#!/usr/bin/env bun
// Read-only provider check for the CRE clearance workflow: runs the workflow's own judging code against each RPC
// provider (cre/veto/judge.ts judgeOnProvider: eth_getCode, the attack simulation in 1 to simRequests eth_simulateV1
// requests, R9 on the fetched code; the JSON-RPC bodies come from workflow.ts httpRpcBatch), then the workflow's
// quorum, with curl as the transport instead of the CRE HTTP capability, and times every request. The static rules
// (R5, R8) and approvals are not read: every case is judged as an unapproved upgrade without init data. The test
// holder and the holder that funds the stranger are picked as the workflow picks them.
//
//   bun scripts/sepolia/probe-rpcs.ts                          # the live deployment (deployments/sepolia.json):
//                                                              #   evilMint/evilOwner/evilFee/evilBaseFee/evilDrain/v2
//                                                              #   must give R1/R2/R3/R9/R3B/pass
//   bun scripts/sepolia/probe-rpcs.ts --proxy <erc1967 proxy> --impl <implementation> --holder <address>[,<address>]
//                                                              # before the deployment: any ERC-1967 token proxy; the
//                                                              #   second holder, if any, funds the stranger
// Options: --deployment file, --config file (providers and tuning; default cre/veto/config.sepolia.json, else the
//          built-in four), --rpc label=url (repeat; replaces the providers), --repeat n, --max-calls n, --block n,
//          --json file (raw measurements). FORK=<port> picks the fork deployment and points three providers at it.
// Nothing is sent: eth_getCode, eth_call, eth_simulateV1 and block reads only.
// Exit status 0 when every quorum verdict is the expected one (with a deployment), every request fits the CRE size
// limits and the providers fit the 15 HTTP calls of one run; providers that fail are listed but do not fail the
// probe while the quorum holds.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const VETO = resolve(ROOT, 'cre/veto')
const { judgeOnProvider, quorum, consensusValue } = await import(resolve(VETO, 'judge.ts'))
const { httpRpcBatch } = await import(resolve(VETO, 'workflow.ts'))
const { proposalActors } = await import(resolve(VETO, 'simulate.ts'))
const { stableStringify } = await import(resolve(VETO, 'report.ts'))
const { keccak256 } = await import(Bun.resolveSync('viem', VETO))

// cre workflow limits export (CRE CLI v1.37.0): HTTPAction and Consensus
const LIMITS = { httpCalls: 15, requestBytes: 120_000, responseBytes: 250_000, timeoutMs: 10_000, observationBytes: 25_000 }
const DEFAULT_RPCS = [
  { url: 'https://ethereum-sepolia-rpc.publicnode.com', label: 'publicnode' },
  { url: 'https://sepolia.drpc.org', label: 'drpc' },
  { url: 'https://11155111.rpc.thirdweb.com', label: 'thirdweb' },
  { url: 'https://1rpc.io/sepolia', label: '1rpc' },
]
const EXPECT: Record<string, string> = {
  evilMint: 'R1_TOTAL_SUPPLY',
  evilOwner: 'R2_OWNER',
  evilFee: 'R3_TRANSFER_CONSERVATION',
  evilBaseFee: 'R9_NEW_OPCODES',
  evilDrain: 'R3B_THIRD_PARTY_FUNDS',
  v2: 'pass',
}

type Rpc = { url: string; label: string }
type Metric = { provider: string; case: string; round: number; batch: string; http: number; ms: number; ttfbMs: number; reqBytes: number; respBytes: number; simCalls?: number; override?: string; error?: string }

const die = (m: string): never => {
  console.error(`probe-rpcs: ${m}`)
  process.exit(2)
}

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const opt: Record<string, string> = {}
const rpcArgs: Rpc[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) die(`unexpected argument ${a}`)
  const v = argv[++i] ?? die(`${a} needs a value`)
  if (a === '--rpc') {
    const eq = v.indexOf('=')
    if (eq < 1) die('--rpc wants label=url')
    rpcArgs.push({ label: v.slice(0, eq), url: v.slice(eq + 1) })
  } else opt[a.slice(2)] = v
}
const fork = process.env.FORK
const tmpBase = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
const forkState = fork ? join(tmpBase, `upgrade-airlock-fork-${fork}`) : null
const repeat = Number(opt.repeat ?? 1)

