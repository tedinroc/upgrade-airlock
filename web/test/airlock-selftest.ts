// Live-mode self-test (?mode=airlock): no browser and no network. JSON-RPC is answered by the fake Sepolia below
// (eth_getLogs refuses ranges over 50 blocks, like 1rpc); WebSocket is a stand-in that never connects.
// The deployment is test/fixtures/chain-data.json (see test/rolldown.config.mjs).   npm run selftest
import { NoSocket } from './airlock-stub'
import { installDom } from './domstub'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  toEventSelector,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Hex,
} from 'viem'
import { ADMIN_ABI, RECEIVER_ABI } from '../src/abi'
import { airlockView, fmtDur, startTitle } from '../src/airlock'
import { blocks } from '../src/chain'
import { DATA, PENDING, type RawLog } from '../src/chaindata'
import { chainHealth, startChainWatch, TOPICS } from '../src/chainwatch'
import { CONFIG } from '../src/config'
import { explorerUrl, fmtEth, fmtGasPrice } from '../src/derive'
import { blockTs, handleLog } from '../src/events'
import { DICT, setLang, t, type Lang } from '../src/i18n'
import { replay } from '../src/playback'
import { AutoReplay, buildTimeline, snapshotAt } from '../src/replay'
import { CHAIN, chainWithRpc, FORK, GUARDS, isLoopback, MODE, OFFLINE, parseRpcOverride, pickMode } from '../src/runtime'
import { newProposal, store, type Proposal } from '../src/store'
import { ruleHashOf } from '../src/types'
import { render, ui } from '../src/ui'
import { findBlocked, NAMES_NOTE, scanWeb } from './scan'

let fails = 0
function ok(cond: unknown, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) fails++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms: number) {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await sleep(20)
  return fn()
}
const CJK = /[㐀-鿿　-〿＀-￯]/
/** Simplified-only characters that must never show up in zh-TW */
const SIMPLIFIED_ONLY = /[区块链测试网报这个为发时间实现评题机连线执务应总转账没权变态错误载读据击两导点让说计规则节预开关显设证资产处数长额签码详图际断续单传备换认话该调钥钱闭难页验类给满离线异议级气闸门舱弹还后录确锁扫]/
const WEB = process.cwd()
const REPO = join(WEB, '..')

// ---------- 1. modes and Sepolia settings ----------
ok(MODE === 'airlock' && !OFFLINE && !FORK, 'default mode is the live airlock (no fork, not offline)')
ok(['offline', 'airlock'].every((m) => pickMode(m) === m) && ['chain', 'testnet', 'fake', 'replay', 'x', '', null].every((m) => pickMode(m as string | null) === 'airlock'), 'only airlock and offline exist; any other ?mode= falls back to airlock')
ok(GUARDS.join(',') === 'cre,breakglass', `guard cards: Chainlink CRE + human break-glass (${GUARDS.join(',')})`)
ok(CHAIN.chainId === 11155111 && CHAIN.http.length === 3 && CHAIN.http.every((u) => u.startsWith('https://')), `Sepolia 11155111 over ${CHAIN.http.length} HTTPS endpoints`)
ok(CHAIN.ws.length >= 1 && CHAIN.ws.every((u) => u.startsWith('wss://')) && !CHAIN.ws.some((u) => u.includes('1rpc')), 'WS only on endpoints that serve it (1rpc has none)')
ok(CHAIN.pollMs >= 1000 && CHAIN.logRange <= 50, `poll every ${CHAIN.pollMs} ms while the WS is down; eth_getLogs ranges <= ${CHAIN.logRange} blocks`)
const TX = ('0x' + 'ab'.repeat(32)) as Hex
ok(explorerUrl(CHAIN.explorerTx, TX) === `https://sepolia.etherscan.io/tx/${TX}`, 'tx links go to sepolia.etherscan.io')
ok(parseRpcOverride('http://127.0.0.1:19621/') === 'http://127.0.0.1:19621' && ['javascript:alert(1)', 'ws://127.0.0.1:8545', '', 'http://', 'http://a b'].every((x) => parseRpcOverride(x) === null), '?rpc= accepts http(s) URLs only')
ok(isLoopback('http://127.0.0.1:19621') && isLoopback('http://localhost:8545') && isLoopback('http://[::1]:8545') && !isLoopback('https://sepolia.drpc.org') && !isLoopback('http://127.0.0.1.evil.example'), 'loopback detection')
{
  const fork = chainWithRpc(CONFIG.sepolia, 'http://127.0.0.1:19621')
  ok(fork.http.join() === 'http://127.0.0.1:19621' && fork.ws.join() === 'ws://127.0.0.1:19621' && fork.explorerTx === null && fork.sourcifyApi === null, 'local fork: one endpoint (HTTP + WS on the same port), no explorer, no Sourcify')
}

