#!/usr/bin/env bash
# Fetch the pinned Silero VAD ONNX artifact into the local model cache.
#
# This is an explicit operator step: the voice runtime never downloads
# models on its own, and the artifact is pinned to an immutable release tag
# and SHA-256 (see crates/openscout-voice-core/src/silero.rs, which must
# stay in sync with the constants below). Weights are MIT-licensed by
# upstream snakers4/silero-vad and are not committed to this repository.
set -euo pipefail

VERSION="v5.1.2"
SHA256="2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f"
SOURCE="https://raw.githubusercontent.com/snakers4/silero-vad/${VERSION}/src/silero_vad/data/silero_vad.onnx"

CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}"
TARGET_DIR="${CACHE_BASE}/openscout/models/silero-vad/${VERSION}"
TARGET="${TARGET_DIR}/silero_vad.onnx"

verify() {
  echo "${SHA256}  $1" | shasum -a 256 -c - >/dev/null
}

if [[ -f "${TARGET}" ]] && verify "${TARGET}"; then
  echo "already cached: ${TARGET}"
  exit 0
fi

mkdir -p "${TARGET_DIR}"
TMP="$(mktemp "${TARGET_DIR}/.silero_vad.onnx.XXXXXX")"
trap 'rm -f "${TMP}"' EXIT

echo "fetching Silero VAD ${VERSION} ..."
curl -fsSL --proto '=https' -o "${TMP}" "${SOURCE}"

if ! verify "${TMP}"; then
  echo "checksum mismatch for ${SOURCE}" >&2
  exit 1
fi

mv "${TMP}" "${TARGET}"
trap - EXIT
echo "cached: ${TARGET}"
