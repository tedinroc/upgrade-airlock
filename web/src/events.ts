// One log from AirlockAdmin or AirlockReceiver -> proposal state + one event-stream line.
// Shared by the live reader (chainwatch.ts) and offline playback (offline.ts); network work is done through hooks.
import { decodeEventLog, type Hex } from 'viem'
import { ACTION_CLEAR, ACTION_VETO, ADMIN_ABI, RECEIVER_ABI } from './abi'
import { DATA, type RawLog } from './chaindata'
import { msg, type Msg } from './i18n'
import type { GuardId } from './runtime'
import { short, store, type Clearance, type Proposal } from './store'
import { IMPL_KEYS, RULE_BY_HASH, type CardId } from './types'

export interface LogHooks {
  /** read this transaction's receipt (gas cost) */
  wantReceipt(tx: string): void
  /** read this block's timestamp */
  wantBlockTs(n: number): void
  /** the proposal changed on chain: read getProposal + clearanceOf again */
  refresh(id: string): void
  /** a live (not historical) event arrived */
  onLive(ts: number): void
}

/** block number -> block timestamp (s); filled by the live reader or from the recording */
export const blockTs = new Map<number, number>()

const lc = (a: unknown) => String(a ?? '').toLowerCase()
const RX = lc(DATA.receiver)
const ADMIN = lc(DATA.airlockAdmin)

/** guardian address -> guard card */
export function guardOf(guardian: string): GuardId | null {
  const g = lc(guardian)
  if (g === RX) return 'cre'
  if (g === lc(DATA.emergencyGuardian)) return 'breakglass'
  return null
}

/** clearer address -> who cleared */
export function clearerOf(addr: string): Clearance['by'] {
  const a = lc(addr)
  return a === RX ? 'cre' : a === lc(DATA.approver) ? 'approver' : 'other'
}

/** Stream name of a guard or clearer */
export function whoMsg(by: string, addr = ''): Msg {
  if (by === 'cre') return msg('who.cre')
  if (by === 'breakglass') return msg('who.human')
  if (by === 'approver') return msg('who.approver')
  return msg('who.unknown', { a: short(addr, 4) })
}

const ruleName = (ruleHash: string) => RULE_BY_HASH.get(lc(ruleHash)) ?? null

function recognise(p: Proposal) {
  const name = store.implNames.get(lc(p.target))
  if (name && name !== 'v1' && name !== 'paused') p.card = name as CardId
}

const seen = new Set<string>()
/** Forget everything (offline playback restarts from a clean store) */
export function resetSeen() {
  seen.clear()
}

