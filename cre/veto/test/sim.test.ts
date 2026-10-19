// The attack simulation against an in-memory token (a small eth_simulateV1 that runs ERC-20 calls with optional
// malicious functions), and the bytecode walker against crafted bytecode.
import { describe, expect, test } from 'bun:test'
import { type Address, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Hex, keccak256, stringToBytes } from 'viem'
import { TOKEN_ABI } from '../abi'
import { codeBytes, codeLayout, dangerousOpcodes, extractSelectors, solcMetadataStart } from '../bytecode'
import { LIMITS } from '../chain'
import { configSchema } from '../config'
import { judgeOnProvider, type ProviderOutcome, quorum, type RpcBatch, type RpcCall, r9Flagged, simulateUpgrade, type UpgradeContext } from '../judge'
import { ARG_SLOTS, BASE_SELECTORS, buildSimulation, newSelectors, PROBE_SHAPES, rpcBody, SIM_REQUEST_BYTES, STRANGER_ETH } from '../simulate'
import { utf8ToBase64 } from '../workflow'

const sel = (sig: string) => keccak256(stringToBytes(sig)).slice(0, 10)
const SEL = {
  totalSupply: sel('totalSupply()'),
  owner: sel('owner()'),
  balanceOf: sel('balanceOf(address)'),
  transfer: sel('transfer(address,uint256)'),
  transferFrom: sel('transferFrom(address,address,uint256)'),
  approve: sel('approve(address,uint256)'),
  mint: sel('mint(address,uint256)'),
  // malicious, non-standard selectors (each NEW relative to the base interface)
  rescue: sel('rescue(address,address,uint256)'), // open rescue(from, to, amount)
  rescueA: sel('rescueA(address,uint256,address)'), // reordered: rescue(from, amount, to)
  sweepB: sel('sweepB(uint256,address,address)'), // reordered: sweep(amount, from, to)
  rescueC: sel('rescueC(address,address,address,uint256)'), // rescueTokens(token, from, to, amount), token == this
  rescueE: sel('rescueE(address,address,uint256)'), // drain with no Transfer event
  flashMint: sel('flashMint()'),
  poke: sel('poke(address,uint256)'),
  borrow: sel('borrow(address,uint256)'),
}
const ERC20 = [SEL.totalSupply, SEL.owner, SEL.balanceOf, SEL.transfer, SEL.transferFrom, SEL.approve]

/** Selectors that do nothing (they revert), to make a contract with many functions. The filler names are NEW. */
const filler = (n: number) => Array.from({ length: n }, (_, i) => sel(`filler${i}()`))
/** Base-interface filler selectors (allowance/name/symbol/... style), NOT new, so they get no placement probes. */
const BASE_FILLERS = ['allowance(address,address)', 'name()', 'symbol()', 'decimals()', 'nonces(address)', 'pendingOwner()', 'proxiableUUID()', 'burn(uint256)'].map(sel)

/** A solc-style dispatcher (PUSH4 sel DUP2 EQ PUSH2 dest JUMPI per selector), optional extra code, then INVALID. */
const dispatcher = (selectors: string[], extra = '') => `0x${selectors.map((s) => `63${s.slice(2)}811461000057`).join('')}${extra}fe` as Hex

const PROXY = '0x0000000000000000000000000000000000090000' as Address
const IMPL = '0x00000000000000000000000000000000000b0002' as Address
const OWNER = '0x0000000000000000000000000000000000000001' as Address
const HOLDERS = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2'] as Address[]
const FUNDER = '0x00000000000000000000000000000000000000a3' as Address
const STRANGER = '0x00000000000000000000000000000000000000d1' as Address
const RECEIVER = '0x00000000000000000000000000000000000000d2' as Address
const BAL = 5_000_000_000n

type Behaviour = 'drain' | 'borrow' | 'flashMint' | 'zeroTransfer' | 'openMint' | 'reorderA' | 'reorderB' | 'tokenGuardC' | 'noLogE' | 'requireTokens' | 'requireEth' | 'allowanceSkip'
type Log = { address: Address; topics: Hex[]; data: Hex }

