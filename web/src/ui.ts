// The war room: a 1280x720 stage scaled to the window (layout.ts switches to a scrolling stack on narrow screens).
// Each block rewrites its innerHTML only when its content changed. Every word on screen goes through i18n.t().
import { airlockView, fmtDur, type AirlockView } from './airlock'
import { blocks } from './chain'
import { DATA, PENDING, RECORDING } from './chaindata'
import { chainHealth } from './chainwatch'
import { CONFIG } from './config'
import { blockFontPx, explorerUrl, fmtEth, fmtGasPrice, plausibleBlockMs, txCost } from './derive'
import { blockTs } from './events'
import { cardDesc, cycleLang, kindText, lang, LANG_LABEL, LANGS, onLangChange, ruleText, t, tm } from './i18n'
import { replay, replayFrame } from './playback'
import type { ReplayFrame } from './replay'
import { CHAIN, FORK, GUARDS, OFFLINE, type GuardId } from './runtime'
import { short, store, type Proposal } from './store'
import { CARDS, ruleShort, type CardInfo } from './types'

const $ = (id: string) => document.getElementById(id)!

/** During playback the airlock, guards and metrics show the virtual block; live, the chain head */
let RF: ReplayFrame | null = null
const curBlock = () => (RF ? RF.vblock : blocks.latest)
const prev = new Map<string, string>()
function patch(id: string, html: string): boolean {
  if (prev.get(id) === html) return false
  prev.set(id, html)
  $(id).innerHTML = html
  return true
}

/** When a panel's content is taller than the panel, scale its inner .fit down (CSS zoom, not below min). A safety
 *  net only: normal copy fits the 1280x720 stage. */
function autoFit(boxId: string, min = 0.85) {
  const box = $(boxId)
  const inner = box.querySelector<HTMLElement>(':scope > .fit')
  if (!inner) return
  inner.style.removeProperty('zoom')
  const cs = getComputedStyle(box)
  const avail = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  const need = inner.offsetHeight
  if (need <= avail + 0.5) return
  inner.style.setProperty('zoom', String(Math.max(min, Math.floor((avail / need) * 1000) / 1000)))
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Numbers that are not live Sepolia are labelled: a local fork, or the recording */
const tagText = () => (OFFLINE ? t('tag.recorded') : FORK ? t('tag.fork') : '')
const tag = () => (tagText() ? `<span class="loc">${tagText()}</span>` : '')

function linkTo(base: string | null, v: string | undefined | null, n: number): string {
  if (!v) return '—'
  const url = explorerUrl(base, v)
  if (url) return `<a class="mono xl" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(v)}">${esc(short(v, n))}<span class="xl-i">↗</span></a>`
  return `<span class="mono" title="${esc(v)}">${esc(short(v, n))}</span>`
}
const txLink = (h: string | undefined | null, n = 6) => linkTo(CHAIN.explorerTx, h, n)
const addrLink = (a: string | undefined | null, n = 6) => linkTo(CHAIN.explorerAddr, a, n)
const hashSpan = (h: string | undefined | null, n = 6) => (h ? `<span class="mono" title="${esc(h)}">${esc(short(h, n))}</span>` : '—')

/** Sourcify badge (live Sepolia only), shown after a confirmed match */
function verifyChip(addr: string | undefined | null): string {
  if (!addr || !CHAIN.sourcifyApi) return ''
  return store.verified.get(addr.toLowerCase()) === 'yes' ? `<span class="vchip yes" title="Sourcify match">${t('chip.verified')}</span>` : ''
}

export function mountSkeleton() {
  $('app').innerHTML = `
  <div id="stage">
    <header id="top">
      <div class="top-left">
        <div class="badge-row"><span id="badge"></span><span id="ga" class="ga"></span></div>
        <div id="ttl" class="title"></div>
        <div id="link" class="link"></div>
      </div>
      <div id="toolbar" class="toolbar"></div>
      <div class="top-right">
        <div class="blk-meta"><span class="blk-label"><span id="blk-l"></span> <span id="blk-tag"></span></span><span id="bt" class="bt"></span></div>
        <div id="blk" class="blk">—</div>
      </div>
    </header>
    <main>
      <section id="airlock" class="panel">
        <div class="fit">
          <h2 id="h-al"></h2>
          <div id="al-sum"></div>
          <div id="al-lock"></div>
          <div id="al-out"></div>
        </div>
      </section>
      <section id="guards" class="panel">
        <h2 id="h-g"></h2>
        ${GUARDS.map((g) => `<div id="g-${g}" class="scard"></div>`).join('')}
      </section>
    </main>
    <section id="metrics"></section>
    <section id="stream"></section>
    <div id="ov-evidence" class="dock hidden"></div>
  </div>`
  fitStage()
  window.addEventListener('resize', fitStage)
  // language button: handled here (not through data-act); the main loop redraws on store.emit()
  document.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement | null)?.closest?.('[data-lang]')) cycleLang()
  })
  onLangChange(() => store.emit())
}

