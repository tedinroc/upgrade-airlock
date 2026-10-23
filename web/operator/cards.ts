// The seven fixed actions the operator may launch on Ethereum Sepolia, one per attack card of the war room.
// They mirror scripts/sepolia/propose.sh exactly: an upgrade card calls AirlockAdmin.proposeUpgrade(<impl>, 0x) with
// the deployment's address for that card; remove-receiver calls proposeSetGuardian(<receiver>, false). Nothing else
// can be sent: the client names a card id, never an address or calldata.
// Plain data and viem encoding only (no node: imports), so the Vite dev server, the Cloudflare Pages Functions and
// the Node tests share it.
import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from 'viem'

/** In the order the war room's picker shows them */
export const CARD_IDS = ['evil-mint', 'evil-owner', 'evil-fee', 'evil-basefee', 'evil-drain', 'remove-receiver', 'v2'] as const
export type CardId = (typeof CARD_IDS)[number]

export const isCardId = (v: unknown): v is CardId => typeof v === 'string' && (CARD_IDS as readonly string[]).includes(v)

/** Implementation keys of the deployment (script/DeployEth.s.sol output) that a card upgrades to */
export type ImplKey = 'v2' | 'evilMint' | 'evilOwner' | 'evilFee' | 'evilBaseFee' | 'evilDrain'

/** card -> what it proposes (propose.sh: KEY=...) */
export const CARD_ACTION: Readonly<Record<CardId, { kind: 'upgrade'; impl: ImplKey } | { kind: 'remove-receiver' }>> = {
  'evil-mint': { kind: 'upgrade', impl: 'evilMint' },
  'evil-owner': { kind: 'upgrade', impl: 'evilOwner' },
  'evil-fee': { kind: 'upgrade', impl: 'evilFee' },
  'evil-basefee': { kind: 'upgrade', impl: 'evilBaseFee' },
  'evil-drain': { kind: 'upgrade', impl: 'evilDrain' },
  'remove-receiver': { kind: 'remove-receiver' },
  v2: { kind: 'upgrade', impl: 'v2' },
}

/** The public deployment data the operator needs (operator/deployment.generated.ts holds the Sepolia one) */
export interface OperatorDeployment {
  /** true while no deployment exists (the placeholder): the operator is off */
  pending: boolean
  chainId: number
  airlockAdmin: string
  /** the only account that may propose; the injected key must belong to it */
  owner: string
  /** the AirlockReceiver (the Chainlink CRE guardian) */
  receiver: string
  impls: Partial<Record<ImplKey, string>>
}

/** AirlockAdmin (src/AirlockAdmin.sol): the two proposals the cards send and the views the cooldown check reads */
export const OPERATOR_ABI = parseAbi([
  'function proposeUpgrade(address newImpl, bytes data) returns (uint256 id)',
  'function proposeSetGuardian(address guardian, bool enabled) returns (uint256 id)',
  'function nextId() view returns (uint256)',
  'struct Proposal { uint8 kind; uint8 status; address proposer; address target; uint256 value; bytes32 codehash; bytes32 dataHash; uint64 proposedBlock; uint64 readyBlock; uint256 vetoCount; }',
  'function getProposal(uint256 id) view returns (Proposal)',
])

const ZERO = '0x0000000000000000000000000000000000000000'
const usable = (a: string | undefined): a is string => !!a && isAddress(a, { strict: false }) && a.toLowerCase() !== ZERO

/** true when the deployment has the AirlockAdmin, the owner and the receiver */
export function deploymentUsable(d: OperatorDeployment): boolean {
  return !d.pending && d.chainId === 11155111 && usable(d.airlockAdmin) && usable(d.owner) && usable(d.receiver)
}

/** The address a card acts on in this deployment, or null when the deployment has none (it predates that card) */
export function cardTarget(card: CardId, d: OperatorDeployment): Address | null {
  const a = CARD_ACTION[card]
  const addr = a.kind === 'remove-receiver' ? d.receiver : d.impls[a.impl]
  return usable(addr) ? getAddress(addr) : null
}

/** The cards this deployment can launch, in picker order */
export function availableCards(d: OperatorDeployment): CardId[] {
  return deploymentUsable(d) ? CARD_IDS.filter((c) => cardTarget(c, d) !== null) : []
}

/** The exact transaction a card sends: to AirlockAdmin, with this calldata (null when the card is not available) */
export function buildAction(card: CardId, d: OperatorDeployment): { to: Address; data: Hex } | null {
  const target = deploymentUsable(d) ? cardTarget(card, d) : null
  if (!target) return null
  const a = CARD_ACTION[card]
  const data =
    a.kind === 'remove-receiver'
      ? encodeFunctionData({ abi: OPERATOR_ABI, functionName: 'proposeSetGuardian', args: [target, false] })
      : encodeFunctionData({ abi: OPERATOR_ABI, functionName: 'proposeUpgrade', args: [target, '0x'] })
  return { to: getAddress(d.airlockAdmin), data }
}
