#!/usr/bin/env node
// Deployment JSON (script/DeployEth.s.sol) -> CRE workflow config (the fields of cre/veto/config.ts).
//
//   bun scripts/sepolia/make-config.mjs [deployment.json] [--out file] [--providers a,b,c] [--rpc label=url ...]
//   (node runs it too, but only bun can load cre/veto/config.ts to check the result against the workflow's schema)
//   FORK=19631 bun scripts/sepolia/make-config.mjs       # the fork rehearsal's config, written to $TMPDIR
//   bun scripts/sepolia/make-config.mjs --example
//
// Defaults: deployments/sepolia.json -> cre/veto/config.sepolia.json, with four independent providers
// (publicnode, drpc, thirdweb, 1rpc) and minAgree 2: at least two must answer and every answer must agree
// (cre/veto/judge.ts). 1rpc is kept although it is often rate-limited (an error only costs a little time).
//   --providers list a comma-separated pick of the known providers: publicnode, drpc, thirdweb, 1rpc, 0xrpc
//                    (e.g. publicnode,drpc,thirdweb; probe them first with probe-rpcs.ts)
//   --rpc label=url  any provider by URL (repeat it; replaces --providers)
//   --min-agree n    quorum size (default 2)
//   --fork-rpc url   every provider points at one local fork (--out is then required, so the fork config never
//                    lands in the repo). FORK=<port> sets it, the fork deployment and the output in $TMPDIR.
//   --example        writes cre/veto/config.sepolia.example.json with placeholder addresses (commit-safe)
//   --sweep-schedule cron schedule of the sweeper trigger (default "0 * * * * *": every 60 s; CRE runs a cron at most every 30 s)
//   --sweep-window n how many of the newest proposal ids each sweep looks at (default 20)
// The result is checked against the workflow's own zod schema (cre/veto/config.ts) when it can be loaded.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const die = (msg) => {
  console.error(`make-config: ${msg}`)
  process.exit(1)
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SEPOLIA = 11155111
// Public Sepolia endpoints that accept JSON-RPC batches with eth_simulateV1 (checked with probe-rpcs.ts).
const KNOWN_RPCS = {
  publicnode: 'https://ethereum-sepolia-rpc.publicnode.com',
  drpc: 'https://sepolia.drpc.org',
  thirdweb: 'https://11155111.rpc.thirdweb.com',
  '1rpc': 'https://1rpc.io/sepolia',
  '0xrpc': 'https://0xrpc.io/sep',
}
const pick = (labels) =>
  labels.map((label) => {
    if (!KNOWN_RPCS[label]) die(`unknown provider "${label}" (known: ${Object.keys(KNOWN_RPCS).join(', ')}; or use --rpc label=url)`)
    return { url: KNOWN_RPCS[label], label }
  })
const DEFAULT_RPCS = pick(['publicnode', 'drpc', 'thirdweb', '1rpc'])
// Same values the fork E2E (cre/scripts/fork-e2e.sh) runs with.
const TUNING = {
  strict: false,
  callGas: 1_000_000,
  readGas: 200_000,
  maxCalls: 150, // simulated calls per eth_simulateV1 request: the demo token's probes go out as two requests
  simRequests: 2, // eth_simulateV1 requests per provider: 1 + 2 HTTP calls each, 12 of the 15 per run with four
  allowedOpcodes: [], // R9: no opcode is exempt; only an approved codehash is
  gasLimit: '2000000',
  reportGraceBlocks: 50,
  logConfidence: 'LATEST', // the workflow accepts no other value
}
// The sweeper (trigger 1): judges proposals the log trigger missed. Field names as in cre/veto/config.ts.
const SWEEP = { schedule: '0 * * * * *', window: 20 }
// DeployEth.s.sol's keyless demo holders: keccak256("upgrade-airlock/demo-holder/<i>"), identical on every deployment.
const DEMO_HOLDERS = [
  '0x50D70Ff5338289b11E91A0fF5336DB29BDd510e0',
  '0x01B22bF1E81f3563727E0F7BD6c2415B87136Da5',
  '0x22421cA36b30D2D4Db5c32fEd40505530D52Ea22',
]

const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const isUrl = (u) => /^https?:\/\/[^\s]+$/.test(u)

function parseArgs(argv) {
  const o = { input: null, out: null, forkRpc: null, rpcs: [], providers: null, minAgree: 2, example: false, sweepSchedule: SWEEP.schedule, sweepWindow: SWEEP.window }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i] ?? die(`${a} needs a value`)
    if (a === '--out') o.out = next()
    else if (a === '--fork-rpc') o.forkRpc = next()
    else if (a === '--rpc') {
      const v = next()
      const eq = v.indexOf('=')
      if (eq < 1) die(`--rpc wants label=url, got "${v}"`)
      o.rpcs.push({ label: v.slice(0, eq), url: v.slice(eq + 1) })
    } else if (a === '--providers') o.providers = next().split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--min-agree') o.minAgree = Number(next())
    else if (a === '--example') o.example = true
    else if (a === '--sweep-schedule') o.sweepSchedule = next()
    else if (a === '--sweep-window') o.sweepWindow = Number(next())
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 21).join('\n'))
      process.exit(0)
    } else if (a.startsWith('-')) die(`unknown option ${a}`)
    else if (!o.input) o.input = a
    else die(`unexpected argument ${a}`)
  }
  return o
}

