# Contributing to Scout

Scout is a local-first control plane with a deliberately small coordination
model. Contributions are welcome when they preserve that model and arrive with
evidence proportionate to their risk.

## Before you start

- Search existing issues and pull requests before opening a new lane.
- Use an issue for a substantial behavior change or public protocol decision.
- Do not file security vulnerabilities publicly; follow [SECURITY.md](./SECURITY.md).
- Keep private OpenScout product code, assets, credentials, and internal release
  material out of this public repository.

## Set up the repository

```bash
git clone https://github.com/oscout/scout.git
cd scout
bun install
```

Useful verification commands:

```bash
bun run sync-exec:fence
bun run --cwd packages/protocol check
bun run --cwd packages/runtime check
bun run --cwd apps/desktop check
```

Run the narrowest relevant tests while iterating. Use `bun run check` and
`bun run test:unit` before handing off a broad cross-package change.

## Architecture guardrails

- The broker is the canonical writer for Scout-owned records.
- Harness transcripts are observed source material, not canonical Scout
  messages.
- One target is a DM; group coordination requires an explicit channel;
  broadcast is opt-in.
- Use `send` for tells and updates. Use `ask` for work that requires a reply,
  investigation, judgment, or ownership.
- Mesh means reachability and coordination, not exactly-once delivery, global
  consensus, or transcript replication.
- Do not claim enterprise, compliance, or hardened multi-tenant readiness.

## Code and commits

- Prefer TypeScript for new JavaScript-side logic and Bun for tooling.
- Add or update focused tests for behavior changes.
- Run `bun run sync-exec:fence` for any new or changed process execution.
- Use a concise gitmoji commit subject, for example `🐛 Fix session route
  resolution` or `📝 Clarify broker ownership`.
- Do not add AI-generated attribution or co-author footers.

## Pull requests

A good pull request explains:

1. the user-visible or system outcome;
2. why the change belongs in the public Scout core;
3. the relevant architecture boundary;
4. exact verification commands and results;
5. limitations, migration notes, or follow-up work.

Keep generated files, caches, local state, private product material, and
unrelated workspace changes out of the patch.

