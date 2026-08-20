#!/bin/bash
# Build internal workspaces and publish the public OpenScout npm packages:
# @openscout/scout (the product) and @openscout/protocol (the typed contracts).
# Reads NPM_TOKEN from the env, falling back to `secret get OPENSCOUT_NPM_TOKEN`
# (macOS keychain via the local `secret` CLI). See docs/local-secrets.md.
#
# Usage:
#   ./scripts/ship-npm.sh           # build + publish @openscout/scout + @openscout/protocol
#   ./scripts/ship-npm.sh --dry-run # build only, skip publish

set -euo pipefail
cd "$(dirname "$0")/.."

export npm_config_cache="${npm_config_cache:-${TMPDIR:-/tmp}/openscout-npm-cache}"
NPM_TAG="${NPM_TAG:-latest}"
NPM_DIST_TAG_VERIFY_ATTEMPTS="${NPM_DIST_TAG_VERIFY_ATTEMPTS:-12}"
NPM_DIST_TAG_VERIFY_DELAY_SECONDS="${NPM_DIST_TAG_VERIFY_DELAY_SECONDS:-5}"
mkdir -p "$npm_config_cache"

# Load .env files if present (kept for local overrides; primary store is the keychain)
[[ -f .env.local ]] && set -a && source .env.local && set +a
[[ -f .env ]] && set -a && source .env && set +a

# Public package builds must carry a distribution-signed native broker. Keep this
# exported so npm's publish/pack prepack rebuilds inherit the same release gate.
export OPENSCOUT_REQUIRE_SCOUTD_SIGN="${OPENSCOUT_REQUIRE_SCOUTD_SIGN:-1}"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "Dry run — skipping publish and npm dist-tag update."
else
  if [[ -z "${NPM_TOKEN:-}" ]] && command -v secret >/dev/null 2>&1; then
    NPM_TOKEN="$(secret get OPENSCOUT_NPM_TOKEN 2>/dev/null || true)"
  fi
  NPM_ARGS=()
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    NPMRC=$(mktemp)
    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$NPMRC"
    NPM_ARGS=(--userconfig "$NPMRC")
    trap 'rm -f "$NPMRC"' EXIT
  elif [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "No NPM_TOKEN set; relying on npm trusted publishing/OIDC."
  else
    echo "ERROR: NPM_TOKEN is not set (try: secret set OPENSCOUT_NPM_TOKEN)"
    exit 1
  fi
fi

publish() {
  local pkg="$1"
  local dir="packages/$pkg"
  local name version

  name=$(node -p "require('./$dir/package.json').name")
  version=$(node -p "require('./$dir/package.json').version")

  echo ""
  echo "Publishing ${name}@${version} with dist-tag ${NPM_TAG}…"

  if $DRY_RUN; then
    echo "  (dry run — would publish with --tag ${NPM_TAG})"
    return
  fi

  (cd "$dir" && npm publish --access public --tag "$NPM_TAG" "${NPM_ARGS[@]}")

  published_tag=$(npm view "$name" "dist-tags.$NPM_TAG" "${NPM_ARGS[@]}" 2>/dev/null || true)
  if [[ "$published_tag" != "$version" ]]; then
    echo "  dist-tag ${NPM_TAG} points at ${published_tag:-nothing}; updating…"
    npm dist-tag add "${name}@${version}" "$NPM_TAG" "${NPM_ARGS[@]}"

    # Registry reads can briefly lag a successful publish/dist-tag write. Poll
    # before failing the release so npm eventual consistency does not turn a
    # completed publication into a false-negative workflow result.
    for ((attempt = 1; attempt <= NPM_DIST_TAG_VERIFY_ATTEMPTS; attempt += 1)); do
      published_tag=$(npm view "$name" "dist-tags.$NPM_TAG" "${NPM_ARGS[@]}" 2>/dev/null || true)
      [[ "$published_tag" == "$version" ]] && break
      if ((attempt < NPM_DIST_TAG_VERIFY_ATTEMPTS)); then
        echo "  waiting for registry dist-tag propagation (${attempt}/${NPM_DIST_TAG_VERIFY_ATTEMPTS})…"
        sleep "$NPM_DIST_TAG_VERIFY_DELAY_SECONDS"
      fi
    done
  fi

  [[ "$published_tag" == "$version" ]] || {
    echo "ERROR: npm dist-tag ${NPM_TAG} is ${published_tag:-unset}, expected ${version}"
    exit 1
  }

  echo "  ✓ $name@$version (${NPM_TAG})"
}

# ── Build ──────────────────────────────────────────────────────────────────────

echo "Building packages…"

echo "  protocol…"
(cd packages/protocol && npm run build)

echo "  agent-sessions…"
(cd packages/agent-sessions && npm run build)

echo "  runtime…"
(cd packages/runtime && npm run build)

echo "  cli…"
# Require the prebuilt scoutd broker service binary in published artifacts —
# build.mjs fails loudly here if cargo is unavailable or scoutd cannot be
# Developer ID signed (see OPENSCOUT_REQUIRE_SCOUTD and OPENSCOUT_REQUIRE_SCOUTD_SIGN).
(cd packages/cli && OPENSCOUT_REQUIRE_SCOUTD=1 node ./scripts/build.mjs)

echo "  web…"
(cd packages/web && npm run build)

echo "Checking packed manifests…"
node scripts/check-packed-manifests.mjs

# ── Publish public packages ────────────────────────────────────────────────────

publish cli
publish protocol

echo ""
if $DRY_RUN; then
  echo "✓ Public npm package builds verified."
else
  echo "✓ Public npm packages published."
fi
