# OpenScout Agent Sessions

`@openscout/agent-sessions` is the shared session substrate for OpenScout. It normalizes live harness sessions — Claude Code, Codex, pi, Grok ACP, Kimi Code ACP, OpenCode, OpenAI-compatible processes, and any ACP stdio agent — into one small stream of session events, snapshots, approvals, topology hints, and replayable state that the runtime and surfaces can consume.

This package observes harness-owned material. It does not turn Claude Code, Codex, pi, or future harness transcripts into first-party Scout conversation messages. Durable coordination records belong in the broker and runtime; adapter state here is the bridge between a concrete harness session and Scout's control plane.

## Quickstart

Register the adapters you want to observe, then drive a session through a `SessionRegistry`. Every adapter — regardless of backend — emits the same event vocabulary (`turn:start`, `block:*`, `block:action:approval`, `turn:end`) and tracks a replayable snapshot you can read at any point.

The `echo` adapter is a built-in test harness that streams a full turn — reasoning, text, and a tool call — so you can wire up a consumer without a live harness. Here it also asks for an approval, which we grant through the registry:

```ts
import { SessionRegistry } from "@openscout/agent-sessions";
import { createAdapter as createEchoAdapter } from "@openscout/agent-sessions/adapters/echo";

const registry = new SessionRegistry({
  adapters: { echo: createEchoAdapter },
});

// One normalized event stream for every session in the registry.
registry.onEvent(({ event }) => {
  // An action paused for a human decision. Approve it — off the broadcast loop,
  // so the awaiting turn can resume.
  if (event.event === "block:action:approval") {
    queueMicrotask(() =>
      registry.decide({
        sessionId: event.sessionId,
        turnId: event.turnId,
        blockId: event.blockId,
        version: event.approval.version,
        decision: "approve",
      }),
    );
  }
});

const session = await registry.createSession("echo", {
  name: "echo demo",
  options: { requireApproval: true },
});

// Drive one turn and wait for it to reach a terminal state.
await new Promise<void>((resolve) => {
  const stop = registry.onEvent(({ event }) => {
    if (event.event === "turn:end") {
      stop();
      resolve();
    }
  });
  registry.send({ sessionId: session.id, text: "ship it" });
});

// Read the replayable snapshot — turns, blocks, and their text.
const snapshot = registry.getSessionSnapshot(session.id);
const reply = snapshot?.turns
  .at(-1)
  ?.blocks.map(({ block }) => (block.type === "text" ? block.text : ""))
  .join("");

reply; // "Echo: ship it"

await registry.shutdown();
```

> `registry.decide()` resolves the adapter's pending approval. Call it *outside*
> the `onEvent` broadcast loop (as above, via `queueMicrotask`) — deciding
> synchronously while an approval event is still being broadcast can stall the
> turn that is awaiting it.

### Browser-safe trace consumers

Web and mobile surfaces should import from `@openscout/agent-sessions/client`. This surface is intentionally narrower than the package root: it exposes only the browser-safe protocol, snapshot, event, and approval helper types, with no registry, adapter, or Node/Bun process code. A trace consumer can render a snapshot and pending approvals without pulling in any harness spawning:

```ts
import {
  extractPendingApprovalRequests,
  inferModelContextWindowTokens,
  type SessionState,
  type AgentSessionStreamEvent,
  type NormalizedApprovalRequest,
} from "@openscout/agent-sessions/client";

// Pull actions awaiting a decision straight from a snapshot.
function pendingApprovals(snapshot: SessionState): NormalizedApprovalRequest[] {
  return extractPendingApprovalRequests(snapshot);
}

// Fold a streamed event into your view state.
function reduce(event: AgentSessionStreamEvent): string {
  return event.event; // discriminated union — narrow on `event.event`
}

inferModelContextWindowTokens("claude-sonnet-4-20250514"); // 200000
```

### One-shot local turns

`@openscout/agent-sessions/local` runs a single turn against a local harness with no broker records and no runtime imports. `completeLocalAgentTurn` opens a lazy session, runs one turn, and closes it — returning the text, resolved harness, transport, session identity, and any usage the harness reported:

