// SPDX-License-Identifier: MIT
// Known limitations of AirlockAdmin. Each test asserts the CURRENT behaviour so the limitation stays documented and
// reproducible. When a later version removes one, its test fails: replace it with a test of the protective
// behaviour. These are testnet demo contracts, and this file is where their known limitations are recorded.
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {AirlockAdmin} from "../../src/AirlockAdmin.sol";
import {DemoBTC} from "../../src/DemoBTC.sol";
import {DemoBTCV2} from "../../src/DemoBTCV2.sol";
import {PausedImpl} from "../../src/PausedImpl.sol";

contract DemoBTCV3 is DemoBTC {
    function version() external pure returns (string memory) {
        return "3";
    }
}

/// Reinitializer-style impl: its codehash says nothing about who the init args name.
contract DemoBTCV2Init is DemoBTC {
    function initializeV2(address newOwner) external reinitializer(2) {
        _transferOwnership(newOwner);
    }
}

contract KnownIssuesTest is Test {
    uint64 constant DELAY = 30;
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
    address stranger = makeAddr("stranger");

    DemoBTC v1;
    DemoBTCV2 v2;
    DemoBTCV3 v3;
    PausedImpl pausedImpl;
    address proxy;
    ProxyAdmin proxyAdmin;
    AirlockAdmin aa;
    DemoBTC token;

    function setUp() public {
        vm.roll(100);
        vm.etch(oracle, hex"00");
        vm.startPrank(deployer);
        v1 = new DemoBTC();
        address[] memory holders = new address[](2);
        holders[0] = h1;
        holders[1] = h2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 100e8;
        amounts[1] = 50e8;
        proxy = address(
            new TransparentUpgradeableProxy(
                address(v1), admin, abi.encodeCall(DemoBTC.initialize, (admin, holders, amounts))
            )
        );
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));
        v2 = new DemoBTCV2();
        v3 = new DemoBTCV3();
        pausedImpl = new PausedImpl();
        address[] memory g = new address[](3);
        g[0] = s1;
        g[1] = s2;
        g[2] = s3;
        aa = new AirlockAdmin(address(proxyAdmin), proxy, admin, g, approver, address(pausedImpl), DELAY, oracle);
        vm.stopPrank();
        token = DemoBTC(proxy);
        vm.startPrank(admin);
        proxyAdmin.transferOwnership(address(aa));
        token.transferOwnership(address(aa));
        vm.stopPrank();
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _proposeCleared(address impl) internal returns (uint256 id) {
        vm.prank(admin);
        id = aa.proposeUpgrade(impl, "");
        vm.prank(oracle);
        aa.clear(id, EVIDENCE);
    }

    /// A matured, cleared, never-executed Upgrade proposal lets ANYONE undo breakGlass in the same block.
    function test_knownIssue_staleProposalUndoesBreakGlassInstantly() public {
        uint256 stale = _proposeCleared(address(v1)); // benign, the oracle clears it, nobody executes
        vm.roll(vm.getBlockNumber() + 5000); // long matured

        vm.prank(s1);
        aa.breakGlass(); // incident: guardians freeze the token
        assertTrue(aa.paused());

        vm.prank(stranger); // same block, no key at all
        aa.execute(stale);
        assertFalse(aa.paused());
        assertEq(_impl(), address(v1));
        vm.prank(h1);
        assertTrue(token.transfer(h2, 1e8)); // unfrozen, zero blocks of delay
    }

    /// Proposals and clearances never expire and execute order is free: anyone can roll back to an older impl.
    function test_knownIssue_staleProposalRollback() public {
        uint256 pOld = _proposeCleared(address(v2));
        uint256 pNew = _proposeCleared(address(v3));
        vm.roll(vm.getBlockNumber() + DELAY);
        aa.execute(pNew);
        assertEq(_impl(), address(v3));
        vm.roll(vm.getBlockNumber() + 100_000);
        vm.prank(stranger);
        aa.execute(pOld); // downgrade, months later, by anyone
        assertEq(_impl(), address(v2));
    }

    /// One rogue guardian (any one of the guardian keys): pause, then veto every exit forever. A clearance does
    /// not help: a veto always wins.
    function test_knownIssue_singleGuardianPermanentFreeze() public {
        vm.prank(s3);
        aa.breakGlass();
        for (uint256 round = 0; round < 5; round++) {
            vm.prank(admin);
            uint256 unpause = aa.proposeUpgrade(address(v1), "");
            vm.prank(admin);
            uint256 removeS3 = aa.proposeSetGuardian(s3, false);
            vm.startPrank(approver);
            aa.clear(unpause, EVIDENCE);
            aa.clear(removeS3, EVIDENCE);
            vm.stopPrank();
            vm.startPrank(s3);
            aa.veto(unpause, bytes32(0));
            aa.veto(removeS3, bytes32(0));
            vm.stopPrank();
            vm.roll(vm.getBlockNumber() + DELAY);
            vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, unpause));
            aa.execute(unpause);
            vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.ProposalVetoed.selector, removeS3));
            aa.execute(removeS3);
        }
        assertTrue(aa.paused());
        assertTrue(aa.isGuardian(s3));
        vm.prank(h1);
        vm.expectRevert(PausedImpl.TokenPaused.selector);
        token.transfer(h2, 1);
    }

    /// Stolen owner key (immutable, cannot be rotated): re-pause right after every legitimate unpause.
    function test_knownIssue_stolenOwnerRepausesForever() public {
        for (uint256 round = 0; round < 3; round++) {
            vm.prank(admin); // attacker copy of the key
            aa.breakGlass();
            uint256 id = _proposeCleared(address(v1)); // team copy of the key, cleared by the oracle
            vm.roll(vm.getBlockNumber() + DELAY);
            aa.execute(id);
            assertFalse(aa.paused());
        }
        vm.prank(admin);
        aa.breakGlass(); // same block as the last unpause
        assertTrue(aa.paused());
    }

    /// The config rule treats raising the delay as "not weakening", so it is cleared; the attacker then makes every
    /// legitimate unpause wait MAX_DELAY_BLOCKS while re-pausing at will.
    function test_knownIssue_raiseDelayThenPause() public {
        vm.prank(admin);
        uint256 id = aa.proposeSetDelay(50_400);
        vm.prank(oracle);
        aa.clear(id, EVIDENCE);
        vm.roll(vm.getBlockNumber() + DELAY);
        aa.execute(id);
        vm.prank(admin);
        aa.breakGlass();
        vm.prank(admin);
        uint256 unpause = aa.proposeUpgrade(address(v1), "");
        assertEq(aa.getProposal(unpause).readyBlock, vm.getBlockNumber() + 50_400);
    }

    /// The unpause is an upgrade, so it needs a clearance too: while the oracle is down and the approver is
    /// unreachable, a paused token stays paused however long everyone waits.
    function test_knownIssue_unpauseNeedsAClearer() public {
        vm.prank(s1);
        aa.breakGlass();
        vm.prank(admin);
        uint256 unpause = aa.proposeUpgrade(address(v1), "");
        vm.roll(vm.getBlockNumber() + 100_000);
        vm.expectRevert(abi.encodeWithSelector(AirlockAdmin.NotCleared.selector, unpause));
        aa.execute(unpause);
        assertTrue(aa.paused());
    }

    /// isApprovedCodehash is a registry only, and a clearance is per proposal: the contract checks only that the
    /// target's code is still the code that was proposed, never the registry or the init data. Init data runs with
    /// msg.sender = ProxyAdmin, so reinitializer args are whatever the owner proposed; only the clearer's judgement
    /// (the workflow's init-data rule, or the approver) stops it.
    function test_knownIssue_clearedReinitializerHandsOwnership() public {
        DemoBTCV2Init vi = new DemoBTCV2Init();
        vm.prank(admin);
        uint256 id = aa.proposeUpgrade(address(vi), abi.encodeCall(DemoBTCV2Init.initializeV2, (stranger)));
        vm.prank(approver); // a mistaken manual clearance
        aa.clear(id, EVIDENCE);
        vm.roll(vm.getBlockNumber() + DELAY);
        assertFalse(aa.isApprovedCodehash(address(vi).codehash));
        aa.execute(id); // no on-chain check of the registry or the data
        assertEq(token.owner(), stranger);
    }

    /// oracleJudged tells the sweeper what CRE still has to judge; it is not a third door. A manual clearance alone
    /// lets a proposal run after the cooldown when no oracle verdict lands in time (the approver is the fallback
    /// for an unavailable oracle). The sweep window: the sweeper scans only the newest `sweepWindow` ids (20, at
    /// most 30), so an approver-cleared proposal whose Proposed log the trigger missed, and that falls below the
    /// window before a sweep reaches it (`sweepWindow` newer proposals), is never judged by CRE and executes on the
    /// approver's clearance alone. The approver's manual clearance is an override by design.
    function test_knownIssue_approverClearanceRunsWithoutOracleVerdict() public {
        vm.prank(admin);
        uint256 id = aa.proposeUpgrade(address(v2), "");
        vm.prank(approver);
        aa.clear(id, EVIDENCE);
        vm.roll(vm.getBlockNumber() + DELAY);
        assertFalse(aa.oracleJudged(id));
        vm.prank(stranger);
        aa.execute(id);
        assertEq(_impl(), address(v2));
    }

    /// ProxyAdmin ownership can never leave AirlockAdmin: no migration path.
    function test_knownIssue_noMigrationPath() public view {
        assertEq(proxyAdmin.owner(), address(aa));
        // AirlockAdmin exposes no call to ProxyAdmin.transferOwnership; owner, approver and clearanceOracle are
        // immutable.
        assertEq(aa.owner(), admin);
        assertEq(aa.clearanceOracle(), oracle);
    }
}
