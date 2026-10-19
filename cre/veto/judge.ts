// Verdicts. Pure apart from the injected `rpc` function, so the same code runs in Bun tests and inside a CRE
// node-mode call (where `rpc` is backed by the HTTP capability).
//
// Config proposals (kinds 1-3): R7 only, from two chain reads (judgeConfig).
// Upgrades: static rules first (R5 strict codehash, R8 init data, a funded holder must exist), then the attack
// simulation on every configured RPC provider, pinned to the proposal's block, with 1 + up to `simRequests` HTTP
// requests each:
//   1. eth_getCode(newImpl) -> the code must hash to the proposed codehash (else R6)
//   2. eth_simulateV1, split over as many requests as the probes need (simulate.ts) -> evaluateSimulation (R1-R4,
//      R3B). Probes that do not fit in `simRequests` requests are R6, unless the codehash is approved: then only that
//      truncation is excused and every other rule still runs on the probes that fit.
//   3. R9: block/fee context, external call, create and selfdestruct opcodes in the new code that the config's
//      `allowedOpcodes` does not list veto, unless the codehash is approved. The list is fixed in the config, so an
//      approval of one implementation's codehash never exempts a later one.
// Quorum: at least `minAgree` providers answer and every answer is the same verdict (pass, or veto with one rule).
// Anything else fails closed as R6_SIM_FAILURE: a wrong veto only delays an upgrade, a wrong pass could let an
// attacker in.
//
// The DON agrees only on `Verdict` ({verdict, rule}); everything else in a `Judgement` (checks, culprits, opcode
// lists, probe counts) is detail for the logs.
import { type Address, type Hex, keccak256 } from 'viem'
import { KIND } from './abi'
import { dangerousOpcodes } from './bytecode'
import type { RuleId } from './rules'
import { buildSimulation, type Check, type Evaluation, evaluateSimulation, ViewRevert } from './simulate'

export type RpcCall = { method: string; params: unknown[] }
/** Sends one JSON-RPC batch to provider `url` and returns the results in request order (throws on any error). */
export type RpcBatch = (url: string, calls: RpcCall[]) => unknown[]

/** The consensus value: deterministic on every honest DON node. */
export type Verdict = { verdict: 'pass' | 'veto'; rule: RuleId | null }

/** A verdict plus the detail that explains it (logged, never part of the consensus value or the evidence). */
export type Judgement = Verdict & {
  reason: string
  checks: Check[]
  culprits: Evaluation['culprits']
  /** R9 opcodes in the new code that the allowlist does not cover */
  flaggedOps: string[]
  probes: number
  selectors: number
  /** eth_simulateV1 requests per provider */
  requests: number
}

export type UpgradeContext = {
  proxy: Address
  newImpl: Address
  codehash: Hex
  hasInitData: boolean
  block: bigint
  holder: Address | null // the first configured holder with a positive balance at the proposal block, or null
  amount: bigint
  /** A second configured holder (never `holder`) with a balance, whose tokens fund the stranger; null/absent when none. */
  funder?: Address | null
  /** Tokens moved from `funder` to the stranger (<= the funder's balance at the proposal block). */
  fundAmount?: bigint
  holders: Address[]
  watch: Address[]
  stranger: Address
  receiver: Address
  strict: boolean
  codehashApproved: boolean
  dataApproved: boolean
  callGas: number
  readGas: number
  /** Simulated calls per eth_simulateV1 request. */
  maxCalls: number
  /** eth_simulateV1 requests per provider (default 2). */
  simRequests?: number
  /** R9 opcode names that do not veto (default none). */
  allowedOpcodes?: readonly string[]
}

export type ProviderOutcome =
  | {
      provider: string
      verdict: 'pass' | 'veto'
      rule: RuleId | null
      checks: Check[]
      culprits: Evaluation['culprits']
      flaggedOps: string[]
      probes: number
      selectors: number
      requests: number
    }
  | { provider: string; verdict: 'error'; error: string }

export const consensusValue = (j: Verdict): Verdict => ({ verdict: j.verdict, rule: j.rule })

const vetoJ = (rule: RuleId, reason: string, checks: Check[] = []): Judgement => ({
  verdict: 'veto',
  rule,
  reason,
  checks,
  culprits: [],
  flaggedOps: [],
  probes: 0,
  selectors: 0,
  requests: 0,
})
const passJ = (reason: string, checks: Check[] = []): Judgement => ({
  verdict: 'pass',
  rule: null,
  reason,
  checks,
  culprits: [],
  flaggedOps: [],
  probes: 0,
  selectors: 0,
  requests: 0,
})

