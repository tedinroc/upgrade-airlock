#!/usr/bin/env bun
// Gas pre-flight on live Sepolia, read-only: replays a fork rehearsal's transactions (the deployment, the funding,
// the proposals, the CRE Clear and Veto reports, manual clearances, the execute) on live Ethereum Sepolia with one
// eth_simulateV1 call, with the same senders, calldata, gas limits and block numbers, so every transaction runs
// against live state under the rules Sepolia actually runs. Nothing is sent.
//
//   FORK=19631 bun scripts/sepolia/gas-replay.ts [--live-rpc url] [--json file] [--deployment file]
//
// Needs the rehearsal's fork still running (the transactions are read from it). The replay starts from the live
// block the fork was taken at (anvil_nodeInfo) and keeps the fork's block numbers, so the contracts land on the same
// addresses and every report's proposal digest (it binds the proposal block) and validUntilBlock still match.
// The provider must still serve state at the fork block: run it within a few hours of starting the fork.
// Checks: every transaction succeeds; every report really lands (the receiver's Verdict log plus AirlockAdmin's
// Cleared or Vetoed log; the forwarder swallows a reverting receiver) within the gas limit the workflow gives
// writeReport; live gas equals fork gas.
// The default provider is drpc: publicnode caps the gas one eth_simulateV1 request may burn (about 50M), which the
// 87M-gas deployment exceeds ("intrinsic gas too low"); the workflow's own simulations burn far less.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}
const fork = process.env.FORK
if (!fork) throw new Error('set FORK=<port> (the fork that ran the rehearsal)')
const forkRpc = `http://127.0.0.1:${fork}`
const liveRpc = arg('live-rpc') ?? 'https://sepolia.drpc.org'
const state = join((process.env.TMPDIR ?? '/tmp').replace(/\/$/, ''), `upgrade-airlock-fork-${fork}`)
const depPath = arg('deployment') ?? join(state, 'deployment.json')
if (!existsSync(depPath)) throw new Error(`no deployment at ${depPath}`)
const d = JSON.parse(readFileSync(depPath, 'utf8'))
if (!d.airlockAdmin) throw new Error(`${depPath} has no airlockAdmin, so it is not a deployment of this stack`)
const lc = (a?: string | null) => (a ?? '').toLowerCase()

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = (await r.json()) as any
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const hex = (n: number | bigint) => `0x${n.toString(16)}`
const num = (h: string) => Number(BigInt(h))

// Names for addresses and selectors in the report.
const names = new Map<string, string>()
for (const [k, v] of Object.entries(d)) if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !names.has(lc(v))) names.set(lc(v), k)
const SEL: Record<string, string> = {}
const { keccak256, toBytes } = await import(Bun.resolveSync('viem', join(import.meta.dir, '../../cre/veto')))
const topic = (s: string) => keccak256(toBytes(s)) as string
const VETOED = topic('Vetoed(uint256,address,bytes32,uint256)')
const CLEARED = topic('Cleared(uint256,address,bytes32)')
const VERDICT = topic('Verdict(uint256,uint8,bytes32,bytes32,bytes32)')
for (const s of [
  'proposeUpgrade(address,bytes)',
  'proposeSetGuardian(address,bool)',
  'execute(uint256)',
  'clear(uint256,bytes32)',
  'veto(uint256,bytes32)',
  'report(address,bytes,bytes,bytes[])',
  'transferOwnership(address)',
])
  SEL[keccak256(toBytes(s)).slice(0, 10)] = s.split('(')[0]

// 1) The rehearsal's transactions on the fork: what the owner, the approver and the emergency guardian sent, and
//    every report sent to the forwarder (by the sender or the sweeper key).
const info = await rpc(forkRpc, 'anvil_nodeInfo', []).catch(() => null)
const forkBlock = Number(info?.forkConfig?.forkBlockNumber ?? Number(d.startBlock) - 1)
const forkHead = num(await rpc(forkRpc, 'eth_blockNumber', []))
const roleOf = (t: any): string | null =>
  lc(t.to) === lc(d.forwarder) ? 'report' : lc(t.from) === lc(d.owner) ? 'owner' : lc(t.from) === lc(d.approver) ? 'approver' : lc(t.from) === lc(d.emergencyGuardian) ? 'guard' : null
type Tx = { block: number; from: string; to: string | null; input: string; value: string; gas: number; forkGasUsed: number; role: string; what: string }
const txs: Tx[] = []
for (let b = Number(d.startBlock); b <= forkHead; b++) {
  const blk = await rpc(forkRpc, 'eth_getBlockByNumber', [hex(b), true])
  for (const t of blk?.transactions ?? []) {
    const role = roleOf(t)
    if (!role) continue
    const rc = await rpc(forkRpc, 'eth_getTransactionReceipt', [t.hash])
    const what = !t.to
      ? `create ${names.get(lc(rc.contractAddress)) ?? rc.contractAddress}`
      : t.input === '0x'
        ? `ETH to ${names.get(lc(t.to)) ?? t.to.slice(0, 10)}`
        : `${names.get(lc(t.to)) ?? t.to}.${SEL[t.input.slice(0, 10)] ?? t.input.slice(0, 10)}`
    txs.push({ block: b, from: lc(t.from), to: t.to ? lc(t.to) : null, input: t.input, value: t.value, gas: num(t.gas), forkGasUsed: num(rc.gasUsed), role, what })
  }
}
if (!txs.length) throw new Error('no rehearsal transactions found on the fork')
const firstPropose = txs.findIndex((t) => /\.propose/.test(t.what))
const deployTxs = (firstPropose < 0 ? txs : txs.slice(0, firstPropose)).filter((t) => t.role === 'owner' && t.input !== '0x')

