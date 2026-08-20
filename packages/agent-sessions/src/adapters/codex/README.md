# Codex Adapter Support Files

This directory holds the Codex adapter implementation and its local support
material. The runnable adapter entrypoint is [adapter.ts](./adapter.ts).

## Tooling

Protocol extractor:

- Tool: [tools/extract-rust-protocol-spec.mjs](./tools/extract-rust-protocol-spec.mjs)
- Package script: `npm --prefix packages/agent-sessions run codex:extract-protocol -- <path-to-rust-file>`

Examples:

```bash
npm --prefix packages/agent-sessions run codex:extract-protocol -- \
  /tmp/openai-codex/codex-rs/app-server-client/src/lib.rs
```

```bash
npm --prefix packages/agent-sessions run codex:extract-protocol -- \
  /tmp/openai-codex/codex-rs/app-server-protocol/src/jsonrpc_lite.rs \
  --json
```

The extractor is intentionally heuristic, not a Rust compiler frontend. It is
meant to turn upstream protocol-facing Rust files into a concise local spec:

- module docs
- public types
- public functions
- impl methods
- protocol imports
- inferred responsibilities

## Formal Spec

- [adapter.spec.json](./adapter.spec.json)

This JSON file is the canonical local adapter contract. The extractor output and
reference notes are evidence and inputs for maintaining that spec.

## References

See [references/openai-codex-app-server-protocol.md](./references/openai-codex-app-server-protocol.md)
for the upstream app-server protocol notes that matter to this adapter.
