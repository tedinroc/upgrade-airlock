// Attack simulation: the proxy's ERC-1967 implementation slot is overridden with the proposed implementation and
// the stranger is made to look like a real user, then one simulated block per eth_simulateV1 request. In the first
// request the calls run in this order:
//   fund stranger (a transfer from a second holder to the stranger) -> baseline reads -> holder transfer (R3/R4) ->
//   reads -> stranger transferFrom without allowance (R3B) -> stranger probes (reads after every placement probe) ->
//   final reads (totalSupply, owner, every watched balance).
// Each later request (only when the probes do not all fit in one) starts again from the proposal block: fund
// stranger -> reads -> more probes -> reads. The stranger is funded in every request because every request is
// independent (each starts from the proposal block), and the funding transfer comes from a *second* holder so the
// test holder's R3 accounting stays exactly -amount, and before the baseline reads so the conservation check sees
// the already-funded balances.
//
// Making the stranger look real matters because malicious implementations gate the drain on it:
//  - a token balance (the funding transfer) defeats `require(balanceOf(msg.sender) != 0)` and the transferFrom that
//    skips its allowance check when the caller already holds tokens;
//  - ETH (a stateOverrides balance) defeats `require(msg.sender.balance != 0)`.
//
// Probes. Every selector the dispatcher compares against gets the base shapes (the stranger, the stranger and a
// large number, a large number, none, a wide mix) plus empty and unknown-selector calldata. Every selector that is
// NEW relative to the standard token/ownable/proxy interface (BASE_SELECTORS) also gets placement probes: the funded
// holder in each of the first four argument slots, the test amount in each other slot, and the remaining slots
// filled once with the stranger and once with the proxy address. That covers a drain however its arguments are
// ordered (rescue(from, amount, to), sweep(amount, from, to), ...) and a `require(token == address(this))` guard (the
// proxy-filled variant passes it). Right after each placement probe the holder's and the stranger's balances are
// read, so a drain that moves the holder's tokens out and a later probe moves them back in the same request — with no
// Transfer event — is still seen by the drop between the two reads. `amount` is the test amount (1% of the holder's
// balance), small enough that a function moving the holder's tokens does not revert for lack of balance.
//
// Every DON node must build byte-identical requests and reach the identical verdict, so nothing here is random:
//  - the stranger and receiver addresses are derived from the proposal (chain, AirlockAdmin, id, block hash);
//  - the "unknown selector" fallback probe is derived the same way;
//  - the funder, the funding amount and the stranger's ETH override are passed in, read at the proposal block;
//  - the simulation is pinned to the proposal's block, never "latest".
import {
  type Address,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  numberToHex,
  pad,
  stringToBytes,
} from 'viem'
import { TOKEN_ABI } from './abi'
import { extractSelectors } from './bytecode'
import { LIMITS } from './chain'
import type { RuleId } from './rules'

// ERC1967Utils.IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
export const IMPLEMENTATION_SLOT = numberToHex(BigInt(keccak256(stringToBytes('eip1967.proxy.implementation'))) - 1n, {
  size: 32,
})

/**
 * Largest JSON body of one eth_simulateV1 request, in bytes. The HTTP capability's request size limit is 120 kb
 * (LIMITS.httpRequestBytes); the body travels base64-encoded in the capability's JSON form (4/3 larger), so the
 * plain body is kept at or below 88,000 bytes: 117,336 once encoded.
 */
export const SIM_REQUEST_BYTES = 88_000
if (Math.ceil(SIM_REQUEST_BYTES / 3) * 4 > LIMITS.httpRequestBytes) throw new Error('SIM_REQUEST_BYTES does not fit the HTTP request limit')

/** The stranger's simulated ETH balance (stateOverrides), so a `require(msg.sender.balance != 0)` drain is reached. */
export const STRANGER_ETH = 10n ** 18n
/** Placement probes try the holder in each of the first four argument slots. */
export const ARG_SLOTS = 4

