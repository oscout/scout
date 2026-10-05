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

## Package publication versus the latest downloadable installer

Scout keeps one shared version across npm packages and native apps. Sharing a
version does not make them one publication: package publication and the
downloadable installer have separate owners and separate release steps.

- **Package publication** (this repository): `@openscout/protocol` and
  `@openscout/scout` on npm, plus a GitHub release on `oscout/scout` whose only
  asset is the npm integrity `receipt.json`.
- **Latest downloadable installer** (private product): the signed macOS DMG,
  built and verified as a local operator task rather than in CI. GitHub's
  **Latest** release, and therefore `/releases/latest` download links, belongs
  to the release that carries that verified installer.

`bun run ship` therefore never claims GitHub Latest. It creates a missing
package release with `--latest=false`, and when it finalizes a draft or
prerelease it also passes `--latest=false`, so a receipt-only release cannot
replace the downloadable installer as Latest. It never edits an existing
stable release: a retry or receipt verification against a release that is
already Latest, such as a verified native release for the same version, leaves
that state unchanged instead of demoting it. Marking a release Latest is a
separate step owned by the native installer release after its DMG is attached
and verified; package publication neither requires nor performs it.

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

## 0.3.0 package review follow-up

This release makes an explicitly selected channel authoritative for message
routing, so body text such as scoped npm package names cannot prevent a channel
update. Claude catalog discovery now tracks pending persistence work and awaits
it during shutdown, so session catalog writes settle before shutdown completes.

The npm guide lists only the bundled CLI, broker/runtime, and basic web surface.
The retired `scout monitor` console is no longer advertised as installed; the
Rust TUI remains a separate optional installation.

Root `bun run test:unit` includes the dedicated CLI suite. Public CI runs those
tests as an explicit step before the source unit suite. Launcher tests build
fresh temporary JavaScript fixtures and isolate HOME, broker endpoints, sockets,
and service settings; they do not depend on existing `dist` output or package a
native supervisor. The signed tarball audit and isolated installed-package smoke
remain separate release gates.

## 0.2.110 source update