/** In-memory token behind the proxy: ERC-20 + Ownable reads, plus the selected malicious functions. */
class FakeEvm {
  calls: RpcCall[][] = []
  constructor(
    public code: Hex,
    public behaviours: Behaviour[] = [],
  ) {}
  rpc: RpcBatch = (_url, calls) => {
    this.calls.push(calls)
    return calls.map((c) => {
      if (c.method === 'eth_getCode') return (c.params[0] as string).toLowerCase() === IMPL ? this.code : '0x'
      if (c.method === 'eth_simulateV1') return this.simulate(c.params)
      throw new Error(`unexpected method ${c.method}`)
    })
  }
  private simulate(params: unknown[]) {
    const [{ blockStateCalls }] = params as [{ blockStateCalls: { stateOverrides: Record<string, { balance?: string }>; calls: { from: Address; to: Address; data: Hex }[] }[] }]
    if (blockStateCalls.length !== 1 || !blockStateCalls[0].stateOverrides[PROXY]) throw new Error('expected one block with the proxy override')
    // simulated ETH balances come from the stateOverrides (the stranger is funded with ETH there)
    const eth = new Map<string, bigint>()
    for (const [addr, o] of Object.entries(blockStateCalls[0].stateOverrides)) if (o.balance) eth.set(addr.toLowerCase(), BigInt(o.balance))
    const ethOf = (a: string) => eth.get(a.toLowerCase()) ?? 0n
    // every request starts from the proposal block's state (the test holder funded, the funder funded, stranger empty)
    const bal = new Map<string, bigint>([
      [HOLDERS[0], 0n],
      [HOLDERS[1], BAL],
      [FUNDER, BAL],
    ])
    const allow = new Map<string, bigint>()
    let supply = BAL * 2n
    const owner = OWNER as string
    const get = (a: string) => bal.get(a.toLowerCase()) ?? 0n
    const results = blockStateCalls[0].calls.map(({ from, to, data }) => {
      const logs: Log[] = []
      const revert = { status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { message: 'execution reverted' } }
      const ok = (returnData: Hex = '0x') => ({ status: '0x1', returnData, gasUsed: '0x5208', logs })
      const transferLog = (f: string, t: string, v: bigint) =>
        logs.push({
          address: PROXY,
          topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: 'Transfer', args: { from: f as Address, to: t as Address } }) as Hex[],
          data: encodeAbiParameters([{ type: 'uint256' }], [v]),
        })
      const move = (f: string, t: string, v: bigint, emit = true) => {
        if (get(f) < v) return false
        bal.set(f.toLowerCase(), get(f) - v)
        bal.set(t.toLowerCase(), get(t) + v)
        if (emit) transferLog(f, t, v)
        return true
      }
      if (to.toLowerCase() !== PROXY) return revert
      const s = data.slice(0, 10)
      const words = (n: number) => {
        if ((data.length - 10) / 64 < n) return null // calldata too short: solc's decoder reverts
        return Array.from({ length: n }, (_, i) => `0x${data.slice(10 + 64 * i, 74 + 64 * i)}` as Hex)
      }
      const addr = (w: Hex) => (BigInt(w) >> 160n ? null : (`0x${w.slice(-40)}` as Address))
      /** `n` ABI words: the first `addrs` as addresses, the rest as uint256; all null if the calldata is too short or
       *  an address word has high bits set (solc's decoder reverts on both) */
      const args = (n: number, addrs: number): (string | bigint | null)[] => {
        const w = words(n)
        if (!w) return Array(n).fill(null)
        const out = w.map((x, i) => (i < addrs ? addr(x) : BigInt(x)))
        return out.slice(0, addrs).some((a) => a === null) ? Array(n).fill(null) : out
      }
      const has = (b: Behaviour) => this.behaviours.includes(b)
      const T = (fn: 'totalSupply' | 'owner' | 'balanceOf' | 'transfer' | 'transferFrom', result: unknown) => encodeFunctionResult({ abi: TOKEN_ABI, functionName: fn, result } as never)
      switch (s) {
        case SEL.totalSupply:
          return ok(T('totalSupply', supply))
        case SEL.owner:
          return ok(T('owner', owner))
        case SEL.balanceOf: {
          const [a] = args(1, 1)
          return a ? ok(T('balanceOf', get(a as Address))) : revert
        }
        case SEL.transfer: {
          const [t, v] = args(2, 1)
          return t && move(from, t as Address, v as bigint) ? ok(T('transfer', true)) : revert
        }
        case SEL.approve: {
          const [sp, v] = args(2, 1)
          if (!sp) return revert
          allow.set(`${from.toLowerCase()}:${(sp as string).toLowerCase()}`, v as bigint)
          return ok(T('transfer', true))
        }
        case SEL.transferFrom: {
          const [f, t, v] = args(3, 2)
          if (!f || !t) return revert
          const key = `${(f as string).toLowerCase()}:${from.toLowerCase()}`
          const amount = v as bigint
          // G: a malicious transferFrom waives the allowance check when the caller already holds tokens
          const skip = has('allowanceSkip') && get(from) > 0n
          if (!skip && ((allow.get(key) ?? 0n) < amount || get(f as string) < amount)) return revert
          if (skip && get(f as string) < amount) return revert
          if (!skip) allow.set(key, (allow.get(key) ?? 0n) - amount)
          move(f as string, t as string, amount)
          return ok(T('transferFrom', true))
        }
        case SEL.rescue: {
          // open rescue(from, to, amount), optionally gated on the caller holding tokens (D) or ETH (F)
          if (!has('drain') && !has('requireTokens') && !has('requireEth')) return revert
          if (has('requireTokens') && get(from) === 0n) return revert
          if (has('requireEth') && ethOf(from) === 0n) return revert
          const [f, t, v] = args(3, 2)
          return f && t && move(f as string, t as string, v as bigint) ? ok() : revert
        }
        case SEL.rescueA: {
          // A: rescueA(from, amount, to) -> _transfer(from, to, amount)
          if (!has('reorderA')) return revert
          const w = words(3)
          if (!w) return revert
          const f = addr(w[0])
          const t = addr(w[2])
          return f && t && move(f, t, BigInt(w[1])) ? ok() : revert
        }
        case SEL.sweepB: {
          // B: sweepB(amount, from, to) -> _transfer(from, to, amount)
          if (!has('reorderB')) return revert
          const w = words(3)
          if (!w) return revert
          const f = addr(w[1])
          const t = addr(w[2])
          return f && t && move(f, t, BigInt(w[0])) ? ok() : revert
        }
        case SEL.rescueC: {
          // C: rescueC(token, from, to, amount) with require(token == address(this) == proxy)
          if (!has('tokenGuardC')) return revert
          const w = words(4)
          if (!w) return revert
          const token = addr(w[0])
          const f = addr(w[1])
          const t = addr(w[2])
          if (!token || token.toLowerCase() !== PROXY.toLowerCase()) return revert
          return f && t && move(f, t, BigInt(w[3])) ? ok() : revert
        }
        case SEL.rescueE: {
          // E: rescueE(from, to, amount) moves balances with NO Transfer event
          if (!has('noLogE')) return revert
          const [f, t, v] = args(3, 2)
          return f && t && move(f as string, t as string, v as bigint, false) ? ok() : revert
        }
        case SEL.borrow: {
          // takes `amount` of `from`'s tokens and gives them back in the same call: no balance changes in the end
          if (!has('borrow')) return revert
          const [f, v] = args(2, 1)
          if (!f || !move(f as string, from, v as bigint)) return revert
          move(from, f as string, v as bigint)
          return ok()
        }
        case SEL.flashMint: {
          // mints to the caller and burns it back in the same call: totalSupply ends where it started
          if (!has('flashMint')) return revert
          transferLog('0x0000000000000000000000000000000000000000', from, 1000n)
          transferLog(from, '0x0000000000000000000000000000000000000000', 1000n)
          return ok()
        }
        case SEL.poke: {
          // emits a zero-value Transfer out of the given address: moves nothing
          if (!has('zeroTransfer')) return revert
          const [a] = args(2, 1)
          if (!a) return revert
          transferLog(a as string, from, 0n)
          return ok()
        }
        default:
          if (s === SEL.mint && has('openMint')) {
            const [t, v] = args(2, 1)
            if (!t) return revert
            supply += v as bigint
            bal.set((t as string).toLowerCase(), get(t as string) + (v as bigint))
            transferLog('0x0000000000000000000000000000000000000000', t as string, v as bigint)
            return ok()
          }
          return revert
      }
    })
    return [{ number: '0x1', calls: results }]
  }
}