const BIG = 2n ** 128n
const word = (x: bigint | Hex) => pad(typeof x === 'bigint' ? numberToHex(x) : x, { size: 32 }).slice(2)

/** Selectors of the standard token / ownable / proxy / initializer interface: a selector outside this set is NEW. */
const BASE_SIGNATURES = [
  // ERC-20 and metadata
  'totalSupply()',
  'balanceOf(address)',
  'transfer(address,uint256)',
  'allowance(address,address)',
  'approve(address,uint256)',
  'transferFrom(address,address,uint256)',
  'name()',
  'symbol()',
  'decimals()',
  // ERC-2612 permit
  'nonces(address)',
  'DOMAIN_SEPARATOR()',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  // Ownable / Ownable2Step
  'owner()',
  'renounceOwnership()',
  'transferOwnership(address)',
  'pendingOwner()',
  'acceptOwnership()',
  // common mint / burn
  'mint(address,uint256)',
  'burn(uint256)',
  'burnFrom(address,uint256)',
  // ERC-1822 / UUPS / proxy
  'upgradeToAndCall(address,bytes)',
  'proxiableUUID()',
  'implementation()',
  // initializers
  'initialize()',
  'initialize(address)',
  'initialize(address,address[],uint256[])',
]
export const BASE_SELECTORS: ReadonlySet<string> = new Set(BASE_SIGNATURES.map((s) => keccak256(stringToBytes(s)).slice(0, 10)))

/** The selectors of the new code that are not part of the standard interface (the ones a drain would hide behind). */
export const newSelectors = (selectors: string[]): string[] => selectors.filter((s) => !BASE_SELECTORS.has(s))

/** Deterministic per-proposal addresses (identical on every DON node). */
export function proposalActors(chainId: bigint, airlockAdmin: Address, id: bigint, blockHash: Hex) {
  const derive = (tag: string) =>
    `0x${keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
        [tag, chainId, airlockAdmin, id, blockHash],
      ),
    ).slice(-40)}` as Address
  return { stranger: derive('upgrade-airlock/stranger'), receiver: derive('upgrade-airlock/receiver') }
}

/**
 * Base argument shapes of a selector probe, in probe order. These run against every selector and catch a drain that
 * shows itself through a Transfer/OwnershipTransferred event. Placement probes (below) add the argument-order and
 * no-event coverage for NEW selectors.
 */
export const PROBE_SHAPES = ['addr', 'addr,big', 'none', 'big', 'wide'] as const
export type ProbeShape = (typeof PROBE_SHAPES)[number]
export const PROBES_PER_SELECTOR = PROBE_SHAPES.length

export function probeData(shape: ProbeShape, selector: string, stranger: Address): string {
  switch (shape) {
    case 'none':
      return selector
    case 'addr':
      return selector + word(stranger)
    case 'addr,big':
      return selector + word(stranger) + word(BIG)
    case 'big':
      return selector + word(BIG)
    case 'wide':
      return selector + word(stranger) + word(BIG) + word(BIG) + word(stranger) + word(0n) + word(0n) + word(0n) + word(0n)
  }
}

/**
 * Placement probes of one NEW selector: the holder in each of the first ARG_SLOTS argument slots, the test amount in
 * each of the other slots, and every remaining slot filled once with the stranger and once with the proxy. A probe is
 * `holder in slot i, amount in slot j, rest = fill`; the label is `h<i>,a<j>,<s|p>`.
 */
export function placementProbes(selector: string, stranger: Address, holder: Address, proxy: Address, amount: bigint) {
  const out: { args: string; data: string }[] = []
  for (let i = 0; i < ARG_SLOTS; i++) {
    for (let j = 0; j < ARG_SLOTS; j++) {
      if (j === i) continue
      for (const [name, fill] of [['s', stranger] as const, ['p', proxy] as const]) {
        let data = selector
        for (let k = 0; k < ARG_SLOTS; k++) data += k === i ? word(holder) : k === j ? word(amount) : word(fill)
        out.push({ args: `h${i},a${j},${name}`, data })
      }
    }
  }
  return out
}

