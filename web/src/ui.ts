// The war room, presentation edition. A landscape screen (projector of any shape from 5:4 to 16:9, recorded video) gets
// a 1920x1080 stage scaled to fit and letterboxed (fitStage); a phone, a portrait screen or a narrow window gets one
// scrolling column (style.css decides with the same media query as STAGE_QUERY).
//
//   top bar   product, "Live on Ethereum Sepolia" with a small block counter, Chainlink CRE mark, controls
//   hero      the airlock of the selected proposal: owner key -> outer door -> chamber (cooldown) -> inner door -> proxy
//   verdict   the Chainlink CRE verdict: the pipeline, the rule in plain words, blocks and seconds after the proposal,
//             links to the proposal tx, the report tx and the evidence hash
//   strip     recent proposals as cards (click, or the arrow keys, to select)
//   lab       the attack picker (lab.ts, drawn by lab-ui.ts): seven cards, each replays a real Sepolia proposal of
//             that attack from its arrival; on a stage screen it shares the bottom row with the strip (two tabs)
//   op        operator mode only (operator-client.ts): launch panel, status toast, token prompt
//   details   developer drawer (D): every hash, gas cost, connection, event stream; hidden by default
//   help      presenter shortcuts (?)
//
// Presenter chrome (language switch, Details, ?, key hints) fades out after 3 s without mouse movement on a stage
// screen and is never drawn with ?clean=1 (for recordings). Touch screens never show key hints.
//
// Each region is rewritten only when its HTML changes. When the proposal on screen changes state (it arrives, the
// verdict lands, the inner door opens) the affected regions carry a short "moment" class (m-arrive, m-veto, m-clear,
// m-exec) so the CSS plays the change once; picking another proposal only fades it in. Every word goes through t().
import { airlockView, fmtClock, fmtDur, type AirlockPhase, type AirlockView } from './airlock'
import { blocks } from './chain'
import { DATA, PENDING, RECORDING } from './chaindata'
import { chainHealth } from './chainwatch'
import { CONFIG } from './config'
import { HELP_ROWS, type Action } from './controls'
import { fmtEth, fmtGasPrice, plausibleBlockMs, realWorkflowId, txCost } from './derive'
import { blockTs } from './events'
import { cardDesc, kindText, labLine, labName, lang, LANG_LABEL, LANGS, onLangChange, ruleShortText, ruleText, setLang, t, tm, type Key } from './i18n'
import { introSlow, isLiveNow, LAB_CARDS, LAB_PLAY, labIntro, labPlaying } from './lab'
import { dayOf, opBarButton, renderLab, renderOperator, replayLabel, tabsHtml } from './lab-ui'
import { opVisible, pendingLaunch, type Launch } from './operator-client'
import { judgeProgress, replay, replayFrame } from './playback'
import type { ReplayFrame } from './replay'
import { CHAIN, CLEAN, FORK, OFFLINE } from './runtime'
import { short, store, type Proposal } from './store'
import { CARDS, ruleShort, type CardInfo } from './types'
import { $, addrLink, esc, fullHash, hashSpan, I, num, patch, txLink } from './view'

/** Stage mode: wide landscape screens. style.css uses the same query. */
export const STAGE_QUERY = '(min-width: 960px) and (min-aspect-ratio: 5/4)'
const STAGE_W = 1920
const STAGE_H = 1080

/** Developer drawer and help overlay (main.ts toggles them) */
export const ui = { details: false, help: false }

/** During playback the hero shows the virtual block; live, the chain head */
let RF: ReplayFrame | null = null
const curBlock = () => (RF ? RF.vblock : blocks.latest)

/** Sourcify badge (live Sepolia only), shown after a confirmed match */
function verifiedChip(addr: string | undefined | null): string {
  if (!addr || !CHAIN.sourcifyApi) return ''
  return store.verified.get(addr.toLowerCase()) === 'yes' ? ` <span class="vchip">${t('dr.verified')}</span>` : ''
}

// ---------- skeleton and stage ----------
export function mountSkeleton() {
  $('app').innerHTML = `
  <div id="stage" class="stage">
    <header class="bar">
      <div class="brand">${I.mark}<div class="brand-txt"><div class="brand-name">Upgrade Airlock</div><div id="t-sub" class="brand-sub"></div></div></div>
      <div id="t-status" class="status" aria-live="polite"></div>
      <div class="bar-r"><div id="t-ctl" class="ctl"></div><div id="t-cre" class="cre"></div></div>
    </header>
    <section id="lab" class="lab" aria-live="polite"></section>
    <main class="main">
      <section class="hero" aria-live="polite">
        <div id="h-head" class="h-head"></div>
        <div id="h-wrap" class="lockwrap"><div id="h-lock" class="lockbox"></div><div id="h-count" class="count"></div><div id="h-stamp" class="count stampbox"></div></div>
        <div id="h-doors" class="doors"></div>
        <div id="h-banner" class="banner-slot"></div>
      </section>
      <aside class="verdict">
        <div id="v-head" class="v-head"></div>
        <div id="v-main" class="v-main"></div>
        <div id="v-pipe" class="v-pipe"></div>
        <div id="v-links" class="v-links"></div>
      </aside>
    </main>
    <section id="strip" class="strip"></section>
    <aside id="details" class="drawer" aria-hidden="true"></aside>
    <div id="help" class="help" aria-hidden="true"></div>
    <div id="op" class="op" aria-hidden="true"></div>
    <div id="op-token" class="op" aria-hidden="true"></div>
    <div id="op-toast" class="op-toast" aria-live="polite"></div>
  </div>`
  if (CLEAN) document.documentElement.classList?.add('clean')
  startIdle()
  fitStage()
  window.addEventListener('resize', fitStage)
  window.addEventListener('orientationchange', fitStage)
  // language switch: handled here (not through data-act); the main loop redraws on store.emit()
  document.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-lang]')
    const l = el?.dataset.lang
    if (l) setLang(l as never)
  })
  onLangChange(() => store.emit())
}

/** Stage mode: scale the 1920x1080 stage to the window and centre it. Stack mode: plain flow (CSS) */
function fitStage() {
  const el = $('stage')
  const stage = typeof window.matchMedia === 'function' && window.matchMedia(STAGE_QUERY).matches
  if (!stage) {
    el.style.removeProperty('transform')
    el.style.removeProperty('left')
    el.style.removeProperty('top')
    return
  }
  const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H)
  el.style.transform = `scale(${s})`
  el.style.left = `${Math.max(0, (window.innerWidth - STAGE_W * s) / 2)}px`
  el.style.top = `${Math.max(0, (window.innerHeight - STAGE_H * s) / 2)}px`
}

