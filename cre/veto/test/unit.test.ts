import { describe, expect, test } from 'bun:test'
import { type Address, encodeAbiParameters, encodeFunctionResult, type Hex, keccak256, parseAbiParameters, recoverAddress, stringToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ACTION, AIRLOCK_ADMIN_ABI, EMPTY_DATA_HASH, KIND, MULTICALL3_ABI, ZERO_HASH } from '../abi'
import { dangerousOpcodes } from '../bytecode'
import { aggregate3RequestBytes, aggregate3ResponseBytes, chunkReads, decodeAggregate3, encodeAggregate3, READ_PAYLOAD_BYTES, type Read, readCost } from '../chain'
import { configSchema } from '../config'
import { judgeConfig, type ProviderOutcome, quorum, staticUpgradeCheck } from '../judge'
import { actionHash, upgradeDataKey } from '../keys'
import { actionOf, buildSignedReport, canonicalEvidence, decodeReport, evidenceHashOf, proposalDigest, stableStringify, VERDICT_TYPE, verdictDigest } from '../report'
import { RULE_IDS, ruleHash } from '../rules'
import { buildSimulation, fallbackCalldata, proposalActors } from '../simulate'
import { utf8ToBase64 } from '../workflow'

const pass = (p: string): ProviderOutcome => ({ provider: p, verdict: 'pass', rule: null, checks: [], culprits: [], flaggedOps: [], probes: 10, selectors: 2, requests: 1 })
const veto = (p: string, rule: 'R1_TOTAL_SUPPLY' | 'R2_OWNER'): ProviderOutcome => ({
  provider: p,
  verdict: 'veto',
  rule,
  checks: [{ name: rule, before: 'a', after: 'b', ok: false }],
  culprits: [],
  flaggedOps: [],
  probes: 10,
  selectors: 2,
  requests: 1,
})
const err = (p: string): ProviderOutcome => ({ provider: p, verdict: 'error', error: 'timeout' })

describe('quorum (at least minAgree answers, all equal)', () => {
  test('unanimous veto keeps the rule', () => expect(quorum([veto('a', 'R1_TOTAL_SUPPLY'), veto('b', 'R1_TOTAL_SUPPLY'), veto('c', 'R1_TOTAL_SUPPLY')], 2).rule).toBe('R1_TOTAL_SUPPLY'))
  test('one provider down still decides', () => expect(quorum([pass('a'), err('b'), pass('c')], 2).verdict).toBe('pass'))
  test('two of four down still decides', () => expect(quorum([pass('a'), err('b'), err('c'), pass('d')], 2).verdict).toBe('pass'))
  test('a lone dissenting veto fails closed (R6), never a pass', () => {
    const v = quorum([pass('a'), pass('b'), veto('c', 'R1_TOTAL_SUPPLY')], 2)
    expect([v.verdict, v.rule]).toEqual(['veto', 'R6_SIM_FAILURE'])
  })
  test('a lone dissenting pass cannot override vetoes', () => {
    const v = quorum([veto('a', 'R1_TOTAL_SUPPLY'), veto('b', 'R1_TOTAL_SUPPLY'), pass('c')], 2)
    expect([v.verdict, v.rule]).toEqual(['veto', 'R6_SIM_FAILURE'])
  })
  test('a 2-2 split fails closed (R6)', () => {
    const v = quorum([pass('a'), pass('b'), veto('c', 'R1_TOTAL_SUPPLY'), veto('d', 'R1_TOTAL_SUPPLY')], 2)
    expect([v.verdict, v.rule]).toEqual(['veto', 'R6_SIM_FAILURE'])
  })
  test('one answer is not enough (R6)', () => expect(quorum([pass('a'), err('b'), err('c')], 2).rule).toBe('R6_SIM_FAILURE'))
  test('all providers down fail closed (R6)', () => expect(quorum([err('a'), err('b'), err('c')], 2).rule).toBe('R6_SIM_FAILURE'))
  test('different veto rules fail closed (R6)', () => expect(quorum([veto('a', 'R1_TOTAL_SUPPLY'), veto('b', 'R2_OWNER'), err('c')], 2).rule).toBe('R6_SIM_FAILURE'))
})

