// Operator backend: launches one of the seven fixed attack cards (operator/cards.ts) on Ethereum Sepolia as the
// AirlockAdmin owner, for a live demo. Runtime-neutral (viem and Web APIs only, no node: imports): the Vite dev server
// (vite.config.ts, loopback only) and the Cloudflare Pages Functions (functions/api/operator/) both call it.
//
//   GET  /api/operator           200 {enabled, auth: 'none' | 'token', cards, cooldownBlocks}
//   POST /api/operator/propose   body {"card": "<id>"}; header Authorization: Bearer <token> when auth is 'token'
//        200 {ok: true, card, txHash}       the proposal is signed and sent; it is not mined yet
//        400 {ok: false, error: 'unknown card'}
//        401 {ok: false, error: 'unauthorized'}
//        409 {ok: false, error: 'cooldown', retryAfterBlocks}   the newest proposal is under 3 blocks old, or the
//                                                               owner still has a transaction in flight
//        502 {ok: false, error: 'rpc'}      no Sepolia node answered usefully (or fees were out of bounds)
//        and three that only a misconfiguration or the chain itself can cause:
//        403 {ok: false, enabled: false, error: 'disabled'}   the operator is off here
//        422 {ok: false, error: 'reverted'}  the node's dry run of the proposal reverted, so nothing was sent
//        500 {ok: false, error: 'misconfigured'}  the key does not belong to the deployment's owner
//
// The private key and the token are handed in by the caller at request time and stay inside this module: no response,
// no error string and no log line carries them, nor any text a node sent back. The client only ever names a card id;
// the address and the calldata come from the deployment data bundled at build time.
import { decodeFunctionResult, encodeFunctionData, keccak256, numberToHex, sha256, stringToBytes, type Address, type Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { availableCards, buildAction, deploymentUsable, isCardId, OPERATOR_ABI, type CardId, type OperatorDeployment } from './cards.ts'
import { DEPLOYMENT } from './deployment.generated.ts'

export const SEPOLIA_CHAIN_ID = 11155111
/** Tried in this order; a read that fails on one is asked of the next */
export const DEFAULT_RPCS: readonly string[] = ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org']
/** A new proposal waits until the newest one is at least this many blocks old */
export const COOLDOWN_BLOCKS = 3
/** proposeUpgrade used 594,008 gas on Sepolia (each one so far); an explicit limit means no estimate call */
export const GAS_LIMIT = 1_000_000n
/** Never sign a fee above this (a node answering nonsense must not drain the owner): 500 gwei */
export const MAX_FEE_CAP = 500_000_000_000n
/** Tip floor so a stage demo is mined in the next block or two: 1.5 gwei */
export const MIN_PRIORITY_FEE = 1_500_000_000n
/** A request body over this many bytes is refused unread */
export const MAX_BODY_BYTES = 1024
/** The configured token must be at least this long (set-operator-secrets.sh makes 64 hex characters) */
export const MIN_TOKEN_LENGTH = 32
/** After a send, this isolate refuses another until the owner's nonce moves on, for at most this long */
const RECENT_SEND_MS = 90_000

export interface OperatorInfo {
  enabled: boolean
  auth: 'none' | 'token'
  cards: string[]
  cooldownBlocks: number
}

/** What every runtime answers when the operator is not configured (a static deploy answers 404 instead) */
export const disabledInfo = (): OperatorInfo => ({ enabled: false, auth: 'token', cards: [], cooldownBlocks: 0 })

export interface ApiResult {
  status: number
  body: Record<string, unknown>
}

export interface OperatorConfig {
  /** 'none': the local dev server (loopback only); 'token': a Bearer token is required */
  auth: 'none' | 'token'
  /** The expected token when auth is 'token' */
  token?: string
  /** Returns the owner's private key (hex, 0x optional) at request time; undefined when there is none */
  ownerKey: () => string | undefined
  /** Sepolia JSON-RPC endpoints (default DEFAULT_RPCS) */
  rpcUrls?: readonly string[]
  /** Default: the Sepolia deployment bundled at build time (operator/deployment.generated.ts) */
  deployment?: OperatorDeployment
  cooldownBlocks?: number
  /** Tests inject a fake Sepolia here */
  fetchFn?: typeof fetch
  rpcTimeoutMs?: number
  now?: () => number
}

/** The JSON headers every operator response carries: never cached, never sniffed, never referred */
export const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

const result = (status: number, body: Record<string, unknown>): ApiResult => ({ status, body })
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiResult => result(status, { ok: false, error, ...extra })

// ---------------------------------------------------------------- secrets

/** A 32-byte hex private key (whitespace and a 0x prefix allowed), or null */
export function parseKey(raw: string | undefined): Hex | null {
  const k = (raw ?? '').replace(/\s+/g, '')
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) return null
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex
}

