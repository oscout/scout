# Public package releases

Beginning with `0.2.91`, Scout's complete supported public npm set is released
from this repository. npm accepted only `@openscout/protocol@0.2.88` during the
local authority cutover; the strict partial-set guard stopped that attempt, and
neither package was promoted to `latest`. Version `0.2.89` stopped before its
first upload. The first GitHub OIDC attempt then published both `0.2.90`
artifacts under their version-specific staging tag, but npm correctly rejected
the workflow's later `dist-tag` mutations: trusted publishing authorizes
`npm publish`, not `npm dist-tag`. None of those versions reached `latest`, so
all three are historical and unsupported.

Do not complete or manually promote the `0.2.88` or `0.2.90` candidates. Do not
publish public packages from a private product checkout or from a commit that
is not public `oscout/scout` `main`.

## Current source

This tree is `0.2.94`. CLI, runtime, protocol, session packages, desktop
command surface, baseline web, and `crates/scout-tui` are kept current by an
allowlisted overlay from the private OpenScout workspace. Native apps, hosted
services, and Slack stay out. After this source is on `main`, tag `v0.2.94`
and dispatch `release-package-npm.yml` so npm `latest` matches the tagged
public commit.

## Current publication set

The last registry cut from this repository, `0.2.92`, publishes:

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
node scripts/bump-version.mjs 0.2.92
bun install
npm run ship -- 0.2.92
bun run check
bun run test:unit
bash scripts/ship-npm.sh --dry-run
```

Commit the source, version manifests, `apps/desktop/src/shared/product.ts`,
`docs.json`, and lockfile on a review branch. Merge only after the standalone
checks and packed artifact audit pass.

## Historical local cutover path

`0.2.88` was the one local signed authority-cutover attempt. Its command was:

```bash
npm run ship -- 0.2.88 --execute --yes
```

That path is retained only for audit and complete-state verification; do not
use it for `0.2.89` or later. The command refuses a non-public origin, a branch
other than `main`, a HEAD that does not match freshly fetched `origin/main`, a
dirty tree, mismatched existing tag or registry state, or unsigned `scoutd`.
Matching tag and completed npm and GitHub release state are idempotent. Before
its first immutable upload, the publisher atomically retains both exact
tarballs and an integrity receipt under the repository's common Git directory at
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

Local npm publication does not create GitHub OIDC provenance. `0.2.89` and
later therefore have one publication authority: the public workflow, with
these configured:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`
- `MACOS_DEVELOPER_ID_APPLICATION_P12_PASSWORD`
- `MACOS_RELEASE_KEYCHAIN_PASSWORD`
- `OPENSCOUT_SIGN_IDENTITY`
- npm trusted publishing for
  `oscout/scout/.github/workflows/release-package-npm.yml`

The workflow explicitly refuses `v0.2.90` and older. Dispatch
`release-package-npm.yml` for an already-reviewed public `v0.2.91` or later tag
and wait for it to verify both packages. Before its first npm mutation, the
workflow builds and audits both exact tarballs, writes their durable receipt,
and uploads the complete candidate bundle as a run artifact. The candidate
bundle and final receipt use distinct artifact names: the former is recovery
state containing both immutable tarballs and their receipt, while the latter is
publication evidence uploaded only after registry verification.

GitHub OIDC publishes protocol first and Scout second, directly to `latest`; it
never invokes `npm dist-tag`. That dependency-safe ordering gives consumers a
valid protocol before the CLI that consumes it appears. npm may keep an accepted
upload in processing for several minutes, so the workflow waits for up to five
minutes per immutable upload before failing closed.

Recovery is explicit and deliberately narrow. If a run stops after publishing
only protocol, dispatch the same reviewed tag again with `recovery_run_id` set
to that failed workflow run. The new run downloads the prior run's exact
candidate bundle before preparation. It first proves that the prior run used
this exact workflow on `main` for the same release commit, ended unsuccessfully,
and owns exactly one live artifact with the expected version-and-SHA name. It
then verifies the receipt and both retained tarballs byte-for-byte, and may
publish only the missing Scout tarball when the registry is the exact
protocol-first prefix: protocol matches the retained SRI, public commit,
repository, version, and `latest`, while Scout does not yet exist. A missing or
foreign `recovery_run_id`, a rebuilt candidate, Scout-first state, a mismatched
artifact, a different partial prefix, or a complete unpromoted set fails closed
and requires a fresh version.

After both packages match the retained candidates and reach `latest`, the
workflow performs a separate registry-verification pass and uploads the final
integrity receipt. Attach that receipt to the GitHub release only after the
package set succeeds. Do not weaken the signing gate or publish a GitHub release
before that verification completes.

## Verify

After publication, verify that the git tag, both manifests, npm versions,
dist-tags, package repository metadata, and public source commit agree. Install
the packed CLI in an empty directory and exercise `scout --version`, setup,
broker health, and the baseline web server. A partial or mismatched publication
is not promoted as a successful release.