describe('R7 config guard', () => {
  const t = '0x1111111111111111111111111111111111111111' as Address
  test('removing a guardian without approval is vetoed', () => expect(judgeConfig({ kind: KIND.SetGuardian, target: t, value: 0n }, null, false).rule).toBe('R7_CONFIG_GUARD'))
  test('adding a guardian also needs approval', () => expect(judgeConfig({ kind: KIND.SetGuardian, target: t, value: 1n }, null, false).verdict).toBe('veto'))
  test('an approved guardian change passes', () => expect(judgeConfig({ kind: KIND.SetGuardian, target: t, value: 0n }, null, true).verdict).toBe('pass'))
  test('a longer delay is not weakening', () => expect(judgeConfig({ kind: KIND.SetDelay, target: '0x0000000000000000000000000000000000000000', value: 30n }, 25n, false).verdict).toBe('pass'))
  test('a shorter delay needs approval', () => expect(judgeConfig({ kind: KIND.SetDelay, target: '0x0000000000000000000000000000000000000000', value: 20n }, 25n, false).rule).toBe('R7_CONFIG_GUARD'))
  test('a new paused impl needs approval', () => expect(judgeConfig({ kind: KIND.SetPausedImpl, target: t, value: 0n }, null, false).rule).toBe('R7_CONFIG_GUARD'))
  test('approval keys', () => {
    expect(actionHash(KIND.SetGuardian, t, 0n)).toBe(keccak256(encodeAbiParameters(parseAbiParameters('uint8, address, uint256'), [1, t, 0n])))
    const data = '0x12345678' as Hex
    expect(upgradeDataKey(keccak256('0x01'), keccak256(data))).toBe(keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [keccak256('0x01'), keccak256(data)])))
  })
})