let config: any = null
const cfgPath = opt.config ?? resolve(VETO, 'config.sepolia.json')
if (opt.config || (!fork && existsSync(cfgPath))) config = JSON.parse(readFileSync(cfgPath, 'utf8'))
let rpcs: Rpc[] = rpcArgs.length ? rpcArgs : config?.rpcs ?? DEFAULT_RPCS
if (fork && !rpcArgs.length) rpcs = ['fork-a', 'fork-b', 'fork-c'].map((label) => ({ label, url: `http://127.0.0.1:${fork}` }))
const minAgree = Number(config?.minAgree ?? 2)
const tuning = {
  callGas: config?.callGas ?? 1_000_000,
  readGas: config?.readGas ?? 200_000,
  maxCalls: Number(opt['max-calls'] ?? config?.maxCalls ?? 150),
  simRequests: Number(config?.simRequests ?? 2),
  allowedOpcodes: (config?.allowedOpcodes ?? []) as string[],
}

// ---------------------------------------------------------------- transport (curl, synchronous like the CRE capability)
const work = mkdtempSync(join(tmpBase, 'airlock-probe-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
const metrics: Metric[] = []
let current = { provider: '', case: '', round: 0 }

function curl(url: string, body: Uint8Array) {
  const out = join(work, 'resp')
  const p = Bun.spawnSync(['curl', '-sS', '-m', '30', '-o', out, '-w', '%{http_code} %{time_total} %{time_starttransfer}', '-H', 'content-type: application/json', '--data-binary', '@-', url], { stdin: body })
  const [code, total, ttfb] = new TextDecoder().decode(p.stdout).trim().split(' ')
  const resp = existsSync(out) ? readFileSync(out) : new Uint8Array()
  rmSync(out, { force: true })
  return { statusCode: Number(code) || 0, body: new Uint8Array(resp), ms: Math.round(Number(total) * 1000), ttfbMs: Math.round(Number(ttfb) * 1000), err: p.exitCode ? new TextDecoder().decode(p.stderr).trim() : '' }
}

const batchOk = (body: Uint8Array, n: number) => {
  try {
    const j = JSON.parse(new TextDecoder().decode(body))
    return Array.isArray(j) && j.length === n && j.every((x) => x.result !== undefined)
  } catch {
    return false
  }
}
const timedSend = (req: { url: string; method: string; headers: Record<string, string>; body: string }) => {
  const body = Buffer.from(req.body, 'base64')
  const calls = JSON.parse(body.toString('utf8')) as { method: string; params: any[] }[]
  const r = curl(req.url, body)
  const sim = calls.find((c) => c.method === 'eth_simulateV1')
  const ovr = sim ? Object.values(sim.params[0].blockStateCalls[0].stateOverrides ?? {}).map((o: any) => Object.keys(o).join('+')).join(',') : undefined
  metrics.push({
    ...current,
    batch: calls.map((c) => c.method.replace(/^eth_/, '')).join('+'),
    http: r.statusCode,
    ms: r.ms,
    ttfbMs: r.ttfbMs,
    reqBytes: body.length,
    respBytes: r.body.length,
    simCalls: sim ? sim.params[0].blockStateCalls[0].calls.length : undefined,
    override: ovr,
    error: r.err || (r.statusCode !== 200 || !batchOk(r.body, calls.length) ? new TextDecoder().decode(r.body).slice(0, 160) : undefined),
  })
  return { statusCode: r.statusCode, body: r.body }
}
const rpcBatch = httpRpcBatch(timedSend)

// plain single calls for setup (not measured)
function call(url: string, method: string, params: unknown[]): any {
  const r = curl(url, new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })))
  const j = JSON.parse(new TextDecoder().decode(r.body) || '{}')
  if (j.error || j.result === undefined) die(`${method} on ${url}: ${j.error?.message ?? r.err ?? 'no result'}`)
  return j.result
}
const balanceOf = (url: string, token: string, who: string, tag: string) =>
  BigInt(call(url, 'eth_call', [{ to: token, data: `0x70a08231${who.slice(2).toLowerCase().padStart(64, '0')}` }, tag]))

// ---------------------------------------------------------------- what to judge
type Case = { name: string; impl: string; expect?: string }
let proxy: string
let holders: string[]
let watch: string[]
let actorAnchor: string
let cases: Case[]
const depPath = opt.deployment ?? (forkState ? join(forkState, 'deployment.json') : resolve(ROOT, 'deployments/sepolia.json'))
if (opt.proxy) {
  if (!opt.impl || !opt.holder) die('--proxy needs --impl and --holder')
  proxy = opt.proxy
  holders = opt.holder.split(',').map((h) => h.trim()).filter(Boolean)
  watch = []
  actorAnchor = opt.proxy
  cases = [{ name: 'impl', impl: opt.impl }]
} else {
  if (!existsSync(depPath)) die(`no deployment at ${depPath}; use --proxy/--impl/--holder before the deployment`)
  const d = JSON.parse(readFileSync(depPath, 'utf8'))
  if (!d.airlockAdmin) die(`${depPath} has no airlockAdmin, so it is not a deployment of this stack (deploy it with deploy.sh)`)
  proxy = d.proxy
  holders = d.holders
  watch = config?.watch ?? [d.owner, d.airlockAdmin]
  actorAnchor = d.airlockAdmin
  cases = Object.keys(EXPECT)
    .filter((k) => d[k])
    .map((k) => ({ name: k, impl: d[k], expect: EXPECT[k] }))
}

