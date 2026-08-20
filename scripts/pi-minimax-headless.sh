#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Run pi headlessly with the MiniMax provider.

Usage:
  bash scripts/pi-minimax-headless.sh [options] [--] [prompt...]

Options:
  --model <model>          MiniMax model (default: MiniMax-M3)
  --thinking <level>       Pi thinking level (default: low)
  --tools <tools>          Comma-separated Pi tools
                           (default: read,bash,edit,write,grep,find,ls)
  --cwd <path>             Working directory for the pi process
  --keep-session           Save the pi session instead of using --no-session
  --session <path>         Use a specific pi session file
  --session-dir <path>     Use a specific pi session directory
  --help                   Show this help

Environment:
  MINIMAX_API_KEY          Preferred MiniMax key name used by pi
  MINIMAX_TOKEN            Accepted fallback when MINIMAX_API_KEY is unset
  macOS Keychain secret    Used as fallback when env values are unset
  OPENSCOUT_PI_BIN         Optional pi executable path/name
  OPENSCOUT_PI_MINIMAX_MODEL
  OPENSCOUT_PI_MINIMAX_THINKING
  OPENSCOUT_PI_MINIMAX_TOOLS
EOF
}

MODEL="${OPENSCOUT_PI_MINIMAX_MODEL:-MiniMax-M3}"
THINKING="${OPENSCOUT_PI_MINIMAX_THINKING:-low}"
TOOLS="${OPENSCOUT_PI_MINIMAX_TOOLS:-read,bash,edit,write,grep,find,ls}"
PI_BIN="${OPENSCOUT_PI_BIN:-pi}"
WORKDIR=""
SESSION_MODE="none"
PI_EXTRA_ARGS=()
PROMPT_ARGS=()

require_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "$flag requires a value." >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --model)
      require_value "$1" "${2:-}"
      MODEL="$2"
      shift 2
      ;;
    --model=*)
      MODEL="${1#*=}"
      shift
      ;;
    --thinking)
      require_value "$1" "${2:-}"
      THINKING="$2"
      shift 2
      ;;
    --thinking=*)
      THINKING="${1#*=}"
      shift
      ;;
    --tools)
      require_value "$1" "${2:-}"
      TOOLS="$2"
      shift 2
      ;;
    --tools=*)
      TOOLS="${1#*=}"
      shift
      ;;
    --cwd)
      require_value "$1" "${2:-}"
      WORKDIR="$2"
      shift 2
      ;;
    --cwd=*)
      WORKDIR="${1#*=}"
      shift
      ;;
    --keep-session)
      SESSION_MODE="keep"
      shift
      ;;
    --session)
      require_value "$1" "${2:-}"
      SESSION_MODE="keep"
      PI_EXTRA_ARGS+=(--session "$2")
      shift 2
      ;;
    --session=*)
      SESSION_MODE="keep"
      PI_EXTRA_ARGS+=(--session "${1#*=}")
      shift
      ;;
    --session-dir)
      require_value "$1" "${2:-}"
      SESSION_MODE="keep"
      PI_EXTRA_ARGS+=(--session-dir "$2")
      shift 2
      ;;
    --session-dir=*)
      SESSION_MODE="keep"
      PI_EXTRA_ARGS+=(--session-dir "${1#*=}")
      shift
      ;;
    --)
      shift
      PROMPT_ARGS+=("$@")
      break
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      PROMPT_ARGS+=("$1")
      shift
      ;;
  esac
done

if ! command -v "$PI_BIN" >/dev/null 2>&1; then
  echo "Missing pi executable. Install pi or set OPENSCOUT_PI_BIN." >&2
  exit 1
fi

read_secret_value() {
  local key="$1"
  if ! command -v secret >/dev/null 2>&1; then
    return 1
  fi
  secret get "$key" 2>/dev/null || true
}

MINIMAX_KEY="${MINIMAX_API_KEY:-${MINIMAX_TOKEN:-}}"
if [[ -z "$MINIMAX_KEY" ]]; then
  MINIMAX_KEY="$(read_secret_value MINIMAX_API_KEY)"
fi
if [[ -z "$MINIMAX_KEY" ]]; then
  echo "Missing MiniMax key. Set it in the shell or local secret store." >&2
  exit 1
fi

if [[ -n "$WORKDIR" ]]; then
  cd "$WORKDIR"
fi

PI_ARGS=(
  --print
  --provider minimax
  --model "$MODEL"
  --thinking "$THINKING"
  --tools "$TOOLS"
)

if [[ "$SESSION_MODE" == "none" ]]; then
  PI_ARGS+=(--no-session)
fi

if [[ "${#PI_EXTRA_ARGS[@]}" -gt 0 ]]; then
  PI_ARGS+=("${PI_EXTRA_ARGS[@]}")
fi

if [[ "${#PROMPT_ARGS[@]}" -eq 0 ]]; then
  if [[ -t 0 ]]; then
    PROMPT_ARGS=("Reply exactly: openscout-pi-minimax-ok")
  else
    PROMPT_ARGS=("$(cat)")
  fi
fi

ENV_ARGS=()
add_env_if_set() {
  local key="$1"
  local value="${!key-}"
  if [[ -n "$value" ]]; then
    ENV_ARGS+=("$key=$value")
  fi
}

for key in PATH HOME USER LOGNAME SHELL TMPDIR TEMP TMP TERM LANG LC_ALL LC_CTYPE; do
  add_env_if_set "$key"
done
ENV_ARGS+=("MINIMAX_API_KEY=$MINIMAX_KEY")

exec env -i "${ENV_ARGS[@]}" "$PI_BIN" "${PI_ARGS[@]}" "${PROMPT_ARGS[@]}"
