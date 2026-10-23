// The attack picker: "pick an attack and watch Chainlink CRE stop it". Seven cards, one per demo action of
// scripts/sepolia/propose.sh. A card plays, from its arrival at the outer door, the replay of the newest REAL proposal
// of that kind already judged on Ethereum Sepolia (the v2 card prefers one that was executed). A proposal of that kind
// still in its cooldown is live: the card says so and shows it instead (live always wins over a replay).
//
// First visit: once the proposals are in, the page plays one replay on its own (evil-drain), then invites the viewer
// to pick another card. Never with ?clean=1 (recording), never with ?p=<id>, never offline (the replay loop already
// runs there), never after the viewer picked anything, never while a live proposal is in its cooldown. Until that
// replay starts, the airlock shows a neutral intro (labIntro), so a first visitor never sees the final verdict before
// the replay that leads up to it.
//
// The pure helpers (labIdOf, pickFor, autoplayWanted, stageOf) are what the self-test checks; the rest binds them to
// the store and the page's replay engine.
import { airlockView, type AirlockPhase } from './airlock'
import { blocks } from './chain'
import { DATA } from './chaindata'
import { setManualPick } from './events'
import { historyIn, liveBusy, playbackGate, replay, replayFrame } from './playback'
import { buildTimeline, replayType, type PlayOpts, type ReplayType, type Timeline } from './replay'
import { CLEAN, OFFLINE, PICK } from './runtime'
import { store, type Proposal } from './store'
import type { CardId, ImplName, RuleId } from './types'

export type LabId = 'evil-mint' | 'evil-owner' | 'evil-fee' | 'evil-basefee' | 'evil-drain' | 'remove-receiver' | 'v2'

export interface LabCard {
  id: LabId
  /** the demo implementation an upgrade card proposes (null: the guardian change) */
  impl: CardId | null
  /** the rule the CRE workflow is expected to veto it with (null: the honest upgrade, expected to clear) */
  rule: RuleId | null
  /** the AirlockAdmin call scripts/sepolia/propose.sh makes for it */
  fn: 'proposeUpgrade' | 'proposeSetGuardian'
}

/** Picker order, left to right (keys 1-7). The ids are the operator API's card ids. */
export const LAB_CARDS: readonly LabCard[] = [
  { id: 'evil-mint', impl: 'evilMint', rule: 'R1_TOTAL_SUPPLY', fn: 'proposeUpgrade' },
  { id: 'evil-owner', impl: 'evilOwner', rule: 'R2_OWNER', fn: 'proposeUpgrade' },
  { id: 'evil-fee', impl: 'evilFee', rule: 'R3_TRANSFER_CONSERVATION', fn: 'proposeUpgrade' },
  { id: 'evil-basefee', impl: 'evilBaseFee', rule: 'R9_NEW_OPCODES', fn: 'proposeUpgrade' },
  { id: 'evil-drain', impl: 'evilDrain', rule: 'R3B_THIRD_PARTY_FUNDS', fn: 'proposeUpgrade' },
  { id: 'remove-receiver', impl: null, rule: 'R7_CONFIG_GUARD', fn: 'proposeSetGuardian' },
  { id: 'v2', impl: 'v2', rule: null, fn: 'proposeUpgrade' },
]
export const LAB_IDS: readonly LabId[] = LAB_CARDS.map((c) => c.id)
export const isLabId = (x: unknown): x is LabId => typeof x === 'string' && (LAB_IDS as readonly string[]).includes(x)
export const labCard = (id: LabId): LabCard => LAB_CARDS.find((c) => c.id === id)!

/** The card the first visit plays on its own */
export const AUTOPLAY_CARD: LabId = 'evil-drain'
/** Wait this long after the proposals are in before the first-visit replay starts (the intro stays up meanwhile) */
export const AUTOPLAY_DELAY_MS = 300
/** Give up on the first-visit replay if it could not start within this long (a live proposal kept the screen) */
export const AUTOPLAY_GIVE_UP_MS = 60_000
/** A proposal that arrived live during this visit is labelled live this long after its arrival */
export const LIVE_LABEL_MS = 15 * 60_000