// ---------- 2. ABI against the forge artifacts (FOUNDRY_PROFILE=eth forge build) ----------
{
  const adminOut = join(REPO, 'out', 'AirlockAdmin.sol', 'AirlockAdmin.json')
  const rxOut = join(REPO, 'out', 'AirlockReceiver.sol', 'AirlockReceiver.json')
  const evTopic = (abi: readonly unknown[], name: string) => {
    const e = (abi as AbiEvent[]).find((x) => x.type === 'event' && x.name === name)
    return e ? toEventSelector(e) : null
  }
  const fnSel = (abi: readonly unknown[], name: string) => {
    const f = (abi as AbiFunction[]).find((x) => x.type === 'function' && x.name === name)
    return f ? toFunctionSelector(f) : null
  }
  ok(evTopic(ADMIN_ABI, 'Cleared') === '0xdfffc913c95f0f11ab761375668bb20cc87c4079b9cc7b8b59d7a1431c0c7b42', 'Cleared topic matches the contracts interface')
  ok(evTopic(RECEIVER_ABI, 'Verdict') === '0x76ccdd46dc53d2b7f83e2731ac9dad444e191b37376383f1307798c1c54353f3', 'Verdict topic matches the contracts interface')
  ok(fnSel(ADMIN_ABI, 'clearanceOf') === '0x6507f7cb', 'clearanceOf selector 0x6507f7cb')
  if (existsSync(adminOut) && existsSync(rxOut)) {
    const A = JSON.parse(readFileSync(adminOut, 'utf8')).abi as Abi
    const R = JSON.parse(readFileSync(rxOut, 'utf8')).abi as Abi
    const evs = ['Proposed', 'Vetoed', 'Cleared', 'Executed', 'ReasonAttached']
    ok(evs.every((n) => evTopic(A, n) !== null && evTopic(A, n) === evTopic(ADMIN_ABI, n)), `AirlockAdmin events match out/ (${evs.join(', ')})`)
    ok(evTopic(R, 'Verdict') === evTopic(RECEIVER_ABI, 'Verdict'), 'AirlockReceiver.Verdict matches out/')
    const fns = ['getProposal', 'clearanceOf', 'nextId', 'delayBlocks']
    ok(fns.every((n) => fnSel(A, n) !== null && fnSel(A, n) === fnSel(ADMIN_ABI, n)), `AirlockAdmin views match out/ (${fns.join(', ')})`)
    const comps = (abi: Abi) => ((abi as AbiFunction[]).find((x) => x.type === 'function' && x.name === 'getProposal')!.outputs[0] as { components: { name: string; type: string }[] }).components.map((c) => `${c.type} ${c.name}`).join(',')
    ok(comps(A) === comps(ADMIN_ABI as Abi), 'getProposal returns the same 10-field struct')
    // the recorder script keeps its own copy of the signatures
    const rec = readFileSync(join(WEB, 'scripts', 'record-run.mjs'), 'utf8')
    const sigs = readFileSync(join(WEB, 'src', 'abi.ts'), 'utf8').match(/'(?:event|function|struct) [^']+'/g) ?? []
    ok(sigs.length >= 9 && sigs.filter((s) => !s.includes('delayBlocks')).every((s) => rec.includes(s)), 'scripts/record-run.mjs uses the same signatures as src/abi.ts')
  } else console.log('skip ABI vs out/: run FOUNDRY_PROFILE=eth forge build first')
}

