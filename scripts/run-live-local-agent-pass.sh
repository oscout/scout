#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Run a same-machine Codex <-> Claude broker e2e pass against a fresh local broker.

This helper:
1. builds runtime artifacts unless OPENSCOUT_SKIP_BUILD=1
2. starts an isolated broker on a random localhost port
3. starts one Codex-backed agent in the repo root
4. starts one Claude-backed agent from a detached worktree
5. runs one real broker-routed ask in each direction around a mission
6. saves mission, prompt, snapshot, and event artifacts for inspection

Usage:
  bash scripts/run-live-local-agent-pass.sh [options]

Options:
  --mission <text>             Open-ended mission for this e2e pass
  --codex-to-claude <text>     Exact prompt sent from Codex to Claude
  --claude-to-codex <text>     Exact prompt sent from Claude to Codex
  --keep                       Preserve broker artifacts after a successful run
  --skip-build                 Reuse existing runtime build artifacts

Useful environment overrides:
  OPENSCOUT_E2E_MISSION="Verify docs freshness and update the KB if needed"
  OPENSCOUT_E2E_CODEX_TO_CLAUDE_PROMPT="..."
  OPENSCOUT_E2E_CLAUDE_TO_CODEX_PROMPT="..."
  OPENSCOUT_SKIP_BUILD=1
  OPENSCOUT_KEEP_LIVE_PASS=1
  OPENSCOUT_LIVE_PASS_ROOT=/tmp/custom-live-pass
  OPENSCOUT_BROKER_PORT=37800
  OPENSCOUT_CLAUDE_BIN=/Users/you/.local/bin/claude
  OPENSCOUT_BUN_BIN=/Users/you/.bun/bin/bun
EOF
}

MISSION_ARG=""
PROMPT_CODEX_TO_CLAUDE_ARG=""
PROMPT_CLAUDE_TO_CODEX_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --mission)
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "--mission requires a value." >&2
        exit 2
      fi
      MISSION_ARG="${2:-}"
      shift 2
      ;;
    --mission=*)
      MISSION_ARG="${1#*=}"
      shift
      ;;
    --codex-to-claude)
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "--codex-to-claude requires a value." >&2
        exit 2
      fi
      PROMPT_CODEX_TO_CLAUDE_ARG="${2:-}"
      shift 2
      ;;
    --codex-to-claude=*)
      PROMPT_CODEX_TO_CLAUDE_ARG="${1#*=}"
      shift
      ;;
    --claude-to-codex)
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "--claude-to-codex requires a value." >&2
        exit 2
      fi
      PROMPT_CLAUDE_TO_CODEX_ARG="${2:-}"
      shift 2
      ;;
    --claude-to-codex=*)
      PROMPT_CLAUDE_TO_CODEX_ARG="${1#*=}"
      shift
      ;;
    --keep)
      export OPENSCOUT_KEEP_LIVE_PASS=1
      shift
      ;;
    --skip-build)
      export OPENSCOUT_SKIP_BUILD=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

find_bin() {
  local override="$1"
  local fallback="$2"
  local common_path="${3:-}"
  if [[ -n "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  if command -v "$fallback" >/dev/null 2>&1; then
    command -v "$fallback"
    return 0
  fi
  if [[ -n "$common_path" && -x "$common_path" ]]; then
    printf '%s\n' "$common_path"
    return 0
  fi
  return 1
}

BUN_BIN="$(find_bin "${OPENSCOUT_BUN_BIN:-}" bun "$HOME/.bun/bin/bun" || true)"
CLAUDE_BIN="$(find_bin "${OPENSCOUT_CLAUDE_BIN:-}" claude "$HOME/.local/bin/claude" || true)"
GIT_BIN="$(find_bin "" git || true)"
CURL_BIN="$(find_bin "" curl || true)"

if [[ -z "$BUN_BIN" ]]; then
  echo "Missing Bun. Install Bun or set OPENSCOUT_BUN_BIN." >&2
  exit 1
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "Missing Claude CLI. Install it or set OPENSCOUT_CLAUDE_BIN." >&2
  exit 1
fi
if [[ -z "$GIT_BIN" || -z "$CURL_BIN" ]]; then
  echo "Missing required dependency: git and curl must be on PATH." >&2
  exit 1
fi

export PATH
PATH="$(dirname "$CLAUDE_BIN"):$(dirname "$BUN_BIN"):$PATH"

if [[ "${OPENSCOUT_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building runtime"
  (
    cd "$ROOT_DIR" &&
    "$BUN_BIN" run --cwd packages/runtime build >/dev/null
  )
fi

if [[ -n "${OPENSCOUT_BROKER_PORT:-}" ]]; then
  BROKER_PORT="$OPENSCOUT_BROKER_PORT"
else
  BROKER_PORT="$("$BUN_BIN" -e 'import net from "node:net"; const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") process.exit(1); console.log(address.port); server.close(); });')"
fi

TMP_ROOT="${OPENSCOUT_LIVE_PASS_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/openscout-live-agent-pass.XXXXXX")}"
CLAUDE_WORKTREE="${OPENSCOUT_LIVE_CLAUDE_WORKTREE:-$(mktemp -d "${TMPDIR:-/tmp}/openscout-live-claude-wt.XXXXXX")}"
DEFAULT_NODE_QUALIFIER="e2e-pass-$("$BUN_BIN" -e 'console.log(Math.random().toString(36).slice(2, 8))')"

