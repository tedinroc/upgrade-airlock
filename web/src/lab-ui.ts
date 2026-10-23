// What lab.ts (the attack picker) and operator-client.ts (operator mode) draw:
//
//   #lab       the picker: a title that says what to do, seven attack cards, and while a card plays, which real
//              Sepolia proposal it is (#id, date, the proposal tx). Stage screens show it in the bottom row, with a
//              tab to the strip of recent proposals; phones show it right under the top bar, as a row of cards to
//              swipe. Never drawn with ?clean=1.
//   #op        the operator's launch panel (O, or the bolt button in the top bar): the seven cards, each with
//              "Launch on Sepolia" and a confirm step
//   #op-toast  where the operator's last launch stands: sending, tx sent (Etherscan link), on chain, the verdict
//   #op-token  the token prompt (?op=1)
// Nothing operator-related is drawn unless operator-client.ts says operator mode is on for this browser.
//
// The playing card's progress bar rides on a CSS variable (--lab-f on #lab), so a frame does not rewrite the cards.
import { CONFIG } from './config'
import { fmtDur } from './airlock'
import { blockTs } from './events'
import { labLine, labName, t, type Key } from './i18n'
import { fmtDay, lab, LAB_CARDS, labCard, labPlaying, pickNow, type LabId, type LabStage } from './lab'
import { launchBusy, launchStage, op, opVisible, type Launch, type LaunchError } from './operator-client'
import { playbackGate } from './playback'
import { CLEAN, OFFLINE } from './runtime'
import { store, type Proposal } from './store'
import { CARDS, ruleShort } from './types'
import { $, esc, I, patch, txLink } from './view'

/** How long the operator's status toast stays after the verdict landed, and after an error */
const TOAST_DONE_MS = 30_000
const TOAST_ERROR_MS = 20_000
const NOTICE_MS = 10_000

const STAGE_ICON: Record<LabStage, string> = { arrive: I.play, judge: '<i class="spin"></i>', veto: I.x, clear: I.check, fast: I.ff, exec: I.check }

/** The two tabs of the bottom row (stage screens only; CSS hides them on a phone, where both are shown) */
export function tabsHtml(): string {
  if (CLEAN) return ''
  const b = (id: 'lab' | 'recent', k: Key) => `<button data-act="tab:${id}" class="${lab.tab === id ? 'on' : ''}" role="tab" aria-selected="${lab.tab === id}">${esc(t(k))}</button>`
  return `<div class="seg tabs" role="tablist" title="${esc(t('lab.tabsTitle'))}">${b('lab', 'lab.tabLab')}${b('recent', 'lab.tabRecent')}</div>`
}

/** The day a proposal was made (venue time), once its block timestamp is read */
export const dayOf = (p: Proposal | null | undefined) => (p?.proposeBlock ? fmtDay(blockTs.get(p.proposeBlock)) : null)

/** The replay label of a proposal as HTML: "Replay · a real Sepolia proposal · 2026-10-20" (the date once its block
 *  is read; kept on one line, so a narrow tag never splits it at its hyphens) */
export function replayLabel(p: Proposal | null | undefined): string {
  const d = dayOf(p)
  return esc(t('h.replayReal')) + (d ? ` · <span class="nw">${esc(d)}</span>` : '')
}

const codeOf = (id: LabId) => {
  const c = labCard(id)
  return c.rule ? `<span class="lc-code veto">${esc(ruleShort(c.rule))}</span>` : `<span class="lc-code clear">${I.check}${esc(t('v.clear'))}</span>`
}

