// Both handlers against an in-memory AirlockAdmin + AirlockReceiver: the same checks the contracts make
// (forwarded report, attester signature, freshness, proposal digest, veto wins over clearance, oracleJudged set only
// by the receiver's verdicts), with the CRE per-run read budget enforced.
import { beforeEach, describe, expect, test } from 'bun:test'
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, keccak256, recoverAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ACTION, AIRLOCK_ADMIN_ABI, EMPTY_DATA_HASH, KIND, MULTICALL3_ABI, STATUS, TOKEN_ABI, ZERO_HASH } from '../abi'
import { type Chain, handleProposed, handleSweep, judgeCost, type Ports, type Proposal, scanCost, sweepCandidates, sweepWindow } from '../airlock'
import { BudgetError, chunkReads, decodeAggregate3, LIMITS, type Read } from '../chain'
import { type Config, configSchema, MAX_SWEEP_WINDOW } from '../config'
import type { UpgradeContext, Verdict } from '../judge'
import { actionHash, upgradeDataKey } from '../keys'
import { canonicalEvidence, decodeReport, evidenceHashOf, proposalDigest, verdictDigest } from '../report'
import { ruleHash } from '../rules'
import { proposalActors } from '../simulate'

const ATTESTER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex // anvil #2, public
const ADMIN = '0x00000000000000000000000000000000000a1a00' as Address
const RECEIVER = '0x00000000000000000000000000000000000ec000' as Address
const PROXY = '0x0000000000000000000000000000000000090000' as Address
const OWNER = '0x0000000000000000000000000000000000000001' as Address
const HOLDERS = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3'] as Address[]
const GOOD = '0x00000000000000000000000000000000000000c1' as Address
const EVIL = '0x00000000000000000000000000000000000000e1' as Address
const EVIL2 = '0x00000000000000000000000000000000000000e2' as Address

const cfg: Config = configSchema.parse({
  chainSelectorName: 'ethereum-testnet-sepolia',
  chainId: 11155111,
  airlockAdmin: ADMIN,
  receiver: RECEIVER,
  proxy: PROXY,
  holders: HOLDERS,
  watch: [OWNER],
  rpcs: [
    { url: 'https://a.example', label: 'a' },
    { url: 'https://b.example', label: 'b' },
  ],
  minAgree: 2,
  reportGraceBlocks: 50,
})

type P = Omit<Proposal, 'clearance' | 'oracleJudged'>

