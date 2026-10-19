// Minimal ABI fragments, written from the signatures in src/AirlockAdmin.sol, src/cre/AirlockReceiver.sol and
// src/DemoBTC.sol, plus Multicall3 (batched reads).
import { keccak256, parseAbi } from 'viem'

export const AIRLOCK_ADMIN_ABI = parseAbi([
  'event Proposed(uint256 indexed id, uint8 indexed kind, address indexed target, uint256 value, bytes data, bytes32 codehash, uint64 readyBlock)',
  'event Cleared(uint256 indexed id, address indexed clearer, bytes32 evidenceHash)',
  'event Vetoed(uint256 indexed id, address indexed guardian, bytes32 ruleHash, uint256 vetoCount)',
  'function nextId() view returns (uint256)',
  'function delayBlocks() view returns (uint64)',
  'function isApprovedCodehash(bytes32) view returns (bool)',
  'function clearanceOf(uint256) view returns (bytes32)',
  'function oracleJudged(uint256) view returns (bool)',
  'function proposalDigest(uint256 id) view returns (bytes32)',
  'function getProposal(uint256 id) view returns ((uint8 kind, uint8 status, address proposer, address target, uint256 value, bytes32 codehash, bytes32 dataHash, uint64 proposedBlock, uint64 readyBlock, uint256 vetoCount))',
])

export const RECEIVER_ABI = parseAbi([
  'event Verdict(uint256 indexed proposalId, uint8 indexed action, bytes32 ruleHash, bytes32 evidenceHash, bytes32 workflowId)',
  'function verdictDigest(uint8 action, uint256 proposalId, bytes32 proposalDigest, bytes32 ruleHash, bytes32 evidenceHash, uint64 validUntilBlock) view returns (bytes32)',
])

export const TOKEN_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
])

/** Multicall3 (same address on Ethereum mainnet, Sepolia and most EVM chains). */
export const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** AirlockAdmin.Status */
export const STATUS = { None: 0, Pending: 1, Vetoed: 2, Executed: 3 } as const
/** AirlockAdmin.Kind */
export const KIND = { Upgrade: 0, SetGuardian: 1, SetDelay: 2, SetPausedImpl: 3 } as const
/** AirlockReceiver report actions */
export const ACTION = { Veto: 0, Clear: 1 } as const

/** dataHash of a proposal without init data: keccak256(""). */
export const EMPTY_DATA_HASH = keccak256('0x')
export const ZERO_HASH = `0x${'00'.repeat(32)}` as const
