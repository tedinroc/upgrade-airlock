// Live mode: the browser reads Ethereum Sepolia (or a local fork via ?rpc=) directly.
//  - WS subscription to the logs of AirlockAdmin + AirlockReceiver (block headers come from chain.ts);
//  - an eth_getLogs cursor fills gaps whether or not the WS is up (each call <= CHAIN.logRange blocks);
//  - on page open the newest proposals are loaded with getProposal + clearanceOf, and each one's logs are read
//    from its proposal block on (CHAIN.historySpan blocks), so the page has content before anything happens live;
//  - verdict cost = receipt gasUsed x effectiveGasPrice; "N seconds after the proposal" uses block timestamps.
// Only eth_call / eth_getLogs / eth_getTransactionReceipt / eth_getBlockByNumber: nothing is signed or sent.
import { decodeFunctionResult, encodeFunctionData, numberToHex, pad, toEventSelector, type Hex } from 'viem'
import { ADMIN_ABI, RECEIVER_ABI } from './abi'
import { blocks, rpc } from './chain'
import { DATA, type RawLog } from './chaindata'
import { CONFIG } from './config'
import { blockTs, handleLog, loadImplNames, pickActive, type LogHooks } from './events'
import { msg } from './i18n'
import { playbackGate, replay } from './playback'
import { CHAIN } from './runtime'
import { store } from './store'
import { isZero32 } from './types'

const ADMIN = DATA.airlockAdmin as Hex
const RX = DATA.receiver as Hex
const ADDRS: Hex[] = [ADMIN, RX]
const ADMIN_EVENTS = ['Proposed', 'Vetoed', 'Cleared', 'Executed', 'ReasonAttached'] as const
const topicOf = (abi: readonly unknown[], name: string): Hex =>
  toEventSelector((abi as readonly { type: string; name?: string }[]).find((x) => x.type === 'event' && x.name === name) as never)
/** topic0 of every log the page reads (one getLogs call covers both contracts) */
export const TOPICS: Hex[] = [...ADMIN_EVENTS.map((e) => topicOf(ADMIN_ABI, e)), topicOf(RECEIVER_ABI, 'Verdict')]

/** Health of the log feed (top bar) */
export const chainHealth = { logsLink: 'down' as 'ws' | 'poll' | 'down', cursor: 0, lastError: '', loadedRecent: false }

// ---------- HTTP JSON-RPC: rotate endpoints, 8 s timeout, up to 4 tries ----------
let httpIdx = 0
async function call<T>(method: string, params: unknown[], tries = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    const url = CHAIN.http[httpIdx % CHAIN.http.length]
    try {
      return await rpc<T>(url, method, params, 8000)
    } catch (e) {
      last = e
      httpIdx++
      chainHealth.lastError = `${method}: ${(e as Error).message}`
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

async function readAdmin<T>(functionName: 'getProposal' | 'clearanceOf' | 'nextId', args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: ADMIN_ABI, functionName, args } as never)
  const ret = await call<Hex>('eth_call', [{ to: ADMIN, data }, 'latest'])
  return decodeFunctionResult({ abi: ADMIN_ABI, functionName, data: ret } as never) as T
}

interface ChainProposal {
  kind: number
  status: number
  proposer: string
  target: string
  codehash: string
  proposedBlock: bigint
  readyBlock: bigint
  vetoCount: bigint
}

// ---------- block timestamps and receipts (background reads; the page redraws when they land) ----------
const tsBusy = new Set<number>()
function wantBlockTs(n: number | null | undefined) {
  if (!n || blockTs.has(n) || tsBusy.has(n)) return
  tsBusy.add(n)
  call<{ timestamp?: Hex } | null>('eth_getBlockByNumber', [numberToHex(n), false])
    .then((b) => {
      if (b?.timestamp) {
        blockTs.set(n, parseInt(b.timestamp, 16))
        store.emit()
      }
    })
    .catch(() => {
      /* the page falls back to "about N s at 12 s/block" */
    })
    .finally(() => setTimeout(() => tsBusy.delete(n), 5000))
}

