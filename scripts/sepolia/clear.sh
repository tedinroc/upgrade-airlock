#!/usr/bin/env bash
# Manual clearance by the human approver (approver.key): the fallback when the CRE workflow cannot give a verdict
# (both the listener and the sweeper are down, or the providers are unreachable). A veto still wins: a vetoed
# proposal cannot be cleared, and a guardian can still veto a cleared one until it executes. The CRE keeps judging
# it too: until the receiver answers (oracleJudged), the sweeper picks the proposal up, and its veto wins.
#
#   scripts/sepolia/clear.sh <id> ["note"]             # live Sepolia (the approver pays the gas)
#   FORK=19631 scripts/sepolia/clear.sh <id> ["note"]
#
# The evidence hash is keccak256 of a small canonical JSON (sorted keys) naming the proposal digest, the approver
# and the note; the JSON is printed so it can be published next to the transaction.
source "$(dirname "$0")/lib.sh"
ID=${1:-}
NOTE=${2:-manual clearance by the approver}
[[ "$ID" =~ ^[0-9]+$ ]] || die "usage: [FORK=<port>] $0 <proposal id> [note]"
check_rpc
GA=$(dep airlockAdmin)
APPROVER=$(addr_of approver)
[ "$(lc "$(cast call "$GA" 'approver()(address)' --rpc-url "$RPC")")" = "$(lc "$APPROVER")" ] || die "approver.key is not AirlockAdmin.approver()"
read -r KIND ST TARGET READY _ _ < <(proposal "$ID")
case "$ST" in
  0) die "proposal #$ID does not exist" ;;
  2) die "#$ID is Vetoed; a veto cannot be overridden by a clearance" ;;
  3) die "#$ID was already executed" ;;
esac
CL=$(clearance "$ID")
[ "$CL" = "$ZERO32" ] || { say "#$ID is already cleared (evidence $CL)"; exit 0; }
DIGEST=$(cast call "$GA" 'proposalDigest(uint256)(bytes32)' "$ID" --rpc-url "$RPC")
EVIDENCE=$(jq -cnS --arg a "$(lc "$GA")" --arg id "$ID" --arg d "$DIGEST" --arg by "$(lc "$APPROVER")" --arg n "$NOTE" \
  '{airlockAdmin: $a, by: $by, chainId: 11155111, note: $n, proposalDigest: $d, proposalId: $id, verdict: "manual-clear"}')
EH=$(cast keccak "$EVIDENCE")
if [ "$MODE" = fork ]; then
  [ "$(cast balance "$APPROVER" --rpc-url "$RPC")" != 0 ] || cast rpc anvil_setBalance "$APPROVER" 0x56bc75e2d63100000 --rpc-url "$RPC" >/dev/null
fi
say "approver $APPROVER clears #$ID (${KIND_NAMES[$KIND]} $(impl_name "$TARGET")) on $NET"
say "  evidence $EVIDENCE"
RCPT=$(send_as approver "$GA" 'clear(uint256,bytes32)' "$ID" "$EH")
TX=$(jq -r .transactionHash <<<"$RCPT")
[ "$(jq -r .status <<<"$RCPT")" = 0x1 ] || die "clear failed: $(tx_ref "$TX")"
say "CLEARED #$ID by the approver, evidence hash $EH"
say "  tx $(tx_ref "$TX")"
say "  executable from block $READY: ${FORK:+FORK=$FORK }scripts/sepolia/execute.sh $ID"
[ "$(oracle_judged "$ID")" = true ] || say "  the CRE still judges #$ID (the sweeper, or sweep.sh); a CRE veto wins over this clearance"
