#!/usr/bin/env bash
# End to end on a local anvil fork of Ethereum Sepolia: nothing is sent to a live network and no workflow is
# deployed. The stack is deployed on the fork, then the CRE workflow runs in the CRE CLI simulator with --broadcast
# (its reports go through Sepolia's MockKeystoneForwarder on the fork) and every outcome is checked on-chain.
#
#   handler 0, log trigger (the Proposed log replayed by tx hash):
#     EvilMint -> Vetoed R1, EvilOwner -> Vetoed R2, EvilFee -> Vetoed R3, EvilBaseFee -> Vetoed R9 (BASEFEE)
#     EvilDrain (an open rescue(from, to, amount); supply, owner and transfers intact) -> Vetoed R3B, caught by
#       the probe that puts the funded holder first
#     drain variants A-G (test/fixtures/DrainVariants.sol, each inheriting DemoBTC so only R3B can catch them):
#       A reordered args rescue(from, amount, to); B sweep(amount, from, to); C rescueTokens(token, from, to, amount)
#       with require(token == this); D rescue gated on the caller holding tokens; E rescue with no Transfer event
#       (out-and-back, net zero); F rescue gated on the caller holding ETH; G transferFrom that waives its allowance
#       check for a token-holding caller -> every one Vetoed R3B (the simulation funds the stranger with tokens and
#       ETH, probes new selectors with the holder in each argument slot, and reads balances after each placement probe)
#     honest v2 -> Cleared by CRE, executes after the cooldown
#     owner proposes removing the receiver as guardian -> Vetoed R7 (the approver is a separate key)
#     the approver pre-approves a shorter delay, the owner proposes it -> Cleared
#   handler 1, cron sweeper (the simulator runs a cron handler once per invocation):
#     an honest upgrade nobody judged cannot execute after the cooldown (NotCleared); one sweeper run clears it
#     the approver clears two proposals by hand and their logs are missed: the sweeper still judges both (an
#       approver clearance is not a CRE verdict, AirlockAdmin.oracleJudged): EvilDrain -> Vetoed R3B (the veto wins
#       over the clearance), a longer delay -> CRE Clear, clearanceOf keeps the approver's evidence
#     an upgrade with ~6 KB of init data -> one sweeper run vetoes it R8 (its Proposed log is over CRE's 5 kb log
#     event limit, so in a deployment only the sweeper sees it; the simulator does not enforce that limit)
#   every verdict's evidenceHash is recomputed from getProposal alone (veto/tools/check-evidence.ts)
# maxCalls 150 (the live Sepolia value) splits the demo token's probes over two eth_simulateV1 requests per provider.
#
# Env: CRE_SIM      simulator binary (default `cre`, which needs `cre login`; a login-free build of the same CLI works)
#      SEPOLIA_RPC  fork source (default publicnode)
#      VETO_ANVIL_PORT (default 19611), KEEP_FORK=1 leaves the anvil fork running at the end
# Keys: anvil's public test mnemonic only: 0 owner/deployer, 2 attester, 3 report sender, 4 approver,
#       5 emergency guardian. Nothing secret.
set -euo pipefail
cd "$(dirname "$0")/.."            # cre/
ROOT=$(cd .. && pwd)
export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$HOME/.foundry/bin:$PATH"
SIM=${CRE_SIM:-cre}
PORT=${VETO_ANVIL_PORT:-19611}
RPC=http://127.0.0.1:$PORT
SRC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
M="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$M" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$(key "$1")"; }
DPK=$(key 0)
OWNER=$(addr 0)
export VETO_ATTESTER_KEY_ALL=$(key 2)
export CRE_ETH_PRIVATE_KEY=$(key 3)
APPROVER=$(addr 4)
EMERGENCY=$(addr 5)
export VETO_ANVIL_PORT=$PORT
OUT=$(mktemp -d "${TMPDIR:-/tmp}/airlock-fork-e2e.XXXXXX")
echo "evidence dir: $OUT"

