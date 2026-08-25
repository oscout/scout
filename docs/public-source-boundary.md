# Public-source boundary

Scout is the public infrastructure core of OpenScout. The destination is
single-source ownership, not mirroring: public modules live here once, and the
private product consumes exact released packages without keeping duplicate
source. This repository should be useful, reviewable, and releasable on its own
without pretending to contain every OpenScout product surface.

> **Migration status:** this document defines the target boundary. At the
> proposal snapshot, public-core source still overlaps the private workspace and
> public release ownership has not fully moved here. Statements below about one
> canonical source, exact package consumption, and web composition are
> invariants to complete and enforce—not claims that the cutover is finished.

## Target at a glance

| Public `oscout/scout` | Private product |
| --- | --- |
| Canonical source for protocol, runtime, harness adapters, CLI/daemon, and reusable primitives | Consumes exact released public package versions |
| Complete baseline web server and operator control plane | Adds native apps, hosted services, advanced operations, and product-specific UI |
| Trusted composition contracts and a standalone public build | Builds a private web distribution through those contracts |
| Never imports or requires private code | Never copies public packages, mirrors `packages/web`, or becomes a source dependency of public Scout |

## What belongs here

- the public `scout` CLI and package bundle;
- the broker, runtime, shared protocol, and harness-session model;
- the complete baseline web control plane, including its server, application
  shell, ordinary operator workflows, and reusable UI primitives;
- trusted web-composition contracts for routes, navigation, slots, namespaced
  server routes, and capability providers;
- portable native services required by the public runtime;
- public integration contracts, documentation, tests, and release tooling;
- assets and community files needed to operate a healthy public project.

Code in this repository must not require a checkout of the private companion
workspace to install, build the public packages, run their focused tests, or
understand their supported architecture.

When the migration is complete, each module has one canonical home. A
public-core change is made and reviewed here, released from here, and adopted by
the private product through an exact dependency bump. There is no public-source
export, mirrored subtree, recurring two-repository merge, or reverse dependency
to keep synchronized.

## Web layering

The public web package is responsible for a complete baseline control plane,
not a deliberately thin shell. A developer should be able to install Scout and
complete the core local loop through useful setup and health, agents and
sessions, conversations and send/ask, flights and work, activity, runtimes and
capabilities, projects, mesh and pairing, and settings views.

The target extension mechanism is trusted, build-time composition. The public
package supplies the app shell, design tokens, components, broker client, and
typed contracts for routes, navigation, slots, namespaced server routes, and
capability providers. The private product compiles those exports with its own
contributions into a separate distribution. React and other UI singletons
resolve once in that composed build.

That dependency runs in one direction: private code imports only documented
public exports, while public code never imports private modules, assumes private
routes exist, or relies on private assets. Missing private capabilities must not
break the baseline app. Until the composition API and package release cutover
land, documentation should describe them as the target rather than implying the
private product already consumes them.

## What stays outside

- OpenScout native macOS and iOS application composition;
- hosted account, relay, push, entitlement, and managed-service behavior;
- advanced fleet, mission, repository, and worktree operations built on public
  records;
- product-specific web presentation, onboarding, and proprietary integrations;
- credentials, signing material, operational data, and private release notes;
- private experiments or integrations that have not become supported public
  interfaces.

Public documentation may describe the boundary and link to product surfaces,
but it should not disclose private implementation details or imply that private
features are available in the public package.

## Broker-owned working set

The broker is the canonical owner of live registry and coordination state.
Control-plane clients must not download or persist the broker's lifetime
registry as their own source of truth. They request a bounded, coherent working
set instead: current routable agents and endpoints, active work, and a recent
window of coordination records with the referenced identities needed to render
it.

The ordinary web context path already asks the broker for a 24-hour working
set, coalesces concurrent reads, and keeps the result behind a short in-process
TTL. An expired or invalidated cache is rehydrated from the broker. Conversation
history outside that working set is loaded through its dedicated bounded APIs,
not by growing the registry payload.

This migration is not complete. Rich agent views and desktop context still have
full-snapshot reads, and the time-windowed projection is not yet protected by an
explicit cardinality or byte ceiling. Those paths must move to scoped,
paginated broker reads before this boundary can be considered enforced. A
routine registry response that returns lifetime history or grows to tens of
megabytes is a regression, not a cache format clients should preserve.

## Release invariants

The public split is trustworthy only when a release can be traced back to the
source a user can inspect. The release workflow should enforce these invariants:

1. all public package manifests use one version;
2. public npm packages are built only from their canonical source in this
   repository;
