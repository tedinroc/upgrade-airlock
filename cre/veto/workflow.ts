// Upgrade Airlock: the CRE clearance workflow (Chainlink CRE, TypeScript SDK 1.23).
//
// Handler 0, EVM log trigger: AirlockAdmin.Proposed at LATEST confidence (the proposal is judged in the block it
//   appears, a whole cooldown before it could execute).
// Handler 1, cron sweeper (config.sweepSchedule, default every 60 s): judges Pending proposals this workflow has not
//   judged yet (AirlockAdmin.oracleJudged false, approver-cleared ones included), e.g. a log the trigger never
//   delivered (CRE drops log events over 5 kb, such as an upgrade with large init data).
//
// Both run airlock.ts:
//   EVM reads (batched through Multicall3): getProposal + clearanceOf + oracleJudged at LATEST; approvals, holder
//   balances, delay at the proposal block; the proposal block's hash (header by number) for the simulation actors
//   -> kinds 1-3: R7 from the reads alone
//   -> kind 0: R5 / R8 / funded holder statically, then node mode: every DON node attack-simulates the upgrade on each
//      configured RPC provider (judge.ts: eth_getCode, then 1 to simRequests eth_simulateV1 requests), the providers
//      are combined by quorum and the DON agrees on the identical {verdict, rule}
//   -> evidenceHash = keccak256(canonical evidence JSON), EIP-712 attestation by the attester (CRE secret),
//      runtime.report -> evm.writeReport -> (Mock)KeystoneForwarder -> AirlockReceiver.onReport
//      -> pass: AirlockAdmin.clear(id, evidenceHash)   veto: AirlockAdmin.veto(id, ruleHash) + attachReason
//   -> EVM read of the proposal state (the forwarder swallows a reverting onReport, so tx success is not proof)
import {
  bytesToHex,
  type CronPayload,
  CronCapability,
  consensusIdenticalAggregation,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  HTTPClient,
  hexToBase64,
  LATEST_BLOCK_NUMBER,
  type EVMLog as Log,
  logTriggerConfig,
  type NodeRuntime,
  protoBigIntToBigint,
  type Runtime,
  TxStatus,
  blockNumber as toBlockNumber,
} from '@chainlink/cre-sdk'
import { type Address, encodeEventTopics, type Hex, zeroAddress } from 'viem'
import { AIRLOCK_ADMIN_ABI } from './abi'
import { type Chain, handleProposed, handleSweep, httpCallsPerProvider, type Ports } from './airlock'
import { BudgetError, chunkReads, decodeAggregate3, encodeAggregate3, LIMITS } from './chain'
import { type Config, configSchema } from './config'
import { consensusValue, type ProviderOutcome, type RpcBatch, simulateUpgrade, type Verdict } from './judge'
import { stableStringify } from './report'

export { configSchema }
export type { Config }

export const PROPOSED_TOPIC = encodeEventTopics({ abi: AIRLOCK_ADMIN_ABI, eventName: 'Proposed' })[0] as Hex

/** id, kind and target are indexed: the log's data (init data, possibly large) is never needed. */
export function decodeProposedLog(log: Log): { id: bigint; kind: number; target: Address; block: bigint; txHash: Hex } {
  const topics = log.topics.map((t: Uint8Array) => bytesToHex(t))
  if (topics.length !== 4 || topics[0].toLowerCase() !== PROPOSED_TOPIC.toLowerCase()) throw new Error('not a Proposed log')
  if (!log.blockNumber) throw new Error('log without block number')
  return {
    id: BigInt(topics[1]),
    kind: Number(BigInt(topics[2])),
    target: `0x${topics[3].slice(-40)}`.toLowerCase() as Address,
    block: protoBigIntToBigint(log.blockNumber),
    txHash: bytesToHex(log.txHash),
  }
}

/** Base64 of the UTF-8 bytes (the HTTP capability takes the request body as base64 in its JSON form). */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=')
  }
  return out
}

/** JSON-RPC batch over the HTTP capability, results in request order; throws on HTTP or JSON-RPC errors. */
export const httpRpcBatch =
  (send: (req: { url: string; method: string; headers: Record<string, string>; body: string }) => { statusCode: number; body: Uint8Array }): RpcBatch =>
  (url, calls) => {
    const body = JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params })))
    const resp = send({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body: utf8ToBase64(body) })
    if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`)
    const parsed = JSON.parse(new TextDecoder().decode(resp.body)) as { id: number; result?: unknown; error?: { message?: string } }[]
    if (!Array.isArray(parsed) || parsed.length !== calls.length) throw new Error('bad batch response')
    const byId = new Map(parsed.map((r) => [Number(r.id), r]))
    return calls.map((c, i) => {
      const r = byId.get(i)
      if (!r || r.error || r.result === undefined) throw new Error(`${c.method}: ${r?.error?.message ?? 'no result'}`)
      return r.result
    })
  }

const fmtOutcome = (o: ProviderOutcome) => (o.verdict === 'error' ? `${o.provider}=error(${o.error.slice(0, 80)})` : `${o.provider}=${o.verdict}${o.rule ? `:${o.rule}` : ''}`)
/** CRE drops log lines over 1 kb. */
const clip = (s: string) => (s.length > 900 ? `${s.slice(0, 897)}...` : s)

function evmClient(cfg: Config): EVMClient {
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName })
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`)
  return new EVMClient(network.chainSelector.selector)
}

