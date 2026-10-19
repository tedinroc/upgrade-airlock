# Sepolia operator kit

Scripts that run the Upgrade Airlock demo on Ethereum Sepolia: deploy the stack, run the Chainlink CRE workflow
(the listener and the sweeper), propose honest and malicious changes, execute the honest one, and show the result.
Every script also runs against a local anvil chain with `FORK=<port>`, so the whole demo can be rehearsed, or
replayed offline, without spending anything.

An upgrade passes two doors in `AirlockAdmin`: a cooldown (`delayBlocks`, 25 blocks, during which any guardian can
veto) and a clearance. The CRE workflow judges every proposal and answers on chain through `AirlockReceiver`, which
is both the clearance oracle and a guardian: a pass becomes a Clear report (`clearanceOf[id]` = the evidence hash),
a failed check a Veto report (status Vetoed, with the rule and the evidence hash). `execute` needs both doors open
and the target's code unchanged since the proposal. A proposal nobody judged has no clearance and cannot execute,
so a missed event delays an upgrade; it never lets one through. `oracleJudged[id]` records whether the CRE itself
has answered: the sweeper keeps judging a proposal the approver cleared by hand, and a CRE veto still wins.

| Script | What it does |
|---|---|
| `deploy.sh` | Deploys the stack (`script/DeployEth.s.sol`, 13 transactions) and writes `deployments/sepolia.json` |
| `make-config.mjs` | Turns the deployment into the workflow config `cre/veto/config.sepolia.json` (run it with bun) |
| `fund-sender.sh [eth] [role]` | Owner sends ETH to the report sender (or `sweeper`, `approver`, `emergency`) |
| `airlock.sh [stop]` | The listener: the workflow's log trigger in listen mode. Every `Proposed` event is judged and answered with a Clear or a Veto report |
| `sweep.sh` | One sweeper run: the workflow's cron handler. Judges proposals that are still Pending without a CRE verdict (`oracleJudged` false: the listener was down, the log was too big to deliver, or the approver cleared it by hand). Exits at once when nothing waits |
| `propose.sh <card>` | Owner proposes a demo card, then waits for the verdict on chain and prints rule, evidence and report tx |
| `execute.sh <id>` | Executes a cleared proposal after its cooldown. When `execute` would revert (vetoed, not cleared, `CodehashChanged`) it sends nothing and shows the revert |
| `clear.sh <id> [note]` | The human approver clears a proposal by hand (the fallback when CRE cannot give a verdict); the CRE still judges it afterwards |
| `status.sh [N]` | The last N proposals: Pending / Cleared / Vetoed / Executed, who gave the verdict, whether the CRE has judged it (`cre`), rule, evidence, txs |
| `fork.sh start\|save\|load\|stop` | A local fork of Sepolia with 12 s blocks, a snapshot of it, or an offline replica from a snapshot |
| `probe-rpcs.ts` | Read-only: runs the workflow's own judging code against every RPC provider and times it |
| `gas-replay.ts` | Read-only: replays a fork rehearsal on live Sepolia (`eth_simulateV1`) to compare gas and check every report lands |
| `systemd/` | User units for a Linux server: `airlock-listener.service`, `airlock-sweep.service` + `.timer`, `install.sh`, `uninstall.sh` |
| `lib.sh` | Shared helpers: modes, key loading, chain checks, event decoding |

The cards for `propose.sh`:

