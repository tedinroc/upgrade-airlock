#!/usr/bin/env bash
# Propose one of the demo cards as the owner, then wait for the airlock's verdict on chain.
#
#   scripts/sepolia/propose.sh v2               # the honest upgrade        -> expect Cleared (it may execute after the cooldown)
#   scripts/sepolia/propose.sh evil-mint        # anyone can mint           -> expect a Veto, R1_TOTAL_SUPPLY
#   scripts/sepolia/propose.sh evil-owner       # anyone can take owner     -> expect a Veto, R2_OWNER
#   scripts/sepolia/propose.sh evil-fee         # transfers skim a fee      -> expect a Veto, R3_TRANSFER_CONSERVATION
#   scripts/sepolia/propose.sh evil-basefee     # honest while simulated (basefee 0), anyone mints on a real block
#                                               #                           -> expect a Veto, R9_NEW_OPCODES (BASEFEE)
#   scripts/sepolia/propose.sh evil-drain       # v1 plus rescue(): anyone moves a holder's tokens without allowance
#                                               #                           -> expect a Veto, R3B_THIRD_PARTY_FUNDS
#   scripts/sepolia/propose.sh remove-receiver  # drop the CRE receiver from the guardians
#                                               #                           -> expect a Veto, R7_CONFIG_GUARD
#   FORK=19631 scripts/sepolia/propose.sh ...   # same on the local fork
#
# Env: WAIT=0 returns right after the proposal is mined; WAIT_SECS (default 180 live, 120 fork) bounds the wait.
# The verdict is read from the chain: AirlockAdmin.clearanceOf(id) (Cleared) or the proposal status (Vetoed), with
# the rule, the evidence hash and the report transaction from the events. The listener's log lines for the
# proposal are shown when its log is in the same state dir.
# The card's expected outcome is only compared after the chain's verdict is in (a projected terminal then never
# shows a verdict before CRE gives one); SHOW_EXPECT=1 also prints it right after the proposal, for rehearsals.
# Reads are retried on transient RPC errors (RPC_TRIES, default 3) and a failed read inside the wait loop is tried
# again 2 s later; the proposal transaction itself is sent once and never retried. If the script stops before it
# prints "proposed #N", look at the war room or status.sh before running it again: the transaction may have landed.
# Exit status: 0 when the outcome is the expected one, 1 otherwise.
source "$(dirname "$0")/lib.sh"
CARD=${1:-}
case "$CARD" in
  v2 | honest) KEY=v2 EXPECT=clear ;;
  evil-mint | evilMint) KEY=evilMint EXPECT=R1_TOTAL_SUPPLY ;;
  evil-owner | evilOwner) KEY=evilOwner EXPECT=R2_OWNER ;;
  evil-fee | evilFee) KEY=evilFee EXPECT=R3_TRANSFER_CONSERVATION ;;
  evil-basefee | evilBaseFee) KEY=evilBaseFee EXPECT=R9_NEW_OPCODES ;;
  evil-drain | evilDrain) KEY=evilDrain EXPECT=R3B_THIRD_PARTY_FUNDS ;;
  remove-receiver) KEY=receiver EXPECT=R7_CONFIG_GUARD ;;
  *) die "usage: [FORK=<port>] $0 v2|evil-mint|evil-owner|evil-fee|evil-basefee|evil-drain|remove-receiver" ;;
esac
check_rpc
GA=$(dep airlockAdmin)
[ -n "$(jq -r --arg k "$KEY" '.[$k] // empty' "$DEPLOY_JSON")" ] || die "the deployment has no $KEY (it predates that card; deploy again with deploy.sh)"
TARGET_ADDR=$(dep "$KEY")
ALOG=$STATE/airlock.log
LOGLINES=0
[ -f "$ALOG" ] && LOGLINES=$(wc -l <"$ALOG" | tr -d ' ')
if [ -f "$STATE/airlock.pid" ] && kill -0 "$(cat "$STATE/airlock.pid")" 2>/dev/null; then :; else
  say "note: no airlock.sh listener in this state dir ($STATE); the proposal is judged by the sweeper (sweep.sh / the systemd timer) or not at all"
fi

T0=$(now_s)
if [ "$KEY" = receiver ]; then
  [ "$(cast call "$GA" 'isGuardian(address)(bool)' "$TARGET_ADDR" --rpc-url "$RPC")" = true ] || say "note: the receiver is not a guardian any more"
  say "proposing $CARD (setGuardian receiver $TARGET_ADDR -> off) on $NET ..."
  RCPT=$(send_as owner "$GA" 'proposeSetGuardian(address,bool)' "$TARGET_ADDR" false)
else
  say "proposing $CARD (upgrade to $KEY $TARGET_ADDR) on $NET ..."
  RCPT=$(send_as owner "$GA" 'proposeUpgrade(address,bytes)' "$TARGET_ADDR" 0x)