export OPENSCOUT_SUPPORT_DIRECTORY="$TMP_ROOT/support"
export OPENSCOUT_CONTROL_HOME="$TMP_ROOT/control"
export OPENSCOUT_RELAY_HUB="$TMP_ROOT/relay"
export OPENSCOUT_NODE_QUALIFIER="${OPENSCOUT_NODE_QUALIFIER:-$DEFAULT_NODE_QUALIFIER}"
export OPENSCOUT_BROKER_HOST="${OPENSCOUT_BROKER_HOST:-127.0.0.1}"
export OPENSCOUT_BROKER_PORT="$BROKER_PORT"
export OPENSCOUT_SKIP_USER_PROJECT_HINTS="${OPENSCOUT_SKIP_USER_PROJECT_HINTS:-1}"

BROKER_URL="http://${OPENSCOUT_BROKER_HOST}:${OPENSCOUT_BROKER_PORT}"
SCOUT_CMD=("$BUN_BIN" "$ROOT_DIR/packages/cli/src/main.ts")
BROKER_CMD=("$BUN_BIN" "$ROOT_DIR/packages/runtime/dist/broker-daemon.js")

BROKER_PID=""
STARTED_AGENTS=0

cleanup() {
  local exit_code="$1"
  if [[ "$STARTED_AGENTS" == "1" ]]; then
    "${SCOUT_CMD[@]}" down --all >/dev/null 2>&1 || true
  fi
  if [[ -n "$BROKER_PID" ]] && kill -0 "$BROKER_PID" >/dev/null 2>&1; then
    kill "$BROKER_PID" >/dev/null 2>&1 || true
    wait "$BROKER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -d "$CLAUDE_WORKTREE" ]]; then
    "$GIT_BIN" -C "$ROOT_DIR" worktree remove --force "$CLAUDE_WORKTREE" >/dev/null 2>&1 || true
  fi
  if [[ "$exit_code" == "0" && "${OPENSCOUT_KEEP_LIVE_PASS:-0}" != "1" ]]; then
    rm -rf "$TMP_ROOT"
    return
  fi
  echo
  echo "Artifacts preserved at: $TMP_ROOT"
}

trap 'cleanup "$?"' EXIT

wait_for_broker() {
  local attempt=0
  while (( attempt < 60 )); do
    if "$CURL_BIN" -fsS "$BROKER_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Broker did not become healthy at $BROKER_URL within 60s." >&2
  return 1
}

extract_started_agent_id() {
  sed -n 's/^Started //p' | tail -n 1
}

wait_for_agent_route() {
  local agent_id="$1"
  for _ in $(seq 1 60); do
    if "$CURL_BIN" -fsS "$BROKER_URL/v1/snapshot" | "$BUN_BIN" -e '
      const agentId = process.argv[1];
      const input = await Bun.stdin.text();
      const snapshot = JSON.parse(input);
      const endpoints = Object.values(snapshot.endpoints ?? {});
      const isRoutable = endpoints.some((endpoint) => {
        return endpoint
          && typeof endpoint === "object"
          && endpoint.agentId === agentId
          && endpoint.state !== "offline";
      });
      process.exit(isRoutable ? 0 : 1);
    ' "$agent_id" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_agent_via_scout() {
  local project_path="$1"
  local agent_name="$2"
  local harness="$3"
  local log_path="$4"
  local scout_pid=""
  local agent_id=""

  "${SCOUT_CMD[@]}" up "$project_path" --name "$agent_name" --harness "$harness" </dev/null >"$log_path" 2>&1 &
  scout_pid="$!"

  for _ in $(seq 1 120); do
    if [[ -f "$log_path" ]]; then
      agent_id="$(extract_started_agent_id <"$log_path")"
      if [[ -n "$agent_id" ]]; then
        break
      fi
    fi
    if ! kill -0 "$scout_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if [[ -n "$agent_id" ]]; then
    if ! wait_for_agent_route "$agent_id"; then
      agent_id=""
    fi
  fi

  if kill -0 "$scout_pid" >/dev/null 2>&1; then
    kill "$scout_pid" >/dev/null 2>&1 || true
    wait "$scout_pid" >/dev/null 2>&1 || true
  fi

  if [[ -f "$log_path" ]]; then
    cat "$log_path" >&2
  fi

  if [[ -z "$agent_id" ]]; then
    return 1
  fi

  printf '%s\n' "$agent_id"
}

DEFAULT_E2E_MISSION="Run a practical OpenScout e2e verification pass: check docs freshness, knowledge-base gaps, and one concrete follow-up that would help the next release. Do not edit files unless the mission explicitly asks for edits."
E2E_MISSION="${MISSION_ARG:-${OPENSCOUT_E2E_MISSION:-${OPENSCOUT_LIVE_MISSION:-$DEFAULT_E2E_MISSION}}}"