const ctxFor = (code: Hex, over: Partial<UpgradeContext> = {}): UpgradeContext => ({
  proxy: PROXY,
  newImpl: IMPL,
  codehash: keccak256(code),
  hasInitData: false,
  block: 100n,
  holder: HOLDERS[1],
  amount: BAL / 100n,
  funder: FUNDER,
  fundAmount: BAL / 100n,
  holders: HOLDERS,
  watch: [OWNER],
  stranger: STRANGER,
  receiver: RECEIVER,
  strict: false,
  codehashApproved: false,
  dataApproved: false,
  callGas: 1_000_000,
  readGas: 200_000,
  maxCalls: 250,
  simRequests: 2,
  allowedOpcodes: [],
  ...over,
})

const judge = (evm: FakeEvm, over: Partial<UpgradeContext> = {}) => judgeOnProvider(evm.rpc, 'http://fake', 'fake', ctxFor(evm.code, over))
const verdictOf = (o: ProviderOutcome) => (o.verdict === 'error' ? `error: ${o.error}` : o.verdict === 'pass' ? 'pass' : o.rule)

describe('the stranger is funded before the probes', () => {
  test('the first request funds the stranger from a second holder, before the baseline reads, with an ETH override', () => {
    const code = dispatcher([...ERC20, SEL.rescue])
    const { layout, requests } = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxCalls: 60, maxRequests: 2 })
    const chunk0 = layout.chunks[0]
    const calls = (requests[0][0] as { blockStateCalls: { stateOverrides: Record<string, { balance?: string }>; calls: { from: Address; to: Address; data: string }[] }[] }).blockStateCalls[0]
    // the funding transfer is the very first call, from the funder to the stranger
    expect(chunk0.fund).toBe(0)
    expect(calls.calls[0].from.toLowerCase()).toBe(FUNDER.toLowerCase())
    expect(calls.calls[0].data.slice(0, 10)).toBe(SEL.transfer)
    expect(calls.calls[0].data).toContain(STRANGER.slice(2).toLowerCase())
    // funding comes before the baseline reads (r0) and the test transfer
    expect(chunk0.fund).toBeLessThan(chunk0.r0?.totalSupply ?? -1)
    expect(chunk0.r0?.totalSupply).toBeLessThan(chunk0.transfer)
    // the stranger has an ETH override
    expect(BigInt(calls.stateOverrides[STRANGER.toLowerCase()].balance ?? '0x0')).toBe(STRANGER_ETH)
    // every later request funds the stranger again (each starts from the proposal block)
    expect(layout.chunks[1]?.fund).toBe(0)
    // the stranger is on the watch list
    expect(layout.watchList).toContain(STRANGER.toLowerCase())
  })
  test('with no second funded holder, there is no funding transfer (ETH override still applies)', () => {
    const code = dispatcher([...ERC20, SEL.rescue])
    const { layout, requests } = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], funder: null, fundAmount: 0n, maxRequests: 2 })
    expect(layout.funder).toBeNull()
    for (const c of layout.chunks) expect(c.fund).toBe(-1)
    const calls = (requests[0][0] as { blockStateCalls: { stateOverrides: Record<string, { balance?: string }>; calls: unknown[] }[] }).blockStateCalls[0]
    expect(BigInt(calls.stateOverrides[STRANGER.toLowerCase()].balance ?? '0x0')).toBe(STRANGER_ETH)
  })
  test('a funding transfer that reverts fails closed (R6), never a pass', () => {
    // the funder holds nothing, so the transfer reverts; the drains it would reach are not trusted
    const code = dispatcher([...ERC20, SEL.rescue])
    const o = judge(new FakeEvm(code), { funder: HOLDERS[0], fundAmount: BAL / 100n }) // HOLDERS[0] balance is 0
    expect(verdictOf(o)).toBe('R6_SIM_FAILURE')
  })
})

