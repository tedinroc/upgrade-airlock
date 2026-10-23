# Upgrade Airlock: the CRE clearance workflow

A Chainlink CRE workflow that is `AirlockAdmin`'s clearance oracle. Every proposal (an upgrade or a change to the
airlock itself) needs a clearance before it can execute. The workflow judges each proposal and always ends in an
attested on-chain report: **Clear** when every check passes, **Veto** when one fails. A proposal no verdict has
reached has no clearance and cannot execute, so a missed log or a failed run only delays an upgrade. A clearance the
approver gives by hand does not count as a verdict of this workflow (`AirlockAdmin.oracleJudged` stays false), so the
workflow still judges that proposal, and its Veto wins over the approver's clearance.

```
AirlockAdmin.Proposed ── handler 0: EVM log trigger (LATEST) ──┐
cron, default every 60 s ── handler 1: sweeper (newest 20 ids) ─┤
                                                                ▼
 (the sweeper takes every Pending proposal with oracleJudged false, approver-cleared ones included, oldest first)
 EVM reads, batched through Multicall3: getProposal + clearanceOf + oracleJudged at LATEST;
   approvals, holder balances, delay at the proposal block; the proposal block's hash (header by number)
 kinds 1-3 (guardian / delay / paused impl): R7 from those reads
 kind 0 (upgrade): R5 strict codehash, R8 init data, a funded holder; then node mode: every node (each DON node
   when deployed to a DON; the CLI simulator today)
   attack-simulates the upgrade on each RPC provider (eth_getCode, then 1 to simRequests eth_simulateV1 requests)
   -> R1-R4, R3B, R9; quorum: at least minAgree answers and all equal, otherwise R6 (fail closed)
 identical consensus on {verdict, rule} (across the DON's nodes in a DON deployment)
 evidence JSON -> evidenceHash; EIP-712 attestation (CRE secret); runtime.report -> writeReport
   -> (Mock)KeystoneForwarder -> AirlockReceiver.onReport
        pass -> AirlockAdmin.clear(id, evidenceHash)
        veto -> AirlockAdmin.veto(id, ruleHash) + attachReason(id, evidenceHash)
 EVM read of the proposal state (the forwarder swallows a reverting onReport: tx success is not proof)
```

| File | What it is |
|---|---|
| `veto/workflow.ts` | Triggers and the CRE wiring: EVM reads with a per-run budget, node-mode simulation, secret, report |
| `veto/airlock.ts` | What happens to a proposal: reads, verdict, report, confirmation; the sweeper's selection (SDK-free) |
| `veto/judge.ts` | R7, the static upgrade rules, per-provider judging and the quorum |
| `veto/simulate.ts` | The `eth_simulateV1` attack simulation (probes split over requests) and its evaluation (R1-R4, R3B) |
| `veto/bytecode.ts` | Selector extraction, the R9 opcode list and the solc metadata check |
| `veto/report.ts` | Report encoding, EIP-712 attestation, `proposalDigest`, canonical evidence |
| `veto/chain.ts` | Multicall3 batching under the ChainRead limits |
| `veto/tools/check-evidence.ts` | Recomputes every on-chain verdict's evidenceHash from `getProposal` alone |
| `scripts/fork-e2e.sh` | The full loop on an anvil fork of Sepolia |
| `../src/cre/AirlockReceiver.sol` | The receiver: clearance oracle and one guardian of `AirlockAdmin` |

## Rules

