#!/usr/bin/env bash
# The last N proposals: Pending (no verdict yet) / Cleared / Vetoed / Executed, who gave the verdict, whether the
# CRE has judged it (AirlockAdmin.oracleJudged; an approver's clearance leaves it "no" until the sweeper answers),
# the rule, the evidence hash and the verdict and execute transactions.
#
#   scripts/sepolia/status.sh [N]              # live Sepolia (default N = 10)
#   FORK=19631 scripts/sepolia/status.sh [N]
# Every read is retried on a transient RPC error (RPC_TRIES, default 3). The verdict events are scanned from the
# deployment block in windows, on SEPOLIA_RPC and then an RPC that keeps the full history (lib.sh events_since;
# HISTORY_RPC overrides the list, EVENTS_FROM=<block> starts the scan later). When no RPC serves a window, the rows in
# it show '-' for by, rule, evidence and verdict tx, and the header line ("proposals so far: N") still shows that the
# chain is reachable.
source "$(dirname "$0")/lib.sh"
N=${1:-10}
[[ "$N" =~ ^[0-9]+$ ]] || die "usage: [FORK=<port>] $0 [N]"
check_rpc
GA=$(dep airlockAdmin)
PROXY=$(dep proxy)
NOW=$(block_now)
NEXT=$(rpc_retry cast call "$GA" 'nextId()(uint256)' --rpc-url "$RPC")
DELAY=$(rpc_retry cast call "$GA" 'delayBlocks()(uint64)' --rpc-url "$RPC")
PAUSED=$(rpc_retry cast call "$GA" 'paused()(bool)' --rpc-url "$RPC")
IMPL=$(cast parse-bytes32-address "$(rpc_retry cast storage "$PROXY" "$IMPL_SLOT" --rpc-url "$RPC")")
RX=$(dep receiver)
say "Upgrade Airlock on $NET, block $NOW"
say "  AirlockAdmin $(addr_ref "$GA")"
say "  delay $DELAY blocks (~$(fmt_secs $((DELAY * SEPOLIA_BLOCK_SECS))) at 12 s blocks); proposals so far: $((NEXT - 1)); proxy implementation: $(impl_name "$IMPL")$([ "$PAUSED" = true ] && echo ' (PAUSED)')"
say "  receiver is guardian: $(rpc_retry cast call "$GA" 'isGuardian(address)(bool)' "$RX" --rpc-url "$RPC"); guardians: $(rpc_retry cast call "$GA" 'guardianCount()(uint256)' --rpc-url "$RPC")"
[ "$NEXT" -gt 1 ] || exit 0

EV=$(events_since "$(dep startBlock)")
FIRST=$((NEXT - N))
[ "$FIRST" -ge 1 ] || FIRST=1
C=0 V=0 P=0 X=0 W=0
ROWS=()
for ((id = FIRST; id < NEXT; id++)); do
  read -r KIND ST TARGET READY _ PBLOCK < <(proposal "$id") || die "could not read proposal #$id from $RPC (try again, or set SEPOLIA_RPC)"
  CL=$(clearance "$id")
  STATE_N=$(state_name "$ST" "$CL")
  CRE=$(oracle_judged "$id")
  case "$CRE" in true) CRE=yes ;; false) CRE=no ;; esac
  [ "$ST" = 1 ] && [ "$CRE" = no ] && W=$((W + 1))
  RULE=- EVID=- BY=- VTX=- XTX=-
  case "$STATE_N" in
    Vetoed)
      V=$((V + 1))
      read -r _ _ RH WHO TXH _ < <(first_event vetoed "$id" "$EV") || RH=
      if [ -n "${RH:-}" ]; then RULE=$(rule_name "$RH"); BY=$(who_name "$WHO"); VTX=$TXH; fi
      read -r _ _ EVID _ _ _ < <(first_event reason "$id" "$EV") || EVID=-
      ;;
    Cleared | Executed)
      if [ "$CL" != "$ZERO32" ]; then
        EVID=$CL
        read -r _ _ _ WHO TXH _ < <(first_event cleared "$id" "$EV") || WHO=
        if [ -n "${WHO:-}" ]; then BY=$(who_name "$WHO"); VTX=$TXH; fi
      fi
      if [ "$STATE_N" = Executed ]; then
        X=$((X + 1))
        read -r _ _ _ _ XTX _ < <(first_event executed "$id" "$EV") || XTX=-
      else C=$((C + 1)); fi
      ;;
    Pending) P=$((P + 1)) ;;
  esac
  WHEN=$READY
  [ "$ST" = 1 ] && [ "$NOW" -lt "$READY" ] && WHEN="$READY(+$((READY - NOW)))"
  ROWS+=("$(printf '  %-4s %-15s %-15s %-9s %-13s %-4s %-9s %-14s %-24s %-14s %s' "$id" "${KIND_NAMES[$KIND]}" "$(impl_name "$TARGET")" \
    "$STATE_N" "$BY" "$CRE" "$PBLOCK" "$WHEN" "$RULE" "$(short "$EVID")" "$( [ "$VTX" = - ] && echo - || tx_ref "$VTX")")")
  [ "$XTX" = - ] || ROWS+=("$(printf '  %-4s %-15s executed in tx %s' '' '' "$(tx_ref "$XTX")")")
done
printf '\n  %-4s %-15s %-15s %-9s %-13s %-4s %-9s %-14s %-24s %-14s %s\n' id kind target state by cre proposed ready rule evidence "verdict tx"
for r in "${ROWS[@]}"; do say "$r"; done
say ""
say "  shown: $C cleared (not executed yet), $V vetoed, $X executed, $P pending without a verdict"
[ "$W" = 0 ] || say "  $W pending without a CRE verdict (cre = no): the sweeper judges them, approver-cleared ones included"
[ "$CRE" != '?' ] || say "  cre = ?: this deployment has no AirlockAdmin.oracleJudged"