describe('placement probes are generated for NEW selectors only', () => {
  test('base-interface selectors get no placement probes; a new selector does', () => {
    expect(newSelectors(ERC20)).toEqual([])
    expect(newSelectors([...ERC20, SEL.rescue])).toEqual([SEL.rescue])
    for (const s of ERC20) expect(BASE_SELECTORS.has(s)).toBe(true)
  })
  test('each new selector gets holder-in-each-slot x amount-in-each-other-slot x {stranger, proxy} placement probes', () => {
    const code = dispatcher([...ERC20, SEL.rescue])
    const { layout } = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxRequests: 2 })
    const placement = layout.chunks.flatMap((c) => c.probes).filter((p) => p.selector === SEL.rescue && p.args.startsWith('h'))
    expect(placement.length).toBe(ARG_SLOTS * (ARG_SLOTS - 1) * 2) // 24
    // one of them is holder in slot 0, amount in slot 2, remaining filled with the stranger
    expect(placement.some((p) => p.args === 'h0,a2,s')).toBe(true)
    // and one fills the remaining slots with the proxy (needed for a require(token == address(this)) guard)
    expect(placement.some((p) => p.args === 'h1,a3,p')).toBe(true)
    // placement probes carry a holder and a stranger balance read right after them
    for (const p of placement) {
      expect(p.holderRead).toBeGreaterThan(p.index)
      expect(p.strangerRead).toBeGreaterThan(p.holderRead)
    }
    // the placement probe really puts the holder, the test amount and the stranger in the right words
    const word = (x: bigint | string) => BigInt(x).toString(16).padStart(64, '0')
    const found = layout.chunks.flatMap((c) => c.probes).find((p) => p.args === 'h0,a2,s')
    const calls = layout.chunks.flatMap((c) => c.calls)
    expect(calls[found!.index].data).toBe(`${SEL.rescue}${word(HOLDERS[1])}${word(STRANGER)}${word(BAL / 100n)}${word(STRANGER)}`)
  })
  test('base selectors keep only the base shapes (no per-probe reads)', () => {
    const code = dispatcher(ERC20)
    const { layout } = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxRequests: 2 })
    for (const p of layout.chunks.flatMap((c) => c.probes)) expect(p.holderRead).toBe(-1)
    expect(layout.probes).toBe(2 + PROBE_SHAPES.length * ERC20.length)
  })
})

