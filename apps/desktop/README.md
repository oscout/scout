# OpenScout Desktop Transition Area

`apps/desktop` is no longer the canonical OpenScout app home. It is a
transitional source tree for CLI, terminal UI, local-host, and service code that
predates the current package/app split.

New shared behavior should move into package-owned homes before it is consumed:
`packages/runtime` for broker/runtime services, `packages/cli` for the public
`scout` command, `packages/web` for the local web UI/server, and `apps/macos`
for native macOS shell behavior.

OpenScout is currently for high-trust local developer pilots. Keep desktop
copy and behavior aligned with that posture: local-first, explicit setup, no
enterprise/compliance claims.

## What Still Lives Here

- `bin/scout.ts` is a source-checkout compatibility entrypoint until CLI
  implementation moves fully into `packages/cli`.
- `src/cli` still contains most command parsing and command handlers.
- `src/core` still contains broker, MCP, pairing, mobile, setup, mesh, and
  service logic that is being extracted into package-owned modules.
- `src/app` contains old desktop/local-host composition that should either move
  to `apps/macos` or disappear as web/native surfaces take over.
- `src/server` is the retired desktop web/control-plane server path. Do not add
  routes there; current web server work belongs in `packages/web/server`.
- `src/ui` contains terminal presentation used by CLI flows.

Do not add new package dependencies on `apps/desktop`. Package code may expose
compatibility shims while migrations are in progress, but the dependency
direction should be apps depending on packages.

## Local Commands

From the repo root:

```bash
bun run dev
bun run --cwd apps/desktop check
bun run --cwd apps/desktop scout --help
bun run --cwd apps/desktop test:happy
```

`bun run dev` starts the current web app from `packages/web`; it is listed here
only because it is still the fastest full local surface check from the repo
root.

Use the public package path when testing installed CLI behavior:

```bash
npm --prefix packages/cli run build
(cd packages/cli && bun link)
scout setup
scout doctor
```

## Read Next

- [Root README](../../README.md) for the product overview and bootstrap path.
- [Architecture](../../docs/architecture.md) for broker/runtime/protocol
  boundaries.
- [Current posture](../../docs/current-posture.md) for maturity and trust
  limits.
- [Agent integration contract](../../docs/agent-integration-contract.md) before
  changing harness or adapter behavior.
- [Desktop deprecation plan](../../docs/eng/sco-038-apps-desktop-deprecation.md)
  before moving or deleting remaining code from this tree.
