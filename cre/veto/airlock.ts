// What the workflow does with a proposal, independent of the CRE SDK: the SDK calls are behind `Ports`, so the
// same code runs in the DON (workflow.ts wires the EVM, HTTP and secrets capabilities) and in Bun unit tests
// (an in-memory chain).
//
// Both handlers end in the same place: every judged proposal gets an on-chain report.
//   pass -> Clear (AirlockAdmin.clear: the proposal may execute after its cooldown)
//   veto -> Veto  (AirlockAdmin.veto + attachReason: it never executes)
// A proposal nobody has judged has no clearance and cannot execute, so a missed log or a failed run delays an
// upgrade instead of letting it through. The sweeper (cron) catches up on those.
//
// "Judged" means judged by this workflow: AirlockAdmin.oracleJudged(id), set when the receiver (the clearance
// oracle) clears or vetoes. A manual clearance by the approver does not set it, so the workflow still judges a
// proposal the approver cleared, and its Veto still wins over that clearance.
import { type Address, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import { ACTION, AIRLOCK_ADMIN_ABI, EMPTY_DATA_HASH, KIND, STATUS, TOKEN_ABI, ZERO_HASH } from './abi'
import { BudgetError, type Read, readCost } from './chain'
import type { Config } from './config'
import { consensusValue, judgeConfig, staticUpgradeCheck, type UpgradeContext, type Verdict } from './judge'
import { actionHash, upgradeDataKey } from './keys'
import { actionOf, buildSignedReport, canonicalEvidence, evidenceHashOf, type ProposalFields, proposalDigest } from './report'
import type { RuleId } from './rules'
import { proposalActors } from './simulate'

export type Proposal = ProposalFields & { status: number; vetoCount: bigint; clearance: Hex; oracleJudged: boolean }

export type WriteResult = { ok: boolean; tx?: Hex; error?: string }

export interface Chain {
  /** ChainRead calls still available in this run. */
  readsLeft(): number
  /** Latest block number (one read). */
  latestBlock(): bigint
  /** Hash of block `n` (one read: header by number). */
  blockHash(n: bigint): Hex
  /** eth_calls at one block, batched (readCost(calls) reads). Results in call order. */
  read(calls: Read[], at: 'latest' | bigint): Hex[]
  /** Signed report payload -> forwarder -> receiver.onReport. */
  write(payload: Hex): WriteResult
}

export interface Ports {
  chain: Chain
  /** The attack simulation on every provider (CRE node mode) and the DON's identical-consensus verdict. */
  simulate(ctx: UpgradeContext, tag: string): Verdict
  /** The EIP-712 attester key (a CRE secret). */
  attesterKey(): Hex
  log(msg: string): void
}

export type Outcome = {
  id: string
  kind: number
  action: 'cleared' | 'vetoed' | 'skipped' | 'deferred' | 'unconfirmed' | 'failed'
  reason: string
  verdict?: 'pass' | 'veto'
  rule?: RuleId | null
  evidenceHash?: Hex
  validUntilBlock?: string
  tx?: Hex
}

export type SweepSummary = {
  block: string
  window: [string, string] | null
  candidates: string[]
  outcomes: Outcome[]
  readsLeft: number
  /** Set when the run stopped early (a per-run budget ran out); the next run picks up from the chain state. */
  error?: string
}

/** Reads after a report: one batched [getProposal, clearanceOf, oracleJudged] to confirm what the receiver did. */
const CONFIRM_READS = 1
/** HTTP calls one attack simulation needs per provider: eth_getCode, then up to `simRequests` eth_simulateV1. */
export const httpCallsPerProvider = (cfg: Pick<Config, 'simRequests'>) => 1 + cfg.simRequests

const STATUS_NAME: Record<number, string> = { 0: 'None', 1: 'Pending', 2: 'Vetoed', 3: 'Executed' }
const lc = (a: string) => a.toLowerCase() as Address

type AdminFn = 'getProposal' | 'clearanceOf' | 'oracleJudged' | 'nextId' | 'delayBlocks' | 'isApprovedCodehash'
const adminRead = (cfg: Pick<Config, 'airlockAdmin'>, functionName: AdminFn, args: readonly unknown[], ret: number): Read => ({
  to: lc(cfg.airlockAdmin),
  data: encodeFunctionData({ abi: AIRLOCK_ADMIN_ABI, functionName, args } as never),
  ret,
})
const decodeAdmin = <T>(functionName: string, data: Hex) => decodeFunctionResult({ abi: AIRLOCK_ADMIN_ABI, functionName, data } as never) as T

/** The reads of one proposal's state: getProposal, clearanceOf, oracleJudged. */
const proposalReads = (cfg: Pick<Config, 'airlockAdmin'>, id: bigint): Read[] => [
  adminRead(cfg, 'getProposal', [id], 320),
  adminRead(cfg, 'clearanceOf', [id], 32),
  adminRead(cfg, 'oracleJudged', [id], 32),
]
const PER_PROPOSAL = 3

/** ChainRead calls to read the state of `n` proposals (the sweeper's scan). */
export const scanCost = (cfg: Pick<Config, 'airlockAdmin'>, n: number): number =>
  readCost(Array.from({ length: n }, (_, i) => proposalReads(cfg, BigInt(i + 1))).flat())

/** getProposal + clearanceOf + oracleJudged for every id, at the latest block. */
export function readProposals(chain: Chain, cfg: Config, ids: bigint[]): Proposal[] {
  const res = chain.read(
    ids.flatMap((id) => proposalReads(cfg, id)),
    'latest',
  )
  return ids.map((id, i) => {
    const g = decodeAdmin<{
      kind: number
      status: number
      proposer: Address
      target: Address
      value: bigint
      codehash: Hex
      dataHash: Hex
      proposedBlock: bigint
      readyBlock: bigint
      vetoCount: bigint
    }>('getProposal', res[PER_PROPOSAL * i])
    return {
      id,
      kind: Number(g.kind),
      status: Number(g.status),
      proposer: lc(g.proposer),
      target: lc(g.target),
      value: g.value,
      codehash: g.codehash.toLowerCase() as Hex,
      dataHash: g.dataHash.toLowerCase() as Hex,
      proposedBlock: BigInt(g.proposedBlock),
      readyBlock: BigInt(g.readyBlock),
      vetoCount: g.vetoCount,
      clearance: decodeAdmin<Hex>('clearanceOf', res[PER_PROPOSAL * i + 1]).toLowerCase() as Hex,
      oracleJudged: decodeAdmin<boolean>('oracleJudged', res[PER_PROPOSAL * i + 2]),
    }
  })
}

/**
 * The sweeper's work list: Pending proposals no verdict of this workflow has reached, oldest first (closest to their
 * readyBlock). A clearance by the approver does not take a proposal off the list.
 */
export const sweepCandidates = (ps: Proposal[]): Proposal[] =>
  ps.filter((p) => p.status === STATUS.Pending && !p.oracleJudged).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** The newest `window` ids below nextId. */
export const sweepWindow = (nextId: bigint, window: number): bigint[] => {
  const first = nextId - BigInt(window) > 1n ? nextId - BigInt(window) : 1n
  const ids: bigint[] = []
  for (let id = first; id < nextId; id++) ids.push(id)
  return ids
}

const configReads = (cfg: Config, p: Proposal): Read[] => [
  adminRead(cfg, 'isApprovedCodehash', [actionHash(p.kind, p.target, p.value)], 32),
  ...(p.kind === KIND.SetDelay ? [adminRead(cfg, 'delayBlocks', [], 32)] : []),
]

const upgradeReads = (cfg: Config, p: Proposal): Read[] => [
  ...cfg.holders.map((h) => ({ to: lc(cfg.proxy), data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [h as Address] }), ret: 32 })),
  adminRead(cfg, 'isApprovedCodehash', [p.codehash], 32),
  ...(p.dataHash !== EMPTY_DATA_HASH ? [adminRead(cfg, 'isApprovedCodehash', [upgradeDataKey(p.codehash, p.dataHash)], 32)] : []),
]