const ref = rpcs[0].url
const head = BigInt(call(ref, 'eth_blockNumber', []))
const block = opt.block ? BigInt(opt.block) : head - 2n // a block every provider already has
const tag = `0x${block.toString(16)}`
const blockHash = call(ref, 'eth_getBlockByNumber', [tag, false]).hash as `0x${string}`
// As the workflow does (cre/veto/airlock.ts judgeProposal): the first holder with a balance makes the test transfer,
// the next one with a balance funds the stranger with the test amount (capped at its balance).
const balances = holders.map((h) => balanceOf(ref, proxy, h, tag))
const hk = balances.findIndex((b) => b > 0n)
if (hk < 0) die('no holder with a balance at the probe block')
const holder = holders[hk].toLowerCase()
const bal = balances[hk]
const amount = bal / 100n > 0n ? bal / 100n : 1n
const fk = balances.findIndex((b, i) => b > 0n && i !== hk && holders[i].toLowerCase() !== holder)
const funder = fk >= 0 ? holders[fk].toLowerCase() : null
const fundAmount = fk >= 0 ? (balances[fk] < amount ? balances[fk] : amount) : 0n
const { stranger, receiver } = proposalActors(11155111n, actorAnchor.toLowerCase(), 0n, blockHash)
console.log(`probe block ${block} (head ${head}); proxy ${proxy}; holder ${holder}; stranger funded by ${funder ?? 'nobody (one funded holder)'}; providers ${rpcs.map((r) => r.label).join(', ')}; ${repeat} round(s)`)

// ---------------------------------------------------------------- run
// Blocking: a quorum verdict that is not the expected one, or a batch over a CRE size limit (identical on every
// provider). Not blocking: a single provider failing, as long as the quorum still holds (it costs time, not a verdict).
let blocking = 0
const providerFails = new Map<string, number>()
const rows: string[] = []
for (let round = 1; round <= repeat; round++) {
  for (const c of cases) {
    const code = call(ref, 'eth_getCode', [c.impl, tag]) as `0x${string}`
    const ctx = {
      proxy: proxy.toLowerCase(),
      newImpl: c.impl.toLowerCase(),
      codehash: keccak256(code),
      hasInitData: false,
      block,
      holder,
      amount,
      funder,
      fundAmount,
      holders: holders.map((a) => a.toLowerCase()),
      watch: watch.map((a) => a.toLowerCase()),
      stranger,
      receiver,
      strict: false,
      codehashApproved: false,
      dataApproved: false,
      ...tuning,
    }
    const outcomes = []
    for (const p of rpcs) {
      current = { provider: p.label, case: c.name, round }
      const t0 = performance.now()
      const o = judgeOnProvider(rpcBatch, p.url, p.label, ctx)
      const wall = Math.round(performance.now() - t0)
      outcomes.push(o)
      const got = o.verdict === 'error' ? `error: ${o.error.slice(0, 90)}` : o.verdict === 'pass' ? 'pass' : (o.rule as string)
      // without an expectation (a foreign proxy) any answer counts, except R6 from a simulation that never ran
      const ok = o.verdict !== 'error' && (c.expect ? got === c.expect : got !== 'R6_SIM_FAILURE')
      if (!ok) providerFails.set(p.label, (providerFails.get(p.label) ?? 0) + 1)
      const why = o.verdict !== 'error' && o.rule === 'R6_SIM_FAILURE' ? ` [${o.checks.find((k: any) => !k.ok)?.after ?? ''}]` : ''
      const ms = metrics.filter((m) => m.provider === p.label && m.case === c.name && m.round === round)
      rows.push(`${ok ? 'ok  ' : 'FAIL'} r${round} ${c.name.padEnd(11)} ${p.label.padEnd(10)} ${got.padEnd(26)} ${ms.map((m) => `${m.batch} ${m.ms}ms`).join(' | ')}  (judge ${wall}ms)${why}`)
    }
    const v = quorum(outcomes, minAgree)
    const obs = stableStringify(consensusValue(v)).length
    const qGot = v.verdict === 'pass' ? 'pass' : (v.rule as string)
    const qOk = (c.expect ? qGot === c.expect : qGot !== 'R6_SIM_FAILURE') && obs <= LIMITS.observationBytes
    if (!qOk) blocking++
    const answered = outcomes.filter((o: any) => o.verdict !== 'error').length
    rows.push(`${qOk ? 'ok  ' : 'FAIL'} r${round} ${c.name.padEnd(11)} QUORUM     ${qGot.padEnd(26)} ${answered}/${outcomes.length} providers answered (min ${minAgree}); consensus observation ${obs} bytes`)
  }
}
for (const r of rows) console.log(r)

