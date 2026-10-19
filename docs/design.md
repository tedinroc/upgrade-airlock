# Upgrade Airlock: design

This document explains why Upgrade Airlock is built the way it is. The [README](../README.md) covers what it does
and how to run it; [cre/README.md](../cre/README.md) covers the workflow's files and configuration.

## Threat model

### Roles

| Role | Held by | Can |
|---|---|---|
| owner | one key | propose (upgrade, guardian change, delay change, break-glass target change), `breakGlass` |
| guardians | `AirlockReceiver` (the CRE workflow) and an emergency guardian key | `veto`, `attachReason`, `breakGlass` |
| clearance oracle | `AirlockReceiver` | `clear` |
| approver | one key, kept apart from the owner | `clear` by hand, `approveCodehash` (registers codehashes, init-data keys and config-change keys) |
| attester | a CRE secret, its own key | signs the EIP-712 verdicts `AirlockReceiver` accepts |
| anyone | | `execute` a proposal that has passed both doors |

`AirlockAdmin` owns the OpenZeppelin `ProxyAdmin` and the token's `Ownable`, and it has no generic call path. The
only way to change the implementation is `execute` of an upgrade proposal (or `breakGlass` to the pre-registered
paused implementation). The constructor refuses overlapping roles (`RoleOverlap`): the owner is never the approver,
a guardian or the clearance oracle, and `proposeSetGuardian(owner, true)` reverts at propose time. No single key
can both propose and let its own proposal through. `DeployEth` checks the rest before it sends anything: owner,
approver, emergency guardian and attester must be four different addresses, and the permissionless
MockKeystoneForwarder is accepted only with `ALLOW_MOCK_FORWARDER=1` or with a workflow id and owner to check.

### The attacker

The attacker holds the owner key, deploys any bytecode without publishing source, chooses the moment and the
content of every proposal, and calls `execute` the moment a proposal could run. The attacker does not hold the
approver key, the emergency guardian key or the attester secret, and does not control the CRE workflow.

