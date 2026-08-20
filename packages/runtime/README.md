# OpenScout Runtime

`@openscout/runtime` is the local runtime foundation for OpenScout: the broker,
SQLite store, service lifecycle, local discovery, system probes, and host-side
adapters that make the protocol durable on a developer machine.

Use [`@openscout/protocol`](../protocol) when you only need the data contract.
Use this package when you are building a local OpenScout surface, service, CLI,
or integration that needs to talk to or embed the broker/runtime layer.

> Current posture: OpenScout is for high-trust local developer pilots. This
> package is not a hardened multi-tenant runtime or a compliance boundary.

## Install

```bash
npm install @openscout/runtime @openscout/protocol @openscout/agent-sessions
```

The runtime is TypeScript-first and publishes built ESM plus declarations. In a
Bun monorepo checkout, the package export map keeps the `bun` condition pointed
at `src/` so local development can type-check without building `dist` first.
Published Node/ESM consumers resolve `dist/`.

## Quickstart: embed the in-memory runtime

For tests, tools, and small local integrations, start with the in-memory runtime
and the shared protocol types:

```ts
import { InMemoryControlRuntime } from "@openscout/runtime";
import type { MessageRecord } from "@openscout/protocol";

const runtime = new InMemoryControlRuntime();

const message: MessageRecord = {
  id: "msg-demo",
  conversationId: "conv-demo",
  actorId: "operator",
  originNodeId: "local-demo",
  class: "agent",
  body: "Hello from a local OpenScout integration.",
  visibility: "workspace",
  policy: "best_effort",
  createdAt: Date.now(),
  metadata: {},
};

await runtime.postMessage(message, { localOnly: true });

console.log(runtime.snapshot().messages[message.id]?.body);
```

For a machine service, use the `openscout-runtime` bin or the public CLI package
that wraps it:

```bash
openscout-runtime service status --json
openscout-runtime broker
```

## What this package owns

The runtime is the operational layer beneath OpenScout surfaces:

- canonical local SQLite schema and stores
- broker daemon, HTTP, SSE, and routing services
- message, invocation, flight, delivery, question, and work-item persistence
- local agent and harness endpoint discovery
- service install/status/start/stop helpers
- repo watch and repo diff snapshots
- system probes for host state used by the broker and web UI
- optional mesh helpers through Tailscale and Iroh bridge processes
- mobile push relay records for local broker notifications

