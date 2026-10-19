// Offline mode (?mode=offline): plays back src/recorded-run.json (scripts/record-run.mjs) for a venue whose network
// fails. Nothing here opens a connection: the logs, block timestamps, receipts and final proposal states were all
// recorded, and they go through the same log handler as the live page.
import { blocks } from './chain'
import { RECORDING } from './chaindata'
import { blockTs, handleLog, loadImplNames, pickActive, resetSeen, type LogHooks } from './events'
import { msg } from './i18n'
import { playbackGate } from './playback'
import { store } from './store'
import { isZero32 } from './types'

const NO_NETWORK: LogHooks = { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} }

/** Load the recording into the store; returns the number of proposals */
export function loadRecording(): number {
  const R = RECORDING
  const d = R.deployment
  store.deploy = { airlockAdmin: d.airlockAdmin, proxy: d.proxy, delayBlocks: d.delayBlocks, chainId: d.chainId }
  loadImplNames()
  for (const [n, t] of Object.entries(R.blocks)) blockTs.set(Number(n), t)
  for (const [tx, r] of Object.entries(R.receipts))
    store.receipts.set(tx.toLowerCase(), { status: r.status === 'success' ? 'success' : 'reverted', gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice })
  resetSeen()
  const logs = [...R.logs].sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16))
  for (const l of logs) handleLog(l, false, NO_NETWORK)
  for (const [id, cp] of Object.entries(R.proposals)) {
    if (!cp.status) continue
    const p = store.ensure(id)
    p.chain = { status: cp.status, vetoCount: cp.vetoCount, proposer: cp.proposer, clearanceOf: isZero32(cp.clearanceOf) ? null : cp.clearanceOf }
    p.proposeBlock = p.proposeBlock ?? cp.proposedBlock
    p.readyBlock = p.readyBlock ?? cp.readyBlock
    if (!p.target) p.target = cp.target
  }
  pickActive()
  // the load itself is not news: the playback writes its own lines as it goes
  store.stream = []
  const n = Object.keys(R.proposals).length
  store.logT('chain', 'load', msg('off.loaded', { n, d: R.recordedOn || '—' }), 'info')
  return n
}

export function startOffline() {
  loadRecording()
  blocks.setOffline(RECORDING.head)
  playbackGate.ready = true
  store.emit()
}