anvil --fork-url "$SRC" --port "$PORT" --silent >"$OUT/anvil.log" 2>&1 &
ANVIL=$!
echo "$ANVIL" >"$OUT/anvil.pid"
if [ "${KEEP_FORK:-0}" = 1 ]; then echo "anvil fork pid $ANVIL on $RPC (KEEP_FORK=1: stop it with kill $ANVIL)"
else trap 'kill $ANVIL 2>/dev/null || true' EXIT; fi
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$RPC")" = 11155111 ] || { echo "fork is not Sepolia" >&2; exit 1; }

# Deploy. Sepolia runs the Amsterdam rules (contract creation costs ~7x Osaka): the node estimates gas
# (--skip-simulation). Build output and broadcast logs stay in $OUT; the JSON goes through cache/ (foundry
# fs_permissions) under a per-run name and is moved out.
DJSON="cache/airlock-fork-e2e.$$.json"
# The simulator writes through the permissionless MockKeystoneForwarder (the attester alone authenticates a verdict):
# DeployEth refuses it without ALLOW_MOCK_FORWARDER=1, and refuses an attester shared with another role.
( cd "$ROOT" && FOUNDRY_PROFILE=eth FOUNDRY_BROADCAST="$OUT/broadcast" DEPLOYER_PK=$DPK ATTESTER_ADDR=$(addr 2) \
  APPROVER_ADDR=$APPROVER EMERGENCY_GUARDIAN_ADDR=$EMERGENCY ALLOW_MOCK_FORWARDER=1 OUT_JSON=$DJSON \
  forge script script/DeployEth.s.sol --rpc-url "$RPC" --broadcast --slow --skip-simulation \
    --out "$OUT/forge-out" --cache-path "$OUT/forge-cache" >"$OUT/deploy.log" 2>&1 ) \
  || { tail -30 "$OUT/deploy.log"; exit 1; }
mv "$ROOT/$DJSON" "$OUT/deployment.json"
D="$OUT/deployment.json"
GA=$(jq -r .airlockAdmin "$D"); RX=$(jq -r .receiver "$D"); PROXY=$(jq -r .proxy "$D"); DELAY=$(jq -r .delayBlocks "$D")
echo "AirlockAdmin $GA  AirlockReceiver $RX  proxy $PROXY  delay $DELAY blocks"
jq --arg rpc "$RPC" '{chainSelectorName:"ethereum-testnet-sepolia", chainId, airlockAdmin, receiver, proxy, holders,
  watch:[.owner,.airlockAdmin], rpcs:[{url:$rpc,label:"fork-a"},{url:$rpc,label:"fork-b"},{url:$rpc,label:"fork-c"}],
  minAgree:2, strict:false, callGas:1000000, readGas:200000, maxCalls:150, simRequests:2, allowedOpcodes:[],
  gasLimit:"2000000", reportGraceBlocks:50, logConfidence:"LATEST", sweepSchedule:"0 * * * * *", sweepWindow:20}' \
  "$D" > veto/config.fork.json
