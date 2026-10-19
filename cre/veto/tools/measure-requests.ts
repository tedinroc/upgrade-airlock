// Measures the eth_simulateV1 requests the attack simulation builds for one or more implementations, against the
// CRE HTTP limits (request 120 kb, response 250 kb, 15 HTTP calls per run). It builds the exact same requests the
// workflow would (simulate.ts buildSimulation), using the same holder / funder / amount selection as airlock.ts,
// then prints per request: call count, plain JSON bytes, and base64 bytes (what the HTTP capability sends).
//
//   bun tools/measure-requests.ts <rpc-url> <deployment.json> <config.json> <label=0xImpl> [<label=0xImpl> ...]
//
// Nothing is sent on chain: eth_getCode, eth_call (balanceOf) and a block read only.
import { type Address, createPublicClient, type Hex, http, keccak256 } from 'viem'
import { TOKEN_ABI } from '../abi'
import { LIMITS } from '../chain'
import { buildSimulation, proposalActors, rpcBody, SIM_REQUEST_BYTES } from '../simulate'
import { utf8ToBase64 } from '../workflow'

const [rpc, depFile, cfgFile, ...impls] = process.argv.slice(2)
if (!rpc || !depFile || !cfgFile || impls.length === 0) {
  console.error('usage: bun tools/measure-requests.ts <rpc-url> <deployment.json> <config.json> <label=0xImpl> ...')
  process.exit(2)
}
const dep = (await Bun.file(depFile).json()) as { airlockAdmin: Address; proxy: Address; holders: Address[] }
const cfg = (await Bun.file(cfgFile).json()) as {
  chainId: number
  airlockAdmin: Address
  proxy: Address
  holders: Address[]
  watch: Address[]
  rpcs: { url: string; label: string }[]
  callGas: number
  readGas: number
  maxCalls: number
  simRequests: number
}
const client = createPublicClient({ transport: http(rpc) })
const lc = (a: string) => a.toLowerCase() as Address

const head = await client.getBlockNumber()
const block = head - 2n
const blk = await client.getBlock({ blockNumber: block })
const balances = await Promise.all(
  cfg.holders.map((h) => client.readContract({ address: cfg.proxy, abi: TOKEN_ABI, functionName: 'balanceOf', args: [h as Address], blockNumber: block })),
)
const k = balances.findIndex((b) => b > 0n)
if (k < 0) throw new Error('no holder with a balance at the probe block')
const holder = lc(cfg.holders[k])
const balance = balances[k]
const amount = balance / 100n > 0n ? balance / 100n : 1n
const fk = balances.findIndex((b, i) => b > 0n && i !== k && lc(cfg.holders[i]) !== holder)
const funder = fk >= 0 ? lc(cfg.holders[fk]) : null
const fundAmount = fk >= 0 ? (balances[fk] < amount ? balances[fk] : amount) : 0n
const { stranger, receiver } = proposalActors(BigInt(cfg.chainId), lc(cfg.airlockAdmin), 0n, blk.hash as Hex)

const perProvider = 1 + cfg.simRequests
const perRun = perProvider * cfg.rpcs.length
console.log(
  `probe block ${block}; holder ${holder} (bal ${balance}); funder ${funder ?? 'none'} (fund ${fundAmount}); maxCalls ${cfg.maxCalls}; simRequests ${cfg.simRequests}; providers ${cfg.rpcs.length}`,
)
console.log(`HTTP calls: ${perProvider}/provider (1 eth_getCode + ${cfg.simRequests} eth_simulateV1), ${perRun}/run of ${LIMITS.httpCalls}\n`)
console.log('impl                 req  calls  jsonB   base64B  (limit 88000 / 120000)  selectors new  probes  fit')

let over = 0
for (const spec of impls) {
  const eq = spec.indexOf('=')
  const label = eq > 0 ? spec.slice(0, eq) : spec
  const impl = lc(eq > 0 ? spec.slice(eq + 1) : spec)
  const code = (await client.getBytecode({ address: impl as Address, blockNumber: block })) ?? '0x'
  const { layout, requests } = buildSimulation({
    proxy: lc(cfg.proxy),
    newImpl: impl as Address,
    newCode: code as Hex,
    holder,
    amount,
    funder,
    fundAmount,
    holders: cfg.holders.map(lc),
    watch: cfg.watch.map(lc),
    stranger,
    receiver,
    block,
    callGas: cfg.callGas,
    readGas: cfg.readGas,
    maxCalls: cfg.maxCalls,
    maxRequests: cfg.simRequests,
  })
  requests.forEach((params, i) => {
    const body = rpcBody('eth_simulateV1', params)
    const b64 = utf8ToBase64(body).length
    const flagJson = body.length > SIM_REQUEST_BYTES ? ' !JSON>88k' : ''
    const flagB64 = b64 > LIMITS.httpRequestBytes ? ' !REQ>120k' : ''
    if (flagJson || flagB64) over++
    console.log(
      `${label.padEnd(20)} ${String(i + 1).padStart(3)}  ${String(layout.chunks[i].calls.length).padStart(5)}  ${String(body.length).padStart(6)}  ${String(b64).padStart(7)}${flagJson}${flagB64}` +
        (i === 0 ? `   ${String(layout.selectors.length).padStart(9)} ${String(layout.newSelectors.length).padStart(4)}  ${String(layout.probes).padStart(6)}  ${layout.truncated ? 'TRUNC' : 'all'}` : ''),
    )
  })
}
console.log(over ? `\nMEASURE: ${over} request(s) over an HTTP size limit` : '\nMEASURE: every request within the HTTP size limits')
process.exit(over ? 1 : 0)
