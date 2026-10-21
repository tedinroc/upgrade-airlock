// Playback of a proposal that already finished, on a virtual block clock: offline mode plays the recorded run in a
// loop; live mode plays recent proposals when the viewer presses P, and Space replays the selected one. Only data
// already read is used (proposal block, readyBlock, each verdict's block and tx, ReasonAttached, Cleared, Executed).
// The clock holds on the proposal, the verdict and the execution for a moment (dwellMs), so the screen can animate
// them; the blocks in between (the cooldown) run at msPerBlock.
// Pure logic: no DOM, no timers, no store; the caller passes the time in (tests drive it directly).
import { GUARDS, type GuardId } from './runtime'
import type { GuardAction, Proposal } from './store'

export type StepKind = 'proposed' | 'veto' | 'reason' | 'clear' | 'ready' | 'executed'
export interface TLStep {
  block: number
  kind: StepKind
  guard?: GuardId
}
/** ejected: a guardian vetoed it; cleared: a clearance landed (executed or not) */
export type ReplayType = 'ejected' | 'cleared'
export interface Timeline {
  id: string
  type: ReplayType
  /** virtual clock start: proposeBlock - LEAD_BLOCKS */
  start: number
  /** virtual clock end: the last step + TAIL_BLOCKS (at least readyBlock + TAIL_BLOCKS) */
  end: number
  proposeBlock: number
  readyBlock: number
  steps: TLStep[]
}

export const LEAD_BLOCKS = 2
export const TAIL_BLOCKS = 3
/** An ejected proposal is final at its veto: the playback ends this many blocks later, without the rest of the cooldown */
export const EJECT_TAIL_BLOCKS = 5
/** Events up to this many blocks after readyBlock stretch the timeline; later ones are pinned to its end (their text
 *  keeps the real block number) */
const LATE_WINDOW = 40
const ORDER: Record<StepKind, number> = { proposed: 0, veto: 1, reason: 2, clear: 3, ready: 4, executed: 5 }

const vetoBlock = (a: GuardAction | undefined): number | null => (a?.verdict === 'veto' && typeof a.block === 'number' && a.block > 0 ? a.block : null)

export function replayType(p: Proposal): ReplayType | null {
  if (!p.proposeBlock || !p.readyBlock || p.readyBlock < p.proposeBlock) return null
  if (GUARDS.some((g) => vetoBlock(p.guards[g]) !== null)) return 'ejected'
  if (p.clearance?.block) return 'cleared'
  return null
}

export function buildTimeline(p: Proposal): Timeline | null {
  const type = replayType(p)
  if (!type) return null
  const pb = p.proposeBlock!
  const rb = p.readyBlock!
  const raw: TLStep[] = [{ block: pb, kind: 'proposed' }]
  for (const g of GUARDS) {
    const b = vetoBlock(p.guards[g])
    if (b !== null) raw.push({ block: b, kind: 'veto', guard: g })
  }
  if (p.reason) raw.push({ block: p.reason.block, kind: 'reason' })
  // a vetoed proposal can not be cleared afterwards; a clearance before the veto is still shown
  if (p.clearance?.block) raw.push({ block: p.clearance.block, kind: 'clear' })
  if (type === 'cleared') raw.push({ block: rb, kind: 'ready' })
  if (type === 'cleared' && p.execute) raw.push({ block: p.execute.block, kind: 'executed' })
  const inWindow = raw.filter((s) => s.block <= rb + LATE_WINDOW).map((s) => s.block)
  const end = type === 'ejected' ? Math.min(rb + TAIL_BLOCKS, Math.max(...inWindow) + EJECT_TAIL_BLOCKS) : Math.max(rb, ...inWindow) + TAIL_BLOCKS
  const steps = raw.map((s) => ({ ...s, block: Math.min(end, Math.max(pb, s.block)) }))
  steps.sort((a, b) => a.block - b.block || ORDER[a.kind] - ORDER[b.kind] || String(a.guard).localeCompare(String(b.guard)))
  return { id: p.id, type, start: pb - LEAD_BLOCKS, end, proposeBlock: pb, readyBlock: rb, steps }
}

/** Proposals that can be played, oldest first */
export function playable(proposals: Iterable<Proposal>): Proposal[] {
  return [...proposals].filter((p) => replayType(p) !== null).sort((a, b) => Number(a.id) - Number(b.id))
}

