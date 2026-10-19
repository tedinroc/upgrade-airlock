// Demo implementations, rule ids and small number helpers shared by the whole app.
import { keccak256, stringToBytes, type Hex } from 'viem'

/** Implementations deployed by script/DeployEth.s.sol that the page recognises by address */
export type CardId = 'evilMint' | 'evilOwner' | 'evilFee' | 'evilBaseFee' | 'evilDrain' | 'v2'
export type ImplName = CardId | 'v1' | 'paused'
export const IMPL_KEYS: readonly ImplName[] = ['v1', 'v2', 'evilMint', 'evilOwner', 'evilFee', 'evilBaseFee', 'evilDrain', 'paused']

export interface CardInfo {
  id: CardId
  /** Contract name (a proper noun, never translated) */
  name: string
  expect: 'veto' | 'pass'
  expectRule: RuleId | null
}

export const CARDS: CardInfo[] = [
  { id: 'evilMint', name: 'EvilMint', expect: 'veto', expectRule: 'R1_TOTAL_SUPPLY' },
  { id: 'evilOwner', name: 'EvilOwner', expect: 'veto', expectRule: 'R2_OWNER' },
  { id: 'evilFee', name: 'EvilFee', expect: 'veto', expectRule: 'R3_TRANSFER_CONSERVATION' },
  { id: 'evilBaseFee', name: 'EvilBaseFee', expect: 'veto', expectRule: 'R9_NEW_OPCODES' },
  { id: 'evilDrain', name: 'EvilDrain', expect: 'veto', expectRule: 'R3B_THIRD_PARTY_FUNDS' },
  { id: 'v2', name: 'DemoBTC v2', expect: 'pass', expectRule: null },
]

/** Rule ids of the CRE workflow; ruleHash = keccak256(utf8("GUARD/<ID>")), the bytes32 carried by Vetoed */
export const RULE_IDS = [
  'R1_TOTAL_SUPPLY',
  'R2_OWNER',
  'R3_TRANSFER_CONSERVATION',
  'R3B_THIRD_PARTY_FUNDS',
  'R4_TRANSFER_LIVENESS',
  'R5_STRICT_CODEHASH',
  'R6_SIM_FAILURE',
  'R7_CONFIG_GUARD',
  'R8_INIT_DATA',
  'R9_NEW_OPCODES',
] as const
export type RuleId = (typeof RULE_IDS)[number]

export const ruleHashOf = (id: string): Hex => keccak256(stringToBytes(`GUARD/${id}`))
/** ruleHash (lowercase) -> rule id */
export const RULE_BY_HASH = new Map<string, RuleId>(RULE_IDS.map((r) => [ruleHashOf(r).toLowerCase(), r]))

/** "R1_TOTAL_SUPPLY" -> "R1" */
export const ruleShort = (rule: string): string => rule.split('_')[0]

export function toNum(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null
  if (typeof x === 'number') return Number.isFinite(x) ? x : null
  if (typeof x === 'bigint') return Number(x)
  if (typeof x === 'string') {
    const n = x.startsWith('0x') ? parseInt(x, 16) : Number(x)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function toBig(x: unknown): bigint | null {
  try {
    if (x === null || x === undefined || x === '') return null
    if (typeof x === 'bigint') return x
    if (typeof x === 'number') return BigInt(Math.round(x))
    if (typeof x === 'string') return BigInt(x)
  } catch {
    return null
  }
  return null
}

export const ZERO32 = ('0x' + '00'.repeat(32)) as Hex
export const isZero32 = (h: string | null | undefined): boolean => !h || /^0x0*$/i.test(h)
