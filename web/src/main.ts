import './style.css'
import { startTitle } from './airlock'
import { blocks } from './chain'
import { PENDING } from './chaindata'
import { startChainWatch } from './chainwatch'
import { keyAction, labIndexOfKey, stepId, type Action } from './controls'
import { setManualPick } from './events'
import { cycleLang, initLang } from './i18n'
import { isLabId, lab, LAB_IDS, noteInteraction, playLab, tickLab } from './lab'
import { checkVerified } from './lookup'
import { startOffline } from './offline'
import { forgetToken, launchCard, loadOperator, mayOperate, op, opVisible, saveToken, takeTokenFromUrl, TOKEN_RE } from './operator-client'
import { historyIn, replay, replayFrame, replayProposal, tickReplay, toggleReplay } from './playback'
import { FORK, OFFLINE, PICK } from './runtime'
import { store } from './store'
import { mountSkeleton, render, STAGE_QUERY, ui } from './ui'

// first of all: an operator token given as ?op=<token> leaves the address bar before anything else runs
takeTokenFromUrl()
initLang()
startTitle()
mountSkeleton()

let dirty = true
const mark = () => {
  dirty = true
}
store.onChange(mark)
blocks.onChange(mark)
let lastFrame = 0
/** Space pressed before that proposal's history was read: it plays as soon as it is in */
let spaceWaiting: string | null = null
function frame() {
  lastFrame = performance.now()
  if (spaceWaiting && historyIn(spaceWaiting)) {
    const id = spaceWaiting
    spaceWaiting = null
    if (shownId() === id) replayProposal(id)
  }
  if (tickLab()) dirty = true
  if (tickReplay()) dirty = true
  if (dirty) {
    dirty = false
    if (!OFFLINE) {
      // Sourcify badges in the details drawer (live Sepolia only; no-op on a fork)
      checkVerified(store.deploy?.airlockAdmin)
      const t = store.active?.target
      if (t) checkVerified(t)
    }
    render()
  }
}
function loop() {
  frame()
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
// the cooldown clock ticks between blocks and playback moves with time: redraw a few times per second. When the
// browser holds back animation frames (a background tab, a headless capture), the timer draws instead.
setInterval(() => {
  mark()
  if (performance.now() - lastFrame > 400) frame()
}, 250)

// ?p=<id>: open on that proposal (live: stay on it; offline: the replay loop starts with it)
if (PICK) {
  if (OFFLINE) replay.startAt(PICK)
  else {
    store.activeId = PICK
    setManualPick(true)
  }
}

if (OFFLINE) startOffline()
else if (!PENDING) {
  blocks.start()
  startChainWatch()
} else blocks.start()

// operator mode exists only where the operator API answers (never offline, never on a local fork: that screen is not
// Ethereum Sepolia). The API is asked only where this browser can be the operator (a loopback host, a saved token or
// ?op=1): a public visitor never calls it, and a static deploy logs no 404.
if (!OFFLINE && !FORK && !PENDING && mayOperate(globalThis.location?.hostname)) void loadOperator().then(() => store.emit())

/** The proposal on screen: the one being replayed, else the selected one */
const shownId = (): string | null => replayFrame()?.tl.id ?? store.activeId

/** The viewer picked a proposal: stop playback and stay on it (a new live proposal still takes over with auto-follow) */
function selectProposal(id: string | null) {
  if (!id || !store.proposals.has(id)) return
  replay.stop(Date.now(), id)
  store.activeId = id
  setManualPick(id !== store.newestId())
  lab.card = null
  lab.pid = null
  store.emit()
}

/** A launch was sent: auto-follow on, any replay stops, the screen goes to the newest real proposal, and the live
 *  war room takes over as soon as the new proposal lands */
function followLive() {
  // the first-visit replay must not take the screen from the operator's real launch
  noteInteraction()
  store.follow = true
  replay.stop(Date.now())
  setManualPick(false)
  lab.card = null
  lab.pid = null
  const n = store.newestId()
  if (n) store.activeId = n
  op.panel = false
  store.emit()
}

/** Phone or narrow window: after a card is picked, bring the airlock into view if it is mostly off screen */
function showHero() {
  try {
    if (window.matchMedia(STAGE_QUERY).matches) return
    const r = document.querySelector('.hero')?.getBoundingClientRect()
    if (r && (r.top > window.innerHeight * 0.5 || r.bottom < 120)) document.querySelector('.hero')!.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch {
    /* no layout */
  }
}

/** Actions that pick what is on screen: the first-visit replay does not start after one of them */
const PICKS = new Set(['sel', 'prev', 'next', 'newest', 'replay', 'follow', 'loop'])

function act(a: Action | string, arg?: string) {
  if (PICKS.has(a)) noteInteraction()
  switch (a) {
    case 'lab': {
      const id = isLabId(arg) ? arg : LAB_IDS[Number(arg)]
      if (id && playLab(id)) showHero()
      break
    }
    case 'tab':
      lab.tab = arg === 'recent' ? 'recent' : 'lab'
      break
    case 'operator':
      if (opVisible()) {
        op.panel = !op.panel
        op.confirm = null
      }
      break
    case 'opask':
      if (opVisible() && isLabId(arg) && op.info.cards.includes(arg)) {
        op.panel = true
        op.confirm = arg
      }
      break
    case 'opno':
      op.confirm = null
      break
    case 'opgo':
      if (isLabId(arg) && op.confirm === arg) {
        noteInteraction()
        void launchCard(arg, store.proposals.values(), followLive).then(() => store.emit())
      }
      break
    case 'opclose':
      op.panel = false
      op.confirm = null
      break
    case 'opout':
      forgetToken()
      break
    case 'optoast':
      op.toastHidden = true
      break
    case 'optokenno':
      op.prompt = false
      break
    case 'sel':
      selectProposal(arg ?? null)
      break
    case 'prev':
    case 'next':
      selectProposal(stepId(store.recentIds(), shownId(), a === 'prev' ? -1 : 1))
      break
    case 'newest':
      selectProposal(store.newestId())
      break
    case 'replay': {
      lab.card = null
      lab.pid = null
      const id = shownId()
      // the page is still reading this proposal's history: play it the moment it is in
      if (!replayProposal(id) && id && store.proposals.has(id) && !historyIn(id)) spaceWaiting = id
      break
    }
    case 'follow':
      if (OFFLINE) toggleReplay()
      else {
        store.follow = !store.follow
        // turning it on jumps to the newest proposal right away
        if (store.follow) selectProposal(store.newestId())
      }
      break
    case 'loop':
      toggleReplay()
      break
    case 'details':
      ui.details = !ui.details
      ui.help = false
      break
    case 'lang':
      cycleLang()
      break
    case 'help':
      ui.help = !ui.help
      break
    case 'close':
      ui.details = false
      ui.help = false
      // Esc steps back out of the operator panel: first the confirm step, then the panel, then the token prompt
      if (op.confirm) op.confirm = null
      else if (op.panel) op.panel = false
      op.prompt = false
      break
  }
  mark()
}

document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-act]')
  if (!el) {
    // a click on the dimmed backdrop closes the help
    if (ui.help && (ev.target as HTMLElement | null)?.id === 'help') act('close')
    return
  }
  const [a, arg] = el.dataset.act!.split(':')
  act(a, arg)
})

// the operator token prompt (?op=1): the token goes to this browser's storage only, never into the page or the URL
document.addEventListener('submit', (ev) => {
  const form = ev.target as HTMLFormElement | null
  if (form?.dataset?.form !== 'optoken') return
  ev.preventDefault()
  const input = form.elements.namedItem('token') as HTMLInputElement | null
  const v = (input?.value ?? '').trim()
  if (input) input.value = ''
  if (TOKEN_RE.test(v) && saveToken(v)) {
    op.prompt = false
    op.promptBad = false
  } else op.promptBad = true
  mark()
})

document.addEventListener('keydown', (ev) => {
  const t = ev.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  const a = keyAction(ev.key, { ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey })
  if (!a) return
  // Enter on a focused button or link activates it (keyboard access); Space always replays, even after a click
  if (ev.key === 'Enter' && t && /^(BUTTON|A)$/.test(t.tagName)) return
  ev.preventDefault()
  if (a === 'lab') {
    noteInteraction()
    act('lab', String(labIndexOfKey(ev.key)))
  } else act(a)
})