describe('third-party drains are vetoed R3B whatever shape they take', () => {
  test('an honest token passes', () => {
    const o = judge(new FakeEvm(dispatcher(ERC20)))
    expect(verdictOf(o)).toBe('pass')
    if (o.verdict === 'error') throw new Error()
    expect(o.probes).toBe(2 + PROBE_SHAPES.length * ERC20.length)
  })
  test('an honest upgrade that adds a benign new selector still passes', () => {
    const version = sel('version()')
    const o = judge(new FakeEvm(dispatcher([...ERC20, version]))) // version ignores its calldata
    expect(verdictOf(o)).toBe('pass')
  })
  for (const [name, selector, behaviour] of [
    ['open rescue(from, to, amount)', SEL.rescue, 'drain'],
    ['A: rescueA(from, amount, to) (amount between the addresses)', SEL.rescueA, 'reorderA'],
    ['B: sweepB(amount, from, to) (amount first)', SEL.sweepB, 'reorderB'],
    ['D: rescue gated on the caller holding tokens', SEL.rescue, 'requireTokens'],
    ['F: rescue gated on the caller holding ETH', SEL.rescue, 'requireEth'],
  ] as const) {
    test(`${name} is vetoed R3B (moved the holder's funds)`, () => {
      const o = judge(new FakeEvm(dispatcher([...ERC20, selector]), [behaviour]))
      expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
      if (o.verdict === 'error') throw new Error()
      for (const r of ['R1_TOTAL_SUPPLY', 'R2_OWNER', 'R3_TRANSFER_CONSERVATION', 'R4_TRANSFER_LIVENESS']) expect(o.checks.find((c) => c.name === r)?.ok).toBe(true)
      expect(o.culprits.some((c) => c.selector === selector && c.effects.includes('moved-others-funds') && c.args.startsWith('h'))).toBe(true)
    })
  }
  test('C: rescueC(token, from, to, amount) with require(token == address(this)) is vetoed (the proxy-filled probe passes the guard)', () => {
    const o = judge(new FakeEvm(dispatcher([...ERC20, SEL.rescueC]), ['tokenGuardC']))
    expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
    if (o.verdict === 'error') throw new Error()
    expect(o.culprits.some((c) => c.selector === SEL.rescueC && c.effects.includes('moved-others-funds') && c.args.endsWith(',p'))).toBe(true)
  })
  test('E: a drain that moves funds out with NO Transfer event is caught by the post-probe balance read', () => {
    const o = judge(new FakeEvm(dispatcher([...ERC20, SEL.rescueE]), ['noLogE']))
    expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
    if (o.verdict === 'error') throw new Error()
    // no Transfer event was emitted, so the only effect is the holder's balance dropping after the probe
    const c = o.culprits.find((x) => x.selector === SEL.rescueE)
    expect(c?.effects).toContain('drained-holder')
    expect(c?.effects).not.toContain('moved-others-funds')
    expect(o.checks.find((k) => k.name === 'R3B_THIRD_PARTY_FUNDS')?.after).toContain('no event')
  })
  test('G: a transferFrom that waives the allowance check for a token-holding caller is caught (the stranger is funded)', () => {
    // no new selector: the R3B transferFrom runs from the funded stranger, so the allowance-skip branch fires
    const code = dispatcher(ERC20)
    const o = judge(new FakeEvm(code, ['allowanceSkip']))
    expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
    if (o.verdict === 'error') throw new Error()
    expect(o.checks.find((c) => c.name === 'R3B_THIRD_PARTY_FUNDS')?.after).toContain('pulled')
    // without a funded stranger the attack would be missed (shown here for contrast)
    const missed = judge(new FakeEvm(dispatcher(ERC20), ['allowanceSkip']), { funder: null, fundAmount: 0n })
    expect(verdictOf(missed)).toBe('pass')
  })
  test("a holder's tokens taken and given back in the same call still veto (probe effects count, not final balances)", () => {
    const o = judge(new FakeEvm(dispatcher([...ERC20, SEL.borrow]), ['borrow']))
    expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
    if (o.verdict === 'error') throw new Error()
    expect(o.culprits.some((c) => c.selector === SEL.borrow && c.effects.includes('moved-others-funds'))).toBe(true)
  })
  test('a mint that is burned back in the same call vetoes R3B (supply effect) although totalSupply is unchanged', () => {
    const o = judge(new FakeEvm(dispatcher([...ERC20, SEL.flashMint]), ['flashMint']))
    expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
    if (o.verdict === 'error') throw new Error()
    expect(o.checks.find((c) => c.name === 'R1_TOTAL_SUPPLY')?.ok).toBe(true)
    expect(o.culprits.some((c) => c.selector === SEL.flashMint && c.effects.includes('supply'))).toBe(true)
  })
  test('a zero-value Transfer moves nothing and is not an effect', () => {
    expect(verdictOf(judge(new FakeEvm(dispatcher([...ERC20, SEL.poke]), ['zeroTransfer'])))).toBe('pass')
  })
  test('an open mint is still R1 (R1 outranks R3B)', () => {
    expect(verdictOf(judge(new FakeEvm(dispatcher([...ERC20, SEL.mint]), ['openMint'])))).toBe('R1_TOTAL_SUPPLY')
  })
})

