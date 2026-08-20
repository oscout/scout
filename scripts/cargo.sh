#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${CARGO:-}" ]]; then
  exec "$CARGO" "$@"
fi

if command -v cargo >/dev/null 2>&1; then
  exec cargo "$@"
fi

if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  exec "$HOME/.cargo/bin/cargo" "$@"
fi

echo "cargo not found; install Rust with rustup or set CARGO=/path/to/cargo" >&2
exit 127
