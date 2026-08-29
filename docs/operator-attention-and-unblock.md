# Operator Attention And Unblock

OpenScout should treat "needs the human" as a first-class product state, not as a side effect of whichever harness happened to print the prompt.

This doc records the current posture and the next implementation steps for approvals, questions, waiting states, permission prompts, and notifications.

## Principle

Scout can only own data that enters Scout. Session events, broker messages, collaboration records, and Scout-created invocation state are first-party data. Native harness prompts that happen above Scout, such as an MCP client asking whether to allow a tool call, are not visible until the host forwards them or exposes a hook.

The operator-attention model should make that boundary explicit:

- Project attention from first-party session state when Scout already sees the event.
- Ingest host-level permission prompts through a host integration, not by pretending the MCP server can see a request that the host intercepted before the server was called.
- Record durable broker unblock requests for anything that can outlive a single session frame.
- Route notifications from the broker/session attention model, with dedupe and clear ownership.

## Agent-Originated Non-Blocking Signals

Long-running agents also need a way to communicate without manufacturing a
block. Scout exposes two MCP tools for that attention-plane traffic:

- `notify_operator({ message })`: a useful one-way FYI. The agent continues and
  does not request a response.
- `consult_operator({ question, defaultAction })`: optional advice. The agent
  continues with the declared default unless the operator replies soon enough
  to influence later work.

Both are broker-backed durable messages to the operator. The broker message id
is also the signal id, so ordinary threaded replies provide correlation without
creating a second consultation state machine. Neither tool creates a flight,
changes a work item, or marks the agent waiting. The tool confirms when that
message is recorded; mobile or desktop notification delivery remains
best-effort and unconfirmed at call time.

The boundary is strict: if there is no responsible default, the agent must use
a real human-input or waiting path. Only `needs_input` may block. A late reply
to a non-blocking consultation is steering; it does not retroactively change
the task lifecycle.

## Alertable Events

Session attention already covers:

- `approval`: an action block is awaiting approval and can be approved or denied.
- `question`: an agent question is awaiting an answer.
- `failed_action`: a recent action failed.
- `failed_turn`: a recent turn failed.
- `session_error`: the session itself is in error.
- `native_attention`: adapter/provider metadata says the native harness needs input.

Broker and collaboration attention should cover:

- `question.open`: an answer is owed.
- `question.answered`: the asker needs to close or reopen.
- `work_item.waiting`: a named dependency or actor owns the next move.
- `work_item.review`: a reviewer owes accept/reopen feedback.
- `flight.failed` / `flight.cancelled`: an ask did not complete.
- `flight.completed`: notify only when the caller requested callback semantics.

Host-level unblock attention still needs explicit ingress:

- Codex approval prompts raised by the Codex host.
- Claude permission prompts raised by the Claude host or companion integration.
- MCP client pre-tool permission prompts.
- Local system permissions needed by Scout itself, such as notifications or APNs setup.

## Current Coverage

Implemented now:

- Runtime session attention projection exists in `packages/runtime/src/session-attention.ts`.
- Protocol and runtime support broker-owned durable `unblock_request` records
  and unblock request events.
- Mobile bridge inbox now uses session attention instead of approvals only.
- Bridge websocket now emits `operator:notify` for any projected session attention item.
- APNs alert routing now sends inbox alerts for any projected item.
- iOS Inbox can decode and display approvals, questions, failures, session errors, and native attention.
- Approval actions remain approve/deny.
- Non-approval attention items provide `Open Session` and local `Dismiss`, following the no-dead-end UI rule in `docs/eng/no-dead-end-ui.md`.
- The iOS tRPC route map includes `question/answer`, so timeline question blocks can use the existing answer-question bridge path.
- Scout MCP `ask` supports `replyMode: "notify"` and emits `notifications/scout/reply`.
- Scout MCP exposes `notify_operator` and `consult_operator`; the latter
  requires a safe default. Both write operator messages without creating a
  flight, and the broker can fan out a generic APNs alert without putting agent
  content in the push payload. The relay preserves opaque conversation/message
  correlation and keeps these non-blocking alerts quiet.
- Web operator attention reads active broker unblock requests.
- Managed Claude sessions rely on host or companion permission capture; Scout
  does not install Claude project hooks.
- Active managed Claude tmux sessions project a currently visible permission
  confirmation from the pane into web agent and operator attention. This is a
  live host projection, not a durable broker record.

Not done yet:

- Answering `question` items from the iOS Inbox.
- Host-level capture beyond the managed Claude tmux permission-confirmation
  path, including Codex, non-tmux Claude, and MCP permission prompts.
- Desktop/web notification sinks for operator attention.
- Cross-device read/dismiss/decision synchronization beyond the current inbox item refresh. Current non-approval dismiss is intentionally local-only.
- Dedicated desktop/web signal presentation, coalescing, and per-agent signal
  policy beyond the existing push-relay rate limits.

## Practical Recovery Guidance

When an operator prompt appears stuck, first classify where the prompt lives:

- Scout-owned session question or action approval: answer or decide it through
  the Scout surface that rendered it.
- Broker unblock request: use the rendered action, or inspect the request by id
  before dismissing it.
- Host-side approval prompt: open the host UI or rely on a host integration that
  forwards the prompt into Scout. An MCP server cannot observe a prompt the host
  intercepted before the tool call reached the server.
- Long-running agent work: mark the work item or flight waiting with the human
  or dependency as next owner instead of leaving the caller blocked.

## Durable Unblock Model

Scout uses broker-owned unblock records for human actions that may outlive a
single websocket frame.

Fields include:

- `id`
- `source`: `session`, `broker`, `host`, or `system`
- `kind`: `approval`, `question`, `permission`, `waiting`, `review`, `failure`, or `setup`
- `status`: `open`, `notified`, `resolved`, `denied`, `expired`, or `dismissed`
- `ownerId`: usually `operator`
- `sourceRef`: session/turn/block, flight, work item, or host request ids
- `title`, `summary`, `detail`
- `risk`
- `actions`: typed action affordances such as approve, deny, answer, open, retry, or dismiss
- `createdAt`, `updatedAt`, `resolvedAt`

The session inbox can continue projecting lightweight items, but durable host and broker waits should be represented by this record so a reconnect, another device, or a later agent can reason about what is still open.

## Implementation Path

1. Keep session attention as the fast path for first-party pairing events.
2. Expand broker attention/unblock projection from collaboration records and flights.
3. Expand host ingress for permission prompts:
   - Codex: surface host approval requests into Scout as unblock records.
   - Claude: use a host integration that forwards permission prompts without a
     project-wide pre-tool gate.
   - MCP: document that server-side tools cannot see client-side approval prompts unless the host forwards them.
4. Route all unblock records through a notification router:
   - `interrupt`: approval, question, host permission, failure.
   - `badge`: requested completion callbacks, review-needed, waiting states.
   - `silent`: ordinary progress/status.
5. Add action handling:
   - approvals call existing `actionDecide`.
   - questions call existing answer-question plumbing, with Inbox needing structured options before it can answer in-place.
   - host permissions call host-specific grant/deny callbacks.
   - work/review items call collaboration update APIs.
6. Add stale sweeps for `waiting`, `review`, and unresolved host permissions.