/** Empty calldata and calldata with an unknown selector (derived from the stranger, never one of `selectors`). */
export function fallbackCalldata(stranger: Address, selectors: string[]) {
  let n = 0
  let sel: string
  do sel = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [stranger, BigInt(n++)])).slice(0, 10)
  while (selectors.includes(sel))
  return [
    { args: 'empty', data: '0x' },
    { args: 'random', data: sel + word(stranger) + word(BIG) + word(BIG) },
  ]
}

type Probe = { selector: string; args: string; data: string; placement: boolean }
/**
 * Every probe, in the order they are packed into requests: the fallback probes, then the base shapes shape-by-shape
 * over all selectors, then the placement probes selector-by-selector over the NEW selectors. When the probes do not
 * all fit, what is left out is always from the tail (the placement probes of the last new selectors first), never a
 * whole selector's base coverage.
 */
export function wantedProbes(selectors: string[], stranger: Address, holder: Address, proxy: Address, amount: bigint): Probe[] {
  const base: Probe[] = [
    ...fallbackCalldata(stranger, selectors).map((p) => ({ selector: 'fallback', ...p, placement: false })),
    ...PROBE_SHAPES.flatMap((args) => selectors.map((selector) => ({ selector, args: args as string, data: probeData(args, selector, stranger), placement: false }))),
  ]
  const placed: Probe[] = newSelectors(selectors).flatMap((selector) =>
    placementProbes(selector, stranger, holder, proxy, amount).map((p) => ({ selector, args: p.args, data: p.data, placement: true })),
  )
  return [...base, ...placed]
}

type ReadFn = 'totalSupply' | 'owner' | 'balanceOf'
type Call = { from: Address; to: Address; data: string; gas: Hex; _tag: string; _fn?: ReadFn | 'transfer' | 'transferFrom' }
type Reads = { totalSupply: number; owner: number; balances: number[] }
/** One probe's index, plus the indices of the holder/stranger balance reads that follow a placement probe (else -1). */
type ProbeRef = { index: number; selector: string; args: string; holderRead: number; strangerRead: number }
/** One eth_simulateV1 request. `r0`, `transfer` and `transferFrom` exist in the first request only. `fund` is the
 *  stranger-funding transfer (-1 when there is no second holder to fund it from). */
export type Chunk = {
  calls: Call[]
  fund: number
  r0: Reads | null
  transfer: number
  transferFrom: number
  /** reads right before the probes */
  r1: Reads
  probes: ProbeRef[]
  /** reads after the probes */
  r2: Reads
  /** JSON body size of the request (what the HTTP capability sends) */
  bytes: number
}
export type Layout = {
  stranger: Address
  receiver: Address
  holder: Address
  funder: Address | null
  amount: bigint
  watchList: Address[]
  selectors: string[]
  newSelectors: string[]
  chunks: Chunk[]
  /** probes over all chunks */
  probes: number
  truncated: boolean
  wantedProbes: number
}

export type SimulationInput = {
  proxy: Address
  newImpl: Address
  newCode: Hex
  holder: Address
  amount: bigint
  /** A second holder (never the test holder) whose tokens fund the stranger; null when none has a balance. */
  funder?: Address | null
  /** How many tokens to move from the funder to the stranger (<= the funder's balance). */
  fundAmount?: bigint
  /** The stranger's simulated ETH balance (default STRANGER_ETH). */
  strangerEth?: bigint
  /** Every configured holder: all of them are watched, not only the one that makes the test transfer. */
  holders: Address[]
  watch: Address[]
  stranger: Address
  receiver: Address
  block: bigint
  callGas: number
  readGas: number
  /** Simulated calls per eth_simulateV1 request. */
  maxCalls: number
  /** eth_simulateV1 requests per provider. */
  maxRequests: number
  /** JSON body size limit per request (default SIM_REQUEST_BYTES). */
  maxBytes?: number
}