/** AirlockAdmin + AirlockReceiver + Multicall3, enough of them to run the workflow logic. */
class FakeChain implements Chain {
  block = 1000n
  delay = 25n
  nextId = 1n
  props = new Map<bigint, P>()
  clearance = new Map<bigint, Hex>()
  /** AirlockAdmin.oracleJudged: set only when the receiver (the clearance oracle) clears or vetoes */
  judged = new Map<bigint, boolean>()
  approvals = new Map<Hex, bigint>() // key -> block it was approved in
  // the first holder is empty: the second one makes the test transfer
  balances = new Map<string, bigint>([
    [HOLDERS[0], 0n],
    [HOLDERS[1], 5_000_000_000n],
    [HOLDERS[2], 25n],
  ])
  used = 0
  readsAt: ('latest' | bigint)[] = []
  reports: { action: number; id: bigint; rule: Hex; evidence: Hex; until: bigint }[] = []
  signatures: { digest: Hex; signature: Hex; expect: Address }[] = []
  propose(kind: number, target: Address, value = 0n, data: Hex = '0x', codehash: Hex = keccak256(target)): bigint {
    const id = this.nextId++
    this.props.set(id, {
      id,
      kind,
      status: STATUS.Pending,
      proposer: OWNER,
      target: target.toLowerCase() as Address,
      value,
      codehash: kind === KIND.Upgrade ? codehash : ZERO_HASH,
      dataHash: keccak256(data),
      proposedBlock: this.block,
      readyBlock: this.block + this.delay,
      vetoCount: 0n,
    })
    this.block += 1n
    return id
  }
  approve(key: Hex) {
    this.approvals.set(key, this.block)
    this.block += 1n
  }
  /** AirlockAdmin.clear by the approver: keeps the first evidence, never sets oracleJudged. */
  approverClear(id: bigint, evidence: Hex = keccak256('0xa99207e5')) {
    const p = this.props.get(id) as P
    if (p.status !== STATUS.Pending) throw new Error('not pending')
    if (!this.clearance.get(id)) this.clearance.set(id, evidence)
    this.block += 1n
  }
  /** AirlockAdmin.veto by the emergency guardian: never sets oracleJudged. */
  guardianVeto(id: bigint) {
    const p = this.props.get(id) as P
    if (p.status === STATUS.Pending) p.status = STATUS.Vetoed
    p.vetoCount += 1n
    this.block += 1n
  }
  newRun() {
    this.used = 0
    this.readsAt = []
  }
  private take(n = 1) {
    if (this.used + n > LIMITS.chainReads) throw new BudgetError('ChainRead CallLimit exceeded')
    this.used += n
  }
  readsLeft() {
    return LIMITS.chainReads - this.used
  }
  latestBlock() {
    this.take()
    return this.block
  }
  blockHash(n: bigint): Hex {
    this.take()
    return keccak256(`0x${n.toString(16).padStart(64, '0')}`)
  }
  private answer(c: Read, at: 'latest' | bigint): Hex {
    const b = at === 'latest' ? this.block : at
    if (c.to.toLowerCase() === PROXY.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: TOKEN_ABI, data: c.data })
      return encodeFunctionResult({ abi: TOKEN_ABI, functionName: 'balanceOf', result: this.balances.get((args?.[0] as string).toLowerCase()) ?? 0n })
    }
    if (c.to.toLowerCase() !== ADMIN.toLowerCase()) throw new Error(`unexpected read target ${c.to}`)
    const d = decodeFunctionData({ abi: AIRLOCK_ADMIN_ABI, data: c.data })
    const r = (functionName: string, result: unknown) => encodeFunctionResult({ abi: AIRLOCK_ADMIN_ABI, functionName, result } as never)
    switch (d.functionName) {
      case 'nextId':
        return r('nextId', this.nextId)
      case 'delayBlocks':
        return r('delayBlocks', this.delay)
      case 'isApprovedCodehash': {
        const at0 = this.approvals.get((d.args[0] as Hex).toLowerCase() as Hex)
        return r('isApprovedCodehash', at0 !== undefined && at0 <= b)
      }
      case 'clearanceOf':
        return r('clearanceOf', this.clearance.get(d.args[0] as bigint) ?? ZERO_HASH)
      case 'oracleJudged':
        return r('oracleJudged', this.judged.get(d.args[0] as bigint) ?? false)
      case 'getProposal': {
        const p = this.props.get(d.args[0] as bigint)
        const empty = { kind: 0, status: 0, proposer: OWNER, target: OWNER, value: 0n, codehash: ZERO_HASH, dataHash: ZERO_HASH, proposedBlock: 0n, readyBlock: 0n, vetoCount: 0n }
        const { id: _id, ...rest } = p ?? { id: 0n, ...empty }
        return r('getProposal', rest)
      }
      default:
        throw new Error(`unexpected admin read ${d.functionName}`)
    }
  }
  read(calls: Read[], at: 'latest' | bigint): Hex[] {
    return chunkReads(calls).flatMap((chunk) => {
      this.take()
      this.readsAt.push(at)
      if (chunk.length === 1) return [this.answer(chunk[0], at)]
      // round-trip through the real aggregate3 encoding
      const res = chunk.map((c) => ({ success: true, returnData: this.answer(c, at) }))
      return decodeAggregate3(encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: res }), chunk.length)
    })
  }
  /** AirlockReceiver.onReport + AirlockAdmin (one transaction per report). */
  write(payload: Hex) {
    this.block += 1n
    const tx = keccak256(payload)
    const rep = decodeReport(payload)
    const p = this.props.get(rep.proposalId)
    const reverted = (why: string) => ({ ok: true, tx, error: why }) // the forwarder swallows the revert
    if (this.block > rep.validUntilBlock) return reverted('ReportExpired')
    // recoverAddress is async: the tests check the recorded signatures
    this.signatures.push({ digest: verdictDigest(11155111n, RECEIVER, ADMIN, rep), signature: rep.signature, expect: privateKeyToAccount(ATTESTER_KEY).address })
    if (!p) return reverted('UnknownProposal')
    if (rep.proposalDigest !== proposalDigest(p)) return reverted('ProposalMismatch')
    if (rep.action === ACTION.Veto) {
      if (p.status === STATUS.Executed) return reverted('AlreadyExecuted')
      p.status = STATUS.Vetoed
      p.vetoCount += 1n
      this.judged.set(p.id, true)
    } else {
      if (p.status !== STATUS.Pending) return reverted('not pending')
      if (!this.clearance.get(p.id)) this.clearance.set(p.id, rep.evidenceHash)
      this.judged.set(p.id, true)
    }
    this.reports.push({ action: rep.action, id: rep.proposalId, rule: rep.ruleHash, evidence: rep.evidenceHash, until: rep.validUntilBlock })
    return { ok: true, tx }
  }
  proposal(id: bigint): Proposal {
    const p = this.props.get(id) as P
    return { ...p, clearance: this.clearance.get(id) ?? ZERO_HASH, oracleJudged: this.judged.get(id) ?? false }
  }
}