// ---------- 3. scripts/sync-sepolia-data.mjs ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'airlock-sync-'))
  const dep = JSON.parse(readFileSync(join(WEB, 'test', 'fixtures', 'deployment.json'), 'utf8'))
  const depFile = join(dir, 'deployment.json')
  const out = join(dir, 'out.json')
  const run = (d: unknown, args: string[] = []) => {
    if (d !== null) writeFileSync(depFile, JSON.stringify(d))
    try {
      execFileSync(process.execPath, [join(WEB, 'scripts', 'sync-sepolia-data.mjs'), d === null ? join(dir, 'missing.json') : depFile, '--out', out, ...args], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  ok(run(dep), 'reads a DeployEth output (airlockAdmin, receiver, emergencyGuardian, approver, ...)')
  const j = JSON.parse(readFileSync(out, 'utf8'))
  ok(j.pending === false && j.airlockAdmin === dep.airlockAdmin && j.receiver === dep.receiver && j.emergencyGuardian === dep.emergencyGuardian && j.approver === dep.approver && j.startBlock === 900 && j.delayBlocks === 25, 'data file: addresses, startBlock, cooldown')
  ok(['v1', 'v2', 'evilMint', 'evilOwner', 'evilFee', 'evilBaseFee', 'evilDrain', 'paused'].every((k) => j.impls[k] === dep[k]), 'data file: all eight implementations (EvilBaseFee and EvilDrain included)')
  ok(JSON.stringify(j) === JSON.stringify(DATA), 'the fixture the page reads is exactly what the script writes')
  ok(findBlocked(readFileSync(out, 'utf8')).length === 0, 'no local path in the data file')
  ok(!run({ ...dep, chainId: 1 }), 'refuses a chain that is not Sepolia')
  ok(!run({ ...dep, approver: dep.owner }), 'refuses approver == owner')
  ok(!run({ ...dep, emergencyGuardian: dep.approver }), 'refuses approver == emergency guardian')
  ok(!run({ ...dep, receiver: undefined }), 'refuses a missing receiver')
  const { airlockAdmin: _drop, ...older } = dep
  ok(run({ ...older, guardedAdmin: dep.airlockAdmin }) && JSON.parse(readFileSync(out, 'utf8')).pending === true, 'a deployment file without an airlockAdmin key gives the placeholder')
  ok(!run({ ...older, guardedAdmin: dep.airlockAdmin }, ['--require']), '--require fails on the placeholder')
  ok(run(null) && JSON.parse(readFileSync(out, 'utf8')).pending === true, 'no deployment file: placeholder (pending: true)')
  rmSync(dir, { recursive: true, force: true })
  const shipped = JSON.parse(readFileSync(join(WEB, 'src', 'chain-data-sepolia.json'), 'utf8'))
  ok(shipped.pending === true || (shipped.chainId === 11155111 && /^0x[0-9a-fA-F]{40}$/.test(shipped.airlockAdmin) && /^0x[0-9a-fA-F]{40}$/.test(shipped.receiver)), `shipped src/chain-data-sepolia.json is ${shipped.pending ? 'the placeholder' : 'a full deployment'}`)
}

// ---------- 4. airlockView (pure) ----------
const H = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex
const base = (): Proposal => ({ ...newProposal('9'), target: '0x01', codehash: '0x02', proposeBlock: 100, readyBlock: 125 })
const RX = DATA.receiver
{
  ok(airlockView(null, 0).phase === 'idle', 'no proposal: idle')
  const ch = airlockView(base(), 110)
  ok(ch.phase === 'chamber' && ch.total === 25 && ch.left === 15 && ch.leftSec === 180 && ch.pct === 40 && !ch.cleared, `cooling, not cleared: chamber, ${ch.left} blocks ≈ ${ch.leftSec} s left, ${ch.pct}%`)
  ok(airlockView(base(), 125).phase === 'waiting' && airlockView(base(), 130).over === 5, 'cooldown over without a clearance: waiting (not executable)')
  const cl = base()
  cl.clearance = { evidenceHash: H(0xc1), clearer: RX, by: 'cre', tx: H(103), block: 103 }
  cl.guards.cre = { verdict: 'pass', tx: H(103), block: 103, evidenceHash: H(0xc1), workflowId: H(0xf1) }
  const ts = new Map([
    [100, 1_000],
    [103, 1_036],
  ])
  const v1 = airlockView(cl, 110, (n) => ts.get(n))
  ok(v1.phase === 'cleared' && v1.clear?.by === 'cre' && v1.clear.afterBlocks === 3 && v1.clear.afterSec === 36 && v1.clear.secFromTs && v1.clear.beforeReady === 22, 'cleared by the CRE 3 blocks · 36 s (block timestamps) after the proposal; the door still waits for the cooldown')
  ok(v1.clear?.evidenceHash === H(0xc1) && v1.clear.workflowId === H(0xf1) && v1.clear.tx === H(103), 'clearance carries evidence hash, workflowId and tx')
  ok(airlockView(cl, 125).phase === 'ready' && airlockView(cl, 125).pct === 100, 'cleared and cooldown over: ready (executable)')
  const firstHash = { ...cl, chain: { status: 1, vetoCount: 0, proposer: '0x1', clearanceOf: H(0xc0) } }
  ok(airlockView(firstHash, 110).clear?.evidenceHash === H(0xc0), 'clearanceOf (the first hash, kept on chain) wins over a later Cleared log')
  const ex = { ...cl, execute: { tx: H(130), block: 130 }, chain: { status: 3, vetoCount: 0, proposer: '0x1', clearanceOf: H(0xc1) } }
  ok(airlockView(ex, 140).phase === 'executed' && airlockView(ex, 140).pct === 100, 'executed: inner door open')
  const late = base()
  late.chain = { status: 1, vetoCount: 0, proposer: '0x1', clearanceOf: H(0xc2) }
  ok(airlockView(late, 110).phase === 'cleared' && airlockView(late, 110).clear === null && airlockView(late, 110).cleared, 'clearanceOf without a log in reach still counts as cleared')
  const ej = base()
  ej.guards.cre = { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', ruleHash: ruleHashOf('R1_TOTAL_SUPPLY'), tx: H(102), block: 102, evidenceHash: H(0xe1), workflowId: H(0xf1) }
  const ve = airlockView(ej, 104, (n) => (n === 100 ? 1000 : n === 102 ? 1024 : undefined))
  ok(ve.phase === 'ejected' && ve.veto?.by === 'cre' && ve.veto.afterBlocks === 2 && ve.veto.toInner === 23 && ve.veto.afterSec === 24 && ve.pct === 8, 'CRE veto: ejected 2 blocks · 24 s after the proposal, 23 blocks short of the inner door')
  ok(airlockView(ej, 104).veto?.secFromTs === false && airlockView(ej, 104).veto?.afterSec === 24, 'without timestamps the seconds are estimated (12 s/block) and say so')
  const vetoAfterClear = { ...cl, guards: { ...cl.guards, breakglass: { verdict: 'veto' as const, rule: 'R2_OWNER', tx: H(108), block: 108 } } }
  ok(airlockView(vetoAfterClear, 130).phase === 'ejected' && airlockView(vetoAfterClear, 130).veto?.by === 'breakglass', 'a guardian veto still wins over a clearance')
  const appr = base()
  appr.clearance = { evidenceHash: H(0xa1), clearer: DATA.approver, by: 'approver', tx: H(105), block: 105 }
  ok(airlockView(appr, 126).phase === 'ready' && airlockView(appr, 126).clear?.by === 'approver', 'clearance by the approver by hand also opens the door')
  setLang('zh-CN', false)
  ok(fmtDur(24) === '24 秒' && fmtDur(300) === '5 分钟' && fmtDur(276) === '4 分 36 秒', 'zh-CN durations')
  setLang('en', false)
  ok(fmtDur(24) === '24 s' && fmtDur(276) === '4 min 36 s', 'en durations')
  ok(t('m.blocks', { n: 1 }) === '<b>1</b> block' && t('m.blocks', { n: 2 }) === '<b>2</b> blocks', 'en plural: 1 block, 2 blocks')
  setLang('zh-CN', false)
  ok(fmtEth(3_750_000n) === '3,750,000 wei' && fmtEth(2_500_000_000_000n) === '2,500 gwei' && fmtGasPrice(15n) === '15 wei', 'fee formats (Sepolia gas prices can be a few wei)')
}

// ---------- 5. playback engine (replay.ts) ----------
{
  const p = base()
  p.proposeTx = H(100)
  p.clearance = { evidenceHash: H(0xc1), clearer: RX, by: 'cre', tx: H(103), block: 103 }
  p.guards.cre = { verdict: 'pass', tx: H(103), block: 103 }
  p.execute = { tx: H(127), block: 127 }
  p.chain = { status: 3, vetoCount: 0, proposer: '0x1', clearanceOf: H(0xc1) }
  const tl = buildTimeline(p)!
  ok(tl.type === 'cleared' && tl.steps.map((s) => s.kind).join(',') === 'proposed,clear,ready,executed' && tl.end === 130, `cleared timeline: ${tl.steps.map((s) => `${s.kind}@${s.block}`).join(' ')}`)
  const phaseAt = (src: Proposal, v: number) => airlockView(snapshotAt(src, buildTimeline(src)!, v), v).phase
  ok([99, 101, 104, 125, 128].map((v) => phaseAt(p, v)).join(',') === 'idle,chamber,cleared,ready,executed', 'played back: idle → chamber → cleared → ready → executed')
  const lateClear = { ...p, clearance: { ...p.clearance!, block: 131, tx: H(131) }, guards: { ...p.guards, cre: { verdict: 'pass' as const, tx: H(131), block: 131 } }, execute: { tx: H(133), block: 133 } }
  ok([110, 128, 132, 134].map((v) => phaseAt(lateClear, v)).join(',') === 'chamber,waiting,ready,executed', 'a clearance after the cooldown: chamber → waiting → ready → executed')
  const ej = base()
  ej.guards.cre = { verdict: 'veto', rule: 'R9_NEW_OPCODES', tx: H(102), block: 102 }
  ej.reason = { tx: H(102), hash: H(0xe9), block: 102 }
  ej.chain = { status: 2, vetoCount: 1, proposer: '0x1', clearanceOf: null }
  ok([101, 102].map((v) => phaseAt(ej, v)).join(',') === 'chamber,ejected', 'vetoed timeline: chamber → ejected')
  const q = { ...p, id: '12' }
  const r = { ...ej, id: '7' }
  const engine = new AutoReplay(0, { msPerBlock: 100, firstDelayMs: 0, idleMs: 1000, gapMs: 0, reducedHoldMs: 100 })
  const all = [q, r]
  const ctx = { proposals: all, get: (id: string) => all.find((x) => x.id === id), reduced: false, liveBusy: false }
  engine.tick(0, ctx)
  const first = engine.frame(0, ctx.get)?.tl.id
  engine.tick(100_000, ctx)
  const second = engine.frame(100_000, ctx.get)?.tl.id
  ok(first === '7' && second === '12', `plays proposals in id order and loops (${first} then ${second})`)
}

// ---------- 6. live read: a fake Sepolia (AirlockAdmin + AirlockReceiver logs, receipts, timestamps) ----------
const ADMIN = DATA.airlockAdmin as Hex
const RECV = DATA.receiver as Hex
const OWNER = DATA.owner as Hex
const IMPL = DATA.impls as Record<string, Hex>
const H32 = (s: string) => keccak256(toHex(s))
const EV1 = H32('evidence #1')
const EV2 = H32('evidence #2')
const WF = H32('workflow')
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex
let HEAD = 1200
let NEXT = 4

function mkLog(abi: Abi, address: Hex, eventName: string, args: Record<string, unknown>, block: number, tx: Hex, logIndex: number): RawLog {
  const ev = (abi as AbiEvent[]).find((x) => x.type === 'event' && x.name === eventName)!
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[]
  const nonIdx = ev.inputs.filter((i) => !i.indexed)
  const data = encodeAbiParameters(nonIdx as never, nonIdx.map((i) => args[i.name!]) as never)
  return { address, topics, data, blockNumber: toHex(block), transactionHash: tx, logIndex: toHex(logIndex) }
}
type ChainProp = { kind: number; status: number; proposer: Hex; target: Hex; value: bigint; codehash: Hex; dataHash: Hex; proposedBlock: bigint; readyBlock: bigint; vetoCount: bigint }
const prop = (target: Hex, status: number, pb: number, vetoCount = 0n): ChainProp => ({ kind: 0, status, proposer: OWNER, target, value: 0n, codehash: H32(`code ${target}`), dataHash: ZERO32, proposedBlock: BigInt(pb), readyBlock: BigInt(pb + 25), vetoCount })
const PROPS = new Map<number, ChainProp>([
  [1, prop(IMPL.evilMint, 2, 1000, 1n)],
  [2, prop(IMPL.v2, 3, 1100)],
  [3, prop(IMPL.evilBaseFee, 1, 1150)],
])
const CLEAR = new Map<number, Hex>([[2, EV2]])
const T = (s: string) => H32(`tx ${s}`)
const LOGS: RawLog[] = [
  mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 1n, kind: 0, target: IMPL.evilMint, value: 0n, data: '0x', codehash: H32('c1'), readyBlock: 1025n }, 1000, T('p1'), 0),
  mkLog(ADMIN_ABI, ADMIN, 'Vetoed', { id: 1n, guardian: RECV, ruleHash: ruleHashOf('R1_TOTAL_SUPPLY'), vetoCount: 1n }, 1002, T('v1'), 0),
  mkLog(ADMIN_ABI, ADMIN, 'ReasonAttached', { id: 1n, guardian: RECV, reportHash: EV1 }, 1002, T('v1'), 1),
  mkLog(RECEIVER_ABI, RECV, 'Verdict', { proposalId: 1n, action: 0, ruleHash: ruleHashOf('R1_TOTAL_SUPPLY'), evidenceHash: EV1, workflowId: WF }, 1002, T('v1'), 2),
  mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 2n, kind: 0, target: IMPL.v2, value: 0n, data: '0x', codehash: H32('c2'), readyBlock: 1125n }, 1100, T('p2'), 0),
  mkLog(ADMIN_ABI, ADMIN, 'Cleared', { id: 2n, clearer: RECV, evidenceHash: EV2 }, 1103, T('c2'), 0),
  mkLog(RECEIVER_ABI, RECV, 'Verdict', { proposalId: 2n, action: 1, ruleHash: ZERO32, evidenceHash: EV2, workflowId: WF }, 1103, T('c2'), 1),
  // Executed 80 blocks after the proposal: only the second 50-block getLogs range finds it
  mkLog(ADMIN_ABI, ADMIN, 'Executed', { id: 2n, executor: OWNER }, 1180, T('e2'), 0),
  mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 3n, kind: 0, target: IMPL.evilBaseFee, value: 0n, data: '0x', codehash: H32('c3'), readyBlock: 1175n }, 1150, T('p3'), 0),
]
const blockTime = (n: number) => 1_760_000_000 + (n - 1000) * 12
const rpcCalls: { url: string; method: string; params: unknown[] }[] = []
const asList = (x: unknown) => (Array.isArray(x) ? x : [x]).map((s) => String(s).toLowerCase())
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
  rpcCalls.push({ url: String(url), method: req.method, params: req.params })
  const reply = (body: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(body as object) }), { status: 200, headers: { 'content-type': 'application/json' } })
  const result = (r: unknown) => reply({ result: r })
  switch (req.method) {
    case 'eth_blockNumber':
      return result(toHex(HEAD))
    case 'eth_getBlockByNumber': {
      const n = Number(BigInt(String(req.params[0])))
      return result({ number: toHex(n), timestamp: toHex(blockTime(n)) })
    }
    case 'eth_getTransactionReceipt': {
      const l = LOGS.find((x) => x.transactionHash === req.params[0])
      return result(l ? { blockNumber: l.blockNumber, status: '0x1', gasUsed: toHex(250000), effectiveGasPrice: toHex(15) } : null)
    }
    case 'eth_call': {
      const call = req.params[0] as { to: string; data: Hex }
      if (call.to.toLowerCase() !== ADMIN.toLowerCase()) return reply({ error: { code: -32000, message: 'unexpected eth_call target' } })
      const d = decodeFunctionData({ abi: ADMIN_ABI, data: call.data }) as { functionName: string; args?: readonly unknown[] }
      const id = Number(d.args?.[0] ?? 0)
      if (d.functionName === 'nextId') return result(encodeFunctionResult({ abi: ADMIN_ABI, functionName: 'nextId', result: BigInt(NEXT) } as never))
      if (d.functionName === 'clearanceOf') return result(encodeFunctionResult({ abi: ADMIN_ABI, functionName: 'clearanceOf', result: CLEAR.get(id) ?? ZERO32 } as never))
      if (d.functionName === 'getProposal') return result(encodeFunctionResult({ abi: ADMIN_ABI, functionName: 'getProposal', result: PROPS.get(id) ?? prop(('0x' + '00'.repeat(20)) as Hex, 0, 0) } as never))
      return reply({ error: { code: -32000, message: `unexpected ${d.functionName}` } })
    }
    case 'eth_getLogs': {
      const f = req.params[0] as { address: unknown; fromBlock: Hex; toBlock: Hex; topics?: unknown[] }
      const from = Number(BigInt(f.fromBlock))
      const to = Number(BigInt(f.toBlock))
      if (to - from + 1 > 50) return reply({ error: { code: -32602, message: 'eth_getLogs is limited to 0 - 50 blocks range' } })
      const addrs = asList(f.address)
      const t0 = f.topics?.[0] ? asList(f.topics[0]) : null
      const t1 = f.topics?.[1] ? String(f.topics[1]).toLowerCase() : null
      return result(
        LOGS.filter((l) => {
          const b = Number(BigInt(l.blockNumber))
          return b >= from && b <= to && addrs.includes(l.address.toLowerCase()) && (!t0 || t0.includes(l.topics[0].toLowerCase())) && (!t1 || l.topics[1]?.toLowerCase() === t1)
        }),
      )
    }
  }
  return reply({ error: { code: -32601, message: `method ${req.method} not in the fake` } })
}) as typeof fetch

