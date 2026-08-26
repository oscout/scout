#!/bin/bash
# Build, verify, and publish the public Scout npm package set.
#
# Publication is two-phase: both immutable versions are uploaded under a
# version-specific staging dist-tag, verified against the current public commit,
# and only then promoted to latest. A completed release is idempotent; a partial
# immutable package set fails closed so separate attempts cannot mix candidates.

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
# npm can accept an upload and keep it in processing for more than a minute.
# Keep this bounded, but long enough for the accepted artifact to become
# observable before the fail-closed partial-set rule ends the authority session.
NPM_DIST_TAG_VERIFY_ATTEMPTS="${NPM_DIST_TAG_VERIFY_ATTEMPTS:-60}"
NPM_DIST_TAG_VERIFY_DELAY_SECONDS="${NPM_DIST_TAG_VERIFY_DELAY_SECONDS:-5}"
PUBLISH_PACKAGES=(protocol cli)
EXPECTED_REPOSITORY="https://github.com/oscout/scout"
mkdir -p "$npm_config_cache"

STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/scout-npm-release.XXXXXX")
NPMRC=""
RELEASE_LOCK_DIR=""
RELEASE_LOCK_HELD=0
RELEASE_STAGE_DIR=""
cleanup() {
  if [[ -n "$NPMRC" && -f "$NPMRC" ]]; then
    rm -f "$NPMRC"
  fi
  if [[ -n "$RELEASE_STAGE_DIR" && -d "$RELEASE_STAGE_DIR" ]]; then
    rm -rf "$RELEASE_STAGE_DIR"
  fi
  if [[ "$RELEASE_LOCK_HELD" == "1" && -n "$RELEASE_LOCK_DIR" ]]; then
    rmdir "$RELEASE_LOCK_DIR" 2>/dev/null || true
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

NPM_READ_ARGS=(--registry "$NPM_REGISTRY_URL")
PACKAGE_NAMES=()
PACKAGE_VERSIONS=()
PACKAGE_EXISTS=()
PACKAGE_LATEST=()
PACKAGE_TARBALLS=()
PACKAGE_INTEGRITIES=()
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
[[ "$release_sha" =~ ^[0-9a-f]{40,64}$ ]] || {
  echo "ERROR: release HEAD is not a full Git object id: $release_sha" >&2
  exit 1
}
STAGING_NPM_TAG="scout-release-${release_version//./-}"
PUBLICATION_AUTHORITY="local-signed"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  PUBLICATION_AUTHORITY="github-oidc"
fi
RELEASE_STATE_DIR="${SCOUT_NPM_RELEASE_STATE_DIR:-}"
if [[ -z "$RELEASE_STATE_DIR" ]]; then
  git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
  RELEASE_STATE_DIR="${git_common_dir}/scout-release/npm/${release_version}-${release_sha}"
fi
RELEASE_RECEIPT_PATH="$RELEASE_STATE_DIR/receipt.json"
RELEASE_LOCK_DIR="${RELEASE_STATE_DIR}.lock"
if [[ "$release_version" == "0.2.88" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "ERROR: v0.2.88 is a local signed authority-cutover release, not a GitHub Actions publication" >&2
    exit 1
  fi
  export NPM_CONFIG_PROVENANCE=false
elif [[ "$MODE" == "publish" ]]; then
  expected_workflow_ref="oscout/scout/.github/workflows/release-package-npm.yml@refs/heads/main"
  if [[ "${GITHUB_ACTIONS:-}" != "true" \
    || "${GITHUB_REPOSITORY:-}" != "oscout/scout" \
    || "${GITHUB_WORKFLOW_REF:-}" != "$expected_workflow_ref" ]]; then
    echo "ERROR: v${release_version} must be published by .github/workflows/release-package-npm.yml" >&2
    echo "ERROR: refusing a second local publication authority for v0.2.89 and later" >&2
    exit 1
  fi
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    echo "ERROR: v${release_version} requires npm trusted publishing; refusing token authentication" >&2
    exit 1
  fi
fi

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
  local observed diagnostic published_sha published_repository integrity expected_integrity

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
  expected_integrity="${PACKAGE_INTEGRITIES[$index]:-}"
  if [[ -n "$expected_integrity" && "$integrity" != "$expected_integrity" ]]; then
    echo "ERROR: ${identity} registry integrity does not match the exact reviewed candidate" >&2
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

assert_registry_preflight() {
  local value existing_count=0
  for value in "${PACKAGE_EXISTS[@]}"; do
    [[ "$value" == "1" ]] && existing_count=$((existing_count + 1))
  done
  if ((existing_count == 0)); then
    return
  fi
  # Once the complete immutable set exists, it can be compared with the exact
  # local candidates and any missing mutable dist-tags can be promoted safely.
  # Only a genuinely partial immutable set is unrecoverable across attempts.
  if all_artifacts_exist; then
    return
  fi
  echo "ERROR: ${release_version} has an incomplete npm package set and cannot be resumed across publication attempts" >&2
  echo "ERROR: choose a fresh version instead of mixing immutable artifacts from different candidates or authorities" >&2
  exit 1
}

load_release_receipt() {
  local output index line integrity filename extra
  if [[ ! -f "$RELEASE_RECEIPT_PATH" ]]; then
    echo "ERROR: complete npm package set has no durable local integrity receipt: $RELEASE_RECEIPT_PATH" >&2
    echo "ERROR: refusing to reconstruct exact candidate identity from a nondeterministic rebuild" >&2
    exit 1
  fi

  if ! output=$(node scripts/npm-release-receipt.mjs verify \
    "$RELEASE_RECEIPT_PATH" "$RELEASE_STATE_DIR" "$EXPECTED_REPOSITORY" \
    "$release_version" "$release_sha" "$PUBLICATION_AUTHORITY" \
    "${PACKAGE_NAMES[0]}" "${PACKAGE_VERSIONS[0]}" \
    "${PACKAGE_NAMES[1]}" "${PACKAGE_VERSIONS[1]}"); then
    echo "ERROR: invalid npm release integrity receipt: $RELEASE_RECEIPT_PATH" >&2
    exit 1
  fi

  PACKAGE_INTEGRITIES=()
  PACKAGE_TARBALLS=()
  for index in "${!PACKAGE_NAMES[@]}"; do
    line="${output%%$'\n'*}"
    if [[ "$output" == *$'\n'* ]]; then
      output="${output#*$'\n'}"
    else
      output=""
    fi
    IFS=$'\t' read -r integrity filename extra <<< "$line"
    if [[ -z "$integrity" || -z "$filename" || -n "$extra" ]]; then
      echo "ERROR: receipt verifier returned malformed package data" >&2
      exit 1
    fi
    PACKAGE_INTEGRITIES[$index]="$integrity"
    PACKAGE_TARBALLS[$index]="$RELEASE_STATE_DIR/$filename"
  done
  [[ -z "$output" ]] || {
    echo "ERROR: receipt verifier returned an unexpected package" >&2
    exit 1
  }
  echo "  ✓ durable integrity receipt loaded for ${release_version}"
}

acquire_release_lock() {
  mkdir -p "$(dirname "$RELEASE_LOCK_DIR")"
  if ! mkdir "$RELEASE_LOCK_DIR"; then
    echo "ERROR: npm release lock already exists: $RELEASE_LOCK_DIR" >&2
    echo "ERROR: confirm no publication is running, then remove that stale lock explicitly" >&2
    exit 1
  fi
  chmod 700 "$RELEASE_LOCK_DIR"
  RELEASE_LOCK_HELD=1
}

persist_release_bundle() {
  local bundle_parent bundle_name index source target
  if [[ -e "$RELEASE_STATE_DIR" ]]; then
    echo "ERROR: refusing to overwrite existing npm release bundle: $RELEASE_STATE_DIR" >&2
    exit 1
  fi
  bundle_parent=$(dirname "$RELEASE_STATE_DIR")
  bundle_name=$(basename "$RELEASE_STATE_DIR")
  mkdir -p "$bundle_parent"
  RELEASE_STAGE_DIR=$(mktemp -d "${bundle_parent}/.${bundle_name}.tmp.XXXXXX")
  chmod 700 "$RELEASE_STAGE_DIR"

  for index in "${!PACKAGE_TARBALLS[@]}"; do
    source="${PACKAGE_TARBALLS[$index]}"
    target="$RELEASE_STAGE_DIR/$(basename "$source")"
    cp "$source" "$target"
    chmod 600 "$target"
    PACKAGE_TARBALLS[$index]="$target"
  done

  node scripts/npm-release-receipt.mjs create \
    "$RELEASE_STAGE_DIR/receipt.json" "$EXPECTED_REPOSITORY" \
    "$release_version" "$release_sha" "$PUBLICATION_AUTHORITY" \
    "${PACKAGE_NAMES[0]}" "${PACKAGE_VERSIONS[0]}" "${PACKAGE_TARBALLS[0]}" \
    "${PACKAGE_NAMES[1]}" "${PACKAGE_VERSIONS[1]}" "${PACKAGE_TARBALLS[1]}"

  node -e '
    const { existsSync, openSync, closeSync, fsyncSync, renameSync } = require("node:fs");
    const [source, target] = process.argv.slice(1);
    if (existsSync(target)) throw new Error(`release bundle already exists: ${target}`);
    renameSync(source, target);
    const descriptor = openSync(require("node:path").dirname(target), "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  ' "$RELEASE_STAGE_DIR" "$RELEASE_STATE_DIR"
  RELEASE_STAGE_DIR=""
  load_release_receipt
  echo "  ✓ durable release bundle recorded at $RELEASE_STATE_DIR"
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
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    # Canonical public releases have one authority: npm trusted publishing.
    # Never probe a runner-local credential helper that could silently replace
    # OIDC with a legacy token after the earlier environment check.
    echo "Relying on npm trusted publishing/OIDC."
    return
  fi
  if [[ -z "${NPM_TOKEN:-}" ]] && command -v secret >/dev/null 2>&1; then
    NPM_TOKEN="$(secret get OPENSCOUT_NPM_TOKEN 2>/dev/null || true)"
  fi
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    NPMRC=$(mktemp "$STATE_DIR/npmrc.XXXXXX")
    chmod 600 "$NPMRC"
    printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
  else
    echo "ERROR: NPM_TOKEN is not set (try: secret set OPENSCOUT_NPM_TOKEN)" >&2
    exit 1
  fi
}

run_npm_mutation() {
  # macOS still ships Bash 3.2, where expanding a declared-but-empty array
  # under `set -u` aborts with "unbound variable". Keep the optional local
  # token argument behind an explicit scalar check so trusted publishing can
  # invoke npm without an empty-array expansion.
  if [[ -n "$NPMRC" ]]; then
    npm "$@" --userconfig "$NPMRC"
  else
    npm "$@"
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

prepare_release_tarballs() {
  local index pkg name version filename tarball integrity pack_root audit_root
  local packed_name packed_version packed_sha packed_repository
  PACKAGE_TARBALLS=()
  PACKAGE_INTEGRITIES=()
  echo "Preparing exact publication candidates…"
  for index in "${!PUBLISH_PACKAGES[@]}"; do
    pkg="${PUBLISH_PACKAGES[$index]}"
    name="${PACKAGE_NAMES[$index]}"
    version="${PACKAGE_VERSIONS[$index]}"
    filename="${name#@}"
    filename="${filename//\//-}-${version}.tgz"
    tarball="$STATE_DIR/$filename"

    # npm adds gitHead when publishing a directory, but not when publishing an
    # already-packed tarball. Build the immutable candidate from an isolated
    # copy with the reviewed commit stamped into its manifest so the registry
    # can prove both source identity and exact tarball integrity.
    pack_root="$STATE_DIR/pack-$pkg"
    mkdir -p "$pack_root"
    cp -R "packages/$pkg/." "$pack_root/"
    # Apply the same workspace-range normalization as the package prepack hook,
    # but inside the isolated candidate copy. The exact tarball is then packed
    # with lifecycle scripts disabled so no later hook can change its bytes.
    node scripts/prepare-publish-manifest.mjs "$pack_root" "$PWD"
    node -e '
      const { readFileSync, writeFileSync } = require("node:fs");
      const path = process.argv[1];
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.gitHead = process.argv[2];
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    ' "$pack_root/package.json" "$release_sha"
    (
      cd "$pack_root"
      npm pack --ignore-scripts --pack-destination "$STATE_DIR" >/dev/null
    )
    [[ -f "$tarball" ]] || {
      echo "ERROR: npm pack did not produce expected candidate $tarball" >&2
      exit 1
    }

    audit_root="$STATE_DIR/audit-$pkg"
    mkdir -p "$audit_root"
    tar -xzf "$tarball" -C "$audit_root" package/package.json
    packed_name=$(node -p "require(process.argv[1]).name" "$audit_root/package/package.json")
    packed_version=$(node -p "require(process.argv[1]).version" "$audit_root/package/package.json")
    packed_sha=$(node -p "require(process.argv[1]).gitHead || ''" "$audit_root/package/package.json")
    packed_repository=$(normalize_repository "$(node -p "require(process.argv[1]).repository?.url || ''" "$audit_root/package/package.json")")
    if [[ "$packed_name" != "$name" || "$packed_version" != "$version" ]]; then
      echo "ERROR: exact candidate identity is ${packed_name}@${packed_version}, expected ${name}@${version}" >&2
      exit 1
    fi
    if [[ "$packed_sha" != "$release_sha" ]]; then
      echo "ERROR: exact candidate gitHead is ${packed_sha:-missing}, expected ${release_sha}" >&2
      exit 1
    fi
    if [[ "$packed_repository" != "$EXPECTED_REPOSITORY" ]]; then
      echo "ERROR: exact candidate repository is ${packed_repository:-missing}, expected ${EXPECTED_REPOSITORY}" >&2
      exit 1
    fi
    # Audit the exact candidate that will be retained, receipted, and uploaded;
    # a separately generated npm-pack check is not publication evidence.
    node scripts/check-packed-manifests.mjs --tarball "$tarball"
    integrity=$(node -e '
      const { createHash } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      process.stdout.write("sha512-" + createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"));
    ' "$tarball")
    PACKAGE_TARBALLS[$index]="$tarball"
    PACKAGE_INTEGRITIES[$index]="$integrity"
    echo "  ✓ ${name}@${version} candidate integrity recorded"
  done
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
  local index name version tarball
  for index in "${!PUBLISH_PACKAGES[@]}"; do
    if [[ "${PACKAGE_EXISTS[$index]}" == "1" ]]; then
      echo "  ✓ ${PACKAGE_NAMES[$index]}@${PACKAGE_VERSIONS[$index]} already matches ${release_sha}"
      continue
    fi
    name="${PACKAGE_NAMES[$index]}"
    version="${PACKAGE_VERSIONS[$index]}"
    tarball="${PACKAGE_TARBALLS[$index]}"
    echo ""
    echo "Publishing ${name}@${version} under staging tag ${STAGING_NPM_TAG}…"
    run_npm_mutation publish "$tarball" --access public --tag "$STAGING_NPM_TAG" \
      "${NPM_READ_ARGS[@]}"
    wait_for_exact_artifact "$index"
    # Verify each immutable upload before attempting the next one. A bad first
    # artifact must stop the train before it can poison the rest of the set.
    inspect_exact_artifact "$index"
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
      run_npm_mutation dist-tag add "${name}@${version}" "$FINAL_NPM_TAG" \
        "${NPM_READ_ARGS[@]}"
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
      if ! run_npm_mutation dist-tag rm "$name" "$STAGING_NPM_TAG" \
        "${NPM_READ_ARGS[@]}"; then
        echo "  WARN: could not remove staging tag ${name}@${STAGING_NPM_TAG}" >&2
      fi
    fi
  done
}

if [[ "$MODE" == "publish" ]]; then
  acquire_release_lock
fi

inspect_registry_state
assert_registry_preflight

if [[ "$MODE" == "verify-state" ]]; then
  if all_artifacts_exist; then
    load_release_receipt
    inspect_registry_state
  fi
  echo "Registry state is pristine or has a complete immutable ${release_version} package set."
  exit 0
fi

if [[ "$MODE" == "dry-run" ]]; then
  echo "Dry run — building and packing without registry mutation."
  build_and_check
  prepare_release_tarballs
  echo "✓ Public npm package builds verified."
  exit 0
fi

if [[ "$MODE" == "publish" ]]; then
  assert_clean_publish_source
  assert_canonical_publish_ref
fi

if [[ "$MODE" == "verify-published" ]]; then
  all_artifacts_exist || {
    echo "ERROR: not all ${release_version} package artifacts are published" >&2
    exit 1
  }
  load_release_receipt
  inspect_registry_state
  all_packages_promoted || {
    echo "ERROR: not all ${release_version} packages are promoted to ${FINAL_NPM_TAG}" >&2
    exit 1
  }
  echo "✓ Public npm package set ${release_version} exactly matches the reviewed candidates and is promoted."
  exit 0
fi

if all_artifacts_exist; then
  # Never rebuild to prove an immutable registry artifact. The CLI bundle and
  # its signature are intentionally nondeterministic, so only the receipt made
  # before the first upload can identify the exact accepted bytes on a retry.
  load_release_receipt
  inspect_registry_state
  if all_packages_promoted; then
    echo "✓ Public npm package set ${release_version} already matches the exact reviewed candidates and latest."
    exit 0
  fi
  configure_publish_credentials
else
  configure_publish_credentials
  if [[ -e "$RELEASE_STATE_DIR" ]]; then
    # A prior attempt may have stopped after the atomic bundle commit but before
    # its first upload. Reuse those retained bytes; never rebuild over them.
    load_release_receipt
    inspect_registry_state
  else
    build_and_check
    prepare_release_tarballs
    # Generation and pack hooks must not have rewritten reviewed source. The
    # immutable npm artifacts must still describe the exact clean release SHA.
    assert_clean_publish_source
    inspect_registry_state
    assert_registry_preflight

    if all_artifacts_exist; then
      # A remote authority raced this build. Without its durable receipt, its
      # bytes cannot be inferred safely from this invocation's rebuild.
      load_release_receipt
      inspect_registry_state
    else
      # Registry state is still pristine, so this invocation owns the candidate.
      # Atomically retain both tarballs and their receipt before the first upload.
      persist_release_bundle
      inspect_registry_state
      assert_registry_preflight
    fi
  fi

  assert_registry_preflight
  if ! all_artifacts_exist; then
    publish_missing_artifacts
    inspect_registry_state
    assert_registry_preflight
    all_artifacts_exist || {
      echo "ERROR: package set remained incomplete after publication" >&2
      exit 1
    }
  fi
fi

promote_package_set
inspect_registry_state
all_artifacts_exist && all_packages_promoted || {
  echo "ERROR: final npm package-set verification failed" >&2
  exit 1
}

echo ""
echo "✓ Public npm packages published from ${release_sha}."
