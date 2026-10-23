#!/usr/bin/env bash
# Deploy the Upgrade Airlock stack (script/DeployEth.s.sol) to Ethereum Sepolia with the demo keys.
#
#   scripts/sepolia/deploy.sh                    # live Sepolia -> deployments/sepolia.json, broadcast/
#   FORK=19631 scripts/sepolia/deploy.sh         # identical flow on a local anvil fork -> $TMPDIR only
#
# Keys (KEY_DIR, default $HOME/.config/ethsz-2026):
#   owner.key      deploys and becomes the demo owner (it can only propose)
#   attester.key   its address is baked into AirlockReceiver (the EIP-712 verdict signer)
#   approver.key   its address becomes AirlockAdmin.approver (manual clearance, codehash registry)
#   emergency.key  its address becomes the second guardian (a human veto, breakGlass)
#   sender.key     pays the CRE writeReport transactions (only its balance is checked here)
# The run refuses when approver.key or emergency.key is missing, or when owner, approver, emergency guardian and
# attester are not four different addresses (DeployEth refuses the same again before it sends anything).
# The CRE simulator writes through the permissionless MockKeystoneForwarder, where the attester's signature alone
# authenticates a verdict, so the run passes ALLOW_MOCK_FORWARDER=1 (DeployEth refuses the mock without it).
# Env: OUT_JSON (live default deployments/sepolia.json; must be under deployments/ or cache/), DELAY_BLOCKS (25),
#      SEPOLIA_RPC, FORCE=1 (deploy again although OUT_JSON exists), YES=1 (no confirmation prompt),
#      DEPLOY_GAS (gas budget for the balance check, default 110000000; the 13 transactions took about 96M gas on a
#      Sepolia fork).
# Sepolia runs the Amsterdam rules, under which contract creation costs far more than Foundry's local simulation
# predicts, so the script lets the node estimate every transaction (--skip-simulation). An anvil fork of Sepolia
# charges the same gas as live Sepolia (gas-replay.ts checks this).
source "$(dirname "$0")/lib.sh"
NTX=13

# Roles first: nothing is read from the chain until the key directory is complete and the roles are distinct.
for r in owner attester sender approver emergency; do
  [ -r "$KEY_DIR/$r.key" ] || die "KEY_DIR has no readable $r.key (the five demo keys are owner, attester, sender, approver, emergency)"
done
OWNER_PK=$(read_key owner)
OWNER=$(cast wallet address --private-key "$OWNER_PK")
ATTESTER=$(addr_of attester)
SENDER=$(addr_of sender)
APPROVER=$(addr_of approver)
EMERGENCY=$(addr_of emergency)
[ "$(lc "$APPROVER")" != "$(lc "$OWNER")" ] || die "approver.key is the owner's key; the owner must not clear its own proposals"
[ "$(lc "$EMERGENCY")" != "$(lc "$OWNER")" ] || die "emergency.key is the owner's key; the owner must not be a guardian"
[ "$(lc "$APPROVER")" != "$(lc "$EMERGENCY")" ] || die "approver.key and emergency.key are the same key; use two different keys"
[ "$(lc "$ATTESTER")" != "$(lc "$OWNER")" ] || die "attester.key is the owner's key; the attester must be its own key"
[ "$(lc "$ATTESTER")" != "$(lc "$APPROVER")" ] || die "attester.key and approver.key are the same key; use two different keys"
[ "$(lc "$ATTESTER")" != "$(lc "$EMERGENCY")" ] || die "attester.key and emergency.key are the same key; use two different keys"

check_rpc
say "network    $NET  ($RPC)"
say "owner      $OWNER  deploys; demo owner (proposes upgrades)"
say "attester   $ATTESTER  signs the EIP-712 verdicts (CRE secret)"
say "approver   $APPROVER  manual clearance and codehash registry"
say "emergency  $EMERGENCY  second guardian (human veto, breakGlass)"
say "sender     $SENDER  pays the CRE writeReport transactions"