/** Timing of a picker replay: a readable arrival, a visible "judging" stretch before the verdict (the verdict card
 *  walks through the workflow's steps meanwhile), long holds on the verdict and the inner door, and the rest of the
 *  cooldown fast-forwarded after the verdict. The real verdict came 1-3 blocks (12-40 s) after the proposal; the
 *  replay compresses that, and its real block distance stays on screen ("1 block · 12 s after the proposal"). */
export const LAB_PLAY: PlayOpts = {
  msPerBlock: 700,
  fastMsPerBlock: 150,
  // lead: about 2.5 s from the start to the outer door, so a first-time viewer sees the capsule go in
  dwellMs: { lead: 1100, proposed: 1800, judging: 4400, verdict: 4200, executed: 3600 },
  gapMs: 2500,
}

// ---------- pure helpers ----------
/** Which card a proposal is: an upgrade to one of the demo implementations, or the guardian change that removes the
 *  CRE receiver (kind 1, target = AirlockReceiver, value 0). Anything else is not a picker card. */
export function labIdOf(p: Proposal, implNames: ReadonlyMap<string, ImplName>, receiver: string = DATA.receiver): LabId | null {
  const kind = Number(p.kind)
  if (kind === 1) return !!p.target && p.target.toLowerCase() === receiver.toLowerCase() && p.value === '0' ? 'remove-receiver' : null
  if (kind !== 0 || !p.target) return null
  const name = p.card ?? implNames.get(p.target.toLowerCase())
  return LAB_CARDS.find((c) => c.impl !== null && c.impl === name)?.id ?? null
}

const executed = (p: Proposal) => !!p.execute || p.chain?.status === 3

export interface LabPick {
  /** the proposal the card replays: the newest one already judged (v2: the newest executed one, if any) */
  replay: Proposal | null
  /** a newer proposal of this card still in its cooldown without a verdict: it is happening on chain right now */
  live: Proposal | null
}

/**
 * @param head  the chain head (0 when unknown); a proposal without a verdict counts as live only inside its cooldown
 */
export function pickFor(id: LabId, proposals: Iterable<Proposal>, implNames: ReadonlyMap<string, ImplName>, head = 0, receiver?: string): LabPick {
  const mine = [...proposals].filter((p) => !p.dropped && labIdOf(p, implNames, receiver) === id).sort((a, b) => Number(b.id) - Number(a.id))
  const judged = mine.filter((p) => replayType(p) !== null)
  const replay = (id === 'v2' ? judged.find(executed) : undefined) ?? judged[0] ?? null
  const live =
    mine.find(
      (p) =>
        (!replay || Number(p.id) > Number(replay.id)) &&
        replayType(p) === null &&
        p.chain?.status !== 2 &&
        p.chain?.status !== 3 &&
        !!p.readyBlock &&
        (head === 0 || head < p.readyBlock),
    ) ?? null
  return { replay, live }
}

/** The backfill can stop looking for this card: it has a replay (v2: an executed one) */
export function labSatisfied(id: LabId, pick: LabPick): boolean {
  return !!pick.replay && (id !== 'v2' || executed(pick.replay))
}

export interface AutoplayCtx {
  clean: boolean
  pick: string | null
  offline: boolean
  /** the proposals and their logs are in */
  ready: boolean
  /** the viewer already picked a card or a proposal, or pressed a presenter key */
  interacted: boolean
  /** a live proposal is in its cooldown */
  liveBusy: boolean
}
/** The first-visit replay may start now */
export function autoplayWanted(c: AutoplayCtx): boolean {
  return !c.clean && !c.pick && !c.offline && c.ready && !c.interacted && !c.liveBusy
}
/** The first-visit replay can never start any more (it waits out liveBusy and ready, nothing else) */
export function autoplayRuledOut(c: AutoplayCtx): boolean {
  return c.clean || !!c.pick || c.offline || c.interacted
}
/** While the first-visit replay is still to come, the airlock shows a neutral intro instead of the newest proposal's
 *  final state. A live proposal in its cooldown (known once the data is in) is shown at once instead. */
export function introWanted(c: AutoplayCtx): boolean {
  return !autoplayRuledOut(c) && !(c.ready && c.liveBusy)
}

