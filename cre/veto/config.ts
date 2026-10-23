import { z } from 'zod'
import { MULTICALL3_ADDRESS } from './abi'
import { DANGEROUS_OPCODE_NAMES } from './bytecode'
import { LIMITS } from './chain'

/**
 * Largest sweepWindow. A sweep costs 2 ChainReads (latest header, nextId), the scan of the window (getProposal,
 * clearanceOf and oracleJudged per id, batched: 6 reads for 30 ids, 8 for 40, 16 for 79), then 3 per upgrade and 2
 * per config change it judges, out of 15. At 30, 2 + 6 = 8 leaves 7: an upgrade and two config changes in every
 * run, with room to spare. test/airlock.test.ts recomputes it.
 */
export const MAX_SWEEP_WINDOW = 30

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const configSchema = z
  .object({
    chainSelectorName: z.string(), // e.g. "ethereum-testnet-sepolia"
    chainId: z.number().int().positive(), // 11155111 for Sepolia (the EIP-712 domain of the receiver)
    airlockAdmin: address,
    /** AirlockReceiver: AirlockAdmin's clearance oracle and one of its guardians. */
    receiver: address,
    proxy: address,
    /** Token holders. All of them are watched in the simulation; the first with a balance makes the R3/R4 transfer. */
    holders: z.array(address).min(1).max(8),
    /** Extra addresses whose balances must not move (e.g. the token owner). */
    watch: z.array(address).max(8).default([]),
    /** Independent RPC providers for the attack simulation (each must support eth_simulateV1 + batch requests). */
    // regex, not z.string().url(): zod's url check relies on the URL global, which the CRE (QuickJS) runtime lacks
    rpcs: z.array(z.object({ url: z.string().regex(/^https?:\/\/[^\s]+$/), label: z.string().min(1) })).min(1).max(5),
    minAgree: z.number().int().positive(),
    strict: z.boolean().default(false),
    callGas: z.number().int().positive().default(1_000_000),
    readGas: z.number().int().positive().default(200_000),
    /** Simulated calls per eth_simulateV1 request (each request also stays under the HTTP request size limit). */
    maxCalls: z.number().int().min(80).max(400).default(250),
    /**
     * eth_simulateV1 requests per provider and proposal when the probes do not fit in one. Every provider costs
     * 1 + simRequests HTTP calls (eth_getCode first), within the 15 per run: 2 allows up to 5 providers.
     */
    simRequests: z.number().int().min(1).max(4).default(2),
    /**
     * R9 opcodes that do not veto an upgrade (names as in bytecode.ts DANGEROUS_OPCODES, e.g. "STATICCALL"). Default
     * none: any such opcode in the new code vetoes unless its codehash is approved.
     */
    allowedOpcodes: z.array(z.enum(DANGEROUS_OPCODE_NAMES)).max(DANGEROUS_OPCODE_NAMES.length).default([]),
    /**
     * Gas limit for the forwarder -> receiver.onReport -> AirlockAdmin.veto + attachReason / clear path. A Veto report
     * used up to about 524k gas in the fork end-to-end run, a Clear about 397k: the default leaves room for both.
     */
    gasLimit: z.string().regex(/^\d+$/).default('2000000'),
    /** A verdict is accepted on-chain until max(readyBlock, current block) + this many blocks (no clock involved). */
    reportGraceBlocks: z.number().int().nonnegative().default(50),
    /** The log trigger only runs at LATEST: a proposal is judged in the block it appears, long before readyBlock. */
    logConfidence: z.literal('LATEST').default('LATEST'),
    /** Sweeper cron schedule (6 fields with seconds, or 5). CRE's fastest allowed interval is 30 s. */
    sweepSchedule: z
      .string()
      .regex(/^\S+( \S+){4,5}$/)
      .default('0 * * * * *'),
    /** The sweeper looks at the newest `sweepWindow` proposal ids (at most MAX_SWEEP_WINDOW, see above). */
    sweepWindow: z.number().int().min(1).max(MAX_SWEEP_WINDOW).default(20),
    /** Multicall3, used to batch reads under the per-run ChainRead budget. */
    multicall: address.default(MULTICALL3_ADDRESS),
  })
  .refine((c) => c.minAgree <= c.rpcs.length, { message: 'minAgree is larger than the number of rpcs', path: ['minAgree'] })
  .refine((c) => new Set(c.rpcs.map((r) => r.label)).size === c.rpcs.length, { message: 'rpc labels must be unique', path: ['rpcs'] })
  .refine((c) => c.rpcs.length * (1 + c.simRequests) <= LIMITS.httpCalls, {
    message: `rpcs x (1 + simRequests) must stay within ${LIMITS.httpCalls} HTTP calls per run`,
    path: ['simRequests'],
  })
  .refine((c) => new Set(c.allowedOpcodes).size === c.allowedOpcodes.length, { message: 'allowedOpcodes lists an opcode twice', path: ['allowedOpcodes'] })

export type Config = z.infer<typeof configSchema>
