# Shared helpers for the Sepolia operator kit. Sourced by the scripts next to it, never run directly.
#
# Two modes, picked by the FORK variable:
#   live (default)  Ethereum Sepolia through SEPOLIA_RPC (default publicnode); deployment in deployments/sepolia.json
#   FORK=<port>     a local anvil fork of Sepolia on 127.0.0.1:<port> (start one with fork.sh); everything the kit
#                   writes goes to $TMPDIR/upgrade-airlock-fork-<port>/, nothing under the repo changes
# AIRLOCK_STATE overrides the live mode's state directory (logs, PID files, the compiled workflow); the systemd
# units set it to a persistent directory so the operator's shell and the services share one place. Fork mode
# ignores it, so a rehearsal never touches the live services' files.
#
# Keys: KEY_DIR (default $HOME/.config/ethsz-2026) holds one hex private key per file:
#   owner.key     deploys the stack, proposes, executes (the owner can only propose; it is never a guardian)
#   attester.key  signs the EIP-712 verdicts the AirlockReceiver accepts (a CRE secret)
#   sender.key    pays the CRE writeReport transactions
#   approver.key  the human approver: manual clearance (clear.sh) and the codehash registry
#   emergency.key the emergency guardian: a human veto and breakGlass
# They are read only at run time, into shell variables, and handed to forge / cast / the CRE simulator.
# Nothing here prints a key; only the derived addresses are shown.
set -euo pipefail

KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$KIT/../.." && pwd)
export PATH="$ROOT/cre/.tools/bin:$ROOT/cre/.tools/node_modules/.bin:$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

KEY_DIR=${KEY_DIR:-$HOME/.config/ethsz-2026}
CHAIN_ID=11155111
EXPLORER=https://sepolia.etherscan.io
SEPOLIA_BLOCK_SECS=12
TMP_BASE=${TMPDIR:-/tmp}
TMP_BASE=${TMP_BASE%/}