const receiptBusy = new Set<string>()
function wantReceipt(tx: string) {
  const key = tx.toLowerCase()
  if (store.receipts.has(key) || receiptBusy.has(key)) return
  receiptBusy.add(key)
  call<{ status: Hex; gasUsed: Hex; effectiveGasPrice?: Hex } | null>('eth_getTransactionReceipt', [tx])
    .then((r) => {
      if (!r) throw new Error('no receipt yet')
      store.receipts.set(key, {
        status: r.status === '0x1' ? 'success' : 'reverted',
        gasUsed: BigInt(r.gasUsed).toString(),
        effectiveGasPrice: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice).toString() : undefined,
      })
      store.emit()
      receiptBusy.delete(key)
    })
    .catch(() => setTimeout(() => receiptBusy.delete(key), 3000))
}

// ---------- getProposal + clearanceOf ----------
function applyProposal(id: string, cp: ChainProposal, clearance: string | null) {
  const p = store.ensure(id)
  p.kind = String(cp.kind)
  p.target = cp.target
  p.codehash = cp.codehash
  p.proposeBlock = Number(cp.proposedBlock)
  p.readyBlock = Number(cp.readyBlock)
  p.chain = { status: Number(cp.status), vetoCount: Number(cp.vetoCount), proposer: cp.proposer, clearanceOf: clearance && !isZero32(clearance) ? clearance : null }
  const name = store.implNames.get(cp.target.toLowerCase())
  if (name && name !== 'v1' && name !== 'paused') p.card = name
  wantBlockTs(p.proposeBlock)
}

const refreshBusy = new Set<string>()
const refreshAgain = new Set<string>()
async function refreshProposal(id: string) {
  if (refreshBusy.has(id)) {
    refreshAgain.add(id)
    return
  }
  refreshBusy.add(id)
  try {
    const [cp, cl] = await Promise.all([readAdmin<ChainProposal>('getProposal', [BigInt(id)]), readAdmin<Hex>('clearanceOf', [BigInt(id)])])
    if (Number(cp.status) !== 0) {
      applyProposal(id, cp, cl)
      pickActive()
      store.emit()
    }
  } catch {
    /* the next event or poll reads it again */
  } finally {
    refreshBusy.delete(id)
    if (refreshAgain.delete(id)) void refreshProposal(id)
  }
}

export const liveHooks: LogHooks = {
  wantReceipt,
  wantBlockTs,
  refresh: (id) => void refreshProposal(id),
  // a live event always wins over playback; playback may start again after CONFIG.replay.idleMs
  onLive: (ts) => replay.onLive(ts),
}

// ---------- eth_getLogs cursor ----------
async function getLogs(from: number, to: number, idTopic?: Hex): Promise<RawLog[]> {
  const topics: unknown[] = [TOPICS]
  if (idTopic) topics.push(idTopic)
  return call<RawLog[]>('eth_getLogs', [{ address: ADDRS, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics }])
}

/** A block span as several getLogs calls of at most CHAIN.logRange blocks, in block order */
async function getLogsSpan(from: number, to: number, idTopic?: Hex): Promise<RawLog[]> {
  const out: RawLog[] = []
  for (let a = from; a <= to; a += CHAIN.logRange) out.push(...(await getLogs(a, Math.min(to, a + CHAIN.logRange - 1), idTopic)))
  return out
}

let polling = false
async function pollLogs() {
  if (polling) return
  polling = true
  try {
    const head = blocks.latest || parseInt(await call<Hex>('eth_blockNumber', []), 16)
    if (!chainHealth.cursor) chainHealth.cursor = head
    // at most 5 ranges per round, so a tab left in the background does not hammer the endpoint
    for (let k = 0; k < 5 && chainHealth.cursor < head; k++) {
      const from = chainHealth.cursor + 1
      const to = Math.min(head, from + CHAIN.logRange - 1)
      for (const l of await getLogs(from, to)) handleLog(l, true, liveHooks)
      chainHealth.cursor = to
    }
    if (chainHealth.logsLink !== 'ws') chainHealth.logsLink = 'poll'
  } catch {
    if (chainHealth.logsLink !== 'ws') chainHealth.logsLink = 'down'
  } finally {
    polling = false
  }
}