/** The JSON body httpRpcBatch sends for one request (a batch of one). */
export const rpcBody = (method: string, params: unknown[]) => JSON.stringify([{ jsonrpc: '2.0', id: 0, method, params }])
const strip = ({ _tag, _fn, ...c }: Call) => c

/** Build the eth_simulateV1 params of every request and the layout needed to read their results. */
export function buildSimulation(input: SimulationInput): { requests: unknown[][]; layout: Layout } {
  const { proxy, newImpl, newCode, holder, amount, stranger, receiver } = input
  const lc = (a: string) => a.toLowerCase() as Address
  const maxBytes = input.maxBytes ?? SIM_REQUEST_BYTES
  const funder = input.funder ? lc(input.funder) : null
  const fundAmount = input.fundAmount ?? 0n
  const strangerEth = input.strangerEth ?? STRANGER_ETH
  const doFund = funder !== null && funder !== lc(holder) && fundAmount > 0n
  // Watched balances: configured watch addresses, every holder, the derived receiver, and the stranger (so a drain
  // into the stranger and an out-and-back move with no event both show up in the balance reads).
  const watchList = [...new Set([...input.watch.map(lc), ...input.holders.map(lc), lc(holder), lc(receiver), lc(stranger)])]
  const stateOverrides = {
    [proxy]: { stateDiff: { [IMPLEMENTATION_SLOT]: pad(lc(newImpl), { size: 32 }) } },
    [lc(stranger)]: { balance: numberToHex(strangerEth) },
  }
  const blockTag = numberToHex(input.block)
  const paramsOf = (calls: Call[]) => [{ blockStateCalls: [{ stateOverrides, calls: calls.map(strip) }] }, blockTag]
  const emptyBytes = rpcBody('eth_simulateV1', paramsOf([])).length

  const readCall = (fn: ReadFn, args: readonly unknown[], tag: string): Call => ({
    from: stranger,
    to: proxy,
    data: encodeFunctionData({ abi: TOKEN_ABI, functionName: fn, args: args as never }),
    gas: numberToHex(input.readGas),
    _tag: tag,
    _fn: fn,
  })
  const readSet = (phase: string): Call[] => [
    readCall('totalSupply', [], `${phase}:totalSupply`),
    readCall('owner', [], `${phase}:owner`),
    ...watchList.map((a) => readCall('balanceOf', [a], `${phase}:balance`)),
  ]
  const holderRead = (): Call => readCall('balanceOf', [lc(holder)], 'probe:holderBalance')
  const strangerRead = (): Call => readCall('balanceOf', [lc(stranger)], 'probe:strangerBalance')
  const fundCall = (): Call => ({
    from: funder as Address,
    to: proxy,
    data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transfer', args: [stranger, fundAmount] }),
    gas: numberToHex(input.callGas),
    _tag: 'fund',
    _fn: 'transfer',
  })
  const callBytes = (c: Call) => JSON.stringify(strip(c)).length
  const finalReads = readSet('final')
  const finalCount = finalReads.length
  const finalBytes = finalReads.reduce((n, c) => n + callBytes(c) + 1, 0)

  // A request under construction: its calls and their JSON size (commas included).
  class Builder {
    calls: Call[] = []
    bytes = emptyBytes
    push(c: Call) {
      this.bytes += callBytes(c) + (this.calls.length ? 1 : 0)
      this.calls.push(c)
      return this.calls.length - 1
    }
    reads(phase: string): Reads {
      const idx = readSet(phase).map((c) => this.push(c))
      return { totalSupply: idx[0], owner: idx[1], balances: idx.slice(2) }
    }
  }

  const selectors = extractSelectors(newCode)
  const news = newSelectors(selectors)
  const wanted = wantedProbes(selectors, lc(stranger), lc(holder), lc(proxy), amount)
  const chunks: Chunk[] = []
  let next = 0
  const maxRequests = Math.max(1, Math.floor(input.maxRequests))
  for (let k = 0; k < maxRequests && (k === 0 || next < wanted.length); k++) {
    const b = new Builder()
    let r0: Reads | null = null
    let transfer = -1
    let transferFrom = -1
    const fund = doFund ? b.push(fundCall()) : -1
    if (k === 0) {
      r0 = b.reads('before')
      transfer = b.push({
        from: holder,
        to: proxy,
        data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transfer', args: [receiver, amount] }),
        gas: numberToHex(input.callGas),
        _tag: 'transfer',
        _fn: 'transfer',
      })
    }
    const r1 = b.reads(k === 0 ? 'afterTransfer' : `chunk${k}:before`)
    if (k === 0) {
      // the R3B transferFrom runs from the now-funded stranger, so a token that waives its allowance check for a
      // caller that holds tokens is caught here.
      transferFrom = b.push({
        from: stranger,
        to: proxy,
        data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transferFrom', args: [holder, stranger, amount] }),
        gas: numberToHex(input.callGas),
        _tag: 'transferFrom',
        _fn: 'transferFrom',
      })
    }
    const probes: ProbeRef[] = []
    while (next < wanted.length) {
      const p = wanted[next]
      const probeCall: Call = { from: stranger, to: proxy, data: p.data, gas: numberToHex(input.callGas), _tag: 'probe' }
      // a placement probe is an atomic unit of probe + holder read + stranger read, never split across requests
      const extra = p.placement ? [holderRead(), strangerRead()] : []
      const addCalls = 1 + extra.length
      const addBytes = callBytes(probeCall) + extra.reduce((n, c) => n + callBytes(c) + 1, 0) + 1
      if (b.calls.length + addCalls + finalCount > input.maxCalls || b.bytes + addBytes + finalBytes > maxBytes) break
      const index = b.push(probeCall)
      const hr = p.placement ? b.push(extra[0]) : -1
      const sr = p.placement ? b.push(extra[1]) : -1
      probes.push({ index, selector: p.selector, args: p.args, holderRead: hr, strangerRead: sr })
      next++
    }
    const r2 = b.reads(k === 0 ? 'final' : `chunk${k}:final`)
    // a request that holds no probe (the budget is too small for even one) adds nothing: stop here
    if (k > 0 && !probes.length) break
    const bytes = rpcBody('eth_simulateV1', paramsOf(b.calls)).length
    chunks.push({ calls: b.calls, fund, r0, transfer, transferFrom, r1, probes, r2, bytes })
  }

  const layout: Layout = {
    stranger: lc(stranger),
    receiver: lc(receiver),
    holder: lc(holder),
    funder: doFund ? funder : null,
    amount,
    watchList,
    selectors,
    newSelectors: news,
    chunks,
    probes: next,
    truncated: next < wanted.length,
    wantedProbes: wanted.length,
  }
  return { requests: chunks.map((c) => paramsOf(c.calls)), layout }
}

