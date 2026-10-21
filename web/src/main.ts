import './style.css'
import { startTitle } from './airlock'
import { blocks } from './chain'
import { PENDING } from './chaindata'
import { startChainWatch } from './chainwatch'
import { keyAction, stepId, type Action } from './controls'
import { setManualPick } from './events'
import { cycleLang, initLang } from './i18n'
import { checkVerified } from './lookup'
import { startOffline } from './offline'
import { replay, replayFrame, replayProposal, tickReplay, toggleReplay } from './playback'
import { OFFLINE, PICK } from './runtime'
import { store } from './store'
import { mountSkeleton, render, ui } from './ui'

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
function frame() {
  lastFrame = performance.now()
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

/** The proposal on screen: the one being replayed, else the selected one */
const shownId = (): string | null => replayFrame()?.tl.id ?? store.activeId

/** The viewer picked a proposal: stop playback and stay on it (a new live proposal still takes over with auto-follow) */
function selectProposal(id: string | null) {
  if (!id || !store.proposals.has(id)) return
  replay.stop(Date.now(), id)
  store.activeId = id
  setManualPick(id !== store.newestId())
  store.emit()
}

function act(a: Action | 'sel', arg?: string) {
  switch (a) {
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
    case 'replay':
      replayProposal(shownId())
      break
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
  act(a as Action | 'sel', arg)
})

document.addEventListener('keydown', (ev) => {
  const t = ev.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  const a = keyAction(ev.key, { ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey })
  if (!a) return
  // Enter on a focused button or link activates it (keyboard access); Space always replays, even after a click
  if (ev.key === 'Enter' && t && /^(BUTTON|A)$/.test(t.tagName)) return
  ev.preventDefault()
  act(a)
})
