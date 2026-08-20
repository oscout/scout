# OpenCode product-V2 server adapter

This adapter is an explicit compatibility path for OpenCode's product V2 beta.
It does **not** replace either existing OpenCode integration:

| Adapter key | Product/protocol | Lifecycle | Current use |
| --- | --- | --- | --- |
| `opencode` | OpenCode V1 `/session` + `/event` | adapter-owned `opencode serve` | legacy Pairing configs |
| `opencode-acp` | ACP JSON-RPC over stdio | adapter-owned `opencode acp` | default broker OpenCode transport |
| `opencode-v2` | Product V2 `/api/*` + SSE | registered shared `opencode2` service | explicit Pairing/config use |

V2 is a breaking API, not an alternate spelling of V1. The implementation
therefore has a separate adapter identity, imports the official Promise client,
and isolates native event shapes in `normalizer.ts`. All three paths still emit
the same OpenScout `Session` / `Turn` / `Block` primitives.

## Lifecycle and authentication

By default the adapter:

1. calls the official `Service.discover()`;
2. calls `Service.ensure()` only when no healthy registration exists, passing
   `opencode2 serve --service` explicitly;
3. derives Basic auth from the service registration through
   `Service.headers()` and registers the sensitive values for Scout redaction;
4. creates a location-scoped session, or resumes exactly `options.sessionId`;
5. consumes the global `/api/event` SSE stream and filters every event by the
   exact native session id.

Before prompt admission the adapter verifies that the native session has no
active or pending work, assigns a branded V2 input id, correlates admission to
that id, and withholds all output until the matching `session.input.promoted`
edge. Promotion of another client's input fails the local turn instead of
attributing its events to Scout. Resume is persistent compatibility, not a
multi-writer session lock. Exact resume also performs a delayed second idle
check at attach time to reduce the managed-service restart-continuity race.

The service belongs to the user and may also serve a TUI or another client.
`shutdown()` cancels this adapter's exact pending input or interrupts its
matching promoted input, drains bounded cleanup, and closes its stream. If a
resumed/shared session cannot be reconciled non-destructively, shutdown emits
an explicit cleanup error instead of interrupting possibly foreign work. It
never calls `Service.stop()` or deletes the persistent OpenCode session.

An explicit server can be attached with `options.serverUrl` plus optional
`serverUsername` / `serverPassword`. Provider credentials remain OpenCode
configuration state; this adapter does not copy ACP's V1 provider-key bridge.

## Options

| Option | Meaning |
| --- | --- |
| `sessionId` | Exact native V2 session to resume. A cwd mismatch fails unless `allowCrossDirectoryResume` is true. |
| `serverUrl` | Attach to this server instead of registered-service discovery. |
| `serverUsername`, `serverPassword` | Optional Basic auth for an explicit server. |
| `serviceFile` | Override the official service registration path. |
| `autoStart` | Set false to discover only. Defaults to true. |
| `command` | Full command array, or a binary string combined with `args`. Defaults to resolved `opencode2 serve --service`. |
| `requiredVersion` | Health-gate the exact server version. Defaults to the pinned next-client build; it fails closed but never replaces a mismatched shared service. |
| `startupTimeoutMs` | Bounds adapter observation of discovery/startup, HTTP calls, and initial SSE connection (15s default). The official shared `Service.ensure()` has its own non-cancellable 120s convergence loop and may finish starting the service after this adapter attempt times out. |
| `reconnectDelayMs` | Delay between stream rediscovery/stabilization checks (1s default). |
| `model` | New-session model: `provider/model`, optionally with `#variant`; unqualified ids use provider `opencode`. Exact resume retains the native session's stored selection. |
| `agent`, `title` | New-session creation fields; exact resume retains stored native state. |

Prompts always use V2 `delivery: "queue"`. Native `steer` can merge an input
into another execution and does not have a faithful OpenScout turn boundary,
so it is intentionally not exposed by this adapter.

Text and reasoning use true V2 delta events. Tool input is accumulated until
`session.tool.called`; success/failure content becomes action output and native
file content becomes `FileBlock`. `session.step.ended` is an LLM step, not a
turn boundary. Only `session.execution.*` (with `session.idle` as a compatibility
fallback) ends a turn.

The server-global SSE stream has no replay cursor. On unexpected EOF, the
adapter fails any active normalized turn rather than pretending it completed,
rediscovers the registered service (including a new URL/password after a
restart), cancels only its own pending input, and observes idle/no-pending state
across repeated bounded checks before reconnecting. It may interrupt an
adapter-created session;
an explicitly resumed session is shared and is only waited/inspected, never
destructively interrupted during uncertain recovery. Originated input ids stay
quarantined across Stop, disconnect, and in-flight admission races; a late
matching promotion is interrupted, and no new prompt is admitted while the
adapter still has unresolved cleanup evidence. This is a conservative bounded
quarantine, not an upstream idempotency guarantee: the pinned beta server does
not retain a cancellation tombstone, so an already delayed prompt request can
theoretically re-admit the same id after cancellation. The adapter reduces that
window with server-response/admission evidence, SSE correlation, wait, and
repeated idle/pending checks, but cannot eliminate it client-side.
Likewise, a transport-ambiguous session-wide `/interrupt` stays fenced: the
adapter will not admit another prompt because that delayed control request
could otherwise stop the new execution. Shutdown reports the unresolved fence.

Generic `filesystem.changed` events are not attributed because they lack a session id;
session-scoped step/tool file events are used instead.

OpenCode product V2 is beta. The dependency is intentionally pinned to an exact
`@opencode-ai/client` next build, and the default health gate rejects a different
server build with an actionable error instead of silently falling back to V1 or
ACP.
