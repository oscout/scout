# OpenAI Codex App-Server Protocol Notes

This is a local adapter reference derived from the official OpenAI Codex app-server
docs and source, with emphasis on the parts that shape our adapter behavior.

Primary upstream references:

- Protocol overview:
  [codex-rs/app-server/README.md#protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#protocol)
- Shared client facade:
  [codex-rs/app-server-client/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-client/src/lib.rs)
- JSON-RPC wire envelopes:
  [codex-rs/app-server-protocol/src/jsonrpc_lite.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/jsonrpc_lite.rs)
- Protocol request/response registry:
  [codex-rs/app-server-protocol/src/protocol/common.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)
- Concrete v2 request/response shapes:
  [codex-rs/app-server-protocol/src/protocol/v2.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2.rs)

## Wire Model

- The protocol is bidirectional JSON-RPC over stdio by default.
- The wire omits the usual `"jsonrpc": "2.0"` field, but message semantics still
  follow JSON-RPC request, notification, response, and error envelopes.
- Stdio is newline-delimited JSON.

## Lifecycle Contract

The upstream lifecycle is explicit and ordered:

1. Open a transport connection.
2. Send `initialize`.
3. Send `initialized`.
4. Call `thread/start`, `thread/resume`, or `thread/fork`.
5. Call `turn/start` or `turn/steer`.
6. Keep consuming notifications until `turn/completed`.

Implication for our adapter:

- We should treat the connection as long-lived and stateful.
- We should not fake a stateless request/response wrapper around turns.

## Core Primitives

- `Thread`: long-lived conversation container.
- `Turn`: one user-to-agent interaction inside a thread.
- `Item`: streamed turn content and side effects, including messages, reasoning,
  command execution, file changes, and dynamic tool calls.

Implication for our adapter:

- Thread and turn identifiers are protocol state, not just metadata.
- Item deltas and completion events are part of the durable contract.

## Server Requests Are Part of the Contract

Upstream `app-server-client` models server-to-client requests as first-class events.
The client is expected to eventually answer each request with either:

- `resolve_server_request(request_id, result)`
- `reject_server_request(request_id, error)`

Implication for our adapter:

- Receiving a server request is not optional bookkeeping.
- Ignoring a request, or replying with a malformed JSON-RPC error envelope, can
  wedge the active turn.

## JSON-RPC Error Shape Matters

`JSONRPCErrorError` in upstream protocol source includes:

- `code: i64`
- `message: String`
- optional `data`

Implication for our adapter:

- If we reject a server request, we must send a valid JSON-RPC error object with
  a numeric `code`.
- Sending only `error.message` is not protocol-correct.

## Notifications and Backpressure

Upstream distinguishes between:

- lossy or best-effort notifications
- lossless notifications that must be delivered, such as transcript deltas and
  authoritative completion events

The shared client also carries an explicit `Lagged` event when consumers fall behind.

Implication for our adapter:

- We should preserve message deltas and completion signals as the highest-value
  events in the stream.
- If we cannot service a server request, we should reject it explicitly rather
  than let it hang behind queue pressure.

## Dynamic Tool Calls

The official protocol includes experimental dynamic tool call requests. These are
normal server requests carrying:

- `threadId`
- `turnId`
- `callId`
- `tool`
- `arguments`

Implication for our adapter:

- Desktop-origin threads may advertise tools that our headless adapter does not
  actually implement.
- Unsupported dynamic tools should be rejected cleanly and explicitly.
- Full parity requires implementing the tool, not just tolerating the request.

## Practical Rules For Our Adapter

- Always consume notifications while a turn is active.
- Always answer server requests with a protocol-valid resolve or reject.
- Keep thread lifecycle state in the adapter, not in the caller.
- Treat upstream source as the contract source of truth when local behavior is unclear.
