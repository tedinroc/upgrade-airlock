#!/usr/bin/env bash
# One sweeper run: the CRE workflow's cron handler (trigger 1), run once. It reads nextId, looks at the newest
# proposal ids (the config's sweep window), and judges the ones that are still Pending without a CRE verdict
# (AirlockAdmin.oracleJudged false): proposals the listener missed because it was down, whose Proposed log was too
# big to deliver, or that the approver cleared by hand (a CRE veto still wins over that clearance). Each judgement
# ends on chain like the listener's (Clear or Veto report). At most one upgrade simulation per run (the CRE HTTP
# budget); the next run takes the next one.
#
#   scripts/sepolia/sweep.sh                 # live Sepolia
#   FORK=19631 scripts/sepolia/sweep.sh      # local fork
#   SWEEP_ALWAYS=1 scripts/sepolia/sweep.sh  # run the workflow even when the pre-check finds nothing to judge
#
# systemd/airlock-sweep.timer runs it every 60 s. Before it starts the simulator it checks the same window itself
# (a few eth_calls) and exits at once when no proposal waits for a verdict, so an idle minute costs no simulator run.
# Proposals younger than SWEEP_MIN_AGE blocks (default 3, ~36 s) are left to the listener, which is normally
# judging them at that moment; set SWEEP_MIN_AGE=0 when no listener runs. One sweep at a time (a lock in the state
# dir). Output: stdout and <state dir>/sweep.log (appended, rotated at 5 MB).
# The reports are paid by sweeper.key when KEY_DIR has one (so the sweeper and the listener never race for one
# nonce), else by sender.key like the listener's.
# Env: CRE_SIM, KEY_DIR, SEPOLIA_RPC, AIRLOCK_STATE, WORKFLOW_CONFIG, WASM_CACHE (see airlock.sh).
source "$(dirname "$0")/lib.sh"
[ $# = 0 ] || die "usage: [FORK=<port>] $0"
MIN_AGE=${SWEEP_MIN_AGE:-3}
[[ "$MIN_AGE" =~ ^[0-9]+$ ]] || die "SWEEP_MIN_AGE must be a number of blocks"

LOCK=$STATE/sweep.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    say "sweep: another sweep is running (pid $(cat "$LOCK/pid")); skipping this one"
    exit 0
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" || die "cannot take the sweep lock $LOCK"
fi
echo $$ >"$LOCK/pid"
cleanup() {
  if [ -n "${SPID:-}" ]; then kill "$SPID" 2>/dev/null || true; fi
  rm -rf "$LOCK"
  [ -n "${RUNLOG:-}" ] && rm -f "$RUNLOG"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

check_rpc
GA=$(dep airlockAdmin)
workflow_config
WINDOW=$(jq -r '.sweepWindow // 20' "$CONFIG")
NOW=$(block_now)
NEXT=$(cast call "$GA" 'nextId()(uint256)' --rpc-url "$RPC")
FIRST=$((NEXT - WINDOW))
[ "$FIRST" -ge 1 ] || FIRST=1
WAITING=() YOUNG=()
for ((id = FIRST; id < NEXT; id++)); do
  read -r _ ST _ _ _ PB < <(proposal "$id")
  [ "$ST" = 1 ] || continue
  # the workflow's own filter: Pending and not judged by the oracle (a deployment without oracleJudged: not cleared)
  J=$(oracle_judged "$id")
  if [ "$J" = '?' ]; then [ "$(clearance "$id")" = "$ZERO32" ] || continue; elif [ "$J" = true ]; then continue; fi
  if [ $((NOW - PB)) -ge "$MIN_AGE" ]; then WAITING+=("$id"); else YOUNG+=("$id"); fi
done
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
HEAD="sweep $STAMP block $NOW: ids $FIRST..$((NEXT - 1)) checked; waiting for a verdict: ${WAITING[*]:-none}${YOUNG[*]:+; left to the listener (younger than $MIN_AGE blocks): ${YOUNG[*]}}"
if [ ${#WAITING[@]} = 0 ] && [ -z "${SWEEP_ALWAYS:-}" ]; then
  say "$HEAD"
  exit 0
fi

sim_bin
RX=$(dep receiver)
ATTESTER_PK=$(read_key attester)
PAYER=sender
[ -r "$KEY_DIR/sweeper.key" ] && PAYER=sweeper
SENDER_PK=$(read_key "$PAYER")
SBAL=$(cast balance "$(cast wallet address --private-key "$SENDER_PK")" --rpc-url "$RPC")
[ "$SBAL" != 0 ] || die "$PAYER.key has no ETH on $NET (fund-sender.sh <eth> $PAYER)"
ATTESTER=$(cast wallet address --private-key "$ATTESTER_PK")
[ "$(cast call "$RX" 'attester()(address)' --rpc-url "$RPC")" = "$ATTESTER" ] || die "attester.key does not match AirlockReceiver.attester()"
wasm_build

LOG=$STATE/sweep.log
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" | tr -d ' ')" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi
RUNLOG=$(mktemp "$STATE/sweep-run.XXXXXX")
say "== $HEAD" | tee -a "$LOG"
T0=$(now_s)
cd "$ROOT/cre"
set +e
# the keys reach the simulator through its environment only (exported by the builtin, never in any argv)
(
  export "$(attester_env)=$ATTESTER_PK" CRE_ETH_PRIVATE_KEY="$SENDER_PK"
  exec "$SIM" workflow simulate ./veto -T "$TARGET" --config "$CONFIG" ${WASM_ARGS[@]+"${WASM_ARGS[@]}"} \
    --non-interactive --trigger-index 1 --broadcast
) >"$RUNLOG" 2>&1 &
SPID=$!
unset ATTESTER_PK SENDER_PK
wait "$SPID"
RC=$?
SPID=
set -e
tee -a "$LOG" <"$RUNLOG"

# What the run changed, read from the chain.
OUT=()
for id in ${WAITING[@]+"${WAITING[@]}"}; do
  read -r _ ST _ _ _ _ < <(proposal "$id")
  NOTE=
  [ "$(oracle_judged "$id")" != false ] || NOTE=' (no CRE verdict yet)'
  OUT+=("#$id $(state_name "$ST" "$(clearance "$id")")$NOTE")
done
say "== sweep done in $(fmt_secs $(($(now_s) - T0))) (simulator exit $RC): ${OUT[*]:-nothing waited}" | tee -a "$LOG"
exit "$RC"
