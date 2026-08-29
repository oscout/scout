# Agent Integration Contract

This page is for coding agents, agent runtimes, and adapter authors that want to plug into OpenScout without first learning the whole product.

OpenScout is a local-first broker. The integration contract is simple: identify yourself, register how you can be reached, send messages and invocations through the broker, and report enough lifecycle state that humans and other agents can understand what is happening.

Status: v0 integration guidance. This is the contract OpenScout is intentionally converging on for local developer pilots, not a frozen public API or enterprise compatibility guarantee. Treat changes to these semantics as product-significant and update this page when they move.

## Integration Goals

A good Scout integration should let an agent:

- have a stable address
- receive a durable message with a broker receipt
- receive an invocation/work handoff with a lifecycle handle
- reply in the same conversation
- expose current status and reachability
- expose or attach a concrete harness session
- report work lifecycle state through flights or collaboration records
- ask the human for input without trapping the request inside one harness UI
- receive broker-authored guidance when routing or runtime state is incomplete,
  instead of having to rediscover topology manually

## Host Integration Vs Harness

Scout compatibility starts at the host integration layer. A host integration is
any first-class bridge to another agent tool, IDE, terminal host, or
agent-state surface. It can expose Scout commands, connect to `scout mcp`,
report lifecycle state, forward approvals, focus or control sessions, or host a
plugin that talks to the broker.

A harness is narrower: it is only the execution backend for a Scout session.
Populate `harness`, endpoint harness metadata, or CLI `--harness` values only
when Scout can actually route work into that runtime as an execution target.
Hermes and Herdr should be represented as host integrations, not harnesses:
Hermes is an agent/MCP host, and Herdr is a terminal host plus agent-state
surface. If a future adapter makes either one an execution backend, add that
explicitly instead of relying on the host name.

## Minimum Contract

At minimum, an integration needs five pieces.

### 1. Identity

The agent needs a stable Scout identity. Human-facing text usually uses a short handle such as `@hudson`, but the broker resolves that to one exact target.

Do not overload `@` handles for saved situations. `@missionwriter` should name a
role or definition; a saved profile/project/harness situation should be exposed
as `target:<name>` for humans and may render as `⌖name` in compact agent/UI
text.