function accountOf(raw: string | undefined): PrivateKeyAccount | null {
  const k = parseKey(raw)
  if (!k) return null
  try {
    return privateKeyToAccount(k) // throws on 0 or a value over the curve order
  } catch {
    return null
  }
}

/** Compares two secrets in time that depends on neither: both are hashed to 32 bytes first, so even their lengths
 *  never show, and every byte of the digests is compared */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = sha256(stringToBytes(a), 'bytes')
  const y = sha256(stringToBytes(b), 'bytes')
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

/** The token of an "Authorization: Bearer <token>" header, or null */
export function bearer(header: string | null | undefined): string | null {
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return m ? m[1] : null
}

// ---------------------------------------------------------------- local dev server guard

/** True for a loopback peer address as Node reports it (IPv4 127/8, IPv6 ::1, IPv4-mapped 127/8) */
export function isLoopbackAddress(a: string | null | undefined): boolean {
  return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(a ?? '')
}

/** True when a dev server bound to this `server.host` value listens on loopback only (unset = vite's localhost) */
export function loopbackBind(host: string | boolean | undefined): boolean {
  if (host === undefined) return true
  if (typeof host !== 'string') return false // true = every interface
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || isLoopbackAddress(h)
}

/** The dev server's guard. The connecting peer (the socket's remote address, which a request cannot fake) must be
 *  loopback, so another device on the same network is refused even when it sends Host 127.0.0.1. Host must be
 *  127.0.0.1:<port> or localhost:<port> (a page that rebinds its own name to 127.0.0.1 still sends its own name);
 *  Origin, whenever the browser sends one, must be that same origin; Sec-Fetch-Site, when present, same-origin or
 *  none (typed into the address bar). */
export function localRequestAllowed(
  h: { remote: string | null | undefined; host?: string | null; origin?: string | null; secFetchSite?: string | null },
  port: number,
): boolean {
  if (!isLoopbackAddress(h.remote)) return false
  const host = (h.host ?? '').toLowerCase()
  if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return false
  if (h.origin != null && h.origin.toLowerCase() !== `http://${host}`) return false
  if (h.secFetchSite != null && h.secFetchSite !== 'same-origin' && h.secFetchSite !== 'none') return false
  return true
}

// ---------------------------------------------------------------- GET /api/operator

const tokenOk = (cfg: OperatorConfig) => cfg.auth === 'none' || (typeof cfg.token === 'string' && cfg.token.trim().length >= MIN_TOKEN_LENGTH)

/** Enabled only with a usable deployment, a well-formed key and (auth 'token') a long enough token */
export function operatorInfo(cfg: OperatorConfig | null): OperatorInfo {
  if (!cfg) return disabledInfo()
  const d = cfg.deployment ?? DEPLOYMENT
  if (!deploymentUsable(d) || !tokenOk(cfg) || !parseKey(cfg.ownerKey())) return disabledInfo()
  return { enabled: true, auth: cfg.auth, cards: availableCards(d), cooldownBlocks: cfg.cooldownBlocks ?? COOLDOWN_BLOCKS }
}

// ---------------------------------------------------------------- JSON-RPC with fallback

