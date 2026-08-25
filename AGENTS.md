# Scout

> One local control plane for every coding agent you run.

## Critical Context

**IMPORTANT:** Read these rules before making any changes:

- Use Bun for JavaScript and TypeScript workflows.
- The broker is the canonical writer for Scout-owned coordination records.
- External harness transcripts are observed source material; never bulk-import them as Scout messages.
- One explicit target is a DM; group coordination requires an explicit channel; broadcast is opt-in.
- Use scout send for tells and scout ask for requested work or replies.
- Mesh means reachability and coordination, not exactly-once delivery or global consensus.
- Scout is for high-trust local developer pilots; do not claim enterprise or compliance readiness.
- Use gitmoji commit subjects and never add AI co-authoring footers.

## Quick Navigation

- Working with **packages/protocol/****? → Run bun run --cwd packages/protocol check.
- Working with **packages/runtime/****? → Run bun run --cwd packages/runtime check and the narrow affected tests.
- Working with **apps/desktop/****? → Run bun run --cwd apps/desktop check.
- Working with **process spawning or shell execution**? → Run bun run sync-exec:fence before committing shell-execution changes.

## Overview

> Scout's public architecture, ownership model, and repository boundary

Scout is a local-first control plane for coding agents. It gives operators and
agents one broker-backed model for identity, routing, durable work, session
observation, and mesh reachability across harnesses such as Codex and Claude
Code.

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

## Quickstart

> Install Scout, verify readiness, and route the first task

This path installs the public `scout` command, initializes its machine-local
state, and routes one real request through the broker.

## Prerequisites

- Bun 1.3 or newer;
- macOS or Linux;
- at least one supported coding-agent harness if you want Scout to launch or
  route work.

Install Bun from [bun.sh](https://bun.sh) if `bun --version` is unavailable.

## Installation

```bash
bun add -g @openscout/scout
scout --version
```

Installing the package does not silently start services. Initialize the local
control plane explicitly:

```bash
scout setup
scout doctor
```

## Orient

From a project directory:

```bash
scout whoami
scout who
scout runtimes
```

`whoami` shows the sender identity Scout inferred from the current project and
harness. `who` shows known targets. `runtimes` lists legal harness/model/effort
combinations for exact execution requests.

## Route the first task

Let Scout resolve or start a Codex session for the current project:

```bash
scout ask --project . --harness codex \
  "Inspect this repository and report the narrowest useful verification command."
```

Use `scout send --to <target>` for a tell or update where no reply is expected.
Use `scout ask` when the target should investigate, act, judge, or report back.

## Next Steps

- Read the [CLI guide](../packages/cli/README.md) for routing, profiles,
  sessions, aliases, channels, and file-backed prompts.
- Read the [overview](./overview.md) for the broker ownership and public/private
  repository boundaries.
- Run `scout doctor --fix` when the native daemon exposes a conservative repair
  for a reported readiness issue.

---
Generated by [Dewey](https://github.com/arach/dewey) | Last updated: 2026-08-25