if [ "$MODE" = fork ]; then
  OUT_REL=cache/deployment-eth.fork-$FORK.$$.json
  export FOUNDRY_BROADCAST=$STATE/broadcast
  FUNDED=("$OWNER" "$SENDER" "$APPROVER" "$EMERGENCY")
  [ -r "$KEY_DIR/sweeper.key" ] && FUNDED+=("$(addr_of sweeper)")
  for a in "${FUNDED[@]}"; do cast rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url "$RPC" >/dev/null; done
  say "fork: owner, sender, approver and emergency guardian$([ ${#FUNDED[@]} = 5 ] && echo ', sweeper') funded with 100 ETH (anvil_setBalance)"
else
  OUT_REL=${OUT_JSON:-deployments/sepolia.json}
fi
case "$OUT_REL" in deployments/*.json | cache/*.json) ;; *) die "OUT_JSON must be a .json under deployments/ or cache/ (forge fs_permissions)" ;; esac
if [ "$MODE" = live ] && [ -f "$ROOT/$OUT_REL" ] && [ -z "${FORCE:-}" ]; then
  die "$OUT_REL already exists (a deployment is live). FORCE=1 replaces it with a new stack (git keeps the old file),
       or deploy with OUT_JSON=deployments/<name>.json and run the other scripts with DEPLOY_JSON=<that file>."
fi

# Balance check: DEPLOY_GAS at twice the current gas price (Sepolia's base fee is low, but it can spike).
BAL=$(cast balance "$OWNER" --rpc-url "$RPC")
GP=$(cast gas-price --rpc-url "$RPC")
GAS=${DEPLOY_GAS:-110000000}
NEED=$(bc <<<"$GAS * $GP * 2")
say "owner balance $(cast from-wei "$BAL") ETH; gas price $GP wei; budget ${GAS} gas -> need about $(cast from-wei "$NEED") ETH"
if [ "$(bc <<<"$BAL < $NEED")" = 1 ]; then
  die "owner $OWNER needs at least $(cast from-wei "$NEED") ETH on Sepolia (faucet), has $(cast from-wei "$BAL")"
fi
NONCE=$(cast nonce "$OWNER" --rpc-url "$RPC")
[ "$NONCE" = 0 ] || say "note: owner nonce is $NONCE; contract addresses follow from it (a fork rehearsal predicts the live ones only at the same nonce)"

if [ "$MODE" = live ] && [ -z "${YES:-}" ]; then
  [ -t 0 ] || die "a live deployment from a non-interactive shell needs YES=1"
  read -r -p "Deploy $NTX transactions to Ethereum Sepolia from $OWNER? Type 'deploy': " ans
  [ "$ans" = deploy ] || die "aborted"
fi

LOG=$STATE/deploy-$(date +%Y%m%d-%H%M%S).log
say "deploying $NTX transactions, one per block (forge log: $LOG) ..."
# A fork run builds into the state dir and keeps forge's run cache there too (a fork shares the chain id with live
# Sepolia, so the live run's cache/DeployEth.s.sol/11155111/, which `forge script --resume` needs, stays untouched).
FORGE_DIRS=()
[ "$MODE" = fork ] && FORGE_DIRS=(--out "$STATE/forge-out" --cache-path "$STATE/forge-cache")
cleanup() { if [ -n "${FPID:-}" ]; then kill "$FPID" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT TERM
T0=$(now_s)
(
  # the key goes to forge's environment through the builtin export; env's own arguments hold addresses only
  cd "$ROOT" && export DEPLOYER_PK="$OWNER_PK" && exec env ATTESTER_ADDR="$ATTESTER" APPROVER_ADDR="$APPROVER" \
    EMERGENCY_GUARDIAN_ADDR="$EMERGENCY" ALLOW_MOCK_FORWARDER=1 OUT_JSON="$OUT_REL" FOUNDRY_PROFILE=eth \
    forge script script/DeployEth.s.sol --rpc-url "$RPC" --broadcast --slow --skip-simulation ${FORGE_DIRS[@]+"${FORGE_DIRS[@]}"}
) >"$LOG" 2>&1 &
FPID=$!
unset OWNER_PK
# progress: forge prints nothing per transaction, so follow the owner's nonce
LAST=$NONCE
while kill -0 "$FPID" 2>/dev/null; do
  N=$(cast nonce "$OWNER" --rpc-url "$RPC" 2>/dev/null || echo "$LAST")
  if [ "$N" != "$LAST" ]; then say "  $((N - NONCE))/$NTX confirmed  ($(fmt_secs $(($(now_s) - T0))))"; LAST=$N; fi
  sleep 3
done
set +e
wait "$FPID"
RC=$?
set -e
FPID=
N=$(cast nonce "$OWNER" --rpc-url "$RPC" 2>/dev/null || echo "$LAST")
[ "$N" = "$LAST" ] || say "  $((N - NONCE))/$NTX confirmed  ($(fmt_secs $(($(now_s) - T0))))"
[ "$RC" = 0 ] || { tail -n 25 "$LOG" >&2; die "forge script failed (exit $RC); log $LOG"; }
SECS=$(($(now_s) - T0))

if [ "$MODE" = fork ]; then
  mv "$ROOT/$OUT_REL" "$DEPLOY_JSON"
else
  DEPLOY_JSON=$ROOT/$OUT_REL
fi

# Post-deploy checks, read from the chain.
GA=$(dep airlockAdmin)
RX=$(dep receiver)
chk() { [ "$(lc "$(cast call "$1" "$2" ${3:+"$3"} --rpc-url "$RPC")")" = "$(lc "$4")" ] || die "post-deploy check failed: $5"; }
chk "$GA" 'isWired()(bool)' "" true "ProxyAdmin is not owned by AirlockAdmin"
chk "$GA" 'isGuardian(address)(bool)' "$RX" true "the receiver is not a guardian"
chk "$GA" 'isGuardian(address)(bool)' "$EMERGENCY" true "the emergency key is not a guardian"
chk "$GA" 'isGuardian(address)(bool)' "$OWNER" false "the owner is a guardian"
chk "$GA" 'clearanceOracle()(address)' "" "$RX" "the receiver is not the clearance oracle"
chk "$GA" 'approver()(address)' "" "$APPROVER" "approver mismatch"
chk "$GA" 'owner()(address)' "" "$OWNER" "owner mismatch"
chk "$RX" 'attester()(address)' "" "$ATTESTER" "receiver attester mismatch"
chk "$RX" 'airlockAdmin()(address)' "" "$GA" "the receiver points at another AirlockAdmin"
chk "$(dep proxy)" 'owner()(address)' "" "$GA" "the token's owner is not AirlockAdmin"
say "post-deploy checks: AirlockAdmin owns ProxyAdmin and the token; guardians = receiver + emergency; clearance oracle = receiver; roles distinct"

RUN=${FOUNDRY_BROADCAST:-$ROOT/broadcast}/DeployEth.s.sol/$CHAIN_ID/run-latest.json
if [ -f "$RUN" ]; then
  read -r NSENT GUSED WEI < <(node -e 'const r = require(process.argv[1]).receipts; let g = 0n, w = 0n
    for (const x of r) { g += BigInt(x.gasUsed); w += BigInt(x.gasUsed) * BigInt(x.effectiveGasPrice) }
    console.log(r.length, String(g), String(w))' "$RUN")
  say "deployed in $(fmt_secs "$SECS"): $NSENT transactions, $GUSED gas, $(cast from-wei "$WEI") ETH"
fi
say ""
say "deployment  $DEPLOY_JSON"
for k in airlockAdmin receiver proxy proxyAdmin v1 v2 evilMint evilOwner evilFee evilBaseFee evilDrain paused; do
  printf '  %-13s %s\n' "$k" "$(addr_ref "$(dep "$k")")"
done
printf '  %-13s %s\n' forwarder "$(addr_ref "$(dep forwarder)")" "delayBlocks" "$(dep delayBlocks) blocks" startBlock "$(dep startBlock)"
say ""
F=${FORK:+FORK=$FORK }
say "next: ${F}bun scripts/sepolia/make-config.mjs${FORK:+   (optional on a fork: airlock.sh and sweep.sh generate the fork config)}"
say "      ${F}scripts/sepolia/fund-sender.sh   then   ${F}scripts/sepolia/airlock.sh"
if [ "$MODE" = live ]; then
  say ""
  say "optional source verification (Sourcify, public):"
  say "  FOUNDRY_PROFILE=eth forge verify-contract $GA src/AirlockAdmin.sol:AirlockAdmin --chain $CHAIN_ID --verifier sourcify"
  say "  FOUNDRY_PROFILE=eth forge verify-contract $RX src/cre/AirlockReceiver.sol:AirlockReceiver --chain $CHAIN_ID --verifier sourcify"
fi