/** No endpoint gave a usable answer */
class RpcDown extends Error {}
/** A node answered with a JSON-RPC error the caller treats as final (a revert, an already known transaction) */
class NodeRefused extends Error {}

interface RpcError {
  code?: number
  message: string
}
type Rpc = (method: string, params: unknown[], isFinal?: (e: RpcError) => boolean) => Promise<unknown>

function makeRpc(urls: readonly string[], fetchFn: typeof fetch, timeoutMs: number): Rpc {
  let start = 0
  return async (method, params, isFinal) => {
    for (let i = 0; i < urls.length; i++) {
      const idx = (start + i) % urls.length
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      let j: unknown
      try {
        const res = await fetchFn(urls[idx], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: ctl.signal,
        })
        if (!res.ok) continue
        j = await res.json()
      } catch {
        continue
      } finally {
        clearTimeout(timer)
      }
      if (!j || typeof j !== 'object') continue
      const o = j as { result?: unknown; error?: { code?: unknown; message?: unknown } }
      if (o.error) {
        const e: RpcError = { code: typeof o.error.code === 'number' ? o.error.code : undefined, message: String(o.error.message ?? '') }
        if (isFinal?.(e)) throw new NodeRefused()
        continue
      }
      if (!('result' in o)) continue
      start = idx
      return o.result
    }
    throw new RpcDown()
  }
}

const isRevert = (e: RpcError) => e.code === 3 || /revert/i.test(e.message)
const isAlreadyKnown = (e: RpcError) => /already known|known transaction|already imported/i.test(e.message)

function qty(v: unknown): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new RpcDown()
  return BigInt(v)
}
function hexData(v: unknown): Hex {
  if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new RpcDown()
  return v as Hex
}

// ---------------------------------------------------------------- POST /api/operator/propose

let inFlight = false
let lastSent: { nonce: bigint; at: number } | null = null

/** Tests only: forget the in-flight flag and the last send */
export function resetOperatorState(): void {
  inFlight = false
  lastSent = null
}