/** Worst-case ChainRead calls to judge and report one proposal (judging reads, block hash, confirmation). */
export const judgeCost = (cfg: Config, p: Proposal): number =>
  p.kind === KIND.Upgrade ? readCost(upgradeReads(cfg, p)) + 1 + CONFIRM_READS : readCost(configReads(cfg, p)) + CONFIRM_READS

type Decision = Verdict & { reason: string }

/** Reads at the proposal block, then the verdict. `sims.left` caps attack simulations per run. */
export function judgeProposal(ports: Ports, cfg: Config, p: Proposal, sims: { left: number }): Decision | { deferred: string } {
  const { chain } = ports
  if (p.kind !== KIND.Upgrade) {
    const r = chain.read(configReads(cfg, p), p.proposedBlock)
    const approved = decodeAdmin<boolean>('isApprovedCodehash', r[0])
    const delay = p.kind === KIND.SetDelay ? BigInt(decodeAdmin<bigint>('delayBlocks', r[1])) : null
    const j = judgeConfig(p, delay, approved)
    return { ...consensusValue(j), reason: j.reason }
  }

  const r = chain.read(upgradeReads(cfg, p), p.proposedBlock)
  const n = cfg.holders.length
  const balances = r.slice(0, n).map((d) => decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'balanceOf', data: d }))
  const k = balances.findIndex((b) => b > 0n)
  const holder = k >= 0 ? lc(cfg.holders[k]) : null
  const balance = k >= 0 ? balances[k] : 0n
  const amount = balance / 100n > 0n ? balance / 100n : 1n
  // A second funded holder (different address) funds the stranger in the simulation, so the test holder's R3
  // accounting stays clean; fund with the test amount, capped at the funder's balance.
  const fk = balances.findIndex((b, i) => b > 0n && i !== k && lc(cfg.holders[i]) !== holder)
  const funder = fk >= 0 ? lc(cfg.holders[fk]) : null
  const fundAmount = fk >= 0 ? (balances[fk] < amount ? balances[fk] : amount) : 0n
  const codehashApproved = decodeAdmin<boolean>('isApprovedCodehash', r[n])
  const hasInitData = p.dataHash !== EMPTY_DATA_HASH
  const dataApproved = hasInitData ? decodeAdmin<boolean>('isApprovedCodehash', r[n + 1]) : false
  const s = staticUpgradeCheck({ strict: cfg.strict, codehash: p.codehash, codehashApproved, hasInitData, dataApproved, holder })
  if (s) return { ...consensusValue(s), reason: s.reason }
  if (sims.left < 1) return { deferred: 'one attack simulation per run, already used' }

  const blockHash = chain.blockHash(p.proposedBlock)
  const { stranger, receiver } = proposalActors(BigInt(cfg.chainId), lc(cfg.airlockAdmin), p.id, blockHash)
  const ctx: UpgradeContext = {
    proxy: lc(cfg.proxy),
    newImpl: p.target,
    codehash: p.codehash,
    hasInitData,
    block: p.proposedBlock,
    holder,
    amount,
    funder,
    fundAmount,
    holders: cfg.holders.map(lc),
    watch: cfg.watch.map(lc),
    stranger,
    receiver,
    strict: cfg.strict,
    codehashApproved,
    dataApproved,
    callGas: cfg.callGas,
    readGas: cfg.readGas,
    maxCalls: cfg.maxCalls,
    simRequests: cfg.simRequests,
    allowedOpcodes: cfg.allowedOpcodes,
  }
  sims.left -= 1
  const v = ports.simulate(ctx, `#${p.id}`)
  return { ...consensusValue(v), reason: `attack simulation, quorum of ${cfg.minAgree} (provider detail in the node logs)` }
}