/** The steps of a picker replay, shown on the playing card: the proposal enters, the CRE judges it, then a veto ejects
 *  it, or a clearance unlocks the inner door, the cooldown is fast-forwarded and the upgrade executes */
export type LabStage = 'arrive' | 'judge' | 'veto' | 'clear' | 'fast' | 'exec'
export function stagesFor(type: ReplayType, didExecute: boolean): LabStage[] {
  if (type === 'ejected') return ['arrive', 'judge', 'veto']
  return didExecute ? ['arrive', 'judge', 'clear', 'fast', 'exec'] : ['arrive', 'judge', 'clear', 'fast']
}
export function stageOf(phase: AirlockPhase, vblock: number, tl: Timeline): LabStage {
  switch (phase) {
    case 'idle':
      return 'arrive'
    case 'ejected':
      return 'veto'
    case 'cleared': {
      const c = tl.steps.find((s) => s.kind === 'clear')
      return c && vblock > c.block ? 'fast' : 'clear'
    }
    case 'ready':
      return 'fast'
    case 'executed':
      return 'exec'
    default:
      return 'judge'
  }
}

/** Block timestamp -> "2026-10-20" at the venue (UTC+8), whatever the laptop's time zone */
export function fmtDay(sec: number | undefined | null): string | null {
  if (!sec || !Number.isFinite(sec)) return null
  return new Date((sec + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

// ---------- page state ----------
export const lab = {
  /** stage screens: the bottom row shows the picker or the strip of recent proposals */
  tab: 'lab' as 'lab' | 'recent',
  /** the card whose replay was started from the picker (or by the first visit) and its proposal */
  card: null as LabId | null,
  pid: null as string | null,
  /** the viewer picked a card or a proposal, or pressed a presenter key: no first-visit replay after that */
  interacted: false,
  autoplay: 'wait' as 'wait' | 'playing' | 'done',
  /** when the first-visit replay became possible (ms) */
  readyAt: 0,
  /** the first-visit replay ended: the picker invites the viewer to pick another card */
  invite: null as LabId | null,
  /** cards already played on this page (their button says "watch again") */
  played: new Set<LabId>(),
  /** how far the first-visit replay got (0..1) */
  autoF: 0,
}

/** The picker card's proposals in the store now */
export const pickNow = (id: LabId): LabPick => pickFor(id, store.proposals.values(), store.implNames, OFFLINE ? 0 : blocks.latest)

/** The viewer acted (a card, a proposal, a presenter key): the first-visit replay will not start, the invite goes */
export function noteInteraction() {
  lab.interacted = true
  lab.invite = null
}

/** Play a card: its live proposal if one is on chain right now, else the replay of its newest judged proposal, from
 *  the start. Returns false when the card has nothing to show yet. */
export function playLab(id: LabId, now = Date.now(), byViewer = true): boolean {
  if (byViewer) noteInteraction()
  const pick = pickNow(id)
  if (pick.live && !OFFLINE) {
    replay.stop(now, pick.live.id)
    store.activeId = pick.live.id
    setManualPick(pick.live.id !== store.newestId())
    lab.card = null
    lab.pid = null
    store.emit()
    return true
  }
  const p = pick.replay
  if (!p || !historyIn(p.id)) return false
  // the viewer asked to see how the attack is stopped, so the stages always play; prefers-reduced-motion only tones
  // the animations down (style.css), it does not skip to the verdict
  if (!replay.playOne(now, p, false, LAB_PLAY)) return false
  // when the replay ends, the screen stays on this proposal's real (final) state; a live proposal still takes over
  store.activeId = p.id
  setManualPick(p.id !== store.newestId())
  lab.card = id
  lab.pid = p.id
  lab.played.add(id)
  store.emit()
  return true
}

/** The picker card being played right now, with how far it is; null when no picker replay is on screen */
export function labPlaying(now = Date.now()): { id: LabId; pid: string; f: number; stage: LabStage; stages: LabStage[] } | null {
  if (!lab.card || !lab.pid || !replay.onDemand) return null
  const pr = replay.progress(now)
  const fr = replayFrame(now)
  if (!pr || !fr || pr.id !== lab.pid || fr.tl.id !== lab.pid) return null
  const src = store.proposals.get(lab.pid)
  const stages = stagesFor(fr.tl.type, !!src && executed(src) && fr.tl.steps.some((s) => s.kind === 'executed'))
  const ph = airlockView(fr.p, fr.vblock).phase
  return { id: lab.card, pid: lab.pid, f: pr.f, stage: stageOf(ph, fr.vblock, fr.tl), stages }
}

/** The first-visit replay's data is in: every recent proposal, or already the autoplay card's newest judged one (the
 *  page reads that one first, so the replay can start before the other cards' history arrives) */
export function autoplayDataIn(): boolean {
  if (playbackGate.ready) return true
  const r = pickNow(AUTOPLAY_CARD).replay
  return !!r && historyIn(r.id)
}

const autoplayCtx = (): AutoplayCtx => ({ clean: CLEAN, pick: PICK, offline: OFFLINE, ready: autoplayDataIn(), interacted: lab.interacted, liveBusy: liveBusy() })

/** The intro has waited this long for the chain: it says the public RPCs are slow and offers the recorded run */
export const INTRO_SLOW_MS = 12_000
/** The intro is still up and the chain has not answered for INTRO_SLOW_MS */
export function introSlow(now = Date.now()): boolean {
  return labIntro(now) && !autoplayDataIn() && playbackGate.startedAt > 0 && now - playbackGate.startedAt > INTRO_SLOW_MS
}

/** The page shows the first-visit intro now: the replay is still to come (data loading, or the short delay after it) */
export function labIntro(now = Date.now()): boolean {
  if (lab.autoplay !== 'wait') return false
  if (lab.readyAt && now - lab.readyAt > AUTOPLAY_GIVE_UP_MS) return false
  return introWanted(autoplayCtx())
}

/** Called every frame: starts the first-visit replay when it may, and notices when it ended. Returns whether the
 *  page must redraw. */
export function tickLab(now = Date.now()): boolean {
  if (lab.autoplay === 'playing') {
    const lp = labPlaying(now)
    if (lp && lp.id === lab.card) {
      lab.autoF = lp.f
      return false
    }
    lab.autoplay = 'done'
    // invite only after a replay that ran to its end (not one a live proposal cut short)
    if (!lab.interacted && lab.card && lab.autoF > 0.9) lab.invite = lab.card
    return true
  }
  if (lab.autoplay !== 'wait') return false
  const ctx = autoplayCtx()
  if (autoplayRuledOut(ctx)) {
    lab.autoplay = 'done'
    return false
  }
  if (!ctx.ready) return false
  if (!lab.readyAt) lab.readyAt = now
  if (now - lab.readyAt > AUTOPLAY_GIVE_UP_MS) {
    lab.autoplay = 'done'
    return false
  }
  // a live proposal holds the screen (the intro gives way to it); the replay may still come after its cooldown
  if (!autoplayWanted(ctx)) return false
  if (now - lab.readyAt < AUTOPLAY_DELAY_MS) return false
  // the autoplay card, or the first card that has a judged proposal
  const order = [AUTOPLAY_CARD, ...LAB_IDS.filter((x) => x !== AUTOPLAY_CARD)]
  const id = order.find((x) => !!pickNow(x).replay && !pickNow(x).live)
  if (!id || !playLab(id, now, false)) {
    lab.autoplay = 'done'
    return false
  }
  lab.autoplay = 'playing'
  return true
}

/** The timeline a card would play (tests and the card's step list) */
export const labTimeline = (id: LabId) => {
  const p = pickNow(id).replay
  return p ? buildTimeline(p) : null
}

/** A proposal on screen is live (not a replay): it arrived live during this visit, or it is in its cooldown now */
export function isLiveNow(p: Proposal | null, now = Date.now()): boolean {
  if (!p || OFFLINE) return false
  const a = store.arrival
  if (a?.id === p.id && now - a.at < LIVE_LABEL_MS) return true
  return p.chain?.status === 1 && !!p.readyBlock && blocks.latest > 0 && blocks.latest < p.readyBlock
}