cp veto/config.fork.json "$OUT/config.fork.json"
# Compile the workflow once (TypeScript typecheck + WASM); every simulator run below reuses the binary.
"$SIM" workflow build ./veto -T sepolia-fork -o "$OUT/airlock.wasm" >"$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; exit 1; }

ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
rule_hash() { cast keccak "GUARD/$1"; }
status_of() { cast call "$GA" "getProposal(uint256)((uint8,uint8,address,address,uint256,bytes32,bytes32,uint64,uint64,uint256))" "$1" --rpc-url "$RPC" | sed -E 's/^\(([0-9]+), ([0-9]+),.*/\2/'; }
clearance_of() { cast call "$GA" "clearanceOf(uint256)(bytes32)" "$1" --rpc-url "$RPC"; }
judged_of() { cast call "$GA" "oracleJudged(uint256)(bool)" "$1" --rpc-url "$RPC"; }
last_id() { echo $(( $(cast call "$GA" "nextId()(uint256)" --rpc-url "$RPC") - 1 )); }
# "action ruleHash evidenceHash" of the newest AirlockReceiver.Verdict for proposal $1 (empty if none)
verdict_of() {
  cast logs --from-block "$(jq -r .startBlock "$D")" --to-block latest --address "$RX" \
    "Verdict(uint256 indexed,uint8 indexed,bytes32,bytes32,bytes32)" "$(cast to-uint256 "$1")" --rpc-url "$RPC" --json \
    | jq -r 'last // empty | "\(.topics[2] | ltrimstr("0x") | sub("^0+";"") | if . == "" then "0" else . end) 0x\(.data[2:66]) 0x\(.data[66:130])"'
}
user_logs() { grep -E '\[USER LOG\]' "$1" | sed 's/^.*\[USER LOG\] /  | /' | cut -c1-220; }
simulate() { # name trigger-index [tx-hash]
  local name=$1 idx=$2 tx=${3:-}
  local args=(workflow simulate ./veto -T sepolia-fork --non-interactive --trigger-index "$idx" --broadcast --wasm "$OUT/airlock.wasm")
  [ -n "$tx" ] && args+=(--evm-tx-hash "$tx" --evm-event-index 0)
  if ! "$SIM" "${args[@]}" >"$OUT/sim-$name.log" 2>&1; then
    bad "$name: simulator exited non-zero"; tail -25 "$OUT/sim-$name.log"; return 1
  fi
  user_logs "$OUT/sim-$name.log"
}
propose() { # name, then the cast send signature and args; prints "id tx"
  local name=$1; shift
  local tx; tx=$(cast send "$GA" "$@" --private-key "$DPK" --rpc-url "$RPC" --json | jq -r .transactionHash)
  echo "$name $(last_id) $tx" >>"$OUT/cases.txt"
  echo "$(last_id) $tx"
}
expect_veto() { # name id rule
  local v; v=$(verdict_of "$2"); local st; st=$(status_of "$2")
  read -r act rh ev <<<"${v:-x x x}"
  if [ "$st" = 2 ] && [ "$act" = 0 ] && [ "$rh" = "$(rule_hash "$3")" ]; then ok "$1: #$2 Vetoed by CRE with $3 (evidence $ev)"
  else bad "$1: #$2 status $st verdict '${v:-none}', expected Vetoed $3"; fi
  echo "$2" >>"$OUT/vetoed.txt"
}
expect_clear() { # name id
  local v; v=$(verdict_of "$2"); local st; st=$(status_of "$2"); local c; c=$(clearance_of "$2")
  read -r act rh ev <<<"${v:-x x x}"
  if [ "$st" = 1 ] && [ "$act" = 1 ] && [ "$rh" = "$ZERO" ] && [ "$c" = "$ev" ] && [ "$c" != "$ZERO" ]; then ok "$1: #$2 Cleared by CRE (clearanceOf = evidence $c)"
  else bad "$1: #$2 status $st clearance $c verdict '${v:-none}', expected Cleared"; fi
}
log_case() { # name impl rule
  local r; r=$(propose "$1" "proposeUpgrade(address,bytes)" "$2" 0x); read -r id tx <<<"$r"
  echo "-- $1: proposal #$id (log trigger)"
  simulate "$1" 0 "$tx" || return 0
  expect_veto "$1" "$id" "$3"
}
# forge create one of the test-only drain fixtures on the fork and print its address.
create_fixture() { # Contract -> deployed address
  ( cd "$ROOT" && FOUNDRY_PROFILE=eth forge create "test/fixtures/DrainVariants.sol:$1" \
      --rpc-url "$RPC" --private-key "$DPK" --broadcast \
      --out "$OUT/forge-out" --cache-path "$OUT/forge-cache" --json 2>>"$OUT/create.log" | jq -r .deployedTo )
}
# Deploy a drain variant, propose an upgrade to it, and expect it Vetoed R3B with every other rule passing.
variant_case() { # label Contract
  local label=$1 contract=$2 impl
  impl=$(create_fixture "$contract")
  if [ -z "$impl" ] || [ "$impl" = null ]; then bad "$label: forge create $contract failed"; tail -5 "$OUT/create.log"; return 0; fi
  echo "$label $impl" >>"$OUT/variants.txt"
  echo "-- $label: $contract at $impl (log trigger)"
  local r id tx; r=$(propose "$label" "proposeUpgrade(address,bytes)" "$impl" 0x); read -r id tx <<<"$r"
  simulate "$label" 0 "$tx" || return 0
  expect_veto "$label" "$id" R3B_THIRD_PARTY_FUNDS
  if grep -qE 'R1_TOTAL_SUPPLY|R2_OWNER|R3_TRANSFER_CONSERVATION|R4_TRANSFER_LIVENESS|R9_NEW_OPCODES' <(grep 'simulation veto' "$OUT/sim-$label.log"); then
    bad "$label: another rule failed too (expected R3B alone)"
  else ok "$label: supply, owner, transfers and opcodes all pass; only R3B fails"; fi
}