const dom = installDom()
ok(!PENDING, 'fixture deployment is not a placeholder')
startChainWatch()
ok(await until(() => chainHealth.loadedRecent, 8000), 'page open: recent proposals loaded (getProposal + clearanceOf + per-proposal getLogs)')
const P = (id: string) => store.proposals.get(id)!
ok(P('1')?.chain?.status === 2 && P('2')?.chain?.status === 3 && P('3')?.chain?.status === 1, 'proposal #1 Vetoed, #2 Executed, #3 Pending on chain')
{
  const a = P('1').guards.cre
  ok(a.verdict === 'veto' && a.rule === 'R1_TOTAL_SUPPLY' && a.tx === T('v1') && a.block === 1002 && a.evidenceHash === EV1 && a.workflowId === WF, 'Vetoed by AirlockReceiver lands on the Chainlink CRE card with rule, tx, evidence hash and workflowId (Verdict)')
  ok(P('1').reason?.hash === EV1 && P('1').card === 'evilMint', 'ReasonAttached carries the evidence hash; EvilMint is recognised by address')
  const c = P('2').clearance
  ok(c?.by === 'cre' && c.block === 1103 && c.tx === T('c2') && c.evidenceHash === EV2 && P('2').chain?.clearanceOf === EV2, 'Cleared by AirlockReceiver: clearance by the CRE (block, tx, evidence); clearanceOf read too')
  ok(P('2').guards.cre.verdict === 'pass' && P('2').guards.cre.workflowId === WF, 'Verdict(action 1) marks the CRE card as passed with its workflowId')
  ok(P('2').execute?.tx === T('e2') && P('2').execute?.block === 1180, 'Executed 80 blocks after the proposal is found (second getLogs range)')
  ok(P('3').card === 'evilBaseFee' && !P('3').clearance && !P('3').chain?.clearanceOf, '#3 EvilBaseFee: pending, no clearance')
  const calls = rpcCalls.filter((x) => x.method === 'eth_getLogs').map((x) => x.params[0] as { address: unknown; fromBlock: Hex; toBlock: Hex; topics: unknown[] })
  const maxRange = Math.max(...calls.map((f) => Number(BigInt(f.toBlock)) - Number(BigInt(f.fromBlock)) + 1))
  ok(calls.length > 0 && maxRange <= 50, `eth_getLogs ranges <= 50 blocks (max ${maxRange}, ${calls.length} calls)`)
  ok(calls.every((f) => asList(f.address).includes(ADMIN.toLowerCase()) && asList(f.address).includes(RECV.toLowerCase())), 'every getLogs covers AirlockAdmin and AirlockReceiver')
  ok(asList(calls[0].topics[0]).length === TOPICS.length && TOPICS.length === 6, 'topics: Proposed, Vetoed, Cleared, Executed, ReasonAttached, Verdict')
  ok(rpcCalls.every((x) => x.url === CHAIN.http[0]), `all JSON-RPC goes to ${CHAIN.http[0]} (rotation only on failure)`)
  ok(NoSocket.opened.includes(CHAIN.ws[0]), 'logs subscription over WS (eth_subscribe logs)')
}
ok(await until(() => !!store.receipts.get(T('v1').toLowerCase()) && !!store.receipts.get(T('c2').toLowerCase()) && blockTs.has(1000) && blockTs.has(1103), 5000), 'veto and clearance receipts (gasUsed, effectiveGasPrice) and block timestamps are read')