/** Evidence, attestation, report, confirmation. */
export function deliverVerdict(ports: Ports, cfg: Config, p: Proposal, v: Verdict, currentBlock: bigint): Outcome {
  const chainId = BigInt(cfg.chainId)
  const admin = lc(cfg.airlockAdmin)
  const digest = proposalDigest(p)
  const verdict = consensusValue(v)
  const evidence = canonicalEvidence({ chainId, airlockAdmin: admin, proposal: p, proposalDigest: digest, verdict })
  const evidenceHash = evidenceHashOf(evidence)
  // Valid until the later of readyBlock and now, plus a grace: deterministic on every DON node, no clock involved.
  const validUntilBlock = (p.readyBlock > currentBlock ? p.readyBlock : currentBlock) + BigInt(cfg.reportGraceBlocks)
  const { action, ruleHash } = actionOf(verdict)
  const signed = buildSignedReport(ports.attesterKey(), chainId, lc(cfg.receiver), admin, {
    action,
    proposalId: p.id,
    proposalDigest: digest,
    ruleHash,
    evidenceHash,
    validUntilBlock,
  })
  const name = action === ACTION.Clear ? 'Clear' : 'Veto'
  ports.log(`#${p.id} evidence ${evidence}`)
  ports.log(`#${p.id} report ${name} evidenceHash ${evidenceHash} validUntilBlock ${validUntilBlock} digest ${signed.digest}`)
  const base: Outcome = {
    id: p.id.toString(),
    kind: p.kind,
    action: 'failed',
    reason: '',
    verdict: verdict.verdict,
    rule: verdict.rule,
    evidenceHash,
    validUntilBlock: validUntilBlock.toString(),
  }
  const w = ports.chain.write(signed.payload)
  if (w.tx) base.tx = w.tx
  if (!w.ok) {
    ports.log(`#${p.id} ${name} report not written: ${w.error ?? 'unknown error'}`)
    return { ...base, reason: `writeReport failed: ${w.error ?? 'unknown error'}` }
  }
  // The forwarder swallows a reverting onReport: a successful transaction is not proof, the proposal state is.
  // oracleJudged is the receiver's own mark (an approver clearance already makes clearanceOf non-zero). A read that
  // does not show the verdict cannot tell a rejected report from a node that has not caught up yet, so it is
  // 'unconfirmed', not a failure: the sweeper re-judges any proposal whose oracleJudged is still false.
  const [after] = readProposals(ports.chain, cfg, [p.id])
  const accepted = after.oracleJudged && (action === ACTION.Veto ? after.status === STATUS.Vetoed : after.status !== STATUS.Vetoed)
  const out: Outcome = {
    ...base,
    action: accepted ? (action === ACTION.Veto ? 'vetoed' : 'cleared') : 'unconfirmed',
    reason: accepted
      ? `${name} accepted${action === ACTION.Clear && after.clearance !== evidenceHash ? ` (clearanceOf keeps the earlier clearance ${after.clearance})` : ''}`
      : `${name} sent; the read shows ${STATUS_NAME[after.status]}, oracleJudged ${after.oracleJudged} (rejected, or the node is behind; the sweeper re-checks)`,
  }
  ports.log(`#${p.id} ${name} tx ${w.tx ?? '(none)'} -> ${out.action} (status ${STATUS_NAME[after.status]})`)
  return out
}