// ---------- the picker ----------
export function renderLab(now: number) {
  const stage = $('stage')
  stage.classList.toggle('tab-recent', lab.tab === 'recent')
  stage.classList.toggle('no-lab', CLEAN)
  if (CLEAN) {
    patch('lab', '')
    return
  }
  const playing = labPlaying(now)
  $('lab').style.setProperty('--lab-f', playing ? playing.f.toFixed(4) : '0')
  const showOp = opVisible()
  const busy = showOp && launchBusy(store.proposals.values(), now)
  const cards = LAB_CARDS.map((c, i) => {
    const pick = pickNow(c.id)
    const live = OFFLINE ? null : pick.live
    const p = live ?? pick.replay
    const on = playing?.id === c.id
    const nudge = lab.invite && lab.invite !== c.id ? ' nudge' : ''
    const ref = live
      ? `<span class="lc-live"><i class="dot"></i>${esc(t('lab.live'))} #${esc(live.id)}</span>`
      : p
        ? `<span class="lc-ref mono">#${esc(p.id)}</span>`
        : ''
    let foot: string
    if (on && playing) {
      const steps = playing.stages
        .map((s) => `<i class="${s === playing.stage ? 'cur' : playing.stages.indexOf(s) < playing.stages.indexOf(playing.stage) ? 'done' : ''}"></i>`)
        .join('')
      foot = `<span class="lc-prog" aria-hidden="true"><i></i></span><span class="lc-stage st-${playing.stage}">${STAGE_ICON[playing.stage]}<span>${esc(t(`lab.st.${playing.stage}` as Key))}</span><span class="lc-steps">${steps}</span></span>`
    } else if (live) foot = `<span class="lc-cta live">${esc(t('lab.liveFoot'))}</span>`
    else if (p) foot = `<span class="lc-cta">${lab.played.has(c.id) ? I.again : I.play}${esc(t(lab.played.has(c.id) ? 'lab.again' : 'lab.play'))}</span>`
    else foot = `<span class="lc-cta dim">${esc(t(playbackGate.ready || OFFLINE ? 'lab.none' : 'lab.loading'))}</span>`
    const opBtn =
      showOp && op.info.cards.includes(c.id)
        ? `<button class="lc-op" data-act="opask:${c.id}"${busy ? ' disabled' : ''} title="${esc(t('op.launch'))}">${I.bolt}<span>${esc(t('op.launchShort'))}</span></button>`
        : ''
    return (
      `<div class="lc ${c.rule ? 'k-veto' : 'k-clear'}${on ? ' on' : ''}${live ? ' live' : ''}${p ? '' : ' none'}${opBtn ? ' has-op' : ''}${nudge}" style="--i:${i}" role="listitem">` +
      `<button class="lc-main" data-act="lab:${c.id}" aria-pressed="${on}"${p ? '' : ' disabled'}>` +
      `<span class="lc-top">${codeOf(c.id)}${ref}</span>` +
      `<span class="lc-name">${esc(labName(c.id))}</span>` +
      `<span class="lc-line">${esc(labLine(c.id))}</span>` +
      `<span class="lc-foot">${foot}</span></button>${opBtn}</div>`
    )
  }).join('')

  let now2 = ''
  if (playing) {
    const src = store.proposals.get(playing.pid)
    const d = dayOf(src)
    now2 =
      `<span class="lab-now"><span class="tag replay">${I.play}${esc(t('lab.now', { id: playing.pid }))}${d ? ` · ${esc(d)}` : ''}</span>` +
      (src?.proposeTx ? `<span class="lab-tx"><span>${esc(t('lab.proposalTx'))}</span>${txLink(src.proposeTx, 4)}</span>` : '') +
      `</span>`
  }
  const title = lab.invite ? t('lab.invite', { name: labName(lab.invite) }) : t('lab.title')
  // phone: the cards are a row to swipe; rewriting the region must not throw the row back to its first card
  const keep = rowScroll()
  const drawn = patch(
    'lab',
    `<div class="lab-head${playing ? ' playing' : ''}"><div class="lab-t"><h3 class="${lab.invite ? 'invite' : ''}">${esc(title)}</h3><span class="lab-sub">${esc(t('lab.sub'))}</span></div>${now2}${tabsHtml()}</div>` +
      `<div class="lab-cards" role="list">${cards}</div>`,
  )
  if (drawn && keep > 0) setRowScroll(keep)
  revealPlaying(playing ? `${playing.id}:${playing.pid}` : null)
}

const labRow = (): HTMLElement | null => {
  try {
    return ($('lab').querySelector?.('.lab-cards') as HTMLElement | null) ?? null
  } catch {
    return null
  }
}
function rowScroll(): number {
  return labRow()?.scrollLeft ?? 0
}
function setRowScroll(x: number) {
  const row = labRow()
  if (row) row.scrollLeft = x
}

/** Phone: the cards are a row to swipe; when a card starts playing (a tap, a key, the first-visit replay), the row
 *  scrolls it to the middle so the viewer sees which attack is on screen */
let revealed: string | null = null
function revealPlaying(key: string | null) {
  if (key === revealed) return
  revealed = key
  if (!key) return
  try {
    const row = labRow()
    const card = row?.querySelector('.lc.on') as HTMLElement | null
    if (!row || !card || row.scrollWidth <= row.clientWidth + 4) return
    const delta = card.getBoundingClientRect().left - row.getBoundingClientRect().left - (row.clientWidth - card.offsetWidth) / 2
    // instant: the row is redrawn every few frames while a card plays, and a redraw keeps the row's scroll position,
    // which would stop a smooth scroll halfway (the playing card then stayed off screen)
    row.scrollLeft = Math.max(0, row.scrollLeft + delta)
  } catch {
    /* no layout (tests) */
  }
}

