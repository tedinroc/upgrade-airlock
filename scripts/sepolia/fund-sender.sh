#!/usr/bin/env bash
# The owner sends a little Sepolia ETH to the report sender (the key that pays the CRE writeReport transactions),
# or to another demo key that sends transactions (sweeper.key when the sweeper pays its own reports, the approver
# for clear.sh, the emergency guardian).
#
#   scripts/sepolia/fund-sender.sh [eth] [sender|sweeper|approver|emergency]   # default 0.01 ETH to the sender
#   FORK=19631 scripts/sepolia/fund-sender.sh [eth] [role]
source "$(dirname "$0")/lib.sh"
AMOUNT=${1:-0.01}
AMOUNT=${AMOUNT%ether}
ROLE=${2:-sender}
[[ "$AMOUNT" =~ ^[0-9]*\.?[0-9]+$ ]] || die "usage: [FORK=<port>] $0 [amount in ETH, e.g. 0.01] [sender|sweeper|approver|emergency]"
case "$ROLE" in sender | sweeper | approver | emergency) ;; *) die "role must be sender, sweeper, approver or emergency" ;; esac
check_rpc
OWNER=$(addr_of owner)
TO=$(addr_of "$ROLE")
WEI=$(cast to-wei "$AMOUNT" ether)
OBAL=$(cast balance "$OWNER" --rpc-url "$RPC")
[ "$(bc <<<"$OBAL > $WEI")" = 1 ] || die "owner $OWNER has $(cast from-wei "$OBAL") ETH, cannot send $(cast from-wei "$WEI")"
say "owner $OWNER -> $ROLE $TO: $(cast from-wei "$WEI") ETH on $NET"
RCPT=$(send_as owner "$TO" --value "$WEI")
TX=$(jq -r .transactionHash <<<"$RCPT")
[ "$(jq -r .status <<<"$RCPT")" = 0x1 ] || die "transfer failed: $(tx_ref "$TX")"
BAL=$(cast balance "$TO" --rpc-url "$RPC")
GP=$(cast gas-price --rpc-url "$RPC")
say "  tx $(tx_ref "$TX")"
say "  $ROLE balance now $(cast from-wei "$BAL") ETH; owner $(cast from-wei "$(cast balance "$OWNER" --rpc-url "$RPC")") ETH"
if { [ "$ROLE" = sender ] || [ "$ROLE" = sweeper ]; } && [ "$GP" -gt 0 ]; then
  GL=2000000
  [ "$MODE" = live ] && [ -f "$ROOT/cre/veto/config.sepolia.json" ] && GL=$(jq -r '.gasLimit // 2000000' "$ROOT/cre/veto/config.sepolia.json")
  say "  at $GP wei/gas that covers ~$(bc <<<"$BAL / ($GL * $GP)") reports of $GL gas (the config's writeReport gas limit)"
fi
exit 0
