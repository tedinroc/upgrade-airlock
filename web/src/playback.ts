// The page's playback controller (replay.ts engine bound to the store): offline mode plays the recorded run in a loop
// from page load; live mode stays on the newest proposal and plays recent ones only after P.
import { blocks } from './chain'
import { CONFIG } from './config'
import { whoMsg } from './events'
import { msg } from './i18n'
import { AutoReplay, type ReplayFrame, type Timeline, type TLStep } from './replay'
import { OFFLINE } from './runtime'
import { short, store, type Proposal } from './store'

/** live mode: page loaded and the recent proposals are in (set by chainwatch / offline loaders) */
export const playbackGate = { ready: false }

function logStep(tl: Timeline, st: TLStep, src: Proposal) {
  const id = tl.id
  const ts = Date.now()
  switch (st.kind) {
    case 'proposed':
      store.logT('chain', 'Proposed', msg('ev.proposed', { id, b: tl.proposeBlock, rb: tl.readyBlock, tx: short(src.proposeTx) }), 'info', ts, true)
      break
    case 'veto': {
      const a = src.guards[st.guard!]
      const real = a?.block ?? st.block
      store.logT(
        'chain',
        'Vetoed',
        msg('ev.vetoed', { id, who: whoMsg(st.guard!), b: real, after: msg('ev.after', { n: real - tl.proposeBlock }), rule: a?.rule ?? short(a?.ruleHash, 4), n: tl.steps.filter((x) => x.kind === 'veto').indexOf(st) + 1 }),
        'bad',
        ts,
        true,
      )
      break
    }
    case 'reason':
      store.logT('chain', 'ReasonAttached', msg('ev.reason', { id, h: short(src.reason?.hash) }), 'info', ts, true)
      break
    case 'clear': {
      const c = src.clearance!
      const real = c.block ?? st.block
      store.logT('chain', 'Cleared', msg('ev.cleared', { id, who: whoMsg(c.by, c.clearer), b: real, after: msg('ev.after', { n: real - tl.proposeBlock }), h: short(c.evidenceHash) }), 'good', ts, true)
      break
    }
    case 'ready': {
      const cleared = tl.steps.some((x) => x.kind === 'clear' && x.block <= st.block)
      const k = tl.type === 'ejected' ? 'rp.readyVetoed' : cleared ? 'rp.readyCleared' : 'rp.readyWaiting'
      store.logT('chain', 'ready', msg(k, { id, b: st.block }), tl.type === 'ejected' ? 'bad' : cleared ? 'good' : 'warn', ts, true)
      break
    }
    case 'executed':
      store.logT('chain', 'Executed', msg('ev.executed', { id, b: src.execute?.block ?? st.block, tx: short(src.execute?.tx) }), 'good', ts, true)
      break
  }
}

export const replay = new AutoReplay(
  Date.now(),
  {
    msPerBlock: CONFIG.replay.msPerBlock,
    firstDelayMs: OFFLINE ? 0 : CONFIG.replay.idleMs,
    idleMs: OFFLINE ? CONFIG.replay.offlineIdleMs : CONFIG.replay.idleMs,
    gapMs: CONFIG.replay.gapMs,
    reducedHoldMs: CONFIG.replay.reducedHoldMs,
  },
  logStep,
)
// live mode stays on the newest proposal's real state (a live proposal can arrive any moment); P starts playback
if (!OFFLINE) replay.paused = true

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** live mode: the newest proposal is still in its cooldown */
function liveBusy(): boolean {
  if (OFFLINE) return false
  let newest: Proposal | null = null
  for (const p of store.proposals.values()) if (!newest || Number(p.id) > Number(newest.id)) newest = p
  return !!newest && newest.chain?.status === 1 && newest.readyBlock !== null && blocks.latest > 0 && blocks.latest < newest.readyBlock
}

/** Called every frame; returns whether the page must redraw */
export function tickReplay(now = Date.now()): boolean {
  if (!playbackGate.ready) return false
  return replay.tick(now, { proposals: store.proposals.values(), get: (id) => store.proposals.get(id), reduced: reducedMotion(), liveBusy: liveBusy() })
}

export function replayFrame(now = Date.now()): ReplayFrame | null {
  return replay.frame(now, (id) => store.proposals.get(id))
}

export function toggleReplay() {
  replay.toggle(Date.now())
  store.emit()
}
