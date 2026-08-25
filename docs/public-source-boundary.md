# Public-source boundary

Scout is the public infrastructure core of OpenScout. The split is based on
single-source ownership, not mirroring: public modules live here once, and the
private product consumes and extends them without keeping duplicate source.
This repository should be useful, reviewable, and releasable on its own without
pretending to contain every OpenScout product surface.

## What belongs here

- the public `scout` CLI and package bundle;
- the broker, runtime, shared protocol, and harness-session model;
- core web primitives, the reusable app shell, and basic structural pages;
- portable native services required by the public runtime;
- public integration contracts, documentation, tests, and release tooling;
- assets and community files needed to operate a healthy public project.

Code in this repository must not require a checkout of the private companion
workspace to install, build the public packages, run their focused tests, or
understand their supported architecture.

Each module has one canonical home. A public-core change is made and reviewed
here; the private product advances its declared dependency on that core. There
is no public-source export, mirrored subtree, or recurring two-repository merge
to keep synchronized.

## Web layering

The public web package defines the foundation: navigation and layout
primitives, shared states, accessible interaction patterns, protocol-backed
data boundaries, and basic structural pages that make the public control plane
coherent on its own.

The private product extends that foundation with product-specific pages,
services, integrations, and presentation. That dependency runs in one
direction: private code may import and compose the canonical public primitives;
public code must not import private modules, assume private routes exist, or
contain empty promotional placeholders for private features.

The extension mechanism is defined by the dedicated public/private architecture
proposal. Whatever mechanism lands should preserve the one-way dependency and
avoid private patches or copied public components. A useful public primitive
should be documented and exercised here before the private layer depends on it.

## What stays outside

- OpenScout native application source and product-specific web presentation;
- hosted product services that are not part of the public Scout contract;
- credentials, signing material, operational data, and private release notes;
- private experiments or integrations that have not become supported public
  interfaces.

Public documentation may describe the boundary and link to product surfaces,
but it should not disclose private implementation details or imply that private
features are available in the public package.

## Release invariants

The public split is trustworthy only when a release can be traced back to the
source a user can inspect. The release workflow should enforce these invariants:

1. all public package manifests use one version;
2. public npm packages are built only from their canonical source in this
   repository;
3. the release tag points at that source commit;
4. npm provenance and package metadata point back to `oscout/scout`;
5. the npm `latest` version and its tagged public source do not drift silently;
6. private consumers pin or otherwise declare the public-core revision they
   use, rather than copying its source;
7. public CI verifies the source boundary without private-workspace
   dependencies.

Version drift between npm and its public tagged source is a release blocker—not
something to fix by editing version strings alone. A private product may
deliberately consume an older public-core revision, but that revision must be
explicit and its source must remain canonical here.

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
