#!/usr/bin/env bash
# The airlock listener: runs the CRE workflow's log trigger (handler 0) in listen mode. Every AirlockAdmin.Proposed
# event is judged as it arrives and answered on chain: a pass becomes a Clear report, a failed check a Veto report.
#
#   scripts/sepolia/airlock.sh               # live Sepolia (target "sepolia", cre/veto/config.sepolia.json)
#   FORK=19631 scripts/sepolia/airlock.sh    # local fork (target "sepolia-fork", a generated config in the state dir)
#   scripts/sepolia/airlock.sh stop          # stops a background airlock.sh started with the same FORK setting
#
# It runs: (cd cre && $CRE_SIM workflow simulate ./veto -T <target> --non-interactive --trigger-index 0 --listen --broadcast)
# with the attester key (the EIP-712 verdict secret, env name from cre/secrets.yaml) and CRE_ETH_PRIVATE_KEY from
# sender.key (pays the writeReport transaction to the MockKeystoneForwarder). The workflow is compiled once per
# source version into the state dir and shared with sweep.sh (WASM_CACHE=0 compiles inside the simulator instead).
# Proposals it misses (the listener was down, the log was too big to deliver) are picked up by sweep.sh.
# Env: CRE_SIM (default `cre`, the official CLI, which needs a logged-in session; a login-free build of the same
#      CLI also works), KEY_DIR, SEPOLIA_RPC (only for the pre-flight reads here; the workflow itself uses the RPCs
#      in cre/project.yaml and in the config), AIRLOCK_STATE, WORKFLOW_CONFIG (live: another config file).
# Output: the simulator's output on stdout and in <state dir>/airlock-<time>.log (airlock.log points to the latest).
# Runs in the foreground (systemd/airlock-listener.service runs it like this); stop it with Ctrl-C or `airlock.sh stop`.
# When the simulator exits (it ends listen mode on any failed run), it is started again after 5 s.
source "$(dirname "$0")/lib.sh"
PIDF=$STATE/airlock.pid

if [ "${1:-}" = stop ]; then
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    kill "$(cat "$PIDF")" && say "stopped airlock (pid $(cat "$PIDF"))"
  else
    say "no airlock running for $NET"
  fi
  rm -f "$PIDF"
  exit 0
fi
[ $# = 0 ] || die "usage: [FORK=<port>] $0 [stop]"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  die "an airlock listener is already running for $NET (pid $(cat "$PIDF")); stop it first: ${FORK:+FORK=$FORK }$0 stop"
fi

sim_bin
check_rpc
GA=$(dep airlockAdmin)
RX=$(dep receiver)
workflow_config
CONFIG_ARGS=(--config "$CONFIG")

ATTESTER_PK=$(read_key attester)
SENDER_PK=$(read_key sender)
ATTESTER=$(cast wallet address --private-key "$ATTESTER_PK")
SENDER=$(cast wallet address --private-key "$SENDER_PK")
ONCHAIN_ATTESTER=$(cast call "$RX" 'attester()(address)' --rpc-url "$RPC")
[ "$ONCHAIN_ATTESTER" = "$ATTESTER" ] || die "attester.key is $ATTESTER but AirlockReceiver.attester() is $ONCHAIN_ATTESTER"
[ "$(lc "$(cast call "$GA" 'clearanceOracle()(address)' --rpc-url "$RPC")")" = "$(lc "$RX")" ] \
  || die "the deployment's receiver is not AirlockAdmin's clearance oracle"
SBAL=$(cast balance "$SENDER" --rpc-url "$RPC")
GP=$(cast gas-price --rpc-url "$RPC")
GL=$(jq -r .gasLimit "$CONFIG")
PER_REPORT=$(bc <<<"$GL * $GP * 2")
[ "$SBAL" != 0 ] || die "sender $SENDER has no ETH on $NET (run fund-sender.sh)"
[ "$(bc <<<"$SBAL < $PER_REPORT")" = 0 ] || say "warning: sender balance $(cast from-wei "$SBAL") ETH may not cover a report ($GL gas at 2x $GP wei)"

STAMP=$(date +%Y%m%d-%H%M%S)
LOG=$STATE/airlock-$STAMP.log
ln -sf "$(basename "$LOG")" "$STATE/airlock.log"
{
  say "== Upgrade Airlock listener: CRE log trigger, $NET, started $(date -u +%Y-%m-%dT%H:%M:%SZ) at block $(block_now)"
  say "   AirlockAdmin $GA  receiver $RX"
  say "   attester $ATTESTER  report sender $SENDER ($(cast from-wei "$SBAL") ETH)"
  say "   providers $(jq -r '[.rpcs[].label]|join(", ")' "$CONFIG"), quorum $(jq -r .minAgree "$CONFIG"); target $TARGET; simulator $(basename "$SIM")"
} | tee "$LOG"
wasm_build
[ ${#WASM_ARGS[@]} = 0 ] || say "   workflow binary $(basename "${WASM_ARGS[1]}")" | tee -a "$LOG"

cleanup() {
  if [ -n "${SPID:-}" ]; then kill "$SPID" 2>/dev/null || true; fi
  rm -f "$PIDF"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cd "$ROOT/cre"
echo $$ >"$PIDF"
# The simulator in listen mode ends when one workflow run fails (an RPC timeout, a revert). Start it again after
# RESTART_SECS (default 5); a proposal that arrives in the gap stays Pending without a clearance until sweep.sh
# judges it. AIRLOCK_RESTART=0 exits instead (with the simulator's exit status).
while :; do
  # The keys go to the simulator's environment only (never to its arguments or the log).
  env "$(attester_env)=$ATTESTER_PK" CRE_ETH_PRIVATE_KEY="$SENDER_PK" \
    "$SIM" workflow simulate ./veto -T "$TARGET" "${CONFIG_ARGS[@]}" ${WASM_ARGS[@]+"${WASM_ARGS[@]}"} \
    --non-interactive --trigger-index 0 --listen --broadcast \
    > >(tee -a "$LOG") 2>&1 &
  SPID=$!
  say "airlock listening (simulator pid $SPID); log $LOG"
  set +e
  wait "$SPID"
  RC=$?
  set -e
  SPID=
  [ "${AIRLOCK_RESTART:-1}" = 1 ] || exit "$RC"
  say "== simulator exited ($RC) at block $(block_now 2>/dev/null || echo '?'); restarting in ${RESTART_SECS:-5} s (sweep.sh judges what arrives meanwhile)" | tee -a "$LOG"
  sleep "${RESTART_SECS:-5}"
done
