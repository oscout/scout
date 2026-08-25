#!/bin/bash
# Build, verify, and resumably publish the public Scout npm package set.
#
# Publication is two-phase: both immutable versions are uploaded under a
# version-specific staging dist-tag, verified against the current public commit,
# and only then promoted to latest. A retry skips matching completed work and
# rejects any mismatched registry artifact.

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-publish}"
if [[ "$#" -gt 1 ]]; then
  echo "ERROR: unexpected extra arguments: ${*:2}" >&2
  exit 1
fi
case "$MODE" in
  publish) ;;
  --dry-run) MODE="dry-run" ;;
  --verify-state) MODE="verify-state" ;;
  --verify-published) MODE="verify-published" ;;
  -h|--help)
    echo "Usage: scripts/ship-npm.sh [--dry-run|--verify-state|--verify-published]"
    exit 0
    ;;
  *)
    echo "ERROR: unknown mode: $MODE" >&2
    exit 1
    ;;
esac

# Local overrides may provide NPM_TOKEN, but the stable registry and final
# dist-tag are intentionally not configurable for a canonical public release.
[[ -f .env.local ]] && set -a && source .env.local && set +a
[[ -f .env ]] && set -a && source .env && set +a

NPM_REGISTRY_URL="https://registry.npmjs.org"
FINAL_NPM_TAG="${NPM_TAG:-latest}"
if [[ "$FINAL_NPM_TAG" != "latest" ]]; then
  echo "ERROR: canonical Scout publication requires NPM_TAG=latest, got $FINAL_NPM_TAG" >&2
  exit 1
fi

export npm_config_cache="${npm_config_cache:-${TMPDIR:-/tmp}/openscout-npm-cache}"
export OPENSCOUT_REQUIRE_SCOUTD_SIGN=1
NPM_DIST_TAG_VERIFY_ATTEMPTS="${NPM_DIST_TAG_VERIFY_ATTEMPTS:-12}"
NPM_DIST_TAG_VERIFY_DELAY_SECONDS="${NPM_DIST_TAG_VERIFY_DELAY_SECONDS:-5}"
PUBLISH_PACKAGES=(protocol cli)
EXPECTED_REPOSITORY="https://github.com/oscout/scout"
mkdir -p "$npm_config_cache"

STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/scout-npm-release.XXXXXX")
NPMRC=""
cleanup() {
  if [[ -n "$NPMRC" && -f "$NPMRC" ]]; then
    rm -f "$NPMRC"
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

NPM_READ_ARGS=(--registry "$NPM_REGISTRY_URL")
NPM_AUTH_ARGS=()
PACKAGE_NAMES=()
PACKAGE_VERSIONS=()
PACKAGE_EXISTS=()
PACKAGE_LATEST=()
release_version=""

for pkg in "${PUBLISH_PACKAGES[@]}"; do
  pkg_name=$(node -p "require('./packages/$pkg/package.json').name")
  pkg_version=$(node -p "require('./packages/$pkg/package.json').version")
  [[ "$pkg_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "ERROR: ${pkg_name} has invalid stable version ${pkg_version}" >&2
    exit 1
  }
  if [[ -z "$release_version" ]]; then
    release_version="$pkg_version"
  elif [[ "$pkg_version" != "$release_version" ]]; then
    echo "ERROR: publish set is not lockstep: expected ${release_version}, got ${pkg_name}@${pkg_version}" >&2
    exit 1
  fi
  PACKAGE_NAMES+=("$pkg_name")
  PACKAGE_VERSIONS+=("$pkg_version")
done

release_sha=$(git rev-parse HEAD^{commit})
STAGING_NPM_TAG="scout-release-${release_version//./-}"

normalize_repository() {
  local value="$1"
  value="${value#git+}"
  value="${value%.git}"
  case "$value" in
    git@github.com:*) value="https://github.com/${value#git@github.com:}" ;;
    ssh://git@github.com/*) value="https://github.com/${value#ssh://git@github.com/}" ;;
  esac
  printf '%s' "$value"
}

npm_view_field() {
  local identity="$1"
  local field="$2"
  local error_file="$STATE_DIR/npm-view-error"
  local value
  if ! value=$(npm view "$identity" "$field" "${NPM_READ_ARGS[@]}" 2>"$error_file"); then
    echo "ERROR: npm view ${identity} ${field} failed: $(<"$error_file")" >&2
    exit 1
  fi
  printf '%s' "$value"
}

inspect_exact_artifact() {
  local index="$1"
  local name="${PACKAGE_NAMES[$index]}"
  local version="${PACKAGE_VERSIONS[$index]}"
  local identity="${name}@${version}"
  local error_file="$STATE_DIR/npm-view-error"
  local observed diagnostic published_sha published_repository integrity

  if observed=$(npm view "$identity" version "${NPM_READ_ARGS[@]}" 2>"$error_file"); then
    if [[ "$observed" != "$version" ]]; then
      echo "ERROR: npm returned ${observed} for ${identity}" >&2
      exit 1
    fi
    PACKAGE_EXISTS[$index]=1
  else
    diagnostic="$(<"$error_file")"
    if [[ "$diagnostic" =~ E404|404.Not.Found|No.match.found.for.version|is.not.in.this.registry ]]; then
      PACKAGE_EXISTS[$index]=0
      return
    fi
    echo "ERROR: could not verify npm state for ${identity}: ${diagnostic}" >&2
    exit 1
  fi

  published_sha=$(npm_view_field "$identity" gitHead)
  published_repository=$(normalize_repository "$(npm_view_field "$identity" repository.url)")
  integrity=$(npm_view_field "$identity" dist.integrity)
  if [[ "$published_sha" != "$release_sha" ]]; then
    echo "ERROR: ${identity} was published from ${published_sha:-unknown}, expected ${release_sha}" >&2
    exit 1
  fi
  if [[ "$published_repository" != "$EXPECTED_REPOSITORY" ]]; then
    echo "ERROR: ${identity} repository is ${published_repository:-unknown}, expected ${EXPECTED_REPOSITORY}" >&2
    exit 1
  fi
  if [[ -z "$integrity" ]]; then
    echo "ERROR: ${identity} has no registry integrity receipt" >&2
    exit 1
  fi
}

validate_latest_baseline() {
  local baseline=""
  local latest
  for latest in "${PACKAGE_LATEST[@]}"; do
    if [[ -z "$latest" ]]; then
      echo "ERROR: an npm package has no latest dist-tag" >&2
      exit 1
    fi
    if [[ "$latest" == "$release_version" ]]; then
      continue
    fi
    if [[ -z "$baseline" ]]; then
      baseline="$latest"
    elif [[ "$latest" != "$baseline" ]]; then
      echo "ERROR: npm latest baseline is split across the public package set: ${PACKAGE_LATEST[*]}" >&2
      exit 1
    fi
  done

  if [[ -n "$baseline" ]]; then
    node -e '
      const target = process.argv[1].split(".").map(Number);
      const base = process.argv[2].split(".").map(Number);
      if (target.length !== 3 || base.length !== 3 || [...target, ...base].some(Number.isNaN)) process.exit(2);
      for (let i = 0; i < 3; i += 1) {
        if (target[i] > base[i]) process.exit(0);
        if (target[i] < base[i]) process.exit(1);
      }
      process.exit(1);
    ' "$release_version" "$baseline" || {
      echo "ERROR: release ${release_version} does not advance npm latest ${baseline}" >&2
      exit 1
    }
  fi
}

inspect_registry_state() {
  local index name latest
  PACKAGE_EXISTS=()
  PACKAGE_LATEST=()
  for index in "${!PUBLISH_PACKAGES[@]}"; do
    inspect_exact_artifact "$index"
    name="${PACKAGE_NAMES[$index]}"
    latest=$(npm_view_field "$name" "dist-tags.latest")
    PACKAGE_LATEST[$index]="$latest"
  done
  validate_latest_baseline
}

all_artifacts_exist() {
  local value
  for value in "${PACKAGE_EXISTS[@]}"; do
    [[ "$value" == "1" ]] || return 1
  done
  return 0
}

all_packages_promoted() {
  local value
  for value in "${PACKAGE_LATEST[@]}"; do
    [[ "$value" == "$release_version" ]] || return 1
  done
  return 0
}

assert_clean_publish_source() {
  local status
  status=$(git status --porcelain --untracked-files=normal)
  if [[ -n "$status" ]]; then
    echo "ERROR: npm publication requires a clean reviewed source tree:" >&2
    printf '%s\n' "$status" >&2
    exit 1
  fi
}

