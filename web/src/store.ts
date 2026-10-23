// Front-end state: proposals keyed by id, built from AirlockAdmin and AirlockReceiver logs (live or recorded).
import { CONFIG } from './config'
import { tIn, type Msg } from './i18n'
import { GUARDS, type GuardId } from './runtime'
import type { CardId, ImplName } from './types'

/** Receipt numbers of a verdict transaction (veto or clearance), read with eth_getTransactionReceipt */
export interface TxCost {
  status?: 'success' | 'reverted'
  gasUsed?: string
  effectiveGasPrice?: string
}

/** What one guard did on one proposal */
export interface GuardAction {
  /** veto: Vetoed by this guardian; pass: the CRE cleared it (only the CRE card can pass) */
  verdict?: 'pass' | 'veto'
  rule?: string | null
  ruleHash?: string | null
  tx?: string
  block?: number
  /** CRE only: keccak256 of the canonical evidence JSON (Verdict / Cleared / ReasonAttached) */
  evidenceHash?: string
  /** CRE only: workflowId from the report metadata (Verdict) */
  workflowId?: string
  /** Order (block * 1e6 + logIndex) of the Vetoed log whose block and tx are kept: the first one. A mined veto report
   *  can be re-sent by anyone while it is valid, and AirlockAdmin emits Vetoed again; that replay never replaces it */
  vetoOrder?: number
  /** Order of the Verdict log whose workflowId and evidence hash are kept (the first one, for the same reason) */
  verdictOrder?: number
}

/** The first accepted clearance (AirlockAdmin keeps the first evidence hash) */
export interface Clearance {
  evidenceHash: string
  clearer: string
  /** cre: the AirlockReceiver (a Chainlink CRE report); approver: cleared by hand; other: any other caller */
  by: 'cre' | 'approver' | 'other'
  tx?: string
  block?: number
  /** Order of the Cleared log (block * 1e6 + logIndex): an earlier log replaces a later one */
  order?: number
}

export interface Proposal {
  id: string
  kind: string
  target: string
  /** Proposed.value: the enabled flag of a guardian change (1 add, 0 remove), the new delay of a cooldown change */
  value?: string
  codehash: string
  proposeBlock: number | null
  readyBlock: number | null
  proposeTx?: string
  card?: CardId
  guards: Record<GuardId, GuardAction>
  clearance?: Clearance
  execute?: { tx: string; block: number }
  /** ReasonAttached: the evidence hash written next to a veto (the first one; order = block * 1e6 + logIndex) */
  reason?: { tx: string; hash: string; block: number; order?: number }
  /** getProposal + clearanceOf as read from the chain (status 0 None, 1 Pending, 2 Vetoed, 3 Executed) */
  chain?: { status: number; vetoCount: number; proposer: string; clearanceOf: string | null }
  /** The proposal's log disappeared in a reorg */
  dropped?: boolean
}

export interface StreamLine {
  ts: number
  source: string
  type: string
  /** zh-CN text (tests and logs) */
  text: string
  /** Template key + params: re-rendered in the current language */
  msg: Msg
  level: 'info' | 'good' | 'bad' | 'warn'
  /** Written by the playback of a recorded proposal */
  replay?: boolean
}

/** Deployment addresses in use (live: src/chain-data-sepolia.json; offline: the recorded run) */
export interface DeployInfo {
  airlockAdmin: string
  proxy: string
  delayBlocks: number
  chainId: number
}

/** Sourcify lookup: yes = exact/partial match; no = known but unverified; err = network failure (no claim made) */
export type VerifyState = 'pending' | 'yes' | 'no' | 'err'

export function newProposal(id: string): Proposal {
  const guards = {} as Record<GuardId, GuardAction>
  for (const g of GUARDS) guards[g] = {}
  return { id, kind: '0', target: '', codehash: '', proposeBlock: null, readyBlock: null, guards }
}

export class Store {
  proposals = new Map<string, Proposal>()
  activeId: string | null = null
  stream: StreamLine[] = []
  /** implementation address (lowercase) -> demo name */
  implNames = new Map<string, ImplName>()
  deploy: DeployInfo | null = null
  verified = new Map<string, VerifyState>()
  /** tx hash (lowercase) -> receipt numbers of verdict and execute transactions */
  receipts = new Map<string, TxCost>()
  /** Auto-follow (F): a live proposal takes over the screen as it arrives */
  follow = true
  /** The last proposal that arrived live (not from history): the screen plays its arrival */
  arrival: { id: string; at: number } | null = null
  private listeners = new Set<() => void>()

  onChange(fn: () => void) {
    this.listeners.add(fn)
  }
  emit() {
    for (const fn of this.listeners) fn()
  }

  get active(): Proposal | null {
    return this.activeId ? (this.proposals.get(this.activeId) ?? null) : null
  }

  ensure(id: string): Proposal {
    let p = this.proposals.get(id)
    if (!p) {
      p = newProposal(id)
      this.proposals.set(id, p)
    }
    return p
  }

  /** Newest first, at most CONFIG.recentProposals */
  recentIds(): string[] {
    return [...this.proposals.keys()].sort((a, b) => Number(b) - Number(a)).slice(0, CONFIG.recentProposals)
  }

  /** Highest proposal id, or null */
  newestId(): string | null {
    return this.recentIds()[0] ?? null
  }

  /** One line in the event stream: stores the template (re-rendered on a language switch) and the zh-CN text */
  logT(source: string, type: string, m: Msg, level: StreamLine['level'] = 'info', ts = Date.now(), replay = false) {
    this.stream.push({ ts, source, type, text: tIn('zh-CN', m.k, m.p), msg: m, level, ...(replay ? { replay } : {}) })
    if (this.stream.length > 80) this.stream.shift()
  }
}

export function short(h: unknown, n = 6): string {
  const s = typeof h === 'string' ? h : ''
  if (!s) return '—'
  if (s.length <= 2 + n * 2) return s
  return `${s.slice(0, 2 + n)}…${s.slice(-4)}`
}

export const store = new Store()