/** No mouse movement for 3 s: the presenter chrome fades out (CSS, stage screens with a mouse only) and so does the
 *  cursor. Any mouse movement brings both back; keys do not, so a presenter with a clicker keeps a clean screen. */
const IDLE_MS = 3000
function startIdle() {
  const root = document.documentElement
  if (!root?.classList || typeof window.addEventListener !== 'function') return
  let timer: ReturnType<typeof setTimeout> | undefined
  const wake = () => {
    root.classList.remove('idle')
    clearTimeout(timer)
    timer = setTimeout(() => root.classList.add('idle'), IDLE_MS)
  }
  window.addEventListener('mousemove', wake, { passive: true })
  window.addEventListener('mousedown', wake, { passive: true })
  wake()
}

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// ---------- what a proposal is ----------
function cardOf(p: Proposal): CardInfo | null {
  const id = p.card ?? store.implNames.get(p.target.toLowerCase())
  return CARDS.find((c) => c.id === id) ?? null
}

interface Ident {
  /** headline */
  title: string
  /** one line under it */
  desc: string
  /** short name for the capsule and the card */
  name: string
}
export function identOf(p: Proposal): Ident {
  const kind = Number(p.kind)
  if (kind === 1) {
    const cre = p.target.toLowerCase() === DATA.receiver.toLowerCase()
    const on = p.value !== undefined && p.value !== '0'
    const who = cre ? 'Chainlink CRE' : short(p.target, 4)
    return {
      title: t(on ? 'h.guardOn' : 'h.guardOff', { who }),
      desc: cre && !on ? t('h.descRemoveCre') : t('h.descGuard'),
      name: cre && !on ? t('h.nameRemoveCre') : t('h.nameGuard'),
    }
  }
  if (kind === 2) return { title: t('h.delay', { n: p.value ?? '?' }), desc: t('h.descGuard'), name: t('h.nameDelay') }
  if (kind === 3) return { title: t('h.paused', { a: short(p.target, 4) }), desc: t('h.descGuard'), name: t('h.namePaused') }
  const c = cardOf(p)
  if (c) {
    // the same plain sentence as its attack card (the technical one only for a demo implementation without a card)
    const lc = LAB_CARDS.find((x) => x.impl === c.id)
    return { title: c.name, desc: lc ? labLine(lc.id) : cardDesc(c.id), name: c.name }
  }
  return { title: t('h.newImpl', { a: short(p.target, 4) }), desc: t('h.descUnknown'), name: short(p.target, 4) }
}

/** The rule a proposal was vetoed with (CRE first), if any */
const vetoRuleOf = (p: Proposal | undefined): string | null => p?.guards.cre.rule ?? p?.guards.breakglass.rule ?? null

const whoName = (by: string | undefined) => (by === 'cre' || by === undefined ? t('who.cre') : by === 'breakglass' ? t('who.human') : by === 'approver' ? t('who.approver') : t('who.someone'))

/** Cooldown in blocks: the deployment, else the default */
const delayBlocks = () => store.deploy?.delayBlocks ?? DATA.delayBlocks ?? CONFIG.delayBlocks
const tsOf = (n: number) => blockTs.get(n)
/** Live, a log can arrive before its block header: never draw a proposal as if it were before its own block */
const viewOf = (p: Proposal | null, cur = curBlock()): AirlockView => airlockView(p, RF ? cur : Math.max(cur, p?.proposeBlock ?? 0), tsOf)
/** A proposal's state now (chain head, or the end of the recording), whatever the playback shows */
const finalView = (p: Proposal) => airlockView(p, Math.max(OFFLINE ? RECORDING.head : blocks.latest, p.proposeBlock ?? 0), tsOf)

/** Seconds left on the cooldown clock: live, it ticks down between blocks (an estimate, shown with ≈) */
function etaSec(v: AirlockView): number {
  if (RF || OFFLINE || !blocks.lastAt) return v.leftSec
  const since = Math.min(CONFIG.blockSec, Math.max(0, (Date.now() - blocks.lastAt) / 1000))
  return Math.max(0, v.leftSec - since)
}

/** The picker's fast-forwarded cooldown, as a multiple of real time (12 s blocks at LAB_PLAY.fastMsPerBlock) */
const FF_FACTOR = Math.round((CONFIG.blockSec * 1000) / (LAB_PLAY.fastMsPerBlock ?? LAB_PLAY.msPerBlock ?? 600))

/** The address of this page in offline playback (the recorded real Sepolia run), keeping the language */
function offlineHref(): string {
  try {
    const u = new URL(location.href)
    for (const k of ['p', 'rpc', 'clean', 'op']) u.searchParams.delete(k)
    u.searchParams.set('mode', 'offline')
    return `${u.pathname}?${u.searchParams}`
  } catch {
    return '?mode=offline'
  }
}

/** A replay between its arrival and its verdict: which CRE workflow step the verdict card is on (the same steps) */
function replayStep(p: Proposal, now: number): { i: number; steps: PipeStep[] } | null {
  if (!RF) return null
  const f = judgeProgress(now)
  if (f === null) return null
  const steps = pipelineOf(p.kind, vetoRuleOf(store.proposals.get(RF.tl.id)))
  return { i: Math.min(steps.length - 1, Math.floor(f * steps.length)), steps }
}

// ---------- the Chainlink CRE verdict of a proposal ----------
type VKind = 'none' | 'await' | 'veto' | 'clear' | 'human' | 'approver' | 'skipped' | 'far' | 'clearFar' | 'loading' | 'intro' | 'pending'
/** live view before the proposals' logs arrive: a missing verdict log is still on its way, not out of reach */
const logsPending = () => !OFFLINE && !chainHealth.loadedRecent
interface VerdictInfo {
  kind: VKind
  rule: string | null
  after: { afterBlocks: number; afterSec: number; secFromTs: boolean } | null
  tx?: string
  evidence?: string
  workflow?: string
}
function verdictOf(p: Proposal | null, v: AirlockView): VerdictInfo {
  const none: VerdictInfo = { kind: 'none', rule: null, after: null }
  if (!p || v.phase === 'idle') return none
  if (v.phase === 'ejected') {
    const x = v.veto
    if (!x) return { ...none, kind: logsPending() ? 'loading' : 'far' }
    if (x.by === 'cre') return { kind: 'veto', rule: x.rule, after: x, tx: x.tx, evidence: x.evidenceHash ?? p.reason?.hash, workflow: x.workflowId }
    return { kind: 'human', rule: x.rule, after: x, tx: x.tx }
  }
  if (v.phase === 'chamber' || v.phase === 'waiting') return { ...none, kind: 'await' }
  const cre = p.guards.cre
  const c = v.clear
  if (c?.by === 'cre' || cre.verdict === 'pass') {
    const after = c?.by === 'cre' ? c : null
    return { kind: 'clear', rule: null, after, tx: c?.by === 'cre' ? c.tx : cre.tx, evidence: c?.by === 'cre' ? c.evidenceHash : (cre.evidenceHash ?? c?.evidenceHash), workflow: cre.workflowId }
  }
  if (c?.by === 'approver') return { kind: v.phase === 'executed' ? 'skipped' : 'approver', rule: null, after: null, tx: c.tx, evidence: c.evidenceHash }
  return { ...none, kind: v.cleared ? (logsPending() ? 'loading' : 'clearFar') : 'await' }
}

