**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md)

# Upgrade Airlock

**Upgrade Airlock gives every contract upgrade two doors.** The outer door is a cooldown measured in blocks. The
inner door opens only when a Chainlink CRE workflow has attacked the new implementation in a simulator on four
independent RPC providers, every answer has agreed, the DON has reached consensus on the verdict, and a signed
**Clear** report has landed on chain. A malicious implementation gets a signed **Veto** instead and can never run,
even when the attacker holds the upgrade key. Built for ETH Shenzhen 2026 on Ethereum Sepolia.

## The problem

An upgradeable proxy puts the whole protocol behind its upgrade key. Once that key leaks, the attack is short: deploy a
malicious implementation, point the proxy at it, mint or drain. It has happened many times:

- **PAID Network, March 2021.** The proxy owner's keys swapped the audited token code for a version with burn and
  mint functions, and the attacker minted about 59.5 million PAID.
  ([CertiK post-mortem](https://www.certik.com/blog/paid-network-post-mortem))
- **Ankr, December 2022.** With the compromised deployer key, the attacker replaced the aBNBc implementation with
  one that minted without authorization checks: 60 trillion aBNBc.
  ([Ankr's report](https://www.ankr.com/blog/the-abnbc-token-report/))
- **Radiant Capital, October 2024.** An attacker controlling 3 of 11 multisig signers took over the lending pool
  provider and upgraded the lending pools' implementation, draining over $53 million.
  ([rekt.news](https://rekt.news/radiant-capital-rekt2))

A timelock only makes the attacker wait, and nobody is obliged to look during the wait. Long delays also block
emergency fixes. Upgrade Airlock makes the wait do the work: an upgrade cannot run until an independent,
decentralized check has passed it, and that check runs automatically on every proposal.

## How it works

```
 owner key (assume it leaks)
   │ proposeUpgrade(newImpl, data)
   ▼
 AirlockAdmin ─────────── Proposed(id, kind, target, codehash, readyBlock) ────────────┐
   │  outer door: cooldown of delayBlocks (25 blocks, about 5 minutes on Sepolia)      │
   │  inner door: clearanceOf[id] != 0                                                 ▼
   │                                   ┌──────────── Chainlink CRE workflow (cre/veto) ────────────┐
   │                                   │ EVM log trigger on Proposed  (+ cron sweeper every 60 s)  │
   │                                   │ EVM reads: proposal, approvals, balances, block header    │
   │                                   │ node mode, on every DON node:                             │
   │                                   │   attack simulation (eth_simulateV1) on 4 RPC providers   │
   │                                   │   every answer must agree, else fail closed (R6)          │
   │                                   │ DON consensus on {verdict, rule}                          │
   │                                   │ evidence hash + EIP-712 attestation -> report             │
   │                                   └──────────────────────────┬────────────────────────────────┘
   │                                                     writeReport -> KeystoneForwarder
   │                                                              ▼
   │◄── clear(id, evidenceHash)  or  veto(id, ruleHash) ── AirlockReceiver.onReport
   ▼
 execute(id): cooldown over AND cleared AND not vetoed  ->  ProxyAdmin.upgradeAndCall(proxy, newImpl, data)
```

1. **Propose.** `AirlockAdmin` owns the OpenZeppelin `ProxyAdmin` and the token's `Ownable`. The owner key can only
   propose: it is never a guardian, the approver or the clearance oracle. Every proposal (an upgrade, or a change
   to the airlock itself: guardians, delay, break-glass target) gets `readyBlock = block.number + delayBlocks`.
   An upgrade or break-glass target must be ordinary contract code: an EIP-7702 delegated account, whose key could
   re-point it after the verdict, is refused (`DelegatedAccount`).
2. **Judge.** The CRE log trigger fires on `Proposed`. A change to the airlock is judged from chain reads (R7). An
   upgrade first meets the static rules (R5, R8), then the attack simulation, pinned to the proposal block: the
   proxy's ERC-1967 implementation slot is overridden with the new code, and a fresh stranger address (derived from
   the proposal block's hash) is funded like a real user, with tokens from a second holder and ETH. A holder makes a
   transfer, the stranger calls `transferFrom` without allowance, then every selector found in the new bytecode with
   five argument shapes. Every selector outside the standard token interface is also called with holder-shaped
   arguments: the funded holder in each of the first four argument slots, the test amount in another, the stranger
   or the proxy in the rest. Supply, owner and every watched balance are read before and after, the holder's
   balance right after each holder-shaped call, and every probe's own events are checked (R1 to R4, R3B). Finally
   the new bytecode is scanned for opcodes that behave differently on a real block than in a simulation (R9).
3. **Agree.** Each DON node runs the simulation on four providers. At least two must answer and every answer must
   be the same verdict; anything else is a veto (R6). The DON then agrees on the identical `{verdict, rule}`.
4. **Report.** The workflow hashes a canonical evidence JSON, signs an EIP-712 verdict with its attester key (a CRE
   secret), and writes the report through the forwarder. `AirlockReceiver` checks the sender, the freshness, the
   signature and that the verdict is bound to this exact proposal (`proposalDigest`), then calls `clear` or
   `veto` + `attachReason` on `AirlockAdmin`.
5. **Execute.** Anyone may call `execute(id)` once the cooldown is over. It reverts `TooEarly` during the cooldown,
   `NotCleared` without a clearance, `ProposalVetoed` after a veto, and `CodehashChanged` when the target no longer
   holds the code that was proposed and judged. A veto always beats a clearance.
6. **Sweep.** A cron trigger re-checks the newest proposals every 60 seconds and judges every pending one the CRE
   has not answered yet (`oracleJudged`): a log the trigger missed, a `Proposed` event too large to deliver, or an
   upgrade the approver cleared by hand. Its veto wins over that clearance.

Every failure points the same way. A missed log, an RPC outage, disagreeing providers or a failed run leaves the
proposal without a clearance or vetoes it, so it delays an upgrade and never lets one through. When CRE cannot
answer at all, the approver key can clear an upgrade by hand with recorded evidence. The sweeper still judges that
upgrade once CRE answers again, and a CRE or guardian veto still wins. `breakGlass()` lets the owner or any guardian
switch the proxy to a pre-registered paused implementation at once. Leaving the paused state is an ordinary upgrade
through both doors.

**Two modes.** In automatic mode, the default, CRE clears or vetoes every upgrade on its own through a bounded attack
search: a funded outside caller, every selector in the new code, and the holder in each of the first four argument
slots of every new function. Strict mode (R5) adds a human review: every new implementation codehash must first be
approved by the approver key, and the attack simulation still runs
([the two modes](docs/design.md#two-modes-automatic-and-strict)).

More detail: [docs/design.md](docs/design.md) (threat model, clearance state machine, report binding, budgets)
and [cre/README.md](cre/README.md) (the workflow).

## Chainlink CRE

CRE is the orchestration layer of Upgrade Airlock: the workflow is the only automated way through the inner door,
and it carries every step from the on-chain trigger to the on-chain verdict. It is written with the CRE TypeScript
SDK (`@chainlink/cre-sdk` 1.23.0) and compiled to WASM with the CRE CLI v1.37.0.

| Chainlink technology | Where | What it does here |
|---|---|---|
| CRE workflow runner | [`cre/veto/main.ts#L1-L9`](cre/veto/main.ts#L1-L9), [`cre/veto/workflow.yaml`](cre/veto/workflow.yaml), [`cre/project.yaml`](cre/project.yaml) | Two handlers, targets `sepolia` and `sepolia-fork` |
| EVM log trigger | [`cre/veto/workflow.ts#L202-L211`](cre/veto/workflow.ts#L202-L211), [`#L193-L198`](cre/veto/workflow.ts#L193-L198), [`#L54-L65`](cre/veto/workflow.ts#L54-L65) | `AirlockAdmin.Proposed` at `LATEST`: a proposal is judged as soon as it appears, a whole cooldown before it could run |
| Cron trigger | [`cre/veto/workflow.ts#L200`](cre/veto/workflow.ts#L200), [`#L209`](cre/veto/workflow.ts#L209), [`cre/veto/airlock.ts#L321-L387`](cre/veto/airlock.ts#L321-L387) | The sweeper: newest 20 ids, every minute |
| EVM read (`callContract`) | [`cre/veto/workflow.ts#L114-L122`](cre/veto/workflow.ts#L114-L122), [`#L137-L142`](cre/veto/workflow.ts#L137-L142), [`cre/veto/chain.ts`](cre/veto/chain.ts) | Proposal, clearance, `oracleJudged`, approvals and balances, batched through Multicall3 at the proposal block or `LATEST` |
| EVM read (`headerByNumber`) | [`cre/veto/workflow.ts#L125-L136`](cre/veto/workflow.ts#L125-L136) | The latest block, and the proposal block's hash that seeds the simulated stranger |
| HTTP capability in node mode | [`cre/veto/workflow.ts#L167-L189`](cre/veto/workflow.ts#L167-L189), [`#L80-L94`](cre/veto/workflow.ts#L80-L94), [`cre/veto/judge.ts#L157-L220`](cre/veto/judge.ts#L157-L220) | Every node sends each provider `eth_getCode`, then one or two `eth_simulateV1` requests (each under the 120 kb request limit) |
| `consensusIdenticalAggregation` | [`cre/veto/workflow.ts#L184-L188`](cre/veto/workflow.ts#L184-L188), quorum in [`cre/veto/judge.ts#L244-L277`](cre/veto/judge.ts#L244-L277) | The DON agrees on `{verdict, rule}` (at most 52 bytes) |
| Secrets | [`cre/veto/workflow.ts#L160-L166`](cre/veto/workflow.ts#L160-L166), [`cre/secrets.yaml`](cre/secrets.yaml) | The EIP-712 attester key, fetched once per run |
| Report + `writeReport` | [`cre/veto/workflow.ts#L143-L149`](cre/veto/workflow.ts#L143-L149), [`cre/veto/airlock.ts#L229-L280`](cre/veto/airlock.ts#L229-L280), [`cre/veto/report.ts`](cre/veto/report.ts) | `runtime.report` (ECDSA, keccak256) and `evm.writeReport`, then a read of the proposal to confirm the result |
| Forwarder + `IReceiver` | [`src/cre/AirlockReceiver.sol#L88-L120`](src/cre/AirlockReceiver.sol#L88-L120), [`#L156-L169`](src/cre/AirlockReceiver.sol#L156-L169), [`src/cre/IReceiver.sol`](src/cre/IReceiver.sol), [`script/DeployEth.s.sol#L35`](script/DeployEth.s.sol#L35) | `onReport` accepts only the configured forwarder, checks workflow id and owner when configured |
| Chain selectors | [`cre/veto/workflow.ts#L100-L104`](cre/veto/workflow.ts#L100-L104) | `ethereum-testnet-sepolia` |
| CRE CLI | [`cre/setup.sh`](cre/setup.sh), [`cre/scripts/fork-e2e.sh`](cre/scripts/fork-e2e.sh), [`scripts/sepolia/airlock.sh`](scripts/sepolia/airlock.sh), [`scripts/sepolia/sweep.sh`](scripts/sepolia/sweep.sh) | `cre workflow build`, `cre workflow simulate --broadcast` |

**How the workflow runs today.** The workflow runs with the CRE CLI's `cre workflow simulate --broadcast` against
Ethereum Sepolia. The listener ([`scripts/sepolia/airlock.sh`](scripts/sepolia/airlock.sh)) keeps the log trigger
in listen mode, the sweeper ([`scripts/sepolia/sweep.sh`](scripts/sepolia/sweep.sh)) runs the cron handler every
minute, and every Clear and Veto is a real Sepolia transaction through Chainlink's Sepolia MockKeystoneForwarder
[`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts).
`AirlockReceiver` is ready for a DON deployment as it is: deploy with `FORWARDER` set to the production
KeystoneForwarder and `WORKFLOW_ID` / `WORKFLOW_OWNER` set, and `onReport` also checks the DON-signed workflow
metadata. `DeployEth` refuses the permissionless MockKeystoneForwarder unless both are set or `ALLOW_MOCK_FORWARDER=1`
says so explicitly ([`script/DeployEth.s.sol#L98`](script/DeployEth.s.sol#L98)).

The workflow stays inside CRE's per-run limits by design: at most 15 chain reads (Multicall3 batches under the 5 kb
payload limit), 12 of 15 HTTP calls with four providers, one attack simulation per run, and a consensus value of at
most 52 bytes. The budgets are in [docs/design.md](docs/design.md#budgets).

## Rules

`ruleHash = keccak256("GUARD/<ID>")`, recorded on chain with every veto.

| Rule | Vetoes when | Decided by |
|---|---|---|
| R1 `TOTAL_SUPPLY` | a stranger's call changes `totalSupply` | attack simulation |
| R2 `OWNER` | a stranger's call changes `owner()` | attack simulation |
| R3 `TRANSFER_CONSERVATION` | a holder's transfer of X does not move exactly X, or moves anyone else's balance | attack simulation |
| R3B `THIRD_PARTY_FUNDS` | an outsider moves any holder's tokens: the funded stranger's `transferFrom` without allowance succeeds, or one of its probes moves anyone else's tokens, mints, burns or moves ownership, or leaves the holder's balance lower, even with no event or when a later call undoes it | attack simulation |
| R4 `TRANSFER_LIVENESS` | a plain holder transfer fails | attack simulation |
| R5 `STRICT_CODEHASH` | strict mode is on and the approver has not approved the codehash | chain reads |
| R6 `SIM_FAILURE` | the simulation cannot decide: providers disagree, too few answer, code mismatch, a view or the stranger's funding reverts, or the probes do not fit in the configured requests | simulation and quorum |
| R7 `CONFIG_GUARD` | a guardian change, a shorter delay or a new break-glass target without the approver's pre-approval | chain reads |
| R8 `INIT_DATA` | an upgrade carries init data the approver has not approved together with the codehash | chain reads |
| R9 `NEW_OPCODES` | the new code contains a block or transaction context opcode (BASEFEE, TIMESTAMP, NUMBER, ORIGIN, GAS and more), an external call, create or selfdestruct that the config's fixed allowlist (empty by default) does not cover, unless the approver approved that exact codehash | bytecode |

R9 closes simulation evasion. `EvilBaseFeeImpl` behaves like v1 while `block.basefee == 0`, which is what an
`eth_simulateV1` call sees, and lets anyone mint on a real block. Every simulated invariant passes; its `BASEFEE`
opcode vetoes it. The allowlist never depends on the code the proxy runs today, so an approval covers one codehash
and no later upgrade. The scan skips the compiler's metadata tail only when it is an exact solc CBOR map that no
instruction can reach; anything else is scanned as code. Approving a codehash exempts it from R9 and excuses probe
truncation (R6), nothing more: every other rule still runs.

R3B closes the quiet drain. `EvilDrainImpl` is v1 plus `rescue(from, to, amount)` with no access control. Supply,
owner, transfers and opcodes are those of v1, so R1 to R4 and R9 all pass. `rescue` is not a standard token
function, so the stranger also calls it with holder-shaped arguments; the call with the holder as `from` moves the
holder's tokens, and R3B vetoes it. A drain that hides behind "only for callers who hold tokens or ETH" is reached
too, because the stranger holds both.

## Live on Sepolia

Ethereum Sepolia, chain id 11155111. Deployed with [`script/DeployEth.s.sol`](script/DeployEth.s.sol) at block
PENDING.

| Contract | Address |
|---|---|
| AirlockAdmin | PENDING |
| AirlockReceiver | PENDING |
| DemoBTC proxy (dBTC) | PENDING |
| ProxyAdmin | PENDING |
| DemoBTC v1 | PENDING |
| DemoBTC v2 (honest upgrade) | PENDING |
| EvilMintImpl | PENDING |
| EvilOwnerImpl | PENDING |
| EvilFeeImpl | PENDING |
| EvilBaseFeeImpl | PENDING |
| EvilDrainImpl | PENDING |
| PausedImpl (break-glass target) | PENDING |
| Chainlink MockKeystoneForwarder | [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://sepolia.etherscan.io/address/0x15fC6ae953E024d975e77382eEeC56A9101f9F88) |

| Card | Proposal | CRE verdict | Proposal tx | Report tx | Then |
|---|---|---|---|---|---|
| `v2`: honest upgrade | PENDING | Clear | PENDING | PENDING | `execute` PENDING, `version()` = "2" |
| `evil-mint`: anyone can mint | PENDING | Veto R1 | PENDING | PENDING | `execute` reverts `ProposalVetoed` |
| `evil-owner`: anyone can take ownership | PENDING | Veto R2 | PENDING | PENDING | `execute` reverts `ProposalVetoed` |
| `evil-fee`: transfers skim 10% | PENDING | Veto R3 | PENDING | PENDING | `execute` reverts `ProposalVetoed` |
| `evil-basefee`: mint opens on a real block | PENDING | Veto R9 | PENDING | PENDING | `execute` reverts `ProposalVetoed` |
| `evil-drain`: anyone moves a holder's tokens | PENDING | Veto R3B | PENDING | PENDING | `execute` reverts `ProposalVetoed` |
| `remove-receiver`: drop CRE as a guardian | PENDING | Veto R7 | PENDING | PENDING | `execute` reverts `ProposalVetoed` |

## Run it

Needs [Foundry](https://getfoundry.sh), `jq`, Node 22, and a CRE account for the simulator. `cre/setup.sh`
installs the CRE CLI v1.37.0 (SHA-256 pinned) and bun 1.4.2 into `cre/.tools`.

```bash
git clone https://github.com/jiapunk/upgrade-airlock.git
cd upgrade-airlock

# contracts (OpenZeppelin and forge-std are vendored in lib/)
forge build                     # fetches the pinned solc 0.8.37 once
forge test --offline            # 117 tests

# the CRE workflow
cre/setup.sh
export PATH="$PWD/cre/.tools/bin:$PWD/cre/.tools/node_modules/.bin:$PATH"
(cd cre/veto && bun test && bun run typecheck)    # 118 tests: rules, probes, bytecode, reports, budgets, handlers

# end to end on a local anvil fork of Sepolia: nothing is sent to a live network
cre login                       # once; the simulator needs a CRE account
cre/scripts/fork-e2e.sh
```

`cre/scripts/fork-e2e.sh` deploys the stack on the fork, runs the workflow in the CRE simulator with `--broadcast`
and checks every outcome on chain:

- log trigger: EvilMint vetoed R1, EvilOwner R2, EvilFee R3, EvilBaseFee R9 (it names `BASEFEE`), EvilDrain R3B
  (it names `rescue`, every other rule passing); seven more drains vetoed R3B alone: reordered arguments, a
  token-address guard, a drain open only to callers holding tokens or ETH, one without a `Transfer` event, and a
  `transferFrom` that skips the allowance for token holders; honest v2 cleared and executed after the cooldown;
  removing the receiver as a guardian vetoed R7; a shorter delay pre-approved by the approver cleared;
- sweeper: an upgrade nobody judged reverts `NotCleared` after the cooldown, one sweeper run clears it and it
  executes; two proposals the approver cleared by hand are judged by the next run: EvilDrain vetoed R3B over the
  clearance, a longer delay cleared by CRE as well; an upgrade with 6 KB of init data is vetoed R8 by the run after;
- every vetoed proposal reverts `ProposalVetoed`, and every verdict's evidence hash is recomputed from chain data
  ([`cre/veto/tools/check-evidence.ts`](cre/veto/tools/check-evidence.ts)).

**War room.** `cd web && npm ci && npm run dev`, then open `http://127.0.0.1:5173/`. It reads Sepolia directly
(read-only) and shows each proposal as an airlock: the cooldown, the CRE clearance, the veto with its rule and
evidence. `?mode=offline` plays a recorded run with no network at all, and `?lang=en|zh-TW|zh-CN` picks the
language.

**Sepolia operator kit** ([`scripts/sepolia/`](scripts/sepolia/README.md)). The keys live outside the repo, one hex
key per file in `KEY_DIR` (`owner`, `attester`, `sender`, `approver`, `emergency`); the scripts never print them,
and `deploy.sh` refuses unless owner, approver, emergency guardian and attester are four different keys. Every
script also runs against a local fork with `FORK=<port>`, so the demo can be rehearsed without spending anything.

```bash
scripts/sepolia/deploy.sh                    # 13 transactions, writes deployments/sepolia.json (FORCE=1 replaces one)
bun scripts/sepolia/make-config.mjs          # the workflow config, 4 providers, quorum 2
scripts/sepolia/fund-sender.sh 0.05          # ETH for the report transactions
scripts/sepolia/airlock.sh                   # terminal A: the CRE listener (log trigger)
scripts/sepolia/propose.sh v2                # terminal B: then evil-mint, evil-owner, evil-fee, evil-basefee, evil-drain, remove-receiver
scripts/sepolia/execute.sh <id>              # runs a cleared proposal after its cooldown, shows the revert otherwise
scripts/sepolia/status.sh                    # every proposal: verdict, CRE judged or not, rule, evidence, txs
```

`sweep.sh` runs the cron sweeper once, `clear.sh` is the approver's manual clearance, `fork.sh` starts, saves and
restores a Sepolia fork, `probe-rpcs.ts` checks every provider with the workflow's own judging code, and
`systemd/` runs the listener and the sweeper on a Linux server.

## Repository layout

```
src/AirlockAdmin.sol            the two doors: proposals, cooldown, guardian veto, clearance, execute, breakGlass
src/cre/AirlockReceiver.sol     CRE report receiver: forwarder, workflow metadata, EIP-712 attestation, digest binding
src/cre/IReceiver.sol           Chainlink CRE receiver interface
src/DemoBTC.sol, DemoBTCV2.sol  demo token (dBTC) v1 and the honest v2
src/PausedImpl.sol              break-glass target: every balance change reverts
src/attack/                     EvilMintImpl, EvilOwnerImpl, EvilFeeImpl, EvilBaseFeeImpl, EvilDrainImpl
script/DeployEth.s.sol          deployment (13 transactions) with role, forwarder and post-deploy wiring checks
test/                           Foundry tests
cre/veto/                       the CRE workflow: workflow.ts (capabilities), airlock.ts (handlers), judge.ts (rules,
                                quorum), simulate.ts (eth_simulateV1), bytecode.ts (selectors, R9), report.ts
                                (report, EIP-712, evidence), chain.ts (read budget), keys.ts, rules.ts, config.ts
cre/veto/test/                  Bun unit tests
cre/veto/tools/                 check-evidence.ts: recomputes every on-chain evidence hash
cre/scripts/fork-e2e.sh         end to end on an anvil fork of Sepolia
cre/setup.sh                    pinned CRE CLI and bun
scripts/sepolia/                operator kit for the live demo
web/                            war room (Vite, TypeScript)
deployments/                    deployment JSON
docs/                           design notes and recorded runs
```

## AI tools

Upgrade Airlock was built with [Claude Code](https://claude.com/claude-code) under the author's direction: the
contracts, the CRE workflow, the tests, the scripts, the war room and these documents were written and checked
with it.

## License

[MIT](LICENSE) © 2026 jiapunk