/** Apply one log. Returns the proposal id it touched, or null when the log was ignored. */
export function handleLog(l: RawLog, live: boolean, hooks: LogHooks, ts = Date.now()): string | null {
  const addr = lc(l?.address)
  const fromRx = addr === RX
  if (!l?.topics?.length || (addr !== ADMIN && !fromRx)) return null
  const key = `${lc(l.transactionHash)}|${lc(l.logIndex)}`
  if (l.removed) {
    if (seen.delete(key)) {
      const id = l.topics[1] ? String(BigInt(l.topics[1])) : ''
      const p = id ? store.proposals.get(id) : undefined
      if (p) {
        p.dropped = true
        hooks.refresh(id)
      }
      store.logT('chain', 'removed', msg('ev.removed', { tx: short(l.transactionHash) }), 'warn', ts)
      store.emit()
    }
    return null
  }
  if (seen.has(key)) return null
  let ev: { eventName: string; args: Record<string, unknown> }
  try {
    ev = decodeEventLog({ abi: fromRx ? RECEIVER_ABI : ADMIN_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as never
  } catch {
    return null
  }
  seen.add(key)
  if (live) hooks.onLive(ts)
  const block = parseInt(l.blockNumber, 16)
  const tx = l.transactionHash
  const id = String(ev.args.proposalId ?? ev.args.id)
  const p = store.ensure(id)
  const after = p.proposeBlock ? msg('ev.after', { n: block - p.proposeBlock }) : ''
  hooks.wantBlockTs(block)

  switch (ev.eventName) {
    case 'Proposed': {
      p.kind = String(ev.args.kind)
      p.target = String(ev.args.target)
      p.codehash = String(ev.args.codehash)
      p.proposeBlock = block
      p.readyBlock = Number(ev.args.readyBlock)
      p.proposeTx = tx
      p.dropped = false
      recognise(p)
      if (live) {
        manualPick = false
        store.activeId = id
      }
      store.logT('chain', 'Proposed', msg('ev.proposed', { id, b: block, rb: p.readyBlock, tx: short(tx) }), 'info', ts)
      break
    }
    case 'Vetoed': {
      const guardian = String(ev.args.guardian)
      const g = guardOf(guardian)
      const rule = ruleName(String(ev.args.ruleHash))
      if (g) {
        const a = p.guards[g]
        a.verdict = 'veto'
        a.rule = rule ?? a.rule ?? null
        a.ruleHash = String(ev.args.ruleHash)
        a.tx = tx
        a.block = block
        hooks.wantReceipt(tx)
      }
      const who = whoMsg(g ?? 'other', guardian)
      store.logT('chain', 'Vetoed', msg('ev.vetoed', { id, who, b: block, after, rule: rule ?? short(String(ev.args.ruleHash), 4), n: String(ev.args.vetoCount) }), 'bad', ts)
      break
    }
    case 'Cleared': {
      const clearer = String(ev.args.clearer)
      const by = clearerOf(clearer)
      const order = block * 1e6 + parseInt(l.logIndex, 16)
      // AirlockAdmin keeps the first evidence hash; a later Cleared only repeats the call
      if (!p.clearance || (p.clearance.order ?? Infinity) > order) {
        p.clearance = { evidenceHash: String(ev.args.evidenceHash), clearer, by, tx, block, order }
        if (by === 'cre') {
          const a = p.guards.cre
          a.verdict = 'pass'
          a.tx = tx
          a.block = block
          a.evidenceHash = a.evidenceHash ?? String(ev.args.evidenceHash)
        }
        hooks.wantReceipt(tx)
      }
      store.logT('chain', 'Cleared', msg('ev.cleared', { id, who: whoMsg(by, clearer), b: block, after, h: short(String(ev.args.evidenceHash)) }), 'good', ts)
      break
    }
    case 'Executed':
      p.execute = { tx, block }
      hooks.wantReceipt(tx)
      store.logT('chain', 'Executed', msg('ev.executed', { id, b: block, tx: short(tx) }), 'good', ts)
      break
    case 'ReasonAttached': {
      p.reason = { tx, hash: String(ev.args.reportHash), block }
      if (guardOf(String(ev.args.guardian)) === 'cre') p.guards.cre.evidenceHash = String(ev.args.reportHash)
      store.logT('chain', 'ReasonAttached', msg('ev.reason', { id, h: short(String(ev.args.reportHash)) }), 'info', ts)
      break
    }
    case 'Verdict': {
      const action = Number(ev.args.action)
      const a = p.guards.cre
      a.evidenceHash = String(ev.args.evidenceHash)
      a.workflowId = String(ev.args.workflowId)
      const rule = ruleName(String(ev.args.ruleHash))
      if (action === ACTION_VETO) {
        a.verdict = 'veto'
        a.rule = rule ?? a.rule ?? null
        a.ruleHash = String(ev.args.ruleHash)
      } else if (action === ACTION_CLEAR && a.verdict !== 'veto') a.verdict = 'pass'
      a.tx = a.tx ?? tx
      a.block = a.block ?? block
      const what = action === ACTION_CLEAR ? msg('ev.vClear') : msg('ev.vVeto', { rule: rule ?? short(String(ev.args.ruleHash), 4) })
      store.logT('chain', 'Verdict', msg('ev.verdict', { id, what, h: short(a.evidenceHash), w: short(a.workflowId, 4) }), action === ACTION_CLEAR ? 'good' : 'bad', ts)
      break
    }
  }
  pickActive()
  store.emit()
  hooks.refresh(id)
  return id
}

/** The viewer picked a proposal: stay on it until a new proposal arrives */
let manualPick = false
export function setManualPick(on: boolean) {
  manualPick = on
}

/** Follow the newest proposal unless the viewer picked one */
export function pickActive() {
  let best: Proposal | null = null
  for (const p of store.proposals.values()) if (!best || Number(p.id) > Number(best.id)) best = p
  if (best && store.activeId !== best.id && !manualPick) store.activeId = best.id
}

/** Implementation addresses of the deployment -> demo names (EvilMint, DemoBTC v2, ...) */
export function loadImplNames() {
  for (const k of IMPL_KEYS) {
    const a = DATA.impls[k]
    if (a) store.implNames.set(a.toLowerCase(), k)
  }
}
