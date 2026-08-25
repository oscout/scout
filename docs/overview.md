---
title: Overview
description: Scout's public architecture, ownership model, and repository boundary
order: 1
---

Scout is a local-first control plane for coding agents. It gives operators and
agents one broker-backed model for identity, routing, durable work, session
observation, and mesh reachability across harnesses such as Codex and Claude
Code.

Together, the local control plane and mesh network form a personal cloud agent
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

This repository is the public home of the Scout core. The complete OpenScout
applications and hosted services are developed in a private companion
workspace. Do not infer private product features, assets, credentials, or
release state from the public core.

Scout is currently for high-trust local developer pilots. It is not an
enterprise-ready, compliance-ready, or hardened untrusted multi-tenant system.

The public web package is the single canonical home for reusable primitives,
the application shell, and basic structural pages. The private product consumes
and extends those contracts with product-specific pages and services; it does
not keep a duplicate public subtree, and the public layer never imports or
assumes the private one. See the
[public-source boundary](./public-source-boundary.md) for the complete ownership
model and release invariants.

## Next

- [Quickstart](./quickstart.md)
- [CLI guide](../packages/cli/README.md)
- [Runtime guide](../packages/runtime/README.md)
- [Protocol guide](../packages/protocol/README.md)