let chain: FakeChain
let sims: UpgradeContext[]
let logs: string[]
/** Simulation outcome per implementation (what the DON would agree on). */
const simVerdict: Record<string, Verdict> = {
  [GOOD]: { verdict: 'pass', rule: null },
  [EVIL]: { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY' },
  [EVIL2]: { verdict: 'veto', rule: 'R9_NEW_OPCODES' },
}
const ports = (): Ports => ({
  chain,
  simulate: (ctx) => {
    sims.push(ctx)
    return simVerdict[ctx.newImpl]
  },
  attesterKey: () => ATTESTER_KEY,
  log: (m) => logs.push(m),
})
const run = <T>(f: () => T): T => {
  chain.newRun()
  return f()
}

beforeEach(() => {
  chain = new FakeChain()
  sims = []
  logs = []
})

describe('log trigger path', () => {
  test('an honest upgrade is cleared, with a fresh attested report', async () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    const p0 = chain.proposal(id)
    const o = run(() => handleProposed(ports(), cfg, id))
    expect(o.action).toBe('cleared')
    expect(chain.proposal(id).clearance).toBe(o.evidenceHash as Hex)
    expect(chain.reports[0].action).toBe(ACTION.Clear)
    expect(chain.reports[0].rule).toBe(ZERO_HASH)
    // validUntilBlock = max(readyBlock, current) + grace; here readyBlock is later
    expect(chain.reports[0].until).toBe(p0.readyBlock + 50n)
    for (const s of chain.signatures) expect(await recoverAddress({ hash: s.digest, signature: s.signature })).toBe(s.expect)
    expect(chain.used).toBeLessThanOrEqual(LIMITS.chainReads)
    expect(sims.length).toBe(1)
  })
  test('the simulation runs at the proposal block with actors from its block hash and every holder watched', () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    const p = chain.proposal(id)
    run(() => handleProposed(ports(), cfg, id))
    const ctx = sims[0]
    expect(ctx.block).toBe(p.proposedBlock)
    expect(ctx.holder).toBe(HOLDERS[1]) // the first holder with a balance
    expect(ctx.holders).toEqual(HOLDERS)
    const blockHash = keccak256(`0x${p.proposedBlock.toString(16).padStart(64, '0')}`)
    expect(ctx.stranger).toBe(proposalActors(11155111n, ADMIN, id, blockHash).stranger)
    // approvals and balances are read at the proposal block
    expect(chain.readsAt).toContain(p.proposedBlock)
  })
  test('a malicious upgrade is vetoed with its rule', () => {
    const id = chain.propose(KIND.Upgrade, EVIL)
    const o = run(() => handleProposed(ports(), cfg, id))
    expect([o.action, o.rule]).toEqual(['vetoed', 'R1_TOTAL_SUPPLY'])
    expect(chain.proposal(id).status).toBe(STATUS.Vetoed)
    expect(chain.reports[0].rule).toBe(ruleHash('R1_TOTAL_SUPPLY'))
  })
  test('removing a guardian without approval is vetoed R7 without any simulation', () => {
    const id = chain.propose(KIND.SetGuardian, RECEIVER, 0n)
    const o = run(() => handleProposed(ports(), cfg, id))
    expect([o.action, o.rule]).toEqual(['vetoed', 'R7_CONFIG_GUARD'])
    expect(sims.length).toBe(0)
  })
  test('an approval made before the proposal counts, one made after it does not', () => {
    chain.approve(actionHash(KIND.SetDelay, '0x0000000000000000000000000000000000000000', 20n))
    const before = chain.propose(KIND.SetDelay, '0x0000000000000000000000000000000000000000', 20n)
    expect(run(() => handleProposed(ports(), cfg, before)).action).toBe('cleared')
    const after = chain.propose(KIND.SetDelay, '0x0000000000000000000000000000000000000000', 15n)
    chain.approve(actionHash(KIND.SetDelay, '0x0000000000000000000000000000000000000000', 15n))
    expect(run(() => handleProposed(ports(), cfg, after)).rule).toBe('R7_CONFIG_GUARD')
  })
  test('init data needs a codehash+data approval (R8), from the dataHash alone', () => {
    const data = `0x${'ab'.repeat(6000)}` as Hex
    const id = chain.propose(KIND.Upgrade, GOOD, 0n, data)
    expect(run(() => handleProposed(ports(), cfg, id)).rule).toBe('R8_INIT_DATA')
    expect(sims.length).toBe(0)
    const id2 = chain.propose(KIND.Upgrade, GOOD, 0n, data)
    chain.approve(upgradeDataKey(keccak256(GOOD), keccak256(data)))
    const id3 = chain.propose(KIND.Upgrade, GOOD, 0n, data)
    expect(run(() => handleProposed(ports(), cfg, id2)).rule).toBe('R8_INIT_DATA') // approved after it was proposed
    expect(run(() => handleProposed(ports(), cfg, id3)).action).toBe('cleared')
  })
  test('only Pending proposals are judged', () => {
    const id = chain.propose(KIND.Upgrade, EVIL)
    run(() => handleProposed(ports(), cfg, id))
    const o = run(() => handleProposed(ports(), cfg, id))
    expect(o.action).toBe('skipped')
    expect(run(() => handleProposed(ports(), cfg, 99n)).action).toBe('skipped')
  })
  test('no funded holder fails closed (R6)', () => {
    for (const h of HOLDERS) chain.balances.set(h, 0n)
    const id = chain.propose(KIND.Upgrade, GOOD)
    expect(run(() => handleProposed(ports(), cfg, id)).rule).toBe('R6_SIM_FAILURE')
  })
})