// ---------------------------------------------------------------- summary per provider and batch
const pct = (xs: number[], q: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
console.log('\nprovider   batch                      n  min/median/max ms   ttfb med  max req B  max resp B  sim calls  override')
for (const p of rpcs) {
  for (const b of [...new Set(metrics.filter((m) => m.provider === p.label).map((m) => m.batch))]) {
    const ms = metrics.filter((m) => m.provider === p.label && m.batch === b)
    const t = ms.map((m) => m.ms)
    const req = Math.max(...ms.map((m) => m.reqBytes))
    const resp = Math.max(...ms.map((m) => m.respBytes))
    const sim = [...new Set(ms.map((m) => m.simCalls).filter((x) => x !== undefined))].join('/')
    const errs = ms.filter((m) => m.error || m.http !== 200)
    const sizes = [req > LIMITS.requestBytes && 'REQUEST>120kb', resp > LIMITS.responseBytes && 'RESPONSE>250kb'].filter(Boolean)
    if (sizes.length) blocking++
    const slow = ms.filter((m) => m.ms > LIMITS.timeoutMs).length
    if (slow) providerFails.set(p.label, (providerFails.get(p.label) ?? 0) + slow)
    const over = [...sizes, slow && `${slow} slower than 10 s`, errs.length && `${errs.length} failed: ${errs[0].error?.replace(/\s+/g, ' ').slice(0, 90)}`].filter(Boolean)
    console.log(
      `${p.label.padEnd(10)} ${b.padEnd(26)} ${String(ms.length).padStart(2)}  ${`${Math.min(...t)}/${pct([...t], 0.5)}/${Math.max(...t)}`.padEnd(18)} ${String(pct(ms.map((m) => m.ttfbMs), 0.5)).padStart(8)}  ${String(req).padStart(9)}  ${String(resp).padStart(10)}  ${(sim || '-').padStart(9)}  ${ms[0].override ?? '-'}${over.length ? `  !! ${over.join(', ')}` : ''}`,
    )
  }
}
// HTTP calls of one upgrade judgement: per provider eth_getCode, then 1 to simRequests eth_simulateV1 requests (as
// many as the probes need). The workflow refuses a config whose worst case exceeds the per-run limit.
const perProposalMax = (1 + tuning.simRequests) * rpcs.length
const perCase = new Map<string, number>()
for (const m of metrics) perCase.set(`${m.case}#${m.round}`, (perCase.get(`${m.case}#${m.round}`) ?? 0) + 1)
const perProposalUsed = Math.max(0, ...perCase.values())
if (perProposalMax > LIMITS.httpCalls) blocking++
console.log(
  `\nHTTP calls per upgrade: at most ${perProposalMax} (${rpcs.length} providers x (1 + ${tuning.simRequests})), ${perProposalUsed} in the largest case here; CRE limit ${LIMITS.httpCalls} per run${perProposalMax > LIMITS.httpCalls ? '  !! over the limit' : ''}`,
)
console.log(`request <= ${LIMITS.requestBytes} B, response <= ${LIMITS.responseBytes} B, ${LIMITS.timeoutMs / 1000} s per call`)
if (opt.json) writeFileSync(opt.json, JSON.stringify({ block: block.toString(), rpcs, metrics }, null, 2))
const flaky = [...providerFails.entries()].map(([l, n]) => `${l} (${n} of ${repeat * cases.length} runs)`).join(', ')
if (blocking) console.log(`PROBE: FAIL, ${blocking} blocking problem(s)${flaky ? `; failing providers: ${flaky}` : ''}`)
else if (flaky) console.log(`PROBE: QUORUM OK, every verdict as expected; failing providers: ${flaky}`)
else console.log('PROBE: ALL OK')
process.exit(blocking ? 1 : 0)
