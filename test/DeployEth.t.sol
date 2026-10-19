// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {DeployEth} from "../script/DeployEth.s.sol";
import {AirlockAdmin} from "../src/AirlockAdmin.sol";
import {DemoBTC} from "../src/DemoBTC.sol";
import {DemoBTCV2} from "../src/DemoBTCV2.sol";
import {EvilDrainImpl} from "../src/attack/EvilDrainImpl.sol";
import {AirlockReceiver} from "../src/cre/AirlockReceiver.sol";

/// script/DeployEth.s.sol run in-process: wiring, role refusal (attester included), the mock-forwarder opt-in, the
/// JSON it writes, and one clear and one veto through the deployed receiver. The same script against an anvil fork
/// of Sepolia is the deployment rehearsal.
contract DeployEthTest is Test {
    address constant MOCK_FORWARDER = 0x15fC6ae953E024d975e77382eEeC56A9101f9F88;
    bytes32 constant R1 = keccak256("GUARD/R1_TOTAL_SUPPLY");
    bytes32 constant WORKFLOW_ID = keccak256("airlock-workflow");

    DeployEth script;
    address owner;
    uint256 ownerPk;
    Vm.Wallet attester;
    address approver = makeAddr("approver");
    address emergency = makeAddr("emergencyGuardian");

    function setUp() public {
        vm.roll(1_000);
        (owner, ownerPk) = makeAddrAndKey("owner");
        attester = vm.createWallet("attester");
        vm.etch(MOCK_FORWARDER, hex"00"); // the script refuses a forwarder without code
        script = new DeployEth();
    }

    function _cfg() internal view returns (DeployEth.Cfg memory c) {
        c.pk = ownerPk;
        c.owner = owner;
        c.attester = attester.addr;
        c.forwarder = MOCK_FORWARDER;
        c.approver = approver;
        c.emergency = emergency;
        c.delay = 25;
        c.allowMockForwarder = true; // the simulation demo: the attester alone authenticates verdicts
        (c.holders, c.amounts) = script.demoHolders();
    }

    function test_deploy_wiresTheAirlock() public {
        uint64 n0 = vm.getNonce(owner);
        DeployEth.Out memory o = script.deploy(_cfg());
        assertEq(vm.getNonce(owner), n0 + 13, "13 transactions");
        AirlockAdmin a = AirlockAdmin(o.airlockAdmin);
        AirlockReceiver r = AirlockReceiver(o.receiver);

        assertEq(a.owner(), owner);
        assertEq(a.approver(), approver);
        assertEq(a.clearanceOracle(), o.receiver);
        assertEq(a.guardianCount(), 2);
        assertTrue(a.isGuardian(o.receiver) && a.isGuardian(emergency));
        assertFalse(a.isGuardian(owner));
        assertEq(a.pausedImpl(), o.paused);
        assertEq(a.delayBlocks(), 25);
        assertEq(a.proxy(), o.proxy);
        assertEq(a.proxyAdmin(), o.proxyAdmin);
        assertTrue(a.isWired());
        assertEq(ProxyAdmin(o.proxyAdmin).owner(), o.airlockAdmin);
        assertEq(address(uint160(uint256(vm.load(o.proxy, ERC1967Utils.ADMIN_SLOT)))), o.proxyAdmin);
        assertEq(address(uint160(uint256(vm.load(o.proxy, ERC1967Utils.IMPLEMENTATION_SLOT)))), o.v1);

        assertEq(address(r.airlockAdmin()), o.airlockAdmin);
        assertEq(r.forwarder(), MOCK_FORWARDER);
        assertEq(r.attester(), attester.addr);
        assertEq(r.expectedWorkflowId(), bytes32(0));
        assertEq(r.expectedWorkflowOwner(), address(0));

        DemoBTC t = DemoBTC(o.proxy);
        assertEq(t.owner(), o.airlockAdmin);
        assertEq(t.totalSupply(), 175e8);
        (address[] memory holders,) = script.demoHolders();
        assertEq(t.balanceOf(holders[0]), 100e8);
        address[9] memory impls =
            [o.v1, o.v2, o.evilMint, o.evilOwner, o.evilFee, o.evilBaseFee, o.evilDrain, o.paused, o.receiver];
        for (uint256 i = 0; i < impls.length; i++) {
            assertGt(impls[i].code.length, 0);
            for (uint256 k = 0; k < i; k++) {
                assertTrue(impls[i] != impls[k], "distinct contracts");
            }
        }
    }

    /// The deployed drain attack is a real drain behind the proxy: a stranger moves a holder's tokens.
    function test_deploy_evilDrainDrainsBehindTheProxy() public {
        DeployEth.Out memory o = script.deploy(_cfg());
        (address[] memory holders,) = script.demoHolders();
        vm.store(o.proxy, ERC1967Utils.IMPLEMENTATION_SLOT, bytes32(uint256(uint160(o.evilDrain))));
        address thief = makeAddr("thief");
        vm.prank(thief);
        EvilDrainImpl(o.proxy).rescue(holders[0], thief, 100e8);
        assertEq(DemoBTC(o.proxy).balanceOf(holders[0]), 0);
        assertEq(DemoBTC(o.proxy).balanceOf(thief), 100e8);
        assertEq(DemoBTC(o.proxy).totalSupply(), 175e8);
    }

    /// The deployed stack works end to end: an attester-signed Clear lets v2 through after the cooldown, an
    /// attester-signed Veto stops the basefee-evasion attack for good.
    function test_deploy_clearAndVetoThroughTheReceiver() public {
        DeployEth.Out memory o = script.deploy(_cfg());
        AirlockAdmin a = AirlockAdmin(o.airlockAdmin);
        AirlockReceiver r = AirlockReceiver(o.receiver);

        vm.startPrank(owner);
        uint256 honest = a.proposeUpgrade(o.v2, "");
        uint256 evil = a.proposeUpgrade(o.evilBaseFee, "");
        vm.stopPrank();

        _deliver(r, 1, honest, a.proposalDigest(honest), bytes32(0));
        _deliver(r, 0, evil, a.proposalDigest(evil), R1);
        assertEq(a.clearanceOf(honest), keccak256("evidence"));
        assertEq(uint8(a.getProposal(evil).status), uint8(AirlockAdmin.Status.Vetoed));

        vm.roll(vm.getBlockNumber() + 25);
        a.execute(honest);
        assertEq(DemoBTCV2(o.proxy).version(), "2");
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, evil));
        a.execute(evil);
    }

    function _deliver(AirlockReceiver r, uint8 action, uint256 id, bytes32 digest, bytes32 rule) internal {
        bytes32 ev = keccak256("evidence");
        uint64 until = uint64(vm.getBlockNumber() + 100);
        (uint8 v, bytes32 sr, bytes32 ss) =
            vm.sign(attester.privateKey, r.verdictDigest(action, id, digest, rule, ev, until));
        vm.prank(MOCK_FORWARDER);
        r.onReport("", abi.encode(action, id, digest, rule, ev, until, abi.encodePacked(sr, ss, v)));
    }

    function test_deploy_refusesMissingOrOverlappingRoles() public {
        DeployEth.Cfg memory c = _cfg();
        c.approver = address(0);
        vm.expectRevert(bytes("APPROVER_ADDR is required"));
        script.deploy(c);

        c = _cfg();
        c.emergency = address(0);
        vm.expectRevert(bytes("EMERGENCY_GUARDIAN_ADDR is required"));
        script.deploy(c);

        c = _cfg();
        c.approver = owner;
        vm.expectRevert(bytes("APPROVER_ADDR must differ from the owner (deployer)"));
        script.deploy(c);

        c = _cfg();
        c.emergency = owner;
        vm.expectRevert(bytes("EMERGENCY_GUARDIAN_ADDR must differ from the owner (deployer)"));
        script.deploy(c);

        c = _cfg();
        c.emergency = approver;
        vm.expectRevert(bytes("APPROVER_ADDR and EMERGENCY_GUARDIAN_ADDR must differ"));
        script.deploy(c);

        c = _cfg();
        c.forwarder = makeAddr("noCode");
        vm.expectRevert(bytes("forwarder has no code on this chain"));
        script.deploy(c);

        assertEq(vm.getNonce(owner), 0, "nothing was deployed");
    }

    /// The attester's signature is what authenticates a verdict behind the mock forwarder, so it may not be the
    /// owner's, the approver's or the emergency guardian's key.
    function test_deploy_refusesMissingOrOverlappingAttester() public {
        DeployEth.Cfg memory c = _cfg();
        c.attester = address(0);
        vm.expectRevert(bytes("ATTESTER_ADDR is required"));
        script.deploy(c);

        c = _cfg();
        c.attester = owner;
        vm.expectRevert(bytes("ATTESTER_ADDR must differ from the owner (deployer)"));
        script.deploy(c);

        c = _cfg();
        c.attester = approver;
        vm.expectRevert(bytes("ATTESTER_ADDR must differ from APPROVER_ADDR"));
        script.deploy(c);

        c = _cfg();
        c.attester = emergency;
        vm.expectRevert(bytes("ATTESTER_ADDR must differ from EMERGENCY_GUARDIAN_ADDR"));
        script.deploy(c);

        assertEq(vm.getNonce(owner), 0, "nothing was deployed");
    }

    function testFuzz_checkRoles_attesterMustBeItsOwnKey(address a, uint8 pick) public {
        address[3] memory others = [owner, approver, emergency];
        address att = pick % 4 == 3 ? a : others[pick % 4];
        bool distinct = att != address(0) && att != owner && att != approver && att != emergency;
        if (!distinct) vm.expectRevert();
        script.checkRoles(owner, approver, emergency, att);
    }

    /// The Sepolia MockKeystoneForwarder is permissionless: the script refuses it unless the run opts in
    /// (ALLOW_MOCK_FORWARDER=1) or names the workflow (WORKFLOW_ID and WORKFLOW_OWNER). Other forwarders pass.
    function test_deploy_mockForwarderNeedsAnExplicitOptIn() public {
        string memory refused = "mock forwarder refused: set ALLOW_MOCK_FORWARDER=1, or WORKFLOW_ID and WORKFLOW_OWNER";
        address wfOwner = makeAddr("workflowOwner");
        DeployEth.Cfg memory c = _cfg();
        c.allowMockForwarder = false;
        vm.expectRevert(bytes(refused));
        script.deploy(c);
        c.workflowId = WORKFLOW_ID; // the id alone is not enough
        vm.expectRevert(bytes(refused));
        script.deploy(c);
        c.workflowId = bytes32(0);
        c.workflowOwner = wfOwner; // nor the owner alone
        vm.expectRevert(bytes(refused));
        script.deploy(c);
        assertEq(vm.getNonce(owner), 0, "nothing was deployed");

        uint256 snap = vm.snapshotState();
        c.workflowId = WORKFLOW_ID; // both: the receiver checks them
        DeployEth.Out memory o = script.deploy(c);
        assertEq(AirlockReceiver(o.receiver).expectedWorkflowId(), WORKFLOW_ID);
        assertEq(AirlockReceiver(o.receiver).expectedWorkflowOwner(), wfOwner);
        vm.revertToState(snap);

        c = _cfg(); // the explicit opt-in
        o = script.deploy(c);
        assertEq(AirlockReceiver(o.receiver).forwarder(), MOCK_FORWARDER);
        assertEq(AirlockReceiver(o.receiver).expectedWorkflowId(), bytes32(0));
        vm.revertToState(snap);

        c = _cfg(); // any other forwarder (e.g. the production KeystoneForwarder) needs no opt-in
        c.allowMockForwarder = false;
        c.forwarder = makeAddr("keystoneForwarder");
        vm.etch(c.forwarder, hex"00");
        o = script.deploy(c);
        assertEq(AirlockReceiver(o.receiver).forwarder(), c.forwarder);
    }

    function test_checkForwarder_passes() public {
        address wfOwner = makeAddr("workflowOwner");
        script.checkForwarder(MOCK_FORWARDER, bytes32(0), address(0), true);
        script.checkForwarder(MOCK_FORWARDER, WORKFLOW_ID, wfOwner, false);
        script.checkForwarder(makeAddr("keystoneForwarder"), bytes32(0), address(0), false);
    }

    /// `run()` reads the environment. This is the only test that touches environment variables.
    function test_run_fromEnv_refusesBadRoles_thenWritesJson() public {
        string memory out = "cache/deploy-eth-test.json";
        vm.setEnv("DEPLOYER_PK", vm.toString(ownerPk));
        vm.setEnv("ATTESTER_ADDR", vm.toString(attester.addr));
        vm.setEnv("FORWARDER", vm.toString(MOCK_FORWARDER));
        vm.setEnv("DELAY_BLOCKS", "25");
        vm.setEnv("WORKFLOW_ID", vm.toString(bytes32(0)));
        vm.setEnv("WORKFLOW_OWNER", vm.toString(address(0)));
        vm.setEnv("OUT_JSON", out);
        vm.setEnv("ALLOW_MOCK_FORWARDER", "1");

        // missing (empty) approver / emergency guardian
        vm.setEnv("APPROVER_ADDR", "");
        vm.setEnv("EMERGENCY_GUARDIAN_ADDR", vm.toString(emergency));
        vm.expectRevert(bytes("APPROVER_ADDR is required"));
        script.run();
        vm.setEnv("APPROVER_ADDR", vm.toString(approver));
        vm.setEnv("EMERGENCY_GUARDIAN_ADDR", "");
        vm.expectRevert(bytes("EMERGENCY_GUARDIAN_ADDR is required"));
        script.run();
        // overlapping
        vm.setEnv("EMERGENCY_GUARDIAN_ADDR", vm.toString(owner));
        vm.expectRevert(bytes("EMERGENCY_GUARDIAN_ADDR must differ from the owner (deployer)"));
        script.run();
        vm.setEnv("EMERGENCY_GUARDIAN_ADDR", vm.toString(approver));
        vm.expectRevert(bytes("APPROVER_ADDR and EMERGENCY_GUARDIAN_ADDR must differ"));
        script.run();
        vm.setEnv("EMERGENCY_GUARDIAN_ADDR", vm.toString(emergency));
        // attester missing or shared with another role
        vm.setEnv("ATTESTER_ADDR", "");
        vm.expectRevert(bytes("ATTESTER_ADDR is required"));
        script.run();
        vm.setEnv("ATTESTER_ADDR", vm.toString(approver));
        vm.expectRevert(bytes("ATTESTER_ADDR must differ from APPROVER_ADDR"));
        script.run();
        vm.setEnv("ATTESTER_ADDR", vm.toString(attester.addr));
        // the mock forwarder without the explicit opt-in
        string memory refused = "mock forwarder refused: set ALLOW_MOCK_FORWARDER=1, or WORKFLOW_ID and WORKFLOW_OWNER";
        vm.setEnv("ALLOW_MOCK_FORWARDER", "");
        vm.expectRevert(bytes(refused));
        script.run();
        vm.setEnv("ALLOW_MOCK_FORWARDER", "0");
        vm.expectRevert(bytes(refused));
        script.run();
        vm.setEnv("ALLOW_MOCK_FORWARDER", "1");

        uint256 startBlock = vm.getBlockNumber();
        script.run();

        string memory j = vm.readFile(out);
        vm.removeFile(out);
        string[] memory keys = vm.parseJsonKeys(j, "$");
        string[21] memory want = [
            "chainId",
            "startBlock",
            "owner",
            "approver",
            "emergencyGuardian",
            "attester",
            "forwarder",
            "delayBlocks",
            "holders",
            "proxy",
            "proxyAdmin",
            "receiver",
            "airlockAdmin",
            "v1",
            "v2",
            "evilMint",
            "evilOwner",
            "evilFee",
            "evilBaseFee",
            "evilDrain",
            "paused"
        ];
        assertEq(keys.length, want.length, "JSON key count");
        for (uint256 i = 0; i < want.length; i++) {
            assertTrue(vm.keyExistsJson(j, string.concat(".", want[i])), want[i]);
        }
        assertEq(vm.parseJsonUint(j, ".chainId"), block.chainid);
        assertEq(vm.parseJsonUint(j, ".startBlock"), startBlock);
        assertEq(vm.parseJsonUint(j, ".delayBlocks"), 25);
        assertEq(vm.parseJsonAddress(j, ".owner"), owner);
        assertEq(vm.parseJsonAddress(j, ".approver"), approver);
        assertEq(vm.parseJsonAddress(j, ".emergencyGuardian"), emergency);
        assertEq(vm.parseJsonAddress(j, ".attester"), attester.addr);
        assertEq(vm.parseJsonAddress(j, ".forwarder"), MOCK_FORWARDER);
        assertEq(vm.parseJsonAddressArray(j, ".holders").length, 3);

        AirlockAdmin a = AirlockAdmin(vm.parseJsonAddress(j, ".airlockAdmin"));
        assertTrue(a.isWired());
        assertEq(a.clearanceOracle(), vm.parseJsonAddress(j, ".receiver"));
        assertEq(a.proxy(), vm.parseJsonAddress(j, ".proxy"));
        assertEq(a.pausedImpl(), vm.parseJsonAddress(j, ".paused"));
        assertGt(vm.parseJsonAddress(j, ".evilBaseFee").code.length, 0);
        assertGt(vm.parseJsonAddress(j, ".evilDrain").code.length, 0);
    }
}
