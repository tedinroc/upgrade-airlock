#!/usr/bin/env bash
# A local anvil chain with Sepolia's state, for rehearsals and for the "network is down" fallback.
#
#   FORK=19631 scripts/sepolia/fork.sh start        # anvil forking live Sepolia on 127.0.0.1:19631, 12 s blocks
#   FORK=19631 scripts/sepolia/fork.sh save [dir]   # snapshot the chain + deployment (default $TMPDIR/.../snapshot)
#   FORK=19632 scripts/sepolia/fork.sh load <dir>   # start an OFFLINE anvil from a snapshot: no upstream RPC needed
#   FORK=19631 scripts/sepolia/fork.sh status
#   FORK=19631 scripts/sepolia/fork.sh stop         # kills the anvil this script started (by its PID file)
#
# Env: BLOCK_TIME (default 12; 0 = mine on every transaction), FORK_SOURCE (default publicnode),
#      FORK_BLOCK (default: latest), READ_ONLY_ACCOUNTS (save: more contracts to carry into the snapshot although
#      the chain never changed them; Multicall3 is always carried).
# Every other script in this folder takes the same FORK=<port> and then talks only to this local chain.
source "$(dirname "$0")/lib.sh"
[ "$MODE" = fork ] || die "set FORK=<port>"
PIDF=$STATE/anvil.pid
SOURCE=${FORK_SOURCE:-https://ethereum-sepolia-rpc.publicnode.com}
BT=${BLOCK_TIME:-12}

running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && ps -p "$(cat "$PIDF")" -o comm= | grep -q anvil; }

launch() { # anvil args...
  if running; then die "a chain is already running on :$FORK (pid $(cat "$PIDF")); stop it first"; fi
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then die "port $FORK is already in use by another node"; fi
  local args=(--port "$FORK" --chain-id "$CHAIN_ID" "$@")
  [ "$BT" != 0 ] && args+=(--block-time "$BT")
  nohup anvil "${args[@]}" >"$STATE/anvil.log" 2>&1 &
  echo $! >"$PIDF"
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
  check_rpc
}

case "${1:-status}" in
  start)
    running && { say "fork already running on :$FORK (pid $(cat "$PIDF"))"; exit 0; }
    rm -rf "$STATE" && mkdir -p "$STATE" # a new fork is a new chain: drop the old deployment and logs
    extra=(--fork-url "$SOURCE")
    [ -n "${FORK_BLOCK:-}" ] && extra+=(--fork-block-number "$FORK_BLOCK")
    launch "${extra[@]}"
    say "fork of Sepolia on $RPC (pid $(cat "$PIDF"), forked at block $(block_now), block time ${BT}s)"
    say "state dir $STATE"
    ;;
  save)
    running || die "no chain running on :$FORK"
    OUT=${2:-$STATE/snapshot}
    mkdir -p "$OUT"
    # anvil_dumpState keeps only the accounts this chain changed. Contracts the workflow only reads (Multicall3 for
    # its batched reads) would be missing from an offline replica, so set their code again to make them part of it.
    MC=$(jq -r '.multicall // empty' "$STATE/config.fork.json" 2>/dev/null || true)
    for a in "${MC:-0xcA11bde05977b3631167028862bE2a173976CA11}" ${READ_ONLY_ACCOUNTS:-}; do
      code=$(cast code "$a" --rpc-url "$RPC")
      [ "$code" = 0x ] || cast rpc anvil_setCode "$a" "$code" --rpc-url "$RPC" >/dev/null
    done
    # anvil_dumpState: hex of the gzipped JSON that `anvil --load-state` reads
    cast rpc anvil_dumpState --rpc-url "$RPC" | tr -d '"' | sed 's/^0x//' | xxd -r -p | gunzip -c >"$OUT/state.json"
    [ -f "$DEPLOY_JSON" ] && cp "$DEPLOY_JSON" "$OUT/deployment.json"
    say "saved block $(block_now) of :$FORK to $OUT ($(du -h "$OUT/state.json" | cut -f1) state$([ -f "$OUT/deployment.json" ] && echo ' + deployment.json'))"
    ;;
  load)
    SNAP=${2:-}
    [ -f "$SNAP/state.json" ] || die "usage: FORK=<port> $0 load <snapshot dir with state.json>"
    SNAP=$(cd "$SNAP" && pwd)
    running && die "a chain is already running on :$FORK"
    rm -rf "$STATE" && mkdir -p "$STATE"
    [ -f "$SNAP/deployment.json" ] && cp "$SNAP/deployment.json" "$STATE/deployment.json"
    launch --load-state "$SNAP/state.json"
    say "offline Sepolia replica on $RPC from $SNAP (pid $(cat "$PIDF"), block $(block_now), block time ${BT}s; no upstream RPC)"
    ;;
  stop)
    if running; then
      P=$(cat "$PIDF")
      kill "$P"
      for _ in $(seq 1 20); do kill -0 "$P" 2>/dev/null || break; sleep 0.5; done
      if kill -0 "$P" 2>/dev/null; then say "chain :$FORK (pid $P) is still shutting down"; else say "stopped chain :$FORK (pid $P)"; fi
    else
      say "no chain started by this script on :$FORK"
    fi
    rm -f "$PIDF"
    ;;
  status)
    if running; then say "chain :$FORK running (pid $(cat "$PIDF")), block $(block_now)"; else say "chain :$FORK not running"; exit 1; fi
    ;;
  *) die "usage: FORK=<port> $0 start|save [dir]|load <dir>|stop|status" ;;
esac
