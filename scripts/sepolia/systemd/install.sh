#!/usr/bin/env bash
# Install the Upgrade Airlock services for the CURRENT USER ONLY (systemd --user; no sudo, nothing system-wide):
#   airlock-listener.service   airlock.sh in the foreground, restarted 5 s after any exit
#   airlock-sweep.service      one sweep.sh run
#   airlock-sweep.timer        starts the sweep every 60 s (Persistent)
#
#   scripts/sepolia/systemd/install.sh              # write the env file if missing, install, enable and start
#   scripts/sepolia/systemd/install.sh --no-start   # install and enable only
#   scripts/sepolia/systemd/install.sh --env-only   # only (re)write the env file and show it
#   DRY_RUN=1 scripts/sepolia/systemd/install.sh    # print the rendered units and the env file; change nothing
#
# The units read ~/.config/upgrade-airlock/airlock.env (ENV_FILE overrides). It holds settings, never keys:
# KEY_DIR (where owner/attester/sender/approver/emergency.key live), CRE_SIM, SEPOLIA_RPC, AIRLOCK_STATE (logs, PID
# files and the compiled workflow; default ~/.local/state/upgrade-airlock) and the PATH the services run with.
# On the first install it is written from the current shell's values (KEY_DIR, CRE_SIM, SEPOLIA_RPC, AIRLOCK_STATE,
# PATH); edit it and run install.sh again to apply. FORCE_ENV=1 rewrites it.
# Load the same file in the operator shell so propose.sh / status.sh see the services' state dir:
#   set -a; . ~/.config/upgrade-airlock/airlock.env; set +a
# The services keep running after logout only with lingering: LINGER=1 runs `loginctl enable-linger` for you.
# Pre-flight (skip with SKIP_CHECKS=1): Linux with a user systemd, not root, the attester and sender keys, a
# deployment with airlockAdmin, the workflow config, the CRE CLI, and cast/jq/bc/node on the services' PATH.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$KIT/../.." && pwd)
UNITS=(airlock-listener.service airlock-sweep.service airlock-sweep.timer)
UNIT_DIR=${SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
ENV_FILE=${ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/upgrade-airlock/airlock.env}
DRY=${DRY_RUN:-}
START=1 ENV_ONLY=
for a in "$@"; do
  case "$a" in
    --no-start) START= ;;
    --env-only) ENV_ONLY=1 ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "error: unknown option $a" >&2; exit 2 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ "$(id -u)" != 0 ] || die "run this as the user that runs the demo, not as root (the units are per-user)"
case "$ENV_FILE$UNIT_DIR$KIT" in *[[:space:]]*) die "paths with spaces are not supported in unit files" ;; esac

# ---------------------------------------------------------------- the env file (settings only, no keys)
env_text() {
  local sim
  sim=${CRE_SIM:-$(command -v cre 2>/dev/null || echo cre)}
  cat <<EOF
# Upgrade Airlock services (systemd --user): settings only. Never put a key in here; KEY_DIR points at the key files.
# Written by scripts/sepolia/systemd/install.sh. Edit, then run install.sh again (or systemctl --user restart ...).
KEY_DIR=${KEY_DIR:-$HOME/.config/ethsz-2026}
CRE_SIM=$sim
SEPOLIA_RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
AIRLOCK_STATE=${AIRLOCK_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/upgrade-airlock}
PATH=$PATH
# Optional:
#   DEPLOY_JSON=<deployment json>        default: deployments/sepolia.json in the repo
#   WORKFLOW_CONFIG=<workflow config>    default: cre/veto/config.sepolia.json in the repo
#   SWEEP_MIN_AGE=3                      blocks a proposal is left to the listener before the sweeper takes it
#   WASM_CACHE=0                         compile the workflow inside every simulator run
EOF
}
if [ -n "$DRY" ]; then
  say "# ---- $ENV_FILE$([ -f "$ENV_FILE" ] && echo ' (exists; kept unless FORCE_ENV=1)')"
  if [ -f "$ENV_FILE" ] && [ -z "${FORCE_ENV:-}" ]; then cat "$ENV_FILE"; else env_text; fi
