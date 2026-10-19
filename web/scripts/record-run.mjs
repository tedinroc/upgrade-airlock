// Records a finished run for offline playback (?mode=offline) into src/recorded-run.json: every AirlockAdmin and
// AirlockReceiver log since the deployment block, the final getProposal + clearanceOf of each proposal, the block
// timestamps those logs need, and the receipts of verdict and execute transactions. Read only (eth_* reads).
//
//   node scripts/record-run.mjs --rpc http://127.0.0.1:19621 --deployment <DeployEth output JSON>
//   options: --source sepolia|sepolia-fork (default: sepolia-fork for a loopback RPC, else sepolia)
//            --out <file> (default src/recorded-run.json)   --range <blocks per eth_getLogs> (default 1000 local, 50 remote)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, numberToHex, parseAbi, toEventSelector } from 'viem'
import { buildChainData, SEPOLIA } from './sync-sepolia-data.mjs'

// Same signatures as src/abi.ts (the selftest checks those against the forge artifacts)
const ADMIN_ABI = parseAbi([
  'event Proposed(uint256 indexed id, uint8 indexed kind, address indexed target, uint256 value, bytes data, bytes32 codehash, uint64 readyBlock)',
  'event Vetoed(uint256 indexed id, address indexed guardian, bytes32 ruleHash, uint256 vetoCount)',
  'event Cleared(uint256 indexed id, address indexed clearer, bytes32 evidenceHash)',
  'event Executed(uint256 indexed id, address executor)',
  'event ReasonAttached(uint256 indexed id, address guardian, bytes32 reportHash)',
  'struct Proposal { uint8 kind; uint8 status; address proposer; address target; uint256 value; bytes32 codehash; bytes32 dataHash; uint64 proposedBlock; uint64 readyBlock; uint256 vetoCount; }',
  'function getProposal(uint256 id) view returns (Proposal)',
  'function clearanceOf(uint256 id) view returns (bytes32)',
  'function nextId() view returns (uint256)',
])
const RECEIVER_ABI = parseAbi(['event Verdict(uint256 indexed proposalId, uint8 indexed action, bytes32 ruleHash, bytes32 evidenceHash, bytes32 workflowId)'])
const TOPICS = [
  ...['Proposed', 'Vetoed', 'Cleared', 'Executed', 'ReasonAttached'].map((n) => toEventSelector(ADMIN_ABI.find((x) => x.type === 'event' && x.name === n))),
  toEventSelector(RECEIVER_ABI[0]),
]
const COST_EVENTS = new Set(['Vetoed', 'Cleared', 'Executed'].map((n) => toEventSelector(ADMIN_ABI.find((x) => x.type === 'event' && x.name === n))))

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const fail = (m) => {
  console.error(m)
  process.exit(1)
}
const rpcUrl = arg('rpc')
const depPath = arg('deployment')
if (!rpcUrl || !depPath) fail('usage: node scripts/record-run.mjs --rpc <url> --deployment <DeployEth output JSON> [--source sepolia|sepolia-fork] [--out file]')
const loopback = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(rpcUrl)
const source = arg('source') ?? (loopback ? 'sepolia-fork' : 'sepolia')
if (source !== 'sepolia' && source !== 'sepolia-fork') fail('--source must be sepolia or sepolia-fork')
const range = Number(arg('range') ?? (loopback ? 1000 : 50))
const here = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(arg('out') ?? join(here, '..', 'src', 'recorded-run.json'))

let id = 1
async function rpc(method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) })
      const j = await r.json()
      if (j.error) throw new Error(j.error.message)
      return j.result
    } catch (e) {
      if (i >= 3) throw e
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
}
const call = async (functionName, args = []) =>
  decodeFunctionResult({ abi: ADMIN_ABI, functionName, data: await rpc('eth_call', [{ to: dep.airlockAdmin, data: encodeFunctionData({ abi: ADMIN_ABI, functionName, args }) }, 'latest']) })

const dep = buildChainData(JSON.parse(readFileSync(depPath, 'utf8')))
const chainId = parseInt(await rpc('eth_chainId', []), 16)
if (chainId !== SEPOLIA) fail(`chainId ${chainId}: want Sepolia (${SEPOLIA}) or a fork of it`)
const head = parseInt(await rpc('eth_blockNumber', []), 16)

const logs = []
for (let a = dep.startBlock; a <= head; a += range) {
  const got = await rpc('eth_getLogs', [{ address: [dep.airlockAdmin, dep.receiver], fromBlock: numberToHex(a), toBlock: numberToHex(Math.min(head, a + range - 1)), topics: [TOPICS] }])
  for (const l of got) logs.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex })
}

const next = Number(await call('nextId'))
const proposals = {}
const wantBlocks = new Set(logs.map((l) => parseInt(l.blockNumber, 16)))
for (let i = 1; i < next; i++) {
  const p = await call('getProposal', [BigInt(i)])
  const clearanceOf = await call('clearanceOf', [BigInt(i)])
  proposals[i] = {
    kind: Number(p.kind),
    status: Number(p.status),
    proposer: p.proposer,
    target: p.target,
    codehash: p.codehash,
    proposedBlock: Number(p.proposedBlock),
    readyBlock: Number(p.readyBlock),
    vetoCount: Number(p.vetoCount),
    clearanceOf,
  }
  wantBlocks.add(Number(p.proposedBlock))
}

const blocks = {}
for (const n of [...wantBlocks].sort((a, b) => a - b)) {
  const b = await rpc('eth_getBlockByNumber', [numberToHex(n), false])
  if (b?.timestamp) blocks[n] = parseInt(b.timestamp, 16)
}
const receipts = {}
for (const tx of new Set(logs.filter((l) => COST_EVENTS.has(l.topics[0])).map((l) => l.transactionHash))) {
  const r = await rpc('eth_getTransactionReceipt', [tx])
  if (r)
    receipts[tx] = {
      status: r.status === '0x1' ? 'success' : 'reverted',
      gasUsed: BigInt(r.gasUsed).toString(),
      effectiveGasPrice: BigInt(r.effectiveGasPrice ?? '0x0').toString(),
      blockNumber: parseInt(r.blockNumber, 16),
    }
}

const out = { v: 1, source, recordedOn: new Date().toISOString().slice(0, 10), head, deployment: dep, logs, blocks, receipts, proposals }
writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n')
console.log(`recorded ${Object.keys(proposals).length} proposals, ${logs.length} logs, blocks ${dep.startBlock}..${head} (${source})`)