// ---------- 7. rendering in three languages ----------
blocks.ingest(1200)
startTitle()
const html = () => dom.html()
const plain = (h: string) => h.replace(/<button data-lang[^>]*>[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const lack = (words: string[], text: string) => {
  const m = words.filter((w) => !text.includes(w))
  return m.length ? ` (missing: ${m.join(' | ')})` : ''
}
function shot(id: string, l: Lang, evidence = false): { h: string; title: string } {
  setLang(l, false)
  store.activeId = id
  ui.evidenceOpen = evidence
  render()
  const out = { h: html(), title: dom.doc.title }
  ui.evidenceOpen = false
  return out
}
{
  const a = shot('1', 'zh-CN', true)
  const w = ['Upgrade Airlock 升级气闸', '外门', '气闸舱', '内门', '⏏ 已弹出', 'Chainlink CRE', '人工紧急否决', 'R1', '陌生地址改变了总供应量', '提案后 2 块 · 24 秒（区块时间戳）', '离内门还差', '23 块', '3,750,000 wei', '15 wei', '证据哈希', '— 不需要出手（CRE 已否决）', 'AirlockReceiver', '上链否决']
  ok(lack(w, plain(a.h)) === '', `zh-CN ejected: airlock, rule, blocks and seconds, cost, both guard cards${lack(w, plain(a.h))}`)
  ok(a.h.includes(`https://sepolia.etherscan.io/tx/${T('v1')}`) && a.h.includes(`https://sepolia.etherscan.io/address/${RECV}`), 'veto tx and AirlockReceiver link to sepolia.etherscan.io')
  ok(a.h.includes('class="al-lock ph-ejected"') && a.h.includes('class="al-out bad"') && a.h.includes('g-pipe done veto'), 'airlock ejected; CRE pipeline lit up as a veto')
  ok(plain(a.h).includes('evidenceHash = keccak256') && a.h.includes(`title="${EV1}"`), 'R: evidence dock with the full hash')
  ok(a.title === 'Upgrade Airlock 升级气闸 · 战情室', `tab title: ${a.title}`)
  const tb = dom.els.get('toolbar')?.innerHTML ?? ''
  const acts = [...tb.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1].split(':')[0])
  ok(acts.every((x) => ['evidence', 'replay', 'sel'].includes(x)) && tb.includes('data-lang') && tb.includes('data-act="sel:3"'), `toolbar: R evidence, P replay, language, recent proposals only (${[...new Set(acts)].join(', ')})`)
  ok(plain(tb).includes('外门 → 舱内 25 块 ≈ 5 分钟 → CRE 放行 → 内门'), 'toolbar flow: 25 blocks ≈ 5 min, then the CRE clearance')
}
{
  const a = shot('2', 'zh-CN')
  const w = ['✓ 内门已开：新实现生效', '✓ Executed', '块 #1180', 'DemoBTC v2', '✓ 放行', '不变量全部守住', '放行落地', '3 块 · 36 秒', '放行交易成本', '3,750,000 wei', '上链放行']
  ok(lack(w, plain(a.h)) === '' && a.h.includes('ph-executed') && a.h.includes('scard-in g-cre passed'), `zh-CN executed: cleared by the CRE, then executed${lack(w, plain(a.h))}`)
}
{
  const a = shot('3', 'zh-CN')
  const w = ['⏳ 等待放行', '冷静期已于 #1175 满，链上还没有放行', '⊠ 锁住', '缺放行', 'execute(3) 会 revert NotCleared', '⏳ 冷静期已满，链上还没有 Verdict', 'EvilBaseFee', '模拟里（basefee=0）表现得像 v1']
  ok(lack(w, plain(a.h)) === '' && a.h.includes('class="al-lock ph-waiting"') && a.h.includes('class="al-out warn"'), `zh-CN past readyBlock without clearance: waiting for clearance, not executable${lack(w, plain(a.h))}`)
}
for (const [id, words] of [
  ['1', ['Upgrade Airlock 升級氣閘', '外門', '氣閘艙', '內門', '⏏ 已彈出', '陌生地址改變了總供應量', '提案後 2 塊 · 24 秒（區塊時間戳）', '人工緊急否決', '證據雜湊']],
  ['2', ['✓ 內門已開：新實作生效', '✓ 放行', '放行交易成本']],
  ['3', ['⏳ 等待放行', '⊠ 鎖住', 'execute(3) 會 revert NotCleared']],
] as const) {
  const a = shot(id, 'zh-TW', id === '1')
  const p = plain(a.h)
  ok(lack([...words], p) === '', `zh-TW #${id}${lack([...words], p)}`)
  const bad = [...new Set(p.match(new RegExp(SIMPLIFIED_ONLY.source, 'g')) ?? [])]
  ok(bad.length === 0, `zh-TW #${id} has no simplified characters${bad.length ? ': ' + bad.join('') : ''}`)
  if (id === '1') ok(a.title === 'Upgrade Airlock 升級氣閘 · 戰情室', `zh-TW tab title: ${a.title}`)
}
for (const [id, words] of [
  ['1', ['Upgrade Airlock', 'Outer door', 'Chamber', 'Inner door', '⏏ Ejected', 'stranger changed total supply', '2 blocks · 24 s (block time) after proposal', 'Short of the inner door', 'Human break-glass', 'Chainlink CRE verdict evidence']],
  ['2', ['✓ Inner door open: the new impl is live', '✓ Clear', 'every invariant held', 'Clearance tx cost']],
  ['3', ['⏳ Waiting for clearance', '⊠ Locked', 'execute(3) reverts NotCleared', 'Acts like v1 in simulation']],
] as const) {
  const a = shot(id, 'en', id === '1')
  const p = plain(a.h)
  ok(lack([...words], p) === '', `en #${id}${lack([...words], p)}`)
  const bad = [...new Set(p.match(new RegExp(CJK.source, 'g')) ?? [])]
  ok(bad.length === 0, `en #${id} has no Chinese characters${bad.length ? ': ' + bad.join('') : ''}`)
  if (id === '1') ok(a.title === 'Upgrade Airlock · War Room', `en tab title: ${a.title}`)
}
{
  const keys = Object.keys(DICT['zh-CN'])
  ok((['zh-TW', 'en'] as Lang[]).every((l) => keys.every((k) => typeof DICT[l][k] === 'string' && DICT[l][k].length > 0)), `all ${keys.length} strings exist in all three languages`)
  const tw = keys.filter((k) => SIMPLIFIED_ONLY.test(DICT['zh-TW'][k]))
  ok(tw.length === 0, `zh-TW strings have no simplified characters${tw.length ? ': ' + tw.slice(0, 5).join(', ') : ''}`)
  ok(keys.every((k) => !CJK.test(DICT.en[k])), 'en strings have no Chinese characters')
}

// ---------- 8. live: outer door → chamber → CRE clearance → cooldown over → inner door ----------
setLang('zh-CN', false)
{
  HEAD = 1210
  NEXT = 5
  PROPS.set(4, prop(IMPL.v2, 1, 1205))
  const p4 = mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 4n, kind: 0, target: IMPL.v2, value: 0n, data: '0x', codehash: H32('c4'), readyBlock: 1230n }, 1205, T('p4'), 0)
  LOGS.push(p4)
  handleLog(p4, true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive: (ts) => replay.onLive(ts) })
  blocks.ingest(1210)
  ok(store.activeId === '4', 'a live Proposed switches to the new proposal')
  render()
  let h = plain(html())
  ok(lack(['✓ Proposed', '块 #1205', '还剩 20 块', '≈ 4 分钟（按 12 秒/块）', '等 CRE 放行', '⏳ 等 Chainlink CRE 判定：链上还没有 Verdict', '⏳ 判定中：链上还没有 Verdict'], h) === '' && html().includes('class="al-lock ph-chamber"'), `chamber: outer door open, countdown, inner door locked until the clearance${lack(['还剩 20 块', '等 CRE 放行'], h)}`)
  // a Cleared from any other contract is ignored
  handleLog(mkLog(ADMIN_ABI, '0x000000000000000000000000000000000000dEaD', 'Cleared', { id: 4n, clearer: RECV, evidenceHash: EV2 }, 1206, T('spoof'), 0), true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} })
  ok(!P('4').clearance, 'a Cleared log from another address does not count')
  const EV4 = H32('evidence #4')
  const clr = [
    mkLog(ADMIN_ABI, ADMIN, 'Cleared', { id: 4n, clearer: RECV, evidenceHash: EV4 }, 1207, T('c4'), 0),
    mkLog(RECEIVER_ABI, RECV, 'Verdict', { proposalId: 4n, action: 1, ruleHash: ZERO32, evidenceHash: EV4, workflowId: WF }, 1207, T('c4'), 1),
  ]
  LOGS.push(...clr)
  CLEAR.set(4, EV4)
  for (const l of clr) handleLog(l, true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} })
  // a second clearance keeps the first evidence hash
  handleLog(mkLog(ADMIN_ABI, ADMIN, 'Cleared', { id: 4n, clearer: DATA.approver, evidenceHash: H32('later') }, 1208, T('c4b'), 0), true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} })
  ok(P('4').clearance?.evidenceHash === EV4 && P('4').clearance?.by === 'cre', 'a later Cleared keeps the first evidence hash (as AirlockAdmin does)')
  blockTs.set(1205, blockTime(1205))
  blockTs.set(1207, blockTime(1207))
  blocks.ingest(1211)
  render()
  h = plain(html())
  ok(lack(['✓ 已由 Chainlink CRE 放行：冷静期满后内门才开', '✓ 已放行', '#1230 起可开', 'CRE 已放行', '提案后 2 块 · 24 秒（区块时间戳）', '证据哈希'], h) === '' && html().includes('class="al-lock ph-cleared"') && html().includes(`title="${EV4}"`), `cleared: "cleared by Chainlink CRE" with evidence hash and tx; inner door opens at readyBlock${lack(['已由 Chainlink CRE 放行', '#1230 起可开'], h)}`)
  blocks.ingest(1230)
  render()
  h = plain(html())
  ok(lack(['✓ 已由 Chainlink CRE 放行，冷静期已满：内门可以开', '◐ 可以开', '等 execute'], h) === '' && html().includes('class="al-lock ph-ready"'), 'cooldown over and cleared: the inner door can open')
  const ex = mkLog(ADMIN_ABI, ADMIN, 'Executed', { id: 4n, executor: OWNER }, 1231, T('e4'), 0)
  handleLog(ex, true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} })
  blocks.ingest(1231)
  render()
  ok(plain(html()).includes('✓ 内门已开：新实现生效') && html().includes('class="al-lock ph-executed"'), 'Executed: inner door open')
  ok(store.stream.some((l) => l.type === 'Cleared' && l.text.includes('Cleared #4') && l.text.includes('Chainlink CRE')) && store.stream.some((l) => l.type === 'Verdict' && l.text.includes('Verdict #4') && l.text.includes('放行')), 'event stream: Cleared #4 by Chainlink CRE and its Verdict')
}

