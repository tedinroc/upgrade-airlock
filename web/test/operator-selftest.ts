// Operator backend self-test (npm run selftest): the shared module in operator/ and the Cloudflare handlers, driven
// with real Request objects against a fake Sepolia JSON-RPC. No network: the global fetch is a trap, and every RPC
// goes through the injected fake. No real key: the owner is a fresh random key made here.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { availableCards, buildAction, CARD_ACTION, CARD_IDS, OPERATOR_ABI, type CardId, type OperatorDeployment } from '../operator/cards'
import { cloudConfig, handleInfoRequest, handleProposeRequest, readCapped } from '../operator/cloud'
import { DEPLOYMENT } from '../operator/deployment.generated'
import {
  bearer,
  constantTimeEqual,
  COOLDOWN_BLOCKS,
  cooldownLeft,
  DEFAULT_RPCS,
  disabledInfo,
  GAS_LIMIT,
  localRequestAllowed,
  loopbackBind,
  MAX_BODY_BYTES,
  MIN_PRIORITY_FEE,
  operatorInfo,
  parseCard,
  propose,
  resetOperatorState,
  type ApiResult,
  type OperatorConfig,
} from '../operator/operator'
import { findBlocked, NAMES_NOTE } from './scan'

let fails = 0
function ok(cond: unknown, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) fails++
}
const WEB = process.cwd()
const REPO = join(WEB, '..')

// every network call must go through an injected fake; the real fetch is a trap
let trapped = 0
globalThis.fetch = (async () => {
  trapped++
  throw new TypeError('network trapped by the self-test')
}) as typeof fetch

