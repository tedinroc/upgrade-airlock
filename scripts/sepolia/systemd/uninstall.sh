#!/usr/bin/env bash
# Stop, disable and remove the Upgrade Airlock user units installed by install.sh (current user only, no sudo).
#
#   scripts/sepolia/systemd/uninstall.sh           # keeps the env file and the state dir (logs)
#   scripts/sepolia/systemd/uninstall.sh --purge   # also removes the env file; the state dir is only printed
#   DRY_RUN=1 scripts/sepolia/systemd/uninstall.sh # print what it would do
set -euo pipefail
UNITS=(airlock-listener.service airlock-sweep.timer airlock-sweep.service)
UNIT_DIR=${SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
ENV_FILE=${ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/upgrade-airlock/airlock.env}
PURGE=
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -h | --help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "error: unknown option $a" >&2; exit 2 ;;
  esac
done
run() { if [ -n "${DRY_RUN:-}" ]; then echo "+ $*"; else "$@"; fi; }
[ "$(id -u)" != 0 ] || { echo "error: run this as the user that installed the units, not as root" >&2; exit 1; }

STATE=
if [ -f "$ENV_FILE" ]; then STATE=$(sed -n 's/^AIRLOCK_STATE=//p' "$ENV_FILE" | tail -n1); fi
if command -v systemctl >/dev/null && { [ -n "${DRY_RUN:-}" ] || systemctl --user show-environment >/dev/null 2>&1; }; then
  run systemctl --user disable --now airlock-listener.service airlock-sweep.timer || true
  run systemctl --user stop airlock-sweep.service || true
fi
for u in "${UNITS[@]}"; do
  if [ -f "$UNIT_DIR/$u" ]; then run rm -f "$UNIT_DIR/$u"; [ -n "${DRY_RUN:-}" ] || echo "removed $UNIT_DIR/$u"; fi
done
if command -v systemctl >/dev/null && { [ -n "${DRY_RUN:-}" ] || systemctl --user show-environment >/dev/null 2>&1; }; then
  run systemctl --user daemon-reload
  run systemctl --user reset-failed airlock-listener.service airlock-sweep.service 2>/dev/null || true
fi
if [ -n "$PURGE" ] && [ -f "$ENV_FILE" ]; then run rm -f "$ENV_FILE"; [ -n "${DRY_RUN:-}" ] || echo "removed $ENV_FILE"; fi
[ -z "$PURGE" ] && [ -f "$ENV_FILE" ] && echo "kept $ENV_FILE (--purge removes it)"
[ -n "$STATE" ] && echo "kept the state dir $STATE (logs; delete it yourself when no longer needed)"
exit 0