function fitStage() {
  const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720)
  const el = $('stage')
  el.style.transform = `scale(${s})`
  el.style.left = `${Math.max(0, (window.innerWidth - 1280 * s) / 2)}px`
  el.style.top = `${Math.max(0, (window.innerHeight - 720 * s) / 2)}px`
}

// ---------- headings (change with the language and the playback pill only) ----------
function renderStatic() {
  patch('ttl', t('title'))
  patch('blk-l', OFFLINE ? t('blk.offline') : t('blk.label'))
  const pill = RF ? ` <span class="rp-pill">${t('rp.pill', { id: esc(RF.tl.id), b: RF.tl.proposeBlock.toLocaleString('en-US') })}${RF.paused ? t('rp.paused') : ''}</span>` : ''
  patch('h-al', `<span class="ico">◫</span> ${t('al.h')}${pill || ` <small>${t('al.hSub')}</small>`}`)
  patch('h-g', `<span class="ico">⛨</span> ${t('g.h')} <small>${t('g.sub')}</small>`)
}

function langButton(): string {
  const cur = lang()
  const parts = LANGS.map((l) => (l === cur ? `<b>${LANG_LABEL[l]}</b>` : `<span style="opacity:.45">${LANG_LABEL[l]}</span>`)).join(' / ')
  return `<button data-lang="next" title="${esc(t('tb.langTitle'))}">${parts}</button>`
}

function replayButton(): string {
  const full = replay.paused ? t('rp.resumeFull') : t('rp.pauseFull')
  const title = OFFLINE ? t('rp.btnTitleOffline') : t('rp.btnTitle')
  return `<button data-act="replay" class="rp-btn${replay.paused ? ' paused' : ''}" title="${esc(`${full} · ${title}`)}" aria-label="${esc(full)}">${replay.paused ? t('rp.resume') : t('rp.pause')}</button>`
}

/** Cooldown in blocks: the deployment, else the default */
const delayBlocks = () => store.deploy?.delayBlocks ?? DATA.delayBlocks ?? CONFIG.delayBlocks
const tsOf = (n: number) => blockTs.get(n)
/** Live, a log can arrive before its block header: never draw a proposal as if it were before its own block */
const viewOf = (p: Proposal | null, cur = curBlock()): AirlockView => airlockView(p, RF ? cur : Math.max(cur, p?.proposeBlock ?? 0), tsOf)

function recentChips(): string {
  const shown = RF ? RF.tl.id : store.activeId
  return store
    .recentIds()
    .map((id) => {
      const p = store.proposals.get(id)!
      // chips show the proposal's state now (the chain head), not the playback's virtual block
      const ph = viewOf(p, OFFLINE ? (RECORDING.head || curBlock()) : blocks.latest).phase
      const cls = ph === 'ejected' ? 'bad' : ph === 'executed' || ph === 'ready' || ph === 'cleared' ? 'good' : ph === 'waiting' ? 'warn' : ''
      return `<button data-act="sel:${esc(id)}" class="${shown === id ? 'on' : ''}"><b class="${cls}">#${esc(id)}</b> ${esc(t(`ph.${ph}`))}</button>`
    })
    .join('')
}