describe('sweeper path', () => {
  test('finds the proposals no verdict reached and judges them, oldest first', () => {
    const a = chain.propose(KIND.Upgrade, GOOD) // judged by the log trigger
    run(() => handleProposed(ports(), cfg, a))
    const b = chain.propose(KIND.Upgrade, EVIL) // judged by the log trigger
    run(() => handleProposed(ports(), cfg, b))
    const c = chain.propose(KIND.Upgrade, GOOD) // missed
    const d = chain.propose(KIND.SetGuardian, RECEIVER, 0n) // missed
    chain.block += 30n
    const s = run(() => handleSweep(ports(), cfg))
    expect(s.candidates).toEqual([c.toString(), d.toString()])
    expect(s.outcomes.map((o) => [o.id, o.action, o.rule])).toEqual([
      [c.toString(), 'cleared', null],
      [d.toString(), 'vetoed', 'R7_CONFIG_GUARD'],
    ])
    expect(chain.used).toBeLessThanOrEqual(LIMITS.chainReads)
    // the report is fresh although readyBlock has passed: max(readyBlock, current) + grace
    const rep = chain.reports.find((r) => r.id === c) as { until: bigint }
    expect(rep.until).toBeGreaterThan(chain.proposal(c).readyBlock + 50n)
  })
  test('at most one attack simulation per run; static and config verdicts still go through', () => {
    const u1 = chain.propose(KIND.Upgrade, EVIL)
    const u2 = chain.propose(KIND.Upgrade, EVIL2)
    const big = chain.propose(KIND.Upgrade, GOOD, 0n, `0x${'cd'.repeat(6000)}`)
    const g = chain.propose(KIND.SetGuardian, OWNER, 1n)
    const s1 = run(() => handleSweep(ports(), cfg))
    expect(s1.outcomes.map((o) => [o.id, o.action, o.rule ?? null])).toEqual([
      [u1.toString(), 'vetoed', 'R1_TOTAL_SUPPLY'],
      [u2.toString(), 'deferred', null],
      [big.toString(), 'vetoed', 'R8_INIT_DATA'],
      [g.toString(), 'vetoed', 'R7_CONFIG_GUARD'],
    ])
    expect(sims.length).toBe(1)
    const s2 = run(() => handleSweep(ports(), cfg))
    expect(s2.outcomes.map((o) => [o.id, o.action, o.rule])).toEqual([[u2.toString(), 'vetoed', 'R9_NEW_OPCODES']])
    const s3 = run(() => handleSweep(ports(), cfg))
    expect(s3.candidates).toEqual([])
  })
  test('stays inside the ChainRead budget and leaves the rest for the next run', () => {
    for (let i = 0; i < 12; i++) chain.propose(KIND.SetGuardian, OWNER, 1n)
    const s1 = run(() => handleSweep(ports(), cfg))
    expect(chain.used).toBeLessThanOrEqual(LIMITS.chainReads)
    expect(s1.outcomes.some((o) => o.action === 'failed')).toBe(false)
    const done = s1.outcomes.filter((o) => o.action === 'vetoed').length
    expect(done).toBeGreaterThan(0)
    expect(s1.outcomes.filter((o) => o.action === 'deferred').length).toBe(12 - done)
    let runs = 1
    while (sweepCandidates([...chain.props.keys()].map((id) => chain.proposal(id))).length && runs < 10) {
      run(() => handleSweep(ports(), cfg))
      expect(chain.used).toBeLessThanOrEqual(LIMITS.chainReads)
      runs++
    }
    expect(runs).toBeLessThan(10)
    expect([...chain.props.values()].every((p) => p.status === STATUS.Vetoed)).toBe(true)
  })
  test('looks only at the newest window of ids', () => {
    for (let i = 0; i < 25; i++) chain.propose(KIND.SetGuardian, OWNER, 1n)
    const s = run(() => handleSweep(ports(), { ...cfg, sweepWindow: 20 }))
    expect(s.window).toEqual(['6', '25'])
    expect(s.candidates[0]).toBe('6')
    expect(s.outcomes.some((o) => o.action === 'failed')).toBe(false)
    expect(chain.used).toBeLessThanOrEqual(LIMITS.chainReads)
    expect(sweepWindow(3n, 20)).toEqual([1n, 2n])
    expect(sweepWindow(1n, 20)).toEqual([])
  })
  test('a vetoed proposal is never cleared, a cleared one is not judged again', () => {
    const v = chain.propose(KIND.Upgrade, EVIL)
    run(() => handleProposed(ports(), cfg, v))
    const c = chain.propose(KIND.Upgrade, GOOD)
    run(() => handleProposed(ports(), cfg, c))
    const n = chain.reports.length
    const s = run(() => handleSweep(ports(), cfg))
    expect(s.candidates).toEqual([])
    expect(chain.reports.length).toBe(n)
    expect(chain.proposal(v).clearance).toBe(ZERO_HASH)
  })
  test('the log path and the sweeper produce the same evidence for the same proposal', () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    const viaLog = run(() => handleProposed(ports(), cfg, id)).evidenceHash
    // same chain state, judged by the sweeper instead
    chain.clearance.delete(id)
    chain.judged.delete(id)
    const viaSweep = run(() => handleSweep(ports(), cfg)).outcomes[0].evidenceHash
    expect(viaSweep).toBe(viaLog as Hex)
    // and anyone can recompute it from getProposal + the verdict
    const p = chain.proposal(id)
    const e = canonicalEvidence({ chainId: 11155111n, airlockAdmin: ADMIN, proposal: p, proposalDigest: proposalDigest(p), verdict: { verdict: 'pass', rule: null } })
    expect(evidenceHashOf(e)).toBe(viaLog as Hex)
  })
  test('a report the receiver rejects (here: expired) is reported as unconfirmed', () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    const real = chain.write.bind(chain)
    chain.write = (payload: Hex) => {
      chain.block += 1000n // the transaction lands long after validUntilBlock
      return real(payload)
    }
    expect(run(() => handleProposed(ports(), cfg, id)).action).toBe('unconfirmed')
    expect(chain.proposal(id).clearance).toBe(ZERO_HASH)
  })
  test('judgement cost estimates', () => {
    const u = chain.propose(KIND.Upgrade, GOOD)
    const g = chain.propose(KIND.SetGuardian, OWNER, 1n)
    expect(judgeCost(cfg, chain.proposal(u))).toBe(3)
    expect(judgeCost(cfg, chain.proposal(g))).toBe(2)
    expect(EMPTY_DATA_HASH).toBe(chain.proposal(u).dataHash)
  })
})

