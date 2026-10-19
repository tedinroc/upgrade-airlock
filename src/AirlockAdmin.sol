// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @title AirlockAdmin
/// @notice Owner of an OZ ProxyAdmin (and of the token's Ownable). Every upgrade, and every change to the airlock
///         itself, passes two doors before it can run:
///         1. a cooldown of `delayBlocks` blocks during which any guardian can veto it, and
///         2. a clearance: `clearanceOracle` (the Chainlink CRE report receiver) or the human `approver` must
///            record an evidence hash for the proposal.
///         A veto always wins over a clearance. `breakGlass` switches the proxy to a pre-registered paused
///         implementation immediately; leaving the paused state is an ordinary upgrade and passes both doors.
/// @dev Time is measured in block numbers only (never timestamps). The contract does not judge whether a new
///      implementation is good or bad; the clearance oracle does that off-chain and binds its verdict to
///      `proposalDigest(id)`, which includes the target's codehash. So that a verdict is about the code that
///      actually runs, an upgrade or break-glass target must be ordinary contract code: an EIP-7702 delegated
///      account (code `0xef0100 || delegate`) is refused, and `execute` refuses a target whose codehash differs
///      from the one recorded at propose time (`CodehashChanged`).
///      `oracleJudged[id]` records whether the clearance oracle itself has delivered a verdict (Clear or Veto) on
///      a proposal, apart from a manual clearance by the approver, so the oracle can still judge a proposal the
///      approver cleared (and veto it: a veto still wins).
///      Roles never overlap: the owner (who proposes) is neither the approver nor a guardian nor the clearance
///      oracle, so no single key can both propose and let its own proposal through.
contract AirlockAdmin {
    // ---------------------------------------------------------------- constants
    uint64 public constant MIN_DELAY_BLOCKS = 10;
    uint64 public constant MAX_DELAY_BLOCKS = 50_400;
    uint256 public constant MAX_GUARDIANS = 8;
    uint256 public constant MIN_GUARDIANS = 1;

    // ---------------------------------------------------------------- enums
    enum Kind {
        Upgrade,
        SetGuardian,
        SetDelay,
        SetPausedImpl
    }

    enum Status {
        None,
        Pending,
        Vetoed,
        Executed
    }

    struct Proposal {
        Kind kind;
        Status status;
        address proposer;
        address target;
        uint256 value;
        bytes32 codehash;
        bytes32 dataHash;
        uint64 proposedBlock;
        uint64 readyBlock;
        uint256 vetoCount;
    }

    // ---------------------------------------------------------------- events
    event Proposed(
        uint256 indexed id,
        uint8 indexed kind,
        address indexed target,
        uint256 value,
        bytes data,
        bytes32 codehash,
        uint64 readyBlock
    );
    event Vetoed(uint256 indexed id, address indexed guardian, bytes32 ruleHash, uint256 vetoCount);
    event Cleared(uint256 indexed id, address indexed clearer, bytes32 evidenceHash);
    event Executed(uint256 indexed id, address executor);
    event ReasonAttached(uint256 indexed id, address guardian, bytes32 reportHash);
    event CodehashApproved(bytes32 indexed codehash, address approver);
    event BrokeGlass(address indexed caller, address pausedImpl);
    event GuardianSet(address indexed guardian, bool enabled);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotGuardian();
    error NotApprover();
    error NotClearer();
    error NotOwnerOrGuardian();
    error UnknownProposal(uint256 id);
    error TooEarly(uint256 id, uint64 readyBlock, uint64 currentBlock);
    error NotCleared(uint256 id);
    error ProposalVetoed(uint256 id);
    error AlreadyExecuted(uint256 id);
    error EmptyEvidence();
    error InvalidDelay(uint64 value);
    error GuardianBounds(uint256 count);
    error RoleOverlap();
    error ZeroAddress();
    error NoCode(address target);
    /// @notice `target` is an EIP-7702 delegated account: its code is a delegation designator, not the code that runs.
    error DelegatedAccount(address target);
    /// @notice The target's code is no longer the code proposal `id` was judged on.
    error CodehashChanged(uint256 id, bytes32 proposedCodehash, bytes32 currentCodehash);
    error AlreadyPaused();

    // ---------------------------------------------------------------- immutable wiring
    address public immutable proxyAdmin;
    address public immutable proxy;
    address public immutable owner;
    address public immutable approver;
    /// @notice The contract whose verdicts clear proposals (the CRE report receiver).
    address public immutable clearanceOracle;

    // ---------------------------------------------------------------- state
    uint64 public delayBlocks;
    bool public paused;
    address public pausedImpl;
    uint256 public guardianCount;
    uint256 public nextId = 1; // id 0 is reserved for "does not exist"

    mapping(address => bool) public isGuardian;
    mapping(bytes32 => bool) public isApprovedCodehash;
    /// @notice Whether `guardian` has already been counted in `vetoCount` of proposal `id`.
    mapping(uint256 => mapping(address => bool)) public hasVetoed;
    /// @notice Evidence hash of the first clearance of proposal `id`; zero while it is not cleared.
    mapping(uint256 => bytes32) public clearanceOf;
    /// @notice True once the clearance oracle itself has cleared or vetoed proposal `id`. A clearance by the approver
    ///         does not set it, so the oracle can still judge (and veto) a proposal the approver cleared by hand.
    mapping(uint256 => bool) public oracleJudged;

    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => bytes) private _data;

    // ---------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGuardian() {
        if (!isGuardian[msg.sender]) revert NotGuardian();
        _;
    }

    constructor(
        address proxyAdmin_,
        address proxy_,
        address owner_,
        address[] memory guardians_,
        address approver_,
        address pausedImpl_,
        uint64 delayBlocks_,
        address clearanceOracle_
    ) {
        if (
            proxyAdmin_ == address(0) || proxy_ == address(0) || owner_ == address(0) || approver_ == address(0)
                || pausedImpl_ == address(0) || clearanceOracle_ == address(0)
        ) revert ZeroAddress();
        if (proxyAdmin_.code.length == 0) revert NoCode(proxyAdmin_);
        if (proxy_.code.length == 0) revert NoCode(proxy_);
        _requireContractCode(pausedImpl_);
        if (clearanceOracle_.code.length == 0) revert NoCode(clearanceOracle_);
        if (_isDelegated(clearanceOracle_)) revert DelegatedAccount(clearanceOracle_); // a key could sign as the oracle
        if (approver_ == owner_ || clearanceOracle_ == owner_) revert RoleOverlap();
        _checkDelay(delayBlocks_);

        proxyAdmin = proxyAdmin_;
        proxy = proxy_;
        owner = owner_;
        approver = approver_;
        pausedImpl = pausedImpl_;
        delayBlocks = delayBlocks_;
        clearanceOracle = clearanceOracle_;

        uint256 count = 0;
        for (uint256 i = 0; i < guardians_.length; i++) {
            address g = guardians_[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (g == address(0)) revert ZeroAddress();
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (g == owner_) revert RoleOverlap();
            if (isGuardian[g]) continue; // duplicates are counted once
            isGuardian[g] = true;
            count++;
            emit GuardianSet(g, true);
        }
        if (count < MIN_GUARDIANS || count > MAX_GUARDIANS) revert GuardianBounds(count);
        guardianCount = count;
    }

    // ---------------------------------------------------------------- proposals (owner)

    function proposeUpgrade(address newImpl, bytes calldata data) external onlyOwner returns (uint256 id) {
        _requireContractCode(newImpl);
        id = _propose(Kind.Upgrade, newImpl, 0, newImpl.codehash, data);
    }

    function proposeSetGuardian(address guardian, bool enabled) external onlyOwner returns (uint256 id) {
        if (guardian == address(0)) revert ZeroAddress();
        if (enabled && guardian == owner) revert RoleOverlap(); // fail at propose time, not after the cooldown
        id = _propose(Kind.SetGuardian, guardian, enabled ? 1 : 0, bytes32(0), "");
    }

    function proposeSetDelay(uint64 newDelay) external onlyOwner returns (uint256 id) {
        _checkDelay(newDelay);
        id = _propose(Kind.SetDelay, address(0), newDelay, bytes32(0), "");
    }

    function proposeSetPausedImpl(address impl) external onlyOwner returns (uint256 id) {
        _requireContractCode(impl);
        id = _propose(Kind.SetPausedImpl, impl, 0, impl.codehash, "");
    }

    // ---------------------------------------------------------------- clearance (oracle or approver)

    /// @notice Record that proposal `id` was judged safe. Only the clearance oracle or the approver may call it,
    ///         only while the proposal is Pending. Idempotent: a second clearance keeps the first evidence hash
    ///         (and still emits `Cleared` with the caller's evidence, so every clearance is observable).
    ///         A clearance never overrides a veto: once vetoed, the proposal can neither be cleared nor executed.
    ///         A clearance by the oracle also sets `oracleJudged[id]` (also when the approver cleared it first).
    function clear(uint256 id, bytes32 evidenceHash) external {
        bool byOracle = msg.sender == clearanceOracle;
        if (!byOracle && msg.sender != approver) revert NotClearer();
        _requirePending(id);
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        if (clearanceOf[id] == bytes32(0)) clearanceOf[id] = evidenceHash;
        if (byOracle) oracleJudged[id] = true;
        emit Cleared(id, msg.sender, evidenceHash);
    }

    // ---------------------------------------------------------------- execute (anyone)

    /// @notice Run a proposal once it is past its readyBlock, not vetoed, and cleared. Anyone may call it.
    ///         An upgrade or break-glass target must still have the codehash it had when it was proposed (the code
    ///         the verdict was about); otherwise it reverts `CodehashChanged` and the proposal stays Pending.
    function execute(uint256 id) external {
        Proposal storage p = _proposals[id];
        _requirePending(id);
        uint64 current = _blockNumber();
        if (current < p.readyBlock) revert TooEarly(id, p.readyBlock, current);
        if (clearanceOf[id] == bytes32(0)) revert NotCleared(id);
        Kind kind = p.kind;
        if (kind == Kind.Upgrade || kind == Kind.SetPausedImpl) {
            bytes32 actual = p.target.codehash;
            if (actual != p.codehash) revert CodehashChanged(id, p.codehash, actual);
        }

        p.status = Status.Executed; // effects (and the event) before the external call
        emit Executed(id, msg.sender);

        if (kind == Kind.Upgrade) {
            ProxyAdmin(proxyAdmin).upgradeAndCall(ITransparentUpgradeableProxy(proxy), p.target, _data[id]);
            if (paused) paused = false; // leaving the paused state goes through both doors like any upgrade
        } else if (kind == Kind.SetGuardian) {
            _setGuardian(p.target, p.value == 1);
        } else if (kind == Kind.SetDelay) {
            // forge-lint: disable-next-line(unsafe-typecast)
            delayBlocks = uint64(p.value); // bounded by _checkDelay at propose time
        } else {
            pausedImpl = p.target; // code checked above: same codehash as at propose time, so not empty
        }
    }

    // ---------------------------------------------------------------- guardians

    /// @notice Veto a pending (cleared or not) proposal. Idempotent: vetoing an already vetoed proposal keeps the
    ///         status, counts the guardian (once per guardian) and emits the event again. A veto by the clearance
    ///         oracle (which is also a guardian) sets `oracleJudged[id]`.
    function veto(uint256 id, bytes32 ruleHash) external onlyGuardian {
        Proposal storage p = _proposals[id];
        Status s = p.status;
        if (s == Status.None) revert UnknownProposal(id);
        if (s == Status.Executed) revert AlreadyExecuted(id);
        if (s == Status.Pending) p.status = Status.Vetoed;
        if (msg.sender == clearanceOracle) oracleJudged[id] = true;
        if (!hasVetoed[id][msg.sender]) {
            hasVetoed[id][msg.sender] = true;
            p.vetoCount += 1;
        }
        emit Vetoed(id, msg.sender, ruleHash, p.vetoCount);
    }

    function attachReason(uint256 id, bytes32 reportHash) external onlyGuardian {
        if (_proposals[id].status == Status.None) revert UnknownProposal(id);
        emit ReasonAttached(id, msg.sender, reportHash);
    }

    // ---------------------------------------------------------------- approver

    /// @notice Registration only: the contract never reads it. The clearance oracle reads it in strict mode.
    function approveCodehash(bytes32 codehash) external {
        if (msg.sender != approver) revert NotApprover();
        isApprovedCodehash[codehash] = true;
        emit CodehashApproved(codehash, msg.sender);
    }

    // ---------------------------------------------------------------- break glass

    function breakGlass() external {
        if (msg.sender != owner && !isGuardian[msg.sender]) revert NotOwnerOrGuardian();
        if (paused) revert AlreadyPaused();
        paused = true;
        address impl = pausedImpl;
        emit BrokeGlass(msg.sender, impl);
        ProxyAdmin(proxyAdmin).upgradeAndCall(ITransparentUpgradeableProxy(proxy), impl, "");
    }

    // ---------------------------------------------------------------- views

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    /// @notice The exact `data` of a proposal (its keccak256 is `dataHash`).
    function getProposalData(uint256 id) external view returns (bytes memory) {
        return _data[id];
    }

    /// @notice What a verdict about proposal `id` is bound to:
    ///         keccak256(abi.encode(uint8 kind, address target, uint256 value, bytes32 codehash, bytes32 dataHash,
    ///         uint64 proposedBlock)). A verdict signed for other content (another chain history, another
    ///         implementation, other init data) does not match.
    function proposalDigest(uint256 id) public view returns (bytes32) {
        Proposal storage p = _proposals[id];
        if (p.status == Status.None) revert UnknownProposal(id);
        return keccak256(abi.encode(p.kind, p.target, p.value, p.codehash, p.dataHash, p.proposedBlock));
    }

    /// @notice True once the ProxyAdmin's owner has been handed to this contract.
    function isWired() external view returns (bool) {
        return ProxyAdmin(proxyAdmin).owner() == address(this);
    }

    // ---------------------------------------------------------------- internal

    function _propose(Kind kind, address target, uint256 value, bytes32 codehash, bytes memory data)
        internal
        returns (uint256 id)
    {
        id = nextId++;
        uint64 current = _blockNumber();
        uint64 ready = current + delayBlocks;
        _proposals[id] = Proposal({
            kind: kind,
            status: Status.Pending,
            proposer: msg.sender,
            target: target,
            value: value,
            codehash: codehash,
            dataHash: keccak256(data),
            proposedBlock: current,
            readyBlock: ready,
            vetoCount: 0
        });
        if (data.length != 0) _data[id] = data;
        emit Proposed(id, uint8(kind), target, value, data, codehash, ready);
    }

    function _requirePending(uint256 id) internal view {
        Status s = _proposals[id].status;
        if (s == Status.None) revert UnknownProposal(id);
        if (s == Status.Vetoed) revert ProposalVetoed(id);
        if (s == Status.Executed) revert AlreadyExecuted(id);
    }

    function _setGuardian(address g, bool enabled) internal {
        if (enabled && g == owner) revert RoleOverlap();
        if (isGuardian[g] == enabled) {
            emit GuardianSet(g, enabled); // no-op, but observable
            return;
        }
        uint256 count = enabled ? guardianCount + 1 : guardianCount - 1;
        if (count < MIN_GUARDIANS || count > MAX_GUARDIANS) revert GuardianBounds(count);
        isGuardian[g] = enabled;
        guardianCount = count;
        emit GuardianSet(g, enabled);
    }

    /// @dev An upgrade or break-glass target must carry its own code: not empty, and not an EIP-7702 delegation
    ///      designator (whose codehash says nothing about the code it runs, and which its key can re-point).
    function _requireContractCode(address target) internal view {
        if (target.code.length == 0) revert NoCode(target);
        if (_isDelegated(target)) revert DelegatedAccount(target);
    }

    /// @dev True when `account`'s code starts with 0xef01: an EIP-7702 delegation designator (0xef0100 || address,
    ///      23 bytes; early drafts of EIP-7702 exposed only 0xef01). EIP-3541 keeps 0xef out of the first byte of any
    ///      deployed contract, so no other code starts that way. Only short code is copied.
    function _isDelegated(address account) internal view returns (bool) {
        uint256 size = account.code.length;
        if (size < 2 || size > 23) return false;
        bytes memory code = account.code;
        return code[0] == 0xef && code[1] == 0x01;
    }

    function _blockNumber() internal view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.number); // block numbers fit in 64 bits for the lifetime of any chain
    }

    function _checkDelay(uint64 value) internal pure {
        if (value < MIN_DELAY_BLOCKS || value > MAX_DELAY_BLOCKS) revert InvalidDelay(value);
    }
}