/** Top-right box width (style.css #top third column) and the largest block-number size */
const BLK_WIDTH = 396
const BLK_MAX_PX = 84
function renderTop() {
  patch(
    'badge',
    OFFLINE
      ? `<span class="badge offline">⟲ ${esc(t('badge.offline'))}</span>`
      : `<span class="badge live airlock">● ${esc(t(FORK ? 'badge.fork' : 'badge.live'))}</span>`,
  )
  const admin = store.deploy?.airlockAdmin ?? DATA.airlockAdmin
  patch('ga', PENDING ? '' : `<span class="ga-l" title="AirlockAdmin">${t('ga.label')} ${verifyChip(admin)}</span><span class="ga-a">${addrLink(admin, 6)}</span>`)
  let link: string
  if (OFFLINE) {
    link = RECORDING.source === 'none' ? t('link.offlineEmpty') : t('link.offline', { src: t(RECORDING.source === 'sepolia' ? 'src.sepolia' : 'src.fork'), d: RECORDING.recordedOn })
  } else {
    const heads = blocks.link === 'ws' ? t('link.ws') : blocks.link === 'poll' ? t('link.poll', { s: Math.round(CHAIN.pollMs / 1000) }) : t('link.down')
    const logs = chainHealth.logsLink === 'ws' ? t('link.logsWs') : chainHealth.logsLink === 'poll' ? t('link.logsPoll', { c: chainHealth.cursor || '…' }) : t('link.connecting')
    link = t('link.live', { heads, logs })
  }
  patch('link', esc(link))
  const head = OFFLINE ? (RF ? RF.vblock : RECORDING.head) : blocks.latest
  const blkText = head ? `#${head.toLocaleString('en-US')}` : '—'
  if (prev.get('blk') !== blkText) $('blk').style.fontSize = `${blockFontPx(blkText, BLK_WIDTH, BLK_MAX_PX)}px`
  patch('blk', blkText)
  patch('blk-tag', `${tag()}${RF && !OFFLINE ? `<span class="rp-vb">${t('rp.vblock', { b: RF.vblock.toLocaleString('en-US') })}</span>` : ''}`)
  if (OFFLINE) patch('bt', t('bt.offline', { s: (CONFIG.replay.msPerBlock / 1000).toFixed(1) }))
  else {
    const raw = blocks.blockTimeMs()
    const bt = plausibleBlockMs(raw, CONFIG.minPlausibleBlockMs)
    patch('bt', bt ? t('bt.measured', { s: (bt / 1000).toFixed(1) }) : raw !== null ? t('bt.fast') : t('bt.measuring'))
  }
  const n = delayBlocks()
  const recent = store.recentIds().length
    ? recentChips()
    : PENDING
      ? ''
      : `<span class="tb-recent">${OFFLINE || chainHealth.loadedRecent ? t('tb.noProposals') : t('tb.loadingRecent')}</span>`
  patch(
    'toolbar',
    `<span class="ro ar-lede">${OFFLINE ? t('tb.ledeOffline') : FORK ? t('tb.ledeFork') : t('tb.lede')}</span>` +
      `<div class="atk-row"><span class="al-flow">${t('tb.flow', { n, t: fmtDur(n * CONFIG.blockSec) })}</span></div>` +
      `<span class="hint ar-hint"><button data-act="evidence">${t('tb.evidence')}</button>${replayButton()}${langButton()}${recent}</span>`,
  )
}

// ---------- the airlock ----------
function cardOf(p: Proposal): CardInfo | null {
  const id = p.card ?? store.implNames.get(p.target.toLowerCase())
  return CARDS.find((c) => c.id === id) ?? null
}

const guardName = (g: string) => (g === 'cre' ? t('who.cre') : g === 'breakglass' ? t('who.human') : g === 'approver' ? t('who.approver') : t('who.someone'))

/** "24 s (block timestamps)" or "~ 36 s (12 s/block)" */
const secText = (x: { afterSec: number; secFromTs: boolean }) =>
  x.secFromTs ? t('al.secTs', { t: fmtDur(x.afterSec) }) : t('al.secEst', { t: fmtDur(x.afterSec), s: CONFIG.blockSec })

function door(kind: 'outer' | 'inner', value: string, sub: string, state: string): string {
  return `<div class="al-door ${kind} ${state}"><div class="al-dl">${t(kind === 'outer' ? 'al.outer' : 'al.inner')}</div><div class="al-dv">${value}</div><div class="al-ds">${sub}</div></div>`
}