elif [ ! -f "$ENV_FILE" ] || [ -n "${FORCE_ENV:-}" ] || [ -n "$ENV_ONLY" ]; then
  if [ -f "$ENV_FILE" ] && [ -z "${FORCE_ENV:-}" ]; then
    say "env file $ENV_FILE exists; FORCE_ENV=1 rewrites it from this shell"
  else
    mkdir -p "$(dirname "$ENV_FILE")"
    (umask 077 && env_text >"$ENV_FILE")
    say "wrote $ENV_FILE"
  fi
fi
[ -z "$ENV_ONLY" ] || { cat "$ENV_FILE"; exit 0; }

# ---------------------------------------------------------------- pre-flight, with the services' own settings
if [ -z "${SKIP_CHECKS:-}" ] && [ -z "$DRY" ]; then
  [ "$(uname -s)" = Linux ] || die "systemd user units need Linux (SKIP_CHECKS=1 to install anyway)"
  command -v systemctl >/dev/null || die "no systemctl"
  systemctl --user show-environment >/dev/null 2>&1 || die "no user systemd instance for $(id -un) (log in through a real session, or enable lingering)"
  (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    for t in cast jq bc node; do command -v "$t" >/dev/null || die "$t is not on the PATH in $ENV_FILE"; done
    command -v "$CRE_SIM" >/dev/null 2>&1 || die "CRE_SIM=$CRE_SIM in $ENV_FILE is not an executable"
    for r in attester sender; do [ -r "$KEY_DIR/$r.key" ] || die "no readable $r.key in KEY_DIR=$KEY_DIR"; done
    D=${DEPLOY_JSON:-$ROOT/deployments/sepolia.json}
    [ -f "$D" ] && jq -e '.airlockAdmin' "$D" >/dev/null || die "$D has no airlockAdmin (deploy with scripts/sepolia/deploy.sh)"
    C=${WORKFLOW_CONFIG:-$ROOT/cre/veto/config.sepolia.json}
    [ -f "$C" ] || die "no workflow config $C (node scripts/sepolia/make-config.mjs)"
    [ "$(jq -r .airlockAdmin "$C" | tr 'A-F' 'a-f')" = "$(jq -r .airlockAdmin "$D" | tr 'A-F' 'a-f')" ] \
      || die "$C is for another deployment (re-run make-config.mjs)"
  )
  if [ "${LINGER:-}" = 1 ]; then
    loginctl enable-linger "$(id -un)" && say "lingering enabled: the services keep running after logout"
  elif [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
    say "note: lingering is off, so the services stop when your last session ends (LINGER=1 install.sh, or: loginctl enable-linger)"
  fi
fi

# ---------------------------------------------------------------- units
render() { sed -e "s|@KIT@|$KIT|g" -e "s|@ENV_FILE@|$ENV_FILE|g" "$HERE/$1"; }
if [ -n "$DRY" ]; then
  for u in "${UNITS[@]}"; do say "# ---- $UNIT_DIR/$u"; render "$u"; done
  say "# ---- then: systemctl --user daemon-reload; systemctl --user enable${START:+ --now} airlock-listener.service airlock-sweep.timer"
  exit 0
fi
mkdir -p "$UNIT_DIR"
for u in "${UNITS[@]}"; do
  render "$u" >"$UNIT_DIR/$u.tmp" && chmod 644 "$UNIT_DIR/$u.tmp" && mv "$UNIT_DIR/$u.tmp" "$UNIT_DIR/$u"
  say "installed $UNIT_DIR/$u"
done
systemctl --user daemon-reload
if [ -n "$START" ]; then
  systemctl --user enable airlock-listener.service airlock-sweep.timer
  systemctl --user restart airlock-listener.service
  systemctl --user restart airlock-sweep.timer
  say "started: airlock-listener.service, airlock-sweep.timer"
else
  systemctl --user enable airlock-listener.service airlock-sweep.timer
  say "enabled (not started): systemctl --user start airlock-listener.service airlock-sweep.timer"
fi
say ""
say "  status    systemctl --user status airlock-listener.service; systemctl --user list-timers airlock-sweep.timer"
say "  logs      journalctl --user -u airlock-listener -f;  journalctl --user -u airlock-sweep -n 50"
say "  shell     set -a; . $ENV_FILE; set +a   (then propose.sh / status.sh share the services' state dir)"
say "  remove    $HERE/uninstall.sh"
