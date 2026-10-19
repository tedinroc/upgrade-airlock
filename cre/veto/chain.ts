// Batched chain reads under CRE's per-run limits (`cre workflow limits export`):
//  - ChainRead.CallLimit 15: every EVM capability read (callContract and headerByNumber) counts as one call;
//  - ChainRead.PayloadSizeLimit 5 kb.
// Several eth_calls at the same block go through one Multicall3.aggregate3 call, split into chunks whose request
// and response both stay under READ_PAYLOAD_BYTES. The local simulator enforces the call limit but not the payload
// limit (a 64 KB call and a 64 KB reply both pass there), so the chunking is what keeps a deployed workflow inside it.
import { type Address, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import { MULTICALL3_ABI } from './abi'

/** One eth_call: target, calldata and the size of its return data in bytes (for the payload budget). */
export type Read = { to: Address; data: Hex; ret: number }

/** The CRE per-run limits this workflow plans against (HTTP sizes in bytes, 1 kb = 1000 bytes to stay on the safe side). */
export const LIMITS = { chainReads: 15, httpCalls: 15, httpRequestBytes: 120_000, httpResponseBytes: 250_000 } as const

/** Thrown when a run would exceed a per-run CRE call limit; the handlers turn it into a logged deferral. */
export class BudgetError extends Error {}
/** Upper bound for one chain read's request and its response (below CRE's 5 kb ChainRead payload limit). */
export const READ_PAYLOAD_BYTES = 4096

const pad32 = (n: number) => Math.ceil(n / 32) * 32
const hexLen = (h: Hex) => (h.length - 2) / 2

/** aggregate3 calldata: selector, array offset, length, then per call an offset, (target, allowFailure, offset), length, data. */
export const aggregate3RequestBytes = (calls: Read[]) => 4 + 64 + calls.reduce((n, c) => n + 32 + 96 + 32 + pad32(hexLen(c.data)), 0)
/** aggregate3 return data: array offset, length, then per result an offset, (success, offset), length, data. */
export const aggregate3ResponseBytes = (calls: Read[]) => 64 + calls.reduce((n, c) => n + 32 + 64 + 32 + pad32(c.ret), 0)

/** Greedy split: a chunk grows while its aggregate3 request and response both fit in `limit`. */
export function chunkReads(calls: Read[], limit = READ_PAYLOAD_BYTES): Read[][] {
  const chunks: Read[][] = []
  let cur: Read[] = []
  for (const c of calls) {
    const next = [...cur, c]
    if (cur.length && (aggregate3RequestBytes(next) > limit || aggregate3ResponseBytes(next) > limit)) {
      chunks.push(cur)
      cur = [c]
    } else cur = next
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** How many ChainRead calls `calls` cost (a chunk of one call is sent directly, without Multicall3). */
export const readCost = (calls: Read[]) => chunkReads(calls).length

export const encodeAggregate3 = (calls: Read[]): Hex =>
  encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [calls.map((c) => ({ target: c.to, allowFailure: false, callData: c.data }))],
  })

export function decodeAggregate3(data: Hex, n: number): Hex[] {
  const res = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data })
  if (res.length !== n) throw new Error(`multicall returned ${res.length} results, expected ${n}`)
  return res.map((r, i) => {
    if (!r.success) throw new Error(`multicall call ${i} failed`)
    return r.returnData
  })
}
