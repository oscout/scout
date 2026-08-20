#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_SH="$ROOT_DIR/scripts/cargo.sh"
MANIFEST_PATH="$ROOT_DIR/crates/scoutd/Cargo.toml"

"$CARGO_SH" fmt --all --check
"$CARGO_SH" check --manifest-path "$MANIFEST_PATH"
"$CARGO_SH" test --manifest-path "$MANIFEST_PATH"
"$CARGO_SH" build --manifest-path "$MANIFEST_PATH"
"$CARGO_SH" run --manifest-path "$MANIFEST_PATH" -- --help >/dev/null
"$CARGO_SH" run --manifest-path "$MANIFEST_PATH" -- status --json >/dev/null
"$CARGO_SH" run --manifest-path "$MANIFEST_PATH" -- doctor --json >/dev/null
