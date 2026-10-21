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
import { airlockView, fmtClock, fmtDur, startTitle } from '../src/airlock'
import { blocks } from '../src/chain'
import { DATA, PENDING, type RawLog } from '../src/chaindata'
import { chainHealth, startChainWatch, TOPICS } from '../src/chainwatch'
import { CONFIG } from '../src/config'
import { HELP_ROWS, keyAction, stepId, type Action } from '../src/controls'
import { explorerUrl, fmtEth, fmtGasPrice, realWorkflowId } from '../src/derive'
import { blockTs, handleLog, pickActive, setManualPick } from '../src/events'
import { DICT, setLang, t, type Lang } from '../src/i18n'
import { replay } from '../src/playback'
import { AutoReplay, buildTimeline, snapshotAt } from '../src/replay'
import { CHAIN, chainWithRpc, CLEAN, FORK, GUARDS, isLoopback, MODE, OFFLINE, parseClean, parsePick, parseRpcOverride, pickMode } from '../src/runtime'
import { newProposal, store, type Proposal } from '../src/store'
import { ruleHashOf } from '../src/types'
import { identOf, momentsFor, phrases, pipelineOf, render, STAGE_QUERY, ui } from '../src/ui'
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
  ok(t('s.after', { n: 1 }) === '+1 block' && t('s.after', { n: 2 }) === '+2 blocks', 'en plural: +1 block, +2 blocks')
  ok(fmtClock(300) === '5:00' && fmtClock(276) === '4:36' && fmtClock(11.2) === '0:12' && fmtClock(-3) === '0:00', 'cooldown clock m:ss')
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