/** "1 block · 12 s after the proposal" (≈ when estimated from 12 s blocks) */
const afterText = (a: VerdictInfo['after']) => (a ? t(a.secFromTs ? 'v.after' : 'v.afterEst', { n: a.afterBlocks, t: fmtDur(a.afterSec) }) : '')

// ---------- moments: what changed on the proposal on screen ----------
type MomentKind = 'arrive' | 'veto' | 'clear' | 'exec'
/** How long each moment plays (style.css keyframes fit inside) */
const MOMENT_MS: Record<MomentKind, number> = { arrive: 1300, veto: 2700, clear: 2500, exec: 2500 }
interface Moment {
  id: string
  kinds: MomentKind[]
  delays: number[]
  until: number
}
let shown: { id: string | null; phase: AirlockPhase | null } = { id: null, phase: null }
let moment: Moment | null = null
let enterUntil = 0

/** Which moments a change of phase plays (from null: the proposal was not on screen before) */
export function momentsFor(from: AirlockPhase | null, to: AirlockPhase): MomentKind[] {
  const fresh = from === null || from === 'idle'
  const cooling = from === 'chamber' || from === 'waiting'
  if (to === 'idle' || from === to) return []
  if (to === 'ejected') return fresh ? ['arrive', 'veto'] : ['veto']
  if (to === 'executed') return fresh ? ['arrive', 'clear', 'exec'] : cooling ? ['clear', 'exec'] : ['exec']
  if (to === 'cleared' || to === 'ready') return fresh ? ['arrive', 'clear'] : cooling ? ['clear'] : []
  return fresh ? ['arrive'] : []
}

function track(id: string | null, ph: AirlockPhase, now: number) {
  if (id !== shown.id) {
    const was = shown.id
    shown = { id, phase: ph }
    moment = null
    // a proposal that just arrived live plays its arrival; a pick by the viewer only fades in
    const a = store.arrival
    if (!RF && id && a?.id === id && now - a.at < 30_000) begin(id, momentsFor(null, ph), now)
    else if (was !== null || id !== null) enterUntil = now + 500
    return
  }
  if (ph !== shown.phase) {
    const kinds = momentsFor(shown.phase, ph)
    shown.phase = ph
    if (id && kinds.length) begin(id, kinds, now)
  }
}

function begin(id: string, kinds: MomentKind[], now: number) {
  if (!kinds.length || reducedMotion()) return
  const delays: number[] = []
  let at = 0
  for (const k of kinds) {
    delays.push(at)
    at += MOMENT_MS[k]
  }
  moment = { id, kinds, delays, until: now + at + 300 }
}

/** The moment classes and delay variables for one region, or nothing once the moment is over */
function mom(now: number): { cls: string; style: string; delay: (k: MomentKind) => number | null } {
  const m = moment
  if (!m || now > m.until || m.id !== shown.id) return { cls: '', style: '', delay: () => null }
  return {
    cls: m.kinds.map((k) => ` m-${k}`).join(''),
    style: m.kinds.map((k, i) => `--d-${k}:${m.delays[i]}ms`).join(';'),
    delay: (k) => (m.kinds.includes(k) ? m.delays[m.kinds.indexOf(k)] : null),
  }
}

/** A door caption: its ' · ' phrases as spans (inline on the stage, one per line on a phone), a number glued to its
 *  unit and "block" to its "#n" with no-break spaces, so a narrow column never strands a unit or a separator */