export class ViewRevert extends Error {}

export type Check = { name: RuleId; before: string; after: string; ok: boolean }
export type Culprit = { selector: string; args: string; effects: string[] }
export type Evaluation = {
  verdict: 'veto' | 'pass'
  rule: RuleId | null
  checks: Check[]
  culprits: Culprit[]
  probes: number
}

type SimCall = { status?: string | number; returnData?: Hex; logs?: { data: Hex; topics: Hex[] }[]; error?: { message?: string } }
type Snap = { totalSupply: bigint; owner: string; balances: bigint[] }

/**
 * What one stranger probe did, from the logs of its own call: 'supply' (a Transfer from or to address 0),
 * 'moved-others-funds' (a Transfer out of anyone but the stranger) or 'owner' (OwnershipTransferred). Transfers of
 * zero move nothing and are ignored. Every effect vetoes (R3B unless R1/R2 already caught it): a stranger's call
 * that mints and burns back, or that moves a holder's tokens and returns them, leaves the final reads unchanged
 * but is still an attack.
 */
export function probeEffects(logs: SimCall['logs'], stranger: Address): string[] {
  const effects = new Set<string>()
  for (const lg of logs ?? []) {
    try {
      const ev = decodeEventLog({ abi: TOKEN_ABI, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] })
      if (ev.eventName === 'Transfer') {
        const { from, to, value } = ev.args as { from: string; to: string; value: bigint }
        if (value === 0n) continue
        if (BigInt(from) === 0n || BigInt(to) === 0n) effects.add('supply')
        if (BigInt(from) !== 0n && from.toLowerCase() !== stranger.toLowerCase()) effects.add('moved-others-funds')
      }
      if (ev.eventName === 'OwnershipTransferred') effects.add('owner')
    } catch {}
  }
  return [...effects].sort()
}