fi
TX=$(jq -r .transactionHash <<<"$RCPT")
[ "$(jq -r .status <<<"$RCPT")" = 0x1 ] || die "proposal transaction failed: $(tx_ref "$TX")"
TOPIC=$(cast keccak 'Proposed(uint256,uint8,address,uint256,bytes,bytes32,uint64)')
LOGJ=$(jq --arg ga "$(lc "$GA")" --arg t "$TOPIC" -c '[.logs[] | select((.address|ascii_downcase)==$ga and .topics[0]==$t)][0]' <<<"$RCPT")
[ "$LOGJ" != null ] || die "no Proposed log in $(tx_ref "$TX")"
ID=$(cast to-dec "$(jq -r '.topics[1]' <<<"$LOGJ")")
PBLOCK=$(cast to-dec "$(jq -r .blockNumber <<<"$RCPT")")
EXPECT_TEXT=$([ "$EXPECT" = clear ] && echo 'Cleared by the CRE receiver' || echo "Vetoed by the CRE receiver with $EXPECT")
READY=$(proposal "$ID" | awk '{print $4}') || READY=
if [[ "$READY" =~ ^[0-9]+$ ]]; then
  DELAY=$((READY - PBLOCK))
  say "proposed #$ID in block $PBLOCK ($(fmt_secs $(($(now_s) - T0))) to mine); executable from block $READY (+$DELAY blocks, ~$(fmt_secs $((DELAY * SEPOLIA_BLOCK_SECS))) at 12 s blocks) once cleared"
else
  say "proposed #$ID in block $PBLOCK ($(fmt_secs $(($(now_s) - T0))) to mine); executable after the cooldown once cleared"
fi
say "  tx $(tx_ref "$TX")"
[ "${SHOW_EXPECT:-0}" = 1 ] && say "  expected: $EXPECT_TEXT"
[ "${WAIT:-1}" = 1 ] || exit 0

listener_lines() {
  [ -f "$ALOG" ] || return 0
  tail -n +"$((LOGLINES + 1))" "$ALOG" | grep -E "\[USER LOG\].*#$ID[^0-9]" | sed -E 's/^.*\[USER LOG\] /  airlock: /' | cut -c1-220 || true
}
LIMIT=${WAIT_SECS:-$([ "$MODE" = live ] && echo 180 || echo 120)}
PTS=$(block_ts "$PBLOCK") || PTS=
chain_secs() { local t; if [ -n "$PTS" ] && t=$(block_ts "$1"); then say "$((t - PTS))s"; else say "?s"; fi; }
while :; do
  # a read the RPC does not answer (after lib.sh's retries) is tried again on the next pass, never fatal
  ST=$(proposal "$ID" | awk '{print $2}') || ST=
  CL=$(clearance "$ID") || CL=
  [[ "$ST" =~ ^[0-3]$ ]] || ST=
  [[ "$CL" =~ ^0x[0-9a-fA-F]{64}$ ]] || CL=
  if [ -n "$ST" ] && [ -n "$CL" ] && { [ "$ST" = 2 ] || [ "$CL" != "$ZERO32" ]; }; then
    EV=$(events_since "$PBLOCK")
    # an RPC behind a load balancer may answer the status before its log index has the event: read again
    if [ -z "$(first_event "$([ "$ST" = 2 ] && echo vetoed || echo cleared)" "$ID" "$EV")" ]; then sleep 3; EV=$(events_since "$PBLOCK"); fi
    if [ "$ST" = 2 ]; then
      read -r _ _ RH WHO VTX VB < <(first_event vetoed "$ID" "$EV") || { RH=$ZERO32 WHO=unknown VTX=unknown VB=$PBLOCK; }
      RULE=$(rule_name "$RH")
      read -r _ _ EVID _ _ _ < <(first_event reason "$ID" "$EV") || EVID=-
      say "VETOED #$ID by $(who_name "$WHO"): $RULE, in block $VB (+$((VB - PBLOCK)) blocks, $(chain_secs "$VB") of chain time after the proposal; $(fmt_secs $(($(now_s) - T0))) wall clock)"
      say "  evidence $EVID"
      say "  report tx $(tx_ref "$VTX")"
      GOT=$RULE
    else
      read -r _ _ EVID WHO CTX CB < <(first_event cleared "$ID" "$EV") || { WHO=unknown CTX=unknown CB=$PBLOCK; }
      say "CLEARED #$ID by $(who_name "$WHO") in block $CB (+$((CB - PBLOCK)) blocks, $(chain_secs "$CB") of chain time after the proposal; $(fmt_secs $(($(now_s) - T0))) wall clock)"
      say "  evidence $CL"
      say "  report tx $(tx_ref "$CTX")"
      say "  executable from block ${READY:-<its ready block>}: ${FORK:+FORK=$FORK }scripts/sepolia/execute.sh $ID"
      GOT=clear
    fi
    listener_lines
    if [ "$GOT" = "$EXPECT" ]; then say "  matches this card's expected outcome ($EXPECT_TEXT)"; exit 0; fi
    say "MISMATCH: expected $([ "$EXPECT" = clear ] && echo 'a clearance' || echo "a veto with $EXPECT")"
    exit 1
  fi
  if [ $(($(now_s) - T0)) -ge "$LIMIT" ]; then
    say "no verdict after $(fmt_secs "$LIMIT"): #$ID is ${ST:+${STATUS_NAMES[$ST]} and }not cleared (is airlock.sh running? see $ALOG; or run sweep.sh)"
    listener_lines
    exit 1
  fi
  sleep 2
done
