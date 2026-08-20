# Scout

The CLI and runtime for the OpenScout agent mesh — the code that ships as
[`@openscout/scout`](https://www.npmjs.com/package/@openscout/scout) on npm.

```sh
bun install -g @openscout/scout   # or: npm install -g @openscout/scout
scout --version
```

## What's here

| Path | What it is |
| ---- | ---------- |
| `packages/cli` | The published package: `scout` CLI + `openscout-runtime` entrypoints |
| `packages/runtime` | Broker runtime: mesh, routing, rendezvous, pairing, knowledge index |
| `packages/protocol` | Wire types, agent identity, runtime catalog |
| `packages/agent-sessions` | Harness session descriptors and lifecycle |
| `packages/web` | Control-plane web server + client bundled into the package |
| `packages/session-trace` / `-react` | Session trace format and viewer components |
| `apps/desktop` | CLI command surface and desktop host core (feeds the CLI bundle) |
| `crates/` | Native side: `scoutd` broker daemon, repo service, voice core |

## Building

```sh
bun install
bun run --cwd packages/cli build   # protocol → runtime → CLI bundle
./packages/cli/bin/scout --version
```

Run `bun run sync-exec:fence` before submitting changes that shell out.

## Relationship to OpenScout

The OpenScout applications (macOS, iOS, the full web app, and the hosted
services) are developed in a private companion repository. This repository is
the source of truth for everything published to npm; releases are cut here via
the `release-package-npm` workflow.
