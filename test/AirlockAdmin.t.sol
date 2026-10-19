// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AirlockAdmin} from "../src/AirlockAdmin.sol";
import {DemoBTC} from "../src/DemoBTC.sol";
import {DemoBTCV2} from "../src/DemoBTCV2.sol";
import {PausedImpl} from "../src/PausedImpl.sol";
import {EvilMintImpl} from "../src/attack/EvilMintImpl.sol";
import {EvilOwnerImpl} from "../src/attack/EvilOwnerImpl.sol";
import {EvilFeeImpl} from "../src/attack/EvilFeeImpl.sol";
import {EvilBaseFeeImpl} from "../src/attack/EvilBaseFeeImpl.sol";
import {EvilDrainImpl} from "../src/attack/EvilDrainImpl.sol";

contract AirlockAdminTest is Test {
    uint64 constant DELAY = 30;
    bytes32 constant R1 = keccak256("GUARD/R1_TOTAL_SUPPLY");
    bytes32 constant R3 = keccak256("GUARD/R3_TRANSFER_CONSERVATION");
    bytes32 constant R7 = keccak256("GUARD/R7_CONFIG_GUARD");
    bytes32 constant EVIDENCE = keccak256("evidence-json");

    address deployer = makeAddr("deployer");
    address admin = makeAddr("admin");
    address s1 = makeAddr("guardian1");
    address s2 = makeAddr("guardian2");
    address s3 = makeAddr("guardian3");
    address approver = makeAddr("approver");
    address oracle = makeAddr("clearanceOracle");
    address h1 = makeAddr("holder1");
    address h2 = makeAddr("holder2");
    address h3 = makeAddr("holder3");
    address stranger = makeAddr("stranger");

    DemoBTC v1;
    DemoBTCV2 v2;
    EvilMintImpl evilMint;
    EvilOwnerImpl evilOwner;
    EvilFeeImpl evilFee;
    EvilBaseFeeImpl evilBaseFee;
    EvilDrainImpl evilDrain;
    PausedImpl pausedImpl;
    address proxy;
    ProxyAdmin proxyAdmin;
    AirlockAdmin aa;
    DemoBTC token; // the proxy, seen through the v1 ABI

    function setUp() public {
        vm.roll(100);
        vm.etch(oracle, hex"00"); // the clearance oracle must be a contract (in production: AirlockReceiver)
        vm.startPrank(deployer);
        v1 = new DemoBTC();
        address[] memory holders = new address[](3);
        holders[0] = h1;
        holders[1] = h2;
        holders[2] = h3;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 100e8;
        amounts[1] = 50e8;
        amounts[2] = 25e8;
        proxy = address(
            new TransparentUpgradeableProxy(
                address(v1), admin, abi.encodeCall(DemoBTC.initialize, (admin, holders, amounts))
            )
        );
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));
        v2 = new DemoBTCV2();
        evilMint = new EvilMintImpl();
        evilOwner = new EvilOwnerImpl();
        evilFee = new EvilFeeImpl();
        evilBaseFee = new EvilBaseFeeImpl();
        evilDrain = new EvilDrainImpl();
        pausedImpl = new PausedImpl();
        aa = _newAdmin(admin, _guardians(), approver, address(pausedImpl), DELAY, oracle);
        vm.stopPrank();

        // Adoption, exactly as script/DeployEth.s.sol: the owner hands both ProxyAdmin and the token's Ownable to
        // AirlockAdmin.
        token = DemoBTC(proxy);
        vm.startPrank(admin);
        proxyAdmin.transferOwnership(address(aa));
        token.transferOwnership(address(aa));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _newAdmin(
        address owner_,
        address[] memory guardians_,
        address approver_,
        address paused_,
        uint64 delay_,
        address oracle_
    ) internal returns (AirlockAdmin) {
        return new AirlockAdmin(address(proxyAdmin), proxy, owner_, guardians_, approver_, paused_, delay_, oracle_);
    }

    function _guardians() internal view returns (address[] memory g) {
        g = new address[](3);
        g[0] = s1;
        g[1] = s2;
        g[2] = s3;
    }

    function _advance(uint256 n) internal {
        vm.roll(vm.getBlockNumber() + n);
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _proposeUpgrade(address impl) internal returns (uint256 id) {
        vm.prank(admin);
        id = aa.proposeUpgrade(impl, "");
    }

    function _clear(uint256 id) internal {
        vm.prank(oracle);
        aa.clear(id, EVIDENCE);
    }

    function _status(uint256 id) internal view returns (AirlockAdmin.Status) {
        return aa.getProposal(id).status;
    }

    // ------------------------------------------------------------------ wiring (T6)

    function test_wiring() public view {
        assertTrue(aa.isWired());
        assertEq(proxyAdmin.owner(), address(aa));
        assertEq(aa.proxy(), proxy);
        assertEq(aa.proxyAdmin(), address(proxyAdmin));
        assertEq(aa.owner(), admin);
        assertEq(aa.approver(), approver);
        assertEq(aa.clearanceOracle(), oracle);
        assertEq(aa.pausedImpl(), address(pausedImpl));
        assertEq(aa.delayBlocks(), DELAY);
        assertEq(aa.guardianCount(), 3);
        assertTrue(aa.isGuardian(s1) && aa.isGuardian(s2) && aa.isGuardian(s3));
        assertFalse(aa.isGuardian(admin));
        assertEq(aa.nextId(), 1);
        assertFalse(aa.paused());
        assertEq(_impl(), address(v1));
        assertEq(token.symbol(), "dBTC");
        assertEq(token.balanceOf(h1), 100e8);
        assertEq(token.owner(), address(aa));
    }

    function test_T6_ownerCannotBypassAirlock() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(evilMint), "");
        assertEq(_impl(), address(v1));
        assertTrue(aa.isWired());
    }

    /// A leaked owner key must not be able to mint (or grab the token) without going through a proposal: the
    /// token's Ownable belongs to AirlockAdmin after adoption.
    function test_T6_ownerCannotMintDirectly() public {
        uint256 sup = token.totalSupply();
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        token.mint(admin, 1_000_000e8);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        token.transferOwnership(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        token.renounceOwnership();
        vm.stopPrank();
        assertEq(token.totalSupply(), sup);
        assertEq(token.owner(), address(aa));
    }

    /// AirlockAdmin owns the token but has no generic call path, so nobody can reach mint through it.
    function test_T6_tokenOwnerIsAirlockAdmin_noOneMints() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(stranger, 1);
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, s1));
        token.mint(s1, 1);
        assertEq(token.totalSupply(), 175e8);
    }

    // ------------------------------------------------------------------ T1: EvilMint vetoed

    function test_T1_evilMintVetoed_executeRevertsProposalVetoed() public {
        uint256 id = _proposeUpgrade(address(evilMint));
        _advance(2);
        vm.prank(s1);
        aa.veto(id, R1);
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Vetoed));

        _advance(DELAY); // well past readyBlock
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
        assertEq(_impl(), address(v1));
    }

    // ------------------------------------------------------------------ v2: 29 blocks TooEarly, 30 ok (when cleared)

    function test_v2_tooEarlyAt29_executesAt30() public {
        uint256 b0 = vm.getBlockNumber();
        uint256 id = _proposeUpgrade(address(v2));
        AirlockAdmin.Proposal memory p = aa.getProposal(id);
        assertEq(id, 1);
        assertEq(p.readyBlock, b0 + DELAY);
        assertEq(p.proposedBlock, b0);
        assertEq(p.codehash, address(v2).codehash);
        assertEq(p.dataHash, keccak256(""));
        _clear(id);

        uint256 sup = token.totalSupply();
        uint256 bal1 = token.balanceOf(h1);
        uint256 bal2 = token.balanceOf(h2);
        uint256 bal3 = token.balanceOf(h3);

        vm.roll(b0 + 29);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.TooEarly.selector, id, uint64(b0 + 30), uint64(b0 + 29)));
        aa.execute(id);

        vm.roll(b0 + 30);
        vm.expectEmit(true, false, false, true, address(aa));
        emit AirlockAdmin.Executed(id, stranger);
        vm.prank(stranger); // anyone may execute
        aa.execute(id);

        assertEq(_impl(), address(v2));
        assertEq(DemoBTCV2(proxy).version(), "2");
        assertEq(token.totalSupply(), sup);
        assertEq(token.balanceOf(h1), bal1);
        assertEq(token.balanceOf(h2), bal2);
        assertEq(token.balanceOf(h3), bal3);
        assertEq(token.owner(), address(aa));
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Executed));

        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.AlreadyExecuted.selector, id));
        aa.execute(id);
    }

    function test_proposedEvent() public {
        uint256 ready = vm.getBlockNumber() + DELAY;
        vm.expectEmit(true, true, true, true, address(aa));
        emit AirlockAdmin.Proposed(1, 0, address(v2), 0, hex"", address(v2).codehash, uint64(ready));
        _proposeUpgrade(address(v2));
        assertEq(aa.nextId(), 2);
    }

    function test_upgradeWithInitData() public {
        bytes memory data = abi.encodeCall(DemoBTC.mint, (h1, 1)); // runs as the proxy itself
        vm.prank(admin);
        uint256 id = aa.proposeUpgrade(address(v2), data);
        assertEq(aa.getProposal(id).dataHash, keccak256(data));
        assertEq(aa.getProposalData(id), data);
        _clear(id);
        _advance(DELAY);
        // mint is onlyOwner; inside upgradeToAndCall msg.sender is the ProxyAdmin -> whole execute reverts
        vm.expectRevert();
        aa.execute(id);
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));
        assertEq(_impl(), address(v1));
    }

    // ------------------------------------------------------------------ clearance: the second door

    /// Every proposal kind waits for a clearance, even long after its readyBlock.
    function test_clearanceRequired_everyKind() public {
        address s4 = makeAddr("guardian4");
        vm.startPrank(admin);
        uint256[4] memory ids = [
            aa.proposeUpgrade(address(v2), ""),
            aa.proposeSetGuardian(s4, true),
            aa.proposeSetDelay(40),
            aa.proposeSetPausedImpl(address(v2))
        ];
        vm.stopPrank();
        _advance(DELAY * 100);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(uint8(aa.getProposal(ids[i]).kind), i);
            vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NotCleared.selector, ids[i]));
            aa.execute(ids[i]);
            assertEq(uint8(_status(ids[i])), uint8(AirlockAdmin.Status.Pending));
        }
        assertEq(_impl(), address(v1));
        assertFalse(aa.isGuardian(s4));
        assertEq(aa.delayBlocks(), DELAY);
        assertEq(aa.pausedImpl(), address(pausedImpl));

        for (uint256 i = 0; i < 4; i++) {
            _clear(ids[i]);
            aa.execute(ids[i]);
            assertEq(uint8(_status(ids[i])), uint8(AirlockAdmin.Status.Executed));
        }
        assertEq(_impl(), address(v2));
        assertTrue(aa.isGuardian(s4));
        assertEq(aa.delayBlocks(), 40);
        assertEq(aa.pausedImpl(), address(v2));
    }

    /// Time is checked first: a proposal that is neither ready nor cleared reports TooEarly; a cleared one still
    /// waits the full cooldown.
    function test_clearanceDoesNotShortenTheCooldown() public {
        uint256 b0 = vm.getBlockNumber();
        uint256 id = _proposeUpgrade(address(v2));
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.TooEarly.selector, id, uint64(b0 + DELAY), uint64(b0)));
        aa.execute(id);
        _clear(id);
        vm.roll(b0 + DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(AirlockAdmin.TooEarly.selector, id, uint64(b0 + DELAY), uint64(b0 + DELAY - 1))
        );
        aa.execute(id);
        vm.roll(b0 + DELAY);
        aa.execute(id);
        assertEq(_impl(), address(v2));
    }

    /// A guardian veto beats a clearance, whichever comes first.
    function test_vetoBeatsClearance() public {
        uint256 id = _proposeUpgrade(address(evilMint));
        _clear(id);
        assertEq(aa.clearanceOf(id), EVIDENCE);
        vm.prank(s2);
        aa.veto(id, R1);
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Vetoed));
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);

        // and a clearance after the veto is refused
        uint256 id2 = _proposeUpgrade(address(evilMint));
        vm.prank(s1);
        aa.veto(id2, R1);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id2));
        aa.clear(id2, EVIDENCE);
        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id2));
        aa.clear(id2, EVIDENCE);
        assertEq(aa.clearanceOf(id2), bytes32(0));
        assertEq(_impl(), address(v1));
    }

    function test_clearByOracle_event() public {
        uint256 id = _proposeUpgrade(address(v2));
        vm.expectEmit(true, true, false, true, address(aa));
        emit AirlockAdmin.Cleared(id, oracle, EVIDENCE);
        _clear(id);
        assertEq(aa.clearanceOf(id), EVIDENCE);
    }

    /// The approver is the manual second door (e.g. while the oracle is down).
    function test_clearByApprover() public {
        uint256 id = _proposeUpgrade(address(v2));
        bytes32 ev = keccak256("approver-review");
        vm.expectEmit(true, true, false, true, address(aa));
        emit AirlockAdmin.Cleared(id, approver, ev);
        vm.prank(approver);
        aa.clear(id, ev);
        assertEq(aa.clearanceOf(id), ev);
        _advance(DELAY);
        aa.execute(id);
        assertEq(_impl(), address(v2));
    }

    function test_onlyClearerRolesClear() public {
        uint256 id = _proposeUpgrade(address(v2));
        address[5] memory others = [stranger, admin, s1, s2, s3];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(AirlockAdmin.NotClearer.selector);
            aa.clear(id, EVIDENCE);
        }
        assertEq(aa.clearanceOf(id), bytes32(0));
    }

    /// A second clearance (by anyone allowed) keeps the first evidence hash; it is still observable as an event.
    function test_clearIdempotent_keepsFirstHash() public {
        uint256 id = _proposeUpgrade(address(v2));
        bytes32 ev2 = keccak256("second");
        _clear(id);
        vm.expectEmit(true, true, false, true, address(aa));
        emit AirlockAdmin.Cleared(id, approver, ev2);
        vm.prank(approver);
        aa.clear(id, ev2);
        assertEq(aa.clearanceOf(id), EVIDENCE);
        _clear(id);
        assertEq(aa.clearanceOf(id), EVIDENCE);
    }

    function test_clear_requiresPendingAndEvidence() public {
        vm.startPrank(oracle);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 0));
        aa.clear(0, EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 5));
        aa.clear(5, EVIDENCE);
        vm.stopPrank();

        uint256 id = _proposeUpgrade(address(v2));
        vm.prank(oracle);
        vm.expectRevert(AirlockAdmin.EmptyEvidence.selector);
        aa.clear(id, bytes32(0));

        _clear(id);
        _advance(DELAY);
        aa.execute(id);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.AlreadyExecuted.selector, id));
        aa.clear(id, EVIDENCE);
    }

    // ------------------------------------------------------------------ oracleJudged: the oracle's own verdict

    /// An AirlockAdmin whose clearance oracle is also a guardian, as in the deployment (AirlockReceiver is both).
    /// Not wired to the proxy: only proposals, clearances and vetoes are exercised.
    function _adminWithOracleGuardian() internal returns (AirlockAdmin a) {
        address[] memory g = new address[](2);
        g[0] = oracle;
        g[1] = s1;
        a = _newAdmin(admin, g, approver, address(pausedImpl), DELAY, oracle);
    }

    function test_oracleJudged_onlyTheOraclesClearSetsIt() public {
        uint256 id = _proposeUpgrade(address(v2));
        assertFalse(aa.oracleJudged(id));
        bytes32 manual = keccak256("approver-review");
        vm.prank(approver);
        aa.clear(id, manual);
        assertFalse(aa.oracleJudged(id), "a manual clearance is not an oracle verdict");
        assertEq(aa.clearanceOf(id), manual);

        // the oracle judges the approver-cleared proposal anyway: first evidence kept, oracleJudged set
        vm.expectEmit(true, true, false, true, address(aa));
        emit AirlockAdmin.Cleared(id, oracle, EVIDENCE);
        _clear(id);
        assertTrue(aa.oracleJudged(id));
        assertEq(aa.clearanceOf(id), manual);

        uint256 id2 = _proposeUpgrade(address(v2));
        _clear(id2);
        assertTrue(aa.oracleJudged(id2));
        assertFalse(aa.oracleJudged(id2 + 1)); // unknown ids read false
        assertFalse(aa.oracleJudged(0));
    }

    /// A veto by the oracle (it is also a guardian) sets oracleJudged; a veto by another guardian does not.
    function test_oracleJudged_setByTheOraclesVetoOnly() public {
        AirlockAdmin a = _adminWithOracleGuardian();
        vm.startPrank(admin);
        uint256 byHuman = a.proposeUpgrade(address(evilMint), "");
        uint256 byOracle = a.proposeUpgrade(address(evilMint), "");
        vm.stopPrank();

        vm.prank(s1);
        a.veto(byHuman, R1);
        assertEq(uint8(a.getProposal(byHuman).status), uint8(AirlockAdmin.Status.Vetoed));
        assertFalse(a.oracleJudged(byHuman));
        vm.prank(oracle); // the oracle may still record its own veto on a vetoed proposal
        a.veto(byHuman, R1);
        assertTrue(a.oracleJudged(byHuman));

        vm.prank(oracle);
        a.veto(byOracle, R1);
        assertEq(uint8(a.getProposal(byOracle).status), uint8(AirlockAdmin.Status.Vetoed));
        assertTrue(a.oracleJudged(byOracle));
    }

    /// The case the sweeper exists for: the approver cleared by hand, the oracle never judged (oracleJudged false,
    /// still Pending), the oracle then judges and vetoes. The veto wins over the manual clearance.
    function test_oracleJudged_approverClearedThenOracleVetoes_vetoWins() public {
        AirlockAdmin a = _adminWithOracleGuardian();
        vm.prank(admin);
        uint256 id = a.proposeUpgrade(address(evilDrain), "");
        vm.prank(approver); // a mistaken manual clearance
        a.clear(id, keccak256("approver-review"));
        assertEq(uint8(a.getProposal(id).status), uint8(AirlockAdmin.Status.Pending));
        assertFalse(a.oracleJudged(id), "still to be judged by the oracle");

        vm.prank(oracle);
        a.veto(id, R3);
        assertTrue(a.oracleJudged(id));
        assertEq(uint8(a.getProposal(id).status), uint8(AirlockAdmin.Status.Vetoed));
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        a.execute(id);
    }

    function testFuzz_oracleJudged_onlyTheOracle(address who, bool clearFirst) public {
        vm.assume(who != oracle);
        AirlockAdmin a = _adminWithOracleGuardian();
        vm.prank(admin);
        uint256 id = a.proposeUpgrade(address(v2), "");
        if (clearFirst) {
            vm.prank(approver);
            a.clear(id, EVIDENCE);
        }
        vm.prank(who);
        try a.clear(id, EVIDENCE) {} catch {}
        vm.prank(who);
        try a.veto(id, R1) {} catch {}
        assertFalse(a.oracleJudged(id));
    }

    // ------------------------------------------------------------------ proposalDigest

    function _expectedDigest(uint256 id) internal view returns (bytes32) {
        AirlockAdmin.Proposal memory p = aa.getProposal(id);
        return keccak256(abi.encode(uint8(p.kind), p.target, p.value, p.codehash, p.dataHash, uint64(p.proposedBlock)));
    }

    function test_proposalDigest_encoding() public {
        bytes memory data = abi.encodeCall(DemoBTCV2.version, ());
        vm.prank(admin);
        uint256 id = aa.proposeUpgrade(address(v2), data);
        bytes32 want = keccak256(
            abi.encode(
                uint8(0), address(v2), uint256(0), address(v2).codehash, keccak256(data), uint64(vm.getBlockNumber())
            )
        );
        assertEq(aa.proposalDigest(id), want);
        assertEq(aa.proposalDigest(id), _expectedDigest(id));

        vm.prank(admin);
        uint256 g = aa.proposeSetGuardian(s1, false);
        assertEq(
            aa.proposalDigest(g),
            keccak256(abi.encode(uint8(1), s1, uint256(0), bytes32(0), keccak256(""), uint64(vm.getBlockNumber())))
        );
    }

    /// The digest binds the content: another implementation, other init data or another block gives another digest.
    function test_proposalDigest_bindsContent() public {
        uint256 a = _proposeUpgrade(address(v2));
        uint256 b = _proposeUpgrade(address(v2)); // same content, same block
        uint256 c = _proposeUpgrade(address(evilMint));
        vm.prank(admin);
        uint256 d = aa.proposeUpgrade(address(v2), hex"01");
        _advance(1);
        uint256 e = _proposeUpgrade(address(v2));
        assertEq(aa.proposalDigest(a), aa.proposalDigest(b)); // the id is bound by the verdict signature
        assertTrue(aa.proposalDigest(a) != aa.proposalDigest(c));
        assertTrue(aa.proposalDigest(a) != aa.proposalDigest(d));
        assertTrue(aa.proposalDigest(a) != aa.proposalDigest(e));
    }

    function test_proposalDigest_unknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 0));
        aa.proposalDigest(0);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 1));
        aa.proposalDigest(1);
    }

    /// The digest stays readable after a veto or an execution (evidence can be checked later).
    function test_proposalDigest_stableAcrossStatus() public {
        uint256 id = _proposeUpgrade(address(v2));
        bytes32 d0 = aa.proposalDigest(id);
        _clear(id);
        _advance(DELAY);
        aa.execute(id);
        assertEq(aa.proposalDigest(id), d0);
    }

    // ------------------------------------------------------------------ EIP-7702 and codehash pinning

    function _designator(address delegate) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"ef0100", delegate);
    }

    /// A real EIP-7702 delegation (vm.signAndAttachDelegation): the EOA runs v2's code, but its code is the
    /// 23-byte designator and its key can re-point it at any time. It is refused as an upgrade target.
    function test_7702_delegatedEoaRefusedAsUpgradeTarget() public {
        Vm.Wallet memory w = vm.createWallet("delegatingEoa");
        vm.signAndAttachDelegation(address(v2), w.privateKey);
        assertEq(DemoBTCV2(w.addr).version(), "2"); // the delegation is live: the EOA runs v2
        assertEq(w.addr.code, _designator(address(v2)));
        assertEq(w.addr.codehash, keccak256(_designator(address(v2))));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.DelegatedAccount.selector, w.addr));
        aa.proposeUpgrade(w.addr, "");
        assertEq(aa.nextId(), 1, "nothing proposed");

        // why: re-delegating changes the code that runs (and the codehash) with one signature, no deployment
        vm.signAndAttachDelegation(address(evilMint), w.privateKey);
        DemoBTC(w.addr).decimals();
        assertEq(w.addr.code, _designator(address(evilMint)));
    }

    function test_7702_delegatedEoaRefusedAsPausedImpl() public {
        address eoa = makeAddr("delegatedEoa");
        vm.etch(eoa, _designator(address(pausedImpl)));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.DelegatedAccount.selector, eoa));
        aa.proposeSetPausedImpl(eoa);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.DelegatedAccount.selector, eoa));
        aa.proposeUpgrade(eoa, "");
    }

    /// Whatever it delegates to (a contract, an EOA, a precompile), a designator is refused.
    function testFuzz_7702_anyDesignatorRefused(address delegate, bool asPausedImpl) public {
        address eoa = makeAddr("designated");
        vm.etch(eoa, _designator(delegate));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.DelegatedAccount.selector, eoa));
        if (asPausedImpl) aa.proposeSetPausedImpl(eoa);
        else aa.proposeUpgrade(eoa, "");
    }

    /// Ordinary short code that merely contains 0xef01 later on is not a designator.
    function test_7702_shortOrdinaryCodeAccepted() public {
        address tiny = makeAddr("tiny");
        vm.etch(tiny, hex"00ef01");
        vm.prank(admin);
        uint256 id = aa.proposeUpgrade(tiny, "");
        assertEq(aa.getProposal(id).codehash, keccak256(hex"00ef01"));
    }

    function test_7702_constructorRefusesDelegatedPausedImplOrOracle() public {
        address eoa = makeAddr("delegatedEoa");
        vm.etch(eoa, _designator(address(pausedImpl)));
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.DelegatedAccount.selector, eoa));
        _newAdmin(admin, _guardians(), approver, eoa, DELAY, oracle);

        address eoaOracle = makeAddr("delegatedOracle");
        vm.etch(eoaOracle, _designator(oracle));
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.DelegatedAccount.selector, eoaOracle));
        _newAdmin(admin, _guardians(), approver, address(pausedImpl), DELAY, eoaOracle);
    }

    /// A cleared upgrade whose target's code changed after it was proposed (a re-created CREATE2 address, or a
    /// designator: modelled with vm.etch) cannot execute: CodehashChanged, the proposal stays Pending, and it
    /// runs once the judged code is back.
    function test_codehashChanged_upgradeRefused() public {
        DemoBTCV2 cand = new DemoBTCV2();
        bytes memory judged = address(cand).code;
        bytes32 judgedHash = address(cand).codehash;
        uint256 id = _proposeUpgrade(address(cand));
        assertEq(aa.getProposal(id).codehash, judgedHash);
        _clear(id);
        _advance(DELAY);

        bytes[3] memory swaps = [address(evilMint).code, _designator(address(evilMint)), bytes("")];
        for (uint256 i = 0; i < swaps.length; i++) {
            vm.etch(address(cand), swaps[i]);
            vm.expectRevert(
                abi.encodeWithSelector(AirlockAdmin.CodehashChanged.selector, id, judgedHash, address(cand).codehash)
            );
            vm.prank(stranger);
            aa.execute(id);
            assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));
            assertEq(_impl(), address(v1));
        }

        vm.etch(address(cand), judged);
        aa.execute(id);
        assertEq(_impl(), address(cand));
        assertEq(DemoBTCV2(proxy).version(), "2");
    }

    /// The same check guards the break-glass target: breakGlass would switch to whatever code is there.
    function test_codehashChanged_setPausedImplRefused() public {
        PausedImpl cand = new PausedImpl();
        bytes32 judgedHash = address(cand).codehash;
        vm.prank(admin);
        uint256 id = aa.proposeSetPausedImpl(address(cand));
        _clear(id);
        _advance(DELAY);
        vm.etch(address(cand), address(evilMint).code);
        vm.expectRevert(
            abi.encodeWithSelector(AirlockAdmin.CodehashChanged.selector, id, judgedHash, address(evilMint).codehash)
        );
        aa.execute(id);
        assertEq(aa.pausedImpl(), address(pausedImpl));

        vm.etch(address(cand), _designator(address(evilMint))); // a designator is refused the same way
        vm.expectRevert(
            abi.encodeWithSelector(
                AirlockAdmin.CodehashChanged.selector, id, judgedHash, keccak256(_designator(address(evilMint)))
            )
        );
        aa.execute(id);
        assertEq(aa.pausedImpl(), address(pausedImpl));
    }

    function testFuzz_codehashChanged(bytes calldata other) public {
        vm.assume(other.length > 0 && other.length < 2_000 && other[0] != 0xef); // 0xef: designator / EOF, above
        DemoBTCV2 cand = new DemoBTCV2();
        bytes32 judgedHash = address(cand).codehash;
        vm.assume(keccak256(other) != judgedHash);
        uint256 id = _proposeUpgrade(address(cand));
        _clear(id);
        _advance(DELAY);
        vm.etch(address(cand), other);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.CodehashChanged.selector, id, judgedHash, keccak256(other)));
        aa.execute(id);
    }

    /// Guardian and delay changes carry no code: their codehash is zero and nothing is rechecked.
    function test_codehashCheck_onlyForCodeKinds() public {
        vm.startPrank(admin);
        uint256 g = aa.proposeSetGuardian(makeAddr("guardian4"), true);
        uint256 d = aa.proposeSetDelay(40);
        vm.stopPrank();
        assertEq(aa.getProposal(g).codehash, bytes32(0));
        assertEq(aa.getProposal(d).codehash, bytes32(0));
        _clear(g);
        _clear(d);
        _advance(DELAY);
        aa.execute(g);
        aa.execute(d);
        assertEq(aa.delayBlocks(), 40);
    }

    // ------------------------------------------------------------------ roles never overlap

    function test_roleOverlap_constructor() public {
        address[] memory g = _guardians();
        // approver == owner
        vm.expectRevert(AirlockAdmin.RoleOverlap.selector);
        _newAdmin(admin, g, admin, address(pausedImpl), DELAY, oracle);
        // owner listed as a guardian
        address[] memory withOwner = new address[](2);
        withOwner[0] = s1;
        withOwner[1] = admin;
        vm.expectRevert(AirlockAdmin.RoleOverlap.selector);
        _newAdmin(admin, withOwner, approver, address(pausedImpl), DELAY, oracle);
        // clearance oracle == owner (an owner contract cannot clear its own proposals)
        vm.expectRevert(AirlockAdmin.RoleOverlap.selector);
        _newAdmin(oracle, g, approver, address(pausedImpl), DELAY, oracle);
        // clearance oracle missing or without code
        vm.expectRevert(AirlockAdmin.ZeroAddress.selector);
        _newAdmin(admin, g, approver, address(pausedImpl), DELAY, address(0));
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NoCode.selector, stranger));
        _newAdmin(admin, g, approver, address(pausedImpl), DELAY, stranger);
        // the oracle may also be a guardian (AirlockReceiver is both)
        address[] memory withOracle = new address[](2);
        withOracle[0] = oracle;
        withOracle[1] = s1;
        AirlockAdmin ok = _newAdmin(admin, withOracle, approver, address(pausedImpl), DELAY, oracle);
        assertTrue(ok.isGuardian(oracle));
    }

    function test_roleOverlap_guardianChange() public {
        vm.prank(admin);
        vm.expectRevert(AirlockAdmin.RoleOverlap.selector);
        aa.proposeSetGuardian(admin, true);
        // removing the owner (never a guardian) is a harmless no-op proposal
        vm.prank(admin);
        uint256 id = aa.proposeSetGuardian(admin, false);
        _clear(id);
        _advance(DELAY);
        aa.execute(id);
        assertFalse(aa.isGuardian(admin));
        assertEq(aa.guardianCount(), 3);
    }

    // ------------------------------------------------------------------ T4 / T5: config changes

    function test_T4_removeGuardian_vetoable_notInstant() public {
        vm.prank(admin);
        uint256 id = aa.proposeSetGuardian(s1, false);
        AirlockAdmin.Proposal memory p = aa.getProposal(id);
        assertEq(uint8(p.kind), uint8(AirlockAdmin.Kind.SetGuardian));
        assertEq(p.target, s1);
        assertEq(p.value, 0);
        assertTrue(aa.isGuardian(s1)); // not removed yet

        vm.expectRevert(
            abi.encodeWithSelector(AirlockAdmin.TooEarly.selector, id, p.readyBlock, uint64(vm.getBlockNumber()))
        );
        aa.execute(id);

        vm.prank(s1); // the guardian being removed can still veto
        aa.veto(id, R7);
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
        assertTrue(aa.isGuardian(s1));
        assertEq(aa.guardianCount(), 3);
    }

    function test_T5_shortenDelay_vetoable_notInstant() public {
        vm.prank(admin);
        uint256 id = aa.proposeSetDelay(10);
        assertEq(aa.getProposal(id).value, 10);
        assertEq(aa.delayBlocks(), DELAY);

        vm.expectRevert();
        aa.execute(id); // TooEarly

        vm.prank(s2);
        aa.veto(id, R7);
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
        assertEq(aa.delayBlocks(), DELAY);
    }

    function test_T5_cannotProposeDelayBelowMinimum() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.InvalidDelay.selector, uint64(0)));
        aa.proposeSetDelay(0);
    }

    function test_configChanges_executeAfterDelayIfClearedAndNotVetoed() public {
        address s4 = makeAddr("guardian4");
        vm.startPrank(admin);
        uint256 add = aa.proposeSetGuardian(s4, true);
        uint256 rm = aa.proposeSetGuardian(s1, false);
        uint256 dl = aa.proposeSetDelay(40);
        uint256 pi = aa.proposeSetPausedImpl(address(v2));
        vm.stopPrank();
        _clear(add);
        _clear(rm);
        _clear(dl);
        _clear(pi);
        _advance(DELAY);
        aa.execute(add);
        aa.execute(rm);
        aa.execute(dl);
        aa.execute(pi);
        assertTrue(aa.isGuardian(s4));
        assertFalse(aa.isGuardian(s1));
        assertEq(aa.guardianCount(), 3);
        assertEq(aa.delayBlocks(), 40);
        assertEq(aa.pausedImpl(), address(v2));

        // the new delay applies to the next proposal
        uint256 b = vm.getBlockNumber();
        uint256 id = _proposeUpgrade(address(v2));
        assertEq(aa.getProposal(id).readyBlock, b + 40);

        vm.prank(s1);
        vm.expectRevert(AirlockAdmin.NotGuardian.selector);
        aa.veto(id, R1);
    }

    function test_cannotRemoveLastGuardian() public {
        vm.startPrank(admin);
        uint256 a = aa.proposeSetGuardian(s1, false);
        uint256 b = aa.proposeSetGuardian(s2, false);
        uint256 c = aa.proposeSetGuardian(s3, false);
        vm.stopPrank();
        _clear(a);
        _clear(b);
        _clear(c);
        _advance(DELAY);
        aa.execute(a);
        aa.execute(b);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.GuardianBounds.selector, 0));
        aa.execute(c);
        assertTrue(aa.isGuardian(s3));
    }

    function test_proposeSetPausedImpl_requiresCode() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NoCode.selector, stranger));
        aa.proposeSetPausedImpl(stranger);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NoCode.selector, stranger));
        aa.proposeUpgrade(stranger, "");
    }

    // ------------------------------------------------------------------ breakGlass

    function test_breakGlass_immediate_thenUnpausePassesBothDoors() public {
        vm.expectEmit(true, false, false, true, address(aa));
        emit AirlockAdmin.BrokeGlass(s3, address(pausedImpl));
        vm.prank(s3);
        aa.breakGlass();
        assertTrue(aa.paused());
        assertEq(_impl(), address(pausedImpl));

        // views still work, transfers and mints revert
        assertEq(token.balanceOf(h1), 100e8);
        assertEq(token.totalSupply(), 175e8);
        assertEq(token.owner(), address(aa));
        vm.prank(h1);
        vm.expectRevert(PausedImpl.TokenPaused.selector);
        token.transfer(h2, 1);
        vm.prank(address(aa)); // even the token owner cannot mint while paused
        vm.expectRevert(PausedImpl.TokenPaused.selector);
        token.mint(address(aa), 1);

        vm.prank(admin);
        vm.expectRevert(AirlockAdmin.AlreadyPaused.selector);
        aa.breakGlass();

        // unpause = upgrade back, which waits the full delay and needs a clearance
        uint256 b0 = vm.getBlockNumber();
        uint256 id = _proposeUpgrade(address(v2));
        vm.roll(b0 + DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(AirlockAdmin.TooEarly.selector, id, uint64(b0 + DELAY), uint64(b0 + DELAY - 1))
        );
        aa.execute(id);
        vm.roll(b0 + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NotCleared.selector, id));
        aa.execute(id);
        assertTrue(aa.paused());

        _clear(id);
        aa.execute(id);
        assertFalse(aa.paused());
        assertEq(_impl(), address(v2));
        vm.prank(h1);
        assertTrue(token.transfer(h2, 1e8));
        assertEq(token.balanceOf(h2), 51e8);
    }

    function test_breakGlass_byOwner() public {
        vm.prank(admin);
        aa.breakGlass();
        assertTrue(aa.paused());
    }

    function test_breakGlass_onlyOwnerOrGuardian() public {
        address[3] memory others = [stranger, approver, oracle];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(AirlockAdmin.NotOwnerOrGuardian.selector);
            aa.breakGlass();
        }
    }

    // ------------------------------------------------------------------ access control

    function test_onlyOwnerProposes() public {
        address[4] memory others = [stranger, s1, approver, oracle];
        for (uint256 i = 0; i < others.length; i++) {
            vm.startPrank(others[i]);
            vm.expectRevert(AirlockAdmin.NotOwner.selector);
            aa.proposeUpgrade(address(v2), "");
            vm.expectRevert(AirlockAdmin.NotOwner.selector);
            aa.proposeSetGuardian(stranger, true);
            vm.expectRevert(AirlockAdmin.NotOwner.selector);
            aa.proposeSetDelay(40);
            vm.expectRevert(AirlockAdmin.NotOwner.selector);
            aa.proposeSetPausedImpl(address(v2));
            vm.stopPrank();
        }
    }

    function test_onlyGuardianVetoesAndAttaches() public {
        uint256 id = _proposeUpgrade(address(evilMint));
        address[4] memory others = [stranger, admin, approver, oracle];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(AirlockAdmin.NotGuardian.selector);
            aa.veto(id, R1);
            vm.prank(others[i]);
            vm.expectRevert(AirlockAdmin.NotGuardian.selector);
            aa.attachReason(id, bytes32(uint256(1)));
        }
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));

        bytes32 report = keccak256(unicode"报告");
        vm.expectEmit(true, false, false, true, address(aa));
        emit AirlockAdmin.ReasonAttached(id, s1, report);
        vm.prank(s1);
        aa.attachReason(id, report);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 99));
        aa.attachReason(99, report);
    }

    function test_onlyApproverApprovesCodehash() public {
        bytes32 h = address(v2).codehash;
        address[4] memory others = [stranger, admin, s1, oracle];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(AirlockAdmin.NotApprover.selector);
            aa.approveCodehash(h);
        }
        assertFalse(aa.isApprovedCodehash(h));
        vm.expectEmit(true, false, false, true, address(aa));
        emit AirlockAdmin.CodehashApproved(h, approver);
        vm.prank(approver);
        aa.approveCodehash(h);
        assertTrue(aa.isApprovedCodehash(h));
    }

    // ------------------------------------------------------------------ veto idempotency

    function test_vetoIdempotent_threeGuardians() public {
        uint256 id = _proposeUpgrade(address(evilFee));
        address[3] memory g = [s1, s2, s3];
        vm.recordLogs();
        for (uint256 i = 0; i < 3; i++) {
            vm.expectEmit(true, true, false, true, address(aa));
            emit AirlockAdmin.Vetoed(id, g[i], R3, i + 1);
            vm.prank(g[i]);
            aa.veto(id, R3);
            assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Vetoed));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(aa) && logs[i].topics[0] == AirlockAdmin.Vetoed.selector) n++;
        }
        assertEq(n, 3);
        assertEq(aa.getProposal(id).vetoCount, 3);

        // the same guardian again: still Vetoed, counted once, event emitted again
        vm.expectEmit(true, true, false, true, address(aa));
        emit AirlockAdmin.Vetoed(id, s1, R3, 3);
        vm.prank(s1);
        aa.veto(id, R3);
        assertEq(aa.getProposal(id).vetoCount, 3);
    }

    function test_vetoExecutedReverts_unknownReverts() public {
        uint256 id = _proposeUpgrade(address(v2));
        _clear(id);
        _advance(DELAY);
        aa.execute(id);
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.AlreadyExecuted.selector, id));
        aa.veto(id, R1);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 0));
        aa.veto(0, R1);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 7));
        aa.execute(7);
    }

    // ------------------------------------------------------------------ attack impls really misbehave

    /// Same trick as the workflow's state override: point the live proxy's implementation slot at the candidate
    /// and act as a stranger. The proxy's storage (balances, owner) is untouched.
    function _overrideImpl(address impl) internal {
        vm.store(proxy, ERC1967Utils.IMPLEMENTATION_SLOT, bytes32(uint256(uint160(impl))));
    }

    function test_attack_evilMint_strangerMints() public {
        uint256 sup = token.totalSupply();
        _overrideImpl(address(evilMint));
        vm.prank(stranger);
        token.mint(stranger, 1_000_000e8);
        assertEq(token.totalSupply(), sup + 1_000_000e8);
        assertEq(token.balanceOf(stranger), 1_000_000e8);
    }

    function test_attack_v1_strangerCannotMint() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(stranger, 1);
    }

    function test_attack_evilOwner_strangerTakesOwnership() public {
        _overrideImpl(address(evilOwner));
        vm.prank(stranger);
        EvilOwnerImpl(proxy).claimOwner();
        assertEq(token.owner(), stranger);
    }

    function test_attack_evilFee_transferNotConserved() public {
        _overrideImpl(address(evilFee));
        uint256 sup = token.totalSupply();
        uint256 ownerBefore = token.balanceOf(address(aa));
        vm.prank(h1);
        token.transfer(stranger, 10e8);
        assertEq(token.balanceOf(h1), 90e8); // holder lost X
        assertEq(token.balanceOf(stranger), 9e8); // receiver got only 0.9 X
        // 10% skimmed to owner(), which is AirlockAdmin: the R3 invariant (receiver +X, everyone else on the
        // watch list unchanged) is still violated, so the oracle still vetoes.
        assertEq(token.balanceOf(address(aa)), ownerBefore + 1e8);
        assertEq(token.balanceOf(admin), 0);
        assertEq(token.totalSupply(), sup);
    }

    /// R3 scenario end to end with AirlockAdmin as token owner: the EvilFee skim lands in AirlockAdmin (stuck
    /// there, no call path), the transfer is still not conserved for a fresh receiver, and the R3 veto keeps the
    /// proposal from ever executing, even with a clearance on record.
    function test_T3_evilFee_skimToAirlockAdmin_R3StillHolds_andVetoed() public {
        address receiver = makeAddr("freshReceiver");
        uint256 x = 10e8;
        uint256 snap = vm.snapshotState();
        _overrideImpl(address(evilFee)); // what the workflow's state override sees
        uint256 h1Before = token.balanceOf(h1);
        uint256 aaBefore = token.balanceOf(address(aa));
        vm.prank(h1);
        token.transfer(receiver, x);
        int256 dHolder = int256(token.balanceOf(h1)) - int256(h1Before);
        int256 dReceiver = int256(token.balanceOf(receiver));
        int256 dOwner = int256(token.balanceOf(address(aa))) - int256(aaBefore);
        assertEq(dHolder, -int256(x));
        assertTrue(dReceiver != int256(x)); // R3 violated
        assertEq(dOwner, int256(x / 10)); // skimmed to AirlockAdmin
        vm.revertToState(snap);

        uint256 id = _proposeUpgrade(address(evilFee));
        vm.prank(approver); // a mistaken manual clearance
        aa.clear(id, EVIDENCE);
        vm.prank(s2);
        aa.veto(id, R3);
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
        assertEq(_impl(), address(v1));
        vm.prank(h1);
        token.transfer(receiver, x);
        assertEq(token.balanceOf(receiver), x); // v1 still conserves
    }

    /// EvilBaseFee behaves exactly like v1 while block.basefee is zero (what eth_simulateV1 without validation sees).
    function test_attack_evilBaseFee_likeV1AtZeroBasefee() public {
        _overrideImpl(address(evilBaseFee));
        vm.fee(0);
        uint256 sup = token.totalSupply();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(stranger, 1_000_000e8);
        // the owner path is unchanged too
        vm.prank(address(aa));
        token.mint(h1, 1);
        assertEq(token.totalSupply(), sup + 1);
        vm.prank(h1);
        token.transfer(h2, 10e8);
        assertEq(token.balanceOf(h2), 60e8); // transfers conserve
    }

    /// ...and lets anyone mint on a real block (any base fee above zero).
    function testFuzz_attack_evilBaseFee_strangerMintsAtPositiveBasefee(uint256 fee) public {
        fee = bound(fee, 1, 1_000_000 gwei);
        _overrideImpl(address(evilBaseFee));
        vm.fee(fee);
        uint256 sup = token.totalSupply();
        vm.prank(stranger);
        token.mint(stranger, 1_000_000e8);
        assertEq(token.totalSupply(), sup + 1_000_000e8);
        assertEq(token.balanceOf(stranger), 1_000_000e8);
    }

    /// EvilDrain: anyone moves any holder's tokens through `rescue`, without an allowance.
    function test_attack_evilDrain_strangerMovesAHoldersTokens() public {
        _overrideImpl(address(evilDrain));
        uint256 sup = token.totalSupply();
        vm.prank(stranger);
        EvilDrainImpl(proxy).rescue(h1, stranger, 100e8);
        assertEq(token.balanceOf(h1), 0);
        assertEq(token.balanceOf(stranger), 100e8);
        assertEq(token.allowance(h1, stranger), 0);
        assertEq(token.totalSupply(), sup); // R1 sees nothing
        assertEq(token.owner(), address(aa)); // R2 sees nothing
    }

    /// ...while every v1 path behaves exactly like v1: only a probe of the new selector shows the drain.
    function test_attack_evilDrain_v1PathsUnchanged() public {
        _overrideImpl(address(evilDrain));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(stranger, 1);
        vm.prank(h1);
        assertTrue(token.transfer(h2, 10e8));
        assertEq(token.balanceOf(h1), 90e8);
        assertEq(token.balanceOf(h2), 60e8); // transfers conserve (R3 sees nothing)
    }

    function test_attack_v1_hasNoRescue() public {
        vm.prank(stranger);
        vm.expectRevert();
        EvilDrainImpl(proxy).rescue(h1, stranger, 1);
        assertEq(token.balanceOf(h1), 100e8);
    }

    // ------------------------------------------------------------------ bytecode (what R9 sees)

    /// True when `op` appears as an opcode in `code` (PUSH data and the CBOR metadata tail skipped), the same walk
    /// as the workflow's static check.
    function _hasOpcode(bytes memory code, uint8 op) internal pure returns (bool) {
        uint256 end = code.length;
        if (end >= 2) {
            uint256 metaLen = (uint256(uint8(code[end - 2])) << 8) | uint8(code[end - 1]);
            if (metaLen + 2 <= end && uint8(code[end - metaLen - 2]) == 0xa2) end = end - metaLen - 2;
        }
        for (uint256 pc = 0; pc < end; pc++) {
            uint8 b = uint8(code[pc]);
            if (b == op) return true;
            if (b >= 0x60 && b <= 0x7f) pc += b - 0x5f;
        }
        return false;
    }

    function test_bytecode_evilBaseFeeCarriesBasefee_honestImplsCarryNoEnvOpcodes() public view {
        assertTrue(_hasOpcode(address(evilBaseFee).code, 0x48), "EvilBaseFee: BASEFEE");
        uint8[5] memory env = [0x48, 0x3a, 0x4a, 0x49, 0x45]; // BASEFEE GASPRICE BLOBBASEFEE BLOBHASH GASLIMIT
        address[3] memory honest = [address(v1), address(v2), address(pausedImpl)];
        for (uint256 i = 0; i < honest.length; i++) {
            for (uint256 j = 0; j < env.length; j++) {
                assertFalse(_hasOpcode(honest[i].code, env[j]), "honest impl carries an environment opcode");
            }
        }
    }

    /// EvilDrain adds no opcode v1 lacks (no environment opcode, call, create or selfdestruct): R9 cannot see it.
    function test_bytecode_evilDrainAddsNoOpcode() public view {
        bool[256] memory inV1 = _opcodeSet(address(v1).code);
        bool[256] memory inDrain = _opcodeSet(address(evilDrain).code);
        for (uint256 op = 0; op < 256; op++) {
            if (inDrain[op]) assertTrue(inV1[op], "EvilDrain adds an opcode v1 lacks");
        }
    }

    function _opcodeSet(bytes memory code) internal pure returns (bool[256] memory set) {
        uint256 end = code.length;
        if (end >= 2) {
            uint256 metaLen = (uint256(uint8(code[end - 2])) << 8) | uint8(code[end - 1]);
            if (metaLen + 2 <= end && uint8(code[end - metaLen - 2]) == 0xa2) end = end - metaLen - 2;
        }
        for (uint256 pc = 0; pc < end; pc++) {
            uint8 b = uint8(code[pc]);
            set[b] = true;
            if (b >= 0x60 && b <= 0x7f) pc += b - 0x5f;
        }
    }

    function test_attack_selectorsUnchanged() public view {
        // EvilMint, EvilFee and EvilBaseFee expose the same mint/transfer selectors as v1, so a selector diff misses
        // them.
        assertGt(address(evilMint).code.length, 0);
        assertGt(address(evilFee).code.length, 0);
        assertGt(address(evilBaseFee).code.length, 0);
        assertTrue(address(evilMint).codehash != address(v1).codehash);
        assertTrue(address(evilFee).codehash != address(v1).codehash);
        assertTrue(address(evilBaseFee).codehash != address(v1).codehash);
        assertTrue(address(evilDrain).codehash != address(v1).codehash);
    }

    function test_implsCannotBeInitialized() public {
        address[] memory hs = new address[](0);
        uint256[] memory am = new uint256[](0);
        vm.expectRevert();
        v1.initialize(stranger, hs, am);
        vm.expectRevert();
        evilMint.initialize(stranger, hs, am);
        vm.expectRevert();
        evilBaseFee.initialize(stranger, hs, am);
        vm.expectRevert();
        evilDrain.initialize(stranger, hs, am);
    }

    // ------------------------------------------------------------------ constructor validation

    function test_constructorValidation() public {
        address[] memory g = _guardians();
        vm.expectRevert(AirlockAdmin.ZeroAddress.selector);
        new AirlockAdmin(address(0), proxy, admin, g, approver, address(pausedImpl), DELAY, oracle);
        vm.expectRevert(AirlockAdmin.ZeroAddress.selector);
        _newAdmin(admin, g, address(0), address(pausedImpl), DELAY, oracle);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NoCode.selector, stranger));
        _newAdmin(admin, g, approver, stranger, DELAY, oracle);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.GuardianBounds.selector, 0));
        _newAdmin(admin, new address[](0), approver, address(pausedImpl), DELAY, oracle);
        address[] memory nine = new address[](9);
        for (uint256 i = 0; i < 9; i++) {
            nine[i] = address(uint160(0x1000 + i));
        }
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.GuardianBounds.selector, 9));
        _newAdmin(admin, nine, approver, address(pausedImpl), DELAY, oracle);
        g[1] = address(0);
        vm.expectRevert(AirlockAdmin.ZeroAddress.selector);
        _newAdmin(admin, g, approver, address(pausedImpl), DELAY, oracle);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_proposeSetDelay_outOfBounds(uint64 d) public {
        vm.assume(d < aa.MIN_DELAY_BLOCKS() || d > aa.MAX_DELAY_BLOCKS());
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.InvalidDelay.selector, d));
        aa.proposeSetDelay(d);
    }

    function testFuzz_constructor_delayOutOfBounds(uint64 d) public {
        vm.assume(d < 10 || d > 50_400);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.InvalidDelay.selector, d));
        _newAdmin(admin, _guardians(), approver, address(pausedImpl), d, oracle);
    }

    function testFuzz_proposeSetDelay_inBounds(uint64 d) public {
        d = uint64(bound(d, 10, 50_400));
        vm.prank(admin);
        uint256 id = aa.proposeSetDelay(d);
        assertEq(aa.getProposal(id).value, d);
    }

    /// Only the clearance oracle and the approver can clear.
    function testFuzz_onlyClearerRoles(address who) public {
        vm.assume(who != oracle && who != approver);
        uint256 id = _proposeUpgrade(address(v2));
        vm.prank(who);
        vm.expectRevert(AirlockAdmin.NotClearer.selector);
        aa.clear(id, EVIDENCE);
    }

    /// Without a clearance nothing executes, however long it waits.
    function testFuzz_noClearanceNoExecute(uint256 wait) public {
        wait = bound(wait, DELAY, 10_000_000);
        uint256 id = _proposeUpgrade(address(v2));
        _advance(wait);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NotCleared.selector, id));
        aa.execute(id);
    }
}