```ts
import { completeLocalAgentTurn } from "@openscout/agent-sessions/local";

// Illustrative: this call requires a live local harness (codex / pi / grok / kimi) on
// the host. The shape is exact; the result depends on your installed harness.
const result = await completeLocalAgentTurn({
  harness: "codex",
  cwd: process.cwd(),
  input: "Summarize the repository layout in two sentences.",
  model: "gpt-5-codex",
});

result.text;         // the harness's reply
result.harness;      // "codex"
result.session.id;   // stable session id for this turn
result.usage;        // token usage, when the harness reports it
```

For a warm, multi-turn client that reuses one local session, use `createLocalAgentClient` from the same surface.

### Bounded task tails

Server-side consumers that only need recent conversational content should use
`readTaskTail` instead of loading a complete harness history. The first adapter
supports Codex rollout JSONL. It performs bounded tail reads, returns only
normalized user and final-assistant messages, and issues an opaque cursor for
subsequent forward reads:

```ts
import { readTaskTail, TaskTailError } from "@openscout/agent-sessions";

const initial = readTaskTail({
  path: rolloutPath, // already validated against the owning Codex task
  adapterType: "codex",
  expectedTaskId: threadId,
  maxMessages: 20,
  maxBytes: 256 * 1024,
  maxScanBytes: 32 * 1024 * 1024,
});

const next = readTaskTail({
  path: rolloutPath,
  adapterType: "codex",
  expectedTaskId: threadId,
  cursor: initial.cursor,
});

initial.messages;          // chronological user/final-assistant messages
initial.source.bytesRead;  // bounded transcript bytes actually read
next.messages;             // only messages completed after the first cursor
```

`maxMessages` defaults to 20 and is capped at 100. `maxBytes` defaults to
256 KiB and is capped at 2 MiB; it bounds normalized message text.
`maxScanBytes` defaults to 32 MiB and is capped at 64 MiB; the initial reader
starts with a small tail window and expands backward only until it has enough
messages. Forward reads use the same hard scan bound and can safely advance
across oversized non-message records. A clipped message carries
`truncated: true`, and the result-level
`truncated` flag also reports unread history or limits. Cursors are versioned
and bind the adapter, task id, file identity, byte offset, adjacent turn, and a
small deduplication window. Rotation, truncation, task mismatch, corrupt
cursors, invalid offsets, and oversized limits fail closed with a typed
`TaskTailError` and `code`.

This reader is deliberately read-only. It does not prove current Codex Desktop
ownership and cannot submit, steer, resume, or create a task. Establish and
validate the owner-provided rollout path first, persist only the opaque cursor
and small presentation state, and keep canonical turn dispatch on the owning
harness channel. Claude Code will use the same public contract when its tail
adapter is added.

## Subpath Exports

| Import | Purpose |
| --- | --- |
| `@openscout/agent-sessions` | Root surface: `SessionRegistry`, `StateTracker`, protocol primitives, adapter factories, history snapshots, bounded task tails, budget/cost observations, and Codex launch helpers. |
| `@openscout/agent-sessions/client` | Browser-safe boundary — snapshot, event, and approval types plus `inferModelContextWindowTokens`, with no registry or adapter code. |
| `@openscout/agent-sessions/local` | Broker-free local turns: `completeLocalAgentTurn`, `createLocalAgentClient`, the Codex app-server transport, and ACP transports. |
| `@openscout/agent-sessions/adapters/acp` | ACP stdio agent adapter (`createAcpAdapter`). |
| `@openscout/agent-sessions/adapters/claude-code` | Claude Code adapter (`createClaudeCodeAdapter`). |
| `@openscout/agent-sessions/adapters/claude-code/team-topology` | Read observed Claude Code team topology (`readClaudeAgentTeamTopology`). |
| `@openscout/agent-sessions/adapters/claude-code/workflow-topology` | Read observed Claude Code workflow topology (`readClaudeWorkflowTopology`). |
| `@openscout/agent-sessions/adapters/codex` | Codex adapter (`createCodexAdapter`). |
| `@openscout/agent-sessions/adapters/codex/topology` | Observed Codex topology tracker (`CodexObservedTopologyTracker`). |
| `@openscout/agent-sessions/adapters/echo` | Echo test harness that streams a full turn (`createEchoAdapter`). |
| `@openscout/agent-sessions/adapters/grok-acp` | Grok ACP adapter (`createGrokAcpAdapter`). |
| `@openscout/agent-sessions/adapters/kimi-acp` | Kimi Code ACP adapter (`createKimiAcpAdapter`). |
| `@openscout/agent-sessions/adapters/openai-compat` | OpenAI-compatible chat/completions adapter (`createOpenAiCompatAdapter`). |
| `@openscout/agent-sessions/adapters/opencode` | Legacy OpenCode V1 server adapter (`createOpencodeAdapter`). |
| `@openscout/agent-sessions/adapters/opencode-v2` | OpenCode product-V2 shared-server adapter (`createOpencodeV2Adapter`). |
| `@openscout/agent-sessions/adapters/pi` | pi adapter (`createPiAdapter`). |
| `@openscout/agent-sessions/codex-executable` | Resolve the Codex executable and inventory candidates on the host. |
| `@openscout/agent-sessions/protocol/primitives` | The pure protocol vocabulary: `Session`, `Turn`, `Block`, `Action`, `Delta`, `AgentSessionStreamEvent`, and the observed-topology types. |

