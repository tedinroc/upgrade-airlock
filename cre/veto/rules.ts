// Rule ids and ruleHash = keccak256(utf8("GUARD/<ID>")): the bytes32 a Veto report carries and AirlockAdmin's Vetoed
// event records. The war room derives the same hashes from the same ids (web/src/types.ts ruleHashOf), so the chain,
// the war room and the reports all read the same rule hashes.
import { type Hex, keccak256, stringToBytes } from 'viem'

export const RULE_IDS = [
  'R1_TOTAL_SUPPLY',
  'R2_OWNER',
  'R3_TRANSFER_CONSERVATION',
  'R4_TRANSFER_LIVENESS',
  'R5_STRICT_CODEHASH',
  'R6_SIM_FAILURE',
  'R7_CONFIG_GUARD',
  'R8_INIT_DATA',
  'R3B_THIRD_PARTY_FUNDS',
  'R9_NEW_OPCODES',
] as const
export type RuleId = (typeof RULE_IDS)[number]

export const ruleHash = (id: RuleId): Hex => keccak256(stringToBytes(`GUARD/${id}`))
