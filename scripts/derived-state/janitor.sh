#!/usr/bin/env bash
# OpenScout unattended janitor. Dry-run unless --apply is passed explicitly.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MODE="${1:-}"
STATE_ROOT="${OPENSCOUT_DERIVED_STATE_ROOT:-$HOME/.local/state/openscout/derived-state}"

run_janitor() {
  local apply="${1:-}"
  local result=0 code=0
  if [ "$apply" = "--apply" ]; then
    python3 "$SCRIPT_DIR/reap.py" --fetch --apply || result=$?
    # This cache is a separate mechanism from Git-copy retirement. The studio
    # script independently refuses to act while a dev server is using the tree.
    python3 "$SCRIPT_DIR/studio-cache.py" --apply || { code=$?; [ "$result" -ne 0 ] || result=$code; }
  else
    python3 "$SCRIPT_DIR/reap.py" || result=$?
    python3 "$SCRIPT_DIR/studio-cache.py" || { code=$?; [ "$result" -ne 0 ] || result=$code; }
  fi
  return "$result"
}

if [ "$MODE" = "--apply" ]; then
  mkdir -p "$STATE_ROOT"
  LAST_RUN="$STATE_ROOT/janitor-last.log"
  ATTENTION="$STATE_ROOT/attention.txt"
  TMP="$STATE_ROOT/janitor-last.$$.tmp"
  status=0
  run_janitor --apply >"$TMP" 2>&1 || status=$?
  mv "$TMP" "$LAST_RUN"
  grep 'review:' "$LAST_RUN" >"$ATTENTION" || : >"$ATTENTION"
  cat "$LAST_RUN"
  exit "$status"
else
  run_janitor
fi
