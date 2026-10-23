#!/usr/bin/env bash
# Execute a proposal once it has both a clearance and a finished cooldown (AirlockAdmin.execute is open to anyone;
# the owner key pays).
#
#   scripts/sepolia/execute.sh <id>            # live: waits for the ready block (WAIT=0 to just print the ETA)
#   FORK=19631 scripts/sepolia/execute.sh <id> # fork: mines the remaining cooldown blocks first (anvil_mine)
#
# Nothing is sent when execute() would revert: a vetoed proposal (ProposalVetoed), one without a clearance
# (NotCleared; the sweeper, the listener or the approver's clear.sh records one), or a target whose code is no longer
# the code that was judged (CodehashChanged). The script then shows the revert with an eth_call and exits 1.
source "$(dirname "$0")/lib.sh"
ID=${1:-}
[[ "$ID" =~ ^[0-9]+$ ]] || die "usage: [FORK=<port>] $0 <proposal id>"
check_rpc
GA=$(dep airlockAdmin)
PROXY=$(dep proxy)
OWNER=$(addr_of owner)
read -r KIND ST TARGET READY _ PBLOCK < <(proposal "$ID") || die "could not read proposal #$ID from $RPC (try again, or set SEPOLIA_RPC)"

# show_revert: what execute(id) does right now, as an eth_call from the owner (nothing is sent).
show_revert() {
  local out sel e
  out=$(cast call "$GA" 'execute(uint256)' "$ID" --from "$OWNER" --rpc-url "$RPC" 2>&1 || true)
  sel=$(grep -oE '0x[0-9a-fA-F]{8,}' <<<"$out" | tail -n1 | cut -c1-10)
  for e in 'ProposalVetoed(uint256)' 'NotCleared(uint256)' 'TooEarly(uint256,uint64,uint64)' 'AlreadyExecuted(uint256)' 'UnknownProposal(uint256)' 'CodehashChanged(uint256,bytes32,bytes32)'; do
    if [ -n "$sel" ] && [ "$sel" = "$(cast sig "$e")" ]; then
      case "$e" in
        TooEarly*) say "  execute($ID) reverts TooEarly($ID, readyBlock $READY, block $(block_now))" ;;
        CodehashChanged*) say "  execute($ID) reverts CodehashChanged: the target's code is not the code that was proposed and judged" ;;
        *) say "  execute($ID) reverts ${e%%(*}($ID)" ;;
      esac
      return
    fi
  done
  say "  execute($ID): $(tail -n1 <<<"$out" | cut -c1-200)"
}

case "$ST" in
  0) die "proposal #$ID does not exist" ;;
  3) say "#$ID was already executed"; exit 0 ;;
  2)
    EV=$(events_since "$PBLOCK") # the verdict lands after the proposal: a recent window every RPC serves
    RH=$(first_event vetoed "$ID" "$EV" | awk '{print $3}')
    say "#$ID (${KIND_NAMES[$KIND]} $(impl_name "$TARGET")) is Vetoed${RH:+ with $(rule_name "$RH")}; nothing sent:"
    show_revert
    exit 1
    ;;
esac

CL=$(clearance "$ID")
NOW=$(block_now)
if [ "$CL" = "$ZERO32" ]; then
  say "#$ID (${KIND_NAMES[$KIND]} $(impl_name "$TARGET")) has no clearance yet (ready block $READY, now $NOW); nothing sent:"
  show_revert
  say "  a verdict comes from the listener (airlock.sh) or the sweeper (sweep.sh); the approver can clear by hand (clear.sh)"
  exit 1
fi

if [ "$NOW" -lt "$READY" ]; then
  LEFT=$((READY - NOW))
  if [ "$MODE" = fork ]; then
    cast rpc anvil_mine "$(printf '0x%x' "$LEFT")" --rpc-url "$RPC" >/dev/null
    say "fork: mined $LEFT blocks to reach the ready block $READY"
  elif [ "${WAIT:-1}" = 1 ]; then
    say "#$ID is cleared and ready at block $READY, now $NOW: waiting ~$(fmt_secs $((LEFT * SEPOLIA_BLOCK_SECS)))"
    while [ "$(block_now)" -lt "$READY" ]; do sleep 6; done
  else
    say "#$ID is cleared and ready at block $READY, now $NOW (~$(fmt_secs $((LEFT * SEPOLIA_BLOCK_SECS))) at 12 s blocks)"
    exit 1
  fi
fi

# a last dry run: a guardian's veto in the meantime, or a target whose code changed (CodehashChanged), sends nothing
if ! cast call "$GA" 'execute(uint256)' "$ID" --from "$OWNER" --rpc-url "$RPC" >/dev/null 2>&1; then
  say "#$ID (${KIND_NAMES[$KIND]} $(impl_name "$TARGET")) would revert now; nothing sent:"
  show_revert
  exit 1
fi
BEFORE=$(cast parse-bytes32-address "$(cast storage "$PROXY" "$IMPL_SLOT" --rpc-url "$RPC")")
RCPT=$(send_as owner "$GA" 'execute(uint256)' "$ID")
TX=$(jq -r .transactionHash <<<"$RCPT")
[ "$(jq -r .status <<<"$RCPT")" = 0x1 ] || die "execute failed: $(tx_ref "$TX")"
say "EXECUTED #$ID (${KIND_NAMES[$KIND]} $(impl_name "$TARGET")) in block $(cast to-dec "$(jq -r .blockNumber <<<"$RCPT")")"
say "  clearance evidence $CL"
say "  tx $(tx_ref "$TX")"
if [ "$KIND" = 0 ]; then
  AFTER=$(cast parse-bytes32-address "$(cast storage "$PROXY" "$IMPL_SLOT" --rpc-url "$RPC")")
  say "  proxy implementation $(impl_name "$BEFORE") -> $(impl_name "$AFTER")"
  V=$(cast call "$PROXY" 'version()(string)' --rpc-url "$RPC" 2>/dev/null || true)
  [ -n "$V" ] && say "  token version() = $V"
fi
exit 0
