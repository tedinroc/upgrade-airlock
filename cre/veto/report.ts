// Verdict report + attestation + evidence. Byte-for-byte contract with src/cre/AirlockReceiver.sol and
// src/AirlockAdmin.sol:
//
//   report         = abi.encode(uint8 action, uint256 proposalId, bytes32 proposalDigest, bytes32 ruleHash,
//                               bytes32 evidenceHash, uint64 validUntilBlock, bytes signature)
//                    action 0 = Veto (ruleHash = the broken rule), 1 = Clear (ruleHash = 0)
//   signature      = 65 bytes r||s||v (v in {27,28}, low-s) by the attester over the EIP-712 digest of
//                    Verdict(address airlockAdmin,uint8 action,uint256 proposalId,bytes32 proposalDigest,
//                            bytes32 ruleHash,bytes32 evidenceHash,uint64 validUntilBlock)
//                    domain { name: "AirlockReceiver", version: "1", chainId, verifyingContract: receiver }
//   proposalDigest = keccak256(abi.encode(uint8 kind, address target, uint256 value, bytes32 codehash,
//                                         bytes32 dataHash, uint64 proposedBlock))   (AirlockAdmin.proposalDigest)
//   evidenceHash   = keccak256(utf8(canonical evidence JSON)): the proposal, its digest, the verdict and the rule,
//                    with sorted keys, so anyone can recompute it from chain data alone.
//
// Pure JS (viem + @noble/curves): runs unchanged in Bun tests and in the CRE WASM (QuickJS) runtime.
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  type Address,
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseAbiParameters,
  stringToBytes,
} from 'viem'
import { ACTION, ZERO_HASH } from './abi'
import type { Verdict } from './judge'
import { type RuleId, ruleHash } from './rules'

export type Action = (typeof ACTION)[keyof typeof ACTION]

export type VerdictBody = {
  action: Action
  proposalId: bigint
  proposalDigest: Hex
  ruleHash: Hex
  evidenceHash: Hex
  validUntilBlock: bigint
}

/** The on-chain proposal fields a verdict is about (AirlockAdmin.getProposal minus the mutable status/vetoCount). */
export type ProposalFields = {
  id: bigint
  kind: number
  proposer: Address
  target: Address
  value: bigint
  codehash: Hex
  dataHash: Hex
  proposedBlock: bigint
  readyBlock: bigint
}

export const VERDICT_TYPE =
  'Verdict(address airlockAdmin,uint8 action,uint256 proposalId,bytes32 proposalDigest,bytes32 ruleHash,bytes32 evidenceHash,uint64 validUntilBlock)'

export const VERDICT_TYPES = {
  Verdict: [
    { name: 'airlockAdmin', type: 'address' },
    { name: 'action', type: 'uint8' },
    { name: 'proposalId', type: 'uint256' },
    { name: 'proposalDigest', type: 'bytes32' },
    { name: 'ruleHash', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'validUntilBlock', type: 'uint64' },
  ],
} as const

/** Equals AirlockReceiver.verdictDigest(action, proposalId, proposalDigest, ruleHash, evidenceHash, validUntilBlock). */
export const verdictDigest = (chainId: bigint, receiver: Address, airlockAdmin: Address, b: VerdictBody): Hex =>
  hashTypedData({
    domain: { name: 'AirlockReceiver', version: '1', chainId, verifyingContract: receiver },
    types: VERDICT_TYPES,
    primaryType: 'Verdict',
    message: { airlockAdmin, ...b },
  })

/** Equals AirlockAdmin.proposalDigest(id). */
export const proposalDigest = (p: Pick<ProposalFields, 'kind' | 'target' | 'value' | 'codehash' | 'dataHash' | 'proposedBlock'>): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('uint8 kind, address target, uint256 value, bytes32 codehash, bytes32 dataHash, uint64 proposedBlock'), [
      p.kind,
      p.target,
      p.value,
      p.codehash,
      p.dataHash,
      p.proposedBlock,
    ]),
  )

