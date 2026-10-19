// Deployment addresses the page reads.
//  - live (?mode=airlock): src/chain-data-sepolia.json, written by scripts/sync-sepolia-data.mjs from the
//    DeployEth.s.sol output (default deployments/sepolia.json). Until a deployment exists it is a placeholder
//    (pending: true) and the page says the contracts are not deployed yet.
//  - offline (?mode=offline): the deployment block inside src/recorded-run.json (scripts/record-run.mjs).
import SEPOLIA_DATA from './chain-data-sepolia.json'
import RECORDED from './recorded-run.json'
import { OFFLINE } from './runtime'
import type { ImplName } from './types'

export interface ChainData {
  pending: boolean
  chainId: number
  startBlock: number
  delayBlocks: number
  airlockAdmin: string
  proxy: string
  /** AirlockReceiver: guardians[0] and the clearance oracle (Chainlink CRE reports land here) */
  receiver: string
  /** Human emergency guardian: guardians[1] */
  emergencyGuardian: string
  /** Manual clearance and codehash registry (not a guardian) */
  approver: string
  owner: string
  attester: string
  forwarder: string
  impls: Partial<Record<ImplName, string>>
}

/** A JSON-RPC log as returned by eth_getLogs / eth_subscribe */
export interface RawLog {
  address: string
  topics: `0x${string}`[]
  data: `0x${string}`
  blockNumber: `0x${string}`
  transactionHash: `0x${string}`
  logIndex: `0x${string}`
  removed?: boolean
}

/** The recorded run that offline mode plays back */
export interface RecordedRun {
  v: number
  /** sepolia: recorded from Ethereum Sepolia; sepolia-fork: recorded from a local anvil fork of Sepolia; none: placeholder */
  source: 'sepolia' | 'sepolia-fork' | 'none'
  /** Recording date (YYYY-MM-DD) */
  recordedOn: string
  /** Last block of the recording */
  head: number
  deployment: ChainData
  logs: RawLog[]
  /** block number -> block timestamp (s) */
  blocks: Record<string, number>
  /** tx hash -> receipt numbers */
  receipts: Record<string, { status: string; gasUsed: string; effectiveGasPrice: string; blockNumber: number }>
  /** id -> getProposal + clearanceOf at the end of the recording */
  proposals: Record<
    string,
    { kind: number; status: number; proposer: string; target: string; codehash: string; proposedBlock: number; readyBlock: number; vetoCount: number; clearanceOf: string }
  >
}

export const RECORDING = RECORDED as unknown as RecordedRun
export const DATA: ChainData = (OFFLINE ? RECORDING.deployment : SEPOLIA_DATA) as ChainData

/** The live deployment file is still a placeholder (or offline mode has no recording yet) */
export const PENDING = DATA.pending === true || (OFFLINE && RECORDING.source === 'none')