The broker remains the canonical writer for Scout-owned coordination records.
External harness transcripts are observed source material; they are not bulk
imported as first-party Scout messages.

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@openscout/runtime` | Root broker/runtime surface: registry, broker services, store, setup, config, probes, projections, repo watch/diff, and protocol path re-exports. |
| `@openscout/runtime/broker-api` | HTTP client helpers for talking to an active local broker. |
| `@openscout/runtime/broker-core-service` | Broker service composition boundary for embedding/testing. |
| `@openscout/runtime/broker-process-manager` | Service config, status, install/start/stop/restart helpers. |
| `@openscout/runtime/broker-trpc-router` | tRPC router surface for broker-adjacent hosts. |
| `@openscout/runtime/registry` | Runtime registry snapshot helpers. |
| `@openscout/runtime/local-agents` | Local agent config, launch, wake, and session helpers. |
| `@openscout/runtime/harness-catalog` | Known harness catalog and readiness reporting. |
| `@openscout/runtime/system-probes` | Cached local system probes and scoutd-backed probe client. |
| `@openscout/runtime/repo-watch` | Repo/worktree status snapshots for Scout surfaces. |
| `@openscout/runtime/knowledge` | Local knowledge/session indexing store. |
| `@openscout/runtime/conversations` | Conversation service facades over the runtime store. |
| `@openscout/runtime/mesh/tailscale` | Tailscale status and host helpers. |
| `@openscout/runtime/mesh/iroh-bridge` | Iroh bridge process helpers. |
| `@openscout/runtime/mobile-push` | Local mobile push registration and audit store. |
| `@openscout/runtime/sqlite-adapter` | Runtime SQLite adapter selection for Bun/Node hosts. |
| `@openscout/runtime/drizzle` | Host-bound control-plane DB bridge for internal server code that queries runtime-owned tables. |
| `@openscout/runtime/tool-resolution` | Portable executable/path resolution helpers. |

Additional exports provide focused slices for setup/onboarding, agent workspace
configuration, provisional names, local config, local edge, session display,
activity, tail, harness topology, Claude stream-json, pi RPC, Codex app server,
and related broker read models.

## Runtime support

This is a host-side package, not a browser package.

| Surface | Browser | Node | Bun | Notes |
| --- | :---: | :---: | :---: | --- |
| Pure helpers such as config/path/protocol facades | — | ✅ | ✅ | May still read environment or files depending on import. |
| Broker/store/service surfaces | — | ✅ | ✅ | SQLite adapter chooses Bun SQLite or Node SQLite. |
| `openscout-runtime` bin | — | — | ✅ | The bin uses a Bun shebang. |
| Local agent, harness, MCP, repo, and system-probe surfaces | — | ✅ | ✅ | These may spawn local tools or talk to `scoutd`. |
| Mesh/Iroh helpers | — | ✅ | ✅ | Require configured native bridge binary. |

Published declarations avoid requiring downstream TypeScript projects to install
`@types/node` just to import the package. Runtime execution still requires the
host capabilities used by the surface you import.

## Native acceleration and fallbacks

Some expensive or OS-sensitive work can be delegated to Rust binaries:

- `scoutd` serves cached system probes and selected imperative operations over a
  local Unix socket.
- `openscout-repo-service` produces native repo scan/diff facts.

The TypeScript runtime uses a conservative fallback model: prefer the scoutd
socket when it advertises the capability, fall back to a bounded native
subprocess when available, and finally use existing TypeScript/local fallback
paths where the feature supports them. Fallback metadata is attached to relevant
responses so operators can diagnose when the daemon is unavailable.

### No daemon required

`scoutd` is an optional accelerator, not a requirement for adopting the package.
The TypeScript/local backend is a first-class, permanent mode: imports, ordinary
unit tests, and supported runtime operations continue to work without a Rust
toolchain or a running daemon. When `scoutd` is present, the runtime verifies the
advertised capability and schema version before using it; when it is absent,
stale, or incompatible, the same typed APIs fall back locally and expose backend
metadata for diagnostics.

The real-daemon conformance harness is intentionally opt-in for contributors:

```bash
OPENSCOUT_CONFORMANCE=1 bun test packages/runtime/src/system-probes.test.ts --test-name-pattern='scoutd conformance diff harness'
```

CI runs that conformance suite, but casual `bun test` does not need Cargo.

## Local development

From the repo root:

```bash
npm --prefix packages/runtime run build
npm --prefix packages/runtime run check
npm --prefix packages/runtime run test
bun run sync-exec:fence
```

The sync-exec fence is intentionally separate from the package-local check. Run
it before changing host process, probe, or service-management code.

## Publishing checks

The package is prepared for standalone npm publication with real dependencies on
`@openscout/protocol` and `@openscout/agent-sessions`. The prepack step rewrites
workspace dependency ranges to concrete package versions before packing.

Recommended release checks:

```bash
npm --prefix packages/runtime run build
npm pack --workspace @openscout/runtime
npx publint packages/runtime
npx @arethetypeswrong/cli --pack packages/runtime --profile esm-only
```

Also verify an external ESM scratch project with `skipLibCheck: false` and no
`@types/node`; this catches published declaration leaks that monorepo checks can
miss.

## Live and e2e checks

- `bun run --cwd packages/runtime test:live:codex-app-server` uses
  [README-live-codex-app-server-test.md](./README-live-codex-app-server-test.md)
  for a direct Codex JSON-RPC check against an existing app-server listener.
- `bun run --cwd packages/runtime test:e2e:local-agent-pass` uses
  [README-live-local-agent-pass.md](./README-live-local-agent-pass.md) for a
  full Codex ↔ Claude broker pass on one machine.

These live checks require local harnesses and are not a substitute for the unit,
package, and external-consumer checks above.