/** What the proposal looked like at virtual block v (only steps already reached) */
export function snapshotAt(src: Proposal, tl: Timeline, v: number): Proposal {
  const reached = (kind: StepKind, g?: GuardId) => tl.steps.some((st) => st.kind === kind && (g === undefined || st.guard === g) && st.block <= v)
  const proposed = v >= tl.proposeBlock
  const guards = {} as Record<GuardId, GuardAction>
  let vetoes = 0
  for (const g of GUARDS) {
    const a = src.guards[g]
    if (vetoBlock(a) !== null && reached('veto', g)) {
      guards[g] = { ...a }
      vetoes++
    } else if (g === 'cre' && a?.verdict === 'pass' && reached('clear')) guards[g] = { ...a }
    else guards[g] = {}
  }
  const cleared = reached('clear') && !!src.clearance
  const executed = tl.type === 'cleared' && reached('executed')
  const status = !proposed ? null : vetoes > 0 ? 2 : executed ? 3 : 1
  return {
    ...src,
    proposeTx: proposed ? src.proposeTx : undefined,
    guards,
    clearance: cleared ? src.clearance : undefined,
    reason: reached('reason') ? src.reason : undefined,
    execute: executed ? src.execute : undefined,
    chain:
      status === null
        ? undefined
        : { status, vetoCount: vetoes, proposer: src.chain?.proposer ?? '', clearanceOf: cleared ? (src.clearance?.evidenceHash ?? null) : null },
  }
}

export interface ReplayFrame {
  tl: Timeline
  /** virtual block number (not the chain head) */
  vblock: number
  p: Proposal
  /** the clock is frozen (P while a playback runs) */
  paused: boolean
  /** played to the end; holding the final state */
  hold: boolean
}

export interface ReplayCtx {
  proposals: Iterable<Proposal>
  get(id: string): Proposal | undefined
  reduced: boolean
  /** live mode: a live proposal is in its cooldown, so nothing is replayed (live always wins) */
  liveBusy: boolean
}

export interface ReplayOptions {
  msPerBlock: number
  /** hold the clock on these steps (ms); omitted = no hold */
  dwellMs?: { proposed?: number; verdict?: number; executed?: number }
  /** wait this long after page load before the first playback */
  firstDelayMs: number
  /** wait this long after a live event (or a manual pick) before playing again */
  idleMs: number
  gapMs: number
  reducedHoldMs: number
}

interface Seg {
  tl: Timeline
  t0: number
  reduced: boolean
  logged: number
  /** block -> hold (ms) when the clock reaches it */
  dwell: Map<number, number>
  /** Space: one proposal on demand; it plays even while the loop is paused, and the loop does not follow it */
  once?: boolean
}

/** Playback controller: tick(now) advances; onLive(now) interrupts; toggle(now) pauses and resumes (P key) */
export class AutoReplay {
  paused = false
  private seg: Seg | null = null
  private frozen: number | null = null
  private lastLive = 0
  private lastId: string | null = null
  private force = false

  private readonly loadTs: number
  private readonly opt: ReplayOptions
  private readonly onStep: (tl: Timeline, step: TLStep, src: Proposal) => void

  constructor(loadTs: number, opt: ReplayOptions, onStep: (tl: Timeline, step: TLStep, src: Proposal) => void = () => {}) {
    this.loadTs = loadTs
    this.opt = opt
    this.onStep = onStep
  }

  get active(): boolean {
    return this.seg !== null
  }

  /** A live event: stop playing now; the idle time counts from here */
  onLive(now: number) {
    this.lastLive = now
    this.seg = null
    this.frozen = null
    this.force = false
  }

  /** The viewer picked a proposal: same as a live event, and the next playback starts after that proposal */
  stop(now: number, pickedId?: string) {
    this.onLive(now)
    if (pickedId) this.lastId = pickedId
  }

  private idleEnough(now: number): boolean {
    return this.lastLive ? now - this.lastLive >= this.opt.idleMs : now - this.loadTs >= this.opt.firstDelayMs
  }

  /** The next playback starts with this proposal (offline ?p=) */
  startAt(id: string) {
    this.lastId = String(Number(id) - 1)
  }