/**
 * R7: a config change that weakens the airlock needs the approver's pre-approval of
 * keccak256(abi.encode(kind, target, value)) (read at the proposal block).
 *  - SetGuardian: always (adding one grants veto and breakGlass power, removing one drops a veto voice);
 *  - SetDelay: only a shorter delay;
 *  - SetPausedImpl: always (breakGlass switches to it with no cooldown).
 */
export function judgeConfig(p: { kind: number; target: Address; value: bigint }, currentDelay: bigint | null, approved: boolean): Judgement {
  let weakening = true
  let what: string
  if (p.kind === KIND.SetGuardian) what = p.value === 0n ? `remove guardian ${p.target}` : `add guardian ${p.target}`
  else if (p.kind === KIND.SetDelay) {
    if (currentDelay === null) throw new Error('SetDelay needs the current delay')
    weakening = p.value < currentDelay
    what = `delay ${currentDelay} -> ${p.value}`
  } else if (p.kind === KIND.SetPausedImpl) what = `paused impl -> ${p.target}`
  else throw new Error(`not a config proposal kind: ${p.kind}`)
  const ok = !weakening || approved
  const check: Check = { name: 'R7_CONFIG_GUARD', before: what, after: !weakening ? 'not weakening' : approved ? 'approved' : 'not approved', ok }
  return ok ? passJ(`config change: ${what} (${check.after})`, [check]) : vetoJ('R7_CONFIG_GUARD', `config change without approval: ${what}`, [check])
}

/** Upgrade rules that need no simulation. Returns null when the simulation must decide. */
export function staticUpgradeCheck(ctx: Pick<UpgradeContext, 'strict' | 'codehashApproved' | 'codehash' | 'hasInitData' | 'dataApproved' | 'holder'>): Judgement | null {
  if (ctx.strict && !ctx.codehashApproved) {
    return vetoJ('R5_STRICT_CODEHASH', 'strict mode: codehash not approved', [{ name: 'R5_STRICT_CODEHASH', before: ctx.codehash, after: 'not approved', ok: false }])
  }
  if (ctx.hasInitData && !ctx.dataApproved) {
    return vetoJ('R8_INIT_DATA', 'init data without codehash+data approval', [{ name: 'R8_INIT_DATA', before: 'init data', after: 'codehash+data not approved', ok: false }])
  }
  if (!ctx.holder) {
    return vetoJ('R6_SIM_FAILURE', 'no configured holder has a balance', [{ name: 'R6_SIM_FAILURE', before: 'holders', after: 'every configured holder has balance 0', ok: false }])
  }
  return null
}

/** R9: dangerous opcodes in `code` that `allowed` does not list. */
export const r9Flagged = (code: Hex, allowed: readonly string[] = []): string[] => {
  const ok = new Set(allowed)
  return dangerousOpcodes(code).filter((o) => !ok.has(o))
}

