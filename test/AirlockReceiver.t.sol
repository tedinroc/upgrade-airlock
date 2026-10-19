// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {AirlockAdmin} from "../src/AirlockAdmin.sol";
import {DemoBTC} from "../src/DemoBTC.sol";
import {DemoBTCV2} from "../src/DemoBTCV2.sol";
import {PausedImpl} from "../src/PausedImpl.sol";
import {EvilMintImpl} from "../src/attack/EvilMintImpl.sol";
import {EvilDrainImpl} from "../src/attack/EvilDrainImpl.sol";
import {AirlockReceiver} from "../src/cre/AirlockReceiver.sol";
import {IReceiver} from "../src/cre/IReceiver.sol";

contract AirlockReceiverTest is Test {
    uint64 constant DELAY = 30;
    uint8 constant VETO = 0;
    uint8 constant CLEAR = 1;
    bytes32 constant R1 = keccak256("GUARD/R1_TOTAL_SUPPLY");
    bytes32 constant EVIDENCE = keccak256("evidence-json");

    address deployer = makeAddr("deployer");
    address admin = makeAddr("admin");
    address emergency = makeAddr("emergencyGuardian");
    address approver = makeAddr("approver");
    address forwarder = makeAddr("forwarder");
    address h1 = makeAddr("holder1");
    Vm.Wallet attester;
    Vm.Wallet impostor;

    DemoBTC v1;
    DemoBTCV2 v2;
    EvilMintImpl evilMint;
    PausedImpl pausedImpl;
    address proxy;
    ProxyAdmin proxyAdmin;
    AirlockAdmin aa;
    AirlockReceiver rx;

    /// One signed verdict, as the workflow builds it (cre/veto/report.ts).
    struct V {
        uint8 action;
        uint256 id;
        bytes32 digest;
        bytes32 rule;
        bytes32 evidence;
        uint64 until;
    }

    function setUp() public {
        vm.roll(100);
        vm.warp(1_800_000_000);
        attester = vm.createWallet("attester");
        impostor = vm.createWallet("impostor");

        vm.startPrank(deployer);
        v1 = new DemoBTC();
        address[] memory holders = new address[](1);
        holders[0] = h1;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e8;
        proxy = address(
            new TransparentUpgradeableProxy(
                address(v1), admin, abi.encodeCall(DemoBTC.initialize, (admin, holders, amounts))
            )
        );
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));
        v2 = new DemoBTCV2();
        evilMint = new EvilMintImpl();
        pausedImpl = new PausedImpl();
        // The receiver needs AirlockAdmin's address and AirlockAdmin needs the receiver (clearance oracle with code,
        // and a guardian): deploy the receiver first against AirlockAdmin's predicted address, exactly as
        // script/DeployEth.s.sol does.
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        rx = new AirlockReceiver(predicted, forwarder, attester.addr, bytes32(0), address(0));
        address[] memory guardians = new address[](2);
        guardians[0] = address(rx);
        guardians[1] = emergency;
        aa = new AirlockAdmin(
            address(proxyAdmin), proxy, admin, guardians, approver, address(pausedImpl), DELAY, address(rx)
        );
        vm.stopPrank();
        assertEq(address(aa), predicted, "predicted AirlockAdmin address");

        vm.startPrank(admin);
        proxyAdmin.transferOwnership(address(aa));
        DemoBTC(proxy).transferOwnership(address(aa));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _propose(address impl) internal returns (uint256 id) {
        vm.prank(admin);
        id = aa.proposeUpgrade(impl, "");
    }

    function _verdict(uint8 action, uint256 id) internal view returns (V memory v) {
        v.action = action;
        v.id = id;
        v.digest = aa.proposalDigest(id);
        v.rule = action == VETO ? R1 : bytes32(0);
        v.evidence = EVIDENCE;
        v.until = uint64(vm.getBlockNumber() + 50);
    }

    function _signWith(uint256 pk, AirlockReceiver r, V memory v) internal view returns (bytes memory) {
        bytes32 h = r.verdictDigest(v.action, v.id, v.digest, v.rule, v.evidence, v.until);
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(pk, h);
        return abi.encodePacked(sr, ss, sv);
    }

    function _report(V memory v, bytes memory sig) internal pure returns (bytes memory) {
        return abi.encode(v.action, v.id, v.digest, v.rule, v.evidence, v.until, sig);
    }

    function _signed(V memory v) internal view returns (bytes memory) {
        return _report(v, _signWith(attester.privateKey, rx, v));
    }

    function _deliver(bytes memory rep) internal {
        vm.prank(forwarder);
        rx.onReport("", rep);
    }

    function _metadata(bytes32 workflowId, address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(workflowId, bytes10("airlock-wf"), owner, bytes2(0x0001));
    }

    function _status(uint256 id) internal view returns (AirlockAdmin.Status) {
        return aa.getProposal(id).status;
    }

    // ------------------------------------------------------------------ EIP-712 shape (for the off-chain signer)

    function test_typehashAndDomain() public view {
        assertEq(
            rx.VERDICT_TYPEHASH(),
            keccak256(
                "Verdict(address airlockAdmin,uint8 action,uint256 proposalId,bytes32 proposalDigest,bytes32 ruleHash,bytes32 evidenceHash,uint64 validUntilBlock)"
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AirlockReceiver"),
                keccak256("1"),
                block.chainid,
                address(rx)
            )
        );
        assertEq(rx.domainSeparator(), domain);
        bytes32 structHash = keccak256(
            abi.encode(
                rx.VERDICT_TYPEHASH(),
                address(aa),
                uint8(1),
                uint256(7),
                bytes32(uint256(0xd1)),
                bytes32(0),
                EVIDENCE,
                uint64(1234)
            )
        );
        assertEq(
            rx.verdictDigest(1, 7, bytes32(uint256(0xd1)), bytes32(0), EVIDENCE, 1234),
            keccak256(abi.encodePacked(hex"1901", domain, structHash))
        );
        assertEq(address(rx.airlockAdmin()), address(aa));
        assertEq(rx.attester(), attester.addr);
        assertEq(rx.forwarder(), forwarder);
        assertEq(aa.clearanceOracle(), address(rx));
        assertTrue(aa.isGuardian(address(rx)));
    }

    // ------------------------------------------------------------------ veto

    function test_vetoReport_vetoesAndAttachesEvidence() public {
        uint256 id = _propose(address(evilMint));
        V memory v = _verdict(VETO, id);
        bytes memory rep = _signed(v);

        vm.expectEmit(true, true, false, true, address(rx));
        emit AirlockReceiver.Verdict(id, VETO, R1, EVIDENCE, bytes32(uint256(7)));
        vm.expectEmit(true, true, false, true, address(aa));
        emit AirlockAdmin.Vetoed(id, address(rx), R1, 1);
        vm.expectEmit(true, false, false, true, address(aa));
        emit AirlockAdmin.ReasonAttached(id, address(rx), EVIDENCE);
        vm.prank(forwarder);
        rx.onReport(_metadata(bytes32(uint256(7)), address(0xaaaa)), rep);

        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Vetoed));
        assertTrue(aa.hasVetoed(id, address(rx)));
        assertEq(aa.clearanceOf(id), bytes32(0));
        assertTrue(aa.oracleJudged(id), "a CRE veto is the oracle's verdict");

        vm.roll(vm.getBlockNumber() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
        assertEq(DemoBTC(proxy).totalSupply(), 100e8, "malicious implementation never went live");
    }

    // ------------------------------------------------------------------ clear

    function test_clearReport_clearsThenExecutesAfterCooldown() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);

        vm.expectEmit(true, true, false, true, address(rx));
        emit AirlockReceiver.Verdict(id, CLEAR, bytes32(0), EVIDENCE, bytes32(0));
        vm.expectEmit(true, true, false, true, address(aa));
        emit AirlockAdmin.Cleared(id, address(rx), EVIDENCE);
        assertFalse(aa.oracleJudged(id));
        _deliver(_signed(v));
        assertEq(aa.clearanceOf(id), EVIDENCE);
        assertTrue(aa.oracleJudged(id), "a CRE clear is the oracle's verdict");
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));

        vm.roll(vm.getBlockNumber() + DELAY - 1);
        vm.expectRevert(); // TooEarly: a clearance never shortens the cooldown
        aa.execute(id);
        vm.roll(vm.getBlockNumber() + 1);
        aa.execute(id);
        assertEq(DemoBTCV2(proxy).version(), "2");
    }

    function test_withoutClearReport_honestUpgradeWaits() public {
        uint256 id = _propose(address(v2));
        vm.roll(vm.getBlockNumber() + DELAY * 10);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NotCleared.selector, id));
        aa.execute(id);
    }

    /// The emergency guardian's veto is not the oracle's verdict.
    function test_emergencyVetoLeavesOracleJudgedUnset() public {
        uint256 id = _propose(address(evilMint));
        vm.prank(emergency);
        aa.veto(id, keccak256("manual"));
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Vetoed));
        assertFalse(aa.oracleJudged(id));
    }

    /// What the sweeper relies on: a proposal the approver cleared by hand is still Pending with oracleJudged false,
    /// so CRE judges it; a CRE Veto then wins over the manual clearance.
    function test_approverClearedThenCreVeto_vetoWins() public {
        EvilDrainImpl drain = new EvilDrainImpl();
        uint256 id = _propose(address(drain));
        bytes32 manual = keccak256("approver-review");
        vm.prank(approver); // a mistaken manual clearance
        aa.clear(id, manual);
        assertEq(aa.clearanceOf(id), manual);
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));
        assertFalse(aa.oracleJudged(id), "still to be judged by CRE");

        _deliver(_signed(_verdict(VETO, id)));
        assertTrue(aa.oracleJudged(id));
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Vetoed));
        vm.roll(vm.getBlockNumber() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
    }

    /// ...and a CRE Clear on an approver-cleared proposal marks it judged and keeps the first evidence hash.
    function test_approverClearedThenCreClear_judgedFirstEvidenceKept() public {
        uint256 id = _propose(address(v2));
        bytes32 manual = keccak256("approver-review");
        vm.prank(approver);
        aa.clear(id, manual);
        _deliver(_signed(_verdict(CLEAR, id)));
        assertTrue(aa.oracleJudged(id));
        assertEq(aa.clearanceOf(id), manual);
        vm.roll(vm.getBlockNumber() + DELAY);
        aa.execute(id);
        assertEq(DemoBTCV2(proxy).version(), "2");
    }

    /// The emergency guardian's veto beats the oracle's clearance.
    function test_guardianVetoBeatsOracleClearance() public {
        uint256 id = _propose(address(v2));
        _deliver(_signed(_verdict(CLEAR, id)));
        vm.prank(emergency);
        aa.veto(id, keccak256("manual"));
        vm.roll(vm.getBlockNumber() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
    }

    /// A veto report landing after a clear report still wins (and a later clear report is refused).
    function test_vetoReportAfterClearReport() public {
        uint256 id = _propose(address(evilMint));
        bytes memory clearRep = _signed(_verdict(CLEAR, id));
        _deliver(clearRep);
        _deliver(_signed(_verdict(VETO, id)));
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Vetoed));
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        _deliver(clearRep);
        vm.roll(vm.getBlockNumber() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, id));
        aa.execute(id);
    }

    function test_clearReportWithRuleHashRejected() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);
        v.rule = R1;
        bytes memory rep = _signed(v);
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.RuleOnClear.selector, R1));
        _deliver(rep);
        assertEq(aa.clearanceOf(id), bytes32(0));
    }

    function test_unknownActionRejected() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);
        v.action = 2;
        bytes memory rep = _signed(v);
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.InvalidAction.selector, uint8(2)));
        _deliver(rep);
    }

    function test_clearWithEmptyEvidenceRejected() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);
        v.evidence = bytes32(0);
        bytes memory rep = _signed(v);
        vm.expectRevert(AirlockAdmin.EmptyEvidence.selector);
        _deliver(rep);
    }

    // ------------------------------------------------------------------ proposalDigest binding

    /// A verdict about other content is rejected even when the attester signed it: here a clearance computed for
    /// an honest v2 proposal is pointed at a malicious proposal's id.
    function test_digestBinding_otherContentRejected() public {
        uint256 honest = _propose(address(v2));
        uint256 evil = _propose(address(evilMint));
        V memory v = _verdict(CLEAR, honest);
        v.id = evil; // signed for (evil id, honest content)
        bytes memory rep = _signed(v);
        vm.expectRevert(AirlockReceiver.ProposalMismatch.selector);
        _deliver(rep);
        assertEq(aa.clearanceOf(evil), bytes32(0));
        assertEq(aa.clearanceOf(honest), bytes32(0));
    }

    /// The same id on another chain history (a reorg, a fork, a redeployment) carries other content.
    function test_digestBinding_sameIdOtherHistoryRejected() public {
        uint256 id = _propose(address(evilMint));
        V memory v = _verdict(CLEAR, id);
        v.digest = keccak256(
            abi.encode(
                uint8(0), address(v2), uint256(0), address(v2).codehash, keccak256(""), uint64(vm.getBlockNumber())
            )
        );
        bytes memory rep = _signed(v);
        vm.expectRevert(AirlockReceiver.ProposalMismatch.selector);
        _deliver(rep);
        v.digest = keccak256(
            abi.encode(
                uint8(0),
                address(evilMint),
                uint256(0),
                address(evilMint).codehash,
                keccak256(""),
                uint64(vm.getBlockNumber() - 1)
            )
        );
        rep = _signed(v);
        vm.expectRevert(AirlockReceiver.ProposalMismatch.selector);
        _deliver(rep);
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));
    }

    function test_digestBinding_unknownProposalRejected() public {
        V memory v = V(CLEAR, 42, keccak256("x"), bytes32(0), EVIDENCE, uint64(vm.getBlockNumber() + 50));
        bytes memory rep = _signed(v);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.UnknownProposal.selector, 42));
        _deliver(rep);
    }

    function testFuzz_digestBinding(bytes32 wrongDigest) public {
        uint256 id = _propose(address(v2));
        vm.assume(wrongDigest != aa.proposalDigest(id));
        V memory v = _verdict(CLEAR, id);
        v.digest = wrongDigest;
        bytes memory rep = _signed(v);
        vm.expectRevert(AirlockReceiver.ProposalMismatch.selector);
        _deliver(rep);
    }

    // ------------------------------------------------------------------ validUntilBlock

    function test_validUntilBlock_inclusive_thenExpired() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);
        v.until = uint64(vm.getBlockNumber() + 5);
        bytes memory rep = _signed(v);

        vm.roll(v.until + 1);
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.ReportExpired.selector, v.until, uint256(v.until) + 1));
        _deliver(rep);

        vm.roll(v.until); // the last valid block
        _deliver(rep);
        assertEq(aa.clearanceOf(id), EVIDENCE);
    }

    function test_validUntilBlock_isSigned() public {
        uint256 id = _propose(address(evilMint));
        V memory v = _verdict(VETO, id);
        v.until = uint64(vm.getBlockNumber() + 5);
        bytes memory sig = _signWith(attester.privateKey, rx, v);
        v.until = uint64(vm.getBlockNumber() + 500); // stretched after signing
        vm.prank(forwarder);
        vm.expectRevert(); // recovers some other address
        rx.onReport("", _report(v, sig));
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));
    }

    // ------------------------------------------------------------------ replay

    function test_replay_vetoIsHarmless() public {
        uint256 id = _propose(address(evilMint));
        bytes memory rep = _signed(_verdict(VETO, id));
        _deliver(rep);
        _deliver(rep); // same proposal, already vetoed: still vetoed, counted once
        assertEq(aa.getProposal(id).vetoCount, 1);
    }

    function test_replay_clearIsIdempotent_thenRefusedOnceExecuted() public {
        uint256 id = _propose(address(v2));
        bytes memory rep = _signed(_verdict(CLEAR, id));
        _deliver(rep);
        _deliver(rep);
        assertEq(aa.clearanceOf(id), EVIDENCE);
        vm.roll(vm.getBlockNumber() + DELAY);
        aa.execute(id);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.AlreadyExecuted.selector, id));
        _deliver(rep);
    }

    /// A report for one proposal never applies to another, even one with identical content in the same block.
    function test_replay_otherIdSameContentRejected() public {
        uint256 a = _propose(address(v2));
        uint256 b = _propose(address(v2));
        assertEq(aa.proposalDigest(a), aa.proposalDigest(b));
        V memory v = _verdict(CLEAR, a);
        bytes memory sig = _signWith(attester.privateKey, rx, v);
        v.id = b;
        vm.prank(forwarder);
        vm.expectRevert(); // the id is signed: recovers some other address
        rx.onReport("", _report(v, sig));
        assertEq(aa.clearanceOf(b), bytes32(0));
    }

    // ------------------------------------------------------------------ authentication

    function test_rejectsWrongForwarder() public {
        uint256 id = _propose(address(v2));
        bytes memory rep = _signed(_verdict(CLEAR, id));
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.InvalidSender.selector, address(this), forwarder));
        rx.onReport("", rep);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.InvalidSender.selector, admin, forwarder));
        rx.onReport("", rep);
        assertEq(aa.clearanceOf(id), bytes32(0));
    }

    function test_rejectsImpostorSignature() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);
        bytes memory rep = _report(v, _signWith(impostor.privateKey, rx, v));
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.InvalidAttestation.selector, impostor.addr));
        _deliver(rep);
    }

    function test_signatureIsBoundToAction() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(VETO, id);
        v.rule = bytes32(0);
        bytes memory sig = _signWith(attester.privateKey, rx, v); // signed as a veto
        v.action = CLEAR;
        vm.prank(forwarder);
        vm.expectRevert(); // recovers some other address
        rx.onReport("", _report(v, sig));
        assertEq(aa.clearanceOf(id), bytes32(0));
    }

    function test_signatureIsBoundToReceiver() public {
        AirlockReceiver rx2 = new AirlockReceiver(address(aa), forwarder, attester.addr, bytes32(0), address(0));
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);
        bytes memory rep = _report(v, _signWith(attester.privateKey, rx2, v));
        vm.prank(forwarder);
        vm.expectRevert(); // domain separator differs
        rx.onReport("", rep);
    }

    function test_malformedSignatureRejected() public {
        uint256 id = _propose(address(v2));
        V memory v = _verdict(CLEAR, id);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, uint256(3)));
        rx.onReport("", _report(v, hex"010203"));
    }

    function test_metadataCheckedWhenConfigured() public {
        bytes32 wfId = keccak256("workflow");
        address wfOwner = makeAddr("workflowOwner");
        AirlockReceiver strict = new AirlockReceiver(address(aa), forwarder, attester.addr, wfId, wfOwner);
        uint256 id = _propose(address(evilMint));
        V memory v = _verdict(VETO, id);
        bytes memory rep = _report(v, _signWith(attester.privateKey, strict, v));

        vm.startPrank(forwarder);
        vm.expectRevert(AirlockReceiver.InvalidMetadata.selector);
        strict.onReport("", rep);
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.InvalidWorkflowId.selector, bytes32(uint256(1)), wfId));
        strict.onReport(_metadata(bytes32(uint256(1)), wfOwner), rep);
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.InvalidWorkflowOwner.selector, address(0xbeef), wfOwner));
        strict.onReport(_metadata(wfId, address(0xbeef)), rep);
        vm.stopPrank();
        // `strict` is not a guardian of `aa`, so a fully valid report gets as far as AirlockAdmin and stops there.
        vm.expectRevert(AirlockAdmin.NotGuardian.selector);
        vm.prank(forwarder);
        strict.onReport(_metadata(wfId, wfOwner), rep);
        // nor is it the clearance oracle
        V memory c = _verdict(CLEAR, id);
        bytes memory clearRep = _report(c, _signWith(attester.privateKey, strict, c));
        vm.expectRevert(AirlockAdmin.NotClearer.selector);
        vm.prank(forwarder);
        strict.onReport(_metadata(wfId, wfOwner), clearRep);
    }

    function test_supportsInterface() public view {
        assertTrue(rx.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(rx.supportsInterface(type(IERC165).interfaceId));
        assertFalse(rx.supportsInterface(0xffffffff));
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(AirlockReceiver.ZeroAddress.selector);
        new AirlockReceiver(address(0), forwarder, attester.addr, bytes32(0), address(0));
        vm.expectRevert(AirlockReceiver.ZeroAddress.selector);
        new AirlockReceiver(address(aa), address(0), attester.addr, bytes32(0), address(0));
        vm.expectRevert(AirlockReceiver.ZeroAddress.selector);
        new AirlockReceiver(address(aa), forwarder, address(0), bytes32(0), address(0));
    }

    /// Only the attester's signatures carry a verdict, for either action.
    function testFuzz_impostorSignatureRejected(uint256 pk, bool clear) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(pk != attester.privateKey);
        uint256 id = _propose(address(evilMint));
        V memory v = _verdict(clear ? CLEAR : VETO, id);
        bytes memory rep = _report(v, _signWith(pk, rx, v));
        vm.expectRevert(abi.encodeWithSelector(AirlockReceiver.InvalidAttestation.selector, vm.addr(pk)));
        _deliver(rep);
        assertEq(uint8(_status(id)), uint8(AirlockAdmin.Status.Pending));
        assertEq(aa.clearanceOf(id), bytes32(0));
    }
}
