// Operator mode (the presenter only): launch one of the seven demo actions as a REAL Ethereum Sepolia transaction
// through the operator API, then let the live war room pick up the proposal and its verdict. This page never holds a
// key and never signs: it sends {card} (one of seven fixed ids, never an address or calldata), the server signs.
//
// Invisible to the public: nothing operator-related is drawn unless GET /api/operator says enabled AND (auth is 'none'
// [local dev] or this browser holds the operator token). A static deploy without the API answers 404: disabled.
//   ?op=1        asks for the token in a small prompt (when the API says it is needed): the safest way on a stage
//                machine, since the token never sits in an address
//   #op=<token>  keeps the token in this browser (localStorage) and removes it from the address bar at once; a
//                fragment is never sent to the server, so it stays out of request logs
//   ?op=<token>  the same, as a query (it does reach the server's request log once, and the browser's history)
// Offline playback and a local fork (?rpc=) never ask the API: their screen is not Ethereum Sepolia. Neither does a
// public visitor: the API is only asked on a loopback host (local dev) or when this browser holds a token or ?op=1
// asked for one, so a static deploy logs no 404 and the public never learns whether operator mode is on.
//
// API contract:
//   GET  /api/operator          -> {enabled, auth: 'none'|'token', cards: string[], cooldownBlocks}
//   POST /api/operator/propose  {card} (+ Authorization: Bearer <token> when auth is 'token')
//        200 {ok, card, txHash} | 400 unknown card | 401 unauthorized | 409 cooldown (retryAfterBlocks) | 502 rpc
//        and from the operator service also 403 disabled (operator off) | 403 forbidden (origin/host guard) |
//        405 method | 422 reverted (its dry run reverted, nothing sent) | 500 misconfigured (the key is not the
//        owner's) | 500 internal
// Every answer gets its own wording on screen (op.err*); the server's own words are never shown.
import { isLabId, LAB_IDS, type LabId } from './lab'
import type { Proposal } from './store'

export interface OperatorInfo {
  enabled: boolean
  auth: 'none' | 'token'
  /** card ids the server will propose (a subset of the seven) */
  cards: LabId[]
  cooldownBlocks: number
}
export const OP_DISABLED: OperatorInfo = { enabled: false, auth: 'token', cards: [], cooldownBlocks: 0 }

/** GET /api/operator's answer, checked field by field; anything unexpected means disabled */
export function parseOperatorInfo(status: number, body: unknown): OperatorInfo {
  if (status !== 200 || !body || typeof body !== 'object') return OP_DISABLED
  const b = body as Record<string, unknown>
  if (b.enabled !== true || (b.auth !== 'none' && b.auth !== 'token') || !Array.isArray(b.cards)) return OP_DISABLED
  const cards = LAB_IDS.filter((id) => (b.cards as unknown[]).includes(id))
  const cd = Number(b.cooldownBlocks)
  return { enabled: cards.length > 0, auth: b.auth, cards, cooldownBlocks: Number.isFinite(cd) && cd >= 0 ? Math.floor(cd) : 0 }
}

/** What a token may look like (URL-safe; long enough to be a secret, short enough for a header) */
export const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/

