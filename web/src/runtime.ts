// This run's settings, from config.ts plus the URL (browser side).
import { CONFIG, type AppMode, type ChainConfig } from './config'

const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)

export function pickMode(raw: string | null): AppMode {
  return raw === 'offline' || raw === 'airlock' ? raw : CONFIG.defaultMode
}

export const MODE: AppMode = pickMode(params.get('mode'))

/** Offline playback: no fetch, no WebSocket; everything comes from src/recorded-run.json */
export const OFFLINE = MODE === 'offline'

/** ?rpc= override: must be an http(s) URL, otherwise ignored */
export function parseRpcOverride(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (!/^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(s)) return null
  return s.replace(/\/+$/, '')
}

/** Loopback address (local fork): 127.0.0.1, localhost, [::1] */
export function isLoopback(url: string): boolean {
  return /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url)
}

/** Chain settings with an optional ?rpc= override: only that endpoint is used (WS on the same host and port, as
 *  anvil serves both). A local fork has no explorer and no Sourcify (its addresses and hashes are not on Sepolia). */
export function chainWithRpc(base: ChainConfig, rpc: string | null): ChainConfig {
  if (!rpc) return { ...base, ws: [...base.ws], http: [...base.http] }
  const local = isLoopback(rpc)
  return {
    ...base,
    ws: [rpc.replace(/^http/i, 'ws')],
    http: [rpc],
    explorerTx: local ? null : base.explorerTx,
    explorerAddr: local ? null : base.explorerAddr,
    sourcifyApi: local ? null : base.sourcifyApi,
    pollMs: local ? 1000 : base.pollMs,
  }
}

const RPC_OVERRIDE = OFFLINE ? null : parseRpcOverride(params.get('rpc'))

/** Live view of a local Sepolia fork (?rpc= on a loopback address): numbers are labelled "local fork" */
export const FORK = RPC_OVERRIDE !== null && isLoopback(RPC_OVERRIDE)

/** Offline mode has no endpoints and no outbound links at all, so nothing can open a connection by accident */
export const CHAIN: ChainConfig = OFFLINE
  ? { ...CONFIG.sepolia, ws: [], http: [], explorerTx: null, explorerAddr: null, sourcifyApi: null }
  : chainWithRpc(CONFIG.sepolia, RPC_OVERRIDE)

/** ?p=<id>: open on that proposal (a positive integer, else ignored) */
export function parsePick(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  return /^[1-9]\d{0,8}$/.test(s) ? s : null
}
export const PICK = parsePick(params.get('p'))

/** ?clean=1 (or a bare ?clean): recording mode. The presenter chrome (language switch, Details, ?, key hints) is not
 *  drawn, so a recorded video shows only the product. ?clean=0 or no parameter: the normal page */
export function parseClean(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false
  const s = raw.trim().toLowerCase()
  return s === '' || s === '1' || s === 'true' || s === 'yes'
}
export const CLEAN = parseClean(params.get('clean'))

/** Guard cards in deployment order: guardians = [AirlockReceiver (Chainlink CRE), emergency guardian (human)] */
export const GUARDS = ['cre', 'breakglass'] as const
export type GuardId = (typeof GUARDS)[number]
