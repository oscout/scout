# Scout MCP API Posture

Status: current v0 product guidance. This is not a frozen public API contract.

Scout's MCP surface should feel like one broker API, not a pile of internal
record constructors. Agents should be able to ask for work, send updates, and
reply durably without understanding cards, sessions, invocations, or delivery
planning first.

## Core Agent API

These are the tools normal agents should learn first:

| Tool | Purpose |
| --- | --- |
| `whoami` | Identify the current broker actor and working-directory context. |
| `ask` | Request work, investigation, review, or a reply. This is the only work-creation front door. |
| `messages_send` | Send a durable tell/update when no owned work or reply is expected. |
| `messages_reply` | Send a normal threaded reply in an existing Scout reply context. |
| `work_update` | Update progress, waiting, review, done, or cancellation for an existing work item. |
| `notify_operator` | Give the human operator a useful FYI without pausing or creating lifecycle. |
| `consult_operator` | Ask for optional advice, declare the safe default, and keep working. |

`ask` may create message, invocation, flight, delivery, card, session, and work
records as side effects. Those records are broker-owned implementation details
unless the caller is explicitly observing or managing them.

Timeout-style fields on MCP tools are caller wait budgets only. They protect a
tool call or host connection from staying open indefinitely; they do not cancel
broker work, mark a flight failed, or define protocol completion.

## Non-Blocking Operator Signals

`notify_operator` and `consult_operator` are agent-to-operator communication,
not task state.

- `notify_operator` is a one-way FYI. No reply is requested.
- `consult_operator` requests optional advice and requires `defaultAction`.
  The agent continues with that default unless a reply arrives in time to steer
  later work.
- Neither tool creates an invocation, flight, question, waiting state, or work
  transition.
- The broker writes a durable operator message and uses its `messageId` as the
  signal correlation id. A reply stays in that conversation and points back to
  the signal message.
- The wire contract is discriminated: notify declares no reply expectation;
  consult declares an optional reply expectation and a nonblank default action.
- `status: "recorded"` confirms only the durable broker write. Push or other
  notification delivery is best-effort and reported as unconfirmed.
- A late reply is steering input. It does not retroactively rewrite work state.

If an agent cannot responsibly continue, these tools are the wrong mechanism.
That dependency belongs in the existing blocking human-input, approval,
question, or `work_item.waiting` path. Only a real `needs_input` condition may
hand the next move to the operator.

The tool names are deliberately namespaced. Bare `notify` already describes
delivery and MCP reply modes inside Scout, while bare `consult` already names
the tracked `ask` delivery intent.

When the caller knows the project but not the concrete agent, use
`ask({ projectPath })`; add `harness` when the desired capability matters. The
broker resolves or creates the concrete worker for that project. Do not make
the caller run discovery just to invent a target, and do not train agents to
guess generic names such as `claude.main`.

MCP receipts should make follow-up cheap: return durable ids such as
`flightId`, `conversationId`, `messageId`, `workId`, `targetSessionId`/`sessionId`,
and any short `ref` or broker-suggested situated target handle the server can
provide. Humans type saved targets as `target:<name>`; agents and compact UI may
render the same handle as `⌖name`. Follow-up uses those handles; naming/pinning
is an explicit later promotion.

`messages_reply` is the threaded-message form of `messages_send`. It should
preserve the ask conversation instead of creating a fresh ask. Quiet or
send-without-notification behavior belongs as an optional message modifier or
agent/session policy, not as a separate reply primitive. Use `ask` only when
there is a new request or ownership lifecycle.

Implementation target: reply delivery should route through the same broker
delivery planner as normal messages so threaded replies can notify or wake
according to target policy. A direct message write that only records history is
too quiet for actionable follow-ups.

## Quiet Delivery

Message and reply quieting should be a shared optional delivery modifier, not a
separate message kind and not a different reply primitive. Quiet delivery still
writes the durable conversation record, but suppresses notify/wake side effects
where the target policy permits it. `ask` should not have a quiet variant:
asking creates a lifecycle.

## Observation Handlers

These tools observe records created by `ask`; they do not create work:

| Tool | Purpose |
| --- | --- |
| `invocations_get` | Fetch the current state for a known ask flight. |
| `invocations_wait` | Wait briefly for a known ask flight to change or finish. |
| `broker_feed` | Inspect broker-native messages, delivery, dispatch, unblock, and error records. |
| `tail_events` | Inspect recent observed harness activity without making transcripts Scout-owned messages. |

`invocations_ask` is not an agent-facing front door. An ask creates invocations
as a side effect; invocation records then have observation handlers.

## Routing Helpers

Routing helpers are optional. They are useful when the broker reports ambiguity
or when a user is inspecting available agents, but they are not mandatory
preflight steps:

| Tool | Purpose |
| --- | --- |
| `agents_search` | Search likely targets for a human or advanced integration. |
| `agents_resolve` | Resolve one ambiguous label into one concrete target. |

Prefer direct `ask`, `messages_send`, or `messages_reply` calls with explicit
fields. Message body text remains payload, not routing metadata.

## Pro Integration API

Some agents and host integrations know Scout deeply enough to manage identity
and runtime infrastructure directly. These tools belong to that pro integration
layer:

| Tool | Purpose |
| --- | --- |
| `card_create` | Create a reply-ready identity/return-address record. |
| `agents_start` | Start or create a concrete local agent session. |
| `session_attach_current` | Attach the current host session to Scout. |
| `aliases_set` / `aliases_repoint` / `aliases_unset` | Manage one scoped mutable route pointer without creating or mutating a card. |
| `aliases_list` / `aliases_resolve` | Inspect alias binding/revision and target availability without dispatch. |

These are real and useful tools, but they should not be the default way to talk
to another agent. Core agents should use `ask({ projectPath, harness })` for
capability requests and let the broker create or bind cards and sessions when
needed. Pro tools are for deliberate promotion, pinning, or lifecycle
management after the routed worker is known good.

`ask` and `messages_send` accept `alias:<name>` or a structured `route_alias`
target directly; callers do not preflight every dispatch with
`aliases_resolve`. The broker dereferences once and returns the pinned binding
revision/canonical target proof.

## Identity Model

The base agent identity is the vanilla project/workspace identity. Harness,
model, profile, node, and session details are constraints on a concrete
instance of that identity.

Specialized profiles may become more important over time, such as a project
agent with an investigator profile and a dedicated tool set. That is an
advanced specialization layered onto the base project identity, not the normal
routing path.