assert_canonical_publish_ref() {
  local remote release_tag local_tag_sha remote_tag_sha
  remote=$(git remote get-url origin)
  remote="${remote#git+}"
  remote="${remote%.git}"
  case "$remote" in
    git@github.com:*) remote="https://github.com/${remote#git@github.com:}" ;;
    ssh://git@github.com/*) remote="https://github.com/${remote#ssh://git@github.com/}" ;;
  esac
  if [[ "$remote" != "$EXPECTED_REPOSITORY" ]]; then
    echo "ERROR: npm publication requires ${EXPECTED_REPOSITORY}, got ${remote}" >&2
    exit 1
  fi

  release_tag="v${release_version}"
  local_tag_sha=$(git rev-parse --verify "refs/tags/${release_tag}^{commit}" 2>/dev/null || true)
  if [[ "$local_tag_sha" != "$release_sha" ]]; then
    echo "ERROR: local ${release_tag} must resolve to release HEAD ${release_sha}" >&2
    exit 1
  fi

  remote_tag_sha=$(git ls-remote --tags origin "refs/tags/${release_tag}^{}" | awk 'NR == 1 { print $1 }')
  if [[ -z "$remote_tag_sha" ]]; then
    remote_tag_sha=$(git ls-remote --tags origin "refs/tags/${release_tag}" | awk 'NR == 1 { print $1 }')
  fi
  if [[ "$remote_tag_sha" != "$release_sha" ]]; then
    echo "ERROR: remote ${release_tag} resolves to ${remote_tag_sha:-nothing}, expected ${release_sha}" >&2
    exit 1
  fi
}