| Rule | Vetoes when |
|---|---|
| R1 `TOTAL_SUPPLY` | a stranger's call changes totalSupply |
| R2 `OWNER` | a stranger's call changes the owner |
| R3 `TRANSFER_CONSERVATION` | a holder's transfer does not move exactly the amount, or moves anyone else's balance |
| R3B `THIRD_PARTY_FUNDS` | a stranger (funded first with tokens and ETH, so caller-gated drains are reached) can pull a holder's funds without allowance; or a stranger probe mints or burns, moves anyone else's tokens or ownership (from its own logs, even if a later call undoes it), or drops the holder's balance with no event |
| R4 `TRANSFER_LIVENESS` | a plain holder transfer fails |
| R5 `STRICT_CODEHASH` | strict mode and the codehash is not approved |
| R6 `SIM_FAILURE` | the simulation cannot decide: providers disagree, too few answer, a view reverts, code mismatch, or the probes do not fit in `simRequests` requests (excused when the codehash is approved) |
| R7 `CONFIG_GUARD` | a guardian change, a shorter delay or a new paused impl without the approver's pre-approval |
| R8 `INIT_DATA` | an upgrade carries init data without a codehash+data approval |
| R9 `NEW_OPCODES` | the new code contains an opcode from this list that the config's `allowedOpcodes` does not allow: block and fee context (TIMESTAMP, NUMBER, PREVRANDAO, COINBASE, BLOCKHASH, BASEFEE, GASPRICE, BLOBBASEFEE, BLOBHASH, GASLIMIT, GAS, ORIGIN) or calls/creates/selfdestruct, unless that codehash is approved |

