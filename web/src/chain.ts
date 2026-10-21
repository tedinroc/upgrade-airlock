// Block stream: WS eth_subscribe newHeads; while the WS is down, poll eth_blockNumber over HTTP and reconnect the WS
// in the background. Offline mode never starts it.
import { CONFIG } from './config'
import { CHAIN } from './runtime'

export type Link = 'ws' | 'poll' | 'down' | 'offline'

export class BlockStream {
  latest = 0
  /** Date.now() when the latest header arrived (drives the per-second cooldown clock between blocks) */
  lastAt = 0
  link: Link = 'down'
  linkUrl = ''
  private arrivals: { n: number; t: number }[] = []
  private listeners = new Set<() => void>()
  private ws: WebSocket | null = null
  private wsIdx = 0
  private httpIdx = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  onChange(fn: () => void) {
    this.listeners.add(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  /** One block header (WS or poll) */
  ingest(n: number) {
    if (!Number.isFinite(n) || n <= 0 || n <= this.latest) return
    this.latest = n
    this.lastAt = Date.now()
    this.arrivals.push({ n, t: performance.now() })
    if (this.arrivals.length > CONFIG.blockTimeWindow) this.arrivals.shift()
    this.emit()
  }

  /** Measured average block time (ms, by arrival); null with too few samples */
  blockTimeMs(): number | null {
    const a = this.arrivals
    if (a.length < 6) return null
    const dn = a[a.length - 1].n - a[0].n
    return dn > 0 ? (a[a.length - 1].t - a[0].t) / dn : null
  }

  start() {
    this.openWs()
  }

  /** Offline playback: no connection; the head is the recording's last block */
  setOffline(head: number) {
    this.stopped = true
    this.link = 'offline'
    this.latest = head
    this.emit()
  }

  private openWs() {
    if (this.stopped) return
    if (CHAIN.ws.length === 0) {
      this.startPoll()
      return
    }
    const url = CHAIN.ws[this.wsIdx % CHAIN.ws.length]
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.wsFailed()
      return
    }
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }))
    ws.onmessage = (ev) => {
      let msg: { id?: number; result?: unknown; error?: unknown; params?: { result?: { number?: string } } }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id === 1) {
        if (msg.error) return ws.close()
        this.link = 'ws'
        this.linkUrl = url
        this.stopPoll()
        this.emit()
        // 12 s blocks: ask for the current number once instead of waiting for the next header
        if (!this.latest && CHAIN.http.length)
          void rpc<string>(CHAIN.http[0], 'eth_blockNumber', [])
            .then((n) => this.ingest(parseInt(n, 16)))
            .catch(() => {
              /* the next header will do */
            })
        return
      }
      const n = msg.params?.result?.number
      if (n) this.ingest(parseInt(n, 16))
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.wsFailed()
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  private wsFailed() {
    if (this.stopped) return
    this.wsIdx++
    this.startPoll()
    setTimeout(() => this.openWs(), 2000)
  }

  private startPoll() {
    if (this.pollTimer !== null || CHAIN.http.length === 0) return
    this.link = 'poll'
    this.emit()
    void this.pollOnce()
    this.pollTimer = setInterval(() => void this.pollOnce(), CHAIN.pollMs)
  }

  private stopPoll() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async pollOnce() {
    const url = CHAIN.http[this.httpIdx % CHAIN.http.length]
    try {
      const n = await rpc<string>(url, 'eth_blockNumber', [])
      this.linkUrl = url
      this.ingest(parseInt(n, 16))
    } catch {
      this.httpIdx++
      if (this.link !== 'ws') {
        this.link = 'down'
        this.emit()
      }
    }
  }
}

let rpcId = 100
export async function rpc<T>(url: string, method: string, params: unknown[], timeoutMs = 3000): Promise<T> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      signal: ctl.signal,
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    if (j.error) throw new Error(j.error.message ?? 'rpc error')
    return j.result as T
  } finally {
    clearTimeout(t)
  }
}

export const blocks = new BlockStream()