function fromDeployment(d, o, rpcs) {
  if (Number(d.chainId) !== SEPOLIA) die(`deployment chainId is ${d.chainId}, expected ${SEPOLIA} (Sepolia)`)
  for (const k of ['airlockAdmin', 'receiver', 'proxy', 'owner']) if (!isAddr(d[k])) die(`deployment has no valid "${k}"`)
  if (!Array.isArray(d.holders) || !d.holders.length || !d.holders.every(isAddr)) die('deployment has no valid "holders"')
  return {
    chainSelectorName: 'ethereum-testnet-sepolia',
    chainId: SEPOLIA,
    airlockAdmin: d.airlockAdmin,
    receiver: d.receiver,
    proxy: d.proxy,
    holders: d.holders,
    watch: [d.owner, d.airlockAdmin], // the workflow adds every holder to the watch list itself
    rpcs,
    minAgree: o.minAgree,
    ...TUNING,
    sweepSchedule: o.sweepSchedule,
    sweepWindow: o.sweepWindow,
  }
}

function check(cfg) {
  if (!Number.isInteger(cfg.minAgree) || cfg.minAgree < 1) die('minAgree must be a positive integer')
  if (!Number.isInteger(cfg.sweepWindow) || cfg.sweepWindow < 1) die('--sweep-window must be a positive integer')
  if (cfg.sweepSchedule.trim().split(/\s+/).length < 5) die(`--sweep-schedule "${cfg.sweepSchedule}" is not a cron expression`)
  if (cfg.rpcs.length < cfg.minAgree) die(`${cfg.rpcs.length} providers cannot reach a ${cfg.minAgree}-provider quorum`)
  if (cfg.rpcs.length > 5) die('at most 5 providers (cre/veto/config.ts)')
  for (const r of cfg.rpcs) if (!isUrl(r.url) || !r.label) die(`bad provider ${JSON.stringify(r)}`)
  const labels = new Set(cfg.rpcs.map((r) => r.label))
  if (labels.size !== cfg.rpcs.length) die('provider labels must be unique')
}

async function schemaCheck(cfg) {
  // The workflow's own schema; needs the workflow deps (cre/setup.sh) and a TypeScript-capable runtime (bun, node >= 22.18).
  try {
    const { configSchema } = await import(resolve(ROOT, 'cre/veto/config.ts'))
    const r = configSchema.safeParse(cfg)
    if (!r.success) die(`config does not match cre/veto/config.ts: ${r.error.message}`)
    return 'checked against cre/veto/config.ts'
  } catch (e) {
    if (e?.code === 'ERR_UNKNOWN_FILE_EXTENSION' || e?.code === 'ERR_MODULE_NOT_FOUND') return 'schema not loaded (run with bun to check it)'
    throw e
  }
}

const show = (p) => (isAbsolute(p) && !relative(ROOT, p).startsWith('..') ? relative(ROOT, p) : p)

const o = parseArgs(process.argv.slice(2))
let cfg
let out
if (o.example) {
  const ph = (n) => `0x${n.repeat(40)}`
  cfg = {
    chainSelectorName: 'ethereum-testnet-sepolia',
    chainId: SEPOLIA,
    airlockAdmin: ph('1'), // AirlockAdmin (deployments/sepolia.json: airlockAdmin)
    receiver: ph('2'), // AirlockReceiver (clearance oracle and guardian)
    proxy: ph('3'), // the DemoBTC proxy
    holders: DEMO_HOLDERS,
    watch: [ph('4'), ph('1')], // [owner, airlockAdmin]
    rpcs: DEFAULT_RPCS,
    minAgree: 2,
    ...TUNING,
    sweepSchedule: o.sweepSchedule,
    sweepWindow: o.sweepWindow,
  }
  out = resolve(ROOT, o.out ?? 'cre/veto/config.sepolia.example.json')
} else {
  if (process.env.FORK) {
    if (!/^\d{2,5}$/.test(process.env.FORK)) die('FORK must be a port number')
    const state = resolve((process.env.TMPDIR || '/tmp').replace(/\/$/, ''), `upgrade-airlock-fork-${process.env.FORK}`)
    o.input ??= resolve(state, 'deployment.json')
    o.forkRpc ??= `http://127.0.0.1:${process.env.FORK}`
    o.out ??= resolve(state, 'config.fork.json')
  }
  const input = resolve(o.input ?? resolve(ROOT, 'deployments/sepolia.json'))
  if (!existsSync(input)) die(`no deployment JSON at ${show(input)} (run scripts/sepolia/deploy.sh first)`)
  let d
  try {
    d = JSON.parse(readFileSync(input, 'utf8'))
  } catch (e) {
    die(`${show(input)} is not JSON: ${e.message}`)
  }
  let rpcs = o.rpcs.length ? o.rpcs : o.providers ? pick(o.providers) : DEFAULT_RPCS
  if (o.forkRpc) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o.forkRpc)) die('--fork-rpc must be http://127.0.0.1:<port>')
    if (!o.out) die('--fork-rpc needs --out (keep the fork config outside the repo)')
    rpcs = ['fork-a', 'fork-b', 'fork-c'].map((label) => ({ url: o.forkRpc, label }))
  }
  cfg = fromDeployment(d, o, rpcs)
  out = resolve(o.out ?? resolve(ROOT, 'cre/veto/config.sepolia.json'))
}
check(cfg)
const how = await schemaCheck(cfg)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`)
console.log(`wrote ${show(out)} (${how})`)
console.log(`  airlockAdmin ${cfg.airlockAdmin}  receiver ${cfg.receiver}  proxy ${cfg.proxy}`)
console.log(`  providers ${cfg.rpcs.map((r) => `${r.label}=${r.url}`).join('  ')}  quorum ${cfg.minAgree}-of-${cfg.rpcs.length}`)
console.log(`  sweeper "${cfg.sweepSchedule}" over the last ${cfg.sweepWindow} proposal ids`)