# ---- handler 0: log trigger
log_case evil-mint     "$(jq -r .evilMint "$D")"    R1_TOTAL_SUPPLY
log_case evil-owner    "$(jq -r .evilOwner "$D")"   R2_OWNER
log_case evil-fee      "$(jq -r .evilFee "$D")"     R3_TRANSFER_CONSERVATION
log_case evil-basefee  "$(jq -r .evilBaseFee "$D")" R9_NEW_OPCODES
if grep -q 'R9_NEW_OPCODES:.*found: BASEFEE' "$OUT/sim-evil-basefee.log"; then ok "evil-basefee: R9 names the BASEFEE opcode"
else bad "evil-basefee: the simulation log does not name BASEFEE"; fi
RESCUE=$(cast sig "rescue(address,address,uint256)")
log_case evil-drain    "$(jq -r .evilDrain "$D")"   R3B_THIRD_PARTY_FUNDS
# a placement probe with the holder in slot 0 (from) drains rescue; its effects include moved-others-funds
if grep -qE "$RESCUE\(h0,[^)]*\):[a-z+-]*moved-others-funds" "$OUT/sim-evil-drain.log"; then
  ok "evil-drain: the culprit is rescue $RESCUE, caught by a holder-in-slot-0 placement probe"
else bad "evil-drain: the simulation log does not name a rescue $RESCUE(h0,...):moved-others-funds culprit"; fi
if grep -qE 'R1_TOTAL_SUPPLY|R2_OWNER|R3_TRANSFER_CONSERVATION|R4_TRANSFER_LIVENESS|R9_NEW_OPCODES' <(grep 'simulation veto' "$OUT/sim-evil-drain.log"); then
  bad "evil-drain: another rule failed too (expected R3B alone)"
else ok "evil-drain: supply, owner, transfers and opcodes all pass; only R3B fails"; fi
if grep -q 'in 2 request(s)' "$OUT/sim-evil-drain.log"; then ok "simulation: the probes went out as two eth_simulateV1 requests per provider"
else bad "simulation: expected two eth_simulateV1 requests per provider at maxCalls 150"; fi

# ---- handler 0: the reviewer's R3B evasions. Each must still end Vetoed R3B, with every other rule passing.
variant_case variant-a VariantA_RescueReorder
variant_case variant-b VariantB_SweepReorder
variant_case variant-c VariantC_RescueTokensGuard
variant_case variant-d VariantD_RescueRequireTokens
variant_case variant-e VariantE_RescueNoLog
variant_case variant-f VariantF_RescueRequireEth
variant_case variant-g VariantG_TransferFromAllowanceSkip

# ---- request sizes against the CRE HTTP limits: DemoBTCV2 (honest) and the largest variant (4-arg rescueTokens)
echo "-- request sizes (DemoBTCV2 and the largest variant) vs the 120 kb request / 15 HTTP-call limits"
VC=$(awk '$1=="variant-c"{print $2}' "$OUT/variants.txt" 2>/dev/null)
if [ -n "$VC" ]; then
  ( cd veto && bun tools/measure-requests.ts "$RPC" "$D" "$OUT/config.fork.json" "DemoBTCV2=$(jq -r .v2 "$D")" "variant-c=$VC" ) | sed 's/^/  /' \
    || bad "measure: a request exceeds a CRE HTTP size limit"
