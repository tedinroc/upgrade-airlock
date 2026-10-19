// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IReceiver} from "./IReceiver.sol";

/// @notice The AirlockAdmin calls this receiver makes: as a guardian (veto, attachReason) and as the clearance
///         oracle (clear), plus the digest every verdict is bound to.
interface IAirlockAdminOracle {
    function veto(uint256 id, bytes32 ruleHash) external;
    function attachReason(uint256 id, bytes32 reportHash) external;
    function clear(uint256 id, bytes32 evidenceHash) external;
    function proposalDigest(uint256 id) external view returns (bytes32);
}

/// @title AirlockReceiver
/// @notice Turns a Chainlink CRE report into an AirlockAdmin verdict. It is both the AirlockAdmin clearance oracle
///         and one of its guardians: the CRE workflow simulates every proposal and writes a report either way,
///         `Clear` when every check passes (the proposal may run after its cooldown) or `Veto` when one fails
///         (it never runs).
/// @dev Authentication, in order:
///      1. `msg.sender` must be the configured forwarder and, when configured, the report metadata must name the
///         expected workflow id and owner. With the production KeystoneForwarder the metadata is backed by DON
///         signatures.
///      2. The report must still be fresh (`block.number <= validUntilBlock`).
///      3. The report carries an EIP-712 signature by `attester` (a CRE secret held by the workflow). This keeps
///         the simulation path safe: the MockKeystoneForwarder used by `cre workflow simulate` is permissionless
///         and does not verify metadata, so without it anyone could route a fake verdict through the mock.
///      4. The signed `proposalDigest` must equal `AirlockAdmin.proposalDigest(proposalId)`, so a verdict about
///         one proposal's content can never clear (or veto) a proposal with other content under the same id.
///      A verdict can only stop a pending proposal or let it through its second door; it can never move funds.
contract AirlockReceiver is IReceiver, EIP712 {
    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(address airlockAdmin,uint8 action,uint256 proposalId,bytes32 proposalDigest,bytes32 ruleHash,bytes32 evidenceHash,uint64 validUntilBlock)"
    );

    uint8 public constant ACTION_VETO = 0;
    uint8 public constant ACTION_CLEAR = 1;

    IAirlockAdminOracle public immutable airlockAdmin;
    address public immutable forwarder;
    address public immutable attester;
    /// @notice Zero means "not checked" (simulation, where the mock forwarder does not vouch for metadata).
    bytes32 public immutable expectedWorkflowId;
    /// @notice Zero means "not checked".
    address public immutable expectedWorkflowOwner;

    event Verdict(
        uint256 indexed proposalId, uint8 indexed action, bytes32 ruleHash, bytes32 evidenceHash, bytes32 workflowId
    );

    error ZeroAddress();
    error InvalidSender(address sender, address expected);
    error InvalidMetadata();
    error InvalidWorkflowId(bytes32 got, bytes32 expected);
    error InvalidWorkflowOwner(address got, address expected);
    error ReportExpired(uint64 validUntilBlock, uint256 currentBlock);
    error InvalidAttestation(address signer);
    error InvalidAction(uint8 action);
    error RuleOnClear(bytes32 ruleHash);
    error ProposalMismatch();

    constructor(
        address airlockAdmin_,
        address forwarder_,
        address attester_,
        bytes32 expectedWorkflowId_,
        // forge-lint: disable-next-line(missing-zero-check)
        address expectedWorkflowOwner_ // zero = not checked
    ) EIP712("AirlockReceiver", "1") {
        if (airlockAdmin_ == address(0) || forwarder_ == address(0) || attester_ == address(0)) revert ZeroAddress();
        airlockAdmin = IAirlockAdminOracle(airlockAdmin_);
        forwarder = forwarder_;
        attester = attester_;
        expectedWorkflowId = expectedWorkflowId_;
        expectedWorkflowOwner = expectedWorkflowOwner_;
    }

    /// @inheritdoc IReceiver
    /// @dev `report` = abi.encode(uint8 action, uint256 proposalId, bytes32 proposalDigest, bytes32 ruleHash,
    ///      bytes32 evidenceHash, uint64 validUntilBlock, bytes signature). `action` 0 = Veto, 1 = Clear (whose
    ///      `ruleHash` must be zero). `evidenceHash` is the keccak256 of the workflow's canonical evidence JSON.
    ///      Accepted while block.number <= validUntilBlock; the workflow sets it from the proposal's readyBlock (or
    ///      the current block, whichever is later) plus a grace, so validity needs no clock.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        bytes32 workflowId = _checkWorkflowMetadata(metadata);

        (
            uint8 action,
            uint256 proposalId,
            bytes32 digest,
            bytes32 ruleHash,
            bytes32 evidenceHash,
            uint64 validUntilBlock,
            bytes memory signature
        ) = abi.decode(report, (uint8, uint256, bytes32, bytes32, bytes32, uint64, bytes));
        if (block.number > validUntilBlock) revert ReportExpired(validUntilBlock, block.number);
        address signer = ECDSA.recover(
            verdictDigest(action, proposalId, digest, ruleHash, evidenceHash, validUntilBlock), signature
        );
        if (signer != attester) revert InvalidAttestation(signer);
        if (action > ACTION_CLEAR) revert InvalidAction(action);
        if (action == ACTION_CLEAR && ruleHash != bytes32(0)) revert RuleOnClear(ruleHash);
        if (digest != airlockAdmin.proposalDigest(proposalId)) revert ProposalMismatch();

        // Emitted before the state-changing calls (undone if AirlockAdmin reverts); the only call before it is the
        // proposalDigest view.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Verdict(proposalId, action, ruleHash, evidenceHash, workflowId);
        if (action == ACTION_VETO) {
            airlockAdmin.veto(proposalId, ruleHash);
            airlockAdmin.attachReason(proposalId, evidenceHash);
        } else {
            airlockAdmin.clear(proposalId, evidenceHash);
        }
    }

    /// @notice The EIP-712 digest the attester signs (domain "AirlockReceiver", version "1", this chain, this
    ///         receiver).
    function verdictDigest(
        uint8 action,
        uint256 proposalId,
        bytes32 proposalDigest,
        bytes32 ruleHash,
        bytes32 evidenceHash,
        uint64 validUntilBlock
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VERDICT_TYPEHASH,
                    address(airlockAdmin),
                    action,
                    proposalId,
                    proposalDigest,
                    ruleHash,
                    evidenceHash,
                    validUntilBlock
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @dev Metadata layout from the KeystoneForwarder: workflowId(32) | workflowName(10) | workflowOwner(20) |
    ///      reportId(2). Returns the workflow id (zero when the metadata is too short and nothing is checked).
    function _checkWorkflowMetadata(bytes calldata metadata) internal view returns (bytes32 workflowId) {
        if (metadata.length >= 32) workflowId = bytes32(metadata[0:32]);
        bytes32 wantId = expectedWorkflowId;
        address wantOwner = expectedWorkflowOwner;
        if (wantId == bytes32(0) && wantOwner == address(0)) return workflowId;
        if (metadata.length < 62) revert InvalidMetadata();
        if (wantId != bytes32(0) && workflowId != wantId) revert InvalidWorkflowId(workflowId, wantId);
        if (wantOwner != address(0)) {
            address gotOwner = address(bytes20(metadata[42:62]));
            if (gotOwner != wantOwner) revert InvalidWorkflowOwner(gotOwner, wantOwner);
        }
    }
}