export function phrases(s: string): string {
  const glue = (x: string) => x.replace(/(\d) (?=\S)/g, '$1\u00a0').replace(/ #/g, '\u00a0#').replace(/ ≈ /g, ' ≈\u00a0')
  return s
    .split(' · ')
    .map((x) => `<span class="ph">${esc(glue(x))}</span>`)
    .join('<span class="sep"> · </span>')
}

// ---------- top bar ----------
function renderBar() {
  patch('t-sub', esc(t('brand.sub')))
  let status: string
  const blk = (n: number) => (n ? `<span class="blk"><span class="blk-l">${t('st.block')}</span><span class="blk-n">#${num(n)}</span></span>` : '')
  if (OFFLINE) {
    const label = RECORDING.source === 'none' ? t('st.offlineEmpty') : t(RECORDING.source === 'sepolia' ? 'st.offline' : 'st.offlineFork')
    status = `<span class="pill replay"><i class="dot"></i>${esc(label)}</span>${blk(RF ? RF.vblock : RECORDING.head)}`
  } else if (RF) {
    // a replay on the live page: the pill says so (live comes back the moment the replay ends or a live event lands)
    status = `<span class="pill replay"><i class="dot"></i>${esc(t('st.replayOf', { id: RF.tl.id }))}</span>${blk(RF.vblock)}`
  } else {
    const st = !blocks.latest ? 'connecting' : blocks.link === 'down' ? 'down' : 'live'
    const label = st === 'live' ? t(FORK ? 'st.fork' : 'st.live') : st === 'down' ? t('st.down') : t('st.connecting')
    status = `<span class="pill ${st}${FORK ? ' fork' : ''}"><i class="dot"></i>${esc(label)}</span>${blk(blocks.latest)}`
  }
  patch('t-status', status)
  patch('t-cre', `<span class="cre-by">${esc(t('cre.by'))}</span><span class="cre-logo">${I.hex}<b>Chainlink</b><span>CRE</span></span>`)
  const cur = lang()
  const langs = LANGS.map((l) => `<button data-lang="${l}" class="${l === cur ? 'on' : ''}" aria-pressed="${l === cur}" lang="${l}">${LANG_LABEL[l]}</button>`).join('')
  patch(
    't-ctl',
    opBarButton() +
      `<div class="seg" role="group" title="${esc(t('ctl.langTitle'))}">${langs}</div>` +
      `<button data-act="details" class="btn${ui.details ? ' on' : ''}" title="${esc(t('ctl.detailsTitle'))}" aria-expanded="${ui.details}">${esc(t('ctl.details'))}</button>` +
      `<button data-act="help" class="btn sq${ui.help ? ' on' : ''}" title="${esc(t('ctl.helpTitle'))}" aria-label="${esc(t('ctl.help'))}">?</button>`,
  )
}

// ---------- hero ----------
function renderHero(p: Proposal | null, v: AirlockView, now: number, intro: boolean, pend: Launch | null) {
  const m = mom(now)
  const enter = now < enterUntil ? ' enter' : ''
  const ph = v.phase
  const id = p ? identOf(p) : null
  const slow = intro && introSlow(now)
  const fastNow = !!RF && ph === 'cleared' && labPlaying(now)?.stage === 'fast'

  // which proposal
  if (pend) {
    // the operator just launched a real attack: its transaction is on its way into a Sepolia block
    patch(
      'h-head',
      `<div class="h-eyebrow"><span>${esc(t('h.pendEyebrow'))}</span><span class="tag live"><i class="dot"></i>${esc(t('h.live'))}</span></div>` +
        `<h1 class="h-title">${esc(labName(pend.card))}</h1><p class="h-desc">${esc(t('h.pendDesc'))}</p>`,
    )
  } else if (intro) {
    // first visit, before its replay starts: say a real attack is about to replay, never the newest final verdict.
    // When the public RPCs do not answer for a while, say so and offer the recorded run instead of "in a moment".
    const body = slow
      ? `<h1 class="h-title">${esc(t('h.slowTitle'))}</h1><p class="h-desc">${esc(t('h.slowDesc'))} <a class="h-off" href="${esc(offlineHref())}">${esc(t('h.slowLink'))}</a></p>`
      : `<h1 class="h-title">${esc(t('h.introTitle'))}</h1><p class="h-desc">${esc(t('h.introDesc'))}</p>`
    patch('h-head', `<div class="h-eyebrow"><span>${esc(t('h.introEyebrow'))}</span><span class="tag replay">${I.play}${esc(t('h.replayReal'))}</span></div>` + body)
  } else if (!p) {
    const n = delayBlocks()
    const head = PENDING ? (OFFLINE ? t('h.noRecording') : t('h.pending')) : OFFLINE || chainHealth.loadedRecent ? t('h.empty') : t('h.loading')
    patch('h-head', `<div class="h-eyebrow">&nbsp;</div><h1 class="h-title">${esc(head)}</h1><p class="h-desc">${esc(t('h.emptyDesc', { n, t: fmtDur(n * CONFIG.blockSec) }))}</p>`)
  } else {
    // a replay says it is one (live mode: of a real Sepolia proposal, with its date); a proposal happening now says live
    const tag = RF
      ? `<span class="tag replay">${RF.paused ? I.pause : I.play}${RF.paused ? esc(t('h.replayPaused')) : OFFLINE ? esc(t('h.replay')) : replayLabel(store.proposals.get(RF.tl.id))}</span>`
      : p.dropped
        ? `<span class="tag warn">${esc(t('h.dropped'))}</span>`
        : isLiveNow(p)
          ? `<span class="tag live"><i class="dot"></i>${esc(t('h.live'))}</span>`
          : OFFLINE
            ? ''
            : // a past proposal's real state: dated, so it never reads as if it had just happened live
              `<span class="tag state">${esc(dayOf(p) ? t('h.onchain', { d: dayOf(p)! }) : t('h.onchainNoDate'))}</span>`
    patch(
      'h-head',
      `<div class="h-eyebrow${enter}"><span>${esc(t('h.eyebrow', { id: p.id, kind: kindText(p.kind) }))}</span>${tag}</div>` +
        `<h1 class="h-title${enter}">${esc(id!.title)}</h1><p class="h-desc${enter}">${esc(id!.desc)}</p>`,
    )
  }

  // the airlock picture; the capsule position rides on --p (set on the wrapper, so a new block does not redraw it)
  const wrap = $('h-wrap')
  const pos = ph === 'executed' ? 1 : ph === 'idle' ? 0 : v.pct / 100
  wrap.style.setProperty('--p', pos.toFixed(4))
  const lockOpen = ph === 'cleared' || ph === 'ready' || ph === 'executed'
  const capIcon = ph === 'ejected' ? I.x : lockOpen ? I.check : I.hex
  const cap = p && ph !== 'idle' ? `<div class="cap-in"><div class="cap-out"><div class="lk-cap">${capIcon}<b>${esc(id!.name)}</b></div></div></div>` : ''
  const proxyState = ph === 'executed' ? t('g.proxyLive', { name: id!.name }) : ph === 'idle' ? t('g.proxyIdle') : t('g.proxySafe')
  patch(
    'h-lock',
    `<div class="lk ph-${ph}${m.cls}${enter}" style="${m.style}">` +
      `<div class="lk-owner">${I.key}<b>${esc(t('g.owner'))}</b><small>${esc(t('g.ownerSub'))}</small><i class="lk-path"></i></div>` +
      `<div class="lk-door lk-outer"><i class="lf t"></i><i class="lf b"></i></div>` +
      `<div class="lk-ch"><i class="lk-grid"></i><i class="lk-scan"></i><i class="lk-flash"></i><div class="lk-rail"><i class="lk-fill"></i><i class="lk-x">${I.x}</i></div>${cap}</div>` +
      `<div class="lk-door lk-inner"><i class="lf t"></i><i class="lf b"></i><span class="lk-lock">${lockOpen ? I.unlock : I.lock}</span></div>` +
      `<div class="lk-dest">${I.proxy}<b>${esc(t('g.proxy'))}</b><small>${esc(proxyState)}</small></div>` +
      `</div>`,
  )

  // the numbers in the chamber
  let count: string
  let still = false
  switch (ph) {
    case 'chamber':
    case 'cleared':
      count =
        `<div class="cn-num"><b>${v.left}</b><span>${esc(t('c.left', { n: v.left }))}</span></div>` +
        `<div class="cn-eta">${I.clock}${esc(t('c.eta', { t: fmtClock(etaSec(v)) }))}<span class="cn-of">${esc(t('c.leftSub'))}</span></div>` +
        // a replay's clock is compressed (it holds while the CRE judges): say so, so a still number does not look stuck
        (RF ? `<div class="cn-rp">${esc(t('c.compressed'))}</div>` : '')
      if (ph === 'cleared') {
        count += fastNow
          ? `<div class="cn-tag ff">${I.ff}${esc(t('c.ff', { n: FF_FACTOR }))}</div>`
          : `<div class="cn-tag good">${I.check}${esc(v.clear?.by === 'cre' || !v.clear ? t('c.cleared') : t('c.clearedBy', { who: whoName(v.clear.by) }))}</div>`
      } else {
        // a replay walks through the workflow's steps here too (on a phone the verdict card is below the fold)
        const rs = p ? replayStep(p, now) : null
        count += rs
          ? `<div class="cn-tag await step"><i class="spin"></i><span>${esc(t('c.step', { s: rs.i === rs.steps.length - 1 ? t('p.chain') : t(rs.steps[rs.i].k), i: rs.i + 1, n: rs.steps.length }))}</span></div>`
          : `<div class="cn-tag await">${esc(t('c.awaiting'))}</div>`
      }
      break
    case 'waiting':
      count = `<div class="cn-word warn">${esc(t('c.over'))}</div><div class="cn-sub">${esc(t('c.noClear'))}</div>`
      still = true
      break
    case 'ready':
      count = `<div class="cn-word good">${esc(t('c.ready'))}</div><div class="cn-sub">${esc(t('c.readySub'))}</div>`
      still = true
      break
    case 'executed':
      count = `<div class="cn-word good">${I.check}${esc(t('c.executed'))}</div>`
      still = true
      break
    case 'ejected':
      count = `<div class="cn-stamp">${esc(t('c.ejected'))}</div><div class="cn-sub">${esc(v.veto ? t('c.vetoAt', { n: v.veto.afterBlocks }) : t(logsPending() ? 'v.loading' : 'v.far'))}</div>`
      still = true
      break
    default:
      // a replay's lead-in: the proposal is about to reach the outer door
      count = pend
        ? `<div class="cn-sub intro"><i class="spin"></i>${esc(t(pend.state === 'sending' ? 'op.sending' : 'c.pending'))}</div>` +
          (pend.txHash ? `<div class="cn-tx">${txLink(pend.txHash, 6)}</div>` : '')
        : intro
          ? `<div class="cn-sub intro"><i class="spin"></i>${esc(t(slow ? 'c.slow' : 'c.intro'))}</div>`
        : RF && p
          ? `<div class="cn-sub arriving">${esc(t('c.arriving', { id: p.id }))}</div>`
          : `<div class="cn-sub dim">${esc(t('c.empty'))}</div>`
  }
  // a ticking clock never carries the moment classes (it is redrawn every second)
  patch('h-count', `<div class="cn ph-${ph}${still ? m.cls : ''}" style="${still ? m.style : ''}">${count}</div>`)

  // the clearance lands: a green CLEARED stamp over the chamber for a moment, then the countdown comes back. It has
  // its own layer (the countdown below it redraws every second, which would restart an animation)
  const dClear = m.delay('clear')
  const stamping = dClear !== null && (ph === 'cleared' || ph === 'ready' || ph === 'executed')
  wrap.classList.toggle('stamping', stamping)
  if (stamping) wrap.style.setProperty('--d-clear', `${dClear}ms`)
  patch('h-stamp', stamping ? `<div class="cstamp"><span class="cn-stamp good">${esc(t('c.clearStamp'))}</span></div>` : '')

  // the three doors in words
  const n = p?.readyBlock && p.proposeBlock ? p.readyBlock - p.proposeBlock : delayBlocks()
  const outer = p?.proposeBlock && ph !== 'idle' ? t('d.outerOn', { b: num(p.proposeBlock) }) : t('d.outerIdle')
  const [inner, innerCls] =
    ph === 'executed'
      ? [p?.execute ? t('d.innerOpen', { b: num(p.execute.block) }) : t('c.executed'), 'good']
      : ph === 'ejected'
        ? [t('d.innerSealed'), 'bad']
        : ph === 'ready'
          ? [t('d.innerReady'), 'good']
          : ph === 'cleared'
            ? [t('d.innerUnlocked', { b: num(p!.readyBlock!) }), 'good']
            : ph === 'waiting'
              ? [t('d.innerWaiting'), 'warn']
              : [t('d.innerLocked'), '']
  patch(
    'h-doors',
    `<div class="dl"><span class="dl-k">${esc(t('d.outer'))}</span><span class="dl-v">${phrases(outer)}</span></div>` +
      `<div class="dl c"><span class="dl-k">${esc(t('d.chamber'))}</span><span class="dl-v">${phrases(t('d.chamberSub', { n, t: fmtDur(n * CONFIG.blockSec) }))}</span></div>` +
      `<div class="dl r"><span class="dl-k">${esc(t('d.inner'))}</span><span class="dl-v ${innerCls}">${phrases(inner)}</span></div>`,
  )

  // the sentence under it
  let icon = I.clock
  let text: string
  let rule = ''
  switch (ph) {
    case 'ejected': {
      icon = I.eject
      text = v.veto ? t('b.ejected', { who: whoName(v.veto.by) }) : t('b.ejectedFar')
      const r = v.veto?.rule
      if (r) rule = `<span class="bn-rule"><b>${esc(ruleShort(r))}</b>${esc(ruleShortText(r))}</span>`
      break
    }
    case 'executed':
      icon = I.check
      text = t('b.executed', { name: id!.name })
      break
    case 'ready':
      icon = I.unlock
      text = t('b.ready', { who: whoName(v.clear?.by) })
      break
    case 'cleared':
      icon = I.unlock
      text = t('b.cleared', { who: whoName(v.clear?.by) })
      break
    case 'waiting':
      icon = I.lock
      text = t('b.waiting')
      break
    case 'chamber':
      text = t('b.chamber')
      break
    default:
      text = pend ? t('b.pending') : intro ? t('b.intro') : RF && p ? t('b.arriving') : t('b.idle')
  }
  patch('h-banner', `<div class="banner ph-${ph}${m.cls}${enter}" style="${m.style}"><span class="bn-i">${icon}</span><span class="bn-t">${esc(text)}</span>${rule}</div>`)
}

// ---------- verdict card ----------
export interface PipeStep {
  k: Key
  s: Key
  /** this step decided the veto (drawn with an x) */
  fail?: boolean
}
const STEP = {
  sim: { k: 'p.sim', s: 'p.simS' },
  agree: { k: 'p.agree', s: 'p.agreeS' },
  cfg: { k: 'p.cfg', s: 'p.cfgS' },
  approval: { k: 'p.static', s: 'p.staticS' },
  undecided: { k: 'p.simFail', s: 'p.simFailS', fail: true },
  don: { k: 'p.don', s: 'p.donS' },
  sign: { k: 'p.sign', s: 'p.signS' },
  chain: { k: 'p.chain', s: 'p.chainS' },
} satisfies Record<string, PipeStep>

/** The steps the workflow really runs for a proposal (README, "How it works" and the rules table): a change to the
 *  airlock itself (kinds 1-3) is judged from chain reads at the proposal block (R7); an upgrade vetoed by a static
 *  rule (R5, R8) never reaches the simulation; R6 means the simulation could not decide. Every other upgrade is
 *  attack-simulated on 4 providers whose answers must agree. Consensus, the signed report and the write on chain
 *  follow in every case. */
export function pipelineOf(kind: string | undefined, rule: string | null | undefined): PipeStep[] {
  const tail = [STEP.don, STEP.sign, STEP.chain]
  if (kind !== undefined && Number(kind) !== 0) return [STEP.cfg, ...tail]
  if (rule === 'R5_STRICT_CODEHASH' || rule === 'R8_INIT_DATA') return [STEP.approval, ...tail]
  if (rule === 'R6_SIM_FAILURE') return [STEP.undecided, ...tail]
  return [STEP.sim, STEP.agree, ...tail]
}

function renderVerdict(p: Proposal | null, v: AirlockView, now: number, intro: boolean, pend: Launch | null) {
  const m = mom(now)
  const vi: VerdictInfo = pend ? { kind: 'pending', rule: null, after: null } : intro ? { kind: 'intro', rule: null, after: null } : verdictOf(p, v)
  // a replay says so here too (on a phone the labels at the top have scrolled away by now)
  patch('v-head', `${I.hex}<h2>${esc(t('v.title'))}</h2>${RF && !OFFLINE ? `<span class="tag replay v-rp">${I.play}${esc(t('v.replayTag'))}</span>` : ''}`)

  let chip: string
  let body: string
  switch (vi.kind) {
    case 'veto':
      chip = `<span class="v-chip veto">${I.x}${esc(t('v.veto'))}</span>${vi.rule ? `<span class="v-code">${esc(ruleShort(vi.rule))}</span>` : ''}`
      body = `<p class="v-rule">${esc(vi.rule ? ruleText(vi.rule) : '')}</p>`
      break
    case 'clear':
      chip = `<span class="v-chip clear">${I.check}${esc(t('v.clear'))}</span>`
      // an upgrade survived the attack simulation; a change to the airlock passed the config check (no simulation)
      body = `<p class="v-rule">${esc(t(p && Number(p.kind) !== 0 ? 'v.clearTextCfg' : 'v.clearText'))}</p>`
      break
    case 'human':
      chip = `<span class="v-chip veto">${I.x}${esc(t('v.veto'))}</span>${vi.rule ? `<span class="v-code">${esc(ruleShort(vi.rule))}</span>` : ''}`
      body = `<p class="v-rule">${esc(t('v.human'))}</p>`
      break
    case 'far':
      chip = `<span class="v-chip veto">${I.x}${esc(t('v.veto'))}</span>`
      body = `<p class="v-rule">${esc(t('v.far'))}</p>`
      break
    case 'clearFar':
      chip = `<span class="v-chip clear">${I.check}${esc(t('v.clear'))}</span>`
      body = `<p class="v-rule">${esc(t('v.clearFar'))}</p>`
      break
    case 'loading':
      chip = `<span class="v-chip none"><i class="spin"></i>${esc(t('v.loadingChip'))}</span>`
      body = `<p class="v-rule dim">${esc(t('v.loading'))}</p>`
      break
    case 'approver':
    case 'skipped':
      chip = `<span class="v-chip none">${esc(t('v.none'))}</span>`
      body = `<p class="v-rule">${esc(t(vi.kind === 'approver' ? 'v.approver' : 'v.skipped'))}</p>`
      break
    case 'await':
      chip = `<span class="v-chip await"><i class="spin"></i>${esc(t('v.awaiting'))}</span>`
      body = `<p class="v-rule">${esc(t('v.awaitText'))}</p>`
      break
    case 'intro':
      chip = `<span class="v-chip none">${I.play}${esc(t('v.introChip'))}</span>`
      body = `<p class="v-rule dim">${esc(t('v.introText'))}</p>`
      break
    case 'pending':
      chip = `<span class="v-chip none"><i class="spin"></i>${esc(t('v.pendChip'))}</span>`
      body = `<p class="v-rule dim">${esc(t('v.pendText'))}</p>`
      break
    default:
      chip = `<span class="v-chip none">${esc(t('v.none'))}</span>`
      body = `<p class="v-rule dim">${esc(t('v.noneText'))}</p>`
  }
  const time = vi.after ? `<p class="v-time">${afterText(vi.after)}</p>` : ''
  const land = vi.kind === 'veto' || vi.kind === 'clear'
  patch('v-main', `<div class="vm k-${vi.kind}${land ? m.cls : ''}" style="${land ? m.style : ''}"><div class="v-verdict">${chip}</div>${body}${time}</div>`)

  // the pipeline this proposal really went through: dim before a proposal, running while it waits, every step done
  // once the verdict is on chain. A replay walks through the steps one by one until its verdict lands (the steps
  // the workflow runs, not their real timing: the real verdict time is the "after the proposal" line above).
  const st = land ? 'done' : vi.kind === 'await' ? 'run' : 'off'
  const last = vi.kind === 'veto' ? t('p.landVeto') : vi.kind === 'clear' ? t('p.landClear') : t('p.chain')
  // a replay's verdict decides the steps up front (an R7 change has no simulation step), so they do not change shape
  const rule = vi.kind === 'veto' ? vi.rule : RF && st === 'run' ? (vetoRuleOf(store.proposals.get(RF.tl.id)) ?? null) : null
  const steps = pipelineOf(p?.kind, rule)
  const end = steps.length - 1
  const f = RF && st === 'run' ? judgeProgress(now) : null
  const cur = f === null ? -1 : Math.min(end, Math.floor(f * steps.length))
  patch(
    'v-pipe',
    `<ol class="pipe st-${st} k-${vi.kind} n-${steps.length}${cur >= 0 ? ' seq' : ''}${land ? m.cls : ''}" style="${land ? m.style : ''}">` +
      steps
        .map((s, i) => {
          const x = vi.kind === 'veto' && (i === end || (s.fail && land))
          const sq = cur < 0 ? '' : i < cur ? 'ok' : i === cur ? 'cur' : 'next'
          const cls = [s.fail && land ? 'fail' : '', sq].filter(Boolean).join(' ')
          const dot = sq === 'cur' ? '<i class="spin"></i>' : x ? I.x : I.check
          return `<li class="${cls}" style="--i:${i}"><span class="pi-dot">${dot}</span><div class="pi-t"><b>${esc(i === end ? last : t(s.k))}</b><small>${esc(t(s.s))}</small></div></li>`
        })
        .join('') +
      `</ol>`,
  )

  // links
  if (!p || v.phase === 'idle') {
    patch('v-links', '')
    return
  }
  const rows = p.proposeTx ? [`<div class="lnk"><span>${esc(t('l.proposal'))}</span>${txLink(p.proposeTx)}</div>`] : []
  if (vi.tx) rows.push(`<div class="lnk"><span>${esc(t('l.report'))}</span>${txLink(vi.tx)}</div>`)
  if (v.phase === 'executed' && p.execute) rows.push(`<div class="lnk"><span>${esc(t('l.execute'))}</span>${txLink(p.execute.tx)}</div>`)
  if (vi.evidence) rows.push(`<div class="lnk wide"><span>${esc(t('l.evidence'))}</span>${hashSpan(vi.evidence, 6)}</div>`)
  patch('v-links', rows.join(''))
}

// ---------- strip of recent proposals ----------
function renderStrip() {
  const showing = RF ? RF.tl.id : store.activeId
  const title = OFFLINE ? t('s.titleOffline') : FORK ? t('s.titleFork') : t('s.title')
  const auto = OFFLINE
    ? `<button data-act="loop" class="toggle${replay.paused ? '' : ' on'}" title="${esc(t('help.loop'))} (P)"><i class="dot"></i>${esc(t('s.loop'))} · ${esc(t(replay.paused ? 's.off' : 's.on'))}</button>`
    : `<button data-act="follow" class="toggle${store.follow ? ' on' : ''}" title="${esc(t('help.follow'))} (F)"><i class="dot"></i>${esc(t('s.follow'))} · ${esc(t(store.follow ? 's.on' : 's.off'))}</button>`
  const ids = store.recentIds().slice().reverse()
  let cards: string
  if (!ids.length) {
    const msg = PENDING ? '' : OFFLINE || chainHealth.loadedRecent ? t('s.none') : t('s.loading')
    cards = `<div class="s-empty">${esc(msg)}</div>`
  } else {
    cards = ids
      .map((id) => {
        const p = store.proposals.get(id)!
        const v = finalView(p)
        const ph = v.phase
        const ident = identOf(p)
        // every card has one rhythm: what it is (rule, or what held), then the verdict with its blocks after the
        // proposal, then where it stands
        let line = ''
        let foot = ''
        const verdictAfter = (k: Key, n: number) => `<b>${esc(t(k))}</b> ${esc(t('s.after', { n }))}`
        if (ph === 'ejected') {
          const r = v.veto?.rule
          line = r ? `<b class="mono">${esc(ruleShort(r))}</b> · ${esc(ruleShortText(r))}` : esc(t(logsPending() ? 'v.loading' : 'v.far'))
          if (v.veto) foot = verdictAfter('s.veto', v.veto.afterBlocks)
        } else if (ph === 'executed' || ph === 'ready' || ph === 'cleared') {
          const byCre = v.clear?.by === 'cre' || (!v.clear && p.guards.cre.verdict === 'pass')
          line = byCre ? esc(t(Number(p.kind) !== 0 ? 's.cfgOk' : 's.allHeld')) : v.clear ? esc(t('c.clearedBy', { who: whoName(v.clear.by) })) : esc(t('ph.cleared'))
          const where = ph === 'executed' ? t('s.executed') : ph === 'cleared' ? t('s.left', { n: v.left }) : t('s.ready')
          foot = (v.clear ? `${verdictAfter('s.clear', v.clear.afterBlocks)} · ` : '') + esc(where)
        } else if (ph === 'chamber') {
          line = esc(t('s.left', { n: v.left }))
          foot = esc(t('s.awaiting'))
        } else if (ph === 'waiting') line = esc(t('s.noClear'))
        // a card being replayed says so in its status chip until the replay reaches its final state
        let chipPh: AirlockPhase = ph
        let chip = esc(t(`ph.${ph}` as Key))
        if (RF?.tl.id === id) {
          const rv = viewOf(RF.p)
          if (rv.phase !== ph) {
            chipPh = rv.phase
            chip = `${I.play}${esc(t('s.replaying'))}`
          }
        }
        const on = showing === id
        // a long name gets a smaller size, so every card keeps a one-line title
        const long = [...ident.name].reduce((w, c) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0) > 16
        return (
          `<button class="pc ph-${chipPh}${on ? ' on' : ''}" data-act="sel:${esc(id)}" aria-pressed="${on}">` +
          `<span class="pc-top"><span class="pc-id">#${esc(id)}</span><span class="pc-chip${chipPh !== ph ? ' rp' : ''}">${chip}</span></span>` +
          `<span class="pc-name${long ? ' long' : ''}">${esc(ident.name)}</span><span class="pc-line">${line}</span><span class="pc-foot">${foot}</span></button>`
        )
      })
      .join('')
  }
  patch(
    'strip',
    `<div class="s-head"><h3>${esc(title)}</h3>${PENDING ? '' : auto}<span class="s-hint">${esc(t('s.hint'))}</span>${tabsHtml()}</div>` +
      `<div class="s-cards" style="--n:${Math.max(ids.length, 1)}">${cards}</div>`,
  )
}

// ---------- details drawer (D) ----------
const row = (k: string, v: string) => `<div class="dr-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`

function costText(tx: string | undefined): string {
  if (!tx) return '<span class="dim">—</span>'
  const c = txCost(store.receipts.get(tx.toLowerCase()))
  if (!c) return `<span class="dim">${esc(t('dr.reading'))}</span>`
  return esc(t('dr.costV', { c: fmtEth(c.costWei), g: num(Number(c.gasUsed)), p: fmtGasPrice(c.priceWei) }))
}

function renderDetails(p: Proposal | null, v: AirlockView) {
  const el = $('details')
  el.classList.toggle('open', ui.details)
  el.setAttribute?.('aria-hidden', String(!ui.details))
  if (!ui.details) return
  const out: string[] = []
  if (p) {
    const vi = verdictOf(p, v)
    const wf = realWorkflowId(vi.workflow)
    const b = (n: number | null | undefined) => (n ? ` · ${esc(t('dr.atBlock', { b: num(n) }))}` : '')
    const vblock = v.veto?.block ?? v.clear?.block
    const rows = [
      row(t('dr.kind'), `#${esc(p.id)} · ${esc(kindText(p.kind))}`),
      row(t('dr.target'), addrLink(p.target, 6) + verifiedChip(p.target)),
      row(t('dr.codehash'), fullHash(p.codehash)),
      row(t('dr.proposer'), addrLink(p.chain?.proposer, 6)),
      row(t('dr.proposed'), txLink(p.proposeTx, 6) + b(p.proposeBlock)),
      row(t('dr.cooldown'), p.proposeBlock && p.readyBlock ? esc(t('dr.cooldownV', { a: num(p.proposeBlock), b: num(p.readyBlock), n: p.readyBlock - p.proposeBlock })) : '—'),
      row(t('dr.verdictTx'), txLink(vi.tx, 6) + b(vblock)),
      row(t('dr.cost'), costText(vi.tx)),
      row(t('dr.evidence'), fullHash(vi.evidence)),
    ]
    if (wf) rows.push(row(t('dr.workflow'), fullHash(wf)))
    if (p.execute) rows.push(row(t('dr.executed'), txLink(p.execute.tx, 6) + b(p.execute.block)))
    out.push(`<section><h4>${esc(t('dr.proposal'))}</h4><dl>${rows.join('')}</dl></section>`)
  }
  if (!PENDING) {
    const d = store.deploy
    out.push(
      `<section><h4>${esc(t('dr.contracts'))}</h4><dl>` +
        row('AirlockAdmin', addrLink(d?.airlockAdmin ?? DATA.airlockAdmin, 6) + verifiedChip(d?.airlockAdmin ?? DATA.airlockAdmin)) +
        row('AirlockReceiver', addrLink(DATA.receiver, 6)) +
        row(t('g.proxy'), addrLink(d?.proxy ?? DATA.proxy, 6)) +
        row('Forwarder', addrLink(DATA.forwarder, 6)) +
        `</dl></section>`,
    )
  }
  let conn: string
  if (OFFLINE) {
    conn =
      row(t('dr.heads'), esc(t('link.offline'))) +
      (RECORDING.source === 'none'
        ? ''
        : row(
            t('dr.recording'),
            esc(t('dr.recordingV', { src: t(RECORDING.source === 'sepolia' ? 'src.sepolia' : 'src.fork'), a: num(RECORDING.deployment.startBlock), b: num(RECORDING.head), d: RECORDING.recordedOn })),
          ))
  } else {
    const heads = blocks.link === 'ws' ? t('link.ws') : blocks.link === 'poll' ? t('link.poll', { s: Math.round(CHAIN.pollMs / 1000) }) : t('link.down')
    const logs = chainHealth.logsLink === 'ws' ? t('link.logsWs') : chainHealth.logsLink === 'poll' ? t('link.logsPoll', { c: chainHealth.cursor ? num(chainHealth.cursor) : '…' }) : t('link.connecting')
    const raw = blocks.blockTimeMs()
    const bt = plausibleBlockMs(raw, CONFIG.minPlausibleBlockMs)
    let host = ''
    try {
      host = blocks.linkUrl ? new URL(blocks.linkUrl).host : ''
    } catch {
      host = ''
    }
    conn =
      row(t('dr.heads'), esc(heads)) +
      row(t('dr.logs'), esc(logs)) +
      row(t('dr.bt'), esc(bt ? t('bt.measured', { s: (bt / 1000).toFixed(1) }) : raw !== null ? t('bt.fast') : t('bt.measuring'))) +
      (host ? row(t('dr.endpoint'), `<span class="mono">${esc(host)}</span>`) : '')
  }
  out.push(`<section><h4>${esc(t('dr.conn'))}</h4><dl>${conn}</dl></section>`)
  const lines = store.stream.slice(-14).reverse()
  out.push(
    `<section><h4>${esc(t('dr.stream'))}</h4><div class="dr-stream">` +
      (lines.length
        ? lines
            .map((l) => {
              const d = new Date(l.ts)
              // venue time (UTC+8) whatever the laptop's time zone is
              const ts = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false })
              return `<div class="ln ${l.level}"><span class="ln-t">${ts}</span><span class="ln-m">${esc(tm(l.msg))}</span></div>`
            })
            .join('')
        : `<div class="dim">${esc(t('dr.noStream'))}</div>`) +
      `</div></section>`,
  )
  out.push(`<section><h4>${esc(t('dr.about'))}</h4><p class="dr-about">${esc(t('dr.aboutBody'))}</p></section>`)
  patch('details', `<div class="dr-head"><h3>${esc(t('dr.title'))}</h3><button data-act="close" class="btn">${esc(t('dr.close'))}</button></div><div class="dr-body">${out.join('')}</div>`)
}