/** outer door | chamber (cooldown progress and the capsule) | inner door */
function lockHtml(p: Proposal | null, v: AirlockView): string {
  const ph = v.phase
  const outer = !p || !p.proposeBlock || ph === 'idle' ? door('outer', t('al.closed'), '', 'off') : door('outer', t('al.proposed'), t('al.atBlock', { b: p.proposeBlock }), 'on')
  const rb = p?.readyBlock
  const inner =
    ph === 'executed'
      ? door('inner', t('al.executed'), p?.execute?.block ? t('al.atBlock', { b: p.execute.block }) : '', 'good')
      : ph === 'ejected'
        ? door('inner', t('al.sealed'), t('al.sealedSub'), 'bad')
        : ph === 'ready'
          ? door('inner', t('al.innerReady'), t('al.innerReadySub'), 'good')
          : ph === 'cleared'
            ? door('inner', t('al.innerCleared'), rb ? t('al.opensAt', { b: rb }) : '', 'cleared')
            : ph === 'waiting'
              ? door('inner', t('al.locked'), t('al.innerWaitSub'), 'warn')
              : door('inner', t('al.locked'), ph === 'idle' ? '' : t('al.innerLockedSub'), 'off')
  let cv: string
  let cs: string
  switch (ph) {
    case 'idle':
      cv = t('al.cEmpty')
      cs = t('al.cEmptySub')
      break
    case 'chamber':
      cv = t('al.left', { n: v.left })
      cs = t('al.leftSub', { t: fmtDur(v.leftSec), s: CONFIG.blockSec })
      break
    case 'cleared':
      cv = t('al.left', { n: v.left })
      cs = t('al.leftCleared', { who: esc(guardName(v.clear?.by ?? 'cre')), t: fmtDur(v.leftSec) })
      break
    case 'waiting':
      cv = t('al.waiting')
      cs = t('al.waitingSub', { rb: p?.readyBlock ?? '?' })
      break
    case 'ready':
      cv = t('al.full')
      cs = t('al.fullSub', { n: v.total })
      break
    case 'ejected':
      cv = t('al.ejected')
      cs = v.veto ? t('al.ejectedSub', { k: v.veto.afterBlocks }) : t('al.ejectedFar')
      break
    default:
      cv = t('al.passedC')
      cs = t('al.passedCSub', { n: v.total })
  }
  const c = p ? cardOf(p) : null
  const x = ph === 'executed' ? 100 : v.pct
  const cap =
    ph === 'idle' || !p
      ? ''
      : `<div class="al-track"><div class="al-cap ${ph}" style="--x:${x}" title="${esc(p.target)}"><span class="al-cap-i">${ph === 'ejected' ? '⏏' : ph === 'cleared' || ph === 'ready' || ph === 'executed' ? '✓' : '⬢'}</span> ${esc(c ? c.name : t('al.capsule'))}</div></div>`
  return `<div class="al-lock ph-${ph}">${outer}<div class="al-ch"><div class="al-cl">${t('al.chamber')}</div><div class="al-cv">${cv} ${tag()}</div><div class="al-cs">${cs}</div><div class="prog"><i style="width:${v.pct}%"></i></div>${cap}</div>${inner}</div>`
}

/** "cleared by Chainlink CRE N blocks after the proposal · tx" + "evidence hash · workflow" */
function clearLines(v: AirlockView): string {
  const c = v.clear
  if (!c) return v.cleared ? `<div class="al-os">${t('al.clearFar')}</div>` : ''
  const wf = c.workflowId ? ` · workflow ${hashSpan(c.workflowId, 4)}` : ''
  return `<div class="al-os">${t('al.clearAfter', { n: c.afterBlocks, t: secText(c) })} · ${t('al.clearTx', { tx: txLink(c.tx, 4) })} ${tag()}</div><div class="al-os dim">${t('al.evidence', { h: hashSpan(c.evidenceHash, 6) })}${wf}</div>`
}