This release brings the reviewed CLI, broker, protocol, and web source updates
into the public package, including invitation previews and readable Scout Chat
feeds, participant inbox commands, clearer ask/status/wait receipts, and the
examples-first npm guide. Commercial support and plans link to
[OpenScout contact](https://openscout.app/contact).

Public-only publication tooling and MCP registry metadata remain authoritative.
The browser package still uses the basic Home, DMs, and Tail profile; the existing
exact tarball limits and excluded-feature checks apply unchanged. The public
Tail session fallback and isolated mobile catalog test are retained. Hosted
Worker parity checks stay in the private product repository; the exported client
behavior tests have no dependency on private Worker source.

## Local publication

### 0.2.109 basic web package footprint

The npm browser client now includes Home, DMs and Tail. World, Replay and
3D character studio assets are excluded. The exact tarball audit rejects the
character asset directory and full-app script markers, requires the basic
shell and emitted JavaScript, and rejects an unbuilt source entry. These checks
inspect the retained tarball itself, not just a successful local client build.

The build retains all 29 runtime crew portraits and eye patches and excludes
the crew preview page, source masters, runs, and QA trees. The tarball audit
still requires those runtime assets, the broker binary, and the server entries.
The reviewed dry-run candidate measures approximately 6.9 MB packed, 29.0 MB
unpacked, and 127 files. The existing total ceilings remain 26 MB packed,
60 MB unpacked, and 670 files; exact excluded-feature checks enforce this cut. The separate
1,024-byte limit on the legacy web-server entry still rejects a duplicated full
server bundle, regardless of total size. Every final candidate must pass the
exact tarball audit; this scope change does not waive signing, artifact checks,
or authorize incidental limit increases.

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

When package policy requires interactive two-factor authentication, explicitly
select the operator's existing npm login instead:

```bash
npm login --registry https://registry.npmjs.org # establish a login separately
bun run ship -- <version> --execute --yes --auth npm-login
```

Run this mode in an interactive terminal so npm can present browser or OTP
challenges. It verifies the existing login with `npm whoami` and inherits npm
configuration and terminal input/output. It does not read, copy, or write
credentials, call secret-store helpers, or fall back to another authentication
mode. `NPM_TOKEN` and `NODE_AUTH_TOKEN` must be unset; hosted execution rejects
this mode. The lower-level publisher accepts `SCOUT_NPM_AUTH_MODE=npm-login`.
Default and `@openscout` scoped registries are pinned to npmjs for every package
read and mutation, including when the inherited login has a different scope registry.
Token authentication remains the default, and both local modes retain the same
source, signing, artifact, receipt, staging, and promotion gates.

Local publication uploads protocol and Scout under a version-specific staging
tag, verifies both against retained candidates, and only then promotes the pair
to `latest`. A fresh release must advance the current versions and begin with
both package versions unused. A matching completed release is idempotent. A
complete immutable pair may resume missing dist-tag promotion only with its
exact retained receipt. The ordinary publisher still rejects a partial local pair. A protocol-first
local interruption may use the explicit retained recovery command below. Changed
artifacts, wrong source, missing receipt, foreign authority, and historical
candidates remain forbidden.

After registry verification succeeds, the command creates or verifies the final
public GitHub release, without marking it Latest, and attaches `receipt.json`. Existing receipts are never
clobbered: their size and anonymously downloaded SHA-256 must match the retained
receipt. An upload command succeeding alone is not a verified release.

## Validate a candidate before promotion

The full stable command above remains the default. For releases that require a
real installation pass before changing npm `latest`, explicitly split candidate
publication from promotion:

```bash
# From clean reviewed public main already versioned at the exact unused version.
# Run in an interactive terminal using the operator's existing npm login.
bun run ship -- <version> --phase candidate --execute --yes --auth npm-login

# Install the exact published version and validate the retained candidate.
# After operator approval of that result, promote the same source and bytes.
bun run ship -- <version> --phase promote --execute --yes --auth npm-login
```

Candidate mode establishes the ordinary `v<version>` tag at the reviewed public
source, prepares the exact signed pair once, and publishes both under the existing
`scout-release-<version-with-dashes>` staging tag. It verifies the complete pair
and staging tags, then creates or verifies a non-draft GitHub **prerelease** with
`--latest=false`. It uploads `candidate-receipt.json`, clearly labeled
`scout-npm-candidate` / `CANDIDATE`, binding the public source SHA, version,
local authority, staging tag, both package measurements and the SHA-256 of the
original integrity receipt. The ordinary `receipt.json` stays in the retained
bundle until promotion. Candidate mode changes neither npm `latest` nor GitHub
Latest; an exact version remains installable from npm for candidate validation.
A candidate retry reuses the same bundle and verifies an existing public marker;
it never rebuilds, overwrites conflicting assets, or relabels a stable release.

Keep the original bundle, tag and candidate marker throughout validation.
Promotion requires that same source on clean public `main` equal to freshly
fetched remote `main`; if main has moved, stop rather than rebuild or infer a
new candidate source. It verifies the original local bundle, exact tag, the
anonymously downloaded public candidate marker and complete immutable registry
pair before changing a dist-tag. It performs no package build or npm upload.
Only then does it promote both npm `latest` tags, verify them, finalize the same
GitHub release as stable with `--latest=false`, and attach the unchanged ordinary
`receipt.json`. The candidate marker remains as historical validation identity.
An interrupted promotion can verify already-promoted members and finish the
remaining promotion/metadata without replacing bytes. An existing stable/native
release's GitHub Latest state remains untouched by a completed retry.

The public candidate release can retain a separately verified native DMG through
an explicitly authorized operator handoff. That handoff must preserve the exact
signed/notarized artifact, its private source/dependency receipt and public byte
verification; it is not performed by the npm publisher. Candidate creation does
not satisfy private native stable-promotion guards. After validation and public
package promotion, the existing native owner can verify the ordinary stable
receipt and promote GitHub Latest separately. Appcast/site publication remains
another verified follow-up.

The lower-level local modes are `ship-npm.sh --publish-candidate`,
`--verify-candidate`, and `--promote-prepared`. They require the exact retained
bundle and clean matching public source/tag. `--publish-candidate` verifies the
pair and exits before npm promotion; `--promote-prepared` requires the complete
published pair and never builds or uploads a missing package. These modes reject
hosted execution. `--verify-candidate` accepts an exact staging tag or an
already-promoted member so explicit promotion retries can complete safely.
The top-level candidate/promotion commands additionally enforce the public
candidate marker and GitHub release metadata.

A partial candidate upload remains fail-closed. Preserve the original bundle
and registry evidence and stop the campaign: do **not** use the ordinary local
recovery command below, because it promotes `latest` and would bypass this
validation gate. Candidate mode never invokes that recovery automatically.
If installation validation fails, preserve the published immutable bytes,
receipts and held staging tag. Fix the source through review and select a new
explicit unused version for the next candidate; never rebuild or replace the
failed version, roll it back, or promote it through partial-pair recovery.
The default full release command refuses to finalize a retained candidate
prerelease; use explicit `--phase promote` after validation. Wrong source,
tampered/missing markers or bundles, changed staging tags, incomplete package
pairs and newer `latest` versions stop promotion before mutation. No private npm
publisher, automatic hosted fallback, rollback or credential-storage behavior
is added by these phases.

## Recover a retained local release

If npm accepts protocol but it becomes visible only after the publication wait
expires, keep the original signed candidate bundle. Do not rebuild it or bump a
version solely because registry propagation exceeded the wait. The ordinary
publisher still rejects partial local state; recovery is a separate explicit
command in reviewed public tooling (see [issue #23](https://github.com/oscout/scout/issues/23)).

The recovery tooling can be merged after the candidate: run it from clean public
`main` equal to remote `main`. Supply the **original** release SHA and original
receipt SHA-256, not the tooling commit. The original local and remote version
tag must still resolve to that source, and the source must be an ancestor of the
reviewed tooling. The command locates the bundle in the shared Git directory at
`scout-release/npm/<version>-<original-source-sha>/`; it does not accept a rebuilt
bundle or an alternate state-directory override.

```bash
# Inspect and record the original receipt digest before requesting execution.
shasum -a 256 .git/scout-release/npm/<version>-<original-source-sha>/receipt.json
node scripts/recover-local-npm-release.mjs \
  --version <version> --source <original-source-sha> \
  --receipt-sha256 <original-receipt-sha256>

# After review and explicit authorization, use the operator's existing npm login.
# Run in an interactive terminal so npm can present any browser/OTP challenge.
node scripts/recover-local-npm-release.mjs \
  --version <version> --source <original-source-sha> \
  --receipt-sha256 <original-receipt-sha256> \
  --execute --yes --auth npm-login
```

Authentication is the operator's existing local npm configuration, including a
browser login established with `npm login` separately. Recovery calls `npm
whoami` and inherits terminal input/output for mutations; it never logs in,
reads or writes credential files, copies tokens, invokes secret-store helpers,
or falls back to hosted authority. Local provenance remains disabled.

Recovery verifies the receipt's repository, source, version, local authority,
and both tarballs' size, SHA-256, SRI, and package manifests before proceeding.
Registry protocol must already match those exact values and its staging tag or
`latest`; CLI-first state, an absent protocol, unknown registry errors, newer
`latest`, and split older baselines fail closed. It can upload **only** the
missing retained CLI tarball, with lifecycle scripts disabled. Both immutable
artifacts must match before either `latest` tag is changed. An exact complete
pair can resume an interrupted promotion without re-uploading anything.

The command holds the same candidate lock as the ordinary publisher and
preserves the original receipt. It waits up to 15 minutes for registry
propagation (`--wait-seconds` accepts 5–3600). A timeout or uncertain upload does
not cause an automatic upload retry: retain the bundle and rerun the identical
command after checking registry state. A later-visible matching CLI is verified
and skipped. Versions through `0.2.90` remain frozen. Staging tags are left as
harmless recovery evidence. GitHub release creation and attaching/verifying the
original receipt remain separate steps after the pair succeeds.

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