printf -v DEFAULT_PROMPT_CODEX_TO_CLAUDE '%s\n%s\n\n%s' \
  "Mission:" \
  "$E2E_MISSION" \
  "You are the Claude-backed agent in an OpenScout broker e2e pass. Inspect the detached worktree and do one bounded, useful verification for the mission. Reply with concrete findings, file paths, and the next action you recommend. Keep it under 180 words. Do not edit files unless the mission explicitly asks for edits."

printf -v DEFAULT_PROMPT_CLAUDE_TO_CODEX '%s\n%s\n\n%s' \
  "Mission:" \
  "$E2E_MISSION" \
  "You are the Codex-backed agent in an OpenScout broker e2e pass. Do a complementary check in the main checkout, taking the prior Claude result into account if it is visible. For docs or KB missions, look for stale docs, missing updates, or a small useful patch. Keep it under 180 words. Do not edit files unless the mission explicitly asks for edits."

PROMPT_CODEX_TO_CLAUDE="${PROMPT_CODEX_TO_CLAUDE_ARG:-${OPENSCOUT_E2E_CODEX_TO_CLAUDE_PROMPT:-${OPENSCOUT_LIVE_PROMPT_CODEX_TO_CLAUDE:-$DEFAULT_PROMPT_CODEX_TO_CLAUDE}}}"
PROMPT_CLAUDE_TO_CODEX="${PROMPT_CLAUDE_TO_CODEX_ARG:-${OPENSCOUT_E2E_CLAUDE_TO_CODEX_PROMPT:-${OPENSCOUT_LIVE_PROMPT_CLAUDE_TO_CODEX:-$DEFAULT_PROMPT_CLAUDE_TO_CODEX}}}"

echo "==> Starting isolated broker at $BROKER_URL"
mkdir -p "$TMP_ROOT"
printf '%s\n' "$E2E_MISSION" >"$TMP_ROOT/mission.txt"
printf '%s\n' "$PROMPT_CODEX_TO_CLAUDE" >"$TMP_ROOT/codex-to-claude.prompt.txt"
printf '%s\n' "$PROMPT_CLAUDE_TO_CODEX" >"$TMP_ROOT/claude-to-codex.prompt.txt"
"${BROKER_CMD[@]}" >"$TMP_ROOT/broker.log" 2>&1 &
BROKER_PID="$!"
wait_for_broker

echo "==> Preparing detached worktree for Claude"
"$GIT_BIN" -C "$ROOT_DIR" worktree add --detach "$CLAUDE_WORKTREE" HEAD >/dev/null

echo "==> Starting Codex agent"
CODEX_AGENT_ID="$(start_agent_via_scout "$ROOT_DIR" "livecodex" "codex" "$TMP_ROOT/codex-up.log")"
if [[ -z "$CODEX_AGENT_ID" ]]; then
  echo "Unable to determine Codex agent id from scout up output." >&2
  exit 1
fi

echo "==> Starting Claude agent"
CLAUDE_AGENT_ID="$(start_agent_via_scout "$CLAUDE_WORKTREE" "liveclaude" "claude" "$TMP_ROOT/claude-up.log")"
if [[ -z "$CLAUDE_AGENT_ID" ]]; then
  echo "Unable to determine Claude agent id from scout up output." >&2
  exit 1
fi

STARTED_AGENTS=1

echo "==> E2E mission"
printf '%s\n' "$E2E_MISSION"

echo "==> Codex -> Claude"
"${SCOUT_CMD[@]}" ask --as "$CODEX_AGENT_ID" --to liveclaude "$PROMPT_CODEX_TO_CLAUDE" </dev/null >"$TMP_ROOT/codex-to-claude.log" 2>&1
cat "$TMP_ROOT/codex-to-claude.log"

echo "==> Claude -> Codex"
"${SCOUT_CMD[@]}" ask --as "$CLAUDE_AGENT_ID" --to livecodex "$PROMPT_CLAUDE_TO_CODEX" </dev/null >"$TMP_ROOT/claude-to-codex.log" 2>&1
cat "$TMP_ROOT/claude-to-codex.log"

echo "==> Capturing broker artifacts"
"$CURL_BIN" -fsS "$BROKER_URL/v1/snapshot" >"$TMP_ROOT/snapshot.json"
"$CURL_BIN" -fsS "$BROKER_URL/v1/events?limit=50" >"$TMP_ROOT/events.json"
"${SCOUT_CMD[@]}" who --json >"$TMP_ROOT/who.json"

echo
echo "E2E agent pass completed."
echo "  Broker:       $BROKER_URL"
echo "  Codex agent:  $CODEX_AGENT_ID"
echo "  Claude agent: $CLAUDE_AGENT_ID"
if [[ "${OPENSCOUT_KEEP_LIVE_PASS:-0}" == "1" ]]; then
  echo "  Artifacts:    $TMP_ROOT"
fi