/** Deterministic (RFC 6979) low-s secp256k1 signature, r||s||v with v = 27/28. Synchronous: QuickJS-safe. */
export const signDigest = (privateKey: Hex, digest: Hex): Hex => {
  const sig = secp256k1.sign(hexToBytes(digest), hexToBytes(privateKey), { lowS: true })
  const out = new Uint8Array(65)
  out.set(sig.toCompactRawBytes(), 0)
  out[64] = 27 + sig.recovery
  return bytesToHex(out)
}

export const REPORT_PARAMS = parseAbiParameters(
  'uint8 action, uint256 proposalId, bytes32 proposalDigest, bytes32 ruleHash, bytes32 evidenceHash, uint64 validUntilBlock, bytes signature',
)

export const encodeReport = (b: VerdictBody, signature: Hex): Hex => {
  if ((signature.length - 2) / 2 !== 65) throw new Error('signature must be 65 bytes')
  return encodeAbiParameters(REPORT_PARAMS, [b.action, b.proposalId, b.proposalDigest, b.ruleHash, b.evidenceHash, b.validUntilBlock, signature])
}

export const decodeReport = (payload: Hex): VerdictBody & { signature: Hex } => {
  const [action, proposalId, digest, rule, evidenceHash, validUntilBlock, signature] = decodeAbiParameters(REPORT_PARAMS, payload)
  return { action: action as Action, proposalId, proposalDigest: digest, ruleHash: rule, evidenceHash, validUntilBlock, signature }
}

export const buildSignedReport = (
  attesterKey: Hex,
  chainId: bigint,
  receiver: Address,
  airlockAdmin: Address,
  b: VerdictBody,
): { digest: Hex; signature: Hex; payload: Hex } => {
  if (b.action === ACTION.Clear && b.ruleHash !== ZERO_HASH) throw new Error('a Clear carries no rule')
  if (b.action === ACTION.Veto && b.ruleHash === ZERO_HASH) throw new Error('a Veto needs a rule')
  const digest = verdictDigest(chainId, receiver, airlockAdmin, b)
  const signature = signDigest(attesterKey, digest)
  return { digest, signature, payload: encodeReport(b, signature) }
}

/** Report action and ruleHash for a verdict: pass -> Clear (no rule), veto -> Veto (the broken rule). */
export const actionOf = (v: Verdict): { action: Action; ruleHash: Hex } =>
  v.verdict === 'pass' ? { action: ACTION.Clear, ruleHash: ZERO_HASH } : { action: ACTION.Veto, ruleHash: ruleHash(v.rule as RuleId) }

/**
 * Canonical evidence JSON: the proposal fields, its digest and the DON-agreed verdict, with sorted keys. Everything
 * in it is on-chain (getProposal) or in the report, so anyone can recompute the hash the receiver records.
 */
export const canonicalEvidence = (e: { chainId: bigint; airlockAdmin: Address; proposal: ProposalFields; proposalDigest: Hex; verdict: Verdict }): string =>
  stableStringify({
    schema: 'upgrade-airlock/evidence-v2',
    chainId: e.chainId.toString(),
    airlockAdmin: e.airlockAdmin.toLowerCase(),
    proposalId: e.proposal.id.toString(),
    kind: e.proposal.kind,
    proposer: e.proposal.proposer.toLowerCase(),
    target: e.proposal.target.toLowerCase(),
    value: e.proposal.value.toString(),
    codehash: e.proposal.codehash.toLowerCase(),
    dataHash: e.proposal.dataHash.toLowerCase(),
    proposedBlock: e.proposal.proposedBlock.toString(),
    readyBlock: e.proposal.readyBlock.toString(),
    proposalDigest: e.proposalDigest.toLowerCase(),
    verdict: e.verdict.verdict,
    rule: e.verdict.rule,
  })

export const evidenceHashOf = (canonical: string): Hex => keccak256(stringToBytes(canonical))

/** JSON with object keys sorted at every level (arrays keep their order). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`
}