/** ?op= or #op= in an address: the token it carries (or the prompt flag), and the same address without it */
export function tokenFromUrl(href: string): { token: string | null; prompt: boolean; stripped: string | null } {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return { token: null, prompt: false, stripped: null }
  }
  const hp = new URLSearchParams(u.hash.replace(/^#/, ''))
  const inQuery = u.searchParams.has('op')
  const inHash = /^#.*\bop=/.test(u.hash) && hp.has('op')
  if (!inQuery && !inHash) return { token: null, prompt: false, stripped: null }
  // the fragment wins (it never reached a server); both are removed either way
  const raw = ((inHash ? hp.get('op') : u.searchParams.get('op')) ?? '').trim()
  u.searchParams.delete('op')
  hp.delete('op')
  const hash = inHash ? (hp.toString() ? `#${hp}` : '') : u.hash
  const stripped = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + hash
  if (raw === '1') return { token: null, prompt: true, stripped }
  return { token: TOKEN_RE.test(raw) ? raw : null, prompt: false, stripped }
}

/** The local dev server's hosts: the only place the API answers without a token */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1']

/** This browser may be the operator's, so the API is worth asking: a loopback host, a saved token, or ?op=1 */
export function mayOperate(hostname: string | null | undefined): boolean {
  return LOOPBACK_HOSTS.includes((hostname ?? '').toLowerCase()) || !!op.token || op.prompt
}

/** The operator UI may be drawn */
export function operatorVisible(info: OperatorInfo, token: string | null): boolean {
  return info.enabled && info.cards.length > 0 && (info.auth === 'none' || !!token)
}

export type LaunchError = 'unknown card' | 'unauthorized' | 'disabled' | 'forbidden' | 'cooldown' | 'reverted' | 'misconfigured' | 'rpc' | 'server' | 'unclear' | 'network'
export type LaunchResult = { ok: true; card: LabId; txHash: string } | { ok: false; error: LaunchError; retryAfterBlocks?: number }

const TXHASH = /^0x[0-9a-fA-F]{64}$/
/** POST /api/operator/propose's answer -> a result the page can show (never the server's own words) */
export function parseLaunchResponse(status: number, body: unknown): LaunchResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (status === 200 && b.ok === true && typeof b.txHash === 'string' && TXHASH.test(b.txHash) && isLabId(b.card)) return { ok: true, card: b.card, txHash: b.txHash }
  // a 2xx without a transaction hash: the transaction may or may not be out (the live war room picks it up if it is)
  if (status >= 200 && status < 300) return { ok: false, error: 'unclear' }
  if (status === 400) return { ok: false, error: 'unknown card' }
  if (status === 401) return { ok: false, error: 'unauthorized' }
  // 403: operator mode switched off on the server, or this page's origin refused by its guard (the UI stays)
  if (status === 403) return { ok: false, error: b.error === 'disabled' || b.enabled === false ? 'disabled' : 'forbidden' }
  if (status === 404) return { ok: false, error: 'disabled' }
  if (status === 409) {
    const n = Number(b.retryAfterBlocks)
    return { ok: false, error: 'cooldown', ...(Number.isFinite(n) && n > 0 ? { retryAfterBlocks: Math.ceil(n) } : {}) }
  }
  if (status === 422) return { ok: false, error: 'reverted' }
  if (status === 500 && b.error === 'misconfigured') return { ok: false, error: 'misconfigured' }
  if (status === 502) return { ok: false, error: 'rpc' }
  if (status >= 400) return { ok: false, error: 'server' }
  return { ok: false, error: 'network' }
}

export interface Launch {
  card: LabId
  state: 'sending' | 'sent' | 'error'
  /** when it was sent (ms) */
  at: number
  txHash?: string
  error?: LaunchError
  retryAfterBlocks?: number
  /** when its verdict was first seen on screen (ms): the status toast fades some time after */
  doneAt?: number
}

/** Where a sent launch stands on chain, from the proposals the war room already reads */
export type LaunchStage = 'sending' | 'sent' | 'slow' | 'onchain' | 'veto' | 'clear' | 'exec' | 'error'
export const SLOW_MS = 4 * 60_000
export function launchStage(l: Launch, proposals: Iterable<Proposal>, now = Date.now()): { stage: LaunchStage; p: Proposal | null } {
  if (l.state === 'sending') return { stage: 'sending', p: null }
  if (l.state === 'error' || !l.txHash) return { stage: 'error', p: null }
  const tx = l.txHash.toLowerCase()
  const p = [...proposals].find((x) => x.proposeTx?.toLowerCase() === tx) ?? null
  if (!p) return { stage: now - l.at > SLOW_MS ? 'slow' : 'sent', p: null }
  const vetoed = p.chain?.status === 2 || Object.values(p.guards).some((g) => g.verdict === 'veto')
  if (vetoed) return { stage: 'veto', p }
  if (p.execute || p.chain?.status === 3) return { stage: 'exec', p }
  if (p.clearance || p.chain?.clearanceOf) return { stage: 'clear', p }
  return { stage: 'onchain', p }
}

// ---------- page state ----------
const LS_KEY = 'airlock.op'
export const op = {
  info: OP_DISABLED,
  /** GET /api/operator answered (or failed) */
  loaded: false,
  token: null as string | null,
  /** ?op=1: the token prompt is open */
  prompt: false,
  promptBad: false,
  /** the launch panel is open, and the card waiting for its confirm step */
  panel: false,
  confirm: null as LabId | null,
  launch: null as Launch | null,
  /** the viewer closed the status toast of the current launch */
  toastHidden: false,
  /** a one-line notice after the operator UI went away (the token was rejected, operator mode was switched off) */
  notice: null as 'auth' | 'disabled' | null,
  noticeAt: 0,
}