function outHtml(p: Proposal, v: AirlockView): string {
  const clearHead = (key: 'al.outCleared' | 'al.outReady') => t(key, { who: esc(guardName(v.clear?.by ?? 'cre')) })
  switch (v.phase) {
    case 'ejected': {
      const x = v.veto
      if (!x) return `<div class="al-out bad"><div class="al-oh">${t('al.outEject', { who: t('who.someone') })}</div><div class="al-os">${t('al.outEjectFar')}</div></div>`
      const r = x.rule ?? '?'
      const ev = x.evidenceHash
        ? `${t('al.evidence', { h: hashSpan(x.evidenceHash, 6) })}${x.workflowId ? ` · workflow ${hashSpan(x.workflowId, 4)}` : ''}`
        : `ruleHash ${hashSpan(x.ruleHash, 6)}`
      return `<div class="al-out bad"><div class="al-oh">${t('al.outEject', { who: esc(guardName(x.by)) })} <b class="mono">${esc(ruleShort(r))}</b> ${esc(ruleText(r))}</div><div class="al-os">${t('al.outEjectAfter', { n: x.afterBlocks, t: secText(x) })} · ${t('al.vetoTx', { tx: txLink(x.tx, 4) })} ${tag()}</div><div class="al-os dim">${ev}</div></div>`
    }
    case 'executed':
      return `<div class="al-out good"><div class="al-oh">${t('al.outExec')}</div><div class="al-os">${p.execute ? t('al.outExecSub', { tx: txLink(p.execute.tx, 4), b: p.execute.block }) : t('al.outExecFar')}${v.clear ? ` · ${t('al.clearTx', { tx: txLink(v.clear.tx, 4) })}` : ''} ${tag()}</div><div class="al-os dim">${v.clear ? t('al.evidence', { h: hashSpan(v.clear.evidenceHash, 6) }) : ''}</div></div>`
    case 'ready':
      return `<div class="al-out good"><div class="al-oh">${clearHead('al.outReady')}</div>${clearLines(v)}</div>`
    case 'cleared':
      return `<div class="al-out ok"><div class="al-oh">${clearHead('al.outCleared')}</div>${clearLines(v)}</div>`
    case 'waiting':
      return `<div class="al-out warn"><div class="al-oh">${t('al.outWaiting')}</div><div class="al-os">${t('al.outWaitingSub', { id: esc(p.id) })}</div><div class="al-os dim">${t('al.outWaitingHint')}</div></div>`
    case 'idle':
      return ''
    default:
      return `<div class="al-out wait"><div class="al-oh">${t('al.outWait')}</div><div class="al-os">${t('al.outWaitSub')}</div></div>`
  }
}

function renderAirlock(p: Proposal | null) {
  const v = viewOf(p)
  if (!p) {
    const n = delayBlocks()
    const head = PENDING ? (OFFLINE ? t('al.noRecording') : t('al.pending')) : OFFLINE || chainHealth.loadedRecent ? t('al.empty') : t('al.loading')
    patch('al-sum', `<div class="al-empty"><div class="al-eh">${head}</div><div class="al-es">${t('al.emptySub', { n, t: fmtDur(n * CONFIG.blockSec) })}</div></div>`)
    patch('al-lock', lockHtml(null, v))
    patch('al-out', '')
    return
  }
  const c = cardOf(p)
  patch(
    'al-sum',
    `<div class="al-sum">
      <div class="pc-title">${t('pc.title', { id: esc(p.id), kind: esc(kindText(p.kind)) })}${p.dropped ? ` <span class="bad">${t('pc.dropped')}</span>` : ''} <span class="chainst ph-${v.phase}">${esc(t(`ph.${v.phase}`))}</span></div>
      <div class="pc-row">${t('pc.newImpl')} ${addrLink(p.target, 6)}${c ? ` <b>${esc(c.name)}</b> <span class="dim">${esc(cardDesc(c.id))}</span>` : ''} ${verifyChip(p.target)}</div>
      <div class="pc-row dim">${t('pc.proposeTx')} ${txLink(p.proposeTx, 4)} · ${t('pc.blocks', { a: p.proposeBlock ?? '?', b: p.readyBlock ?? '?' })}</div>
    </div>`,
  )
  patch('al-lock', lockHtml(p, v))
  patch('al-out', outHtml(p, v))
}