// ---------- 1. the seven cards and their exact calldata ----------
const shipped = JSON.parse(readFileSync(join(WEB, 'src', 'chain-data-sepolia.json'), 'utf8'))
ok(CARD_IDS.join() === 'evil-mint,evil-owner,evil-fee,evil-basefee,evil-drain,remove-receiver,v2', 'seven cards, in picker order')
{
  const g = DEPLOYMENT
  const same =
    g.pending === shipped.pending &&
    g.chainId === shipped.chainId &&
    g.airlockAdmin === shipped.airlockAdmin &&
    g.owner === shipped.owner &&
    g.receiver === shipped.receiver &&
    (['v2', 'evilMint', 'evilOwner', 'evilFee', 'evilBaseFee', 'evilDrain'] as const).every((k) => g.impls[k] === shipped.impls?.[k])
  ok(same, 'operator/deployment.generated.ts matches src/chain-data-sepolia.json (npm run sync:sepolia regenerates it)')
}
// propose.sh's case table: card -> deployment key
{
  const sh = readFileSync(join(REPO, 'scripts', 'sepolia', 'propose.sh'), 'utf8')
  const table = new Map<string, string>()
  for (const m of sh.matchAll(/^\s+([a-z0-9-]+)(?: \| [A-Za-z0-9]+)?\) KEY=([A-Za-z0-9]+) EXPECT=/gm)) table.set(m[1], m[2])
  const mine = CARD_IDS.map((c) => [c, CARD_ACTION[c].kind === 'remove-receiver' ? 'receiver' : (CARD_ACTION[c] as { impl: string }).impl])
  ok(table.size === 7 && mine.every(([c, k]) => table.get(c) === k), `every card proposes what scripts/sepolia/propose.sh proposes (${table.size} rows)`)
}
const castBin = [join(homedir(), '.foundry', 'bin', 'cast'), 'cast'].find((p) => {
  try {
    execFileSync(p, ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})
const castCalldata = (sig: string, ...args: string[]) => execFileSync(castBin!, ['calldata', sig, ...args], { encoding: 'utf8' }).trim()
{
  const upSel = toFunctionSelector('proposeUpgrade(address,bytes)')
  const gSel = toFunctionSelector('proposeSetGuardian(address,bool)')
  let exact = 0
  let castSame = 0
  for (const card of CARD_IDS) {
    const a = buildAction(card, DEPLOYMENT)
    const act = CARD_ACTION[card]
    const target = (act.kind === 'remove-receiver' ? DEPLOYMENT.receiver : DEPLOYMENT.impls[act.impl]) as Address
    const want =
      act.kind === 'remove-receiver'
        ? ((gSel + encodeAbiParameters([{ type: 'address' }, { type: 'bool' }], [target, false]).slice(2)) as Hex)
        : ((upSel + encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [target, '0x']).slice(2)) as Hex)
    if (a && a.to === DEPLOYMENT.airlockAdmin && a.data === want) exact++
    if (castBin && a) {
      const c = act.kind === 'remove-receiver' ? castCalldata('proposeSetGuardian(address,bool)', target, 'false') : castCalldata('proposeUpgrade(address,bytes)', target, '0x')
      if (c === a.data) castSame++
    }
  }
  ok(exact === 7, `every card's calldata is selector + abi.encode(target, 0x | false), sent to AirlockAdmin (${exact}/7)`)
  if (castBin) ok(castSame === 7, `cast calldata gives the same bytes for all seven cards (${castSame}/7)`)
  else console.log('note: cast not found, calldata compared with viem encoding only')
  const art = join(REPO, 'out', 'AirlockAdmin.sol', 'AirlockAdmin.json')
  if (existsSync(art)) {
    const ids = JSON.parse(readFileSync(art, 'utf8')).methodIdentifiers as Record<string, string>
    const need = ['proposeUpgrade(address,bytes)', 'proposeSetGuardian(address,bool)', 'nextId()', 'getProposal(uint256)']
    ok(need.every((s) => ids[s] && `0x${ids[s]}` === toFunctionSelector(OPERATOR_ABI.find((f) => f.type === 'function' && s.startsWith(f.name + '('))!)), 'operator ABI selectors match the forge artifact of AirlockAdmin')
  }
  ok(availableCards(DEPLOYMENT).length === (DEPLOYMENT.pending ? 0 : 7), `the shipped deployment can launch ${availableCards(DEPLOYMENT).length} cards`)
  const { evilDrain: _d, ...older } = DEPLOYMENT.impls
  const old: OperatorDeployment = { ...DEPLOYMENT, impls: older }
  ok(buildAction('evil-drain', old) === null && !availableCards(old).includes('evil-drain') && availableCards(old).length === 6, 'a deployment without a card\'s implementation does not offer that card')
  ok(availableCards({ ...DEPLOYMENT, pending: true }).length === 0 && buildAction('v2', { ...DEPLOYMENT, pending: true }) === null, 'the placeholder deployment offers nothing')
}

// ---------- 2. secrets, auth and the local guard ----------
ok(constantTimeEqual('a'.repeat(64), 'a'.repeat(64)) && constantTimeEqual('', ''), 'constant-time compare: equal strings')
ok(!constantTimeEqual('a'.repeat(64), 'a'.repeat(63) + 'b') && !constantTimeEqual('a'.repeat(64), 'a'.repeat(63)) && !constantTimeEqual('abc', 'abcd') && !constantTimeEqual('x', ''), 'constant-time compare: one byte off, a prefix, different lengths')
{
  // it hashes both sides first, so the loop is 32 bytes whatever the inputs; check that long inputs still compare
  const long = 'f'.repeat(10_000)
  ok(constantTimeEqual(long, long) && !constantTimeEqual(long, long + 'f'), 'constant-time compare: long inputs (hashed to 32 bytes first)')
}
ok(bearer('Bearer abc') === 'abc' && bearer('bearer  abc ') === 'abc' && bearer('Basic abc') === null && bearer('Bearer') === null && bearer(null) === null && bearer('Bearer a b') === null, 'Authorization: Bearer parsing')
{
  const P = 5173
  const yes = [
    { host: '127.0.0.1:5173' },
    { host: 'localhost:5173' },
    { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
    { host: 'localhost:5173', origin: 'http://localhost:5173', secFetchSite: 'same-origin' },
  ]
  const no = [
    { host: 'attacker.example:5173' }, // DNS rebinding: the browser sends the attacker's name
    { host: 'attacker.example:5173', origin: 'http://attacker.example:5173' },
    { host: '127.0.0.1:5174' },
    { host: '192.168.1.20:5173' },
    { host: '' },
    { host: '127.0.0.1:5173', origin: 'http://evil.example' },
    { host: '127.0.0.1:5173', origin: 'null' },
    { host: '127.0.0.1:5173', origin: 'http://localhost:5173' },
    { host: '127.0.0.1:5173', secFetchSite: 'cross-site' },
    { host: '127.0.0.1:5173', secFetchSite: 'same-site' },
  ]
  const lo = (h: { host?: string; origin?: string; secFetchSite?: string }) => ({ remote: '127.0.0.1', ...h })
  ok(yes.every((h) => localRequestAllowed(lo(h), P)), 'local guard: loopback Host with no Origin or a matching one is allowed')
  ok(no.every((h) => !localRequestAllowed(lo(h), P)) && !localRequestAllowed(lo({ host: '127.0.0.1:0' }), 0), 'local guard: foreign Host (DNS rebinding), other port, foreign or null Origin, cross-site fetch are refused')
  // the peer address cannot be faked by a header: a device on the LAN that sends Host 127.0.0.1 is still refused
  ok(
    !localRequestAllowed({ remote: '192.168.1.20', host: '127.0.0.1:5173' }, P) &&
      !localRequestAllowed({ remote: '::ffff:192.168.1.20', host: '127.0.0.1:5173' }, P) &&
      !localRequestAllowed({ remote: '10.0.0.5', host: 'localhost:5173', origin: 'http://localhost:5173' }, P) &&
      !localRequestAllowed({ remote: 'fe80::1', host: '127.0.0.1:5173' }, P) &&
      !localRequestAllowed({ remote: undefined, host: '127.0.0.1:5173' }, P) &&
      !localRequestAllowed({ remote: '', host: '127.0.0.1:5173' }, P) &&
      !localRequestAllowed({ remote: '127.0.0.1.evil', host: '127.0.0.1:5173' }, P),
    'local guard: a non-loopback peer (LAN IPv4, mapped LAN, link-local, unknown) is refused even with Host 127.0.0.1:5173',
  )
  ok(
    localRequestAllowed({ remote: '::ffff:127.0.0.1', host: '127.0.0.1:5173' }, P) &&
      localRequestAllowed({ remote: '::1', host: 'localhost:5173' }, P) &&
      localRequestAllowed({ remote: '127.0.0.2', host: '127.0.0.1:5173' }, P),
    'local guard: loopback peers (127/8, ::1, ::ffff:127.0.0.1) are allowed',
  )
  ok(
    loopbackBind(undefined) && loopbackBind('127.0.0.1') && loopbackBind('localhost') && loopbackBind('::1') && loopbackBind('[::1]') &&
      !loopbackBind(true) && !loopbackBind('0.0.0.0') && !loopbackBind('::') && !loopbackBind('192.168.1.20') && !loopbackBind(''),
    'dev server bind: the operator API runs only on a loopback bind (vite --host / 0.0.0.0 / a LAN address keep it off)',
  )
}
ok(parseCard('{"card":"v2"}') === 'v2' && parseCard('{"card":"evil-drain","target":"0x01"}') === 'evil-drain', 'body: the card id is read, any other field is ignored')
ok(
  [null, '', 'v2', '"v2"', '[]', '["v2"]', '{"card":2}', '{"card":"V2"}', '{"card":"evilMint"}', '{"card":"0x4D959f981C01E3B81ac6C9A20E84816Fe5f6Bce3"}', '{"card":"remove-receiver "}', `{"card":"v2","x":"${'a'.repeat(MAX_BODY_BYTES)}"}`].every(
    (b) => parseCard(b) === null,
  ),
  'body: anything but one of the seven ids (an address, another spelling, an oversized body) is refused',
)
ok(cooldownLeft(100n, null, 3) === 0 && cooldownLeft(100n, 100n, 3) === 3 && cooldownLeft(100n, 99n, 3) === 2 && cooldownLeft(100n, 98n, 3) === 1 && cooldownLeft(100n, 97n, 3) === 0 && cooldownLeft(100n, 101n, 3) === 3, 'cooldown math: 3, 2, 1 blocks left, then go; a node behind the proposal counts as 0 blocks')

// ---------- 3. a fake Sepolia ----------
const OWNER_KEY = generatePrivateKey()
const OWNER = privateKeyToAccount(OWNER_KEY).address
const OTHER_KEY = generatePrivateKey()
const TOKEN = toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2)
const DEP: OperatorDeployment = { ...DEPLOYMENT, pending: false, owner: OWNER }
const [RPC_A, RPC_B] = ['https://rpc-a.invalid', 'https://rpc-b.invalid']
const ZERO32 = `0x${'0'.repeat(64)}` as Hex

interface Fake {
  chainId: number
  block: bigint
  baseFee: bigint
  tip: bigint | null
  nextId: bigint
  newest: bigint
  nonce: bigint
  pending: bigint
  revert: boolean
  sendError: string | null
  down: Set<string>
  calls: { url: string; method: string }[]
  dryRuns: { from: string; data: Hex }[]
  sent: Hex[]
}
const fake = (o: Partial<Fake> = {}): Fake => ({
  chainId: 11155111,
  block: 12_000_000n,
  baseFee: 1_000_000_000n,
  tip: 2_000_000_000n,
  nextId: 9n,
  newest: 11_999_000n,
  nonce: 40n,
  pending: 40n,
  revert: false,
  sendError: null,
  down: new Set(),
  calls: [],
  dryRuns: [],
  sent: [],
  ...o,
})
function fakeFetch(f: Fake): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] }
    f.calls.push({ url, method: req.method })
    if (f.down.has(url)) throw new TypeError('fetch failed')
    const res = (o: object) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...o }), { status: 200, headers: { 'content-type': 'application/json' } })
    const okr = (result: unknown) => res({ result })
    const err = (code: number, message: string) => res({ error: { code, message } })
    switch (req.method) {
      case 'eth_chainId':
        return okr(toHex(f.chainId))
      case 'eth_getBlockByNumber':
        return okr({ number: toHex(f.block), baseFeePerGas: toHex(f.baseFee) })
      case 'eth_getTransactionCount':
        return okr(toHex(req.params[1] === 'pending' ? f.pending : f.nonce))
      case 'eth_maxPriorityFeePerGas':
        return f.tip === null ? err(-32601, 'the method eth_maxPriorityFeePerGas does not exist') : okr(toHex(f.tip))
      case 'eth_call': {
        const call = req.params[0] as { from?: string; to: string; data: Hex }
        const d = decodeFunctionData({ abi: OPERATOR_ABI, data: call.data })
        if (d.functionName === 'nextId') return okr(encodeFunctionResult({ abi: OPERATOR_ABI, functionName: 'nextId', result: f.nextId }))
        if (d.functionName === 'getProposal')
          return okr(
            encodeFunctionResult({
              abi: OPERATOR_ABI,
              functionName: 'getProposal',
              result: { kind: 0, status: 1, proposer: OWNER, target: OWNER, value: 0n, codehash: ZERO32, dataHash: ZERO32, proposedBlock: f.newest, readyBlock: f.newest + 25n, vetoCount: 0n },
            }),
          )
        f.dryRuns.push({ from: String(call.from), data: call.data })
        return f.revert ? err(3, 'execution reverted: NotOwner') : okr(encodeFunctionResult({ abi: OPERATOR_ABI, functionName: 'proposeUpgrade', result: f.nextId }))
      }
      case 'eth_sendRawTransaction':
        f.sent.push(req.params[0])
        return f.sendError ? err(-32000, f.sendError) : okr(keccak256(req.params[0]))
    }
    return err(-32601, 'not in the fake')
  }) as typeof fetch
}
const cfg = (f: Fake, o: Partial<OperatorConfig> = {}): OperatorConfig => ({
  auth: 'token',
  token: TOKEN,
  ownerKey: () => OWNER_KEY,
  rpcUrls: [RPC_A, RPC_B],
  deployment: DEP,
  fetchFn: fakeFetch(f),
  ...o,
})
const auth = `Bearer ${TOKEN}`
const body = (card: string) => JSON.stringify({ card })
const SECRETS = [OWNER_KEY.slice(2).toLowerCase(), OTHER_KEY.slice(2).toLowerCase(), TOKEN.toLowerCase()]
const seen: string[] = []
const run = async (f: Fake, card: string, o: Partial<OperatorConfig> = {}, authorization: string | null = auth) => {
  const r = await propose({ authorization, body: body(card) }, cfg(f, o))
  seen.push(JSON.stringify(r))
  return r
}
const is = (r: ApiResult, status: number, error?: string) => r.status === status && (error === undefined || r.body.error === error)

