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
import { backfillLab, chainHealth, loadOrder, loadPicked, startChainWatch, TOPICS } from '../src/chainwatch'
import { CONFIG } from '../src/config'
import { HELP_ROWS, keyAction, labIndexOfKey, stepId, type Action } from '../src/controls'
import { explorerUrl, fmtEth, fmtGasPrice, realWorkflowId } from '../src/derive'
import { blockTs, handleLog, pickActive, resetSeen, setManualPick } from '../src/events'
import { DICT, setLang, t, type Lang } from '../src/i18n'
import { historyIn, judgeProgress, playbackGate, replay, tickReplay } from '../src/playback'
import { AutoReplay, buildTimeline, snapshotAt } from '../src/replay'
import {
  AUTOPLAY_CARD,
  AUTOPLAY_DELAY_MS,
  autoplayDataIn,
  autoplayRuledOut,
  autoplayWanted,
  fmtDay,
  INTRO_SLOW_MS,
  introSlow,
  introWanted,
  lab,
  LAB_CARDS,
  LAB_IDS,
  LAB_PLAY,
  labIdOf,
  labIntro,
  labPlaying,
  labSatisfied,
  pickFor,
  pickNow,
  playLab,
  stageOf,
  stagesFor,
  tickLab,
  type AutoplayCtx,
  type LabId,
} from '../src/lab'
import {
  launchCard,
  launchStage,
  loadOperator,
  mayOperate,
  op,
  OP_DISABLED,
  operatorVisible,
  parseLaunchResponse,
  parseOperatorInfo,
  saveToken,
  takeTokenFromUrl,
  tokenFromUrl,
} from '../src/operator-client'
import { CHAIN, chainWithRpc, CLEAN, FORK, GUARDS, isLoopback, MODE, OFFLINE, parseClean, parsePick, parseRpcOverride, pickMode, rpcOverrideOf } from '../src/runtime'
import { newProposal, store, type Proposal } from '../src/store'
import { ruleHashOf } from '../src/types'
import { launchErrorText } from '../src/lab-ui'
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
  // ?rpc= is for a local fork only: a link to the public site must never make it read (and call "Live · Ethereum
  // Sepolia") someone else's JSON-RPC. FORK is exactly "rpcOverrideOf(?rpc=) !== null".
  ok(
    rpcOverrideOf('http://127.0.0.1:19621/') === 'http://127.0.0.1:19621' && rpcOverrideOf('http://localhost:8545') === 'http://localhost:8545' &&
      ['https://evil.example', 'https://sepolia.drpc.org', 'http://127.0.0.1.evil.example:8545', 'javascript:alert(1)', '', null].every((x) => rpcOverrideOf(x) === null) &&
      rpcOverrideOf('http://127.0.0.1:19621', true) === null,
    '?rpc= override: loopback addresses only; any other host (or offline mode) is ignored, so FORK stays off',
  )
  ok(
    CHAIN.historyHttp.length === 4 && CHAIN.historyHttp.every((u) => u.startsWith('https://')) && CHAIN.historyHttp[0] === 'https://sepolia.drpc.org' && CHAIN.historyHttp[3] === 'https://ethereum-sepolia-rpc.publicnode.com' && new Set(CHAIN.historyHttp).size === 4,
    `proposal history from ${CHAIN.historyHttp.length} endpoints: drpc first, publicnode (prunes old logs) last`,
  )
  const evil = chainWithRpc(CONFIG.sepolia, rpcOverrideOf('https://evil.example'))
  ok(
    evil.http.length === 3 && evil.http.join() === CONFIG.sepolia.http.join() && evil.ws.join() === CONFIG.sepolia.ws.join() && evil.historyHttp.join() === CONFIG.sepolia.historyHttp.join() && !evil.http.some((u) => u.includes('evil')),
    '?rpc=https://evil.example: the page keeps reading the 3 Sepolia endpoints',
  )
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
  // history (eth_getLogs with a proposal id topic) goes to the history endpoint first (one public endpoint prunes old
  // logs); everything else to the head endpoint; rotation only on failure
  const isHist = (x: { method: string; params: unknown[] }) => x.method === 'eth_getLogs' && ((x.params[0] as { topics: unknown[] }).topics?.length ?? 0) > 1
  ok(
    CHAIN.historyHttp[0] === 'https://sepolia.drpc.org' &&
      rpcCalls.filter(isHist).length > 0 &&
      rpcCalls.filter(isHist).every((x) => x.url === CHAIN.historyHttp[0]) &&
      rpcCalls.filter((x) => !isHist(x)).every((x) => x.url === CHAIN.http[0] || (x.method === 'eth_chainId' && x.url === CHAIN.historyHttp[0])),
    `history getLogs go to ${CHAIN.historyHttp[0]}, every other JSON-RPC to ${CHAIN.http[0]} (rotation only on failure)`,
  )
  ok(NoSocket.opened.includes(CHAIN.ws[0]), 'logs subscription over WS (eth_subscribe logs)')
}
ok(await until(() => !!store.receipts.get(T('v1').toLowerCase()) && !!store.receipts.get(T('c2').toLowerCase()) && blockTs.has(1000) && blockTs.has(1103), 5000), 'veto and clearance receipts (gasUsed, effectiveGasPrice) and block timestamps are read')