describe('R9 against a fixed allowlist', () => {
  const withBasefee = dispatcher(ERC20, '4850') // BASEFEE POP
  test("BASEFEE vetoes R9; the proxy's current implementation is never read", () => {
    const evm = new FakeEvm(withBasefee)
    const o = judge(evm)
    expect(verdictOf(o)).toBe('R9_NEW_OPCODES')
    // only eth_getCode of the new implementation and eth_simulateV1: no eth_getStorageAt, no code of the current one
    expect(evm.calls.flat().map((c) => c.method)).toEqual(['eth_getCode', 'eth_simulateV1'])
    expect(evm.calls[0][0].params[0]).toBe(IMPL)
  })
  test('an allowlisted opcode passes', () => expect(verdictOf(judge(new FakeEvm(withBasefee), { allowedOpcodes: ['BASEFEE'] }))).toBe('pass'))
  test('an approved codehash passes, and the approval covers that codehash only', () => {
    const o = judge(new FakeEvm(withBasefee), { codehashApproved: true })
    expect(verdictOf(o)).toBe('pass')
    if (o.verdict === 'error') throw new Error()
    expect(o.checks.find((c) => c.name === 'R9_NEW_OPCODES')).toEqual({ name: 'R9_NEW_OPCODES', before: 'allowed: none', after: 'found: BASEFEE (codehash approved)', ok: true })
    // a later upgrade with the same opcode and a different codehash: no approval for it, so R9 again
    expect(verdictOf(judge(new FakeEvm(dispatcher([...ERC20, sel('v3()')], '4850'))))).toBe('R9_NEW_OPCODES')
  })
  test('only the opcodes the allowlist lacks are reported', () => {
    expect(r9Flagged(dispatcher(ERC20, '48504250'), ['BASEFEE'])).toEqual(['TIMESTAMP'])
    const o = judge(new FakeEvm(dispatcher(ERC20, '48504250')), { allowedOpcodes: ['BASEFEE'] })
    expect(verdictOf(o)).toBe('R9_NEW_OPCODES')
    if (o.verdict === 'error') throw new Error()
    expect(o.flaggedOps).toEqual(['TIMESTAMP'])
  })
  test('the config accepts only R9 opcode names, once each', () => {
    const base = {
      chainSelectorName: 'ethereum-testnet-sepolia',
      chainId: 11155111,
      airlockAdmin: '0x1111111111111111111111111111111111111111',
      receiver: '0x2222222222222222222222222222222222222222',
      proxy: '0x3333333333333333333333333333333333333333',
      holders: ['0x4444444444444444444444444444444444444444'],
      rpcs: [{ url: 'https://a.example', label: 'a' }],
      minAgree: 1,
    }
    expect(configSchema.parse(base).allowedOpcodes).toEqual([])
    expect(configSchema.safeParse({ ...base, allowedOpcodes: ['STATICCALL', 'TIMESTAMP'] }).success).toBe(true)
    expect(configSchema.safeParse({ ...base, allowedOpcodes: ['SSTORE'] }).success).toBe(false)
    expect(configSchema.safeParse({ ...base, allowedOpcodes: ['GAS', 'GAS'] }).success).toBe(false)
  })
})

describe('probe budget: split requests, truncation and approval', () => {
  test('a base-only token (no new selector) fits in one request at the default maxCalls', () => {
    const code = dispatcher([...ERC20, ...BASE_FILLERS]) // 14 base selectors, no placement probes
    const evm = new FakeEvm(code)
    const o = judge(evm)
    expect(verdictOf(o)).toBe('pass')
    if (o.verdict === 'error') throw new Error()
    expect(o.requests).toBe(1)
    expect(evm.calls.length).toBe(2)
  })
  test('a contract with a new selector is split into two requests, each under the call and size limits, and passes', () => {
    const code = dispatcher([...ERC20, sel('version()')]) // one new (benign) selector -> placement probes
    const evm = new FakeEvm(code)
    const o = judge(evm, { maxCalls: 90 })
    expect(verdictOf(o)).toBe('pass')
    if (o.verdict === 'error') throw new Error()
    expect(o.requests).toBe(2)
    expect(evm.calls.length).toBe(3) // eth_getCode + 2 x eth_simulateV1: 1 + simRequests HTTP calls
    const { layout, requests } = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxCalls: 90, maxRequests: 2 })
    requests.forEach((params, k) => {
      const body = rpcBody('eth_simulateV1', params)
      expect(body.length).toBe(layout.chunks[k].bytes)
      expect(body.length).toBeLessThanOrEqual(SIM_REQUEST_BYTES)
      expect(utf8ToBase64(body).length).toBeLessThanOrEqual(LIMITS.httpRequestBytes)
      expect(layout.chunks[k].calls.length).toBeLessThanOrEqual(90)
    })
    // the second request carries no holder transfer: it funds the stranger again, then reads around its probes
    expect(layout.chunks[1].transfer).toBe(-1)
    expect(layout.chunks[1].r0).toBeNull()
    expect(layout.chunks[1].fund).toBe(0)
  })
  test('the byte limit closes a request before maxCalls does when probes are large', () => {
    const code = dispatcher([...ERC20, ...filler(44)])
    const { layout } = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxCalls: 400, maxRequests: 4, maxBytes: 40_000 })
    for (const c of layout.chunks) expect(c.bytes).toBeLessThanOrEqual(40_000)
    expect(layout.chunks.length).toBeGreaterThan(1)
  })
  test('more probes than fit: R6 without simulating, unless the codehash is approved', () => {
    const code = dispatcher([...ERC20, ...filler(74)]) // 74 new selectors: placement explodes past the budget
    const evm = new FakeEvm(code)
    const o = judge(evm)
    expect(verdictOf(o)).toBe('R6_SIM_FAILURE')
    expect(evm.calls.length).toBe(1) // eth_getCode only
    const approved = new FakeEvm(code)
    const a = judge(approved, { codehashApproved: true })
    expect(verdictOf(a)).toBe('pass')
    if (a.verdict === 'error') throw new Error()
    expect(a.checks.find((c) => c.name === 'R6_SIM_FAILURE')?.ok).toBe(true)
    expect(approved.calls.length).toBe(3)
  })
  test('an approved codehash does not excuse a real drain: rescue still vetoes R3B', () => {
    // the codehash approval only excuses probe truncation (R6); every other rule still runs on the probes that fit
    const o = judge(new FakeEvm(dispatcher([...ERC20, SEL.rescue]), ['drain']), { codehashApproved: true })
    expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
  })
  test('a no-event drain whose probe lands in a later request is still caught (each request starts from the proposal block)', () => {
    // one new selector, small requests so its placement probes span both requests
    const code = dispatcher([...ERC20, ...BASE_FILLERS, SEL.rescueE])
    const over = { maxCalls: 80, simRequests: 4 }
    const o = judge(new FakeEvm(code, ['noLogE']), over)
    expect(verdictOf(o)).toBe('R3B_THIRD_PARTY_FUNDS')
    const { layout } = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxCalls: 80, maxRequests: 4 })
    expect(layout.truncated).toBe(false)
    expect(layout.chunks.length).toBeGreaterThan(1)
  })
  test('identical requests on every build (DON nodes must agree byte for byte)', () => {
    const code = dispatcher([...ERC20, ...filler(10)])
    const a = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxRequests: 2 })
    const b = buildSimulation({ ...ctxFor(code), newCode: code, holder: HOLDERS[1], maxRequests: 2 })
    expect(JSON.stringify(a.requests)).toBe(JSON.stringify(b.requests))
  })
  test('four providers stay within the HTTP call limit; a fifth needs simRequests <= 2', () => {
    const base = {
      chainSelectorName: 'ethereum-testnet-sepolia',
      chainId: 11155111,
      airlockAdmin: '0x1111111111111111111111111111111111111111',
      receiver: '0x2222222222222222222222222222222222222222',
      proxy: '0x3333333333333333333333333333333333333333',
      holders: ['0x4444444444444444444444444444444444444444'],
      minAgree: 2,
    }
    const rpcs = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://${i}.example`, label: `p${i}` }))
    expect(configSchema.parse({ ...base, rpcs: rpcs(4) }).simRequests).toBe(2)
    expect(configSchema.safeParse({ ...base, rpcs: rpcs(5), simRequests: 2 }).success).toBe(true)
    expect(configSchema.safeParse({ ...base, rpcs: rpcs(4), simRequests: 3 }).success).toBe(false)
    expect(configSchema.safeParse({ ...base, rpcs: rpcs(3), simRequests: 4 }).success).toBe(true)
    // the providers really make 1 + requests calls each
    const evm = new FakeEvm(dispatcher([...ERC20, ...BASE_FILLERS]))
    const { judgement } = simulateUpgrade(evm.rpc, rpcs(4), 2, ctxFor(evm.code))
    expect(judgement.verdict).toBe('pass')
    expect(evm.calls.length).toBe(4 * 2) // one new-selector-free contract -> 1 request each
    expect(evm.calls.length).toBeLessThanOrEqual(LIMITS.httpCalls)
  })
  test('providers that see different code fail closed (R6)', () => {
    const honest = new FakeEvm(dispatcher(ERC20))
    const evil = new FakeEvm(dispatcher(ERC20), ['drain'])
    evil.code = dispatcher([...ERC20, SEL.rescue])
    const ctx = ctxFor(honest.code)
    const outs = [judgeOnProvider(honest.rpc, 'a', 'a', ctx), judgeOnProvider(evil.rpc, 'b', 'b', ctx), judgeOnProvider(honest.rpc, 'c', 'c', ctx)]
    expect(verdictOf(outs[1])).toBe('R6_SIM_FAILURE') // codehash mismatch
    expect(quorum(outs, 2).rule).toBe('R6_SIM_FAILURE')
  })
})

