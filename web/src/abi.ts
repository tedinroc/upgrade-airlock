// The parts of the contract ABIs the war room reads. Written from the contracts' interface; test/airlock-selftest.ts
// compares every event topic and function selector here with the forge artifacts in out/ (FOUNDRY_PROFILE=eth).
import { parseAbi } from 'viem'

/** src/AirlockAdmin.sol: events the airlock is drawn from, and the views the page calls */
export const ADMIN_ABI = parseAbi([
  'event Proposed(uint256 indexed id, uint8 indexed kind, address indexed target, uint256 value, bytes data, bytes32 codehash, uint64 readyBlock)',
  'event Vetoed(uint256 indexed id, address indexed guardian, bytes32 ruleHash, uint256 vetoCount)',
  'event Cleared(uint256 indexed id, address indexed clearer, bytes32 evidenceHash)',
  'event Executed(uint256 indexed id, address executor)',
  'event ReasonAttached(uint256 indexed id, address guardian, bytes32 reportHash)',
  'struct Proposal { uint8 kind; uint8 status; address proposer; address target; uint256 value; bytes32 codehash; bytes32 dataHash; uint64 proposedBlock; uint64 readyBlock; uint256 vetoCount; }',
  'function getProposal(uint256 id) view returns (Proposal)',
  'function clearanceOf(uint256 id) view returns (bytes32)',
  'function nextId() view returns (uint256)',
  'function delayBlocks() view returns (uint64)',
])

/** src/cre/AirlockReceiver.sol: one Verdict per accepted Chainlink CRE report (action 0 = Veto, 1 = Clear) */
export const RECEIVER_ABI = parseAbi([
  'event Verdict(uint256 indexed proposalId, uint8 indexed action, bytes32 ruleHash, bytes32 evidenceHash, bytes32 workflowId)',
])

export const ACTION_VETO = 0
export const ACTION_CLEAR = 1

/** Proposal.status */
export const STATUS = { None: 0, Pending: 1, Vetoed: 2, Executed: 3 } as const