describe('approver clearances do not count as a workflow verdict (oracleJudged)', () => {
  test('the sweeper judges an approver-cleared proposal whose log was missed, and its veto wins', () => {
    const id = chain.propose(KIND.Upgrade, EVIL) // log missed
    chain.approverClear(id)
    expect(sweepCandidates([chain.proposal(id)]).map((p) => p.id)).toEqual([id])
    const s = run(() => handleSweep(ports(), cfg))
    expect(s.candidates).toEqual([id.toString()])
    expect(s.outcomes.map((o) => [o.action, o.rule])).toEqual([['vetoed', 'R1_TOTAL_SUPPLY']])
    expect(chain.proposal(id).status).toBe(STATUS.Vetoed)
    expect(chain.proposal(id).oracleJudged).toBe(true)
    expect(logs.some((l) => l.includes(`#${id}(approver-cleared)`))).toBe(true)
    // judged now: the next sweep leaves it alone
    expect(run(() => handleSweep(ports(), cfg)).candidates).toEqual([])
  })
  test('an approver-cleared honest proposal gets its workflow Clear; clearanceOf keeps the first evidence', () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    const manual = keccak256('0x6d616e75616c')
    chain.approverClear(id, manual)
    const o = run(() => handleSweep(ports(), cfg)).outcomes[0]
    expect(o.action).toBe('cleared')
    expect(o.reason).toContain('keeps the earlier clearance')
    expect(chain.proposal(id).clearance).toBe(manual)
    expect(chain.proposal(id).oracleJudged).toBe(true)
    expect(sims.length).toBe(1)
  })
  test('the log trigger also judges a proposal the approver cleared first', () => {
    const id = chain.propose(KIND.Upgrade, EVIL2)
    chain.approverClear(id)
    const o = run(() => handleProposed(ports(), cfg, id))
    expect([o.action, o.rule]).toEqual(['vetoed', 'R9_NEW_OPCODES'])
  })
  test('a proposal the workflow already judged is skipped by the log trigger (duplicate delivery)', () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    expect(run(() => handleProposed(ports(), cfg, id)).action).toBe('cleared')
    const n = chain.reports.length
    const again = run(() => handleProposed(ports(), cfg, id))
    expect([again.action, again.reason]).toEqual(['skipped', 'already judged by this workflow'])
    expect(chain.reports.length).toBe(n)
  })
  test('a rejected Clear on an approver-cleared proposal is reported as unconfirmed (clearanceOf alone is no proof)', () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    chain.approverClear(id)
    const real = chain.write.bind(chain)
    chain.write = (payload: Hex) => {
      chain.block += 1000n // lands after validUntilBlock: the receiver reverts, the forwarder swallows it
      return real(payload)
    }
    const o = run(() => handleProposed(ports(), cfg, id))
    expect(o.action).toBe('unconfirmed')
    expect(chain.proposal(id).clearance).not.toBe(ZERO_HASH)
    expect(chain.proposal(id).oracleJudged).toBe(false)
  })
  test("an emergency guardian's veto leaves nothing for the sweeper", () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    chain.guardianVeto(id)
    expect(chain.proposal(id).oracleJudged).toBe(false)
    expect(run(() => handleSweep(ports(), cfg)).candidates).toEqual([])
  })
})

