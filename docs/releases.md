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

## Publication ownership

This public repository owns `@openscout/protocol` and `@openscout/scout`.
Other workspaces share the source version but are not separately supported npm
releases. Native macOS/iOS apps remain in the private product repository.

Local execution is the default for reviewed, explicitly authorized releases.
Hosted CI and npm publication remain opt-in. Do not dispatch Actions as a
fallback for missing local credentials or local validation failures. Record
proportional local checks against the exact reviewed head and current main base;
observe required GitHub rules and feedback before merging. Hosted runs can
provide additional evidence when explicitly requested.

## Prepare and review

Choose an explicit unused version. Never use `patch` to recover from registry
drift.

```bash
bun scripts/bump-version.mjs <version>
bun install
bun run ship -- <version>
bun run check
bun run test:unit
bash scripts/ship-npm.sh --dry-run
```

Commit the source, version manifests, `apps/desktop/src/shared/product.ts`,
`docs.json`, and lockfile on a review branch. Merge only after the standalone
checks and packed artifact audit pass.

## Local publication

### 0.2.101 package footprint

The integrated candidate measures approximately 22.8 MB packed, 52.3 MB
unpacked, and 600 files. This release deliberately includes the reachable
World and Replay renderers, their artwork, and the 3D character studio. The
previous 8.5 MB / 38 MB / 500-file limits predated those screens; deleting
their reachable chunks or renderer options would change the release scope.
The reviewed limits are now 26 MB packed, 60 MB unpacked, and 670 files,
allowing roughly ten percent margin with rounded ceilings.

The build retains all 29 runtime crew portraits and eye patches (884,738
bytes) and excludes the crew preview page, source masters, runs, and QA
trees. The tarball audit requires those runtime assets and the Sage model,
so the old failure mode of enabling crew art while stripping its directory
cannot pass. The separate 1,024-byte limit on the legacy web-server entry
still rejects a duplicated full server bundle, regardless of total size.
Every final candidate must pass the exact tarball audit; this recalibration
does not waive artifact checks or authorize later incidental limit increases.

After the chosen version and source are reviewed and merged, run from a clean
public `main` checkout:

```bash
bun run ship -- <version>                 # read-only plan; does not build
bun run ship -- <version> --execute --yes # authorized local release
```

Execution never selects a version, bumps manifests, commits source, or starts
hosted jobs. It requires the canonical public origin, clean `main`, HEAD equal
to freshly fetched remote `main`, lockstep versions, and matching existing tags.
It creates/pushes the explicitly chosen tag only after registry preflight.
Versions through `0.2.90` are historical and cannot be published or promoted.

The publisher prepares and audits both exact tarballs once, including signed
`scoutd`, then atomically retains the candidates and integrity receipt under
`.git/scout-release/npm/<version>-<release-sha>/`. `--publish-prepared` publishes
those retained bytes without rebuilding. Preserve this bundle through registry
and GitHub verification. Receipts bind repository, source SHA, version,
authority, package SHA-256/SRI and sizes. New receipts explicitly record
`provenance: "none"` for local publication; the `local-signed` authority describes
signed artifacts, not npm OIDC provenance. Historical schema-1 receipts remain
readable through their bound authority.

Provide `NPM_TOKEN` or the local secret-store entry `OPENSCOUT_NPM_TOKEN` with
permission to publish both packages and update their dist-tags. The script uses
a private temporary npm configuration and removes it on exit. Local publication
explicitly disables npm provenance generation. It neither stores credentials in
receipts nor falls back to hosted credentials. Signed build prerequisites still
apply; do not bypass the binary signing gate.

Local publication uploads protocol and Scout under a version-specific staging
tag, verifies both against retained candidates, and only then promotes the pair
to `latest`. A fresh release must advance the current versions and begin with
both package versions unused. A matching completed release is idempotent. A
complete immutable pair may resume missing dist-tag promotion only with its
exact retained receipt. A partial local pair, changed artifact, wrong source,
missing receipt, or foreign authority fails closed; choose a newly reviewed
unused version instead of repairing historical candidates manually.

After registry verification succeeds, the command creates or verifies the final
public GitHub release and attaches `receipt.json`. Existing receipts are never
clobbered: their size and anonymously downloaded SHA-256 must match the retained
receipt. An upload command succeeding alone is not a verified release.

## Explicit hosted publication

When the operator deliberately chooses hosted publication, dispatch the public
`release-package-npm.yml` workflow directly. It verifies its canonical workflow
identity and refuses token authentication. There is no automatic transition
between local and hosted authority; retained receipts cannot cross authorities.
The hosted path uses npm trusted publishing/OIDC and these signing secrets:

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