else bad "measure: variant-c was not deployed"; fi

read -r V2ID tx <<<"$(propose honest-v2 "proposeUpgrade(address,bytes)" "$(jq -r .v2 "$D")" 0x)"
echo "-- honest-v2: proposal #$V2ID (log trigger)"
simulate honest-v2 0 "$tx" && expect_clear honest-v2 "$V2ID"

# Nobody judges this one: no log-trigger run.
read -r LATEID _ <<<"$(propose unjudged-v2 "proposeUpgrade(address,bytes)" "$(jq -r .v2 "$D")" 0x)"
echo "-- unjudged-v2: proposal #$LATEID (no workflow run)"

read -r GID tx <<<"$(propose drop-receiver "proposeSetGuardian(address,bool)" "$RX" false)"
echo "-- drop-receiver: proposal #$GID removes the receiver as guardian (log trigger)"
simulate drop-receiver 0 "$tx" && expect_veto drop-receiver "$GID" R7_CONFIG_GUARD

# The approver (its own key) pre-approves keccak256(abi.encode(uint8 kind=2, address 0, uint256 20)).
cast send "$GA" "approveCodehash(bytes32)" "$(cast keccak "$(cast abi-encode "f(uint8,address,uint256)" 2 0x0000000000000000000000000000000000000000 20)")" \
  --private-key "$(key 4)" --rpc-url "$RPC" >/dev/null
read -r DID tx <<<"$(propose approved-delay "proposeSetDelay(uint64)" 20)"
echo "-- approved-delay: proposal #$DID shortens the delay to 20 blocks, pre-approved by the approver (log trigger)"
simulate approved-delay 0 "$tx" && expect_clear approved-delay "$DID"

# ---- the cooldown passes
cast rpc anvil_mine "$(printf '0x%x' "$DELAY")" --rpc-url "$RPC" >/dev/null
if cast send "$GA" "execute(uint256)" "$V2ID" --private-key "$DPK" --rpc-url "$RPC" >/dev/null 2>&1 \
  && [ "$(cast storage "$PROXY" "$IMPL_SLOT" --rpc-url "$RPC" | cast parse-bytes32-address)" = "$(cast to-check-sum-address "$(jq -r .v2 "$D")")" ]; then
  ok "honest-v2: #$V2ID executed after $DELAY blocks, the proxy now runs v2"
else bad "honest-v2: #$V2ID did not execute"; fi
NOT_CLEARED=$(cast sig "NotCleared(uint256)")
if err=$(cast call "$GA" "execute(uint256)" "$LATEID" --from "$OWNER" --rpc-url "$RPC" 2>&1); then bad "unjudged-v2: #$LATEID would execute without a clearance"
elif grep -q "$NOT_CLEARED" <<<"$err"; then ok "unjudged-v2: #$LATEID cannot execute after the cooldown (NotCleared $NOT_CLEARED)"
else bad "unjudged-v2: #$LATEID execute reverted for another reason: $(tail -1 <<<"$err")"; fi

# ---- handler 1: the sweeper
echo "-- sweeper run 1"
if simulate sweep-1 1; then
  expect_clear unjudged-v2 "$LATEID"
  if cast send "$GA" "execute(uint256)" "$LATEID" --private-key "$DPK" --rpc-url "$RPC" >/dev/null 2>&1; then ok "unjudged-v2: #$LATEID executes once the sweeper cleared it"
  else bad "unjudged-v2: #$LATEID still cannot execute"; fi
fi

