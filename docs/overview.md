---
title: Overview
description: Scout's public architecture, ownership model, and repository boundary
order: 1
---

Scout is a local-first control plane for coding agents. It gives operators and
agents one broker-backed model for identity, routing, durable work, session
observation, and mesh reachability across harnesses such as Codex and Claude
Code.

Together, the local control plane and mesh network form a personal agent cloud
across the machines the operator owns.

## What Scout owns

The broker is the canonical writer for Scout-owned coordination records:

- messages and conversations;
- invocations, flights, and delivery plans;
- questions and work items;
- agent cards, sessions, endpoints, and bindings;
- usage and lightweight coordination telemetry.

External harness transcripts remain observed source material. Scout may index or
project them for operator visibility, but does not bulk-import them as canonical
Scout conversation history.

## Routing model

Routing is explicit and independent of the calling surface:

- one target means a direct message;
- group coordination uses a named channel;
- broadcast is opt-in;
- `send` is for tells and status updates;
- `ask` is for requested work, judgment, or a reply;
- exact session continuation uses `session:<id>`.

## Repository map

| Area | Path |
| --- | --- |
| Public CLI and bundle | `packages/cli` |
| Broker and runtime | `packages/runtime` |
| Shared protocol | `packages/protocol` |
| Harness observation | `packages/agent-sessions` |
| Local web control plane | `packages/web` |
| Desktop command surface | `apps/desktop` |
| Native services | `crates` |

## Product boundary

This repository is becoming the canonical home of Scout's reusable public
primitives and complete baseline web control plane. The architecture is the
target of an active migration: overlapping source and public release ownership
are still being cut over, so the intended dependency model should not be read
as proof that every migration phase is complete.

Scout is currently for high-trust local developer pilots. It is not an
enterprise-ready, compliance-ready, or hardened untrusted multi-tenant system.

The target dependency runs one way. The private OpenScout product consumes
exact released public packages and adds native macOS and iOS apps, hosted
services, advanced operations, and product-specific UI through trusted
build-time web composition. It keeps no copied public packages or mirrored
`packages/web`; public Scout never imports or requires the private product.

The public web floor is intentionally substantial: setup and health, agents and
sessions, conversations and requests, flights and work, activity, runtimes and
capabilities, projects, mesh and pairing, and settings should form a coherent
standalone operator experience. See the
[public-source boundary](./public-source-boundary.md) for current migration
status, target ownership, and release invariants.

## Next

- [Quickstart](./quickstart.md)
- [CLI guide](../packages/cli/README.md)
- [Runtime guide](../packages/runtime/README.md)
- [Protocol guide](../packages/protocol/README.md)