/**
 * Evaluate the eth_simulateV1 results (one per request, in request order) against R1-R4 and R3B.
 * Throws ViewRevert (-> R6) if a read reverted, the stranger funding reverted, or a result has the wrong shape.
 */
export function evaluateSimulation(results: unknown[], layout: Layout): Evaluation {
  if (!Array.isArray(results) || results.length !== layout.chunks.length) {
    throw new ViewRevert(`expected ${layout.chunks.length} simulation result(s), got ${Array.isArray(results) ? results.length : typeof results}`)
  }
  const holderIdx = layout.watchList.indexOf(layout.holder)
  const strangerIdx = layout.watchList.indexOf(layout.stranger)
  const per = layout.chunks.map((chunk, k) => {
    const result = results[k]
    const block = Array.isArray(result) ? result[0] : result
    const res = (block as { calls?: SimCall[] } | undefined)?.calls
    if (!Array.isArray(res) || res.length !== chunk.calls.length) {
      throw new ViewRevert(`unexpected simulate result shape (${res?.length} calls, expected ${chunk.calls.length})`)
    }
    const ok = (i: number) => res[i].status === '0x1' || res[i].status === 1 || res[i].status === '1'
    const readVal = (i: number): unknown => {
      if (!ok(i)) throw new ViewRevert(`view ${chunk.calls[i]._tag} reverted${res[i].error?.message ? `: ${res[i].error?.message}` : ''}`)
      const fn = chunk.calls[i]._fn
      if (!fn) throw new ViewRevert(`call ${i} is not a read`)
      return decodeFunctionResult({ abi: TOKEN_ABI, functionName: fn, data: res[i].returnData ?? '0x' })
    }
    // A funding transfer that reverted means the stranger is not funded and the gated drains would be missed: fail
    // closed (R6) rather than reach a false pass.
    if (chunk.fund >= 0 && !ok(chunk.fund)) throw new ViewRevert(`stranger funding transfer reverted${res[chunk.fund].error?.message ? `: ${res[chunk.fund].error?.message}` : ''}`)
    const snap = (r: Reads): Snap => ({
      totalSupply: readVal(r.totalSupply) as bigint,
      owner: (readVal(r.owner) as string).toLowerCase(),
      balances: r.balances.map((i) => readVal(i) as bigint),
    })
    const s0 = chunk.r0 ? snap(chunk.r0) : null
    const s1 = snap(chunk.r1)
    const s2 = snap(chunk.r2)
    // the holder/stranger balances right before this chunk's probes, the baseline for the per-probe drain check
    const holderBefore = s1.balances[holderIdx]
    const culprits: Culprit[] = []
    for (const p of chunk.probes) {
      if (!ok(p.index)) continue
      const effects = new Set(probeEffects(res[p.index].logs, layout.stranger))
      // a placement probe that moved the holder's tokens out — even with no Transfer event — leaves the holder's
      // balance below its pre-probe value when read right after the probe
      if (p.holderRead >= 0 && ok(p.holderRead) && (readVal(p.holderRead) as bigint) < holderBefore) effects.add('drained-holder')
      if (effects.size) culprits.push({ selector: p.selector, args: p.args, effects: [...effects].sort() })
    }
    return { chunk, res, ok, s0, s1, s2, culprits }
  })

  // R4 and R3: the plain holder transfer of the first request.
  const first = per[0]
  const s0 = first.s0 as Snap
  const t = first.res[first.chunk.transfer]
  let transferOk = first.ok(first.chunk.transfer)
  if (transferOk && t.returnData && t.returnData !== '0x') {
    try {
      transferOk = decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'transfer', data: t.returnData }) === true
    } catch {
      transferOk = false
    }
  }
  // R3: holder -X, receiver +X, everyone else on the watchlist unchanged, totalSupply unchanged. The stranger funding
  // happens before the baseline reads, so the funder and the stranger are unchanged across the test transfer.
  const X = layout.amount
  const deltas = layout.watchList.map((a, k) => ({ a, d: first.s1.balances[k] - s0.balances[k] }))
  const conservation =
    transferOk &&
    deltas.every(({ a, d }) => (a === layout.holder ? d === -X : a === layout.receiver ? d === X : d === 0n)) &&
    first.s1.totalSupply === s0.totalSupply
  const recvIdx = layout.watchList.indexOf(layout.receiver)

  // R1 and R2 per request: the probes of a request must not change totalSupply, and the owner at its end must be the
  // owner before the simulation.
  const r1Bad = per.find((c) => c.s2.totalSupply !== c.s1.totalSupply)
  const r2Bad = per.find((c) => c.s2.owner !== s0.owner)
  const r1Shown = r1Bad ?? first
  const r2Shown = r2Bad ?? first

  const checks: Check[] = [
    { name: 'R1_TOTAL_SUPPLY', before: String(r1Shown.s1.totalSupply), after: String(r1Shown.s2.totalSupply), ok: !r1Bad },
    { name: 'R2_OWNER', before: s0.owner, after: r2Shown.s2.owner, ok: !r2Bad },
    {
      name: 'R3_TRANSFER_CONSERVATION',
      before: `receiver+${X}`,
      after: `receiver+${first.s1.balances[recvIdx] - s0.balances[recvIdx]}`,
      ok: conservation,
    },
    { name: 'R4_TRANSFER_LIVENESS', before: 'transfer', after: transferOk ? 'success' : 'reverted', ok: transferOk },
  ]

  // R3B: a stranger without allowance must not pull the holder's funds, and no stranger probe may mint, burn, move
  // anyone else's tokens or ownership (from its own logs, or from the holder's balance dropping after a placement
  // probe) even if a later call undoes it. The stranger is funded first, so a drain gated on the caller holding
  // tokens or ETH is reached.
  let pulled = false
  const tf = first.res[first.chunk.transferFrom]
  if (first.ok(first.chunk.transferFrom)) {
    pulled = true
    if (tf.returnData && tf.returnData !== '0x') {
      try {
        pulled = decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'transferFrom', data: tf.returnData }) !== false
      } catch {
        pulled = true
      }
    }
  }
  const culprits = per.flatMap((c) => c.culprits)
  const drained = culprits.filter((c) => c.effects.includes('drained-holder')).length
  const logged = culprits.filter((c) => !c.effects.includes('drained-holder') || c.effects.length > 1).length
  checks.push({
    name: 'R3B_THIRD_PARTY_FUNDS',
    before: 'transferFrom(holder, stranger) without allowance; funded-stranger probes',
    after: pulled
      ? 'transferFrom pulled the holder funds'
      : [logged && `${logged} probe(s) with effects`, drained && `${drained} probe(s) drained the holder with no event`].filter(Boolean).join(', ') ||
        'reverted, holder balance held, no probe effects',
    ok: !pulled && culprits.length === 0,
  })

  // Priority when several invariants break: liveness, conservation, owner, supply, third-party funds.
  const order: RuleId[] = ['R4_TRANSFER_LIVENESS', 'R3_TRANSFER_CONSERVATION', 'R2_OWNER', 'R1_TOTAL_SUPPLY', 'R3B_THIRD_PARTY_FUNDS']
  const failed = order.find((n) => !checks.find((c) => c.name === n)?.ok) ?? null
  return { verdict: failed ? 'veto' : 'pass', rule: failed, checks, culprits, probes: layout.probes }
}