// ---------- operator mode ----------
/** The bolt button in the top bar (operator only) */
export function opBarButton(): string {
  if (!opVisible()) return ''
  return `<button data-act="operator" class="btn opb${op.panel ? ' on' : ''}" title="${esc(t('op.title'))} (O)" aria-expanded="${op.panel}">${I.bolt}<span class="opb-t">${esc(t('op.btn'))}</span></button>`
}

const whoVeto = (p: Proposal) => (p.guards.cre.verdict === 'veto' ? t('who.cre') : p.guards.breakglass.verdict === 'veto' ? t('who.human') : '')
const vetoRule = (p: Proposal) => p.guards.cre.rule ?? p.guards.breakglass.rule ?? null
const whoClear = (p: Proposal) => (p.clearance?.by === 'approver' ? t('who.approver') : p.clearance?.by === 'other' ? t('who.someone') : t('who.cre'))

const ERR_KEY: Record<LaunchError, Key> = {
  'unknown card': 'op.errCard',
  unauthorized: 'op.errAuth',
  disabled: 'op.errDisabled',
  forbidden: 'op.errForbidden',
  cooldown: 'op.errCooldownAny',
  reverted: 'op.errReverted',
  misconfigured: 'op.errMisconfigured',
  rpc: 'op.errRpc',
  server: 'op.errServer',
  unclear: 'op.errUnclear',
  network: 'op.errNet',
}
/** What a refused launch says on screen: one fixed sentence per API answer (never the server's own words) */
export function launchErrorText(l: Pick<Launch, 'error' | 'retryAfterBlocks'>): string {
  if (l.error === 'cooldown' && l.retryAfterBlocks) return t('op.errCooldown', { n: l.retryAfterBlocks, t: fmtDur(l.retryAfterBlocks * CONFIG.blockSec) })
  return t(ERR_KEY[l.error ?? 'network'])
}

/** One line on where a launch stands (panel and toast) */
function launchLine(l: Launch, now: number): { cls: string; html: string; final: boolean } {
  const { stage, p } = launchStage(l, store.proposals.values(), now)
  const name = `<b>${esc(labName(l.card))}</b>`
  const tx = l.txHash ? `<span class="op-tx">${txLink(l.txHash, 4)}</span>` : ''
  const spin = '<i class="spin"></i>'
  switch (stage) {
    case 'sending':
      return { cls: 'run', html: `${spin}${name}<span>${esc(t('op.sending'))}</span>`, final: false }
    case 'sent':
      return { cls: 'run', html: `${spin}${name}<span>${esc(t('op.sent'))}</span>${tx}`, final: false }
    case 'slow':
      return { cls: 'warn', html: `${I.clock}${name}<span>${esc(t('op.slow'))}</span>${tx}`, final: true }
    case 'onchain':
      return { cls: 'run', html: `${spin}${name}<span>${esc(t('op.onchain', { id: p!.id }))}</span>${tx}`, final: false }
    case 'veto': {
      const r = vetoRule(p!)
      const who = whoVeto(p!)
      return { cls: 'bad', html: `${I.x}${name}<span>${esc(t('op.veto', { id: p!.id, who, rule: r ? `${who ? ' · ' : ''}${ruleShort(r)}` : '' }))}</span>${tx}`, final: true }
    }
    case 'clear':
      return { cls: 'good', html: `${I.check}${name}<span>${esc(t('op.clear', { id: p!.id, who: whoClear(p!) }))}</span>${tx}`, final: true }
    case 'exec':
      return { cls: 'good', html: `${I.check}${name}<span>${esc(t('op.exec', { id: p!.id }))}</span>${tx}`, final: true }
    default:
      return { cls: 'warn', html: `${I.x}${name}<span>${esc(launchErrorText(l))}</span>`, final: true }
  }
}

const implText = (id: LabId): string => {
  const c = labCard(id)
  if (c.fn === 'proposeSetGuardian') return 'proposeSetGuardian(AirlockReceiver, false)'
  return `proposeUpgrade(${CARDS.find((x) => x.id === c.impl)?.name ?? c.impl})`
}

/** The confirm step last drawn (a new one is scrolled into view) */
let shownAsk: LabId | null = null