// ---------------------------------------------------------------- bytecode walker and the CBOR metadata tail
const hex = (...parts: string[]) => `0x${parts.join('')}` as Hex
const IPFS_KEY = '6469706673' // text(4) "ipfs"
const SOLC_KEY = '64736f6c63' // text(4) "solc"
/** A hash full of opcode bytes the walker must not see, with no 0x5b (JUMPDEST) in it. */
const HASH34 = `1220${'4248f1f4ff'.repeat(6)}4344`
const tailOf = (body: string) => body + (body.length / 2).toString(16).padStart(4, '0')
const ipfsTail = (hash = HASH34) => tailOf(`a2${IPFS_KEY}5822${hash}${SOLC_KEY}43000825`)
const PREFIX = '6080604052348015600e575f5ffd5b5f80fd5bfe' // ends in INVALID

describe('bytecode: the metadata tail is skipped only when it is exact solc CBOR and unreachable', () => {
  test('a real solc tail after INVALID is skipped (its hash bytes are not opcodes)', () => {
    // the tail of DemoBTC as compiled by solc 0.8.37
    const real = 'a2646970667358221220ae8a2104f53a97446523ff4972dad12b64598bce0166a857e37cb50aadd8c0c164736f6c6343000825'
    const code = hex(PREFIX, tailOf(real))
    expect(solcMetadataStart(codeBytes(code))).toBe(PREFIX.length / 2)
    expect(dangerousOpcodes(code)).toEqual([])
    expect(dangerousOpcodes(hex(PREFIX, ipfsTail()))).toEqual([])
  })
  test('other solc formats: bzzr0, bzzr1, metadata-hash none, experimental, a prerelease version string', () => {
    const b32 = '4248f1f4'.repeat(8)
    const prerelease = Buffer.from('0.8.31-develop.2025.1.1').toString('hex')
    for (const body of [
      `a1${'65627a7a7230'}5820${b32}`, // {bzzr0} (0.4.x)
      `a2${'65627a7a7231'}5820${b32}${SOLC_KEY}43000511`, // {bzzr1, solc}
      `a1${SOLC_KEY}43000825`, // {solc}
      `a3${IPFS_KEY}5822${HASH34}${'6c6578706572696d656e74616c'}f5${SOLC_KEY}43000825`, // {ipfs, experimental: true, solc}
      `a2${IPFS_KEY}5822${HASH34}${SOLC_KEY}77${prerelease}`, // {ipfs, solc: "0.8.31-develop..."}
    ]) {
      const code = hex(PREFIX, tailOf(body))
      expect(solcMetadataStart(codeBytes(code))).toBe(PREFIX.length / 2)
      expect(dangerousOpcodes(code)).toEqual([])
    }
  })
  test('anything else is scanned as code (fail closed)', () => {
    const body = `a2${IPFS_KEY}5822${HASH34}${SOLC_KEY}43000825`
    const len = body.length / 2
    const cases = {
      'declared length one too long': hex(PREFIX, body, (len + 1).toString(16).padStart(4, '0')),
      'declared length one too short': hex(PREFIX, body, (len - 1).toString(16).padStart(4, '0')),
      'unknown key': hex(PREFIX, tailOf(body.replace(IPFS_KEY, '6469706679'))),
      'duplicate key': hex(PREFIX, tailOf(`a2${SOLC_KEY}43000825${SOLC_KEY}43000825${HASH34}`)),
      'a map of 5 entries': hex(PREFIX, tailOf(`a5${body.slice(2)}`)),
      'not a map': hex(PREFIX, tailOf(`84${body.slice(2)}`)),
      'ipfs hash of the wrong length': hex(PREFIX, tailOf(`a2${IPFS_KEY}5821${HASH34.slice(2)}${SOLC_KEY}43000825`)),
      'solc version of the wrong type': hex(PREFIX, tailOf(`a2${IPFS_KEY}5822${HASH34}${SOLC_KEY}44000825ff`)),
      'experimental that is not a boolean': hex(PREFIX, tailOf(`a3${IPFS_KEY}5822${HASH34}${'6c6578706572696d656e74616c'}01${SOLC_KEY}43000825`)),
    }
    for (const [name, code] of Object.entries(cases)) {
      expect([name, codeLayout(codeBytes(code)).end]).toEqual([name, codeBytes(code).length])
      expect([name, dangerousOpcodes(code).length > 0]).toEqual([name, true])
    }
  })
  test('the attack the old walker allowed: a trailing length that hides reachable code and a selector', () => {
    // dispatcher -> JUMPDEST BASEFEE ... a hidden dispatcher entry (PUSH4 sel DUP2 EQ PUSH2 dest JUMPI) STOP, then
    // 0xa2 and a 2-byte "length" that claims all of it is metadata
    const hidden = sel('steal()')
    const body = `a25b485063${hidden.slice(2)}81146100005700`
    const code = hex(`63${SEL.transfer.slice(2)}811461000057`, 'fe', tailOf(body))
    expect(dangerousOpcodes(code)).toEqual(['BASEFEE'])
    expect(extractSelectors(code)).toContain(hidden)
  })
  test('code that falls through into the tail makes it code', () => {
    // the last instruction before the tail is POP, not a halting opcode
    const code = hex('6001', '50', ipfsTail())
    expect(codeLayout(codeBytes(code)).end).toBe(codeBytes(code).length)
    expect(dangerousOpcodes(code)).toContain('TIMESTAMP')
  })
  test('a PUSH whose data runs into the tail makes it code', () => {
    const code = hex('6000fe', '61', ipfsTail()) // PUSH2 takes the tail's first bytes as data
    expect(codeLayout(codeBytes(code)).end).toBe(codeBytes(code).length)
  })
  test('a reachable JUMPDEST inside the hash is followed until execution halts', () => {
    // hash: 1220, JUMPDEST BASEFEE STOP TIMESTAMP, padding: BASEFEE is reachable, TIMESTAMP (after STOP) is not
    const hash = `12205b480042${'01'.repeat(28)}`
    const code = hex(PREFIX, ipfsTail(hash))
    const layout = codeLayout(codeBytes(code))
    expect(layout.end).toBe(PREFIX.length / 2)
    expect(layout.tailEntries.length).toBe(1)
    expect(dangerousOpcodes(code)).toEqual(['BASEFEE'])
  })
  test('a 0x5b inside PUSH data of the tail is not a JUMPDEST', () => {
    // 0x61 = PUSH2 swallows 5b 48: no entry point
    const hash = `1220615b48${'01'.repeat(29)}`
    const code = hex(PREFIX, ipfsTail(hash))
    expect(codeLayout(codeBytes(code)).tailEntries).toEqual([])
    expect(dangerousOpcodes(code)).toEqual([])
  })
  test('code without any tail is scanned to the end', () => {
    expect(dangerousOpcodes('0x60004200')).toEqual(['TIMESTAMP'])
    expect(codeLayout(codeBytes('0x6000'))).toEqual({ end: 2, tailEntries: [] })
  })
})