configure_publish_credentials() {
  if [[ -z "${NPM_TOKEN:-}" ]] && command -v secret >/dev/null 2>&1; then
    NPM_TOKEN="$(secret get OPENSCOUT_NPM_TOKEN 2>/dev/null || true)"
  fi
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    NPMRC=$(mktemp "$STATE_DIR/npmrc.XXXXXX")
    chmod 600 "$NPMRC"
    printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
    NPM_AUTH_ARGS=(--userconfig "$NPMRC")
  elif [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "No NPM_TOKEN set; relying on npm trusted publishing/OIDC."
  else
    echo "ERROR: NPM_TOKEN is not set (try: secret set OPENSCOUT_NPM_TOKEN)" >&2
    exit 1
  fi
}

build_and_check() {
  echo "Building packages…"

  echo "  protocol…"
  (cd packages/protocol && npm run build)

  echo "  agent-sessions…"
  (cd packages/agent-sessions && npm run build)

  echo "  runtime…"
  (cd packages/runtime && npm run build)

  echo "  cli…"
  (cd packages/cli && OPENSCOUT_REQUIRE_SCOUTD=1 node ./scripts/build.mjs)

  echo "  web…"
  (cd packages/web && npm run build)

  echo "Checking packed manifests…"
  node scripts/check-packed-manifests.mjs
}

wait_for_exact_artifact() {
  local index="$1"
  local name="${PACKAGE_NAMES[$index]}"
  local version="${PACKAGE_VERSIONS[$index]}"
  local identity="${name}@${version}"
  local observed=""
  local attempt
  for ((attempt = 1; attempt <= NPM_DIST_TAG_VERIFY_ATTEMPTS; attempt += 1)); do
    observed=$(npm view "$identity" version "${NPM_READ_ARGS[@]}" 2>/dev/null || true)
    [[ "$observed" == "$version" ]] && return 0
    if ((attempt < NPM_DIST_TAG_VERIFY_ATTEMPTS)); then
      echo "  waiting for ${identity} registry propagation (${attempt}/${NPM_DIST_TAG_VERIFY_ATTEMPTS})…"
      sleep "$NPM_DIST_TAG_VERIFY_DELAY_SECONDS"
    fi
  done
  echo "ERROR: ${identity} was not observable after publication" >&2
  exit 1
}

publish_missing_artifacts() {
  local index pkg name version
  for index in "${!PUBLISH_PACKAGES[@]}"; do
    if [[ "${PACKAGE_EXISTS[$index]}" == "1" ]]; then
      echo "  ✓ ${PACKAGE_NAMES[$index]}@${PACKAGE_VERSIONS[$index]} already matches ${release_sha}"
      continue
    fi
    pkg="${PUBLISH_PACKAGES[$index]}"
    name="${PACKAGE_NAMES[$index]}"
    version="${PACKAGE_VERSIONS[$index]}"
    echo ""
    echo "Publishing ${name}@${version} under staging tag ${STAGING_NPM_TAG}…"
    (
      cd "packages/$pkg"
      npm publish --access public --tag "$STAGING_NPM_TAG" \
        "${NPM_READ_ARGS[@]}" "${NPM_AUTH_ARGS[@]}"
    )
    wait_for_exact_artifact "$index"
  done
}

wait_for_final_tag() {
  local name="$1"
  local version="$2"
  local observed=""
  local attempt
  for ((attempt = 1; attempt <= NPM_DIST_TAG_VERIFY_ATTEMPTS; attempt += 1)); do
    observed=$(npm view "$name" "dist-tags.${FINAL_NPM_TAG}" "${NPM_READ_ARGS[@]}" 2>/dev/null || true)
    [[ "$observed" == "$version" ]] && return 0
    if ((attempt < NPM_DIST_TAG_VERIFY_ATTEMPTS)); then
      echo "  waiting for ${name} ${FINAL_NPM_TAG} propagation (${attempt}/${NPM_DIST_TAG_VERIFY_ATTEMPTS})…"
      sleep "$NPM_DIST_TAG_VERIFY_DELAY_SECONDS"
    fi
  done
  echo "ERROR: npm dist-tag ${name}@${FINAL_NPM_TAG} is ${observed:-unset}, expected ${version}" >&2
  exit 1
}

promote_package_set() {
  local index name version staged
  echo ""
  echo "Promoting verified package set to ${FINAL_NPM_TAG}…"
  for index in "${!PUBLISH_PACKAGES[@]}"; do
    name="${PACKAGE_NAMES[$index]}"
    version="${PACKAGE_VERSIONS[$index]}"
    if [[ "${PACKAGE_LATEST[$index]}" != "$version" ]]; then
      npm dist-tag add "${name}@${version}" "$FINAL_NPM_TAG" \
        "${NPM_READ_ARGS[@]}" "${NPM_AUTH_ARGS[@]}"
    fi
    wait_for_final_tag "$name" "$version"
    echo "  ✓ ${name}@${version} (${FINAL_NPM_TAG})"
  done

  # A leftover version-specific staging tag is harmless, but remove it once the
  # full set is promoted so the registry state remains easy to read. Failure to
  # remove it does not invalidate the verified immutable artifacts or latest.
  for index in "${!PUBLISH_PACKAGES[@]}"; do
    name="${PACKAGE_NAMES[$index]}"
    version="${PACKAGE_VERSIONS[$index]}"
    staged=$(npm view "$name" "dist-tags.${STAGING_NPM_TAG}" "${NPM_READ_ARGS[@]}" 2>/dev/null || true)
    if [[ "$staged" == "$version" ]]; then
      if ! npm dist-tag rm "$name" "$STAGING_NPM_TAG" \
        "${NPM_READ_ARGS[@]}" "${NPM_AUTH_ARGS[@]}"; then
        echo "  WARN: could not remove staging tag ${name}@${STAGING_NPM_TAG}" >&2
      fi
    fi
  done
}

inspect_registry_state

if [[ "$MODE" == "verify-state" ]]; then
  echo "Registry state is compatible with resumable ${release_version} publication."
  exit 0
fi

if [[ "$MODE" == "verify-published" ]]; then
  all_artifacts_exist || {
    echo "ERROR: not all ${release_version} package artifacts are published" >&2
    exit 1
  }
  all_packages_promoted || {
    echo "ERROR: not all ${release_version} packages are promoted to ${FINAL_NPM_TAG}" >&2
    exit 1
  }
  echo "✓ Public npm package set ${release_version} is published and promoted."
  exit 0
fi

if [[ "$MODE" == "dry-run" ]]; then
  echo "Dry run — building and packing without registry mutation."
  build_and_check
  echo "✓ Public npm package builds verified."
  exit 0
fi

assert_clean_publish_source
assert_canonical_publish_ref

if all_artifacts_exist && all_packages_promoted; then
  echo "✓ Public npm package set ${release_version} already matches ${release_sha} and latest."
  exit 0
fi

configure_publish_credentials

if ! all_artifacts_exist; then
  build_and_check
  # Generation and pack hooks must not have rewritten reviewed source. The
  # immutable npm artifacts must still describe the exact clean release SHA.
  assert_clean_publish_source
  publish_missing_artifacts
  inspect_registry_state
  all_artifacts_exist || {
    echo "ERROR: package set remained incomplete after publication" >&2
    exit 1
  }
fi

promote_package_set
inspect_registry_state
all_artifacts_exist && all_packages_promoted || {
  echo "ERROR: final npm package-set verification failed" >&2
  exit 1
}

echo ""
echo "✓ Public npm packages published from ${release_sha}."