export function renderOperator(now: number) {
  const vis = opVisible()
  // the panel
  const panel = $('op')
  const open = vis && op.panel
  panel.classList.toggle('open', open)
  panel.setAttribute?.('aria-hidden', String(!open))
  if (!open) patch('op', '')
  else {
    const busy = launchBusy(store.proposals.values(), now)
    const rows = op.info.cards
      .map((id) => {
        const c = labCard(id)
        const expect = c.rule ? t('op.expectVeto', { rule: ruleShort(c.rule) }) : t('op.expectClear')
        const what = `<div class="op-what">${codeOf(id)}<b>${esc(labName(id))}</b><small class="mono">${esc(implText(id))}</small><small>${esc(expect)}</small></div>`
        const act =
          op.confirm === id
            ? `<div class="op-ask"><p><b>${esc(t('op.confirmQ', { name: labName(id) }))}</b> ${esc(t('op.confirmBody', { fn: c.fn }))}</p>` +
              `<div class="op-btns"><button data-act="opgo:${id}" class="btn danger"${busy ? ' disabled' : ''}>${I.bolt}${esc(t('op.confirm'))}</button><button data-act="opno" class="btn">${esc(t('op.cancel'))}</button></div></div>`
            : `<button data-act="opask:${id}" class="btn go"${busy ? ` disabled title="${esc(t('op.busy'))}"` : ''}>${I.bolt}${esc(t('op.launch'))}</button>`
        return `<div class="op-row${op.confirm === id ? ' ask' : ''}">${what}${act}</div>`
      })
      .join('')
    const st = op.launch ? launchLine(op.launch, now) : null
    const foot = [t(op.info.auth === 'none' ? 'op.authNone' : 'op.authToken'), ...(op.info.cooldownBlocks > 0 ? [t('op.gap', { n: op.info.cooldownBlocks })] : [])].join(' · ')
    // a phone scrolls the panel: a redraw keeps the scroll, and a new confirm step is brought into view
    const card = () => (panel.querySelector?.('.op-card') as HTMLElement | null) ?? null
    const keep = card()?.scrollTop ?? 0
    const drawn = patch(
      'op',
      `<div class="op-card" role="dialog" aria-modal="true" aria-label="${esc(t('op.title'))}">` +
        `<div class="op-head"><span class="op-badge">${I.bolt}${esc(t('op.badge'))}</span><h3>${esc(t('op.title'))}</h3><button data-act="opclose" class="btn">${esc(t('op.close'))}</button></div>` +
        `<p class="op-note">${esc(t('op.note'))}</p>` +
        (st ? `<div class="op-status ${st.cls}">${st.html}</div>` : '') +
        `<div class="op-list">${rows}</div>` +
        `<div class="op-foot"><span>${esc(foot)}</span>${op.info.auth === 'token' ? `<button data-act="opout" class="lnkbtn">${esc(t('op.signOut'))}</button>` : ''}</div>` +
        `</div>`,
    )
    if (drawn) {
      try {
        const c = card()
        if (c && keep) c.scrollTop = keep
        if (op.confirm && op.confirm !== shownAsk) (c?.querySelector('.op-row.ask') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' })
      } catch {
        /* no layout (tests) */
      }
    }
  }
  shownAsk = open ? op.confirm : null

  // the status toast: the last launch while the panel is closed, or the "token rejected" notice
  let toast = ''
  if (op.notice) {
    if (now - op.noticeAt > NOTICE_MS) op.notice = null
    else toast = `<div class="op-status warn">${I.x}<span>${esc(t(op.notice === 'auth' ? 'op.errAuth' : 'op.errDisabled'))}</span></div>`
  } else if (vis && op.launch && !op.panel && !op.toastHidden && !CLEAN) {
    // (never over a ?clean=1 recording: the war room itself shows the launch)
    const st = launchLine(op.launch, now)
    if (st.final && !op.launch.doneAt) op.launch.doneAt = now
    const gone = op.launch.state === 'error' ? now - op.launch.at > TOAST_ERROR_MS : !!op.launch.doneAt && now - op.launch.doneAt > TOAST_DONE_MS
    if (!gone) toast = `<div class="op-status ${st.cls}">${st.html}<button data-act="optoast" class="op-x" aria-label="${esc(t('op.close'))}">${I.x}</button></div>`
  }
  patch('op-toast', toast)

  // the token prompt (?op=1)
  const tok = $('op-token')
  const ask = op.prompt && op.loaded && op.info.enabled && op.info.auth === 'token' && !op.token
  tok.classList.toggle('open', ask)
  tok.setAttribute?.('aria-hidden', String(!ask))
  const drawn = patch(
    'op-token',
    ask
      ? `<form class="op-card op-tok" data-form="optoken" autocomplete="off"><h3>${esc(t('op.tokenTitle'))}</h3><p class="op-note">${esc(t('op.tokenBody'))}</p>` +
          `<input class="op-input" name="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${esc(t('op.tokenTitle'))}">` +
          (op.promptBad ? `<p class="op-bad">${esc(t('op.tokenBad'))}</p>` : '') +
          `<div class="op-btns"><button type="submit" class="btn primary">${esc(t('op.tokenSave'))}</button><button type="button" data-act="optokenno" class="btn">${esc(t('op.cancel'))}</button></div></form>`
      : '',
  )
  if (drawn && ask) (tok.querySelector?.('input') as HTMLInputElement | null)?.focus?.()
}