3. the release tag points at that source commit;
4. npm provenance and package metadata point back to `oscout/scout`;
5. the npm `latest` version and its tagged public source do not drift silently;
6. private consumers pin exact, lockstep public package versions rather than
   copying source or importing unpublished internals;
7. public CI verifies the source boundary without private-workspace
   dependencies.

Version drift between npm and its public tagged source is a release blocker—not
something to fix by editing version strings alone. A private product may
deliberately consume an older public-core revision, but that revision must be
explicit and its source must remain canonical here.

### The transition release

`0.2.89` moves source and release authority for the supported
`@openscout/scout` and `@openscout/protocol` pair to this repository. npm
accepted only the protocol artifact from the attempted `0.2.88` cutover under
an unpromoted staging tag; that partial version is historical and is not a
supported Scout release. `0.2.89` does not claim that the complete
component-package boundary is already finished.
Supported publication of `@openscout/agent-sessions`, `@openscout/runtime`, and
`@openscout/web` from this repository remains deferred until they have supported
exports, standalone pack/install tests, and a zero-extension web-composition
fixture. Historical registry artifacts are not the supported lockstep family.

The first full pre-`1.0` component release is one exact five-package set:
protocol, agent sessions, runtime, web, and Scout. Its manifests, packed
first-party dependencies, public source tag, npm dist-tags, and distribution BOM
must all resolve to one version. The private product can have an independent
product version, but it consumes one complete public set without ranges or
source paths.

## Scout distributions

A **Scout Distribution** is a reproducible product assembly: one exact public
core release plus zero or more trusted build-time extensions. It is not a sixth
npm package, a runtime plugin loader, or a source mirror.

The first full five-package release—not the `0.2.89` transition release—will
define the reference zero-extension Scout Distribution. `0.2.89` establishes
two-package source and publication authority; it does not claim a resolved
distribution BOM or private BOM-based consumption.

A private product will extend the zero-extension baseline by immutable BOM
digest, contribute product routes, navigation, semantic UI slots, namespaced
server routes, and capability providers, and emit one flattened resolved BOM
for diagnostics. It will not restate or copy the public package source.

An eventual resolved BOM records source identity, registry integrity,
provenance, composition-contract identity, and extensions:

```jsonc
// Illustrative v1alpha1 shape; field names are not yet normative.
{
  "apiVersion": "scout.openscout.dev/v1alpha1",
  "kind": "ScoutDistribution",
  "metadata": {
    "id": "org.oscout.scout",
    "version": "<distribution-version>"
  },
  "core": {
    "version": "<core-version>",
    "source": {
      "repository": "https://github.com/oscout/scout",
      "tag": "v<core-version>",
      "commit": "<40-character-commit>"
    },
    "packages": [
      {
        "name": "@openscout/protocol",
        "version": "<core-version>",
        "integrity": "sha512-<registry-sri>",
        "provenance": "<attestation-reference>"
      },
      {
        "name": "@openscout/agent-sessions",
        "version": "<core-version>",
        "integrity": "sha512-<registry-sri>",
        "provenance": "<attestation-reference>"
      },
      {
        "name": "@openscout/runtime",
        "version": "<core-version>",
        "integrity": "sha512-<registry-sri>",
        "provenance": "<attestation-reference>"
      },
      {
        "name": "@openscout/web",
        "version": "<core-version>",
        "integrity": "sha512-<registry-sri>",
        "provenance": "<attestation-reference>"
      },
      {
        "name": "@openscout/scout",
        "version": "<core-version>",
        "integrity": "sha512-<registry-sri>",
        "provenance": "<attestation-reference>"
      }
    ]
  },
  "composition": {
    "contract": {
      "package": "@openscout/web",
      "export": "./composition",
      "version": "<core-version>"
    },
    "extensions": []
  },
  "capabilities": {
    "requires": [],
    "declares": []
  }
}
```

The normative full-family BOM contains exactly the five public package names,
all at the same pre-`1.0` version. A private overlay repeats only the public
distribution id, version, BOM URL, and digest, then lists its own extension
identities and digests. Live availability and authorization remain
broker-owned; BOM capabilities describe build-time requirements and
declarations only.

The resolved BOM is created after registry publication and attached to the
release with a signature or attestation. It cannot live inside a tarball whose
own integrity it records.

## Moving a surface across the boundary

When code becomes public, move a coherent slice with its tests, documentation,
license metadata, dependency declarations, and history or provenance notes.
Then update the private consumer and remove its old copy. Remove private-only
assumptions first. Review the moved diff for secrets, internal endpoints,
customer data, signing details, and unsupported product claims before
publishing it.

When public code returns to a private surface, preserve compatibility for any
published contract or document the breaking change. Move ownership rather than
forking a second copy, and do not leave a public package pointing at source
users can no longer inspect.