describe('static upgrade rules', () => {
  const base = { strict: false, codehash: keccak256('0x01'), codehashApproved: false, hasInitData: false, dataApproved: false, holder: '0x1111111111111111111111111111111111111111' as Address }
  test('nothing static: the simulation decides', () => expect(staticUpgradeCheck(base)).toBeNull())
  test('strict mode needs an approved codehash (R5)', () => expect(staticUpgradeCheck({ ...base, strict: true })?.rule).toBe('R5_STRICT_CODEHASH'))
  test('init data needs a codehash+data approval (R8)', () => expect(staticUpgradeCheck({ ...base, hasInitData: true })?.rule).toBe('R8_INIT_DATA'))
  test('approved init data goes to the simulation', () => expect(staticUpgradeCheck({ ...base, hasInitData: true, dataApproved: true })).toBeNull())
  test('no funded holder fails closed (R6)', () => expect(staticUpgradeCheck({ ...base, holder: null })?.rule).toBe('R6_SIM_FAILURE'))
  test('empty init data hash', () => expect(EMPTY_DATA_HASH).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'))
})

describe('R9 opcodes', () => {
  test('block and fee context opcodes are flagged', () => {
    // BASEFEE GASPRICE BLOBBASEFEE BLOBHASH GASLIMIT STOP
    expect(dangerousOpcodes('0x483a4a494500')).toEqual(['BASEFEE', 'BLOBBASEFEE', 'BLOBHASH', 'GASLIMIT', 'GASPRICE'])
  })
  test('PUSH data is not an opcode', () => expect(dangerousOpcodes('0x6048604560480000')).toEqual([]))
  test('a trailing length that is not an exact solc CBOR map is not skipped (the old fake tail is now scanned)', () => {
    // STOP, then 0xa2 0x48 0x49 0x44 and a "length" 0x0004: not a solc map, so BASEFEE BLOBHASH PREVRANDAO count
    expect(dangerousOpcodes('0x00a24849440004')).toEqual(['BASEFEE', 'BLOBHASH', 'PREVRANDAO'])
  })
})

describe('simulation layout', () => {
  test('every configured holder is watched', () => {
    const holders = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3'] as Address[]
    const { layout } = buildSimulation({
      proxy: '0x00000000000000000000000000000000000000b1',
      newImpl: '0x00000000000000000000000000000000000000b2',
      newCode: '0x00',
      holder: holders[1],
      amount: 1n,
      holders,
      watch: ['0x00000000000000000000000000000000000000c1'],
      stranger: '0x00000000000000000000000000000000000000d1',
      receiver: '0x00000000000000000000000000000000000000d2',
      block: 1n,
      callGas: 1,
      readGas: 1,
      maxCalls: 150,
      maxRequests: 2,
    })
    for (const h of holders) expect(layout.watchList).toContain(h)
    expect(layout.watchList).toContain('0x00000000000000000000000000000000000000c1')
    expect(layout.watchList).toContain('0x00000000000000000000000000000000000000d2')
  })
})

describe('report, digest and attestation', () => {
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex // anvil #1, public
  const receiver = '0x81e8CcAfe8a0C69b17EBdF6a767423Be99D92544' as Address
  const admin = '0x3d8559f13a4392E8e6f58A6c7143256193cbDEEa' as Address
  const body = { action: ACTION.Veto, proposalId: 7n, proposalDigest: keccak256('0x07'), ruleHash: ruleHash('R1_TOTAL_SUPPLY'), evidenceHash: keccak256('0x01'), validUntilBlock: 123n }

  test('typehash matches AirlockReceiver.VERDICT_TYPEHASH', () => {
    expect(keccak256(stringToBytes(VERDICT_TYPE))).toBe('0xf69c38ff50cd566c526626b8d004b69b911f6ebecce91e7bace3c494dd31665a')
  })
  test('signature recovers to the attester and the payload round-trips', async () => {
    const s = buildSignedReport(key, 11155111n, receiver, admin, body)
    expect(await recoverAddress({ hash: s.digest, signature: s.signature })).toBe(privateKeyToAccount(key).address)
    const d = decodeReport(s.payload)
    expect([d.action, d.proposalId, d.proposalDigest, d.ruleHash, d.evidenceHash, d.validUntilBlock, d.signature]).toEqual([0, 7n, body.proposalDigest, body.ruleHash, body.evidenceHash, 123n, s.signature])
  })
  test('digest is bound to chain, receiver, airlockAdmin, action and proposal content', () => {
    const base = verdictDigest(11155111n, receiver, admin, body)
    expect(verdictDigest(1n, receiver, admin, body)).not.toBe(base)
    expect(verdictDigest(11155111n, admin, admin, body)).not.toBe(base)
    expect(verdictDigest(11155111n, receiver, receiver, body)).not.toBe(base)
    expect(verdictDigest(11155111n, receiver, admin, { ...body, action: ACTION.Clear, ruleHash: ZERO_HASH })).not.toBe(base)
    expect(verdictDigest(11155111n, receiver, admin, { ...body, proposalDigest: keccak256('0x08') })).not.toBe(base)
  })
  test('a Clear carries no rule and a Veto needs one', () => {
    expect(() => buildSignedReport(key, 1n, receiver, admin, { ...body, action: ACTION.Clear })).toThrow()
    expect(() => buildSignedReport(key, 1n, receiver, admin, { ...body, ruleHash: ZERO_HASH })).toThrow()
    expect(actionOf({ verdict: 'pass', rule: null })).toEqual({ action: ACTION.Clear, ruleHash: ZERO_HASH })
    expect(actionOf({ verdict: 'veto', rule: 'R7_CONFIG_GUARD' })).toEqual({ action: ACTION.Veto, ruleHash: ruleHash('R7_CONFIG_GUARD') })
  })
  test('proposalDigest = keccak256(abi.encode(kind, target, value, codehash, dataHash, proposedBlock))', () => {
    const p = { kind: 0, target: receiver, value: 0n, codehash: keccak256('0x01'), dataHash: EMPTY_DATA_HASH, proposedBlock: 9_000_000n }
    const manual = keccak256(
      encodeAbiParameters(parseAbiParameters('uint8, address, uint256, bytes32, bytes32, uint64'), [0, receiver, 0n, p.codehash, p.dataHash, p.proposedBlock]),
    )
    expect(proposalDigest(p)).toBe(manual)
    expect(proposalDigest({ ...p, proposedBlock: 9_000_001n })).not.toBe(manual)
  })
  test('rule hashes are keccak256("GUARD/<ID>") for all ten rules, pinned (the war room derives the same values)', () => {
    for (const id of RULE_IDS) expect(ruleHash(id)).toBe(keccak256(stringToBytes(`GUARD/${id}`)))
    expect(RULE_IDS.length).toBe(10)
    expect(ruleHash('R1_TOTAL_SUPPLY')).toBe('0x2d882812e0d4af193fbd76c9ccddcbb70bac4eda3768abe4fe59cd4adb9e653f')
    expect(ruleHash('R2_OWNER')).toBe('0x1391a3353c21683826f9e1baca10ec6ea865cbb0c2fccc79ca2576ff7b3fff5c')
    expect(ruleHash('R9_NEW_OPCODES')).toBe('0x766e11dc2c5f99690e801f33107e733cccfe7ba712f5a72ab95d4020fbeb2b87')
  })
  test('evidence is canonical and carries only proposal fields, digest, verdict and rule', () => {
    const proposal = { id: 3n, kind: 0, proposer: admin, target: receiver, value: 0n, codehash: keccak256('0x01'), dataHash: EMPTY_DATA_HASH, proposedBlock: 10n, readyBlock: 35n }
    const e = canonicalEvidence({ chainId: 11155111n, airlockAdmin: admin, proposal, proposalDigest: proposalDigest(proposal), verdict: { verdict: 'veto', rule: 'R9_NEW_OPCODES' } })
    const o = JSON.parse(e)
    expect(Object.keys(o)).toEqual([...Object.keys(o)].sort())
    expect(Object.keys(o).sort()).toEqual(
      ['airlockAdmin', 'chainId', 'codehash', 'dataHash', 'kind', 'proposalDigest', 'proposalId', 'proposedBlock', 'proposer', 'readyBlock', 'rule', 'schema', 'target', 'value', 'verdict'].sort(),
    )
    expect(o.rule).toBe('R9_NEW_OPCODES')
    expect(o.airlockAdmin).toBe(admin.toLowerCase())
    expect(evidenceHashOf(e)).toBe(keccak256(stringToBytes(e)))
  })
})

describe('batched reads', () => {
  const getP = (id: bigint): Read => ({ to: '0x00000000000000000000000000000000000000aa', data: `0x5f5f5f5f${id.toString(16).padStart(64, '0')}` as Hex, ret: 320 })
  const word = (id: bigint): Read => ({ to: '0x00000000000000000000000000000000000000aa', data: `0x6507f7cb${id.toString(16).padStart(64, '0')}` as Hex, ret: 32 })
  test('a 20-proposal scan splits into chunks that each fit the payload limit', () => {
    const calls = Array.from({ length: 20 }, (_, i) => [getP(BigInt(i + 1)), word(BigInt(i + 1))]).flat()
    const chunks = chunkReads(calls)
    expect(chunks.flat()).toEqual(calls)
    for (const c of chunks) {
      expect(aggregate3RequestBytes(c)).toBeLessThanOrEqual(READ_PAYLOAD_BYTES)
      expect(aggregate3ResponseBytes(c)).toBeLessThanOrEqual(READ_PAYLOAD_BYTES)
    }
    expect(chunks.length).toBe(4)
  })
  test('request size estimate equals the real aggregate3 calldata', () => {
    const calls = [getP(1n), word(1n), word(2n)]
    expect(aggregate3RequestBytes(calls)).toBe((encodeAggregate3(calls).length - 2) / 2)
  })
  test('response size estimate equals the real aggregate3 return data', () => {
    const rets = [`0x${'11'.repeat(320)}`, `0x${'22'.repeat(32)}`] as Hex[]
    const enc = encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: rets.map((r) => ({ success: true, returnData: r })) })
    expect(aggregate3ResponseBytes([getP(1n), word(1n)])).toBe((enc.length - 2) / 2)
    expect(decodeAggregate3(enc, 2)).toEqual(rets)
  })
  test('a failed call inside the batch throws', () => {
    const enc = encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [{ success: false, returnData: '0x' }] })
    expect(() => decodeAggregate3(enc, 1)).toThrow()
  })
  test('one call costs one read', () => expect(readCost([word(1n)])).toBe(1))
  test('ABI selectors match the deployed AirlockAdmin', () => {
    const sel = (fn: 'clearanceOf' | 'proposalDigest') => AIRLOCK_ADMIN_ABI.find((x) => x.type === 'function' && x.name === fn)
    expect(sel('clearanceOf')).toBeDefined()
    expect(keccak256(stringToBytes('clearanceOf(uint256)')).slice(0, 10)).toBe('0x6507f7cb')
    expect(keccak256(stringToBytes('proposalDigest(uint256)')).slice(0, 10)).toBe('0xa1a5b7cb')
  })
})

