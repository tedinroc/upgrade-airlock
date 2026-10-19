// The airlock picture of one proposal:
//   outer door = Proposed (the upgrade enters the chamber)
//   chamber    = the cooldown (readyBlock - proposeBlock blocks, shown in seconds at 12 s/block)
//   inner door = stays locked until the Chainlink CRE clearance lands AND the cooldown is over; then Executed
//   ejected    = Vetoed (by the CRE through AirlockReceiver, or by the human emergency guardian); a veto beats a clearance
// airlockView() is pure (no DOM, no store; the time is passed in), so the tests call it directly.
import { CONFIG } from './config'
import { onLangChange, t } from './i18n'
import { GUARDS, type GuardId } from './runtime'
import type { Clearance, Proposal } from './store'

/** idle: no proposal; chamber: cooling, not cleared; cleared: cooling, clearance landed; waiting: cooldown over but no
 *  clearance (execute reverts NotCleared); ready: cooldown over and cleared (executable); executed; ejected */
export type AirlockPhase = 'idle' | 'chamber' | 'cleared' | 'waiting' | 'ready' | 'executed' | 'ejected'

interface Timing {
  block: number
  tx: string | undefined
  /** proposal block -> this block */
  afterBlocks: number
  /** seconds after the proposal: block timestamps when known, otherwise blocks x blockSec */
  afterSec: number
  secFromTs: boolean
}

export interface AirlockVeto extends Timing {
  by: GuardId
  rule: string | null
  ruleHash: string | null
  evidenceHash: string | undefined
  workflowId: string | undefined
  /** veto block -> readyBlock (how far the attacker still was from the inner door) */
  toInner: number
}

export interface AirlockClear extends Timing {
  by: Clearance['by']
  clearer: string
  evidenceHash: string
  workflowId: string | undefined
  /** clearance block -> readyBlock; negative when the clearance landed after the cooldown ended */
  beforeReady: number
}

export interface AirlockView {
  phase: AirlockPhase
  /** cooldown length in blocks */
  total: number
  /** blocks left to readyBlock, 0..total */
  left: number
  leftSec: number
  /** blocks past readyBlock (waiting / ready) */
  over: number
  /** cooldown progress 0-100 (stops at the veto block when ejected) */
  pct: number
  /** first veto that landed; null when the chain says Vetoed but the veto log was out of reach */
  veto: AirlockVeto | null
  /** the clearance (first Cleared, or clearanceOf when the log was out of reach: then no block/tx) */
  clear: AirlockClear | null
  /** clearanceOf / Cleared says cleared even if no log was read */
  cleared: boolean
}

function timing(block: number, tx: string | undefined, pb: number, ts: (n: number) => number | undefined, blockSec: number): Timing {
  const t0 = ts(pb)
  const t1 = ts(block)
  const secFromTs = t0 !== undefined && t1 !== undefined && t1 >= t0
  return { block, tx, afterBlocks: block - pb, afterSec: secFromTs ? t1! - t0! : (block - pb) * blockSec, secFromTs }
}

/** First veto (lowest block; on the same block the CRE card first, as guardians are [CRE, human]) */
function firstVeto(p: Proposal): { by: GuardId; block: number } | null {
  let best: { by: GuardId; block: number } | null = null
  for (const g of GUARDS) {
    const a = p.guards[g]
    if (a?.verdict === 'veto' && typeof a.block === 'number' && a.block > 0 && (!best || a.block < best.block)) best = { by: g, block: a.block }
  }
  return best
}

/**
 * @param cur  current block (the virtual block during playback)
 * @param ts   block number -> block timestamp (s), or undefined
 */
export function airlockView(
  p: Proposal | null,
  cur: number,
  ts: (n: number) => number | undefined = () => undefined,
  blockSec: number = CONFIG.blockSec,
): AirlockView {
  if (!p || !p.proposeBlock || !p.readyBlock) {
    const total = p?.readyBlock && p.proposeBlock ? p.readyBlock - p.proposeBlock : 0
    return { phase: 'idle', total, left: total, leftSec: total * blockSec, over: 0, pct: 0, veto: null, clear: null, cleared: false }
  }
  const pb = p.proposeBlock
  const rb = p.readyBlock
  const total = Math.max(1, rb - pb)
  // playback lead-in: the virtual clock starts a couple of blocks before the proposal
  if (cur < pb) return { phase: 'idle', total, left: total, leftSec: total * blockSec, over: 0, pct: 0, veto: null, clear: null, cleared: false }
  const left = Math.min(total, Math.max(0, rb - cur))
  const over = Math.max(0, cur - rb)

  let veto: AirlockVeto | null = null
  const fv = firstVeto(p)
  if (fv) {
    const a = p.guards[fv.by]
    veto = {
      ...timing(fv.block, a.tx, pb, ts, blockSec),
      by: fv.by,
      rule: a.rule ?? null,
      ruleHash: a.ruleHash ?? null,
      evidenceHash: fv.by === 'cre' ? a.evidenceHash : undefined,
      workflowId: fv.by === 'cre' ? a.workflowId : undefined,
      toInner: Math.max(0, rb - fv.block),
    }
  }

  let clear: AirlockClear | null = null
  const c = p.clearance
  if (c?.block) {
    clear = {
      ...timing(c.block, c.tx, pb, ts, blockSec),
      by: c.by,
      clearer: c.clearer,
      // AirlockAdmin keeps the first hash: clearanceOf wins over a log
      evidenceHash: p.chain?.clearanceOf ?? c.evidenceHash,
      workflowId: c.by === 'cre' ? p.guards.cre.workflowId : undefined,
      beforeReady: rb - c.block,
    }
  }
  const cleared = !!clear || !!p.chain?.clearanceOf

  const vetoed = !!veto || p.chain?.status === 2
  const executed = !vetoed && (p.chain?.status === 3 || !!p.execute)
  const phase: AirlockPhase = vetoed
    ? 'ejected'
    : executed
      ? 'executed'
      : cur >= rb
        ? cleared
          ? 'ready'
          : 'waiting'
        : cleared
          ? 'cleared'
          : 'chamber'
  const doneBlocks = veto ? Math.min(total, veto.afterBlocks) : phase === 'executed' || phase === 'ready' || phase === 'waiting' ? total : total - left
  return { phase, total, left, leftSec: left * blockSec, over, pct: Math.min(100, Math.round((doneBlocks / total) * 100)), veto, clear, cleared }
}

/** Seconds -> "24 s", "4 min 36 s" (current language) */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return t('d.sec', { s })
  if (s % 60 === 0) return t('d.minOnly', { m: s / 60 })
  return t('d.min', { m: Math.floor(s / 60), s: s % 60 })
}

/** Tab title follows the language */
export function startTitle() {
  const title = () => {
    try {
      document.title = t('doc.title')
    } catch {
      /* Node tests */
    }
  }
  title()
  onLangChange(title)
}