// 2) Live: from the fork block, with the fork's own block numbers.
const liveHead = num(await rpc(liveRpc, 'eth_blockNumber', []))
if (liveHead < forkBlock) throw new Error(`live head ${liveHead} is behind the fork block ${forkBlock}`)
if (txs[0].block <= forkBlock) throw new Error(`first rehearsal transaction in block ${txs[0].block}, not after the fork block ${forkBlock}`)
const byBlock = new Map<number, Tx[]>()
for (const t of txs) byBlock.set(t.block, [...(byBlock.get(t.block) ?? []), t])
const BAL = hex(10n ** 21n)
const funded = Object.fromEntries([...new Set(txs.map((t) => t.from))].map((a) => [a, { balance: BAL }]))
const blockStateCalls = [...byBlock.entries()].map(([b, list], i) => ({
  blockOverrides: { number: hex(b) },
  ...(i === 0 ? { stateOverrides: funded } : {}),
  calls: list.map((t) => ({
    from: t.from,
    ...(t.to ? { to: t.to } : {}),
    input: t.input,
    value: t.value,
    gas: hex(t.gas), // the real transaction's gas limit (forge's estimate x1.3, cast's estimate, writeReport's gasLimit)
  })),
}))
const t0 = performance.now()
const sim = await rpc(liveRpc, 'eth_simulateV1', [{ blockStateCalls }, hex(forkBlock)])
const ms = Math.round(performance.now() - t0)
const results = sim.flatMap((blk: any) => blk.calls)
if (results.length !== txs.length) throw new Error(`simulate returned ${results.length} calls for ${txs.length} transactions`)

// 3) Report.
let problems = 0
console.log(`replayed ${txs.length} fork transactions (blocks ${txs[0].block}-${txs[txs.length - 1].block}) on live Sepolia state at the fork block ${forkBlock} (live head ${liveHead}); eth_simulateV1 ${ms} ms`)
console.log('\n  block      role      transaction                          gas limit   fork gas   live gas  status')
txs.forEach((t, i) => {
  const r = results[i]
  const live = num(r.gasUsed)
  const okStatus = r.status === '0x1'
  const notes: string[] = []
  if (!okStatus) notes.push(`FAILED ${r.error?.message ?? ''}`.trim())
  if (t.role === 'report') {
    const logs = r.logs ?? []
    const verdict = logs.find((l: any) => lc(l.address) === lc(d.receiver) && l.topics[0] === VERDICT)
    const landed = logs.find((l: any) => lc(l.address) === lc(d.airlockAdmin) && (l.topics[0] === VETOED || l.topics[0] === CLEARED))
    if (!verdict || !landed) notes.push('NO VERDICT (the receiver reverted inside the forwarder)')
    else notes.push(`${landed.topics[0] === VETOED ? 'vetoed' : 'cleared'} #${num(landed.topics[1])}; ${Math.round((100 * live) / t.gas)}% of the ${t.gas} gas limit`)
  }
  if (live !== t.forkGasUsed) notes.push(`live differs from fork by ${live - t.forkGasUsed}`)
  if (!okStatus || notes.some((n) => /NO VERDICT/.test(n))) problems++
  console.log(`  ${String(t.block).padEnd(10)} ${t.role.padEnd(9)} ${t.what.padEnd(36)} ${String(t.gas).padStart(9)} ${String(t.forkGasUsed).padStart(10)} ${String(live).padStart(10)}  ${okStatus ? 'ok' : 'FAIL'} ${notes.join('; ')}`)
})
const deployLive = deployTxs.reduce((s, t) => s + num(results[txs.indexOf(t)].gasUsed), 0)
const deployFork = deployTxs.reduce((s, t) => s + t.forkGasUsed, 0)
const maxLimit = Math.max(...deployTxs.map((t) => t.gas))
const gp = BigInt(await rpc(liveRpc, 'eth_gasPrice', []))
const maxReport = Math.max(0, ...txs.filter((t) => t.role === 'report').map((t) => num(results[txs.indexOf(t)].gasUsed)))
console.log(`\ndeployment: ${deployTxs.length} transactions, ${deployLive} gas on live Sepolia (fork ${deployFork}); largest gas limit ${maxLimit}`)
console.log(`at the current ${gp} wei/gas: deployment ~${(Number(BigInt(deployLive) * gp) / 1e18).toFixed(12)} ETH; one report ~${(Number(BigInt(maxReport) * gp) / 1e18).toFixed(12)} ETH`)
if (arg('json')) writeFileSync(arg('json') as string, JSON.stringify({ forkBlock, liveHead, txs: txs.map((t, i) => ({ ...t, input: undefined, live: results[i] && { status: results[i].status, gasUsed: num(results[i].gasUsed) } })) }, null, 2))
console.log(problems ? `GAS REPLAY: ${problems} problem(s)` : 'GAS REPLAY: ALL OK')
process.exit(problems ? 1 : 0)
