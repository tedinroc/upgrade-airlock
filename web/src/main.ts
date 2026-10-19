import './style.css'
import { startTitle } from './airlock'
import { blocks } from './chain'
import { PENDING } from './chaindata'
import { startChainWatch } from './chainwatch'
import { setManualPick } from './events'
import { cycleLang, initLang } from './i18n'
import { checkVerified } from './lookup'
import { startOffline } from './offline'
import { replay, tickReplay, toggleReplay } from './playback'
import { OFFLINE } from './runtime'
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
function loop() {
  if (tickReplay()) dirty = true
  if (dirty) {
    dirty = false
    if (!OFFLINE) {
      // Sourcify badges (live Sepolia only; no-op on a fork)
      checkVerified(store.deploy?.airlockAdmin)
      const t = store.active?.target
      if (t) checkVerified(t)
    }
    render()
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
// cooldown seconds and playback move with time: redraw a few times per second
setInterval(mark, 250)

if (OFFLINE) startOffline()
else if (!PENDING) {
  blocks.start()
  startChainWatch()
} else blocks.start()

/** The viewer picked a proposal from the recent list: stop playback and stay on it until a new proposal arrives */
function selectProposal(id: string) {
  if (!store.proposals.has(id)) return
  replay.stop(Date.now(), id)
  store.activeId = id
  const newest = Math.max(...[...store.proposals.keys()].map(Number))
  setManualPick(Number(id) !== newest)
  store.emit()
}

function act(a: string) {
  if (a === 'replay') toggleReplay()
  else if (a.startsWith('sel:')) selectProposal(a.slice(4))
  else if (a === 'evidence') ui.evidenceOpen = !ui.evidenceOpen
  else if (a === 'close-evidence') ui.evidenceOpen = false
  mark()
}

document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (btn) act(btn.dataset.act!)
})

document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return
  const k = ev.key.toLowerCase()
  if (k === 'r') act('evidence')
  else if (k === 'p') act('replay')
  else if (k === 'l') cycleLang()
  else if (k === 'escape') act('close-evidence')
})