| Card | What the proposal does | Expected verdict |
|---|---|---|
| `v2` | Honest upgrade (adds `version()`) | Cleared by the CRE receiver; executable after the cooldown |
| `evil-mint` | Anyone can mint | Vetoed, `R1_TOTAL_SUPPLY` |
| `evil-owner` | Anyone can take ownership | Vetoed, `R2_OWNER` |
| `evil-fee` | Transfers skim a fee | Vetoed, `R3_TRANSFER_CONSERVATION` |
| `evil-basefee` | Behaves like v1 while `block.basefee == 0` (as in a simulation), lets anyone mint on a real block | Vetoed, `R9_NEW_OPCODES` (the new `BASEFEE` opcode), although the simulation itself finds nothing |
| `evil-drain` | v1 plus `rescue(from, to, amount)`: anyone moves a holder's tokens without an allowance. Supply, owner, transfers and opcodes are those of v1 | Vetoed, `R3B_THIRD_PARTY_FUNDS`: the funded stranger calls the new selector with the holder in the argument slots, and the call with the holder as `from` moves the holder's balance |
| `remove-receiver` | `proposeSetGuardian(receiver, false)`: drop the CRE receiver from the guardians | Vetoed, `R7_CONFIG_GUARD` (weakening change without the approver's pre-approval) |

## Before you start

- Tools: `cre/setup.sh` (CRE CLI and bun), Foundry (`forge`, `cast`, `anvil`), `jq`, `bc` and Node 22.
- Keys: `KEY_DIR`, which defaults to `$HOME/.config/ethsz-2026`, holds one hex private key per file:

  | File | Role |
  |---|---|
  | `owner.key` | Deploys, proposes, executes. It can only propose: it is never a guardian, the approver or the clearance oracle |
  | `attester.key` | Signs the EIP-712 verdicts `AirlockReceiver` accepts (a CRE secret) |
  | `sender.key` | Pays the CRE `writeReport` transactions |
  | `approver.key` | `AirlockAdmin.approver`: manual clearance (`clear.sh`) and the codehash registry |
  | `emergency.key` | The second guardian: a human veto and `breakGlass` |
  | `sweeper.key` (optional) | Pays the sweeper's reports, so the sweeper and the listener never race for one nonce |

  `deploy.sh` refuses to run when `approver.key` or `emergency.key` is missing, or when owner, approver, emergency
  guardian and attester are not four different addresses. It passes `ALLOW_MOCK_FORWARDER=1`, because the CRE
  simulator writes through the permissionless MockKeystoneForwarder; `DeployEth` refuses the mock without it (or
  without `WORKFLOW_ID` and `WORKFLOW_OWNER`). The scripts read the key files at run time and never print
  a key; only addresses are shown. forge and the simulator get keys through environment variables. `cast` takes
  them as a command-line argument (to derive addresses and in `cast send`), so a key shows in the process list
  while that call runs.
- Simulator: `airlock.sh` and `sweep.sh` run `CRE_SIM`, which defaults to `cre`. The official CLI needs a logged-in
  session for `workflow simulate`. A login-free build of the same CLI works too: set `CRE_SIM=<path>`. Both
  scripts compile the workflow once per source version (`cre workflow build`, about 30 s) and run that binary
  (`--wasm`), so a sweep does not recompile every minute and a restarted listener is ready in about 2 s. The binary
  lives in `<state dir>/wasm/`, or in `$TMPDIR/airlock-wasm-<uid>/` when that path would be longer than the 97
  characters the CLI accepts for `--wasm`. `WASM_CACHE=0` turns the cache off.
- Modes: with no `FORK`, the scripts talk to live Sepolia through `SEPOLIA_RPC` (default publicnode). With
  `FORK=<port>` they talk only to the anvil on `127.0.0.1:<port>`, and they refuse to run if that node is not anvil.
- State dir: live mode keeps logs, PID files and the compiled workflow in `$TMPDIR/upgrade-airlock-sepolia/`
  (`AIRLOCK_STATE` overrides it; the systemd units set it to `~/.local/state/upgrade-airlock`). Fork mode always
  uses `$TMPDIR/upgrade-airlock-fork-<port>/` and changes nothing under the repo.

## Demo day, live Sepolia

### The day before (about 20 minutes)

| # | Command | Prints | Time |
|---|---|---|---|
| 1 | `FORCE=1 YES=1 scripts/sepolia/deploy.sh` | The five role addresses, `n/13 confirmed` per block, the post-deploy checks, the address list with Etherscan links and the gas used | about 3 min (13 transactions, one per block; 96M gas) |
| 2 | `bun scripts/sepolia/make-config.mjs` | `wrote cre/veto/config.sepolia.json (checked against cre/veto/config.ts)`, providers, quorum, sweeper schedule | <1 s |
| 3 | `scripts/sepolia/fund-sender.sh 0.05` (and `0.01 approver` for the manual fallback) | Transfer link, both balances, how many reports that covers | one block, ~12 s |
| 4 | `bun scripts/sepolia/probe-rpcs.ts` | One row per provider and card plus a quorum row per card, the HTTP calls per upgrade, then `PROBE: ALL OK` (evilMint R1, evilOwner R2, evilFee R3, evilBaseFee R9, evilDrain R3B, v2 pass) | about a minute (6 cards on 4 providers; not timed on live yet) |
| 5 | A full rehearsal on a fork (below), then `fork.sh save` for the offline fallback | | ~15 min |

`deploy.sh` with `FORCE=1` replaces `deployments/sepolia.json` (git keeps the old file). Alternatively deploy with
`OUT_JSON=deployments/<name>.json` and run the other scripts with `DEPLOY_JSON=<that file>`, passing the same file
to `make-config.mjs`.

### Start the airlock

Either on the demo laptop, in terminal A:

```bash
scripts/sepolia/airlock.sh          # the listener; Ctrl-C or `airlock.sh stop` ends it
# the sweeper, if wanted, in terminal C:  while :; do scripts/sepolia/sweep.sh; sleep 60; done
```

or on a Linux server, once (current user only, no sudo):

```bash
scripts/sepolia/systemd/install.sh  # writes ~/.config/upgrade-airlock/airlock.env, installs, enables and starts
set -a; . ~/.config/upgrade-airlock/airlock.env; set +a   # in every operator shell, so the scripts share the state dir
LINGER=1 scripts/sepolia/systemd/install.sh   # once, so the services survive logout (loginctl enable-linger)
```

The listener prints a header (AirlockAdmin, receiver, attester, sender balance, providers), then the simulator's
`Listening for logs starting at block N`. It is ready about 2 s after start with a compiled binary, and about
30 s after a source change (one compile). Start it a few minutes before going on stage. The simulator ends
listen mode when one workflow run fails (an RPC timeout, for example); `airlock.sh` starts it again after 5 s,
and the systemd unit restarts `airlock.sh` itself 5 s after any exit. The timer starts a sweep at second 0 of
every minute.

### On stage (12 s blocks)

| # | Terminal B | Prints | Time on 12 s blocks |
|---|---|---|---|
| 0 | `scripts/sepolia/status.sh` | Proposals so far, the proxy's implementation, `receiver is guardian: true` | ~10 to 20 s on a public RPC |
| 1 | `scripts/sepolia/propose.sh v2` | `proposed #id ... executable from block B (+25 blocks, ~5m00s at 12 s blocks) once cleared`, then `CLEARED #id by CRE receiver` with the evidence hash and the report tx | mined in ≤12 s; cleared 1 block later: 24 s from the command to `CLEARED` |
| 2 | `scripts/sepolia/propose.sh evil-mint` | `VETOED #id by CRE receiver: R1_TOTAL_SUPPLY, in block B (+n blocks, ...)`, evidence, report tx | 22 to 36 s each: mined in ≤12 s, vetoed 1 block later (2 blocks when a provider times out) |
| 3 | `scripts/sepolia/propose.sh evil-owner` | ... `R2_OWNER` | same |
| 4 | `scripts/sepolia/propose.sh evil-fee` | ... `R3_TRANSFER_CONSERVATION` | same |
| 5 | `scripts/sepolia/propose.sh evil-basefee` | ... `R9_NEW_OPCODES`: the simulation sees an honest token (base fee 0), the opcode check sees `BASEFEE` | same |
| 6 | `scripts/sepolia/propose.sh evil-drain` | ... `R3B_THIRD_PARTY_FUNDS`: every v1 invariant holds, the probe of `rescue` with the holder as `from` moves the holder's balance | same |
| 7 | `scripts/sepolia/propose.sh remove-receiver` | ... `R7_CONFIG_GUARD` (a config change: chain reads only, no attack simulation) | 26 s, vetoed 1 block later |
| 8 | `scripts/sepolia/execute.sh <evil-mint id>` | `#id (upgrade evilMint) is Vetoed with R1_TOTAL_SUPPLY; nothing sent:`, then `execute(id) reverts ProposalVetoed(id)` | ~2 s |
| 9 | `scripts/sepolia/execute.sh <v2 id>` | Waits for the ready block, then `EXECUTED #id`, `proxy implementation v1 -> v2`, `token version() = "2"` | the cooldown ends 25 blocks (~5 min) after step 1, then one block |
| 10 | `scripts/sepolia/status.sh` | The final table: every verdict, whether the CRE judged it, rule, evidence hash and transaction | ~10 to 20 s |

Propose `v2` first, so its 5-minute cooldown runs while you show the six vetoes (steps 2 to 7 take about
3 minutes together). Each `propose.sh` exits 0 only when the outcome is the expected one. A verdict report is
accepted on chain until `max(readyBlock, the block it was signed in) + 50` blocks.

Optional, the sweeper: stop the listener (`airlock.sh stop`, or `systemctl --user stop airlock-listener`), propose a
card with `WAIT_SECS=150`, and the sweeper judges it on its next run: within 60 s after the proposal is 3 blocks old
(with the timer), or at once with `SWEEP_MIN_AGE=0 scripts/sepolia/sweep.sh`. Start the listener again afterwards.

## Rehearsal on a fork

The same sequence with nothing spent; blocks come every 12 s, as on Sepolia:

```bash
export FORK=19631
scripts/sepolia/fork.sh start                     # anvil --fork-url <sepolia> --block-time 12
scripts/sepolia/deploy.sh                         # funds the demo keys with anvil_setBalance, deploys 13 transactions
scripts/sepolia/airlock.sh &                      # target sepolia-fork, config generated in the state dir
for c in v2 evil-mint evil-owner evil-fee evil-basefee evil-drain remove-receiver; do scripts/sepolia/propose.sh $c; done
scripts/sepolia/airlock.sh stop
WAIT_SECS=60 scripts/sepolia/propose.sh evil-mint # no listener: times out, the proposal stays Pending
SWEEP_MIN_AGE=0 scripts/sepolia/sweep.sh          # the sweeper judges it
scripts/sepolia/execute.sh <evil id>              # shows ProposalVetoed, sends nothing
scripts/sepolia/execute.sh <v2 id>                # fork mode mines the remaining cooldown (anvil_mine)
scripts/sepolia/status.sh
bun scripts/sepolia/gas-replay.ts                 # the same transactions on live Sepolia via eth_simulateV1, read-only
scripts/sepolia/fork.sh save ~/airlock-snapshot   # keep it for the offline fallback
scripts/sepolia/fork.sh stop
```

Rehearsal results (2026-10-19, fork of Sepolia at block 11949110, 12 s blocks, the demo key directory, the
login-free simulator build, workflow source as of that morning):

| Step | Result |
|---|---|
| deploy | 12 transactions in 2 min 53 s, 87,060,408 gas. The post-deploy checks passed (roles distinct, receiver = clearance oracle and guardian) |
| refusals | With a test key directory: a missing `approver.key` or `emergency.key`, approver = owner, emergency = owner and approver = emergency each stopped `deploy.sh` before any chain call |
| listener | Listening 2 s after start with the compiled binary. One compile (`cre workflow build`, done once per source version) took 27 s |
| v2 | Cleared by the CRE receiver 1 block after the proposal, 24 s from the command. Executed after the cooldown: v1 -> v2, `version()` = "2" |
| evil-mint / evil-owner / evil-fee / evil-basefee | Vetoed with R1 / R2 / R3 / R9 (naming `BASEFEE`), 1 block after the proposal (evil-owner 2 blocks: one fork provider timed out, the 2-of-3 quorum held). 22 to 36 s each |
| remove-receiver | Vetoed with R7, 1 block after the proposal, 26 s |
| sweeper | With the listener stopped, an evil-mint and a v2 proposal stayed Pending. Sweep 1 (43 s, including a 27 s compile) vetoed the evil-mint with R1 and deferred v2 (one simulation per run); sweep 2 (19 s) cleared v2; an idle sweep took 1 s and started no simulator |
| execute | A vetoed id: `ProposalVetoed`, nothing sent. Before a clearance: `TooEarly` / `NotCleared`, nothing sent. An approver clearance (`clear.sh`) then `execute.sh` mined the 24 remaining blocks and executed |
| providers | `probe-rpcs.ts` against the fork: R1 / R2 / R3 / R9 / pass on all three providers, `PROBE: ALL OK`; 6 HTTP calls per upgrade (limit 15), consensus value at most 52 bytes |
| gas | `gas-replay.ts`: all 30 transactions replayed on live Sepolia state at the fork block with the same gas as on the fork, every report landed (`GAS REPLAY: ALL OK`). `proposeUpgrade` 593,654; `proposeSetGuardian` 482,188; Veto report 413,644 to 413,668 (21 % of the 2,000,000 `gasLimit`); Clear report 189,178 to 287,074; `execute` 67,995. The largest deploy transaction asks for a 20.7M gas limit (AirlockAdmin, 16.0M used) |
| offline replica | `fork.sh save` then `fork.sh load` on another port: the listener vetoed an evil-fee (R3) and cleared a v2 with no upstream RPC. A killed simulator was restarted by `airlock.sh` 5 s later and judged the next proposal |
| systemd | In a local Ubuntu 24.04 container with systemd: `install.sh` as a normal user, `systemd-analyze --user verify` clean, the listener restarted every 5 s while it could not start, the timer fired at second 0 of each minute, `uninstall.sh` removed every unit |

A second rehearsal covered what came after: `EvilDrainImpl`, `oracleJudged`, the codehash recheck and the
holder-first probes of that morning (2026-10-19, fork of Sepolia at block 11949615, `BLOCK_TIME=2`, the same keys
and simulator):

| Step | Result |
|---|---|
| deploy | 13 transactions in 45 s, 95,725,264 gas; the post-deploy checks passed |
| hand clearance | With no listener, `evil-drain` and `evil-fee` were proposed and cleared by `clear.sh`; `status.sh` showed both `Cleared`, `cre no` |
| sweeper | Sweep 1 vetoed the hand-cleared EvilDrain with R3B (culprit `rescue` `0x20ff430b` probed as holder, stranger, amount; 130 probes over 16 selectors in 2 requests). Sweep 2 vetoed the hand-cleared EvilFee with R3. An idle sweep found nothing to judge |
| listener | `propose.sh evil-drain`: vetoed R3B 2 blocks after the proposal. `propose.sh v2`: cleared 3 blocks after, then executed (v1 -> v2, `version()` = "2"). `execute.sh` on the EvilDrain id sent nothing (`ProposalVetoed`) |
| codehash swap | A cleared proposal whose target code was replaced with `anvil_setCode`: `execute.sh` sent nothing and showed `CodehashChanged` (owner nonce unchanged) |
| providers | `probe-rpcs.ts` against the fork: R1 / R2 / R3 / R9 / R3B / pass on all three providers, `PROBE: ALL OK`, 9 HTTP calls per upgrade (limit 15) |
| war room | Served against the fork deployment: the EvilDrain card, the hand clearance with "CRE still judges it", then the R3B ejection |

## When something fails

- **A provider is down or rate-limited.** Run `probe-rpcs.ts`, then regenerate the config with the providers that
  answer, for example `bun scripts/sepolia/make-config.mjs --providers publicnode,drpc,thirdweb,0xrpc`, and restart
  the listener (`airlock.sh`, or `systemctl --user restart airlock-listener`). At least `minAgree` (2) providers
  must answer and every answer must agree; otherwise the workflow fails closed with `R6_SIM_FAILURE`, which would
  also veto the honest v2. An error only costs time, because errors are left out of the quorum.
- **The listener is down.** Nothing passes unjudged: the proposal stays Pending without a clearance, and the
  sweeper judges it on its next run (the timer, or `sweep.sh` by hand; `SWEEP_MIN_AGE=0` takes it at once). The
  sweeper looks at the newest 20 proposal ids (`sweepWindow`) and does at most one attack simulation per run (the
  CRE HTTP budget); several missed upgrades take one run each.
- **CRE cannot give a verdict at all** (simulator, providers or the report sender broken). `v2` can still go live:
  `scripts/sepolia/clear.sh <v2 id> "manual clearance: <reason>"` records the approver's clearance, then
  `execute.sh` as usual. Say so on stage: the clearance is by a human, its evidence JSON is printed. Until it
  executes, the sweeper still judges it once CRE is back (`status.sh` shows `cre no` until then), and a CRE veto
  wins over the hand clearance.
- **Sepolia or the venue network is down: the offline replay.**
  - Chain replica: the night before, after the rehearsal, `FORK=19631 scripts/sepolia/fork.sh save ~/airlock-snapshot`.
    On stage `FORK=19632 scripts/sepolia/fork.sh load ~/airlock-snapshot`, then the same `airlock.sh`, `propose.sh`,
    `execute.sh` and `status.sh` with `FORK=19632`. The replica is anvil with `--load-state` and no upstream RPC;
    the snapshot holds the stack, the MockKeystoneForwarder, Multicall3 (which `save` carries over on purpose:
    the workflow only reads it, and anvil leaves unchanged accounts out of a dump) and the history. Tested in the
    rehearsal; not tested with the network unplugged (the simulator's update check needs the network but is not
    required).
  - War room: the web page's offline mode (`?mode=offline`, see `web/`) plays back a recorded run without any
    network connection.
- **The last resort.** Show `status.sh` output or the recorded evidence in `docs/evidence/`.
- **`airlock.sh` says the attester does not match.** `attester.key` is not the key baked into the deployed
  `AirlockReceiver`. Use the matching key directory, or deploy again.

## Running on a Linux server

`systemd/install.sh` installs three user units for the account that runs it (`~/.config/systemd/user/`; no sudo,
nothing system-wide):

| Unit | What it does |
|---|---|
| `airlock-listener.service` | `airlock.sh` in the foreground; `Restart=always`, `RestartSec=5`, no start-rate limit |
| `airlock-sweep.service` | One `sweep.sh` run (`Type=oneshot`, 6-minute limit: a CRE execution may take 5) |
| `airlock-sweep.timer` | Starts the sweep at second 0 of every minute (`OnCalendar`, `AccuracySec=1s`, `Persistent=true`) |

The units read `~/.config/upgrade-airlock/airlock.env`, which holds settings only (`KEY_DIR`, `CRE_SIM`,
`SEPOLIA_RPC`, `AIRLOCK_STATE`, `PATH`), never a key. `install.sh` writes it from the current shell on the first
run (`FORCE_ENV=1` rewrites it) and checks before installing that the attester and sender keys, the deployment, the
workflow config and the tools are in place. `DRY_RUN=1` prints the rendered units and changes nothing.
`uninstall.sh` stops, disables and removes the units (`--purge` also removes the env file); the logs in the state
dir stay.

```bash
systemctl --user status airlock-listener.service
systemctl --user list-timers airlock-sweep.timer
journalctl --user -u airlock-listener -f          # the simulator's output
journalctl --user -u airlock-sweep -n 50          # the last sweeps (also in $AIRLOCK_STATE/sweep.log)
```

## Safety

- Fork mode talks to loopback only, and only to anvil (`web3_clientVersion`). Live `deploy.sh` refuses to overwrite
  an existing deployment JSON without `FORCE=1`, asks you to type `deploy`, and needs `YES=1` when no terminal is
  attached.
- A fork deployment builds into the state dir and keeps forge's run cache there (`--out`, `--cache-path`), and
  `FOUNDRY_BROADCAST` keeps its broadcast logs out of `broadcast/`, so the live run's
  `cache/DeployEth.s.sol/11155111/` (which `forge script --resume` needs) is never touched.
- `airlock.sh` and `sweep.sh` hand the attester and sender keys to the simulator through environment variables only;
  their logs never contain them. After the rehearsal every log and every kit file was searched for the five demo
  keys: no match.