// ---------- 8b. an approver clearance, then the CRE sweeper's R3B veto of EvilDrain wins ----------
{
  const NOHOOK = { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} }
  const EVA = H32('approver evidence #5')
  const EV5 = H32('evidence #5')
  HEAD = 1245
  NEXT = 6
  PROPS.set(5, prop(IMPL.evilDrain, 1, 1240))
  const p5 = mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 5n, kind: 0, target: IMPL.evilDrain, value: 0n, data: '0x', codehash: H32('c5'), readyBlock: 1265n }, 1240, T('p5'), 0)
  const a5 = mkLog(ADMIN_ABI, ADMIN, 'Cleared', { id: 5n, clearer: DATA.approver, evidenceHash: EVA }, 1241, T('a5'), 0)
  LOGS.push(p5, a5)
  CLEAR.set(5, EVA)
  handleLog(p5, true, { ...NOHOOK, onLive: (ts) => replay.onLive(ts) })
  handleLog(a5, true, NOHOOK)
  blocks.ingest(1242)
  ok(P('5').card === 'evilDrain' && P('5').clearance?.by === 'approver', 'EvilDrain is recognised by address; the approver cleared it by hand')
  let a = shot('5', 'zh-CN')
  const pre = ['EvilDrain', '新增 rescue()', 'approver（人工） 已放行', '⏳ 已放行但 CRE 尚未判定：仍会补判，否决优先']
  ok(lack(pre, plain(a.h)) === '' && a.h.includes('class="al-lock ph-cleared"'), `approver-cleared EvilDrain: the CRE card says the sweeper still judges it${lack(pre, plain(a.h))}`)
  const ve = [
    mkLog(ADMIN_ABI, ADMIN, 'Vetoed', { id: 5n, guardian: RECV, ruleHash: ruleHashOf('R3B_THIRD_PARTY_FUNDS'), vetoCount: 1n }, 1243, T('v5'), 0),
    mkLog(ADMIN_ABI, ADMIN, 'ReasonAttached', { id: 5n, guardian: RECV, reportHash: EV5 }, 1243, T('v5'), 1),
    mkLog(RECEIVER_ABI, RECV, 'Verdict', { proposalId: 5n, action: 0, ruleHash: ruleHashOf('R3B_THIRD_PARTY_FUNDS'), evidenceHash: EV5, workflowId: WF }, 1243, T('v5'), 2),
  ]
  LOGS.push(...ve)
  PROPS.set(5, prop(IMPL.evilDrain, 2, 1240, 1n))
  for (const l of ve) handleLog(l, true, NOHOOK)
  blocks.ingest(1245)
  a = shot('5', 'zh-CN')
  const zh = ['⏏ 已弹出', 'R3B', '陌生地址的调用动了别人的余额', 'EvilDrain']
  ok(lack(zh, plain(a.h)) === '' && a.h.includes('class="al-lock ph-ejected"') && a.h.includes('g-pipe done veto'), `the CRE veto (R3B) wins over the approver's clearance${lack(zh, plain(a.h))}`)
  const tw = plain(shot('5', 'zh-TW').h)
  ok(lack(['陌生地址的呼叫動了別人的餘額', '新增 rescue()：任何人都能不經授權搬走持有人的幣'], tw) === '' && !SIMPLIFIED_ONLY.test(tw), 'zh-TW: R3B and the EvilDrain card, no simplified characters')
  const en = plain(shot('5', 'en').h)
  const enw = ['EvilDrain', 'Adds rescue(): anyone can move a holder', 'stranger moved third-party funds']
  ok(lack(enw, en) === '' && !CJK.test(en), `en: R3B and the EvilDrain card${lack(enw, en)}`)
}