// ---------- 6b. first visit: a neutral intro until its replay starts, never the newest proposal's final verdict ----------
{
  const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  setLang('zh-CN', false)
  render()
  const hero = plain(dom.els.get('h-head')?.innerHTML ?? '') + plain(dom.els.get('h-count')?.innerHTML ?? '')
  const vm = plain(dom.els.get('v-main')?.innerHTML ?? '')
  ok(labIntro() && hero.includes('正在载入一笔真实攻击') && hero.includes('重播即将开始') && vm.includes('等待重播'), `first visit, data in, replay not started yet: the intro (${hero.slice(0, 60)})`)
  ok(!(dom.els.get('h-lock')?.innerHTML ?? '').includes('ph-ejected') && !(dom.els.get('h-lock')?.innerHTML ?? '').includes('ph-executed') && !/否决|放行|已弹出|已执行/.test(hero + vm), 'the intro shows no verdict: no ejected or executed airlock, no Veto or Clear')
  // sections 7-9 read the page after its first-visit replay (the intro is over); 10g plays the autoplay itself
  lab.autoplay = 'done'
  render()
  ok(!labIntro() && !plain(dom.els.get('h-head')?.innerHTML ?? '').includes('正在载入一笔真实攻击'), 'once the first-visit replay is over (or ruled out), the newest proposal is on screen')
}

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
  ok(acts.every((x) => ['sel', 'follow', 'tab'].includes(x)) && strip.includes('data-act="sel:1"') && strip.includes('data-act="sel:3"') && strip.includes('class="pc ph-ejected on"') && strip.includes('data-act="tab:lab"'), `strip: one card per proposal, the shown one highlighted, the auto-follow switch and the tab back to the attack picker (${[...new Set(acts)].join(', ')})`)
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
  const w = ['已执行 · DemoBTC v2 上线', '升级已生效', '区块 #1,180 开启', 'DemoBTC v2', '只多一个 version() 的诚实升级：放行后执行', '放行', '撑过攻击模拟：每条规则都守住了', '提案后 3 块 · 36 秒', '放行上链', '已换上 DemoBTC v2', '执行交易']
  ok(lack(w, plain(a.h)) === '' && a.h.includes('class="lk ph-executed') && a.h.includes('pipe st-done k-clear'), `zh-CN executed: cleared by the CRE, then the inner door opened${lack(w, plain(a.h))}`)
  ok(a.h.includes(`https://sepolia.etherscan.io/tx/${T('e2')}`) && a.h.includes(`https://sepolia.etherscan.io/tx/${T('c2')}`), 'executed: report tx and execute tx links')
}
{
  const a = shot('3', 'zh-CN')
  const w = ['冷静期已满', '链上还没有放行', '冷静期已满 · 没有放行，内门继续锁住', '锁住 · 没有放行', '判定中', 'EvilBaseFee', '模拟里装成好人，上了真实区块才让人增发']
  ok(lack(w, plain(a.h)) === '' && a.h.includes('class="lk ph-waiting') && a.h.includes('class="banner ph-waiting') && a.h.includes('pipe st-run'), `zh-CN past readyBlock without clearance: inner door stays locked${lack(w, plain(a.h))}`)
}
for (const [id, words] of [
  ['1', ['升級氣閘 · 每次代理升級都要過 Chainlink CRE', '外門', '氣閘艙', '內門', '已彈出', '陌生地址的一次呼叫就改變了總供應量。', '提案後 2 塊 · 24 秒', '永久封死', '證據雜湊', '事件串流']],
  ['2', ['已執行 · DemoBTC v2 上線', '升級已生效', '放行', '撐過攻擊模擬：每條規則都守住了', '放行上鏈']],
  ['3', ['冷靜期已滿', '鎖住 · 沒有放行', '模擬裡裝成好人，上了真實區塊才讓人增發']],
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
  ['3', ['Cooldown over', 'Locked · no clearance', 'Judging', 'Plays nice in a simulation']],
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
  ok(lack(['外人沒有授權就搬走了持有人的代幣。', '新增 rescue()：不經授權就能搬走別人的幣'], tw) === '' && !SIMPLIFIED_ONLY.test(tw), 'zh-TW: R3B and the EvilDrain card, no simplified characters')
  const en = plain(shot('5', 'en').h)
  const enw = ['EvilDrain', "Adds rescue(): anyone can move other people's tokens", "An outsider moved a holder's tokens without an allowance.", 'R3B · Holder funds moved']
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

// ---------- 8g. a re-sent veto report: anyone may re-send a mined report until it expires; the first veto stays ----------
{
  const NOHOOK = { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive() {} }
  const EVX = H32('evidence #40')
  const WFX = H32('a workflow id the re-sender chose')
  const R1 = ruleHashOf('R1_TOTAL_SUPPLY')
  // one report transaction: the receiver's Verdict, then AirlockAdmin's Vetoed and ReasonAttached
  const report = (b: number, tx: Hex, wf: Hex) => [
    mkLog(RECEIVER_ABI, RECV, 'Verdict', { proposalId: 40n, action: 0, ruleHash: R1, evidenceHash: EVX, workflowId: wf }, b, tx, 0),
    mkLog(ADMIN_ABI, ADMIN, 'Vetoed', { id: 40n, guardian: RECV, ruleHash: R1, vetoCount: 1n }, b, tx, 1),
    mkLog(ADMIN_ABI, ADMIN, 'ReasonAttached', { id: 40n, guardian: RECV, reportHash: EVX }, b, tx, 2),
  ]
  const proposed = mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 40n, kind: 0, target: IMPL.evilMint, value: 0n, data: '0x', codehash: H32('c40'), readyBlock: 1525n }, 1500, T('p40'), 0)
  const first = report(1502, T('v40'), WF)
  const again = report(1530, T('v40 re-sent'), WFX)
  const check = (label: string) => {
    const v = airlockView(P('40'), 1600)
    const a = P('40').guards.cre
    ok(
      v.phase === 'ejected' && v.veto?.afterBlocks === 2 && v.veto.tx === T('v40') && v.veto.workflowId === WF && v.veto.toInner === 23 && a.block === 1502 && P('40').reason?.tx === T('v40') && a.evidenceHash === EVX,
      `${label}: the first veto stays on screen (2 blocks after the proposal, its tx and workflow id), not the re-sent one (shown: ${v.veto?.afterBlocks} blocks, ${v.veto?.tx === T('v40') ? 'first tx' : 'other tx'}, ${v.veto?.workflowId === WF ? 'first workflow id' : 'other workflow id'})`,
    )
  }
  const streamBefore = store.stream.length
  for (const l of [proposed, ...first, ...again]) handleLog(l, false, NOHOOK)
  check('a veto report re-sent 28 blocks later')
  ok(store.stream.slice(streamBefore).filter((l) => l.type === 'Vetoed' && l.text.includes('#40')).length === 2, 'the event stream still lists both Vetoed logs: both are real chain events')
  store.proposals.delete('40')
  resetSeen()
  for (const l of [proposed, ...again, ...first]) handleLog(l, false, NOHOOK)
  check('the same logs out of order (the re-sent report read first)')
  store.proposals.delete('40')
  pickActive()
}