export const opVisible = () => operatorVisible(op.info, op.token)

function readToken(): string | null {
  try {
    const t = globalThis.localStorage?.getItem(LS_KEY) ?? null
    return t && TOKEN_RE.test(t) ? t : null
  } catch {
    return null
  }
}
export function saveToken(t: string): boolean {
  if (!TOKEN_RE.test(t)) return false
  op.token = t
  try {
    globalThis.localStorage?.setItem(LS_KEY, t)
  } catch {
    /* private mode: the token lasts for this page only */
  }
  return true
}
export function forgetToken() {
  op.token = null
  op.panel = false
  op.confirm = null
  try {
    globalThis.localStorage?.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}

/** Step 1, synchronous and first thing on page load: take ?op= out of the address bar before anything else runs */
export function takeTokenFromUrl() {
  try {
    const r = tokenFromUrl(globalThis.location?.href ?? '')
    if (r.stripped !== null) {
      if (r.token) saveToken(r.token)
      op.prompt = r.prompt
      globalThis.history?.replaceState?.(globalThis.history.state, '', r.stripped)
    }
  } catch {
    /* no history API: nothing to strip */
  }
  op.token = op.token ?? readToken()
}

/** Step 2: ask the API whether operator mode exists here. A 404, a network error or a bad answer: disabled. */
export async function loadOperator(fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<OperatorInfo> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined
  try {
    const r = await fetchImpl('/api/operator', { cache: 'no-store', headers: { accept: 'application/json' }, signal: ctl?.signal })
    let body: unknown = null
    if (r.status === 200) body = await r.json().catch(() => null)
    op.info = parseOperatorInfo(r.status, body)
  } catch {
    op.info = OP_DISABLED
  } finally {
    if (timer) clearTimeout(timer)
    op.loaded = true
  }
  // the prompt only makes sense where a token is needed and missing
  if (!(op.info.enabled && op.info.auth === 'token' && !op.token)) op.prompt = false
  return op.info
}

/** A launch is on its way and has not been seen on chain yet: one at a time */
export function launchBusy(proposals: Iterable<Proposal>, now = Date.now()): boolean {
  const l = op.launch
  if (!l) return false
  const s = launchStage(l, proposals, now).stage
  return s === 'sending' || s === 'sent'
}

/** The operator's launch on its way (sending, or sent and not on chain yet): the war room shows it as pending */
export function pendingLaunch(proposals: Iterable<Proposal>, now = Date.now()): Launch | null {
  const l = op.launch
  if (!l || !opVisible()) return null
  const s = launchStage(l, proposals, now).stage
  return s === 'sending' || s === 'sent' ? l : null
}

/** Send one card. onSent runs once the server answered with a transaction hash. */
export async function launchCard(card: LabId, proposals: Iterable<Proposal>, onSent: () => void, fetchImpl: typeof fetch = fetch): Promise<LaunchResult | null> {
  if (!opVisible() || !op.info.cards.includes(card) || launchBusy(proposals)) return null
  op.confirm = null
  op.toastHidden = false
  op.launch = { card, state: 'sending', at: Date.now() }
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (op.info.auth === 'token' && op.token) headers.authorization = `Bearer ${op.token}`
  let res: LaunchResult
  try {
    const r = await fetchImpl('/api/operator/propose', { method: 'POST', headers, body: JSON.stringify({ card }), cache: 'no-store' })
    const body = await r.json().catch(() => null)
    res = parseLaunchResponse(r.status, body)
  } catch {
    res = { ok: false, error: 'network' }
  }
  if (res.ok) {
    op.launch = { card, state: 'sent', at: Date.now(), txHash: res.txHash }
    onSent()
  } else {
    op.launch = { card, state: 'error', at: Date.now(), error: res.error, ...(res.retryAfterBlocks ? { retryAfterBlocks: res.retryAfterBlocks } : {}) }
    if (res.error === 'unauthorized' && op.info.auth === 'token') {
      // a wrong or rotated token: forget it, the operator UI disappears, a notice says why
      forgetToken()
      op.notice = 'auth'
      op.noticeAt = Date.now()
    } else if (res.error === 'disabled') {
      // switched off on the server since the page loaded: the operator UI disappears
      op.info = OP_DISABLED
      op.panel = false
      op.confirm = null
      op.notice = 'disabled'
      op.noticeAt = Date.now()
    }
  }
  return res
}
