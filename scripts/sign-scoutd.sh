#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/sign-scoutd.sh [path ...]

Signs scoutd binaries on macOS.

Environment:
  OPENSCOUT_SCOUTD_SIGN_IDENTITY  Codesign identity for scoutd only.
  OPENSCOUT_SIGN_IDENTITY         Fallback codesign identity.
  OPENSCOUT_REQUIRE_SCOUTD_SIGN=1 Require a Developer ID Application signature.
  OPENSCOUT_SKIP_SCOUTD_SIGN=1    Skip signing.
  SKIP_SIGN=1                     Skip signing.

When no paths are provided, signs target/release/scoutd.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${OPENSCOUT_SKIP_SCOUTD_SIGN:-0}" == "1" || "${SKIP_SIGN:-0}" == "1" ]]; then
  if [[ "${OPENSCOUT_REQUIRE_SCOUTD_SIGN:-0}" == "1" ]]; then
    echo "ERROR: OPENSCOUT_REQUIRE_SCOUTD_SIGN=1 but scoutd signing was also skipped." >&2
    exit 1
  fi
  echo "  skipping scoutd signing"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  if [[ "${OPENSCOUT_REQUIRE_SCOUTD_SIGN:-0}" == "1" ]]; then
    echo "ERROR: OPENSCOUT_REQUIRE_SCOUTD_SIGN=1 but scoutd signing requires macOS." >&2
    exit 1
  fi
  echo "  skipping scoutd signing on non-macOS host"
  exit 0
fi

if ! command -v codesign >/dev/null 2>&1; then
  if [[ "${OPENSCOUT_REQUIRE_SCOUTD_SIGN:-0}" == "1" ]]; then
    echo "ERROR: codesign not found; cannot sign scoutd." >&2
    exit 1
  fi
  echo "  WARN: codesign not found; leaving scoutd unsigned" >&2
  exit 0
fi

if [[ "$#" -eq 0 ]]; then
  set -- "$ROOT_DIR/target/release/scoutd"
fi

identity="${OPENSCOUT_SCOUTD_SIGN_IDENTITY:-${OPENSCOUT_SIGN_IDENTITY:-}}"
mode="configured identity"

if [[ -z "$identity" ]] && command -v security >/dev/null 2>&1; then
  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  developer_id_line="$(printf '%s\n' "$identities" | grep '"Developer ID Application:' | head -n 1 || true)"
  apple_development_line="$(printf '%s\n' "$identities" | grep '"Apple Development:' | head -n 1 || true)"
  developer_id_hash="$(printf '%s\n' "$developer_id_line" | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*\([A-Fa-f0-9]\{40\}\)[[:space:]].*/\1/p')"
  apple_development_hash="$(printf '%s\n' "$apple_development_line" | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*\([A-Fa-f0-9]\{40\}\)[[:space:]].*/\1/p')"
  developer_id_name="$(printf '%s\n' "$developer_id_line" | sed -n 's/.*"\([^"]*\)".*/\1/p')"
  apple_development_name="$(printf '%s\n' "$apple_development_line" | sed -n 's/.*"\([^"]*\)".*/\1/p')"
  if [[ -n "$developer_id_hash" ]]; then
    identity="$developer_id_hash"
    mode="Developer ID (${developer_id_name:-$developer_id_hash})"
  elif [[ "${OPENSCOUT_REQUIRE_SCOUTD_SIGN:-0}" != "1" && -n "$apple_development_hash" ]]; then
    identity="$apple_development_hash"
    mode="Apple Development (${apple_development_name:-$apple_development_hash})"
  fi
fi

sign_args=(--force --options runtime --timestamp)
if [[ "$identity" == "-" ]]; then
  mode="ad hoc"
  sign_args=(--force --options runtime)
elif [[ -z "$identity" ]]; then
  if [[ "${OPENSCOUT_REQUIRE_SCOUTD_SIGN:-0}" == "1" ]]; then
    echo "ERROR: OPENSCOUT_REQUIRE_SCOUTD_SIGN=1 but no signing identity is configured." >&2
    echo "Set OPENSCOUT_SCOUTD_SIGN_IDENTITY or OPENSCOUT_SIGN_IDENTITY." >&2
    exit 1
  fi
  identity="-"
  mode="ad hoc"
  sign_args=(--force --options runtime)
fi

for binary in "$@"; do
  if [[ ! -f "$binary" ]]; then
    echo "ERROR: scoutd binary not found: $binary" >&2
    exit 1
  fi

  if ! file "$binary" | grep -q "Mach-O"; then
    echo "ERROR: scoutd binary is not a Mach-O executable: $binary" >&2
    exit 1
  fi

  echo "  signing scoutd ($mode): $binary"
  codesign "${sign_args[@]}" --sign "$identity" "$binary"
  codesign --verify --strict --verbose=2 "$binary"

  if [[ "${OPENSCOUT_REQUIRE_SCOUTD_SIGN:-0}" == "1" ]]; then
    signature_details="$(codesign -dv --verbose=4 "$binary" 2>&1)"
    if ! printf '%s\n' "$signature_details" | grep -q '^Authority=Developer ID Application:'; then
      echo "ERROR: OPENSCOUT_REQUIRE_SCOUTD_SIGN=1 but $binary is not signed with Developer ID Application." >&2
      exit 1
    fi
  fi

  if [[ "$identity" != "-" ]] && command -v spctl >/dev/null 2>&1; then
    spctl --assess --type execute --verbose "$binary" >/dev/null 2>&1 \
      || echo "  WARN: spctl assessment did not accept $binary before notarization" >&2
  fi
done