describe('config', () => {
  const ok = {
    chainSelectorName: 'ethereum-testnet-sepolia',
    chainId: 11155111,
    airlockAdmin: '0x1111111111111111111111111111111111111111',
    receiver: '0x2222222222222222222222222222222222222222',
    proxy: '0x3333333333333333333333333333333333333333',
    holders: ['0x4444444444444444444444444444444444444444'],
    rpcs: [
      { url: 'https://a.example', label: 'a' },
      { url: 'https://b.example', label: 'b' },
    ],
    minAgree: 2,
  }
  test('defaults', () => {
    const c = configSchema.parse(ok)
    expect([c.logConfidence, c.sweepSchedule, c.sweepWindow, c.multicall]).toEqual(['LATEST', '0 * * * * *', 20, '0xcA11bde05977b3631167028862bE2a173976CA11'])
  })
  test('only LATEST confidence is accepted', () => {
    expect(configSchema.safeParse({ ...ok, logConfidence: 'FINALIZED' }).success).toBe(false)
    expect(configSchema.safeParse({ ...ok, logConfidence: 'SAFE' }).success).toBe(false)
  })
  test('the quorum must be reachable', () => expect(configSchema.safeParse({ ...ok, minAgree: 3 }).success).toBe(false))
  test('provider labels are unique', () => expect(configSchema.safeParse({ ...ok, rpcs: [ok.rpcs[0], { ...ok.rpcs[1], label: 'a' }] }).success).toBe(false))
  test('a cron schedule has 5 or 6 fields', () => {
    expect(configSchema.safeParse({ ...ok, sweepSchedule: '*/30 * * * * *' }).success).toBe(true)
    expect(configSchema.safeParse({ ...ok, sweepSchedule: 'every minute' }).success).toBe(false)
  })
})