  /** Space: play this proposal now, whether or not the loop is paused; a live event still interrupts it */
  playOne(now: number, p: Proposal, reduced: boolean): boolean {
    const tl = buildTimeline(p)
    if (!tl) return false
    this.seg = this.newSeg(tl, now, reduced)
    this.seg.once = true
    this.frozen = null
    this.force = false
    return true
  }

  private newSeg(tl: Timeline, now: number, reduced: boolean): Seg {
    const d = this.opt.dwellMs ?? {}
    const dwell = new Map<number, number>()
    const add = (b: number, ms: number | undefined) => {
      if (ms && ms > 0) dwell.set(b, (dwell.get(b) ?? 0) + ms)
    }
    add(tl.proposeBlock, d.proposed)
    const verdict = tl.steps.find((s) => s.kind === 'veto' || s.kind === 'clear')
    if (verdict) add(verdict.block, d.verdict)
    const exec = tl.steps.find((s) => s.kind === 'executed')
    if (exec) add(exec.block, d.executed)
    return { tl, t0: now, reduced, logged: 0, dwell }
  }

  /** Pause: freeze the virtual block and do not start on its own; resume: continue, or start right away */
  toggle(now: number) {
    if (!this.paused) {
      this.paused = true
      if (this.seg) this.frozen = now - this.seg.t0
      return
    }
    this.paused = false
    if (this.seg && this.frozen !== null) this.seg.t0 = now - this.frozen
    else this.force = true
    this.frozen = null
  }

  private vblockAt(now: number): number {
    const s = this.seg!
    if (s.reduced) return s.tl.end
    let t = this.frozen ?? now - s.t0
    // each block: first its hold (if any), then msPerBlock to the next one
    for (let b = s.tl.start; b < s.tl.end; b++) {
      t -= s.dwell.get(b) ?? 0
      if (t < 0) return b
      t -= this.opt.msPerBlock
      if (t < 0) return b
    }
    return s.tl.end
  }

  private segDurationMs(s: Seg): number {
    if (s.reduced) return this.opt.reducedHoldMs
    let hold = 0
    for (const [b, ms] of s.dwell) if (b < s.tl.end) hold += ms
    return (s.tl.end - s.tl.start) * this.opt.msPerBlock + hold + this.opt.gapMs
  }

  private startNext(now: number, ctx: ReplayCtx): boolean {
    const list = playable(ctx.proposals)
    if (!list.length) return false
    const i = this.lastId === null ? -1 : list.findIndex((p) => Number(p.id) > Number(this.lastId))
    const pick = i >= 0 ? list[i] : list[0]
    const tl = buildTimeline(pick)
    if (!tl) return false
    this.lastId = pick.id
    this.seg = this.newSeg(tl, now, ctx.reduced)
    this.frozen = null
    this.force = false
    return true
  }

  /** Advance the clock; returns whether the page must redraw */
  tick(now: number, ctx: ReplayCtx): boolean {
    const once = !!this.seg?.once
    if (ctx.liveBusy && !once) {
      if (!this.seg) return false
      this.seg = null
      this.frozen = null
      return true
    }
    if (this.paused && !once) return false
    let changed = false
    if (this.seg && this.frozen === null && now - this.seg.t0 >= this.segDurationMs(this.seg)) {
      // after a Space replay the loop waits its idle time again before it carries on
      if (this.seg.once) this.lastLive = now
      this.seg = null
      changed = true
    }
    if (!this.seg) {
      if (this.paused) return changed
      if (!this.force && !this.idleEnough(now)) return changed
      if (!this.startNext(now, ctx)) return changed
      changed = true
    }
    const s = this.seg!
    const v = this.vblockAt(now)
    const src = ctx.get(s.tl.id)
    while (s.logged < s.tl.steps.length && s.tl.steps[s.logged].block <= v) {
      if (src) this.onStep(s.tl, s.tl.steps[s.logged], src)
      s.logged++
      changed = true
    }
    return changed
  }

  /** What the page shows while playing; null when not playing */
  frame(now: number, get: (id: string) => Proposal | undefined): ReplayFrame | null {
    if (!this.seg) return null
    const src = get(this.seg.tl.id)
    if (!src) return null
    const vblock = this.vblockAt(now)
    return { tl: this.seg.tl, vblock, p: snapshotAt(src, this.seg.tl, vblock), paused: this.frozen !== null, hold: vblock >= this.seg.tl.end }
  }
}