// ---------- help overlay (?) ----------
const HELP_TEXT: Record<Action, Key> = {
  prev: 'help.prev',
  next: 'help.next',
  newest: 'help.newest',
  replay: 'help.replay',
  follow: 'help.follow',
  loop: 'help.loop',
  details: 'help.details',
  lang: 'help.lang',
  help: 'help.help',
  lab: 'help.lab',
  operator: 'help.operator',
  close: 'help.esc',
}
function renderHelp() {
  const el = $('help')
  el.classList.toggle('open', ui.help)
  el.setAttribute?.('aria-hidden', String(!ui.help))
  if (!ui.help) return
  // the operator key is listed only where operator mode is on for this browser
  const rows = HELP_ROWS.filter((r) => r.action !== 'operator' || opVisible()).map((r) => {
    const keys = r.keys.map((k) => `<kbd>${esc(k === 'Space' ? t('help.space') : k)}</kbd>`).join('')
    const what = r.action === 'prev' ? `${t('help.prev')} / ${t('help.next')}` : t(HELP_TEXT[r.action])
    return `<div class="hp-row"><span class="hp-k">${keys}</span><span class="hp-v">${esc(what)}</span></div>`
  }).join('')
  patch(
    'help',
    `<div class="hp-card" role="dialog" aria-label="${esc(t('help.title'))}"><h3>${esc(t('help.title'))}</h3><div class="hp-rows">${rows}</div>` +
      `<div class="hp-url"><b>${esc(t('help.url'))}</b><span class="mono">${esc(t('help.urlBody'))}</span></div><p class="hp-foot">${esc(t('help.foot'))}</p></div>`,
  )
}

export function render() {
  const now = Date.now()
  RF = replayFrame(now)
  // first visit before its replay: a neutral intro, not the newest proposal's final state. The operator's launch on
  // its way into a block: shown as pending (auto-follow), not the previous proposal's final state
  const pend = !RF && store.follow ? pendingLaunch(store.proposals.values(), now) : null
  const intro = !RF && !pend && labIntro(now)
  const p = RF ? RF.p : intro || pend ? null : store.active
  const v = viewOf(p)
  track(p?.id ?? null, v.phase, now)
  renderBar()
  renderHero(p, v, now, intro, pend)
  renderVerdict(p, v, now, intro, pend)
  renderStrip()
  renderLab(now)
  renderDetails(p, v)
  renderHelp()
  renderOperator(now)
}