die() { echo "error: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
now_s() { date +%s; }
lc() { tr 'A-F' 'a-f' <<<"$1"; }
for _t in cast jq bc; do command -v "$_t" >/dev/null 2>&1 || die "$_t is not on the PATH (cast comes with Foundry: foundryup)"; done
unset _t

if [ -n "${FORK:-}" ]; then
  [[ "$FORK" =~ ^[0-9]{2,5}$ ]] || die "FORK must be a local port number (got '$FORK')"
  MODE=fork
  RPC=http://127.0.0.1:$FORK
  STATE=$TMP_BASE/upgrade-airlock-fork-$FORK
  DEPLOY_JSON=${DEPLOY_JSON:-$STATE/deployment.json}
  NET="anvil fork :$FORK"
else
  MODE=live
  RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
  STATE=${AIRLOCK_STATE:-$TMP_BASE/upgrade-airlock-sepolia}
  DEPLOY_JSON=${DEPLOY_JSON:-$ROOT/deployments/sepolia.json}
  NET="Ethereum Sepolia"
fi
mkdir -p "$STATE"

# ---------------------------------------------------------------- keys (never printed)

# read_key <owner|attester|sender|approver|emergency>: the 0x-prefixed key on stdout, for capture into a variable only.
read_key() {
  local f="$KEY_DIR/$1.key" k
  [ -r "$f" ] || die "missing or unreadable key file $1.key in KEY_DIR"
  k=$(tr -d ' \t\r\n' <"$f")
  [[ "$k" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || die "$1.key does not hold a 32-byte hex private key"
  [[ "$k" == 0x* ]] || k=0x$k
  printf '%s' "$k"
}

# addr_of <role>
addr_of() {
  local k
  k=$(read_key "$1")
  cast wallet address --private-key "$k"
}

# ---------------------------------------------------------------- chain

# rpc_retry <command...>: runs a read-only chain command up to RPC_TRIES times (default 3), 2 s apart, so a transient
# RPC error (a rate limit, a reset connection, a load-balanced node without the data) does not stop a stage command.
# Only the last attempt's error is shown. Never wrap anything that sends a transaction (send_as): a retry could send
# it twice.
rpc_retry() {
  local n=${RPC_TRIES:-3} i=1 out
  while :; do
    if [ "$i" -lt "$n" ]; then
      if out=$("$@" 2>/dev/null); then printf '%s\n' "$out"; return 0; fi
    else
      if out=$("$@"); then printf '%s\n' "$out"; return 0; fi
      return 1
    fi
    i=$((i + 1))
    sleep 2
  done
}

# The RPC must be Sepolia (chain id 11155111); in FORK mode it must also be an anvil node on loopback, so a FORK run
# can never send anything to a public network.
check_rpc() {
  local cid cv
  cid=$(rpc_retry cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "no RPC answering at $RPC${FORK:+ (start the fork: FORK=$FORK $KIT/fork.sh start)}"
  [ "$cid" = "$CHAIN_ID" ] || die "chain id $cid at $RPC, expected $CHAIN_ID (Sepolia)"
  if [ "$MODE" = fork ]; then
    cv=$(cast rpc web3_clientVersion --rpc-url "$RPC" 2>/dev/null | tr -d '"') || cv=unknown
    [[ "$cv" == anvil* ]] || die "FORK=$FORK: $RPC is not an anvil node ($cv); refusing"
  fi
}

block_now() { rpc_retry cast block-number --rpc-url "$RPC"; }
block_ts() {
  local b
  b=$(rpc_retry cast rpc eth_getBlockByNumber "$(printf '0x%x' "$1")" false --rpc-url "$RPC") || return 1
  cast to-dec "$(jq -r .timestamp <<<"$b")"
}

# dep <key>: a field of the deployment JSON (airlockAdmin, receiver, evilMint, ...).
dep() {
  [ -f "$DEPLOY_JSON" ] || die "no deployment at $DEPLOY_JSON (run deploy.sh${FORK:+ with FORK=$FORK} first)"
  local v
  v=$(jq -r --arg k "$1" '.[$k] // empty' "$DEPLOY_JSON")
  if [ -z "$v" ]; then
    [ "$1" = airlockAdmin ] && die "$DEPLOY_JSON has no airlockAdmin, so it is not a deployment of this stack; deploy it with deploy.sh"
    die "deployment JSON has no '$1'"
  fi
  printf '%s' "$v"
}

tx_ref() { if [ "$MODE" = live ]; then say "$EXPLORER/tx/$1"; else say "$1"; fi; }
addr_ref() { if [ "$MODE" = live ]; then say "$EXPLORER/address/$1"; else say "$1"; fi; }

# send_as <role> <cast send args...>: sends with that key and prints the receipt JSON.
send_as() {
  local who=$1 k
  shift
  k=$(read_key "$who")
  cast send "$@" --private-key "$k" --rpc-url "$RPC" --json
}

# ---------------------------------------------------------------- AirlockAdmin

PROPOSAL_SIG='getProposal(uint256)((uint8,uint8,address,address,uint256,bytes32,bytes32,uint64,uint64,uint256))'
STATUS_NAMES=(None Pending Vetoed Executed)
KIND_NAMES=(upgrade set-guardian set-delay set-paused-impl)
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

# Rule ids: read from the workflow (cre/veto/rules.ts) so a new rule shows up here without an edit; this list is
# the fallback. ruleHash = keccak256("GUARD/<ID>").
RULE_IDS=(R1_TOTAL_SUPPLY R2_OWNER R3_TRANSFER_CONSERVATION R4_TRANSFER_LIVENESS R5_STRICT_CODEHASH R6_SIM_FAILURE
  R7_CONFIG_GUARD R8_INIT_DATA R3B_THIRD_PARTY_FUNDS R9_NEW_OPCODES)
if [ -f "$ROOT/cre/veto/rules.ts" ]; then
  _ids=$(grep -oE "'R[0-9][0-9A-Z_]*'" "$ROOT/cre/veto/rules.ts" | tr -d "'" | awk '!s[$0]++' || true)
  [ -n "$_ids" ] && read -r -a RULE_IDS <<<"$(tr '\n' ' ' <<<"$_ids")"
  unset _ids
fi

# proposal <id>: "kind status target readyBlock vetoCount proposedBlock" (numbers as decimals). Fails (status 1, no
# output) when the RPC does not answer after the retries.
proposal() {
  local ga raw
  ga=$(dep airlockAdmin)
  raw=$(rpc_retry cast call "$ga" "$PROPOSAL_SIG" "$1" --rpc-url "$RPC") || return 1
  # (kind, status, proposer, target, value, codehash, dataHash, proposedBlock, readyBlock, vetoCount)
  sed -E 's/^\((.*)\)$/\1/; s/ \[[^]]*\]//g' <<<"$raw" | awk -F', ' '{print $1, $2, $4, $9, $10, $8}'
}

# clearance <id>: the evidence hash AirlockAdmin recorded for the proposal, or 0x00..00 when it is not cleared.
clearance() { rpc_retry cast call "$(dep airlockAdmin)" 'clearanceOf(uint256)(bytes32)' "$1" --rpc-url "$RPC"; }

# oracle_judged <id>: true once the clearance oracle (the CRE receiver) has answered the proposal with a Clear or a
# Veto, false while it has not (also after an approver's clearance: the sweeper still judges it, and a CRE veto
# wins), "?" when the deployment has no AirlockAdmin.oracleJudged.
oracle_judged() { cast call "$(dep airlockAdmin)" 'oracleJudged(uint256)(bool)' "$1" --rpc-url "$RPC" 2>/dev/null || say '?'; }

# state_name <status> <clearance>: Pending (not judged yet) / Cleared (pending, may execute after readyBlock) /
# Vetoed / Executed.
state_name() {
  if [ "$1" = 1 ] && [ "$2" != "$ZERO32" ]; then say Cleared; else say "${STATUS_NAMES[$1]}"; fi
}

# rule_name <ruleHash>: R1_TOTAL_SUPPLY etc.
rule_name() {
  local want r
  want=$(lc "$1")
  [ "$want" = "$ZERO32" ] && { say "-"; return; }
  for r in "${RULE_IDS[@]}"; do
    [ "$(cast keccak "GUARD/$r")" = "$want" ] && { say "$r"; return; }
  done
  say "unknown($1)"
}

# impl_name <address>: the deployment key that has this address (v2, evilMint, receiver, emergencyGuardian, ...),
# or the address.
impl_name() {
  local a k
  a=$(lc "$1")
  k=$(jq -r --arg a "$a" '[to_entries[] | select((.value|type)=="string" and (.value|ascii_downcase)==$a) | .key][0] // empty' "$DEPLOY_JSON")
  if [ -n "$k" ]; then say "$k"; else say "$1"; fi
}

# who_name <address>: receiver (CRE), approver, emergencyGuardian, owner, or the address.
who_name() {
  local n
  n=$(impl_name "$1")
  case "$n" in receiver) say "CRE receiver" ;; *) say "$n" ;; esac
}

# events_since <fromBlock>: one line per AirlockAdmin judgement event, oldest first:
#   "vetoed   <id> <ruleHash>     <guardian> <tx> <block>"
#   "cleared  <id> <evidenceHash> <clearer>  <tx> <block>"
#   "reason   <id> <reportHash>   <guardian> <tx> <block>"
#   "executed <id> -              <executor> <tx> <block>"
# One eth_getLogs from the deployment block is refused by most public RPCs (publicnode answers some requests with
# 4444 "pruned history unavailable", drpc's free plan caps the range), so the scan runs in windows of EVENTS_CHUNK
# blocks (default 5000). Each window is asked of every history RPC in turn, for up to RPC_TRIES rounds 2 s apart:
# live, HISTORY_RPC (comma-separated) or else SEPOLIA_RPC and then the Tenderly public gateway, which keeps the full
# history; a fork run reads only its anvil (HISTORY_RPC is ignored there). A window no RPC serves is skipped with a
# warning on stderr (rows in it show '-' for the rule, evidence and verdict tx), and the function never fails, so
# `set -e` callers keep going.
# EVENTS_FROM (a block number) starts the scan later.
HISTORY_FALLBACK=https://sepolia.gateway.tenderly.co
events_since() {
  local ga tv tc tr te from to lo hi chunk url got round all='' skipped=0
  local -a urls
  ga=$(dep airlockAdmin)
  from=${EVENTS_FROM:-$1}
  chunk=${EVENTS_CHUNK:-5000}
  [[ "$from" =~ ^[0-9]+$ ]] || { say "warning: event scan start '$from' is not a block number; no events read" >&2; return 0; }
  [[ "$chunk" =~ ^[1-9][0-9]*$ ]] || chunk=5000
  if [ "$MODE" = fork ]; then
    urls=("$RPC") # a fork run talks to the loopback anvil only, whatever HISTORY_RPC says
  elif [ -n "${HISTORY_RPC:-}" ]; then
    IFS=',' read -r -a urls <<<"$HISTORY_RPC"
  else
    urls=("$RPC" "$HISTORY_FALLBACK")
  fi
  [ "${#urls[@]}" -gt 0 ] || urls=("$RPC")
  to=$(block_now 2>/dev/null) || { say "warning: no block number from $RPC; no events read" >&2; return 0; }
  tv=$(cast keccak 'Vetoed(uint256,address,bytes32,uint256)')
  tc=$(cast keccak 'Cleared(uint256,address,bytes32)')
  tr=$(cast keccak 'ReasonAttached(uint256,address,bytes32)')
  te=$(cast keccak 'Executed(uint256,address)')
  for ((lo = from; lo <= to; lo += chunk)); do
    hi=$((lo + chunk - 1))
    [ "$hi" -le "$to" ] || hi=$to
    got=
    for ((round = 1; round <= ${RPC_TRIES:-3}; round++)); do
      for url in "${urls[@]}"; do
        if got=$(logs_window "$url" "$lo" "$hi" "$ga"); then break 2; fi
        got=
      done
      [ "$round" -lt "${RPC_TRIES:-3}" ] && sleep 2
    done
    if [ -n "$got" ]; then all+="$got"$'\n'; else skipped=$((skipped + 1)); say "warning: no RPC served AirlockAdmin events in blocks $lo-$hi" >&2; fi
  done
  [ "$skipped" = 0 ] || say "warning: $skipped event window(s) skipped: rows there show '-' for the rule, evidence and verdict tx (set HISTORY_RPC to an RPC that keeps the history, or EVENTS_FROM to a recent block)" >&2
  [ -n "$all" ] || return 0
  jq -rs --arg tv "$tv" --arg tc "$tc" --arg tr "$tr" --arg te "$te" '
      def w(i): .data[2 + 64 * i: 66 + 64 * i];
      def addr(x): "0x" + x[24:64];
      def num: ltrimstr("0x") | ascii_downcase | explode
        | reduce .[] as $c (0; . * 16 + (if $c >= 97 then $c - 87 else $c - 48 end));
      add | .[] | . as $l
      | (if .topics[0] == $tv then "vetoed \(.topics[1] | num) 0x\(w(0)) \(addr(.topics[2][2:]))"
         elif .topics[0] == $tc then "cleared \(.topics[1] | num) 0x\(w(0)) \(addr(.topics[2][2:]))"
         elif .topics[0] == $tr then "reason \(.topics[1] | num) 0x\(w(1)) \(addr(w(0)))"
         elif .topics[0] == $te then "executed \(.topics[1] | num) - \(addr(w(0)))"
         else empty end) + " \($l.transactionHash) \($l.blockNumber | num)"' <<<"$all" \
    || { say "warning: could not parse the event logs; no events read" >&2; return 0; }
}

# logs_window <rpc> <from> <to> <address>: one eth_getLogs; the JSON array on stdout, or status 1 (cast prints an
# error object instead of an array when the RPC refuses).
logs_window() {
  local out
  out=$(cast logs --from-block "$2" --to-block "$3" --address "$4" --rpc-url "$1" --json 2>/dev/null) || return 1
  jq -e 'type == "array"' >/dev/null 2>&1 <<<"$out" || return 1
  printf '%s\n' "$out"
}

# first_event <kind> <id> <events text>: the first matching line ("kind id value who tx block") or nothing.
first_event() { awk -v k="$1" -v id="$2" '$1==k && $2==id && !f {print; f=1}' <<<"$3"; }

fmt_secs() { local s=$1; if [ "$s" -ge 60 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi; }
short() { local h=$1; if [ "${#h}" -gt 14 ]; then printf '%s..%s' "${h:0:8}" "${h: -4}"; else printf '%s' "$h"; fi; }

# ---------------------------------------------------------------- CRE simulator

# The workflow config for this mode: live -> cre/veto/config.sepolia.json (make-config.mjs writes it);
# fork -> generated into $STATE from the fork deployment, every provider pointing at the fork.
workflow_config() {
  if [ "$MODE" = fork ]; then
    CONFIG=$STATE/config.fork.json
    if [ ! -f "$CONFIG" ] || [ "$DEPLOY_JSON" -nt "$CONFIG" ] || [ "$KIT/make-config.mjs" -nt "$CONFIG" ]; then
      # bun checks the result against the workflow's own schema (cre/veto/config.ts); node writes it unchecked
      "$(command -v bun || echo node)" "$KIT/make-config.mjs" "$DEPLOY_JSON" --fork-rpc "$RPC" --out "$CONFIG" >/dev/null
    fi
    TARGET=sepolia-fork
    export VETO_ANVIL_PORT=$FORK # cre/project.yaml: sepolia-fork -> http://127.0.0.1:${VETO_ANVIL_PORT}
  else
    CONFIG=${WORKFLOW_CONFIG:-$ROOT/cre/veto/config.sepolia.json}
    [ -f "$CONFIG" ] || die "no $(basename "$CONFIG") (run: node scripts/sepolia/make-config.mjs)"
    TARGET=sepolia
  fi
  local want have
  want=$(lc "$(dep airlockAdmin)")
  have=$(lc "$(jq -r '.airlockAdmin // empty' "$CONFIG")")
  [ "$have" = "$want" ] || die "$(basename "$CONFIG") watches '${have:-nothing}', the deployment is $want (re-run make-config.mjs)"
}

# attester_env: the environment variable the simulator reads the attester secret from (cre/secrets.yaml).
attester_env() {
  local n
  n=$(awk '/^secretsNames:/ {s=1; next} s && /^[[:space:]]+-[[:space:]]+[A-Z0-9_]+/ {print $2; exit}' "$ROOT/cre/secrets.yaml" 2>/dev/null || true)
  say "${n:-VETO_ATTESTER_KEY_ALL}"
}

# sim_bin: the CRE CLI to run (CRE_SIM, default `cre`).
sim_bin() {
  SIM=${CRE_SIM:-cre}
  command -v "$SIM" >/dev/null 2>&1 || die "CRE CLI '$SIM' not found (cre/setup.sh installs it; or set CRE_SIM)"
}

# wasm_build: compiles the workflow once per source version (cre workflow build) and sets WASM_ARGS, so the
# listener and the sweeper run the same binary and a sweep does not recompile every minute. The cache is
# <state dir>/wasm/<hash>.wasm, or $TMPDIR/airlock-wasm-<uid>/ when that path is longer than the CLI's 97-character
# limit for --wasm (the directory must belong to this user). WASM_CACHE=0 skips the cache (the simulator then
# compiles on every run).
wasm_build() {
  WASM_ARGS=()
  [ "${WASM_CACHE:-1}" = 1 ] || return 0
  local h dir out tmp log
  h=$(cd "$ROOT/cre/veto" && cat ./*.ts package.json bun.lock 2>/dev/null | shasum -a 256 | cut -c1-16)
  dir=$STATE/wasm
  [ $((${#dir} + 22)) -le 97 ] || dir=$TMP_BASE/airlock-wasm-$(id -u)
  out=$dir/$h.wasm
  if [ ${#out} -gt 97 ]; then
    say "note: no workflow cache (the path $out is longer than the CLI accepts); the simulator compiles on each run" >&2
    return 0
  fi
  mkdir -p "$dir" && chmod 700 "$dir"
  [ -O "$dir" ] || { say "note: $dir is not owned by this user; the simulator compiles on each run" >&2; return 0; }
  if [ ! -s "$out" ]; then
    log=$dir/build-$h.log
    tmp=$dir/building-$$.wasm # the CLI appends .wasm to an output path without it
    say "compiling the workflow once for this source version (cre workflow build, about a minute) ..." >&2
    if (cd "$ROOT/cre" && "$SIM" workflow build ./veto -o "$tmp" >"$log" 2>&1) && [ -s "$tmp" ]; then
      mv "$tmp" "$out"
      find "$dir" -name '*.wasm' ! -name "$h.wasm" ! -name 'building-*' -delete 2>/dev/null || true
    else
      rm -f "$tmp" "$tmp.wasm"
      say "note: workflow build failed (log $log); the simulator compiles it on each run instead" >&2
      return 0
    fi
  fi
  WASM_ARGS=(--wasm "$out")
}