function judgeAndDeliver(ports: Ports, cfg: Config, p: Proposal, currentBlock: bigint, sims: { left: number }): Outcome {
  const id = p.id.toString()
  const need = judgeCost(cfg, p)
  if (ports.chain.readsLeft() < need) {
    return { id, kind: p.kind, action: 'deferred', reason: `needs ${need} chain reads, ${ports.chain.readsLeft()} left in this run` }
  }
  const d = judgeProposal(ports, cfg, p, sims)
  if ('deferred' in d) {
    ports.log(`#${id} deferred: ${d.deferred}`)
    return { id, kind: p.kind, action: 'deferred', reason: d.deferred }
  }
  ports.log(`#${id} verdict ${d.verdict}${d.rule ? ` ${d.rule}` : ''} (${d.reason})`)
  return deliverVerdict(ports, cfg, p, d, currentBlock)
}

const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 300)

/**
 * Handler 0: a Proposed log. Judges the proposal while it is Pending and this workflow has not judged it yet (a
 * guardian veto still wins over a clearance; an approver clearance does not count as a verdict).
 */
export function handleProposed(ports: Ports, cfg: Config, id: bigint): Outcome {
  try {
    const currentBlock = ports.chain.latestBlock()
    const [p] = readProposals(ports.chain, cfg, [id])
    if (p.status !== STATUS.Pending || p.oracleJudged) {
      const reason =
        p.status === STATUS.None ? 'unknown proposal (log from a reorged block?)' : p.status !== STATUS.Pending ? `proposal is ${STATUS_NAME[p.status]}` : 'already judged by this workflow'
      ports.log(`#${id} skipped: ${reason}`)
      return { id: id.toString(), kind: p.kind, action: 'skipped', reason }
    }
    return judgeAndDeliver(ports, cfg, p, currentBlock, { left: 1 })
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e
    ports.log(`#${id} deferred: ${errMsg(e)} (the sweeper judges it later)`)
    return { id: id.toString(), kind: -1, action: 'deferred', reason: errMsg(e) }
  }
}