describe('sweep window and run budgets', () => {
  test(`the largest sweepWindow (${MAX_SWEEP_WINDOW}) leaves room for an upgrade and two config changes`, () => {
    const fixed = 2 // latest header, nextId
    const upgrade = 3
    const config = 2
    expect(fixed + scanCost(cfg, MAX_SWEEP_WINDOW) + upgrade + 2 * config).toBeLessThanOrEqual(LIMITS.chainReads)
    expect(configSchema.safeParse({ ...cfg, sweepWindow: MAX_SWEEP_WINDOW }).success).toBe(true)
    expect(configSchema.safeParse({ ...cfg, sweepWindow: MAX_SWEEP_WINDOW + 1 }).success).toBe(false)
    // the values that used to pass the schema and break every sweep
    expect(configSchema.safeParse({ ...cfg, sweepWindow: 79 }).success).toBe(false)
    expect(configSchema.safeParse({ ...cfg, sweepWindow: 100 }).success).toBe(false)
  })
  test('a full window of pending proposals: the run stays in budget and judges an upgrade and config changes', () => {
    for (let i = 0; i < MAX_SWEEP_WINDOW; i++) i % 2 ? chain.propose(KIND.SetGuardian, OWNER, 1n) : chain.propose(KIND.Upgrade, EVIL)
    const s = run(() => handleSweep(ports(), { ...cfg, sweepWindow: MAX_SWEEP_WINDOW }))
    expect(chain.used).toBeLessThanOrEqual(LIMITS.chainReads)
    expect(s.candidates.length).toBe(MAX_SWEEP_WINDOW)
    expect(s.error).toBeUndefined()
    expect(s.outcomes.filter((o) => o.action === 'vetoed' && o.kind === KIND.Upgrade).length).toBe(1)
    expect(s.outcomes.filter((o) => o.action === 'vetoed' && o.kind === KIND.SetGuardian).length).toBeGreaterThanOrEqual(2)
  })
  test('a budget that runs out during the scan ends the run with a log line, not an error', () => {
    for (let i = 0; i < 20; i++) chain.propose(KIND.SetGuardian, OWNER, 1n)
    const s = run(() => {
      chain.used = LIMITS.chainReads - 3 // something else already used most of this run's reads
      return handleSweep(ports(), cfg)
    })
    expect(s.error).toContain('ChainRead')
    expect(s.outcomes).toEqual([])
    expect(logs.some((l) => l.startsWith('sweep stopped before judging anything'))).toBe(true)
  })
  test('a budget error while judging defers that proposal and the rest, and the run still returns', () => {
    const a = chain.propose(KIND.Upgrade, GOOD)
    const b = chain.propose(KIND.SetGuardian, OWNER, 1n)
    chain.blockHash = () => {
      throw new BudgetError('ChainRead CallLimit exceeded')
    }
    const s = run(() => handleSweep(ports(), cfg))
    expect(s.outcomes.map((o) => [o.id, o.action])).toEqual([
      [a.toString(), 'deferred'],
      [b.toString(), 'deferred'],
    ])
    expect(s.error).toContain('ChainRead')
  })
  test('the log path defers on a budget error instead of failing the run', () => {
    const id = chain.propose(KIND.Upgrade, GOOD)
    chain.blockHash = () => {
      throw new BudgetError('ChainRead CallLimit exceeded')
    }
    expect(run(() => handleProposed(ports(), cfg, id)).action).toBe('deferred')
  })
})