// ---------- 10. attack picker (lab.ts) and operator mode (operator-client.ts) ----------
{
  // 10a. which card a proposal is
  const names = store.implNames
  const mk = (id: string, kind: string, target: string, value = '0', extra: Partial<Proposal> = {}): Proposal => ({ ...newProposal(id), kind, target, value, codehash: '0x02', proposeBlock: 100, readyBlock: 125, ...extra })
  ok(LAB_IDS.join(',') === 'evil-mint,evil-owner,evil-fee,evil-basefee,evil-drain,remove-receiver,v2' && LAB_CARDS.length === 7, 'picker: seven cards in the order of the operator API card ids')
  const upg = (['evilMint', 'evilOwner', 'evilFee', 'evilBaseFee', 'evilDrain', 'v2'] as const).map((k) => labIdOf(mk('1', '0', IMPL[k]), names))
  ok(upg.join(',') === 'evil-mint,evil-owner,evil-fee,evil-basefee,evil-drain,v2', `card -> proposal: an upgrade to each demo implementation is its card (${upg.join(',')})`)
  ok(labIdOf(mk('1', '1', RECV, '0'), names) === 'remove-receiver' && labIdOf(mk('1', '1', RECV.toUpperCase().replace('0X', '0x'), '0'), names) === 'remove-receiver', 'card -> proposal: removing the CRE receiver (guardian change, value 0) is "remove-receiver"')
  ok(
    [mk('1', '1', RECV, '1'), mk('1', '1', OWNER, '0'), mk('1', '0', IMPL.v1), mk('1', '0', IMPL.paused), mk('1', '2', ZERO32.slice(0, 42), '20'), mk('1', '3', IMPL.paused), mk('1', '0', '')].every((p) => labIdOf(p, names) === null),
    'card -> proposal: adding a guardian, another guardian, v1, the paused target, a cooldown or break-glass change are not picker cards',
  )
  const ME = (id: string, b: number, extra: Partial<Proposal> = {}) => mk(id, '0', IMPL.evilMint, '0', { proposeBlock: b, readyBlock: b + 25, proposeTx: H(b), ...extra })
  const veto = (b: number) => ({ guards: { cre: { verdict: 'veto' as const, rule: 'R1_TOTAL_SUPPLY', tx: H(b), block: b }, breakglass: {} }, chain: { status: 2, vetoCount: 1, proposer: OWNER, clearanceOf: null } })
  const set = [ME('1', 100, veto(101)), ME('5', 500, veto(502)), ME('7', 700)]
  const pk = pickFor('evil-mint', set, names, 710)
  ok(pk.replay?.id === '5' && pk.live?.id === '7', `the card replays its newest judged proposal (#${pk.replay?.id}) and shows a newer one in its cooldown as live (#${pk.live?.id})`)
  ok(pickFor('evil-mint', set, names, 800).live === null && pickFor('evil-mint', [ME('7', 700, { dropped: true })], names, 710).live === null, 'a proposal past its cooldown without a verdict, or dropped in a reorg, is not live')
  const V2 = (id: string, b: number, exec: boolean) => {
    const p = mk(id, '0', IMPL.v2, '0', { proposeBlock: b, readyBlock: b + 25 })
    p.clearance = { evidenceHash: H(b + 1), clearer: RX, by: 'cre', tx: H(b + 1), block: b + 1 }
    p.guards.cre = { verdict: 'pass', tx: H(b + 1), block: b + 1 }
    if (exec) p.execute = { tx: H(b + 30), block: b + 30 }
    p.chain = { status: exec ? 3 : 1, vetoCount: 0, proposer: OWNER, clearanceOf: H(b + 1) }
    return p
  }
  const v2s = [V2('2', 200, true), V2('6', 600, false)]
  ok(pickFor('v2', v2s, names).replay?.id === '2' && pickFor('v2', [V2('6', 600, false)], names).replay?.id === '6', 'the v2 card prefers the newest executed upgrade (clear, cooldown, execute), else the newest cleared one')
  ok(labSatisfied('v2', pickFor('v2', v2s, names)) && !labSatisfied('v2', pickFor('v2', [V2('6', 600, false)], names)) && !labSatisfied('evil-mint', { replay: null, live: null }), 'the backfill keeps looking for an executed v2')
  // on the fake Sepolia read above
  const now = LAB_IDS.map((id) => `${id}:${pickNow(id).replay?.id ?? '-'}`).join(' ')
  ok(pickNow('evil-mint').replay?.id === '1' && pickNow('v2').replay?.id === '4' && pickNow('evil-drain').replay?.id === '5' && pickNow('remove-receiver').replay?.id === '7' && pickNow('evil-basefee').replay === null, `picker on the fake Sepolia: ${now}`)

  // 10b. the picker's playback: arrival, a "judging" hold, the verdict, then the cooldown fast-forwarded
  {
    const p = base()
    p.proposeTx = H(100)
    p.clearance = { evidenceHash: H(0xc1), clearer: RX, by: 'cre', tx: H(102), block: 102 }
    p.guards.cre = { verdict: 'pass', tx: H(102), block: 102 }
    p.execute = { tx: H(127), block: 127 }
    p.chain = { status: 3, vetoCount: 0, proposer: '0x1', clearanceOf: H(0xc1) }
    const e = new AutoReplay(0, { msPerBlock: 600, firstDelayMs: 0, idleMs: 1000, gapMs: 0, reducedHoldMs: 100 })
    e.paused = true
    e.playOne(0, p, false, { msPerBlock: 100, fastMsPerBlock: 10, gapMs: 0 })
    const vb = (ms: number) => e.frame(ms, () => p)?.vblock
    ok(vb(450) === 102 && vb(505) === 103 && vb(715) === 124 && vb(725) === 125, 'picker playback: blocks before the verdict at the normal pace, the rest of the cooldown fast-forwarded')
    ok(e.progress(0)?.f === 0 && e.progress(10_000)?.f === 1 && e.onDemand, 'picker playback reports its progress (0..1)')
    const j = base()
    j.guards.cre = { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', tx: H(101), block: 101 }
    j.chain = { status: 2, vetoCount: 1, proposer: '0x1', clearanceOf: null }
    e.playOne(0, j, false, { msPerBlock: 100, dwellMs: { judging: 1000 } })
    ok(vb(250) === 100 && vb(1250) === 100 && vb(1350) === 101, 'a verdict one block after the proposal still gets a "judging" hold')
    const tl = buildTimeline(p)!
    ok(stagesFor('ejected', false).join() === 'arrive,judge,veto' && stagesFor('cleared', true).join() === 'arrive,judge,clear,fast,exec', 'picker steps: arrive, judge, veto | clear, fast-forward, execute')
    ok(stageOf('idle', 98, tl) === 'arrive' && stageOf('chamber', 101, tl) === 'judge' && stageOf('cleared', 102, tl) === 'clear' && stageOf('cleared', 110, tl) === 'fast' && stageOf('executed', 127, tl) === 'exec' && stageOf('ejected', 101, tl) === 'veto', 'picker step of each phase')
    ok(LAB_PLAY.fastMsPerBlock! < LAB_PLAY.msPerBlock! && (LAB_PLAY.dwellMs?.judging ?? 0) > 0 && (LAB_PLAY.dwellMs?.verdict ?? 0) >= 3000, 'the picker holds on the verdict and fast-forwards the cooldown')
    ok(fmtDay(Date.UTC(2026, 9, 20, 16, 30) / 1000) === '2026-10-21' && fmtDay(undefined) === null && fmtDay(0) === null, 'replay dates are venue dates (UTC+8)')
  }

  // 10c. first-visit autoplay rules
  const ctx: AutoplayCtx = { clean: false, pick: null, offline: false, ready: true, interacted: false, liveBusy: false }
  ok(autoplayWanted(ctx), 'first visit: the page plays one replay on its own')
  ok(!autoplayWanted({ ...ctx, clean: true }) && autoplayRuledOut({ ...ctx, clean: true }), 'no autoplay with ?clean=1 (recording)')
  ok(!autoplayWanted({ ...ctx, pick: '4' }) && autoplayRuledOut({ ...ctx, pick: '4' }), 'no autoplay with ?p=<id>')
  ok(!autoplayWanted({ ...ctx, offline: true }) && !autoplayWanted({ ...ctx, interacted: true }) && autoplayRuledOut({ ...ctx, interacted: true }), 'no autoplay offline (the loop plays) or after the viewer picked something')
  ok(!autoplayWanted({ ...ctx, ready: false }) && !autoplayWanted({ ...ctx, liveBusy: true }) && !autoplayRuledOut({ ...ctx, liveBusy: true }) && !autoplayRuledOut({ ...ctx, ready: false }), 'autoplay waits for the data and for a live proposal to finish its cooldown')
  ok(introWanted(ctx) && introWanted({ ...ctx, ready: false }) && introWanted({ ...ctx, ready: false, liveBusy: true }), 'intro: shown while the data loads and until the first-visit replay starts')
  ok(!introWanted({ ...ctx, clean: true }) && !introWanted({ ...ctx, pick: '4' }) && !introWanted({ ...ctx, offline: true }) && !introWanted({ ...ctx, interacted: true }) && !introWanted({ ...ctx, liveBusy: true }), 'no intro with ?clean=1, ?p=, offline, after a pick, or when a live proposal is in its cooldown (live wins)')
  ok(AUTOPLAY_CARD === 'evil-drain' && labIndexOfKey('1') === 0 && labIndexOfKey('7') === 6 && labIndexOfKey('8') === null && keyAction('5') === 'lab' && keyAction('o') === 'operator', 'autoplay card is evil-drain; keys 1-7 play the cards, O opens the operator panel')

  // 10d. the operator UI stays invisible: disabled, 404, network error, or no token
  setLang('zh-CN', false)
  const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const opHtml = () => {
    render()
    const h = html() + region('t-ctl') + region('lab')
    return /data-act="(operator|opask|opgo)|class="lc-op|op-badge|实战发起/.test(h)
  }
  ok(JSON.stringify(parseOperatorInfo(404, null)) === JSON.stringify(OP_DISABLED) && !parseOperatorInfo(200, { enabled: false, auth: 'none', cards: ['v2'], cooldownBlocks: 3 }).enabled && !parseOperatorInfo(200, { enabled: true, auth: 'open', cards: ['v2'] }).enabled && !parseOperatorInfo(200, { enabled: true, auth: 'none', cards: ['0x01'] }).enabled, 'GET /api/operator: 404, enabled false, an unknown auth or no known card mean disabled')
  const good = parseOperatorInfo(200, { enabled: true, auth: 'token', cards: ['v2', 'evil-mint', 'bogus'], cooldownBlocks: 3 })
  ok(good.enabled && good.auth === 'token' && good.cards.join() === 'evil-mint,v2' && good.cooldownBlocks === 3, 'GET /api/operator: known cards only, in picker order')
  const TOKEN = 'test-operator-token-0123456789abcdef'
  ok(!operatorVisible(OP_DISABLED, TOKEN) && !operatorVisible(good, null) && operatorVisible(good, TOKEN) && operatorVisible({ ...good, auth: 'none' }, null), 'operator UI: needs enabled AND (auth none OR a token)')
  op.token = null
  await loadOperator(res(404, { error: 'not found' }))
  ok(!op.info.enabled && op.loaded && !opHtml(), 'a static deploy (404): nothing operator-related on the page')
  await loadOperator((async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch)
  ok(!op.info.enabled && !opHtml(), 'the API unreachable: nothing operator-related on the page')
  await loadOperator(res(200, { enabled: true, auth: 'token', cards: [...LAB_IDS], cooldownBlocks: 3 }))
  ok(op.info.enabled && !opHtml(), 'enabled but no token in this browser: nothing operator-related on the page')
  op.prompt = true
  render()
  ok(region('op-token').includes('data-form="optoken"') && region('op-token').includes('type="password"') && plain(region('op-token')).includes('口令只存在这台浏览器里') && !opHtml(), '?op=1: a small token prompt (password field), and still no operator controls until a token is saved')
  await loadOperator(res(404, null))
  render()
  ok(!op.prompt && region('op-token') === '', '?op=1 on a page without the operator API: no prompt at all')
  await loadOperator(res(200, { enabled: true, auth: 'token', cards: [...LAB_IDS], cooldownBlocks: 3 }))
  ui.help = true
  render()
  ok(!plain(region('help')).includes('实战发起面板') && plain(region('help')).includes('重播第 1–7 种攻击'), 'the help lists keys 1-7 for everyone, the operator key only for the operator')
  ui.help = false

  // 10e. the token: ?op=<token> is kept in this browser and leaves the address bar at once
  const t1 = tokenFromUrl(`http://localhost/?lang=en&op=${TOKEN}#top`)
  ok(t1.token === TOKEN && t1.stripped === '/?lang=en#top' && !t1.stripped.includes(TOKEN), '?op=<token>: the token is read and the address loses it')
  const t2 = tokenFromUrl('http://localhost/?op=1')
  const t3 = tokenFromUrl('http://localhost/?op=short&p=4')
  ok(t2.prompt && t2.token === null && t2.stripped === '/' && t3.token === null && t3.stripped === '/?p=4' && tokenFromUrl('http://localhost/?lang=en').stripped === null, '?op=1 asks for the token; a malformed token is dropped (and still stripped); no ?op leaves the address alone')
  const t4 = tokenFromUrl(`http://localhost/?lang=en#op=${TOKEN}`)
  const t5 = tokenFromUrl(`http://localhost/?op=1#op=${TOKEN}&x=1`)
  ok(
    t4.token === TOKEN && t4.stripped === '/?lang=en' && t5.token === TOKEN && t5.stripped === '/#x=1' && !t5.stripped.includes(TOKEN) && tokenFromUrl('http://localhost/#top').stripped === null && tokenFromUrl('http://localhost/#stop=1').stripped === null,
    '#op=<token> (never sent to the server) is read the same way and leaves the address; #top or #stop=1 are left alone',
  )
  {
    const keep = { token: op.token, prompt: op.prompt }
    op.token = null
    op.prompt = false
    const pub = ['upgrade-airlock.pages.dev', 'example.org', '', null, undefined, '127.0.0.1.nip.io'].every((h) => !mayOperate(h))
    const lo = ['127.0.0.1', 'localhost', '[::1]'].every((h) => mayOperate(h))
    op.prompt = true
    const asked = mayOperate('upgrade-airlock.pages.dev')
    op.prompt = false
    op.token = TOKEN
    const held = mayOperate('upgrade-airlock.pages.dev')
    op.token = keep.token
    op.prompt = keep.prompt
    ok(pub && lo && asked && held, 'a public visitor never asks /api/operator; only a loopback host, ?op=1 or a saved token do')
  }
  {
    const g = globalThis as unknown as Record<string, unknown>
    const loc = g.location as { search: string; href: string }
    const was = loc.href
    const replaced: string[] = []
    g.history = { state: null, replaceState: (_s: unknown, _t: string, u: string) => void replaced.push(String(u)) }
    loc.href = `http://localhost/?mode=airlock&op=${TOKEN}`
    dom.mem.delete('airlock.op')
    op.token = null
    takeTokenFromUrl()
    loc.href = was
    ok(op.token === TOKEN && dom.mem.get('airlock.op') === TOKEN && replaced.length === 1 && replaced[0] === '/?mode=airlock' && !replaced[0].includes(TOKEN), 'page load: the token goes to localStorage and history.replaceState removes it from the URL')
  }
  ok(opHtml(), 'with the token, the operator UI appears')
  render()
  const opAsk = [...region('lab').matchAll(/data-act="opask:([a-z0-9-]+)"/g)].map((m) => m[1])
  ok(region('t-ctl').includes('data-act="operator"') && opAsk.join(',') === LAB_IDS.join(','), `operator: the bolt button in the top bar and a launch button on each of the 7 cards (${opAsk.length})`)
  op.panel = true
  op.confirm = 'evil-mint'
  render()
  const panel = plain(region('op'))
  ok(lack(['在 Sepolia 上真实发起攻击', '确定在 Sepolia 上发起「任意增发」？', '这会送出一笔真实交易（proposeUpgrade）', '确认发起', '预期：否决 R1', 'proposeSetGuardian(AirlockReceiver, false)', '两次发起至少间隔 3 块'], panel) === '' && region('op').includes('data-act="opgo:evil-mint"') && (region('op').match(/data-act="opgo:/g) ?? []).length === 1, `operator panel: one confirm step before a real launch${lack(['确认发起'], panel)}`)
  setLang('en', false)
  render()
  ok(region('op').includes('Launch &quot;Infinite mint&quot; on Sepolia?') && !CJK.test(plain(region('op'))), 'operator panel in English')
  setLang('zh-CN', false)

  // 10f. a launch: exactly {card} with the bearer token, then the war room follows the transaction on chain
  const calls: { url: string; init: RequestInit }[] = []
  const LTX = H32('launch tx')
  const okFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true, card: 'evil-mint', txHash: LTX }), { status: 200 })
  }) as unknown as typeof fetch
  let sent = 0
  ok((await launchCard('evil-owner' as never, store.proposals.values(), () => sent++, okFetch))?.ok === true, 'a launch is sent')
  const c0 = calls[0]
  const hdr = c0.init.headers as Record<string, string>
  ok(c0.url === '/api/operator/propose' && c0.init.method === 'POST' && c0.init.body === '{"card":"evil-owner"}' && hdr.authorization === `Bearer ${TOKEN}` && !c0.url.includes(TOKEN), 'POST /api/operator/propose with only {card} and the bearer token in a header')
  ok(sent === 1 && op.launch?.state === 'sent' && op.launch.txHash === LTX && launchStage(op.launch, store.proposals.values()).stage === 'sent', 'after the server answers: the tx hash, pending')
  ok((await launchCard('v2', store.proposals.values(), () => sent++, okFetch)) === null && calls.length === 1, 'one launch at a time: a second one waits until the first is on chain')
  op.panel = false
  render()
  ok(plain(region('op-toast')).includes('交易已送出 · 等待上链') && region('op-toast').includes(`https://sepolia.etherscan.io/tx/${LTX}`), 'the status toast: tx sent, with its Etherscan link')
  ok(plain(region('h-head')).includes('操作员刚刚发起 · 真实交易') && plain(region('h-head')).includes('抢走 owner') && region('h-head').includes('tag live') && region('h-count').includes(`https://sepolia.etherscan.io/tx/${LTX}`) && plain(region('v-main')).includes('等待上链') && !region('h-lock').includes('ph-ejected'), 'while the launch is on its way into a block, the airlock shows it as pending (live), not the previous final verdict')
  HEAD = 1330
  const NOHOOK = { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive: (ts: number) => replay.onLive(ts) }
  handleLog(mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 10n, kind: 0, target: IMPL.evilOwner, value: 0n, data: '0x', codehash: H32('c10'), readyBlock: 1325n }, 1300, LTX, 0), true, NOHOOK)
  blocks.ingest(1301)
  render()
  ok(store.activeId === '10' && plain(region('op-toast')).includes('提案 #10 已进气闸 · 等待 Chainlink CRE 判定') && region('h-head').includes('tag live') && plain(region('h-head')).includes('实时') && !region('h-head').includes('tag replay'), 'the proposal lands: auto-follow shows it, labelled live (not a replay); the toast says it is in the airlock')
  ok(region('lab').includes(`实时 #10`) && plain(region('t-status')).includes('实时 · Ethereum Sepolia'), 'the picker card of that attack says live #10; the top bar says live')
  // a visitor starts a picker replay of an older proposal meanwhile; the live verdict of #10 then takes the screen back
  const pickedReplay = playLab('evil-mint') && !!labPlaying() && store.activeId !== '10'
  handleLog(mkLog(ADMIN_ABI, ADMIN, 'Vetoed', { id: 10n, guardian: RECV, ruleHash: ruleHashOf('R2_OWNER'), vetoCount: 1n }, 1302, H32('veto 10'), 0), true, NOHOOK)
  ok(pickedReplay && !labPlaying() && store.activeId === '10', 'auto-follow: a live verdict on the newest proposal stops a picker replay and shows that proposal, not the replayed one')
  render()
  ok(plain(region('op-toast')).includes('提案 #10 已否决 · Chainlink CRE · R2'), `the verdict lands in the toast: ${plain(region('op-toast')).trim()}`)
  const fail = (status: number, body: unknown) => launchCard('v2', store.proposals.values(), () => sent++, res(status, body))
  await fail(409, { ok: false, error: 'cooldown', retryAfterBlocks: 2 })
  render()
  ok(op.launch?.error === 'cooldown' && plain(region('op-toast')).includes('冷却中 · 再等 2 块（约 24 秒）'), '409: cooling down, with the blocks to wait')
  await fail(422, { ok: false, error: 'reverted', detail: 'secret internals' })
  render()
  ok(op.launch?.error === 'reverted' && !region('op-toast').includes('secret internals'), '422: the dry run reverted; the server words are never shown')
  // every answer of the API contract maps to its own error, and every error to its own sentence in each language
  const errOf = (st: number, body: unknown) => (parseLaunchResponse(st, body) as { error?: string }).error
  const table: [number, unknown, string][] = [
    [200, { ok: true, card: 'v2', txHash: '0x12' }, 'unclear'],
    [200, { ok: true, card: 'not-a-card', txHash: LTX }, 'unclear'],
    [400, { ok: false, error: 'unknown card' }, 'unknown card'],
    [401, { ok: false, error: 'unauthorized' }, 'unauthorized'],
    [403, { ok: false, enabled: false, error: 'disabled' }, 'disabled'],
    [403, { ok: false, error: 'forbidden' }, 'forbidden'],
    [404, null, 'disabled'],
    [405, { ok: false, error: 'method' }, 'server'],
    [409, { ok: false, error: 'cooldown', retryAfterBlocks: 2 }, 'cooldown'],
    [422, { ok: false, error: 'reverted' }, 'reverted'],
    [500, { ok: false, error: 'misconfigured' }, 'misconfigured'],
    [500, { ok: false, error: 'internal' }, 'server'],
    [502, { ok: false, error: 'rpc' }, 'rpc'],
  ]
  const wrong = table.filter(([st, b, e]) => errOf(st, b) !== e).map(([st, b]) => `${st}:${JSON.stringify(b)}->${errOf(st, b)}`)
  ok(wrong.length === 0, `launch answers: each status of the API contract has its own error (${wrong.join(' ') || '13 cases'})`)
  const ERRS = ['unknown card', 'unauthorized', 'disabled', 'forbidden', 'cooldown', 'reverted', 'misconfigured', 'rpc', 'server', 'unclear', 'network'] as const
  for (const l of ['zh-CN', 'zh-TW', 'en'] as Lang[]) {
    setLang(l, false)
    const texts = ERRS.map((e) => launchErrorText({ error: e }))
    ok(new Set(texts).size === ERRS.length && texts.every((x) => x.length > 4) && (l !== 'en' || !texts.some((x) => CJK.test(x))) && (l !== 'zh-TW' || !texts.some((x) => SIMPLIFIED_ONLY.test(x))), `${l}: every launch error has its own wording`)
  }
  setLang('zh-CN', false)
  const toast = () => {
    render()
    return plain(region('op-toast'))
  }
  await fail(500, { ok: false, error: 'misconfigured' })
  ok(op.launch?.error === 'misconfigured' && toast().includes('服务器上的私钥不是这个部署的 owner · 没有送出') && opHtml(), '500 misconfigured: the wrong key is named as such (not a network problem)')
  await fail(403, { ok: false, error: 'forbidden' })
  ok(toast().includes('操作员服务拒绝了这个来源') && opHtml(), '403 forbidden (origin guard): said so; operator mode stays')
  await fail(502, { ok: false, error: 'rpc' })
  ok(toast().includes('节点没有接受这笔交易'), '502: the node did not take it')
  await fail(500, { ok: false, error: 'internal' })
  ok(toast().includes('操作员服务出错 · 没有送出'), '500 internal: the service failed')
  await fail(200, { ok: true })
  ok(toast().includes('回应看不懂 · 若交易已送出，战情室会自动接上'), 'a 200 without a tx hash: unclear, the live war room picks it up if it went out')
  await fail(400, { ok: false, error: 'unknown card' })
  ok(toast().includes('这张卡不能发起'), '400: this card cannot be launched')
  await launchCard('v2', store.proposals.values(), () => sent++, (async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch)
  ok(op.launch?.error === 'network' && toast().includes('连不上操作员服务'), 'no answer at all: cannot reach the operator service')
  ok(sent === 1, 'none of the refused launches counted as sent')
  await fail(401, { ok: false, error: 'unauthorized' })
  ok(op.token === null && !dom.mem.has('airlock.op') && !opHtml() && plain(region('op-toast')).includes('操作员口令无效'), '401: the token is forgotten, the operator UI disappears, a notice says why')
  op.notice = null
  op.launch = null
  await loadOperator(res(200, { enabled: true, auth: 'none', cards: [...LAB_IDS], cooldownBlocks: 3 }))
  ok(opHtml(), 'local dev (auth none): the operator UI without a token')
  await fail(403, { ok: false, enabled: false, error: 'disabled' })
  ok(op.launch?.error === 'disabled' && !opHtml() && plain(region('op-toast')).includes('这里的操作员模式已关闭'), '403 disabled: operator mode was switched off on the server; its UI goes, a notice says why')
  op.notice = null
  op.launch = null
  await loadOperator(res(200, { enabled: true, auth: 'none', cards: [...LAB_IDS], cooldownBlocks: 3 }))
  ok(opHtml(), 'and back when the API says enabled again')
  await loadOperator(res(404, null))
  store.proposals.delete('10')
  store.arrival = null
  pickActive()
  ok(!opHtml(), 'and gone again when the API says disabled')

  // 10g. first-visit autoplay on the page: evil-drain plays from its arrival, labelled as a replay of a real proposal
  blockTs.set(1240, blockTime(1240))
  const realNow = Date.now
  let NOW = realNow()
  Date.now = () => NOW
  try {
    const T0 = NOW
    lab.autoplay = 'wait'
    lab.readyAt = 0
    lab.interacted = false
    lab.invite = null
    tickLab(T0)
    ok(lab.autoplay === 'wait' && !labPlaying(T0), 'autoplay waits a moment after the data is in')
    render()
    ok(labIntro(T0) && plain(region('h-head')).includes('正在载入一笔真实攻击') && !region('h-lock').includes('ph-ejected') && !region('h-lock').includes('ph-executed'), 'meanwhile the intro is up, not a final verdict')
    NOW = T0 + AUTOPLAY_DELAY_MS + 10
    tickLab(NOW)
    ok(lab.autoplay === 'playing' && lab.card === 'evil-drain' && labPlaying(NOW)?.pid === '5', `autoplay: the evil-drain card plays proposal #${labPlaying(NOW)?.pid}`)
    render()
    const day = fmtDay(blockTime(1240))!
    ok(plain(region('h-head')).includes(`回放 · 真实 Sepolia 提案 · ${day}`) && plain(region('t-status')).includes('回放 · Sepolia 提案 #5'), `replay label: "回放 · 真实 Sepolia 提案 · ${day}" in the hero, "回放 · Sepolia 提案 #5" in the top bar`)
    ok(plain(region('lab')).includes(`正在回放 #5 · 真实 Sepolia 提案 · ${day}`) && region('lab').includes(`https://sepolia.etherscan.io/tx/${T('p5')}`) && region('lab').includes('class="lc k-veto on'), 'the picker says which real proposal is playing, with its proposal tx link')
    ok(region('h-lock').includes('ph-idle') || region('h-lock').includes(' m-arrive'), 'the replay starts before the proposal arrives (outer door)')
    ok(!labIntro(NOW) && !plain(region('h-head')).includes('正在载入一笔真实攻击'), 'the intro is gone once the replay runs')
    ok(plain(region('h-count')).includes('提案 #5 抵达外门') || region('h-lock').includes(' m-arrive'), 'the replay lead-in says the proposal is reaching the outer door')
    const seen = new Set<string>()
    let vetoShot = ''
    const curs: number[] = []
    const chips: string[] = []
    let vTag = 0
    let compressed = 0
    let lastF = -1
    let monotonic = true
    for (let i = 0; i < 600 && labPlaying(NOW); i++) {
      NOW += 100
      tickLab(NOW)
      tickReplay(NOW)
      const lp = labPlaying(NOW)
      if (lp) seen.add(lp.stage)
      const f = judgeProgress(NOW)
      if (f !== null) {
        if (f < lastF) monotonic = false
        lastF = f
      }
      if (lp?.stage === 'judge') {
        render()
        const m = /CRE · ([^<]+?) (\d)\/(\d)/.exec(plain(region('h-count')))
        if (m) chips.push(`${m[2]}/${m[3]}`)
        if (region('v-head').includes('v-rp')) vTag++
        if (plain(region('h-count')).includes('回放 · 时间已压缩')) compressed++
        const pipe = region('v-pipe')
        if (pipe.includes('pipe st-run') && pipe.includes(' seq')) curs.push((pipe.match(/class="ok"/g) ?? []).length)
      }
      if (lp?.stage === 'veto' && !vetoShot) {
        render()
        vetoShot = html()
      }
    }
    ok(monotonic && lastF === 1, 'judgeProgress runs from the arrival (0) to the verdict (1)')
    ok(curs.length > 5 && curs.every((x, i) => i === 0 || x >= curs[i - 1]) && curs[0] === 0 && Math.max(...curs) >= 3, `while CRE judges, the verdict card walks through the workflow steps one by one (${[...new Set(curs)].join(' → ')} done)`)
    ok(['arrive', 'judge', 'veto'].every((x) => seen.has(x)) && vetoShot.includes('class="lk ph-ejected') && vetoShot.includes('pipe st-done k-veto'), `the replay walks through ${[...seen].join(' → ')} and ends ejected`)
    ok(chips.length > 5 && chips[0] === '1/5' && new Set(chips).size >= 3 && vTag === chips.length, `phone-sized proof: the chamber chip walks the same CRE steps (${[...new Set(chips)].join(' → ')}), the verdict card says "replay"`)
    ok(compressed === chips.length && compressed > 0, 'next to the still counter, the replay says its clock is compressed')
    tickLab(NOW)
    render()
    ok(lab.autoplay === 'done' && lab.invite === 'evil-drain' && plain(region('lab')).includes('刚才是「搬走持有人的币」的真实重播') && (region('lab').match(/ nudge"/g) ?? []).length === 6, 'after the autoplay: the picker invites the viewer to pick another card')
    ok(store.activeId === '5' && !region('h-head').includes('tag replay'), 'after the replay the screen holds the real final state of that proposal')
    ok(plain(region('h-head')).includes(`链上状态 · 提案于 ${day}`) && !region('h-head').includes('tag live'), `and says it is a dated on-chain state ("链上状态 · 提案于 ${day}"), never live`)
    ok(playLab('v2', NOW) && labPlaying(NOW)?.pid === '4' && lab.invite === null && lab.interacted, 'a click on a card plays it (v2 -> the executed #4) and ends the invite')
    let exec = false
    let ff = false
    for (let i = 0; i < 600 && labPlaying(NOW); i++) {
      NOW += 100
      tickReplay(NOW)
      if (labPlaying(NOW)?.stage === 'fast' && !ff) {
        render()
        ff = plain(region('h-count')).includes('冷静期快进 ×80')
      }
      if (labPlaying(NOW)?.stage === 'exec' && !exec) {
        exec = true
        render()
        ok(region('h-lock').includes('ph-executed') && plain(html()).includes('已执行 · DemoBTC v2 上线') && region('lab').includes('st-exec'), 'v2 replay reaches the inner door: executed, the upgrade is live')
      }
    }
    ok(exec, 'the v2 replay played through to its execution')
    ok(ff, 'the fast-forwarded cooldown is marked in the chamber (冷静期快进 ×80)')
  } finally {
    Date.now = realNow
  }

  // 10g2. a cold visitor: the evil-drain proposal is read first, so its replay can start before the others are in;
  // a chain that does not answer turns the intro into an honest "slow" line with the recorded run
  {
    ok(
      loadOrder(['1', '2', '3', '4', '5', '6', '7', '8'], (id) => (({ '8': 'evil-drain', '2': 'evil-drain', '1': 'evil-mint', '4': 'v2' }) as Record<string, LabId>)[id] ?? null).join() === '8,1,4,7,6,5,3,2',
      'load order: the autoplay card\'s newest proposal first, then each other card\'s newest, then the rest newest first',
    )
    ok(loadOrder(['3', '1'], () => null).join() === '3,1' && loadOrder([], () => null).length === 0, 'load order without picker cards: newest first')
    const keep = { ready: playbackGate.ready, loaded: new Set(playbackGate.loaded), startedAt: playbackGate.startedAt }
    const st = { autoplay: lab.autoplay, readyAt: lab.readyAt, interacted: lab.interacted, invite: lab.invite }
    const drainId = pickNow('evil-drain').replay?.id ?? ''
    playbackGate.ready = false
    playbackGate.loaded.clear()
    ok(!autoplayDataIn() && !historyIn(drainId) && !playLab('evil-drain', Date.now(), false), 'nothing read yet: no replay can start')
    playbackGate.loaded.add(drainId)
    ok(autoplayDataIn() && historyIn(drainId) && !historyIn('1'), `the autoplay proposal #${drainId} alone is enough for the first-visit replay; the other cards still wait`)
    lab.autoplay = 'wait'
    lab.readyAt = 0
    lab.interacted = false
    playbackGate.loaded.clear()
    playbackGate.startedAt = Date.now() - INTRO_SLOW_MS - 1000
    render()
    ok(introSlow() && plain(region('h-head')).includes('连接 Sepolia 比较慢') && region('h-head').includes('mode=offline') && plain(region('h-count')).includes('仍在读取链上数据'), 'no answer for 12 s: the intro says the public RPCs are slow and links the recorded run (?mode=offline)')
    playbackGate.startedAt = Date.now()
    ok(!introSlow(), 'and not before 12 s')
    playbackGate.ready = keep.ready
    playbackGate.loaded.clear()
    for (const x of keep.loaded) playbackGate.loaded.add(x)
    playbackGate.startedAt = keep.startedAt
    Object.assign(lab, st)
    render()
  }

  // 10h. a card whose newest judged proposal is older than the recent ones: the backfill reads it
  {
    HEAD = 1400
    NEXT = 31
    PROPS.set(30, prop(IMPL.evilFee, 2, 1350, 1n))
    LOGS.push(
      mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 30n, kind: 0, target: IMPL.evilFee, value: 0n, data: '0x', codehash: H32('c30'), readyBlock: 1375n }, 1350, T('p30'), 0),
      mkLog(ADMIN_ABI, ADMIN, 'Vetoed', { id: 30n, guardian: RECV, ruleHash: ruleHashOf('R3_TRANSFER_CONSERVATION'), vetoCount: 1n }, 1352, T('v30'), 0),
    )
    const before = rpcCalls.filter((c) => c.method === 'eth_call').length
    ok(!pickNow('evil-fee').replay, 'evil-fee has no proposal in the store yet')
    const found = await backfillLab(31, 40)
    const reads = rpcCalls.filter((c) => c.method === 'eth_call').length - before
    ok(found.includes('30') && pickNow('evil-fee').replay?.id === '30' && P('30').guards.cre.rule === 'R3_TRANSFER_CONSERVATION', `backfill: older proposal #30 (EvilFee, R3) found and its logs read (${reads} eth_calls; found ${found.join(',')}; rule ${P('30')?.guards.cre.rule}; pick ${pickNow('evil-fee').replay?.id}; card ${P('30')?.card})`)
    ok(reads <= 2 * 40 + 2, 'backfill reads at most labScanMax older ids')
    store.proposals.delete('30')
    resetSeen()
  }

  // 10i. ?p=<id> of a proposal older than the recent ones: it is read with its logs; an id the chain does not have
  // says so (never "the airlock is empty")
  {
    PROPS.set(25, prop(IMPL.evilOwner, 2, 1360, 1n))
    LOGS.push(
      mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 25n, kind: 0, target: IMPL.evilOwner, value: 0n, data: '0x', codehash: H32('c25'), readyBlock: 1385n }, 1360, T('p25'), 0),
      mkLog(ADMIN_ABI, ADMIN, 'Vetoed', { id: 25n, guardian: RECV, ruleHash: ruleHashOf('R2_OWNER'), vetoCount: 1n }, 1361, T('v25'), 0),
    )
    const keep = { active: store.activeId, follow: store.follow }
    ok(!store.proposals.has('25') && !playbackGate.loaded.has('25'), '?p=25 is not among the recent proposals')
    const got = await loadPicked('25', 31, 1400)
    ok(got && P('25')?.proposeTx === T('p25') && P('25').chain?.status === 2 && P('25').guards.cre.block === 1361 && P('25').guards.cre.rule === 'R2_OWNER' && playbackGate.loaded.has('25'), '?p=25 outside the recent window: that proposal and its logs are read (it can be shown and replayed)')
    const before = rpcCalls.length
    const none = await loadPicked('99', 31, 1400)
    ok(!none && !store.proposals.has('99') && rpcCalls.length === before, '?p=99 past nextId: no such proposal, nothing read and nothing invented')
    store.proposals.delete('25')
    playbackGate.loaded.delete('25')
    chainHealth.pickMissing = '99'
    store.activeId = '99'
    setManualPick(true)
    setLang('en', false)
    render()
    const en = plain(region('h-head'))
    setLang('zh-CN', false)
    render()
    const zh = plain(region('h-head'))
    ok(en.includes('No proposal #99') && en.includes('The newest proposal on Ethereum Sepolia is #7') && !en.includes('The airlock is empty') && zh.includes('没有提案 #99') && !zh.includes('气闸空着'), `the hero says there is no such proposal (${en.trim().slice(0, 90)})`)
    chainHealth.pickMissing = null
    setManualPick(false)
    store.activeId = keep.active
    store.follow = keep.follow
    pickActive()
    resetSeen()
  }

  // 10j. the invite after the first-visit replay goes as soon as a live proposal is on screen (one sent from the CLI or
  // another device takes the screen without the viewer touching the page)
  {
    const keepFollow = store.follow
    store.follow = true
    setManualPick(false)
    lab.autoplay = 'done'
    lab.invite = 'evil-drain'
    render()
    const up = region('lab').includes('class="invite"') && plain(region('lab')).includes('刚才是')
    HEAD = 1405
    PROPS.set(31, prop(IMPL.evilMint, 1, 1402))
    handleLog(mkLog(ADMIN_ABI, ADMIN, 'Proposed', { id: 31n, kind: 0, target: IMPL.evilMint, value: 0n, data: '0x', codehash: H32('c31'), readyBlock: 1427n }, 1402, T('p31'), 0), true, { wantReceipt() {}, wantBlockTs() {}, refresh() {}, onLive: (ts) => replay.onLive(ts) })
    blocks.ingest(1403)
    tickLab()
    render()
    ok(up && store.activeId === '31' && lab.invite === null && !region('lab').includes('class="invite"') && !plain(region('lab')).includes('刚才是') && region('h-head').includes('tag live'), 'a live proposal takes the screen: the "That was a real replay…" heading goes at once, never next to a live attack')
    store.proposals.delete('31')
    PROPS.delete(31)
    store.arrival = null
    store.follow = keepFollow
    pickActive()
  }
  lab.card = null
  lab.pid = null
  replay.stop(Date.now())
  render()
  const css = readFileSync(join(WEB, 'src', 'style.css'), 'utf8')
  ok(/\.no-lab \.lab \{\s*display: none;/.test(css) && /\.stage:not\(\.no-lab\):not\(\.tab-recent\) \.strip,\s*\.stage\.tab-recent \.lab \{\s*display: none;/.test(css), '?clean=1 has no picker; a stage screen shows the picker or the strip (tabs)')
  ok(/\.lab-cards \{[^}]*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/.test(css) && /\.lab-cards \{[^}]*grid-auto-flow: column;[^}]*overflow-x: auto/.test(css), 'stage: seven cards in a row; phone: a row of cards to swipe')
}

// ---------- 9. identity: nothing in web/ names another project or a local path ----------
{
  const hits = scanWeb(WEB)
  ok(hits.length === 0, `web/ sources are clean of blocked names and local paths (${NAMES_NOTE})${hits.length ? ': ' + hits.map((x) => `${x.file} (${x.hits.join(', ')})`).join('; ') : ''}`)
  ok(findBlocked(html()).length === 0, 'rendered page is clean too')
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