let airlockKey = ''
/** Re-measure the panel only when one of its blocks changed (no forced layout every frame) */
function airlockDirty(): boolean {
  const k = ['h-al', 'al-sum', 'al-lock', 'al-out'].map((id) => prev.get(id) ?? '').join('\u0000')
  if (k === airlockKey) return false
  airlockKey = k
  return true
}

// ---------- guard cards: Chainlink CRE (AirlockReceiver) and the human emergency guardian ----------
function renderGuard(g: GuardId, p: Proposal | null) {
  const a = p?.guards[g]
  const v = viewOf(p)
  const cre = g === 'cre'
  const addr = cre ? DATA.receiver : DATA.emergencyGuardian
  const head = cre
    ? `<b>Chainlink CRE</b> <span class="chip cre">DON</span> <span class="chip on">${t('g.roles')}</span> <span class="dim">AirlockReceiver ${PENDING ? '' : addrLink(addr, 4)}</span>`
    : `<b>${t('who.human')}</b> <span class="chip human">${t('g.humanChip')}</span> <span class="chip on">guardian</span> <span class="dim">${PENDING ? '' : addrLink(addr, 4)}</span>`
  const vetoed = a?.verdict === 'veto'
  const passed = cre && a?.verdict === 'pass'
  const pipe = cre
    ? `<div class="g-pipe${vetoed ? ' done veto' : passed ? ' done' : ''}">${[1, 2, 3, 4].map((i) => `<span>${t(`g.p${i}` as never)}</span>`).join('<i>→</i>')}<i>→</i><span>${t(vetoed ? 'g.p5veto' : passed ? 'g.p5clear' : 'g.p5')}</span></div>`
    : ''
  let verdict = `<span class="dim">${cre ? t('g.creStandby') : t('g.noAction')}</span>`
  let lines = ''
  if (p && a) {
    const after = (b: number | undefined) => (b && p.proposeBlock ? t('g.after', { n: b - p.proposeBlock }) : '')
    if (vetoed) {
      const r = a.rule ?? '?'
      verdict = `<span class="bad">${cre ? t('g.veto') : t('g.humanVeto')}</span> <b>${esc(ruleShort(r))}</b> ${esc(ruleText(r))}`
      lines = `<div class="barlabel">${t('g.vetoLine', { tx: txLink(a.tx, 4), b: a.block ?? '?', after: after(a.block) })} ${tag()}</div>`
      if (cre && a.evidenceHash) lines += `<div class="barlabel">${t('g.evid', { h: hashSpan(a.evidenceHash, 4), w: hashSpan(a.workflowId, 4) })}</div>`
    } else if (passed) {
      verdict = `<span class="good">${t('g.clear')}</span> ${t('g.clearSub')}`
      lines = `<div class="barlabel">${t('g.clearLine', { tx: txLink(a.tx, 4), b: a.block ?? '?', after: after(a.block) })} ${tag()}</div>`
      // the CRE's own evidence; clearanceOf keeps the first clearer's hash, which is the approver's after a hand clear
      const h = v.clear?.by === 'cre' ? v.clear.evidenceHash : (a.evidenceHash ?? v.clear?.evidenceHash)
      if (h) lines += `<div class="barlabel">${t('g.evid', { h: hashSpan(h, 4), w: hashSpan(a.workflowId, 4) })}</div>`
    } else if (v.phase === 'ejected') {
      // vetoed by the other guard; without the veto log (out of reach) neither card can say who it was
      verdict = `<span class="dim">${!v.veto ? t('g.vetoFar') : cre ? t('g.creOther') : t('g.humanNotNeeded')}</span>`
    } else if (cre && (v.phase === 'chamber' || v.phase === 'waiting')) {
      verdict = `<span class="warn">${v.phase === 'waiting' ? t('g.creLate') : t('g.creJudging')}</span>`
    } else if (cre && v.cleared) {
      // cleared without a CRE verdict (the approver by hand): the sweeper still judges it until it executes, and a
      // CRE veto wins over the clearance
      verdict = v.phase === 'executed' ? `<span class="dim">${t('g.creSkipped')}</span>` : `<span class="warn">${t('g.creRejudge')}</span>`
    } else if (!cre && v.clear?.by === 'approver') {
      verdict = `<span class="good">${t('g.approverCleared')}</span>`
      lines = `<div class="barlabel">${t('g.clearLine', { tx: txLink(v.clear.tx, 4), b: v.clear.block, after: after(v.clear.block) })} ${tag()}</div>`
    } else if (!cre) {
      verdict = `<span class="dim">${v.phase === 'executed' || v.phase === 'ready' ? t('g.noVeto') : t('g.noAction')}</span>`
    }
  }
  patch(
    `g-${g}`,
    `<div class="scard-in g-${g}${vetoed ? ' vetoed' : passed ? ' passed' : ''}">
      <div class="s-head">${head}</div>
      <div class="g-sub">${t(cre ? 'g.creSub' : 'g.humanSub')}</div>
      ${pipe}
      <div class="s-verdict">${verdict}</div>
      <div class="s-veto">${lines}</div>
    </div>`,
  )
}