// ---------- WS logs subscription ----------
let wsIdx = 0
function openLogsWs() {
  if (CHAIN.ws.length === 0) return
  const url = CHAIN.ws[wsIdx % CHAIN.ws.length]
  let sock: WebSocket
  try {
    sock = new WebSocket(url)
  } catch {
    wsIdx++
    setTimeout(openLogsWs, 3000)
    return
  }
  sock.onopen = () => sock.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_subscribe', params: ['logs', { address: ADDRS }] }))
  sock.onmessage = (ev) => {
    let m: { id?: number; result?: unknown; params?: { result?: RawLog } }
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (m.id === 7) {
      if (m.result) {
        chainHealth.logsLink = 'ws'
        store.emit()
      } else sock.close()
      return
    }
    const l = m.params?.result
    if (l?.topics) handleLog(l, true, liveHooks)
  }
  sock.onclose = () => {
    if (chainHealth.logsLink === 'ws') chainHealth.logsLink = 'poll'
    wsIdx++
    store.emit()
    setTimeout(openLogsWs, 3000)
  }
  sock.onerror = () => {
    /* onclose follows */
  }
}

// ---------- page open: the newest proposals ----------
async function loadRecent() {
  for (let attempt = 0; ; attempt++) {
    try {
      const next = Number(await readAdmin<bigint>('nextId'))
      const head = parseInt(await call<Hex>('eth_blockNumber', []), 16)
      const ids: number[] = []
      for (let id = next - 1; id >= 1 && ids.length < CONFIG.recentProposals; id--) ids.push(id)
      const props = await Promise.all(
        ids.map(async (id) => [id, await readAdmin<ChainProposal>('getProposal', [BigInt(id)]), await readAdmin<Hex>('clearanceOf', [BigInt(id)])] as const),
      )
      for (const [id, cp, cl] of props) if (Number(cp.status) !== 0) applyProposal(String(id), cp, cl)
      pickActive()
      store.emit()
      const spans = await Promise.all(
        props.map(async ([id, cp]) => {
          if (Number(cp.status) === 0) return []
          const from = Number(cp.proposedBlock)
          const to = Math.min(from + CHAIN.historySpan - 1, Math.max(head, blocks.latest))
          return getLogsSpan(from, to, pad(numberToHex(BigInt(id)), { size: 32 }))
        }),
      )
      // replay history in chain order, so the event stream reads oldest to newest
      const ord = (l: RawLog) => parseInt(l.blockNumber, 16) * 1e6 + parseInt(l.logIndex, 16)
      for (const l of spans.flat().sort((a, b) => ord(a) - ord(b))) handleLog(l, false, liveHooks)
      chainHealth.loadedRecent = true
      playbackGate.ready = true
      store.logT('chain', 'load', msg('ev.loaded', { n: props.length, next }), 'info')
      store.emit()
      return
    } catch (e) {
      store.logT('chain', 'load', msg('ev.loadFail', { n: attempt + 1, err: (e as Error).message.slice(0, 80) }), 'warn')
      store.emit()
      await new Promise((r) => setTimeout(r, Math.min(10000, 2000 * (attempt + 1))))
    }
  }
}

export function startChainWatch() {
  store.deploy = { airlockAdmin: DATA.airlockAdmin, proxy: DATA.proxy, delayBlocks: DATA.delayBlocks, chainId: DATA.chainId }
  loadImplNames()
  void loadRecent()
  openLogsWs()
  // cursor: every 4 s while the WS is up, every second while it is down
  let tick = 0
  setInterval(() => {
    tick++
    if (chainHealth.logsLink !== 'ws' || tick % 4 === 0) void pollLogs()
    // a pending proposal whose cooldown just ended: read it again (it may be waiting for its clearance)
    if (tick % 12 === 0)
      for (const p of store.proposals.values()) if (p.chain?.status === 1 && p.readyBlock && blocks.latest >= p.readyBlock) void refreshProposal(p.id)
  }, 1000)
}