The stranger is funded first. Before the probes (and before the R3B `transferFrom`), the simulation makes the
derived stranger look like a real user: a token balance (a transfer to it from a *second* holder, so the test
holder's R3 accounting stays exactly `-amount`) and an ETH balance (a `stateOverrides` balance). That defeats drains
gated on the caller holding tokens (`require(balanceOf(msg.sender) != 0)`), the caller holding ETH
(`require(msg.sender.balance != 0)`), and a `transferFrom` that waives its allowance check for a token-holding caller.
The funding transfer must succeed or the run fails closed (R6).

Probes. Every selector the dispatcher compares against is called by the funded stranger with five base shapes (the
stranger; the stranger and a large number; a large number; none; a wide mix), plus empty and unknown-selector
calldata, so a drain that shows itself through a `Transfer`/`OwnershipTransferred` event is caught however it is
reached. Every selector that is **new** relative to the standard token / ownable / proxy interface also gets
*placement* probes: the funded holder in each of the first four argument slots, the test `amount` (1% of the
holder's balance) in each other slot, and the remaining slots filled once with the stranger and once with the proxy
address. That covers a drain whatever order its arguments take (`rescue(from, amount, to)`, `sweep(amount, from, to)`,
`rescueTokens(token, from, to, amount)` with `require(token == address(this))` — the proxy-filled probe passes the
guard). Right after every placement probe the holder's and the stranger's balances are read, so a drain that moves
the holder's tokens out and a later probe moves them back in the same request — with no `Transfer` event — is still
seen by the drop between the reads. `EvilDrainImpl` (an open `rescue(from, to, amount)`, nothing else changed) passes
R1, R2, R3, R4 and R9; the holder-first probe of `rescue` vetoes it R3B.

R9 is why simulation evasion does not work: an `eth_simulateV1` call without validation runs with basefee 0, so
`EvilBaseFeeImpl` (owner-only mint at basefee 0, open mint on a real block) passes every simulated invariant, and its
BASEFEE opcode vetoes it. The allowlist is fixed in the config (default empty) and never depends on the code the
proxy runs today, so approving one implementation's codehash exempts that codehash only, not every later upgrade.

The opcode walker skips the solc metadata tail only when it decodes as an exact solc CBOR map (keys ipfs, bzzr0,
bzzr1, solc, experimental with their exact value types and lengths, ending exactly at the declared length) and no
code can reach it: the instruction before it halts, and any JUMPDEST the EVM accepts inside it is followed until
execution halts. Anything else is scanned as code. About 2% of honest solc builds have a reachable JUMPDEST in their
metadata hash followed by an R9 opcode byte; approving that codehash covers it.

Approvals are read at the proposal block, so a verdict is the same whether the log trigger or the sweeper reaches
it, and an approval registered after the proposal does not count. Keys (`veto/keys.ts`):
`keccak256(abi.encode(kind, target, value))` for config changes, `keccak256(abi.encode(codehash, dataHash))` for
init data, the codehash itself for R5/R9.

## Report and evidence

```
report         = abi.encode(uint8 action, uint256 proposalId, bytes32 proposalDigest, bytes32 ruleHash,
                            bytes32 evidenceHash, uint64 validUntilBlock, bytes signature)   action 0 Veto, 1 Clear
signature      = EIP-712, domain ("AirlockReceiver", "1", chainId, receiver), type
                 Verdict(address airlockAdmin,uint8 action,uint256 proposalId,bytes32 proposalDigest,bytes32 ruleHash,
                         bytes32 evidenceHash,uint64 validUntilBlock)
proposalDigest = AirlockAdmin.proposalDigest(id) = keccak256(abi.encode(kind, target, value, codehash, dataHash,
                                                                         proposedBlock))
evidenceHash   = keccak256 of the canonical JSON (sorted keys, schema upgrade-airlock/evidence-v2): chainId,
                 airlockAdmin, proposalId and the getProposal fields, proposalDigest, verdict, rule
validUntilBlock = max(readyBlock, current block) + reportGraceBlocks   (blocks, never a clock)
```

The consensus step (the DON, in a DON deployment) agrees only on `{verdict, rule}`. Per-provider answers, failed checks, culprit selectors and new opcodes are
in the node logs. Everything in the evidence is on chain, so `veto/tools/check-evidence.ts` recomputes each hash:
`bun veto/tools/check-evidence.ts <rpc> ../deployments/sepolia.json` (it reads the logs in 10,000-block windows; on
live Sepolia give it an RPC that keeps old logs, such as https://sepolia.gateway.tenderly.co).

## Staying inside CRE's per-run limits

`cre workflow limits export` lists them; the simulator applies the defaults.

| Limit | How the workflow stays inside it |
|---|---|
| ChainRead 15 calls (headerByNumber counts too) | Multicall3 batches. Sweeper: latest header 1, nextId 1, scan of 20 ids 4 (getProposal, clearanceOf, oracleJudged), then 3 per upgrade (reads at the proposal block, block hash, confirmation) and 2 per config change. Every judgement checks the remaining budget first; the rest waits for the next run. `sweepWindow` is capped at 30 (scan 6), which leaves room for an upgrade and two config changes; a budget that still runs out ends the run with a log line, never an error. Log path: 5. |
| ChainRead payload 5 kb | Each batch's request and response stay under 4096 bytes. Init data is never read: R8 needs only `dataHash`. |
| HTTP 15 calls | One simulation is `eth_getCode`, then 1 to `simRequests` (default 2) `eth_simulateV1` requests per provider: at most 12 calls with four providers, 15 with five. The config refuses `rpcs x (1 + simRequests)` over 15. At most one simulation per run; static and config verdicts need no HTTP. |
| HTTP request 120 kb, response 250 kb | Each `eth_simulateV1` request holds at most `maxCalls` calls and at most 88,000 bytes of JSON (117,336 once base64-encoded). Probes = 2 fallback + 5 base shapes per selector + 24 placement probes per **new** selector (each placement probe carries one holder and one stranger balance read). DemoBTCV2 and EvilDrain (16 extracted selectors, including `0x0000001f`, a length-check constant from the solc dispatcher that the selector walker over-includes and probes harmlessly; v1 has 15) are 130 probes; at `maxCalls` 150 it goes out as two requests (148 calls / 40.0 kB JSON / 53.3 kB base64 and 127 calls / 33.0 kB / 44.0 kB) — well inside 120 kb. A drain variant (even the 4-argument `rescueTokens`) adds one drain selector, so it measures the same. `bun tools/measure-requests.ts` prints these. |
| Log event 5 kb | A Proposed log with large init data is not delivered; the sweeper judges it from `getProposal`. |
| Log line 1 kb, secrets 5 calls | Lines are clipped; the attester key is fetched once per run. |
| Cron at least 30 s | Default `0 * * * * *` (every minute). |

## Run

```bash
./setup.sh                                  # CRE CLI v1.37.0 (sha256-pinned), bun 1.4.2, npm deps
export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
(cd veto && bun test && bun run typecheck)  # unit tests: rules, report bytes, budgets, both handlers on an in-memory
                                            # chain, the simulation against an in-memory token, crafted bytecode
scripts/fork-e2e.sh                         # full loop on an anvil fork of Sepolia (port 19611)
```

`scripts/fork-e2e.sh` deploys the stack with `script/DeployEth.s.sol` on the fork, then runs the workflow in the
CRE simulator with `--broadcast` and checks every result on chain:

- log trigger: EvilMint vetoed R1, EvilOwner R2, EvilFee R3, EvilBaseFee R9 (BASEFEE), EvilDrain R3B (the culprit
  `rescue` named, every other rule passing); seven drain variants A-G (`test/fixtures/DrainVariants.sol`: reordered
  args, a four-argument `rescueTokens` behind `require(token == address(this))`, drains gated on the caller holding
  tokens or ETH, a drain with no `Transfer` event, and a `transferFrom` that waives its allowance check) each vetoed
  R3B with every other rule passing; honest v2 cleared and executed after the cooldown; removing the receiver as
  guardian vetoed R7; a shorter delay pre-approved by the approver (its own key) cleared;
- sweeper: an upgrade nobody judged reverts `NotCleared` after the cooldown, one sweeper run clears it and it
  executes; two proposals the approver cleared by hand with their logs missed are both judged by the next run:
  EvilDrain is vetoed R3B (the veto wins over the clearance), a longer delay gets a CRE Clear while `clearanceOf`
  keeps the approver's evidence; an upgrade with 6 KB of init data is vetoed R8 by the run after that;
- the probes go out as two `eth_simulateV1` requests per provider (the fork config uses the live `maxCalls` 150),
  and `tools/measure-requests.ts` prints each request's call count and size against the HTTP limits;
- every vetoed proposal reverts `ProposalVetoed`, and every verdict's evidenceHash is recomputed from chain data.

`CRE_SIM` selects the simulator binary (default `cre`, which needs `cre login`).

### Simulator behaviour

- `--trigger-index 0 --evm-tx-hash <tx> --evm-event-index 0` replays one Proposed log.
- `--trigger-index 1 --non-interactive` runs the cron sweeper once, immediately; it does not wait for the schedule.
- `--listen` does not drive cron: with the sweeper trigger the CLI prints `--listen is not supported for this
  trigger type; ignoring`, runs it once and exits. Periodic sweeps in simulation need an outer loop, e.g.
  `while sleep 60; do cre workflow simulate ./veto -T sepolia --non-interactive --trigger-index 1 --broadcast; done`.
- It enforces ChainRead's 15 calls but not its 5 kb payload (a 64 KB call and a 64 KB reply both pass) and not
  the 5 kb log event size; the workflow respects both anyway.
- `cre workflow build ./veto -T sepolia-fork -o airlock.wasm` once, then `--wasm airlock.wasm`, skips the
  per-run compile (about 45 s each).

Notes found while building:
- Sepolia runs the Amsterdam rules: creating a contract costs about 7x what Foundry's Osaka simulation estimates.
  Deploy scripts use `--skip-simulation` so the node estimates gas.
- The CRE runtime has no `URL` global, so the config validates RPC URLs with a regex.
- `runtime.now()` is not reliable in the simulator; every validity window is in blocks.

## Config (`veto/config.ts`)

| Field | Meaning |
|---|---|
| `airlockAdmin`, `receiver`, `proxy` | Deployment addresses (`deployments/*.json`) |
| `holders` | Token holders; all are watched, the first with a balance makes the test transfer |
| `watch` | Extra addresses whose balances must not move (owner, AirlockAdmin) |
| `rpcs`, `minAgree` | Simulation providers (1-5, each with `eth_simulateV1` and batch requests) and the quorum |
| `strict` | R5: every upgrade codehash must be approved |
| `callGas`, `readGas` | Gas per simulated call and per simulated read |
| `maxCalls`, `simRequests` | Simulated calls per `eth_simulateV1` request (80-400, default 250) and requests per provider (1-4, default 2) |
| `allowedOpcodes` | R9 opcodes that do not veto, by name (default none) |
| `gasLimit` | Gas for forwarder -> receiver -> AirlockAdmin (default 2,000,000; a Veto report used up to about 524k in the fork end-to-end run, a Clear about 397k) |
| `reportGraceBlocks` | Report validity after max(readyBlock, current block) |
| `logConfidence` | `LATEST` only |
| `sweepSchedule`, `sweepWindow` | Sweeper cron (default every 60 s) and how many of the newest ids it scans (default 20, at most 30) |
| `multicall` | Multicall3 address (default the canonical one) |