/** The card id of a request body ({"card": "<id>"}), or null */
export function parseCard(body: string | null): CardId | null {
  if (body == null || body.length > MAX_BODY_BYTES) return null
  let j: unknown
  try {
    j = JSON.parse(body)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const card = (j as { card?: unknown }).card
  return isCardId(card) ? card : null
}

/** Blocks still to wait: the newest proposal must be at least `cooldown` blocks old (0 = go) */
export function cooldownLeft(latestBlock: bigint, newestProposedBlock: bigint | null, cooldown: number): number {
  if (newestProposedBlock === null) return 0
  const since = latestBlock - newestProposedBlock
  const left = BigInt(cooldown) - (since < 0n ? 0n : since)
  return left > 0n ? Number(left) : 0
}

/** Checks, signs and sends one card's proposal. `body` is the raw request body (null when it was too large). */
export async function propose(req: { authorization?: string | null; body: string | null }, cfg: OperatorConfig | null): Promise<ApiResult> {
  if (!cfg || !operatorInfo(cfg).enabled) return fail(403, 'disabled', { enabled: false })
  if (cfg.auth === 'token') {
    const got = bearer(req.authorization)
    if (got === null || !constantTimeEqual(got, (cfg.token ?? '').trim())) return fail(401, 'unauthorized')
  }
  const d = cfg.deployment ?? DEPLOYMENT
  const card = parseCard(req.body)
  const action = card ? buildAction(card, d) : null
  if (!card || !action) return fail(400, 'unknown card')
  // checked before any network call: a key that is not the owner's never reaches a node
  const account = accountOf(cfg.ownerKey())
  if (!account || account.address.toLowerCase() !== d.owner.toLowerCase()) return fail(500, 'misconfigured')
  const cooldown = cfg.cooldownBlocks ?? COOLDOWN_BLOCKS
  if (inFlight) return fail(409, 'cooldown', { retryAfterBlocks: cooldown + 1 })
  inFlight = true
  try {
    return await send(card, action, account, cfg, cooldown)
  } catch (e) {
    return e instanceof NodeRefused ? fail(422, 'reverted') : fail(502, 'rpc')
  } finally {
    inFlight = false
  }
}

async function send(card: CardId, action: { to: Address; data: Hex }, account: PrivateKeyAccount, cfg: OperatorConfig, cooldown: number): Promise<ApiResult> {
  const fetchFn = cfg.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const rpc = makeRpc(cfg.rpcUrls?.length ? cfg.rpcUrls : DEFAULT_RPCS, fetchFn, cfg.rpcTimeoutMs ?? 8000)
  const now = cfg.now ?? Date.now
  const owner = account.address
  const admin = action.to

  const [chainId, block, nextIdRaw, nonceLatest, noncePending, tip] = await Promise.all([
    rpc('eth_chainId', []),
    rpc('eth_getBlockByNumber', ['latest', false]),
    rpc('eth_call', [{ to: admin, data: encodeFunctionData({ abi: OPERATOR_ABI, functionName: 'nextId' }) }, 'latest']),
    rpc('eth_getTransactionCount', [owner, 'latest']),
    rpc('eth_getTransactionCount', [owner, 'pending']),
    rpc('eth_maxPriorityFeePerGas', []).catch(() => null),
  ])
  if (qty(chainId) !== BigInt(SEPOLIA_CHAIN_ID)) throw new RpcDown()
  const blk = block as { number?: unknown; baseFeePerGas?: unknown } | null
  if (!blk || typeof blk !== 'object') throw new RpcDown()
  const latest = qty(blk.number)
  const baseFee = qty(blk.baseFeePerGas)

  // 1. cooldown: the newest proposal (nextId - 1) must be at least `cooldown` blocks old
  const nextId = decodeFunctionResult({ abi: OPERATOR_ABI, functionName: 'nextId', data: hexData(nextIdRaw) })
  let newestBlock: bigint | null = null
  if (nextId > 1n) {
    const raw = await rpc('eth_call', [{ to: admin, data: encodeFunctionData({ abi: OPERATOR_ABI, functionName: 'getProposal', args: [nextId - 1n] }) }, 'latest'])
    newestBlock = decodeFunctionResult({ abi: OPERATOR_ABI, functionName: 'getProposal', data: hexData(raw) }).proposedBlock
  }
  const left = cooldownLeft(latest, newestBlock, cooldown)
  if (left > 0) return fail(409, 'cooldown', { retryAfterBlocks: left })

  // 2. nothing of the owner's in flight: no pending transaction, and not our own last send still unmined
  const nonce = qty(nonceLatest)
  const recent = lastSent !== null && now() - lastSent.at < RECENT_SEND_MS && nonce <= lastSent.nonce
  if (qty(noncePending) > nonce || recent) return fail(409, 'cooldown', { retryAfterBlocks: cooldown + 1 })

  // 3. dry run as the owner: a proposal the contract would refuse is never sent (NodeRefused -> 422)
  await rpc('eth_call', [{ from: owner, to: admin, data: action.data, gas: numberToHex(GAS_LIMIT) }, 'latest'], isRevert)

  // 4. EIP-1559 fees from the node, with a tip floor and a hard cap
  const tipWei = tip === null ? MIN_PRIORITY_FEE : qty(tip)
  const maxPriorityFeePerGas = tipWei > MIN_PRIORITY_FEE ? tipWei : MIN_PRIORITY_FEE
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas
  if (maxFeePerGas > MAX_FEE_CAP) throw new RpcDown()

  // 5. sign and send; the same signed bytes go to the next node if one fails, so a retry can never double-send
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: SEPOLIA_CHAIN_ID,
    nonce: Number(nonce),
    to: admin,
    data: action.data,
    value: 0n,
    gas: GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  const txHash = keccak256(raw)
  try {
    await rpc('eth_sendRawTransaction', [raw], isAlreadyKnown)
  } catch (e) {
    if (!(e instanceof NodeRefused)) throw e // NodeRefused here: the node already has this exact transaction
  }
  lastSent = { nonce, at: now() }
  return result(200, { ok: true, card, txHash })
}
