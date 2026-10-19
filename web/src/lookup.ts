// Sourcify lookup of contract addresses (live Sepolia only): the page shows "verified" only after a confirmed match;
// a network failure shows nothing (no claim either way). GET only; nothing is signed or sent.
import { CHAIN } from './runtime'
import { store } from './store'

/** One lookup per address; a network error may be retried after 15 s */
export function checkVerified(addr: string | undefined | null) {
  if (!addr || !CHAIN.sourcifyApi || /^0x0{40}$/i.test(addr)) return
  const key = addr.toLowerCase()
  if (store.verified.has(key)) return
  store.verified.set(key, 'pending')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 8000)
  fetch(CHAIN.sourcifyApi + addr, { signal: ctl.signal })
    .then(async (r) => {
      if (r.status === 404) return store.verified.set(key, 'no')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { match?: string | null; runtimeMatch?: string | null }
      store.verified.set(key, j.match || j.runtimeMatch ? 'yes' : 'no')
    })
    .catch(() => {
      store.verified.set(key, 'err')
      setTimeout(() => {
        if (store.verified.get(key) === 'err') store.verified.delete(key)
      }, 15000)
    })
    .finally(() => {
      clearTimeout(timer)
      store.emit()
    })
}