// ---------- 5b. playback for the stage: short ejected timelines, holds on the moments, Space replays one ----------
{
  const ej = base()
  ej.guards.cre = { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', tx: H(101), block: 101 }
  ej.chain = { status: 2, vetoCount: 1, proposer: '0x1', clearanceOf: null }
  const tl = buildTimeline(ej)!
  ok(tl.type === 'ejected' && tl.end === 106 && !tl.steps.some((x) => x.kind === 'ready'), `an ejected timeline ends 5 blocks after the veto, without the rest of the cooldown (end ${tl.end})`)
  const ok2 = { ...base(), id: '2' }
  ok2.clearance = { evidenceHash: H(0xc1), clearer: RX, by: 'cre', tx: H(102), block: 102 }
  ok2.guards.cre = { verdict: 'pass', tx: H(102), block: 102 }
  ok2.execute = { tx: H(126), block: 126 }
  ok2.chain = { status: 3, vetoCount: 0, proposer: '0x1', clearanceOf: H(0xc1) }
  const all = [{ ...ej, id: '1' }, ok2]
  const get = (id: string) => all.find((x) => x.id === id)
  const ctx = { proposals: all, get, reduced: false, liveBusy: false }
  const e = new AutoReplay(0, { msPerBlock: 100, dwellMs: { proposed: 1000, verdict: 2000, executed: 1000 }, firstDelayMs: 0, idleMs: 5000, gapMs: 0, reducedHoldMs: 100 })
  e.paused = true
  ok(!e.tick(0, ctx) && e.frame(0, get) === null, 'a paused loop plays nothing on its own')
  ok(e.playOne(0, ok2, false), 'Space: one proposal plays while the loop is paused')
  // lead 2 blocks (98, 99) = 200 ms; hold 1000 ms on the proposal block 100; verdict at 102 holds 2000 ms
  const vb = (ms: number) => (e.tick(ms, ctx), e.frame(ms, get)?.vblock)
  ok(vb(50) === 98 && vb(150) === 99 && vb(250) === 100 && vb(1150) === 100 && vb(1250) === 100 && vb(1350) === 101 && vb(1500) === 102 && vb(3300) === 102 && vb(3550) === 103, 'the clock holds on the proposal and on the verdict')
  ok(e.frame(3550, get)?.paused === false && e.frame(3550, get)?.tl.id === '2', 'a Space replay is not shown as paused')
  let t = 3550
  while (e.frame(t, get) && t < 60_000) e.tick((t += 100), ctx)
  ok(t < 60_000 && e.frame(t, get) === null && !e.tick(t + 100_000, ctx), 'after a Space replay the paused loop stays paused (no next proposal)')
  const o = new AutoReplay(0, { msPerBlock: 100, firstDelayMs: 0, idleMs: 5000, gapMs: 0, reducedHoldMs: 100 })
  o.startAt('2')
  o.tick(0, ctx)
  ok(o.frame(0, get)?.tl.id === '2', '?p= in offline mode: the loop starts with that proposal')
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
// the stand-in WebSocket never connects; the header feed is drawn as up (the reads above answered)
blocks.link = 'ws'
startTitle()
const html = () => dom.html()
const plain = (h: string) => h.replace(/<button data-lang[^>]*>[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const lack = (words: string[], text: string) => {
  const m = words.filter((w) => !text.includes(w))
  return m.length ? ` (missing: ${m.join(' | ')})` : ''
}
const region = (id: string) => dom.els.get(id)?.innerHTML ?? ''
function shot(id: string, l: Lang, details = false): { h: string; title: string } {
  setLang(l, false)
  store.activeId = id
  ui.details = details
  render()
  const out = { h: html(), title: dom.doc.title }
  ui.details = false
  render()
  return out
}
{
  setLang('zh-CN', false)
  store.activeId = '1'
  render()
  ok(region('details') === '' && !dom.els.get('details')!.classList.contains('open') && !plain(html()).includes('事件串流'), 'the details drawer is hidden by default (no event stream, gas or connection on the main screen)')
  ok(!dom.els.get('help')!.classList.contains('open'), 'the help overlay is hidden by default')
  const a = shot('1', 'zh-CN', true)
  const w = ['升级气闸 · 每次代理升级都要过 Chainlink CRE', '外门', '气闸舱', '内门', '已弹出', '已弹出 · Chainlink CRE 否决', 'Chainlink CRE 判定', '否决', 'R1', '陌生地址的一次调用就改变了总供应量。', '总供应量被改', '提案后 2 块 · 24 秒', '永久封死 · 执行必定回滚', 'EvilMint', '否决上链', '毫发无伤', '证据哈希', '3,750,000 wei', '15 wei', 'workflow id', 'AirlockReceiver', '事件串流']
  ok(lack(w, plain(a.h)) === '', `zh-CN ejected: airlock, stamp, rule in plain words, blocks and seconds, pipeline, details drawer${lack(w, plain(a.h))}`)
  ok(a.h.includes(`https://sepolia.etherscan.io/tx/${T('v1')}`) && a.h.includes(`https://sepolia.etherscan.io/address/${RECV}`), 'report tx and AirlockReceiver link to sepolia.etherscan.io')
  ok(a.h.includes('class="lk ph-ejected') && a.h.includes('class="banner ph-ejected') && a.h.includes('pipe st-done k-veto') && a.h.includes('class="cn-stamp"'), 'airlock ejected: stamp, red banner, CRE pipeline done as a veto')
  ok(a.h.includes(`title="${EV1}"`) && a.h.includes(EV1), 'evidence hash: short on screen with the full hash in its title, in full in the drawer')
  ok(a.h.includes(WF), 'a real workflow id is listed in the drawer')
  ok(a.title === 'Upgrade Airlock 升级气闸 · 战情室', `tab title: ${a.title}`)
  const strip = region('strip')
  const acts = [...strip.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1].split(':')[0])
  ok(acts.every((x) => ['sel', 'follow'].includes(x)) && strip.includes('data-act="sel:1"') && strip.includes('data-act="sel:3"') && strip.includes('class="pc ph-ejected on"'), `strip: one card per proposal, the shown one highlighted, plus the auto-follow switch (${[...new Set(acts)].join(', ')})`)
  ok(plain(strip).includes('R1 · 总供应量被改') && plain(strip).includes('否决 +2 块') && plain(strip).includes('放行 +3 块') && plain(strip).includes('已执行'), 'strip cards: rule, verdict blocks after the proposal, executed')
  const ids = [...strip.matchAll(/data-act="sel:(\d+)"/g)].map((m) => m[1])
  ok(ids.join(',') === '1,2,3', `strip reads left to right, oldest to newest (${ids.join(',')})`)
  const bar = region('t-ctl')
  ok(bar.includes('data-act="details"') && bar.includes('data-act="help"') && (bar.match(/data-lang="/g) ?? []).length === 3, 'top bar: language switch, Details, ?')
  ok(plain(region('t-status')).includes('实时 · Ethereum Sepolia') && plain(region('t-status')).includes('#1,200') && plain(region('t-cre')).includes('Chainlink CRE'), 'top bar: live on Ethereum Sepolia, the block counter, the Chainlink CRE mark')
  ok(!/0x1{64}/i.test(html()), 'no placeholder workflow id on screen')
}
{
  const a = shot('2', 'zh-CN', true)
  const w = ['已执行 · DemoBTC v2 上线', '升级已生效', '区块 #1,180 开启', 'DemoBTC v2', '诚实的升级：只多一个 version()', '放行', '撑过攻击模拟：每条规则都守住了', '提案后 3 块 · 36 秒', '放行上链', '已换上 DemoBTC v2', '执行交易']
  ok(lack(w, plain(a.h)) === '' && a.h.includes('class="lk ph-executed') && a.h.includes('pipe st-done k-clear'), `zh-CN executed: cleared by the CRE, then the inner door opened${lack(w, plain(a.h))}`)
  ok(a.h.includes(`https://sepolia.etherscan.io/tx/${T('e2')}`) && a.h.includes(`https://sepolia.etherscan.io/tx/${T('c2')}`), 'executed: report tx and execute tx links')
}
{
  const a = shot('3', 'zh-CN')
  const w = ['冷静期已满', '链上还没有放行', '冷静期已满 · 没有放行，内门继续锁住', '锁住 · 没有放行', '判定中', 'EvilBaseFee', '模拟里（basefee 为 0）表现得像 v1']
  ok(lack(w, plain(a.h)) === '' && a.h.includes('class="lk ph-waiting') && a.h.includes('class="banner ph-waiting') && a.h.includes('pipe st-run'), `zh-CN past readyBlock without clearance: inner door stays locked${lack(w, plain(a.h))}`)
}
for (const [id, words] of [
  ['1', ['升級氣閘 · 每次代理升級都要過 Chainlink CRE', '外門', '氣閘艙', '內門', '已彈出', '陌生地址的一次呼叫就改變了總供應量。', '提案後 2 塊 · 24 秒', '永久封死', '證據雜湊', '事件串流']],
  ['2', ['已執行 · DemoBTC v2 上線', '升級已生效', '放行', '撐過攻擊模擬：每條規則都守住了', '放行上鏈']],
  ['3', ['冷靜期已滿', '鎖住 · 沒有放行', '模擬裡（basefee 為 0）表現得像 v1']],
] as const) {
  const a = shot(id, 'zh-TW', id === '1')
  const p = plain(a.h)
  ok(lack([...words], p) === '', `zh-TW #${id}${lack([...words], p)}`)
  const bad = [...new Set(p.match(new RegExp(SIMPLIFIED_ONLY.source, 'g')) ?? [])]
  ok(bad.length === 0, `zh-TW #${id} has no simplified characters${bad.length ? ': ' + bad.join('') : ''}`)
  if (id === '1') ok(a.title === 'Upgrade Airlock 升級氣閘 · 戰情室', `zh-TW tab title: ${a.title}`)
}
for (const [id, words] of [
  ['1', ['Every proxy upgrade, cleared by Chainlink CRE', 'Live · Ethereum Sepolia', 'Outer door', 'Chamber', 'Inner door', 'Ejected', 'Ejected · vetoed by Chainlink CRE', "A stranger's call changed the total supply.", 'R1 · Supply changed', '2 blocks · 24 s after the proposal', 'Sealed for good · execute reverts', 'Chainlink CRE verdict', 'Attack simulation', 'eth_simulateV1 on 4 RPC providers', 'All answers agree', 'at least 2 of 4 answer · every answer matches', 'Consensus', 'Signed report', 'Veto on chain', 'Proposal tx', 'Report tx', 'Evidence hash', 'Event stream', 'Verdict tx cost']],
  ['2', ['Executed · DemoBTC v2 is live', 'Upgrade is live', 'Survived the attack simulation: every rule held.', 'Clear on chain', '3 blocks · 36 s after the proposal', 'now runs DemoBTC v2', 'Execute tx', 'Every rule held', 'Clear +3 blocks · executed']],
  ['3', ['Cooldown over', 'Locked · no clearance', 'Judging', 'Acts like v1 in a simulation']],
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

// ---------- 7b. presenter controls, help overlay, moments ----------
{
  const want: Record<string, Action> = { ArrowLeft: 'prev', PageUp: 'prev', ArrowRight: 'next', PageDown: 'next', n: 'newest', N: 'newest', Home: 'newest', ' ': 'replay', Enter: 'replay', f: 'follow', p: 'loop', d: 'details', l: 'lang', '?': 'help', h: 'help', Escape: 'close' }
  ok(Object.entries(want).every(([k, a]) => keyAction(k) === a) && keyAction('x') === null && keyAction('d', { meta: true }) === null && keyAction('r', { ctrl: true }) === null, 'keys: arrows and Page Up/Down step, N newest, Space replay, F follow, P loop, D details, L language, ? help, Esc close; Ctrl/Alt/Cmd combos left alone')
  const acts = new Set(HELP_ROWS.map((r) => r.action))
  ok((['prev', 'newest', 'replay', 'follow', 'loop', 'details', 'lang', 'help', 'close'] as Action[]).every((a) => acts.has(a)), 'the help overlay lists every action')
  ok(stepId(['3', '1', '2'], '2', -1) === '1' && stepId(['3', '1', '2'], '2', 1) === '3' && stepId(['1', '2'], '2', 1) === '2' && stepId(['1', '2'], '1', -1) === '1' && stepId(['1', '2'], null, 1) === '2' && stepId([], '1', 1) === null, '← → step through proposals by id and stop at either end')
  ok(parsePick('4') === '4' && parsePick(' 12 ') === '12' && [null, '', '0', '-1', 'x', '1e3', '4;'].every((x) => parsePick(x) === null), '?p= accepts a proposal id only')
  ok(realWorkflowId(WF) === WF && realWorkflowId(('0x' + '11'.repeat(32)) as Hex) === null && realWorkflowId(ZERO32) === null && realWorkflowId('0x12') === null && realWorkflowId(undefined) === null, 'workflow id: the simulator placeholder 0x1111…1111 and zero are hidden')
  const css = readFileSync(join(WEB, 'src', 'style.css'), 'utf8')
  ok(STAGE_QUERY === '(min-width: 960px) and (min-aspect-ratio: 5/4)' && css.split(`@media not all and ${STAGE_QUERY}`).length === 3 && css.includes(`@media (hover: hover) and ${STAGE_QUERY}`) && !css.includes('13/10'), 'stage and stack layouts use the same media query in ui.ts and style.css; a 4:3 or 5:4 projector gets the stage')
  ok(/\.clean \.ctl,\s*\.clean \.s-hint \{\s*display: none/.test(css) && /@media \(hover: none\) \{\s*\.s-hint \{\s*display: none/.test(css) && /\.idle \.ctl,[\s\S]*?opacity: 0/.test(css), 'presenter chrome: hidden with ?clean=1, no key hints on touch screens, faded out when the mouse is idle')
  ok(parseClean('1') && parseClean('') && parseClean('true') && !parseClean(null) && !parseClean('0') && !parseClean('no') && !CLEAN, '?clean=1 (or a bare ?clean) is recording mode; off by default')
  ok(/\.drawer \{[^}]*background: #0a0f1e;/.test(css), 'the details drawer is opaque (nothing ghosts through it)')
  ok(/\.cn-stamp \{[^}]*font-size: clamp\(16px, 12\.5cqw, 28px\)/.test(css) && /\.count \{[^}]*container-type: inline-size/.test(css), 'phone: the stamps size themselves to the chamber width')
  ok(/\.dl-v \.ph \{\s*display: block;\s*\}\s*\.dl-v \.sep \{\s*display: none;/.test(css), 'phone: door captions are rows, one phrase per line, no stray separators')
  ok(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/.test(css), 'prefers-reduced-motion turns every animation off')
  ok(!/@import|url\(\s*['"]?https?:/i.test(css) && !readFileSync(join(WEB, 'index.html'), 'utf8').includes('https://'), 'no web fonts or other CDN requests (system font stacks only)')
  ok(momentsFor('chamber', 'ejected').join() === 'veto' && momentsFor(null, 'chamber').join() === 'arrive' && momentsFor('idle', 'ejected').join() === 'arrive,veto' && momentsFor('chamber', 'cleared').join() === 'clear' && momentsFor('ready', 'executed').join() === 'exec' && momentsFor('chamber', 'executed').join() === 'clear,exec' && momentsFor('cleared', 'ready').join() === '' && momentsFor('ejected', 'idle').join() === '', 'moments: arrival, veto, clearance, inner door; none when nothing new happened')
  for (const l of ['zh-CN', 'zh-TW', 'en'] as Lang[]) {
    setLang(l, false)
    ui.help = true
    render()
    const hp = plain(region('help'))
    const words = l === 'en' ? ['Presenter shortcuts', 'Previous (older) proposal', 'Jump to the newest proposal', "Replay the selected proposal's verdict moment", 'Auto-follow', 'Developer details drawer', 'Switch language', '?mode=offline', 'Space'] : l === 'zh-TW' ? ['講者快捷鍵', '跳到最新提案', '重播選取提案的判定瞬間', '自動跟隨', '空白鍵'] : ['讲者快捷键', '跳到最新提案', '重播选中提案的判定瞬间', '自动跟随', '空格']
    ok(dom.els.get('help')!.classList.contains('open') && lack(words, hp) === '', `${l} help overlay${lack(words, hp)}`)
    ui.help = false
  }
  render()
  // a selection by the viewer fades in; it plays no moment
  setLang('en', false)
  store.activeId = '2'
  render()
  store.activeId = '1'
  render()
  ok(!/ m-(arrive|veto|clear|exec)/.test(region('h-lock')) && region('h-head').includes(' enter'), 'picking another proposal fades it in without replaying its verdict')
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
  ok(store.activeId === '4' && store.arrival?.id === '4', 'auto-follow: a live Proposed takes over the screen')
  render()
  let h = plain(html())
  const ch = ['提案于区块 #1,205', '20 块', '冷静期剩余', '≈ 4:00', '等待 Chainlink CRE 判定', '已进气闸 · 等待 Chainlink CRE 判定', '锁住 · 等 Chainlink CRE 放行', '判定中', '毫发无伤']
  ok(lack(ch, h) === '' && html().includes('class="lk ph-chamber'), `chamber: outer door shut behind it, the cooldown in blocks and m:ss, inner door locked${lack(ch, h)}`)
  ok(region('h-lock').includes(' m-arrive'), 'the live arrival plays its moment (outer door, capsule)')
  // a Cleared from any other contract is ignored
  handleLog(mkLog(ADMIN_ABI, '0x000000000000000000000000000000000000dEaD', 'Cleared', { id: 4n, clearer: RECV, evidenceHash: EV2 }, 1206, T('spoof'), 0), true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} })
  ok(!P('4').clearance, 'a Cleared log from another address does not count')
  const EV4 = H32('evidence #4')
  const clr = [
    mkLog(ADMIN_ABI, ADMIN, 'Cleared', { id: 4n, clearer: RECV, evidenceHash: EV4 }, 1207, T('c4'), 0),
    mkLog(RECEIVER_ABI, RECV, 'Verdict', { proposalId: 4n, action: 1, ruleHash: ZERO32, evidenceHash: EV4, workflowId: ('0x' + '11'.repeat(32)) as Hex }, 1207, T('c4'), 1),
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
  const cl = ['Chainlink CRE 已放行', 'Chainlink CRE 已放行 · 冷静期满内门就开', '已解锁 · 区块 #1,230 起可开', '放行', '提案后 2 块 · 24 秒', '放行上链']
  ok(lack(cl, h) === '' && html().includes('class="lk ph-cleared') && html().includes(`title="${EV4}"`), `cleared: "cleared by Chainlink CRE" with blocks, seconds and the evidence hash; the inner door unlocks${lack(cl, h)}`)
  ok(region('h-lock').includes(' m-clear') && region('v-pipe').includes(' m-clear') && !region('h-lock').includes(' m-arrive'), 'the clearance plays its moment: the pipeline lights up, the lock opens')
  ok(region('h-stamp').includes('cn-stamp good') && plain(region('h-stamp')).includes('已放行') && dom.els.get('h-wrap')!.classList.contains('stamping'), 'the clearance lands with a green stamp over the chamber')
  ok(!region('h-count').includes(' m-clear'), 'the ticking countdown never carries the moment (a redraw would restart it)')
  ui.details = true
  render()
  ok(!plain(region('details')).includes('Workflow id') && !plain(region('details')).includes('workflow id') && !region('details').includes('1'.repeat(64)), 'the simulator placeholder workflow id is not shown, not even in the drawer')
  ui.details = false
  blocks.ingest(1230)
  render()
  h = plain(html())
  ok(lack(['Chainlink CRE 已放行 · 可以执行', '可以执行', '已解锁 · 冷静期已满'], h) === '' && html().includes('class="lk ph-ready'), 'cooldown over and cleared: ready to execute')
  const ex = mkLog(ADMIN_ABI, ADMIN, 'Executed', { id: 4n, executor: OWNER }, 1231, T('e4'), 0)
  handleLog(ex, true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} })
  blocks.ingest(1231)
  render()
  ok(plain(html()).includes('已执行 · DemoBTC v2 上线') && html().includes('class="lk ph-executed') && region('h-lock').includes(' m-exec'), 'Executed: the inner door opens (moment) and the proxy runs v2')
  ok(store.stream.some((l) => l.type === 'Cleared' && l.text.includes('Cleared #4') && l.text.includes('Chainlink CRE')) && store.stream.some((l) => l.type === 'Verdict' && l.text.includes('Verdict #4') && l.text.includes('放行')), 'event stream (drawer): Cleared #4 by Chainlink CRE and its Verdict')
}

// ---------- 8a. auto-follow off: a new proposal waits in the strip ----------
{
  store.follow = false
  store.activeId = '2'
  setManualPick(true)
  const p9 = mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 9n, kind: 0, target: IMPL.evilOwner, value: 0n, data: '0x', codehash: H32('c9'), readyBlock: 1257n }, 1232, T('p9'), 0)
  handleLog(p9, true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} })
  ok(store.activeId === '2' && store.proposals.has('9'), 'auto-follow off: the screen stays on the picked proposal')
  render()
  ok(region('strip').includes('data-act="sel:9"') && plain(region('strip')).includes('自动跟随 · 关'), 'the new proposal shows up as a card; the switch says auto-follow is off')
  store.proposals.delete('9')
  store.follow = true
  setManualPick(false)
  pickActive()
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
  const pre = ['EvilDrain', '新增 rescue()', 'approver（人工） 已放行 · 冷静期满内门就开', 'approver 人工放行；Chainlink CRE 仍会补判，否决优先']
  ok(lack(pre, plain(a.h)) === '' && a.h.includes('class="lk ph-cleared'), `approver-cleared EvilDrain: the verdict card says the CRE still judges it${lack(pre, plain(a.h))}`)
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
  const zh = ['已弹出 · Chainlink CRE 否决', 'R3B', '外人没有授权就搬走了持有人的代币。', 'EvilDrain']
  ok(lack(zh, plain(a.h)) === '' && a.h.includes('class="lk ph-ejected') && a.h.includes('pipe st-done k-veto'), `the CRE veto (R3B) wins over the approver's clearance${lack(zh, plain(a.h))}`)
  const tw = plain(shot('5', 'zh-TW').h)
  ok(lack(['外人沒有授權就搬走了持有人的代幣。', '新增 rescue()：任何人都能不經授權搬走持有人的幣'], tw) === '' && !SIMPLIFIED_ONLY.test(tw), 'zh-TW: R3B and the EvilDrain card, no simplified characters')
  const en = plain(shot('5', 'en').h)
  const enw = ['EvilDrain', "Adds rescue(): anyone can move a holder's tokens without an allowance", "An outsider moved a holder's tokens without an allowance.", 'R3B · Holder funds moved']
  ok(lack(enw, en) === '' && !CJK.test(en), `en: R3B and the EvilDrain card${lack(enw, en)}`)
}

// ---------- 8c. a veto whose log is out of reach: nobody is named ----------
{
  PROPS.set(6, prop(IMPL.evilDrain, 2, 1250, 1n))
  const p6 = store.ensure('6')
  Object.assign(p6, { kind: '0', target: IMPL.evilDrain, codehash: H32('c6'), proposeBlock: 1250, readyBlock: 1275, card: 'evilDrain' })
  p6.chain = { status: 2, vetoCount: 1, proposer: OWNER, clearanceOf: null }
  const en = plain(shot('6', 'en').h)
  ok(en.includes('Ejected · vetoed on chain') && en.includes('Vetoed on chain (the veto log is out of reach)') && !en.includes('vetoed by Chainlink CRE') && !en.includes('emergency guardian'), 'a veto out of reach: ejected, and no one is named as the vetoer')
}

// ---------- 8d. "remove the CRE receiver" (a guardian change) vetoed with R7, simulator workflow id ----------
{
  const NOHOOK = { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} }
  const EV7 = H32('evidence #7')
  PROPS.set(7, { ...prop(RECV, 2, 1260, 1n), kind: 1, value: 0n, codehash: ZERO32 })
  const logs7 = [
    mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 7n, kind: 1, target: RECV, value: 0n, data: '0x', codehash: ZERO32, readyBlock: 1285n }, 1260, T('p7'), 0),
    mkLog(ADMIN_ABI, ADMIN, 'Vetoed', { id: 7n, guardian: RECV, ruleHash: ruleHashOf('R7_CONFIG_GUARD'), vetoCount: 1n }, 1261, T('v7'), 0),
    mkLog(RECEIVER_ABI, RECV, 'Verdict', { proposalId: 7n, action: 0, ruleHash: ruleHashOf('R7_CONFIG_GUARD'), evidenceHash: EV7, workflowId: ('0x' + '11'.repeat(32)) as Hex }, 1261, T('v7'), 1),
  ]
  for (const l of logs7) handleLog(l, true, NOHOOK)
  blocks.ingest(1262)
  ok(P('7').kind === '1' && P('7').value === '0', 'Proposed.value is kept (guardian change: 0 = remove)')
  setLang('en', false)
  ok(identOf(P('7')).title === 'Remove the Chainlink CRE guardian' && identOf(P('7')).name === 'Remove CRE', 'a guardian change that removes the CRE receiver is named as such')
  const a = shot('7', 'en', true)
  const w = ['Proposal #7 · Guardian change', 'Remove the Chainlink CRE guardian', 'R7', "A guardian, cooldown or break-glass change without the approver's pre-approval.", 'R7 · Config not approved', 'Ejected · vetoed by Chainlink CRE']
  ok(lack(w, plain(a.h)) === '' && !a.h.includes('1'.repeat(64)) && !plain(a.h).includes('Workflow id'), `R7 veto of "remove the CRE receiver"; the placeholder workflow id stays hidden${lack(w, plain(a.h))}`)
  // R7 is decided from chain reads: the verdict card must not claim an attack simulation that never ran
  const pipe = plain(region('v-pipe'))
  const cfgSteps = ['Config check', 'chain reads at the proposal block: approver pre-approval', 'Consensus', 'Signed report', 'Veto on chain']
  ok(lack(cfgSteps, pipe) === '' && !pipe.includes('Attack simulation') && !pipe.includes('All answers agree') && !pipe.includes('eth_simulateV1') && region('v-pipe').includes('n-4'), `R7 pipeline: config check, consensus, signed report, on chain; no simulation steps${lack(cfgSteps, pipe)}`)
  const zh = plain(shot('7', 'zh-CN').h)
  ok(lack(['移除 Chainlink CRE guardian', '移除 CRE guardian', 'R7 · 配置变更未核准', '配置检查', '在提案区块读链上状态：approver 是否预先核准', '共识聚合'], zh) === '' && !plain(region('v-pipe')).includes('攻击模拟') && !plain(region('v-pipe')).includes('答案全部一致'), 'zh-CN: the same proposal in Chinese, with the config-check pipeline')
  const tw = plain(shot('7', 'zh-TW').h)
  ok(tw.includes('設定檢查') && !plain(region('v-pipe')).includes('攻擊模擬') && !SIMPLIFIED_ONLY.test(tw), 'zh-TW: config-check pipeline, no simplified characters')
  setLang('zh-CN', false)
}

// ---------- 8e. the pipeline is what the workflow really ran; a cleared config change says so ----------
{
  const names = (kind: string, rule: string | null) => pipelineOf(kind, rule).map((s) => s.k).join(',')
  ok(names('0', null) === 'p.sim,p.agree,p.don,p.sign,p.chain' && names('0', 'R1_TOTAL_SUPPLY') === 'p.sim,p.agree,p.don,p.sign,p.chain' && names('0', 'R9_NEW_OPCODES') === 'p.sim,p.agree,p.don,p.sign,p.chain', 'an upgrade: attack simulation on 4 providers, all answers agree, DON, report, chain')
  ok(['1', '2', '3'].every((k) => names(k, 'R7_CONFIG_GUARD') === 'p.cfg,p.don,p.sign,p.chain' && names(k, null) === 'p.cfg,p.don,p.sign,p.chain'), 'a change to the airlock (kinds 1-3): config check from chain reads, then DON, report, chain')
  ok(names('0', 'R5_STRICT_CODEHASH') === 'p.static,p.don,p.sign,p.chain' && names('0', 'R8_INIT_DATA') === 'p.static,p.don,p.sign,p.chain', 'R5 and R8 are decided before any simulation')
  ok(names('0', 'R6_SIM_FAILURE') === 'p.simFail,p.don,p.sign,p.chain' && pipelineOf('0', 'R6_SIM_FAILURE')[0].fail === true, 'R6: the simulation could not decide (fail-closed), drawn as the failing step')
  // a shorter cooldown cleared by the CRE (pre-approved by the approver): no "survived the attack simulation"
  const p8 = store.ensure('8')
  Object.assign(p8, { kind: '2', value: '20', target: '0x0000000000000000000000000000000000000000', codehash: ZERO32, proposeBlock: 1262, readyBlock: 1287 })
  p8.chain = { status: 1, vetoCount: 0, proposer: OWNER, clearanceOf: H32('evidence #8') }
  p8.clearance = { evidenceHash: H32('evidence #8'), clearer: RECV, by: 'cre', tx: T('c8'), block: 1263 }
  p8.guards.cre = { verdict: 'pass', tx: T('c8'), block: 1263, evidenceHash: H32('evidence #8') }
  const en = shot('8', 'en')
  const p = plain(en.h)
  ok(lack(['Change the cooldown to 20 blocks', 'The config check passed: the approver pre-approved it, or it does not weaken the airlock.', 'Config check', 'Config check passed', 'Clear on chain'], p) === '' && !p.includes('Survived the attack simulation') && !plain(region('v-pipe')).includes('Attack simulation'), `a cleared config change: config check passed, no attack simulation claimed${lack(['The config check passed'], p)}`)
  const zh = plain(shot('8', 'zh-CN').h)
  ok(zh.includes('配置检查通过：approver 已预先核准，或这个变更没有削弱气闸。') && !zh.includes('撑过攻击模拟'), 'zh-CN: a cleared config change')
  store.proposals.delete('8')
  pickActive()
}

// ---------- 8f. small pieces of the stage ----------
{
  const h = phrases('Sealed for good · execute reverts')
  ok((h.match(/class="ph"/g) ?? []).length === 2 && (h.match(/class="sep"/g) ?? []).length === 1, 'door captions: one span per phrase, the separator on its own (hidden on a phone)')
  ok(phrases('冷静期 25 块 ≈ 5 分钟').includes('25\u00a0块') && phrases('冷静期 25 块 ≈ 5 分钟').includes('≈\u00a05\u00a0分钟') && phrases('Proposed in block #11,950,735').includes('block\u00a0#11,950,735'), 'door captions: numbers stay with their units, "block" with its number')
  setLang('en', false)
  ok(t('p.agreeS') === 'at least 2 of 4 answer · every answer matches', 'en: the agreement step reads correctly')
  setLang('zh-CN', false)
}

// ---------- 9. identity: nothing in web/ names another project or a local path ----------
{
  const hits = scanWeb(WEB)
  ok(hits.length === 0, `web/ sources are clean of blocked names and local paths (${NAMES_NOTE})${hits.length ? ': ' + hits.map((x) => `${x.file} (${x.hits.join(', ')})`).join('; ') : ''}`)
  ok(findBlocked(html()).length === 0, 'rendered page is clean too')
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