describe('determinism helpers', () => {
  test('actors depend on the proposal only', () => {
    const a = proposalActors(11155111n, '0x3d8559f13a4392E8e6f58A6c7143256193cbDEEa', 1n, keccak256('0x02'))
    const b = proposalActors(11155111n, '0x3d8559f13a4392E8e6f58A6c7143256193cbDEEa', 1n, keccak256('0x02'))
    const c = proposalActors(11155111n, '0x3d8559f13a4392E8e6f58A6c7143256193cbDEEa', 2n, keccak256('0x02'))
    const d = proposalActors(11155111n, '0x3d8559f13a4392E8e6f58A6c7143256193cbDEEa', 1n, keccak256('0x03'))
    expect(a).toEqual(b)
    expect(a.stranger).not.toBe(c.stranger)
    expect(a.stranger).not.toBe(d.stranger)
    expect(a.stranger).not.toBe(a.receiver)
  })
  test('fallback probe never reuses a known selector', () => {
    const s = '0x1111111111111111111111111111111111111111' as Address
    const first = fallbackCalldata(s, [])[1].data.slice(0, 10)
    expect(fallbackCalldata(s, [first])[1].data.slice(0, 10)).not.toBe(first)
  })
  test('base64 matches the reference encoder', () => {
    for (const s of ['', 'a', 'ab', 'abc', '{"jsonrpc":"2.0","method":"eth_simulateV1"}', '中文 ✓']) {
      expect(utf8ToBase64(s)).toBe(Buffer.from(s, 'utf8').toString('base64'))
    }
  })
  test('stableStringify sorts keys at every level', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}')
  })
})