/**
 * Handler 1: the sweeper. Looks at the newest `sweepWindow` ids and judges every Pending proposal this workflow has
 * not judged (approver-cleared ones included), oldest first, within this run's budgets: at most one attack
 * simulation, and only while the chain reads a judgement needs are left. A receiver verdict always sets
 * oracleJudged, so whatever is left over is picked up by the next run. A budget that runs out anyway ends the run
 * with a log line and the summary, never with an error.
 */
export function handleSweep(ports: Ports, cfg: Config): SweepSummary {
  const { chain } = ports
  let currentBlock = 0n
  let ids: bigint[] = []
  let todo: Proposal[]
  try {
    currentBlock = chain.latestBlock()
    const nextId = BigInt(decodeAdmin<bigint>('nextId', chain.read([adminRead(cfg, 'nextId', [], 32)], 'latest')[0]))
    ids = sweepWindow(nextId, cfg.sweepWindow)
    if (!ids.length) {
      ports.log('sweep: no proposals yet')
      return { block: currentBlock.toString(), window: null, candidates: [], outcomes: [], readsLeft: chain.readsLeft() }
    }
    todo = sweepCandidates(readProposals(chain, cfg, ids))
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e
    ports.log(`sweep stopped before judging anything: ${errMsg(e)}`)
    return {
      block: currentBlock.toString(),
      window: ids.length ? [ids[0].toString(), ids[ids.length - 1].toString()] : null,
      candidates: [],
      outcomes: [],
      readsLeft: chain.readsLeft(),
      error: errMsg(e),
    }
  }
  const shown = todo.map((p) => `#${p.id}${p.clearance !== ZERO_HASH ? '(approver-cleared)' : ''}`).join(' ')
  ports.log(`sweep at block ${currentBlock}: ids ${ids[0]}-${ids[ids.length - 1]}, pending without a workflow verdict: ${shown || 'none'}`)
  const sims = { left: 1 }
  const outcomes: Outcome[] = []
  let exhausted: string | undefined
  for (const p of todo) {
    const id = p.id.toString()
    if (exhausted) {
      outcomes.push({ id, kind: p.kind, action: 'deferred', reason: exhausted })
      continue
    }
    try {
      outcomes.push(judgeAndDeliver(ports, cfg, p, currentBlock, sims))
    } catch (e) {
      const reason = errMsg(e)
      if (e instanceof BudgetError) {
        exhausted = reason
        ports.log(`#${id} deferred, run budget exhausted: ${reason}`)
        outcomes.push({ id, kind: p.kind, action: 'deferred', reason })
      } else {
        ports.log(`#${id} failed: ${reason}`)
        outcomes.push({ id, kind: p.kind, action: 'failed', reason })
      }
    }
  }
  return {
    block: currentBlock.toString(),
    window: [ids[0].toString(), ids[ids.length - 1].toString()],
    candidates: todo.map((p) => p.id.toString()),
    outcomes,
    readsLeft: chain.readsLeft(),
    ...(exhausted ? { error: exhausted } : {}),
  }
}