// ---------- big numbers, all read from the chain (or the recording) ----------
function costTile(label: string, tx: string | undefined): string {
  const c = txCost(tx ? store.receipts.get(tx.toLowerCase()) : undefined)
  const value = c ? fmtEth(c.costWei) : '—'
  const sub = c ? t(FORK || OFFLINE ? 'm.costSLocal' : 'm.costS', { g: c.gasUsed.toLocaleString('en-US'), p: fmtGasPrice(c.priceWei) }) : tx ? t('m.readingReceipt') : t('m.noTx')
  return `<div class="tile"><div class="t-l">${label}</div><div class="t-v">${esc(value)} ${tag()}</div><div class="t-s">${sub}</div></div>`
}

function renderMetrics(p: Proposal | null) {
  if (!p) {
    patch('metrics', `<div class="m-empty">${t('m.empty')}</div>`)
    return
  }
  const v = viewOf(p)
  const bs = CONFIG.blockSec
  if (v.phase === 'idle') {
    patch('metrics', `<div class="m-empty">${t('m.empty')}</div>`)
    return
  }
  if (v.phase === 'ejected') {
    const x = v.veto
    if (!x) {
      patch('metrics', `<div class="m-empty">${t('m.vetoedFar')}</div>`)
      return
    }
    const src = x.secFromTs ? t('m.srcTs') : t('m.srcEst', { s: bs })
    patch(
      'metrics',
      `<div class="tile bad"><div class="t-l">${t('m.vetoTook', { who: esc(guardName(x.by)) })}</div><div class="t-v">${t('m.blocksSec', { n: x.afterBlocks, t: fmtDur(x.afterSec) })} ${tag()}</div><div class="t-s">${t('m.vetoTookS', { b: x.block, src, votes: p.chain?.vetoCount ?? 1 })}</div></div>
       <div class="tile"><div class="t-l">${t('m.toInner')}</div><div class="t-v">${t('m.blocks', { n: x.toInner })} ${tag()}</div><div class="t-s">${t('m.toInnerS', { t: fmtDur(x.toInner * bs) })}</div></div>
       ${costTile(t('m.vetoCost'), x.tx)}`,
    )
    return
  }
  if (v.phase === 'chamber') {
    patch('metrics', `<div class="m-empty">${t('m.cooling', { n: v.left, t: fmtDur(v.leftSec) })} ${tag()}</div>`)
    return
  }
  if (v.phase === 'waiting') {
    patch('metrics', `<div class="m-empty warn">${t('m.waiting', { id: esc(p.id) })} ${tag()}</div>`)
    return
  }
  // cleared / ready / executed
  const c = v.clear
  const first = c
    ? `<div class="tile good"><div class="t-l">${t('m.clearTook', { who: esc(guardName(c.by)) })}</div><div class="t-v">${t('m.blocksSec', { n: c.afterBlocks, t: fmtDur(c.afterSec) })} ${tag()}</div><div class="t-s">${t('m.clearTookS', { b: c.block, src: c.secFromTs ? t('m.srcTs') : t('m.srcEst', { s: bs }) })}</div></div>`
    : `<div class="tile good"><div class="t-l">${t('m.clearTook', { who: t('who.someone') })}</div><div class="t-v">${t('m.clearedFar')}</div></div>`
  const door =
    v.phase === 'executed'
      ? `<div class="tile good"><div class="t-l">${t('m.inner')}</div><div class="t-v">${t('m.innerOpen')} ${tag()}</div><div class="t-s">${p.execute ? t('m.innerOpenS', { b: p.execute.block }) : ''}</div></div>`
      : v.phase === 'ready'
        ? `<div class="tile good"><div class="t-l">${t('m.inner')}</div><div class="t-v">${t('m.innerReady')} ${tag()}</div><div class="t-s">${t('m.innerReadyS', { b: p.readyBlock ?? '?' })}</div></div>`
        : `<div class="tile"><div class="t-l">${t('m.inner')}</div><div class="t-v">${t('m.blocks', { n: v.left })} ${tag()}</div><div class="t-s">${t('m.innerLeftS', { b: p.readyBlock ?? '?', t: fmtDur(v.leftSec) })}</div></div>`
  patch('metrics', first + door + costTile(t('m.clearCost'), c?.tx))
}

