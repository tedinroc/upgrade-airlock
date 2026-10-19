// Recomputes every AirlockReceiver verdict's evidenceHash from chain data alone: AirlockAdmin.getProposal(id) plus
// the action and rule in the receiver's Verdict event. Prints one line per verdict; exits 1 on any mismatch.
//
//   bun tools/check-evidence.ts <rpc-url> <deployment.json>
//
// The deployment JSON is the one script/DeployEth.s.sol writes (chainId, startBlock, airlockAdmin, receiver).
import { type Address, createPublicClient, type Hex, http } from 'viem'
import { ACTION, AIRLOCK_ADMIN_ABI, RECEIVER_ABI } from '../abi'
import { canonicalEvidence, evidenceHashOf, proposalDigest } from '../report'
import { RULE_IDS, type RuleId, ruleHash } from '../rules'

const [rpc, file] = process.argv.slice(2)
if (!rpc || !file) {
  console.error('usage: bun tools/check-evidence.ts <rpc-url> <deployment.json>')
  process.exit(2)
}
const d = (await Bun.file(file).json()) as { chainId: number; startBlock: number; airlockAdmin: Address; receiver: Address }
const client = createPublicClient({ transport: http(rpc) })
const byHash = new Map(RULE_IDS.map((r) => [ruleHash(r), r]))

const logs = await client.getContractEvents({ address: d.receiver, abi: RECEIVER_ABI, eventName: 'Verdict', fromBlock: BigInt(d.startBlock), toBlock: 'latest' })
let bad = 0
for (const log of logs) {
  const { proposalId, action, ruleHash: rh, evidenceHash } = log.args as { proposalId: bigint; action: number; ruleHash: Hex; evidenceHash: Hex }
  const g = await client.readContract({ address: d.airlockAdmin, abi: AIRLOCK_ADMIN_ABI, functionName: 'getProposal', args: [proposalId] })
  const proposal = {
    id: proposalId,
    kind: Number(g.kind),
    proposer: g.proposer,
    target: g.target,
    value: g.value,
    codehash: g.codehash,
    dataHash: g.dataHash,
    proposedBlock: BigInt(g.proposedBlock),
    readyBlock: BigInt(g.readyBlock),
  }
  const rule: RuleId | null = action === ACTION.Clear ? null : (byHash.get(rh) ?? null)
  const evidence = canonicalEvidence({
    chainId: BigInt(d.chainId),
    airlockAdmin: d.airlockAdmin,
    proposal,
    proposalDigest: proposalDigest(proposal),
    verdict: { verdict: action === ACTION.Clear ? 'pass' : 'veto', rule },
  })
  const ok = evidenceHashOf(evidence) === evidenceHash.toLowerCase()
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} #${proposalId} ${action === ACTION.Clear ? 'Clear' : `Veto ${rule ?? rh}`} evidence ${evidenceHash}${ok ? ' recomputed from getProposal' : ` != ${evidenceHashOf(evidence)}`}`)
}
console.log(`${logs.length} verdict(s), ${bad} mismatch(es)`)
process.exit(bad ? 1 : 0)
