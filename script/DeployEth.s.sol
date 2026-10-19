// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {AirlockAdmin} from "../src/AirlockAdmin.sol";
import {DemoBTC} from "../src/DemoBTC.sol";
import {DemoBTCV2} from "../src/DemoBTCV2.sol";
import {PausedImpl} from "../src/PausedImpl.sol";
import {EvilMintImpl} from "../src/attack/EvilMintImpl.sol";
import {EvilOwnerImpl} from "../src/attack/EvilOwnerImpl.sol";
import {EvilFeeImpl} from "../src/attack/EvilFeeImpl.sol";
import {EvilBaseFeeImpl} from "../src/attack/EvilBaseFeeImpl.sol";
import {EvilDrainImpl} from "../src/attack/EvilDrainImpl.sol";
import {AirlockReceiver} from "../src/cre/AirlockReceiver.sol";

/// @notice Ethereum (Sepolia) deployment of Upgrade Airlock with Chainlink CRE as the clearance oracle:
///   DemoBTC v1 -> TransparentUpgradeableProxy -> demo impls (v2, three attacks, the basefee-evasion attack, the
///   third-party drain attack, the paused impl) -> AirlockReceiver (against AirlockAdmin's predicted address) ->
///   AirlockAdmin(guardians = [AirlockReceiver, emergency guardian], clearanceOracle = AirlockReceiver) -> adoption
///   (ProxyAdmin and the token's Ownable handed to AirlockAdmin). 13 transactions, all from the deployer.
/// The deployer key is the demo owner: it can only propose. The approver (manual clearance, codehash registry), the
/// emergency guardian (veto, breakGlass) and the attester (signs the CRE verdicts) are separate keys; the run
/// refuses to deploy when one is missing or when any two of owner, approver, emergency guardian and attester are
/// the same address.
/// The Sepolia MockKeystoneForwarder (what `cre workflow simulate` writes through) is permissionless and forwards
/// whatever metadata its caller supplies, so behind it the attester's signature alone authenticates a verdict. The
/// run refuses it unless ALLOW_MOCK_FORWARDER=1 says so explicitly, or WORKFLOW_ID and WORKFLOW_OWNER are both set.
///
/// Env: DEPLOYER_PK (required), ATTESTER_ADDR (required, the CRE workflow's attestation key),
///      APPROVER_ADDR (required), EMERGENCY_GUARDIAN_ADDR (required),
///      FORWARDER (default: Sepolia MockKeystoneForwarder used by `cre workflow simulate`), DELAY_BLOCKS (default 25),
///      WORKFLOW_ID / WORKFLOW_OWNER (default 0 = not checked; set them for a DON deployment),
///      ALLOW_MOCK_FORWARDER ("1" or "true" accepts the mock forwarder without WORKFLOW_ID and WORKFLOW_OWNER),
///      OUT_JSON (default cache/deployment-eth.dryrun.json; must be under deployments/ or cache/).
/// Sepolia runs the Amsterdam rules: run with `--skip-simulation` (on Sepolia and on an anvil fork of it).
contract DeployEth is Script {
    address internal constant SEPOLIA_MOCK_FORWARDER = 0x15fC6ae953E024d975e77382eEeC56A9101f9F88;
    uint64 internal constant DEFAULT_DELAY = 25;

    struct Out {
        address v1;
        address proxy;
        address proxyAdmin;
        address v2;
        address evilMint;
        address evilOwner;
        address evilFee;
        address evilBaseFee;
        address evilDrain;
        address paused;
        address receiver;
        address airlockAdmin;
    }

    struct Cfg {
        uint256 pk;
        address owner;
        address attester;
        address forwarder;
        address approver;
        address emergency;
        uint64 delay;
        bytes32 workflowId;
        address workflowOwner;
        bool allowMockForwarder;
        address[] holders;
        uint256[] amounts;
    }

    function run() external {
        Cfg memory c = _config();
        uint256 startBlock = block.number;
        Out memory o = deploy(c);
        _write(c, o, startBlock);
    }

    /// @notice Refuses missing or overlapping roles. The owner proposes; the approver clears by hand, the emergency
    ///         guardian vetoes and the attester signs the verdicts the receiver turns into clearances, so none of the
    ///         four may share a key.
    function checkRoles(address owner, address approver, address emergency, address attester) public pure {
        require(approver != address(0), "APPROVER_ADDR is required");
        require(emergency != address(0), "EMERGENCY_GUARDIAN_ADDR is required");
        require(attester != address(0), "ATTESTER_ADDR is required");
        require(approver != owner, "APPROVER_ADDR must differ from the owner (deployer)");
        require(emergency != owner, "EMERGENCY_GUARDIAN_ADDR must differ from the owner (deployer)");
        require(approver != emergency, "APPROVER_ADDR and EMERGENCY_GUARDIAN_ADDR must differ");
        require(attester != owner, "ATTESTER_ADDR must differ from the owner (deployer)");
        require(attester != approver, "ATTESTER_ADDR must differ from APPROVER_ADDR");
        require(attester != emergency, "ATTESTER_ADDR must differ from EMERGENCY_GUARDIAN_ADDR");
    }

    /// @notice Refuses the permissionless Sepolia MockKeystoneForwarder unless the caller opted in explicitly
    ///         (ALLOW_MOCK_FORWARDER=1) or set both WORKFLOW_ID and WORKFLOW_OWNER. Any other forwarder passes.
    function checkForwarder(address forwarder, bytes32 workflowId, address workflowOwner, bool allowMock) public pure {
        if (forwarder != SEPOLIA_MOCK_FORWARDER || allowMock) return;
        require(
            workflowId != bytes32(0) && workflowOwner != address(0),
            "mock forwarder refused: set ALLOW_MOCK_FORWARDER=1, or WORKFLOW_ID and WORKFLOW_OWNER"
        );
    }

    /// @notice The demo holders: keyless addresses (each is a hash, nobody holds a key for it). The attack
    ///         simulation does not need signatures (eth_simulateV1 takes `from` as given).
    function demoHolders() public pure returns (address[] memory holders, uint256[] memory amounts) {
        holders = new address[](3);
        amounts = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            holders[i] = address(uint160(uint256(keccak256(abi.encodePacked("upgrade-airlock/demo-holder/", i + 1)))));
        }
        amounts[0] = 100e8; // dBTC has 8 decimals
        amounts[1] = 50e8;
        amounts[2] = 25e8;
    }

    function deploy(Cfg memory c) public returns (Out memory o) {
        checkRoles(c.owner, c.approver, c.emergency, c.attester);
        checkForwarder(c.forwarder, c.workflowId, c.workflowOwner, c.allowMockForwarder);
        require(c.forwarder.code.length > 0, "forwarder has no code on this chain");

        vm.startBroadcast(c.pk);
        o.v1 = address(new DemoBTC());
        o.proxy = address(
            new TransparentUpgradeableProxy(
                o.v1, c.owner, abi.encodeCall(DemoBTC.initialize, (c.owner, c.holders, c.amounts))
            )
        );
        o.proxyAdmin = address(uint160(uint256(vm.load(o.proxy, ERC1967Utils.ADMIN_SLOT))));
        o.v2 = address(new DemoBTCV2());
        o.evilMint = address(new EvilMintImpl());
        o.evilOwner = address(new EvilOwnerImpl());
        o.evilFee = address(new EvilFeeImpl());
        o.evilBaseFee = address(new EvilBaseFeeImpl());
        o.evilDrain = address(new EvilDrainImpl());
        o.paused = address(new PausedImpl());
        // The receiver is deployed first, against AirlockAdmin's address (the next contract this key creates):
        // AirlockAdmin requires its clearance oracle to have code already.
        address predicted = vm.computeCreateAddress(c.owner, vm.getNonce(c.owner) + 1);
        o.receiver = address(new AirlockReceiver(predicted, c.forwarder, c.attester, c.workflowId, c.workflowOwner));
        address[] memory guardians = new address[](2);
        guardians[0] = o.receiver;
        guardians[1] = c.emergency;
        o.airlockAdmin = address(
            new AirlockAdmin(o.proxyAdmin, o.proxy, c.owner, guardians, c.approver, o.paused, c.delay, o.receiver)
        );
        require(o.airlockAdmin == predicted, "AirlockAdmin address prediction failed");
        ProxyAdmin(o.proxyAdmin).transferOwnership(o.airlockAdmin);
        DemoBTC(o.proxy).transferOwnership(o.airlockAdmin);
        vm.stopBroadcast();

        AirlockAdmin a = AirlockAdmin(o.airlockAdmin);
        require(a.isWired(), "ProxyAdmin not handed to AirlockAdmin");
        require(DemoBTC(o.proxy).owner() == o.airlockAdmin, "token owner is not AirlockAdmin");
        require(a.isGuardian(o.receiver) && a.isGuardian(c.emergency), "guardians not set");
        require(a.clearanceOracle() == o.receiver, "receiver is not the clearance oracle");
        require(address(AirlockReceiver(o.receiver).airlockAdmin()) == o.airlockAdmin, "receiver wired elsewhere");
    }

    function _config() internal view returns (Cfg memory c) {
        c.pk = vm.envUint("DEPLOYER_PK");
        c.owner = vm.addr(c.pk);
        c.attester = vm.envOr("ATTESTER_ADDR", address(0));
        c.forwarder = vm.envOr("FORWARDER", SEPOLIA_MOCK_FORWARDER);
        c.approver = vm.envOr("APPROVER_ADDR", address(0));
        c.emergency = vm.envOr("EMERGENCY_GUARDIAN_ADDR", address(0));
        c.delay = uint64(vm.envOr("DELAY_BLOCKS", uint256(DEFAULT_DELAY)));
        c.workflowId = vm.envOr("WORKFLOW_ID", bytes32(0));
        c.workflowOwner = vm.envOr("WORKFLOW_OWNER", address(0));
        bytes32 allow = keccak256(bytes(vm.envOr("ALLOW_MOCK_FORWARDER", string(""))));
        c.allowMockForwarder = allow == keccak256("1") || allow == keccak256("true");
        (c.holders, c.amounts) = demoHolders();
    }

    function _write(Cfg memory c, Out memory o, uint256 startBlock) internal {
        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "startBlock", startBlock);
        vm.serializeAddress(j, "owner", c.owner);
        vm.serializeAddress(j, "approver", c.approver);
        vm.serializeAddress(j, "emergencyGuardian", c.emergency);
        vm.serializeAddress(j, "attester", c.attester);
        vm.serializeAddress(j, "forwarder", c.forwarder);
        vm.serializeUint(j, "delayBlocks", c.delay);
        vm.serializeAddress(j, "holders", c.holders);
        vm.serializeAddress(j, "proxy", o.proxy);
        vm.serializeAddress(j, "proxyAdmin", o.proxyAdmin);
        vm.serializeAddress(j, "receiver", o.receiver);
        vm.serializeAddress(j, "airlockAdmin", o.airlockAdmin);
        vm.serializeAddress(j, "v1", o.v1);
        vm.serializeAddress(j, "v2", o.v2);
        vm.serializeAddress(j, "evilMint", o.evilMint);
        vm.serializeAddress(j, "evilOwner", o.evilOwner);
        vm.serializeAddress(j, "evilFee", o.evilFee);
        vm.serializeAddress(j, "evilBaseFee", o.evilBaseFee);
        vm.serializeAddress(j, "evilDrain", o.evilDrain);
        string memory out = vm.serializeAddress(j, "paused", o.paused);
        vm.writeJson(out, vm.envOr("OUT_JSON", string("cache/deployment-eth.dryrun.json")));
    }
}