## Runtime Support

The runtime split is browser versus server. Browser imports must stay on the
pure protocol/client surfaces. Server imports run on both Node and Bun.

| Surface | Browser | Server (Node/Bun) |
| --- | :---: | :---: |
| `./client`, `./protocol/primitives` | ✅ | ✅ |
| Root observability / history / budget helpers | — | ✅ |
| `./local` (codex, grok, kimi, opencode ACP, pi) | — | ✅ |
| `./codex-executable` | — | ✅ |
| `adapters/acp` | — | ✅ |
| `adapters/codex` (observe/topology/usage) | — | ✅ |
| `adapters/grok-acp` | — | ✅ |
| `adapters/kimi-acp` | — | ✅ |
| `adapters/openai-compat` (pure `fetch`) | — | ✅ |
| `adapters/echo` | — | ✅ |
| `adapters/claude-code` | — | ✅ |
| `adapters/opencode` | — | ✅ |
| `adapters/opencode-v2` | — | ✅ |
| `adapters/pi` | — | ✅ |

The pure protocol and `./client` surfaces are browser-safe: no process
spawning, no Node built-ins. Server-side surfaces use standard Web APIs,
plain `fetch`, or runtime-native process spawning for harness processes.
Claude Code, legacy OpenCode V1, and pi use `Bun.spawn` when running under Bun and fall
back to `node:child_process` under Node. Existing ACP, Grok ACP, Kimi Code ACP, and Codex
app-server transports use the Node child-process API, which is available in
both runtimes. OpenCode V2 uses the official HTTP/SSE client and its registered
shared service; adapter shutdown disconnects but never stops that user-owned
service.

## Important Boundaries

- Adapter code may inspect harness transcripts, topology, logs, and process signals, but must not bulk-import external turns as Scout `message` records.
- Browser-facing imports should come from `@openscout/agent-sessions/client` unless registry or adapter code is explicitly needed.
- Adapter behavior should fail with actionable diagnostics when a harness, executable, cwd, or session is unavailable.
- Observed harness topology (`ObservedHarnessTopology`, attached to `Session.providerMeta`) is read-only. It explains what a harness is doing; Scout must not mutate the upstream files or runtime state that produced it.

## Local Commands

From the repo root:

```bash
bun run --cwd packages/agent-sessions test
bun run --cwd packages/agent-sessions check
bun run --cwd packages/agent-sessions build
bun run --cwd packages/agent-sessions adapter:validate-specs
bun run --cwd packages/agent-sessions adapter:conformance
```

## Install

`@openscout/agent-sessions` is published on npm; the latest published release is `0.2.64`. The package is being restored and expanded to the current workspace line, so if you need a subpath or symbol that is newer than the published release, consume it from the workspace until the next publish lands. Do not pin to a version that is not yet on npm.

## Read Next

- [Data model](../../docs/architecture.md#the-data-model) for the Scout-owned versus harness-owned boundary.
- [Agent integration contract](../../docs/agent-integration-contract.md) for adapter expectations.
- [Architecture](../../docs/architecture.md) for how sessions connect to the broker and runtime.