// ---------- event stream ----------
function renderStream(p: Proposal | null, docked: boolean) {
  const lines = store.stream.slice(-4)
  const v = p ? viewOf(p) : null
  const ev = v?.veto?.evidenceHash ?? v?.clear?.evidenceHash
  const chip = !docked && p && ev ? `<span class="st-chip">${t('st.chip', { id: esc(p.id), hash: `<span class="mono">${esc(short(ev, 4))}</span>` })}</span>` : ''
  $('stream').classList.toggle('docked', docked)
  patch(
    'stream',
    `<div class="st-title">${t('st.title')} <small>${OFFLINE ? t('st.subOffline') : t('st.sub')}</small>${chip}</div><div class="st-lines">` +
      lines
        .map((l) => {
          const d = new Date(l.ts)
          // venue time (UTC+8) whatever the laptop's time zone is
          const ts = `${d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
          const ico = l.level === 'bad' ? '✕' : l.level === 'good' ? '✓' : l.level === 'warn' ? '!' : '·'
          const rp = l.replay ? `<span class="rp-tag">${t('rp.prefix')}</span>` : ''
          return `<div class="ln ${l.level}${l.replay ? ' rp' : ''}"><span class="t">${ts}</span><span class="src">${esc(t('st.src'))}</span><span class="ico">${ico}</span>${rp}${esc(tm(l.msg))}</div>`
        })
        .join('') +
      '</div>',
  )
}

// ---------- evidence dock (R) ----------
export const ui = { evidenceOpen: false }

function renderEvidence(p: Proposal | null) {
  const el = $('ov-evidence')
  el.classList.toggle('hidden', !ui.evidenceOpen)
  if (!ui.evidenceOpen) return
  const close = `<button data-act="close-evidence" title="${esc(t('r.closeTitle'))}">✕</button>`
  const v = p ? viewOf(p) : null
  const veto = v?.veto ?? null
  const clear = veto ? null : (v?.clear ?? null)
  const hash = veto?.evidenceHash ?? clear?.evidenceHash
  const verdict = veto ? `<b class="bad">Veto</b> ${esc(veto.rule ?? '—')}` : clear ? `<b class="good">Clear</b>` : '—'
  const tx = veto?.tx ?? clear?.tx
  const wf = veto?.workflowId ?? clear?.workflowId
  patch(
    'ov-evidence',
    `<div class="r-head">${t('r.title')}${p ? ` · #${esc(p.id)}` : ''}<span class="r-note">${t('r.note')}</span>${close}</div>
     <div class="r-body"><div>${hash ? t('r.body') : v?.phase === 'ejected' ? t('r.humanVeto') : t('r.none')}</div></div>
     <div class="r-foot"><span>${t('r.verdict')} ${verdict}</span><span>${t('r.evid')} ${hashSpan(hash, 8)}</span><span>workflow ${hashSpan(wf, 4)}</span><span>tx ${txLink(tx, 4)}</span></div>`,
  )
}

export function render() {
  const now = Date.now()
  RF = replayFrame(now)
  const p = RF ? RF.p : store.active
  renderStatic()
  renderTop()
  renderAirlock(p)
  if (airlockDirty()) autoFit('airlock')
  for (const g of GUARDS) renderGuard(g, p)
  renderMetrics(p)
  renderStream(p, ui.evidenceOpen)
  renderEvidence(p)
}