| Attack | What stops it |
|---|---|
| Propose a malicious implementation (open mint, ownership takeover, a skimming transfer, pulling holders' funds) | The attack simulation finds the broken invariant (R1, R2, R3, R3B, R4); the Veto report lands during the cooldown |
| Hide a drain behind one new, innocent-looking function and keep every v1 invariant (`EvilDrainImpl`'s `rescue(from, to, amount)`) | Every selector outside the standard token interface is called by the stranger with the funded holder in each of the first four argument slots and the test amount in another, and the holder's balance is read right after each call; every probe's own `Transfer` and `OwnershipTransferred` events are checked too. One call that moves a holder's tokens vetoes it (R3B), whatever the argument order, with or without an event, even if a later call puts them back |
| Open the drain only to callers that look like real users (holding tokens or ETH), or waive the allowance for callers that hold tokens | The stranger is funded before it calls anything: tokens from a second holder and 1 ETH by state override. Its `transferFrom` without allowance and every probe run funded |
| Execute right at `readyBlock`, before anyone looks | `execute` needs a clearance (`NotCleared`); nobody has to be watching |
| Propose an EIP-7702 delegated account: its code is a 23-byte designator, and its key can re-point it after the verdict | `proposeUpgrade` and `proposeSetPausedImpl` refuse it (`DelegatedAccount`), as the constructor does for the paused implementation and the clearance oracle |
| Swap the code at the judged address before `execute` (selfdestruct and redeploy, a metamorphic factory) | `execute` compares the target's codehash with the one recorded at propose time and reverts `CodehashChanged`; the proposal stays pending |
| Code that behaves honestly inside a simulation and maliciously on a real block (basefee, timestamp, block number, origin, gas) | R9: block and transaction context opcodes, external calls, create and selfdestruct veto the upgrade unless the config's fixed allowlist covers them or the approver approved that codehash. The compiler's metadata tail is skipped only when no instruction can reach it, so opcodes cannot hide there |
| Talk the approver into a hand clearance before CRE looks | A hand clearance is not a CRE verdict (`oracleJudged` stays false): the log trigger or the sweeper still judges the proposal, and a CRE veto ejects it. Only a proposal CRE never reaches runs on the approver's word alone ([the sweep window](#the-sweep-window)) |
| Recognize the simulation's stranger and behave honestly toward it | The stranger and receiver addresses are derived from the proposal block's hash, which does not exist yet when the implementation is deployed |
| Hide behind initialization data (a reinitializer that hands over ownership) | R8: init data needs the approver's approval of `keccak256(abi.encode(codehash, dataHash))` |
| Make the `Proposed` log too large to deliver (CRE drops log events over 5 kb) | The sweeper judges every pending proposal among the newest `sweepWindow` ids that CRE has not judged, from `getProposal`, which never includes the data |
| Weaken the airlock first: remove the CRE receiver as a guardian, shorten the delay, swap the break-glass target | Every change to the airlock is itself a proposal and passes both doors; R7 vetoes it without the approver's pre-approval |
| Forge a verdict through the forwarder used in simulation (the MockKeystoneForwarder is permissionless) | Every report carries an EIP-712 signature by the attester; the receiver recovers it |
| Reuse a Clear for other content: another proposal, another chain history, another implementation | The signed `proposalDigest` must equal `AirlockAdmin.proposalDigest(id)` |
| Keep a Clear for later | `validUntilBlock` is signed; a Clear only applies to a pending proposal and the first evidence hash is kept |
| Run or bribe an RPC provider | Every answering provider must agree and at least two must answer, so a single bad provider can cause a veto (R6, a delay), never a pass |

## Two doors and the clearance state machine

A proposal has a status (`None`, `Pending`, `Vetoed`, `Executed`) and, while it is pending, a clearance
(`clearanceOf[id]`, the evidence hash of the first accepted clearance, zero while there is none).

```
                propose (owner)
    None ─────────────────────────► Pending, not cleared ── execute ──► reverts TooEarly / NotCleared
                                      │                │
                 clear (oracle or     │                │ veto (any guardian)
                 approver, evidence)  ▼                ▼
                               Pending, cleared ─────► Vetoed ── execute ──► reverts ProposalVetoed
                                      │       veto        (terminal: cannot be cleared or executed)
                                      │
                execute (anyone), block.number >= readyBlock
                                      ▼
                                   Executed (terminal)
```

- **Outer door.** `readyBlock = proposedBlock + delayBlocks`. Time is counted in blocks only, never timestamps.
  `delayBlocks` is 25 on Sepolia (about 5 minutes) and bounded to 10 to 50,400 blocks.
- **Inner door.** `clear(id, evidenceHash)` is accepted from the clearance oracle or the approver, for a pending
  proposal, with a non-zero evidence hash. The first hash is kept; every accepted call still emits `Cleared` with
  the caller's own evidence, so a second opinion is visible on chain.
- **A veto always wins.** A guardian may veto a pending proposal whether it is cleared or not. Once vetoed, it can
  be neither cleared nor executed.
- **The oracle's own verdict is recorded apart.** `oracleJudged[id]` turns true when the clearance oracle clears or
  vetoes, never on the approver's clearance. A hand clearance therefore does not end the CRE's job: the sweeper
  still judges that proposal while it is in the sweep window, and a CRE veto ejects it although `clearanceOf` is
  set.
- **`execute` check order:** `UnknownProposal` / `ProposalVetoed` / `AlreadyExecuted`, then `TooEarly`, then
  `NotCleared`, then for an upgrade or break-glass target `CodehashChanged` (the target's code must still hash to
  the proposal's codehash). Status and the `Executed` event are written before the external call.
- **Every kind needs a clearance**, not only upgrades: guardian, delay and break-glass target changes pass both
  doors too.
- **Break glass.** `breakGlass()` (owner or any guardian) switches the proxy to the pre-registered paused
  implementation at once, without a proposal. Leaving the paused state is an ordinary upgrade through both doors.

The CRE workflow answers every proposal it judges: a pass becomes a Clear, a failed check a Veto. A proposal no
verdict has reached simply has no clearance. That is the property the whole design rests on:

| What goes wrong | Result |
|---|---|
| The log trigger misses a proposal, or the workflow run fails | No clearance: the proposal waits; the sweeper judges it on a later run while its id is among the newest `sweepWindow` |
| A provider is down or rate-limited | Errors are left out of the quorum; with fewer than `minAgree` answers the verdict is R6 (veto) |
| Providers disagree | R6 (veto) |
| The report transaction fails, or `onReport` reverts (the forwarder does not propagate the revert) | No clearance; the workflow reads the proposal back and logs `unconfirmed`, and the sweeper tries again |
| CRE cannot answer at all | The approver clears by hand with a published evidence JSON (`scripts/sepolia/clear.sh`); the sweeper still judges the proposal once CRE answers again, and a CRE or guardian veto wins. The approver's clearance is an override: a proposal CRE never reaches runs on it alone |

A wrong veto costs a new proposal. A wrong clearance could let an attacker in, so every uncertain case resolves to
a veto or to no clearance.

### The sweep window

The sweeper reads only the newest `sweepWindow` ids (20 by default, at most 30, so that the scan fits the ChainRead
budget). A proposal no log-trigger run has judged (a missed log, a failed run) is caught as long as fewer than
`sweepWindow` newer proposals exist when a sweep reaches it; the owner can push it out sooner by proposing more.
Once it is below the window, CRE never judges it:

- **Not cleared:** it stays pending and cannot execute. It costs a new proposal, nothing more.
- **Cleared by the approver:** it executes on the approver's clearance alone once its cooldown is over. This is the
  approver's manual clearance working as designed, an override for when CRE gives no verdict. `oracleJudged` is the
  sweeper's work list, not a third door; `test_knownIssue_approverClearanceRunsWithoutOracleVerdict` in
  [`test/known-issues/KnownIssues.t.sol`](../test/known-issues/KnownIssues.t.sol) records this.

## The workflow

Two handlers share one code path ([`cre/veto/airlock.ts`](../cre/veto/airlock.ts)):

- **Handler 0, EVM log trigger** on `AirlockAdmin.Proposed` at `LATEST` confidence. A proposal is judged as soon as
  it appears, a whole cooldown before it could run. Only the indexed topics are decoded (id, kind, target), never
  the data.
- **Handler 1, cron sweeper** (default every 60 seconds). It reads `nextId`, scans the newest `sweepWindow` (20)
  ids, and judges the pending proposals the oracle has not judged (`oracleJudged` false, approver-cleared ones
  included), oldest first, within the run's budgets. Whatever is left waits for the next run; older ids are not
  scanned ([the sweep window](#the-sweep-window)).

Judging one proposal:

1. **Reads at the proposal block.** Approvals, holder balances and the current delay are read at
   `proposedBlock`, so the verdict is the same whether the log trigger or the sweeper reaches it, and an approval
   registered after the proposal does not count.
2. **Config changes (kinds 1 to 3): R7** from those reads alone. Adding or removing a guardian and changing the
   break-glass target always need the approver's pre-approval of `keccak256(abi.encode(kind, target, value))`; a
   delay change needs it only when it shortens the delay.
3. **Upgrades (kind 0): static rules.** R5 in strict mode (the codehash must be approved, see
   [the two modes](#two-modes-automatic-and-strict)), R8 for init data, and a funded holder must exist.
4. **Upgrades: the attack simulation, in node mode.** Every DON node sends every configured provider
   `eth_getCode(newImpl)` pinned to the proposal block (the code must hash to the proposed codehash, else R6), then
   the simulation in at most `simRequests` (default 2) `eth_simulateV1` requests of at most `maxCalls` calls and
   88,000 bytes each, all with the proxy's implementation slot overridden and the stranger given 1 ETH. Every
   request starts from the proposal block with a transfer of the test amount (1% of the test holder's balance,
   capped at the sender's balance) from a second configured holder with a balance, when there is one, to the
   stranger, so the stranger looks like a real user; a funding transfer that reverts is R6. The first request then
   holds baseline reads, the holder's transfer to the receiver, reads, a `transferFrom(holder, stranger)` by the
   stranger without allowance, the stranger's probes and final reads of `totalSupply`, `owner()` and every watched
   balance, the stranger's included. A further request holds reads, more probes and reads.

   Every selector found in the new bytecode is probed with five argument shapes (the stranger, the stranger and a
   large number, a large number, none, a wide mix), plus empty and unknown-selector calldata. Every selector outside
   the standard token, ownable, proxy and initializer interface also gets 24 placement probes: the funded holder in
   each of the first four argument slots, the test amount in each other slot, the remaining slots filled once with
   the stranger and once with the proxy. The holder's and the stranger's balances are read right after each
   placement probe. A probe's own `Transfer` and `OwnershipTransferred` events count, and so does a holder balance
   read after a placement probe that is below its value before the probes, so a drain that emits no event, or that a
   later call undoes, still vetoes. If the probes do not fit, the verdict is R6, unless the approver approved the
   codehash: that excuses the truncation only (the placement probes of the last selectors are the ones left out),
   and every other rule still runs on the probes that fit.
5. **R9.** The opcode walker that extracts selectors also lists dangerous opcodes; any in the new code that the
   config's fixed `allowedOpcodes` (empty by default) does not list vetoes the upgrade unless its codehash is
   approved. The list never depends on the current implementation, so an approval covers one codehash and no later
   upgrade. The walker skips the solc metadata tail only when it decodes as an exact solc CBOR map, the instruction
   before it halts, and every JUMPDEST inside it is followed until execution halts; otherwise the whole code is
   scanned (fail closed). An `eth_simulateV1` call without validation runs with basefee and gas price 0, so this is
   what catches code that branches on them.
6. **Quorum.** At least `minAgree` providers must answer and every answer must be the same verdict and rule.
7. **Report.** Evidence, attestation, `writeReport`, then a read of the proposal to confirm the receiver's effect.

## Two modes: automatic and strict

The config's `strict` flag sets how an upgrade earns its clearance. In both modes the workflow clears nothing that
has not passed the attack simulation.

**Automatic mode** (`strict: false`, the default and the demo setting). CRE clears or vetoes every upgrade on its
own, with no human in the loop, through a bounded attack search on the proposed code at the proposal block:

| It probes | How |
|---|---|
| A caller that looks like a real user | The stranger, an EOA derived from the proposal block's hash, holds tokens from a second holder (sent at the start of every request, when a second holder has a balance) and 1 ETH by state override. It makes every call below except the plain transfer |
| A plain transfer | The test holder sends the test amount to a fresh receiver; it must succeed (R4) and move exactly that amount and nothing else (R3) |
| Allowances | Before any probe, the funded stranger calls `transferFrom(holder, stranger)` with no allowance; it must fail (R3B). That also catches a `transferFrom` that waives the allowance for callers holding tokens |
| Every selector in the new bytecode | Five base shapes: the stranger, the stranger and a large number, a large number, none, a wide mix of eight words; plus empty and unknown-selector calldata |
| Every new selector (outside the standard token, ownable, proxy and initializer interface) | 24 placement probes: the funded holder in each of the first four argument slots, the test amount in each other slot, the remaining slots filled once with the stranger and once with the proxy. That covers functions of up to four arguments in any order, and a `require(token == address(this))` guard |
| Balances, probe by probe | The holder's and the stranger's balances read right after each placement probe; every probe's own `Transfer` and `OwnershipTransferred` events; `totalSupply`, `owner()` and every watched balance before and after the probes of each request |

What that means: it catches every backdoor a funded outside caller reaches with those shapes. An open mint, an
ownership grab, a skimming transfer and a drain of a holder's tokens are all vetoed, the drain whatever its argument
order, with or without an event, gated on the caller holding tokens or ETH, and even when a later call puts the
tokens back. `EvilDrainImpl` and the seven drain variants of the fork end-to-end run are each caught by R3B alone.

**Strict mode** (`strict: true`, R5). Every new implementation codehash must be approved by the approver key
(`approveCodehash`) after a review of that exact code: an upgrade whose codehash is not approved by the proposal
block is vetoed R5. An approved codehash still runs the attack simulation and meets every other rule; the approval
exempts it from R9 and excuses probe truncation (R6), nothing more. A reviewed upgrade therefore still has to
survive the attack, and an attacker who holds the owner key also needs the approver's review.

**What each mode is for.** A bounded search catches what its callers and shapes reach. A backdoor behind a magic
value (a drain that opens for one exact argument), a call counter (one that opens on the hundredth call), a
dynamically encoded argument (`bytes`, an array or a struct the probes do not build), more arguments than the
placement probes fill, or a specific caller (a contract, a hard-coded address) is outside a bounded search. That
is what strict mode is for: a person reviews the code once, the approval binds that review to one codehash, and the
simulation still runs on every proposal. Automatic mode fits a token that wants routine upgrades cleared in
minutes; strict mode fits one where every upgrade is reviewed anyway, and makes that review part of the clearance.

## Why consensus carries only the verdict and the rule

The node-mode function returns `stableStringify({verdict, rule})` to `consensusIdenticalAggregation`, and nothing
else.

- **Identical aggregation needs identical bytes.** Nodes reach the same providers at different moments. One node
  may see a timeout or a rate limit where another gets an answer, and error strings, timings and which provider's
  detail gets reported can differ. If any of that were in the observation, honest nodes would disagree and the
  run would end without a verdict. `{verdict, rule}` is deterministic for honest providers: the simulation is
  pinned to the proposal block, the actors are derived from chain data, and a provider error removes an answer
  instead of changing it. A run in which the nodes still cannot agree ends without a report, which leaves the
  proposal without a clearance.
- **The rest is detail, not decision.** Per-provider answers, failed checks with before and after values, culprit
  selectors and the flagged R9 opcodes go to the node logs. None of them changes what happens on chain.
- **The evidence is rebuilt from the chain.** After consensus every node builds the same canonical evidence JSON
  from `getProposal` fields, `proposalDigest` and the agreed verdict, hashes it, and signs it with a deterministic
  (RFC 6979) signature. Every node therefore produces a byte-identical report payload, and anyone can recompute
  every evidence hash later from chain data alone
  ([`cre/veto/tools/check-evidence.ts`](../cre/veto/tools/check-evidence.ts)).
- **It is small.** The largest consensus value is 52 bytes, against a 25 kb observation limit.

## Report binding

```
report          = abi.encode(uint8 action, uint256 proposalId, bytes32 proposalDigest, bytes32 ruleHash,
                             bytes32 evidenceHash, uint64 validUntilBlock, bytes signature)
                  action 0 = Veto (ruleHash = keccak256("GUARD/<rule>")), 1 = Clear (ruleHash = 0)
signature       = 65 bytes r||s||v by the attester over the EIP-712 digest of
                  Verdict(address airlockAdmin,uint8 action,uint256 proposalId,bytes32 proposalDigest,
                          bytes32 ruleHash,bytes32 evidenceHash,uint64 validUntilBlock)
                  domain ("AirlockReceiver", "1", chainId, receiver address)
proposalDigest  = keccak256(abi.encode(uint8 kind, address target, uint256 value, bytes32 codehash,
                                       bytes32 dataHash, uint64 proposedBlock))
evidenceHash    = keccak256(canonical evidence JSON, sorted keys, schema upgrade-airlock/evidence-v2)
validUntilBlock = max(readyBlock, current block) + reportGraceBlocks (50)
```

Each field closes one hole:

| Bound to | So that |
|---|---|
| chain id and receiver (EIP-712 domain) | a verdict for another chain or another deployment does not verify |
| `airlockAdmin` (in the struct) | a verdict for another airlock does not verify |
| `action` and `ruleHash` (signed) | a Veto cannot be turned into a Clear; a Clear with a rule is rejected (`RuleOnClear`) |
| `proposalDigest` | a verdict about one proposal's content cannot clear another proposal, or the same id after a reorg with other content |
| `validUntilBlock` | an old report cannot be held back and delivered much later; validity is in blocks, so it needs no clock |
| `evidenceHash` | the verdict is tied to a document anyone can rebuild and check |

`AirlockReceiver.onReport` checks, in order: the sender is the configured forwarder; the workflow metadata names
the expected workflow id and owner (when configured, as in a DON deployment, where the KeystoneForwarder backs the
metadata with DON signatures); the report is fresh; the signer is the attester; the action is 0 or 1; a Clear has
no rule; the digest matches `AirlockAdmin.proposalDigest(id)`. Only then does it emit `Verdict` and call `clear`, or
`veto` and `attachReason`. A replayed Veto is harmless (`veto` is idempotent), and a replayed Clear keeps the first
evidence hash and is refused once the proposal has executed.

Approval keys, all registered with `approveCodehash` and read at the proposal block
([`cre/veto/keys.ts`](../cre/veto/keys.ts)):

| Key | For |
|---|---|
| the codehash | R5 in strict mode, the R9 exemption, and probes that do not fit (R6) |
| `keccak256(abi.encode(codehash, dataHash))` | R8, an upgrade with init data |
| `keccak256(abi.encode(uint8 kind, address target, uint256 value))` | R7, a change to the airlock |

## Budgets

CRE limits every workflow run (`cre workflow limits export`). The workflow plans against them instead of hoping:

| Limit | Value | How the workflow stays inside it |
|---|---|---|
| ChainRead calls | 15 per run | Reads go through Multicall3 in batches. Log path: 5 calls for an upgrade (latest header, proposal state, reads at the proposal block, the proposal block's header, the confirmation), 4 for a config change. Sweeper: 1 header, 1 `nextId`, 4 for the 20-id scan (`getProposal`, `clearanceOf`, `oracleJudged`; `sweepWindow` is capped at 30), then 3 per upgrade and 2 per config change. Each judgement checks the remaining budget first and defers when it does not fit; a budget that still runs out ends the run with a log line |
| ChainRead payload | 5 kb | Each batch's request and response stay under 4,096 bytes. Init data is never read: R8 needs only `dataHash` |
| HTTP calls | 15 per run | 1 + `simRequests` per provider: 12 with the four Sepolia providers; the config refuses more than 15. One attack simulation per run; static and config verdicts need no HTTP |
| HTTP request size | 120 kb | Each `eth_simulateV1` request holds at most `maxCalls` calls and 88,000 bytes of JSON (117,336 base64-encoded). A placement probe takes three calls (the probe and two balance reads). At the live `maxCalls` of 150, EvilDrain's 130 probes (16 selectors, 2 outside the standard interface) go out as two requests |
| Consensus observation | 25 kb | `{verdict, rule}`, at most 52 bytes |
| Log trigger event size | 5 kb | A larger `Proposed` event is left to the sweeper |
| Cron interval | at least 30 s | every 60 s |
| Execution time | 5 min | One simulation per run; the server's sweep unit stops a run after 6 minutes |
| Secrets calls | 5 per run | The attester key is fetched once per run |
| Log line | 1 kb | Lines are clipped at 900 characters |

On chain, a report runs under a 2,000,000 gas limit. In the fork end-to-end run (an anvil fork of Sepolia, which
charges what live Sepolia charges), a Veto report (`onReport`, `veto`, `attachReason`) used 426,000 to 524,000 gas,
a Clear report 191,000 to 397,000, and `execute` of the v2 upgrade, codehash recheck included, 70,000.