export function judgeOnProvider(rpc: RpcBatch, url: string, label: string, ctx: UpgradeContext): ProviderOutcome {
  const r6 = (before: string, after: string, probes = 0, selectors = 0): ProviderOutcome => ({
    provider: label,
    verdict: 'veto',
    rule: 'R6_SIM_FAILURE',
    checks: [{ name: 'R6_SIM_FAILURE', before, after, ok: false }],
    culprits: [],
    flaggedOps: [],
    probes,
    selectors,
    requests: 0,
  })
  try {
    const blockTag = `0x${ctx.block.toString(16)}`
    const [newCode] = rpc(url, [{ method: 'eth_getCode', params: [ctx.newImpl, blockTag] }]) as [Hex]
    if (!newCode || newCode === '0x' || keccak256(newCode) !== ctx.codehash.toLowerCase()) return r6(ctx.codehash, 'code missing or codehash mismatch')
    const { requests, layout } = buildSimulation({
      proxy: ctx.proxy,
      newImpl: ctx.newImpl,
      newCode,
      holder: ctx.holder as Address,
      amount: ctx.amount,
      funder: ctx.funder ?? null,
      fundAmount: ctx.fundAmount ?? 0n,
      holders: ctx.holders,
      watch: ctx.watch,
      stranger: ctx.stranger,
      receiver: ctx.receiver,
      block: ctx.block,
      callGas: ctx.callGas,
      readGas: ctx.readGas,
      maxCalls: ctx.maxCalls,
      maxRequests: ctx.simRequests ?? 2,
    })
    const fit = `${layout.probes} of ${layout.wantedProbes} probes fit in ${layout.chunks.length} request(s) of at most ${ctx.maxCalls} calls`
    // Too many probes: R6, unless the codehash is approved (then only this is excused; every other rule still runs).
    if (layout.truncated && !ctx.codehashApproved) return r6(`${layout.wantedProbes} probes needed`, `only ${fit}`, layout.probes, layout.selectors.length)
    const results = requests.map((params) => rpc(url, [{ method: 'eth_simulateV1', params }])[0])

    let ev: Evaluation
    try {
      ev = evaluateSimulation(results, layout)
    } catch (e) {
      if (e instanceof ViewRevert) return r6('view', e.message.slice(0, 160), layout.probes, layout.selectors.length)
      throw e
    }
    const flaggedOps = r9Flagged(newCode, ctx.allowedOpcodes)
    let { verdict, rule } = ev
    const checks = [...ev.checks]
    if (layout.truncated) checks.push({ name: 'R6_SIM_FAILURE', before: `${layout.wantedProbes} probes needed`, after: `${fit} (codehash approved)`, ok: true })
    if (verdict === 'pass' && flaggedOps.length) {
      const ok9 = ctx.codehashApproved
      const allowed = [...(ctx.allowedOpcodes ?? [])].sort().join(' ') || 'none'
      checks.push({ name: 'R9_NEW_OPCODES', before: `allowed: ${allowed}`, after: `found: ${flaggedOps.join(' ')}${ok9 ? ' (codehash approved)' : ''}`, ok: ok9 })
      if (!ok9) {
        verdict = 'veto'
        rule = 'R9_NEW_OPCODES'
      }
    }
    return { provider: label, verdict, rule, checks, culprits: ev.culprits, flaggedOps, probes: ev.probes, selectors: layout.selectors.length, requests: requests.length }
  } catch (e) {
    return { provider: label, verdict: 'error', error: (e as Error).message?.slice(0, 200) ?? String(e) }
  }
}

/** Every provider, then the quorum (no static rules: call staticUpgradeCheck first). */
export function simulateUpgrade(
  rpc: RpcBatch,
  providers: { url: string; label: string }[],
  minAgree: number,
  ctx: UpgradeContext,
): { judgement: Judgement; outcomes: ProviderOutcome[] } {
  const outcomes = providers.map((p) => judgeOnProvider(rpc, p.url, p.label, ctx))
  return { judgement: quorum(outcomes, minAgree), outcomes }
}

/** Static rules, then the simulation (for off-chain tools that judge an upgrade in one call). */
export function judgeUpgrade(
  rpc: RpcBatch,
  providers: { url: string; label: string }[],
  minAgree: number,
  ctx: UpgradeContext,
): { judgement: Judgement; outcomes: ProviderOutcome[] } {
  const s = staticUpgradeCheck(ctx)
  return s ? { judgement: s, outcomes: [] } : simulateUpgrade(rpc, providers, minAgree, ctx)
}

export function quorum(outcomes: ProviderOutcome[], minAgree: number): Judgement {
  // Every answered provider must agree, and at least `minAgree` must have answered. Honest providers simulate the
  // same code at the same pinned block, so any disagreement means a provider is wrong or lying: fail closed.
  // A single bad provider can therefore cause a veto (a delay), never a pass.
  const groups = new Map<string, Extract<ProviderOutcome, { verdict: 'pass' | 'veto' }>[]>()
  for (const o of outcomes) {
    if (o.verdict === 'error') continue
    const key = `${o.verdict}:${o.rule ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), o])
  }
  if (groups.size > 1) {
    return vetoJ('R6_SIM_FAILURE', 'providers disagree', [
      { name: 'R6_SIM_FAILURE', before: 'all answering providers must agree', after: [...groups.keys()].sort().join(' vs '), ok: false },
    ])
  }
  const best = [...groups.values()][0]
  if (!best || best.length < minAgree) {
    return vetoJ('R6_SIM_FAILURE', `fewer than ${minAgree} providers answered`, [
      { name: 'R6_SIM_FAILURE', before: `${minAgree} of ${outcomes.length} providers must answer`, after: 'not enough answers', ok: false },
    ])
  }
  const o = best[0]
  return {
    verdict: o.verdict,
    rule: o.rule,
    reason: `quorum of ${minAgree}`,
    checks: o.checks,
    culprits: o.culprits,
    flaggedOps: o.flaggedOps,
    probes: o.probes,
    selectors: o.selectors,
    requests: o.requests,
  }
}