# The approver clears two proposals by hand, and the log trigger never runs for them.
MANUAL=$(cast keccak "approver: manual review")
read -r ADID _ <<<"$(propose approver-drain "proposeUpgrade(address,bytes)" "$(jq -r .evilDrain "$D")" 0x)"
read -r ACID _ <<<"$(propose approver-delay "proposeSetDelay(uint64)" 30)"
for id in "$ADID" "$ACID"; do cast send "$GA" "clear(uint256,bytes32)" "$id" "$MANUAL" --private-key "$(key 4)" --rpc-url "$RPC" >/dev/null; done
echo "-- approver-drain #$ADID (EvilDrain) and approver-delay #$ACID (delay 30) cleared by the approver, logs missed"
if [ "$(clearance_of "$ADID")" = "$MANUAL" ] && [ "$(judged_of "$ADID")" = false ] && [ "$(judged_of "$ACID")" = false ]; then
  ok "approver: #$ADID and #$ACID carry the approver's clearance, oracleJudged false"
else bad "approver: unexpected state before the sweep (clearance $(clearance_of "$ADID"), oracleJudged $(judged_of "$ADID")/$(judged_of "$ACID"))"; fi
echo "-- sweeper run 2"
if simulate sweep-2 1; then
  if grep -q "pending without a workflow verdict: #$ADID(approver-cleared) #$ACID(approver-cleared)\$" "$OUT/sim-sweep-2.log"; then
    ok "sweeper: run 2 picked up exactly the two approver-cleared proposals"
  else bad "sweeper: run 2 did not list exactly #$ADID and #$ACID as approver-cleared candidates"; fi
  expect_veto approver-drain "$ADID" R3B_THIRD_PARTY_FUNDS
  [ "$(judged_of "$ADID")" = true ] && ok "approver-drain: #$ADID oracleJudged after the CRE veto" || bad "approver-drain: #$ADID oracleJudged still false"
  v=$(verdict_of "$ACID"); read -r act rh ev <<<"${v:-x x x}"
  if [ "$(status_of "$ACID")" = 1 ] && [ "$act" = 1 ] && [ "$(judged_of "$ACID")" = true ] && [ "$(clearance_of "$ACID")" = "$MANUAL" ] && [ "$ev" != "$MANUAL" ]; then
    ok "approver-delay: #$ACID CRE Clear (evidence $ev) on top of the approver's; clearanceOf keeps the first, oracleJudged true"
  else bad "approver-delay: #$ACID status $(status_of "$ACID") verdict '${v:-none}' oracleJudged $(judged_of "$ACID") clearance $(clearance_of "$ACID")"; fi
fi

BIG=0x$(printf '%*s' 12288 '' | tr ' ' 'a')   # 6144 bytes of 0xaa
read -r BIGID _ <<<"$(propose big-init "proposeUpgrade(address,bytes)" "$(jq -r .v2 "$D")" "$BIG")"
echo "-- big-init: proposal #$BIGID with $(( (${#BIG} - 2) / 2 )) bytes of init data (no log-trigger run)"
echo "-- sweeper run 3"
simulate sweep-3 1 && expect_veto big-init "$BIGID" R8_INIT_DATA
if grep -q "pending without a workflow verdict: #$BIGID\$" "$OUT/sim-sweep-3.log"; then ok "sweeper: run 3 found only #$BIGID to judge"
else bad "sweeper: run 3 judged more than #$BIGID"; fi

# ---- a vetoed proposal never executes
cast rpc anvil_mine "$(printf '0x%x' "$DELAY")" --rpc-url "$RPC" >/dev/null
VETOED=$(cast sig "ProposalVetoed(uint256)")
for id in $(cat "$OUT/vetoed.txt" 2>/dev/null); do
  if err=$(cast call "$GA" "execute(uint256)" "$id" --from "$OWNER" --rpc-url "$RPC" 2>&1); then bad "#$id would execute although vetoed"
  elif grep -q "$VETOED" <<<"$err"; then ok "#$id execute() reverts ProposalVetoed after the cooldown"
  else bad "#$id execute reverted for another reason: $(tail -1 <<<"$err")"; fi
done

echo "-- evidence"
( cd veto && bun tools/check-evidence.ts "$RPC" "$D" ) | sed 's/^/  /' || bad "evidence: a verdict's evidenceHash does not match its proposal"

[ $fail = 0 ] && echo "FORK E2E: ALL PASS (logs in $OUT)" || { echo "FORK E2E: FAILURES (logs in $OUT)"; exit 1; }