// ---------- 8c. a veto whose log is out of reach: neither guard card claims the other one vetoed ----------
{
  PROPS.set(6, prop(IMPL.evilDrain, 2, 1250, 1n))
  const p6 = store.ensure('6')
  Object.assign(p6, { kind: '0', target: IMPL.evilDrain, codehash: H32('c6'), proposeBlock: 1250, readyBlock: 1275, card: 'evilDrain' })
  p6.chain = { status: 2, vetoCount: 1, proposer: OWNER, clearanceOf: null }
  const en = plain(shot('6', 'en').h)
  ok(en.includes('⏏ Ejected') && (en.match(/vetoed on chain \(the veto log is out of reach\)/g) ?? []).length === 2 && !en.includes('human veto landed') && !en.includes('the CRE vetoed'), 'a veto out of reach: both guard cards say so, neither names the other')
}

// ---------- 9. identity: nothing in web/ names another project or a local path ----------
{
  const hits = scanWeb(WEB)
  ok(hits.length === 0, `web/ sources are clean of blocked names and local paths (${NAMES_NOTE})${hits.length ? ': ' + hits.map((x) => `${x.file} (${x.hits.join(', ')})`).join('; ') : ''}`)
  ok(findBlocked(html()).length === 0, 'rendered page is clean too')
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