/** The EVM capability as a `Chain`, counting every read against the per-run ChainRead limit. */
export function creChain(runtime: Runtime<Config>, evm: EVMClient): Chain {
  const cfg = runtime.config
  let used = 0
  const take = (what: string) => {
    if (used + 1 > LIMITS.chainReads) throw new BudgetError(`ChainRead budget of ${LIMITS.chainReads} exhausted (${what})`)
    used += 1
  }
  const ethCall = (to: Address, data: Hex, at: 'latest' | bigint): Hex =>
    bytesToHex(
      evm
        .callContract(runtime, {
          call: encodeCallMsg({ from: zeroAddress, to, data }),
          blockNumber: at === 'latest' ? LATEST_BLOCK_NUMBER : toBlockNumber(at),
        })
        .result().data,
    )
  return {
    readsLeft: () => LIMITS.chainReads - used,
    latestBlock: () => {
      take('latest header')
      const h = evm.headerByNumber(runtime, {}).result().header
      if (!h?.blockNumber) throw new Error('no latest header')
      return protoBigIntToBigint(h.blockNumber)
    },
    blockHash: (n) => {
      take(`header ${n}`)
      const h = evm.headerByNumber(runtime, { blockNumber: toBlockNumber(n) }).result().header
      if (!h?.blockNumber || protoBigIntToBigint(h.blockNumber) !== n || h.hash.length !== 32) throw new Error(`no header for block ${n}`)
      return bytesToHex(h.hash)
    },
    read: (calls, at) =>
      chunkReads(calls).flatMap((chunk) => {
        take(`${chunk.length} eth_call(s)`)
        if (chunk.length === 1) return [ethCall(chunk[0].to, chunk[0].data, at)]
        return decodeAggregate3(ethCall(cfg.multicall as Address, encodeAggregate3(chunk), at), chunk.length)
      }),
    write: (payload) => {
      const report = runtime.report({ encodedPayload: hexToBase64(payload), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result()
      const wr = evm.writeReport(runtime, { receiver: cfg.receiver, report, gasConfig: { gasLimit: cfg.gasLimit } }).result()
      const tx = wr.txHash && wr.txHash.length ? bytesToHex(wr.txHash) : undefined
      const ok = wr.txStatus === TxStatus.SUCCESS
      return { ok, tx, error: ok ? undefined : `tx status ${wr.txStatus}${wr.errorMessage ? `: ${wr.errorMessage}` : ''}` }
    },
  }
}

export function crePorts(runtime: Runtime<Config>): Ports {
  const cfg = runtime.config
  const evm = evmClient(cfg)
  let key: Hex | null = null
  return {
    chain: creChain(runtime, evm),
    log: (m) => runtime.log(clip(m)),
    attesterKey: () => {
      if (!key) {
        const raw = runtime.getSecret({ id: 'VETO_ATTESTER_KEY' }).result().value.trim()
        key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
      }
      return key
    },
    simulate: (ctx, tag) => {
      // the config schema refuses more; this only guards a config that bypassed it
      if (httpCallsPerProvider(cfg) * cfg.rpcs.length > LIMITS.httpCalls) throw new Error('too many providers for one run')
      const agreed = runtime
        .runInNodeMode((node: NodeRuntime<Config>) => {
          const http = new HTTPClient()
          const rpc = httpRpcBatch((req) => http.sendRequest(node, req).result())
          const { judgement: j, outcomes } = simulateUpgrade(rpc, cfg.rpcs, cfg.minAgree, ctx)
          node.log(clip(`${tag} providers: ${outcomes.map(fmtOutcome).join(' ')}`))
          const failed = j.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.before} -> ${c.after}`)
          node.log(
            clip(
              `${tag} simulation ${j.verdict}${j.rule ? ` ${j.rule}` : ''} (${j.reason}; ${j.probes} probes over ${j.selectors} selectors in ${j.requests} request(s); R9 opcodes: ${j.flaggedOps.join(' ') || 'none'})${failed.length ? ` | ${failed.join(' | ')}` : ''}`,
            ),
          )
          const culprits = j.culprits.map((c) => `${c.selector}(${c.args}):${c.effects.join('+')}`)
          if (culprits.length) node.log(clip(`${tag} culprits: ${culprits.join(' ')}`))
          // Only {verdict, rule}: provider counts, error strings and check detail may differ between nodes.
          return stableStringify(consensusValue(j))
        }, consensusIdenticalAggregation<string>())()
        .result()
      return JSON.parse(agreed) as Verdict
    },
  }
}

export const onProposed = (runtime: Runtime<Config>, log: Log): string => {
  if (log.removed) return JSON.stringify({ action: 'skipped', reason: 'removed log (reorg)' })
  const ev = decodeProposedLog(log)
  runtime.log(`Proposed #${ev.id} kind ${ev.kind} target ${ev.target} in block ${ev.block} (tx ${ev.txHash})`)
  return JSON.stringify(handleProposed(crePorts(runtime), runtime.config, ev.id))
}

export const onSweep = (runtime: Runtime<Config>, _payload: CronPayload): string => JSON.stringify(handleSweep(crePorts(runtime), runtime.config))

export const initWorkflow = (config: Config) => {
  const evm = evmClient(config)
  return [
    handler(
      evm.logTrigger(logTriggerConfig({ addresses: [config.airlockAdmin as Hex], topics: [[PROPOSED_TOPIC]], confidence: config.logConfidence })),
      onProposed,
    ),
    handler(new CronCapability().trigger({ schedule: config.sweepSchedule }), onSweep),
  ]
}
