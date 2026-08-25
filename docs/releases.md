# Public package releases

Beginning with `0.2.88`, Scout's supported public npm artifacts are released
from this repository. Until `v0.2.88` is tagged and both npm artifacts verify,
the live registry remains on the pre-cutover private-source release. Do not
publish public packages from a private product checkout or from a commit that
is not public `oscout/scout` `main`.

## Current publication set

The `0.2.88` authority cutover publishes:

- `@openscout/protocol`
- `@openscout/scout`

After the cutover source is reviewed and merged, the CLI package bundles the
public runtime, agent-session, desktop, and baseline web sources. Those
component workspaces remain on the same source version, but
`@openscout/agent-sessions`, `@openscout/runtime`, and `@openscout/web` are not
promoted as supported registry packages until their exports, standalone
pack/install tests, and web-composition fixture are ready. That later
five-package release is a separate migration gate.

## Prepare and review

Choose an explicit unused version. Never use `patch` to recover from registry
drift.

```bash
node scripts/bump-version.mjs 0.2.88
bun install
npm run ship -- 0.2.88
bun run check
bun run test:unit
bash scripts/ship-npm.sh --dry-run
```

Commit the source, version manifests, `apps/desktop/src/shared/product.ts`,
`docs.json`, and lockfile on a review branch. Merge only after the standalone
checks and packed artifact audit pass.

## Publish locally

The local path is the current canonical fallback while the public repository's
GitHub environment is not provisioned with the native signing credentials.
Run it from a clean, up-to-date `main` checkout:

```bash
npm run ship -- 0.2.88 --execute --yes
```

The command refuses a non-public origin, a branch other than `main`, a HEAD that
does not match freshly fetched `origin/main`, a dirty tree, mismatched existing
tag or registry state, or unsigned `scoutd`. Matching tag and completed npm and
GitHub release state are idempotent. Before its first immutable upload, the
publisher atomically retains both exact tarballs and an integrity receipt under
the repository's common Git directory at
`.git/scout-release/npm/<version>-<release-sha>/`. Keep that bundle through final
npm and GitHub verification; it is the evidence used to resume without
rebuilding the signed CLI. The receipt is also attached to the GitHub release.

The `0.2.88` cutover fails closed if only part of its immutable npm package set
already exists; use a fresh version instead of mixing artifacts across
publication attempts. A complete immutable set may resume missing mutable
dist-tag promotion only when every registry SRI matches the retained receipt.
Missing, altered, or mismatched receipt state also fails closed—do not delete the
bundle during a release train. The publisher uploads the retained candidates
under a version-specific staging dist-tag, verifies the complete pair, and only
then promotes both packages to `latest`.

Local npm publication does not create GitHub OIDC provenance. The preferred
long-term path is the public workflow once all of these are configured:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`
- `MACOS_DEVELOPER_ID_APPLICATION_P12_PASSWORD`
- `MACOS_RELEASE_KEYCHAIN_PASSWORD`
- `OPENSCOUT_SIGN_IDENTITY`
- npm trusted publishing for
  `oscout/scout/.github/workflows/release-package-npm.yml`

The workflow explicitly refuses `v0.2.88`: that one authority-cutover release
is local signed publication only. The workflow remains manual-only until the
prerequisites are present. Once they are, dispatch
`release-package-npm.yml` for an already-reviewed public `v0.2.89` or later tag
and wait for it to verify both packages; do not weaken the signing gate or
publish a GitHub release before the package set succeeds.

## Verify

After publication, verify that the git tag, both manifests, npm versions,
dist-tags, package repository metadata, and public source commit agree. Install
the packed CLI in an empty directory and exercise `scout --version`, setup,
broker health, and the baseline web server. A partial or mismatched publication
is not promoted as a successful release.