Use the [agent identity section of `architecture.md`](./architecture.md#agent-identity-and-addressing) for the full grammar. The important fields are:

- `definitionId`: the base agent/project name
- `workspaceQualifier`: branch, worktree, or project variant when needed
- `harness`: Codex, Claude, or another backend
- `model`: model family or concrete model when relevant
- `node`: machine or broker authority

### 2. Reachable Endpoint

The broker needs to know how to reach the agent. A reachable endpoint records:

- agent id
- authority node
- harness
- transport
- session reference
- current reachability/status
- optional permission profile and wake policy

The endpoint is a route, not the agent's personality. An agent can move between
sessions or machines while retaining a stable identity.

Endpoint state should describe the attachment, not a specific task. Use states
such as `registered`, `attaching`, `waking`, `idle`, `working`, `unreachable`,
`failed`, `superseded`, and `stopped`; keep task lifecycle in flights or work
items. `superseded` is diagnostic runtime state for endpoint rows replaced by a
newer route, not a durable card state. If several endpoints match, the broker
should choose the preferred compatible endpoint or return an ambiguity
diagnostic with candidates.

### 3. Runtime Session

A session is a concrete harness conversation/process/thread that can receive
work. Use **session** as the public noun across CLI, MCP, docs, and skills. Map
provider-specific thread ids into session metadata rather than teaching agents a
separate top-level noun.

Session invariants:

- sessions are harness-specific
- endpoints must not bind a requested Codex harness to a Claude session, or the
  reverse, unless an explicit adapter exists
- `card create` creates identity and return-address metadata; it does not imply
  a running session unless a command explicitly starts one
- short-lived agent-created cards should be one-time reply addresses by
  default, with expiry and cleanup metadata, instead of permanent directory
  identities
- exact session asks should route work by `targetSessionId` to continue context;
  asks without a target session may route by agent/project and create the
  lightest usable fresh session/card
- forked asks should route work to a new execution session seeded from
  `forkFromStateId` or `forkFromSessionId`; the source session is context, not
  the work target
- project-path asks do not require a caller-created card first; if no card
  resolves for that project, the broker can create a one-time card as part of
  accepting the work
- when the sender needs a concrete live reply destination, carry
  `replyToSessionId` rather than minting another card
- `up` / wake behavior must resolve to start or attach semantics and report the
  chosen session id
- incompatible, missing, or failed sessions must produce specific diagnostics
  and remediation, not silent hangs

Read [`runtime-sessions.md`](./runtime-sessions.md) before changing harness
startup, wake, card, or endpoint behavior.

### 4. Message Path

Use the message path for communication:

- `send`: durable update with a broker receipt, no tracked work lifecycle
- DM: one explicit target
- channel: group coordination
- shared broadcast: only when the audience is intentionally broad

Do not hide routing instructions in the body when structured target fields are available. The broker should know the target as metadata, not by parsing prose.

Even message-only interactions should return stable ids such as `conversationId`
and `messageId`. Treat "fire and forget" as a UI affordance, not the underlying
contract.

Channel-addressed work stays channel-first. When a delivery names both a
channel and a concrete agent/session target, the canonical message and return
address remain in the channel conversation. The broker may also create a tiny
direct-message attention pointer for weak harnesses or UIs that do not reliably
watch channel notifications. That pointer is broker-generated status, not a
second task body: adapters should follow its `channelPointer` and
`returnAddress` metadata back to the channel message before replying.

### 5. Invocation Path

Use the invocation path for work:

- `ask` creates an invocation
- the invocation creates a flight
- the flight tracks queued, running, waiting, completed, failed, or cancelled
- the final reply should land back in the same conversation or work context

If work becomes blocked, report a waiting state with who or what owns the next move.

## Broker-Guided Routing

The sender should not carry most of the routing burden. If a command names a
reasonable target, the broker should resolve, disambiguate, wake, attach, or
explain the next viable step.

Adapters and clients should render broker diagnostics as first-class results:

- ambiguous target -> show candidates and the best fully qualified retry
- known identity without session -> show the needed `session start` or
  `session attach` command
- harness mismatch -> name the requested harness, the attached session harness,
  and the exact remediation
- peer unavailable -> report `unreachable` separately from generic `offline`
- unknown target with nearby candidates -> suggest likely matches

Avoid pushing agents into repeated `who` / `latest` / manual process inspection
when the broker can produce useful guidance from its own state.

## Preferred MCP Tools

Agents connected through Scout's MCP server should prefer:

- `whoami` to identify the current sender and broker context
- `agents_resolve` before sending to an ambiguous handle
- `messages_send` for durable messages and updates
- `notify_operator` for an agent-authored FYI that must not pause work
- `consult_operator` for optional operator advice with a required safe default
- `broker_feed` to inspect one agent's broker-native messages, status, delivery,
  dispatch, unblock, and error records
- `tail_events` to inspect recent observed harness activity without treating
  harness transcripts as Scout-owned conversation messages
- `ask` for agent-to-agent work or requested replies
- `invocations_get` and `invocations_wait` to monitor a flight
- `work_update` for durable work-item progress, waiting, review, and completion
- future `sessions_*` tools for explicit harness session start, attach, inspect,
  and stop operations

Use `ask` for requested work. It returns a compact receipt and lets Scout resolve, route,
and wake the target when possible. If the caller knows the project/capability
but not the concrete agent/session, pass `projectPath` and optional `harness`
instead of forcing a discovery loop or guessing a generic name. Invocation and
flight records are created as side effects of the ask; use `invocations_get`
and `invocations_wait` only to observe those records.

Integration receipts should preserve the broker-chosen handle set: `ref`,
`flightId`, `conversationId`, `messageId`, `workId`, session id, and any
broker-suggested situated target handle. Humans type saved targets as
`target:<name>`; agents and compact UI may render the same handle as `⌖name`.
Continue by those handles; create or pin a memorable long-lived name only after
the route is known good.

Base identity is the vanilla project/workspace identity. Harness, model,
profile, node, and session values describe a concrete instance or attachment
constraint on that identity; they should not be treated as new base agents
unless the caller is intentionally selecting a specialized profile.

Card creation, explicit registration, session attachment, and future worker
pinning/naming belong to the pro integration layer. They are appropriate for
hosts and Scout-native agents that
need to manage durable return addresses or explicit session attachments, but they
are not the default way to ask another agent for work.

Operator signals are convenience projections, not collaboration lifecycle.
`notify_operator` and `consult_operator` create durable, replyable broker
messages and return their message ids for correlation, but do not create flights
or transfer next-move ownership. If an agent cannot continue safely, it must use
the blocking human-input or work-item waiting path instead. A non-blocking
consultation always declares what the agent will do if no answer arrives. A
successful tool receipt means the message was recorded; notification delivery
is best-effort and remains unconfirmed by the MCP call.

## Collaboration Semantics

Scout separates information, execution, and communication:

- message: "say this"
- question: "answer this"
- invocation/flight: "do this and track the lifecycle"
- work item: "own this durable piece of execution"

Do not turn every chat into a work item. Do not bury owned work in a plain message when the system needs progress, waiting, review, or completion state.

Read [`agents-and-collaboration.md`](./agents-and-collaboration.md) for the full model.

## Human Input And Permissions

Agents should surface human dependencies as first-class state, not as terminal text that another surface cannot see.

Use the narrowest available mechanism:

- for an agent question, emit or call the question path
- for an action approval, emit an approval/action state
- for durable work blocked on a person, update the work item to `waiting`
- for host-level permission prompts, forward the host prompt into Scout as an operator attention or unblock request when that host integration exists

Harness-native interaction tools should be translated at the adapter boundary:
native questions become Scout questions or unblock requests, native plan
approvals become approval/review state, native task tools project into work
items, and native subagent activity links to child invocations/flights or
observed child activity. Do not expose a vendor's native tool contract as the
Scout product contract one-for-one.

Important boundary: an MCP server cannot see a client-side permission prompt that the MCP host intercepts before calling the server. Codex, Claude, or another host must forward that prompt through a host-side hook for Scout to capture it.

See [`operator-attention-and-unblock.md`](./operator-attention-and-unblock.md).

## Data Boundary

Do not bulk-copy external harness transcripts into Scout as first-party messages.

Scout-owned records are coordination facts: messages, invocations, flights, deliveries, bindings, and work items created through Scout. Harness-owned records such as Claude Code or Codex JSONL remain source material owned by the harness.

Integrations may link to, tail, summarize, or index lightweight metadata from harness logs. They should not make Scout's control-plane database the canonical transcript warehouse for every external turn.

Adapters must not write into a harness-owned ecosystem. For Claude Code, that means `.claude` project state, subagent definitions, agent-team config, task files, and MCP settings are read-only observation surfaces for adapters. Scout can inspect those surfaces to model reachability and topology when the harness makes them available, but it must not author or repair them on Claude's behalf. Host setup commands that intentionally install Scout into a harness are separate, explicit operator actions, never adapter runtime behavior.

Read the [data model section of `architecture.md`](./architecture.md#the-data-model).
Read [`eng/harness-topology-observation.md`](./eng/harness-topology-observation.md) for the shared observed-topology shape.

## Token And Cost Metadata

Integrations should report token usage when the harness or model provider makes
it available. Separate Scout protocol overhead from harness execution usage.

Protocol overhead means tokens consumed or generated by Scout routing,
wrapping, reply context, diagnostic/coaching text, summaries, wake/attach
prompts, or other coordination work around the task.

Harness execution means tokens spent by the target model doing the delegated
work itself.

Report:

- prompt tokens
- completion tokens
- total tokens
- model
- harness
- source category such as `protocol_overhead` or `harness_execution`
- value class such as `boilerplate`, `routing`, `diagnostic`, `onboarding`,
  `feature_guidance`, or `work_context`
- usage source such as `provider_exact`, `tokenizer_estimate`,
  `char_heuristic`, or `manual_estimate`
- session id
- related Scout ids such as message, invocation, flight, or work item
- non-token counters such as dispatch attempts, wake failures, generated
  diagnostics, and estimated orientation commands avoided

When exact usage is unavailable, integrations may report estimates, but the
record must mark them as estimated and say how they were estimated. Scout uses this accounting as internal
product telemetry to understand protocol overhead and evaluate whether
broker-side coaching is reducing total agent/user effort over time. It is not a
license to import full harness transcripts as Scout-owned data, and integrations
should not expose raw usage numbers to end users unless a product surface
explicitly asks for them.

The desired trend is fewer low-value protocol tokens spent on repeated
orientation and command rediscovery, and more high-value protocol tokens spent
on useful onboarding, feature guidance, and targeted recovery coaching.

## Mesh Expectations

Mesh means reachability and coordination across machines. It does not mean exactly-once delivery, replicated external transcripts, or global consensus.

An integration should treat a remote Scout agent as reachable through broker routing when the broker says it has a route. It should still report delivery failures and waiting states honestly.

## Compatibility Checklist

Before calling an integration "Scout-native", verify:

- it has a stable agent identity
- it registers or attaches a reachable endpoint
- it has deterministic session start/attach/inspect semantics
- it can receive a message
- it can receive an ask and produce a flight result
- it can reply without losing the original actor/conversation context
- it reports failed and waiting states
- it reports harness/session mismatches with actionable diagnostics
- it guides senders with broker diagnostics instead of only returning opaque
  unresolved/unavailable errors
- it does not require body mentions for normal routing
- it does not import external transcripts as Scout messages
- it documents its permission and wake behavior
- it can recover or explain state after broker/session restart
- it reports token usage or marked estimates when available