async function main() {
  // ---------- 4. GET /api/operator ----------
  ok(JSON.stringify(operatorInfo(null)) === JSON.stringify({ enabled: false, auth: 'token', cards: [], cooldownBlocks: 0 }) && JSON.stringify(disabledInfo()) === JSON.stringify(operatorInfo(null)), 'not configured: {enabled:false, auth:"token", cards:[], cooldownBlocks:0}')
  const on = operatorInfo(cfg(fake()))
  ok(on.enabled && on.auth === 'token' && on.cards.join() === CARD_IDS.join() && on.cooldownBlocks === COOLDOWN_BLOCKS && COOLDOWN_BLOCKS === 3, 'configured: enabled, token auth, the seven cards, a 3-block cooldown')
  ok(operatorInfo(cfg(fake(), { auth: 'none', token: undefined })).auth === 'none' && operatorInfo(cfg(fake(), { auth: 'none', token: undefined })).enabled, 'local dev server: enabled with auth "none"')
  ok(
    !operatorInfo(cfg(fake(), { token: 'short' })).enabled &&
      !operatorInfo(cfg(fake(), { token: undefined })).enabled &&
      !operatorInfo(cfg(fake(), { ownerKey: () => undefined })).enabled &&
      !operatorInfo(cfg(fake(), { ownerKey: () => '0x1234' })).enabled &&
      !operatorInfo(cfg(fake(), { deployment: { ...DEP, pending: true } })).enabled,
    'off without a 32+ character token, without a well-formed key, or on the placeholder deployment',
  )

  // ---------- 5. POST /api/operator/propose: refusals that never touch the network ----------
  {
    const f = fake()
    const r401 = [await run(f, 'v2', {}, null), await run(f, 'v2', {}, `Bearer ${TOKEN.slice(0, -1)}${TOKEN.endsWith('0') ? '1' : '0'}`), await run(f, 'v2', {}, `Bearer ${TOKEN}x`), await run(f, 'v2', {}, TOKEN), await run(f, 'v2', {}, `Basic ${TOKEN}`)]
    ok(r401.every((r) => is(r, 401, 'unauthorized') && r.body.ok === false), '401 unauthorized: no header, a wrong token, a longer one, no "Bearer"')
    const r400 = [await run(f, 'evilMint'), await run(f, '0x4D959f981C01E3B81ac6C9A20E84816Fe5f6Bce3'), await run(f, ''), await propose({ authorization: auth, body: null }, cfg(f)), await propose({ authorization: auth, body: '{bad json' }, cfg(f))]
    ok(r400.every((r) => is(r, 400, 'unknown card')), '400 unknown card: another spelling, an address, empty, an oversized or broken body')
    const r401first = await run(f, 'not-a-card', {}, null)
    ok(is(r401first, 401), 'the token is checked before the card')
    ok(is(await run(f, 'evil-drain', { deployment: { ...DEP, impls: { ...DEP.impls, evilDrain: undefined } } }), 400, 'unknown card'), '400 for a card this deployment has no implementation for')
    const off = await run(f, 'v2', { ownerKey: () => undefined })
    ok(is(off, 403, 'disabled') && off.body.enabled === false, '403 disabled when the operator is off')
    const wrong = await run(f, 'v2', { ownerKey: () => OTHER_KEY })
    ok(is(wrong, 500, 'misconfigured'), '500 misconfigured: a key that is not the owner\'s')
    ok(f.calls.length === 0, `none of these reached the network (${f.calls.length} RPC calls)`)
  }

  // ---------- 6. checks against the chain ----------
  for (const [since, left] of [
    [0n, 3],
    [1n, 2],
    [2n, 1],
  ] as const) {
    resetOperatorState()
    const f = fake({ newest: 12_000_000n - since })
    const r = await run(f, 'evil-mint')
    ok(is(r, 409, 'cooldown') && r.body.retryAfterBlocks === left && f.sent.length === 0, `409 cooldown: newest proposal ${since} block(s) old -> retry after ${left}`)
  }
  {
    resetOperatorState()
    const f = fake({ newest: 12_000_000n - 3n })
    ok(is(await run(f, 'evil-mint'), 200) && f.sent.length === 1, 'newest proposal 3 blocks old: sent')
    resetOperatorState()
    const f1 = fake({ nextId: 1n })
    ok(is(await run(f1, 'v2'), 200) && f1.calls.filter((c) => c.method === 'eth_call').length === 2, 'no proposal yet (nextId 1): no cooldown read, sent')
  }
  {
    resetOperatorState()
    const f = fake({ pending: 41n })
    const r = await run(f, 'evil-fee')
    ok(is(r, 409, 'cooldown') && r.body.retryAfterBlocks === COOLDOWN_BLOCKS + 1 && f.sent.length === 0, '409 cooldown while the owner has a pending transaction')
  }
  {
    resetOperatorState()
    const f = fake({ chainId: 1 })
    ok(is(await run(f, 'v2'), 502, 'rpc') && f.sent.length === 0, '502 rpc: a node that is not Sepolia; nothing sent')
    resetOperatorState()
    const g = fake({ down: new Set([RPC_A, RPC_B]) })
    ok(is(await run(g, 'v2'), 502, 'rpc') && g.sent.length === 0, '502 rpc: every node down')
    resetOperatorState()
    const h = fake({ baseFee: 400_000_000_000n })
    ok(is(await run(h, 'v2'), 502, 'rpc') && h.sent.length === 0, '502 rpc: fees above the 500 gwei cap are never signed')
    resetOperatorState()
    const rv = fake({ revert: true })
    ok(is(await run(rv, 'remove-receiver'), 422, 'reverted') && rv.sent.length === 0 && rv.dryRuns.length === 1, '422 reverted: the dry run reverts, nothing is sent')
  }

  // ---------- 7. a send, for every card ----------
  for (const card of CARD_IDS) {
    resetOperatorState()
    const f = fake()
    const r = await run(f, card)
    const raw = f.sent[0] as TransactionSerializedEIP1559 | undefined
    const tx = raw ? parseTransaction(raw) : null
    const want = buildAction(card as CardId, DEP)!
    const signer = raw ? await recoverTransactionAddress({ serializedTransaction: raw }) : null
    ok(
      is(r, 200) &&
        r.body.ok === true &&
        r.body.card === card &&
        f.sent.length === 1 &&
        r.body.txHash === keccak256(raw!) &&
        tx?.type === 'eip1559' &&
        tx.chainId === 11155111 &&
        tx.to?.toLowerCase() === DEP.airlockAdmin.toLowerCase() &&
        tx.data === want.data &&
        (tx.value ?? 0n) === 0n &&
        tx.gas === GAS_LIMIT &&
        tx.nonce === 40 &&
        tx.maxPriorityFeePerGas === 2_000_000_000n &&
        tx.maxFeePerGas === 2n * 1_000_000_000n + 2_000_000_000n &&
        signer === OWNER &&
        f.dryRuns.length === 1 &&
        f.dryRuns[0].from.toLowerCase() === OWNER.toLowerCase() &&
        f.dryRuns[0].data === want.data,
      `${card}: one EIP-1559 tx from the owner to AirlockAdmin, exact calldata, gas 1,000,000, nonce from the node, fee 2*base + tip, dry run first; txHash returned`,
    )
  }
  {
    resetOperatorState()
    const f = fake({ down: new Set([RPC_A]) })
    ok(is(await run(f, 'v2'), 200) && f.calls.some((c) => c.url === RPC_B && c.method === 'eth_sendRawTransaction'), 'publicnode down: the fallback RPC is used')
    resetOperatorState()
    const t = fake({ tip: null })
    await run(t, 'v2')
    ok(parseTransaction(t.sent[0] as TransactionSerializedEIP1559).maxPriorityFeePerGas === MIN_PRIORITY_FEE, 'a node without eth_maxPriorityFeePerGas: the 1.5 gwei tip floor')
    resetOperatorState()
    const lo = fake({ tip: 1n })
    await run(lo, 'v2')
    ok(parseTransaction(lo.sent[0] as TransactionSerializedEIP1559).maxPriorityFeePerGas === MIN_PRIORITY_FEE, 'a tiny tip from the node is raised to the floor')
    resetOperatorState()
    const known = fake({ sendError: 'already known' })
    const rk = await run(known, 'v2')
    ok(is(rk, 200) && rk.body.txHash === keccak256(known.sent[0]), '"already known" from the node: the same signed tx is there, 200 with its hash')
    resetOperatorState()
    const funds = fake({ sendError: 'insufficient funds for gas * price + value' })
    ok(is(await run(funds, 'v2'), 502, 'rpc') && funds.sent.length === 2, 'a node that refuses the tx: the same bytes are tried on the fallback, then 502 rpc')
  }
  {
    // after a send, this isolate waits for the owner's nonce to move on
    resetOperatorState()
    const f = fake()
    ok(is(await run(f, 'evil-mint'), 200), 'first launch sent')
    const again = await run(f, 'evil-owner')
    ok(is(again, 409, 'cooldown') && f.sent.length === 1, 'a second launch before the first is mined: 409 cooldown (even when the node does not show it pending)')
    f.nonce = 41n
    f.pending = 41n
    f.newest = f.block
    f.block += 3n
    ok(is(await run(f, 'evil-owner'), 200) && f.sent.length === 2, 'once it is mined and 3 blocks old, the next launch goes')
    // two at once: the second sees the first in flight
    resetOperatorState()
    const g = fake()
    const [a, b] = await Promise.all([run(g, 'v2'), run(g, 'evil-mint')])
    ok([a, b].filter((r) => r.status === 200).length === 1 && [a, b].filter((r) => is(r, 409, 'cooldown')).length === 1 && g.sent.length === 1, 'two launches at the same moment: one is sent, the other gets 409')
  }

  // ---------- 8. the Cloudflare handlers ----------
  {
    const url = 'https://airlock.example/api/operator'
    const info = await handleInfoRequest(new Request(url), {})
    const j = await info.json()
    ok(info.status === 200 && JSON.stringify(j) === JSON.stringify(disabledInfo()), 'Function GET without secrets: 200 {enabled:false, ...}')
    ok(info.headers.get('content-type')?.startsWith('application/json') && info.headers.get('cache-control') === 'no-store' && info.headers.get('x-content-type-options') === 'nosniff', 'Function responses: JSON, no-store, nosniff')
    ok(!(await (await handleInfoRequest(new Request(url), { OWNER_KEY: OWNER_KEY })).json()).enabled && !(await (await handleInfoRequest(new Request(url), { OPERATOR_TOKEN: TOKEN })).json()).enabled, 'Function GET with only one of the two secrets: off')
    const env = { OWNER_KEY: OTHER_KEY.slice(2), OPERATOR_TOKEN: TOKEN }
    const jon = await (await handleInfoRequest(new Request(url), env)).json()
    ok(jon.enabled === true && jon.auth === 'token' && jon.cards.length === availableCards(DEPLOYMENT).length && jon.cooldownBlocks === 3, 'Function GET with both secrets (key without 0x): enabled, token auth')
    const put = await handleInfoRequest(new Request(url, { method: 'PUT' }), env)
    ok(put.status === 405 && put.headers.get('allow') === 'GET', 'Function GET route: 405 for PUT, Allow: GET')
    const purl = url + '/propose'
    const pget = await handleProposeRequest(new Request(purl), env)
    ok(pget.status === 405 && pget.headers.get('allow') === 'POST', 'Function propose route: 405 for GET, Allow: POST')
    const post = (h: Record<string, string>, b: string) => handleProposeRequest(new Request(purl, { method: 'POST', headers: h, body: b }), env)
    const noAuth = await post({ 'content-type': 'application/json' }, body('v2'))
    ok(noAuth.status === 401 && (await noAuth.json()).error === 'unauthorized', 'Function POST without the token: 401')
    const foreign = await post({ authorization: auth, origin: 'https://evil.example' }, body('v2'))
    ok(foreign.status === 403, 'Function POST from a foreign Origin: 403')
    const big = await post({ authorization: auth, origin: 'https://airlock.example' }, `{"card":"v2","pad":"${'x'.repeat(2 * MAX_BODY_BYTES)}"}`)
    ok(big.status === 400, 'Function POST with an oversized body: 400 (not read past the cap)')
    const bad = await post({ authorization: auth }, body('drain-everything'))
    ok(bad.status === 400 && (await bad.json()).error === 'unknown card', 'Function POST with an unknown card: 400')
    const dummy = await post({ authorization: auth }, body('v2'))
    ok(dummy.status === 500 && (await dummy.json()).error === 'misconfigured' && trapped === 0, 'Function POST with a key that is not the owner\'s: 500 misconfigured, before any network call')
    ok(cloudConfig({ OWNER_KEY: 'k' }) === null && cloudConfig({ OPERATOR_TOKEN: 't' }) === null && cloudConfig({ OWNER_KEY: 'k', OPERATOR_TOKEN: 't' })?.auth === 'token', 'cloudConfig needs both secrets')
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(400).fill(65))
        c.close()
      },
    })
    const capped = await readCapped(new Request(purl, { method: 'POST', body: stream, duplex: 'half' } as RequestInit))
    ok(capped === null, 'a streamed body over the cap is cut off (no content-length needed)')
  }

  // ---------- 9. nothing secret, nothing local ----------
  {
    const all = seen.join('\n').toLowerCase()
    ok(SECRETS.every((s) => !all.includes(s)), `no response carries the key or the token (${seen.length} responses)`)
    ok(!/execution reverted|fetch failed|insufficient|already known|notowner|does not exist|trapped/i.test(seen.join('\n')), 'no response carries a node\'s or the runtime\'s error text')
    const errors = new Set(seen.map((s) => JSON.parse(s).body.error).filter(Boolean))
    ok([...errors].every((e) => ['unauthorized', 'unknown card', 'cooldown', 'rpc', 'disabled', 'reverted', 'misconfigured'].includes(e)), `error strings are fixed words only: ${[...errors].join(', ')}`)
    ok(DEFAULT_RPCS.join() === 'https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org', 'default RPCs: publicnode, then drpc')
    const files = [...['cards.ts', 'operator.ts', 'cloud.ts', 'deployment.generated.ts'].map((f) => join(WEB, 'operator', f)), join(WEB, 'functions', 'api', 'operator', 'index.ts'), join(WEB, 'functions', 'api', 'operator', 'propose.ts'), join(WEB, 'vite.config.ts')]
    const hits = files.flatMap((f) => findBlocked(readFileSync(f, 'utf8')).map((h) => `${f.slice(WEB.length + 1)}: ${h}`))
    ok(hits.length === 0, `operator sources are clean of blocked names and local paths (${NAMES_NOTE})${hits.length ? ': ' + hits.join('; ') : ''}`)
    ok(readdirSync(join(WEB, 'functions', 'api', 'operator')).sort().join() === 'index.ts,propose.ts', 'functions/api/operator holds exactly the two routes')
    ok(files.slice(0, 6).every((f) => !/from ['"]node:/.test(readFileSync(f, 'utf8'))), 'operator/ and functions/ import no node: modules (they run on Workers)')
    ok(trapped === 0, `the real fetch was never called (${trapped})`)
  }
}

main()
  .catch((e) => {
    console.log(`FAIL crashed: ${e instanceof Error ? e.message : String(e)}`)
    fails++
  })
  .finally(() => {
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    process.exit(fails ? 1 : 0)
  })
