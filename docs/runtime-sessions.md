# Runtime Sessions

Scout began as a local communications layer: find the other sessions already
running, route messages between them, and preserve enough broker state that
humans and agents did not have to paste context by hand.

That is still true, but it is no longer the whole contract. Scout also owns
local harness orchestration for developer pilots. It can start, attach, wake,
and monitor Claude, Codex, and future harness sessions. This document names the
runtime semantics that make that deterministic.

Status: v0 product direction. Update this page before changing user-facing CLI,
MCP, skill, or broker semantics around harness lifecycle.

## Core Nouns

| Noun | Meaning |
| --- | --- |
| Agent | Stable addressable identity, such as `hudson.main.air-local` |
| Session | A concrete harness conversation/process/thread that can receive work |
| Endpoint | The routable attachment between one agent identity and one session |
| Invocation | A broker-owned request for an agent to do something |
| Flight | The lifecycle state for an invocation |
| Card | A shareable identity and return address; not by itself a running session |

Use **session** as the public noun. Avoid introducing a separate user-facing
`thread` concept unless a specific harness forces it; map harness thread ids
into Scout session metadata instead.

## Invariants

1. A card creates or describes identity. It must not imply that a harness session
   is running unless the command explicitly starts one.
2. A session is always harness-specific. A Codex session cannot satisfy a Claude
   endpoint, and a Claude session cannot satisfy a Codex endpoint.
3. An endpoint must declare `agentId`, `harness`, `transport`, `sessionId`,
   `state`, wake policy, and whether it is the preferred endpoint for that
   agent/harness pair.
4. A broker receipt means the broker accepted and recorded the request. It does
   not mean a harness session has completed the work.
5. Every user-visible delivery or invocation should return durable ids that can
   be referenced later. A message receipt returns `conversationId` and
   `messageId`. An invocation receipt returns `conversationId`, `messageId`,
   `invocationId`, and `flightId`. A work handoff also returns `workId`.
6. If Scout cannot start, attach, wake, or route to a compatible session, it
   must fail with a specific reason and a concrete remediation. Silent parked
   limbo is a product bug.
7. The broker should do the routing work or coach the sender toward the next
   viable action. Do not make agents run a long orientation ritual just to
   discover that a target needs a session, a qualifier, or an attach operation.

## Broker Coaching

Scout should lean on the broker, not the sender, to explain runtime and routing
state. The product assumes abundant local cognitive capacity; spending extra
reasoning in the broker is preferable to making every user or agent rediscover
topology by hand.

When a sender tries a reasonable capability command such as:

```bash
scout ask --project ../talkie --harness codex "Review this."
```

the broker should infer the likely intent, inspect identity/session/endpoint
state, and return one of:

- accepted receipt with ids and the active endpoint/session
- accepted receipt plus wake/start/attach progress
- dispatch result with candidates and a recommended fully qualified target
- lifecycle failure with the failed layer, reason, and exact remediation command

Avoid sender-hostile errors such as "could not find target" when Scout has
enough context to say something more useful. Prefer:

```plaintext
No active Codex session is attached to codex-hudai.
I found a Claude session for the same project: relay-hudson-claude.
Start a compatible session:
  scout session start --agent codex-hudai --harness codex
```

The sender may still use `who`, `latest`, or `session inspect` for debugging,
but those should be follow-up tools, not required preflights for ordinary agent
communication.

## Endpoint State

Endpoint state is the broker's best current view of a routable attachment. Keep
flight state separate from endpoint state: an endpoint can be `idle` while a
particular flight is `waiting`, or `waking` while multiple queued flights are
pending.

| State | Meaning |
| --- | --- |
| `registered` | identity and endpoint metadata exist, but no live session is attached |
| `attaching` | Scout is binding an endpoint to an existing compatible session |
| `waking` | Scout is starting or resuming a compatible harness session |
| `idle` | attached session is reachable and ready for work |
| `working` | attached session has claimed at least one active flight or work item |
| `unreachable` | endpoint is known, but the broker cannot currently contact it |
| `failed` | endpoint setup or wake failed with a recorded reason |
| `superseded` | endpoint row was replaced by a newer registration or route and should only appear in diagnostics |
| `stopped` | endpoint was intentionally detached or stopped |

Allowed transitions should be explicit in protocol/runtime code. The expected
happy path is `registered -> waking -> idle -> working -> idle`. Failure paths
should preserve the failed layer and remediation, for example `waking -> failed`
with `reason: "harness_mismatch"`.

## Cardinality And Selection

One agent identity may have multiple sessions over time and may have multiple
endpoints when different harnesses, transports, machines, or worktrees are
valid. The broker must not make the sender guess which one matters.

Routing selection should prefer:

1. exact agent id plus exact harness/session requested by the command
2. the preferred endpoint for that agent/harness pair
3. the most recent reachable compatible endpoint
4. a dispatch result that lists candidates and the recommended fully qualified
   retry

If more than one compatible endpoint is active and none is preferred, the result
is ambiguous, not silently random.

## Session Persistence

Session records survive broker restarts as coordination metadata, but that does
not mean the underlying harness is still alive.

- `resumable`: provider metadata says Scout can reattach or resume
- `reachability_unknown`: a prior session exists but the broker has not
  confirmed it is reachable
- `not_attachable`: the session reference cannot be loaded, parsed, or matched
  to a compatible harness/profile
- `terminal`: the harness or provider explicitly reported stopped, closed,
  cancelled, completed, or another terminal state

After restart, Scout should mark uncertain sessions as `reachability_unknown`
until an endpoint health check, attach, or wake operation confirms reachability.
User-facing copy should render that as "session not currently reachable"; failed
attach resolution should render as "session reference not attachable".

For ACP transports, keep the OpenScout runtime session id separate from the
provider-native ACP session id. A live endpoint retains one ACP client and
serializes its turns. After process loss or broker restart, a new binary must
use the provider id with `session/resume` or `session/load`. If the agent cannot
resume or load that exact context, fail the existing-session request rather than
silently calling `session/new`. See [SCO-090](./eng/sco-090-acp-session-continuity.md).

## Token And Coordination Accounting

Scout should track the cost of coordination, not just the state of coordination.
This is not billing infrastructure, enterprise metering, or a user-facing
scoreboard. It is developer-facing product telemetry for local pilots: what did
running through the Scout protocol add, and did that protocol overhead reduce
total cognitive work elsewhere?

Separate two ledgers:

- **Protocol overhead:** tokens Scout consumes or generates to route, wrap,
  diagnose, summarize, annotate, wake, attach, or coach around the core task.
- **Harness execution:** tokens spent by Claude, Codex, or another model doing
  the actual delegated work.

This section is primarily about protocol overhead. Harness execution usage is
useful context, but it should not be blended into the cost of the Scout protocol
itself.

Minimum useful accounting:

- prompt, completion, and total tokens for Scout-authored protocol prompts,
  wrappers, diagnostics, and summaries when a harness exposes them
- estimated tokens when exact usage is unavailable, with `usageSource` such as
  `provider_exact`, `tokenizer_estimate`, `char_heuristic`, or `manual_estimate`
- model and harness for each counted turn
- value class for protocol overhead:
  - `boilerplate`: repeated identity, topology, or command-discovery text
  - `routing`: target resolution, dispatch, delivery, and receipt wrapping
  - `diagnostic`: explaining failed or incomplete broker/runtime state
  - `onboarding`: teaching an agent a new Scout capability or contract
  - `feature_guidance`: coaching toward a better command or workflow
  - `work_context`: useful task context carried by Scout around the request,
    excluding the target harness's own execution tokens
- broker-side diagnostic effort, including non-token counters such as
  `diagnosticGenerated`, `dispatchAttemptCount`, `wakeFailureCount`, and
  `orientationCommandsAvoidedEstimate`
- avoided retry/orientation loops when the broker directly resolves or coaches
  a sender
- ids linking usage to `sessionId`, `endpointId`, `conversationId`,
  `messageId`, `invocationId`, `flightId`, and `workId`

The goal is trend visibility, not per-message guilt or end-user interpretation.
Internal reports should answer questions like:

- how many tokens did the Scout protocol add before the target harness began the
  real work?
- how many tokens did Scout generate in receipts, routing context, reply
  context, diagnostic text, and status summaries?
- are low-value boilerplate tokens trending down?
- are high-value guidance tokens, such as agent onboarding and feature coaching,
  replacing repeated orientation chatter?
- did broker coaching reduce repeated `who` / `latest` / `ps` loops?
- which agents or sessions are spending the most context on coordination?
- where do harness wake failures create expensive human or agent retries?
- when is a smarter broker response cheaper than sender-side rediscovery?

Accounting records should stay lightweight, mostly internal, and broker-owned.
Do not bulk-import full harness transcripts to compute them; store usage
numbers, estimates, references, summaries, and a source label such as `protocol_overhead` or
`harness_execution`.

The optimization target is not "fewer tokens everywhere." It is better token
mix: fewer low-value tokens spent on repeated identity checks, topology
discovery, card instructions, and command rediscovery; more high-value tokens
spent on onboarding agents, explaining new features, preserving useful context,
and coaching recovery from real state transitions.

## Session Operations

These are the semantics Scout should expose consistently across CLI, MCP, UI,
and skills. Command names may evolve, but the behavior should not be ambiguous.

| Operation | Meaning |
| --- | --- |
| `session start` | Create a new concrete harness session for an agent |
| `session intake` | Materialize an existing harness session through a local terminal backend |
| `session attach` | Attach an agent endpoint to an existing harness session |
| `session list` | Show known sessions and endpoint attachments |
| `search index` / `search query` | Explicit FTS over observed harness transcripts (see [session-search.md](./session-search.md)) |
| `session stop` | Stop or detach a concrete session |
| `session inspect` | Explain the agent/session/endpoint state and last error |

Expected CLI shape:

```bash
scout session start --agent hudson --harness codex
scout session intake --harness codex --session <id> --project .
scout session attach --agent hudson --harness codex --session <id>
scout session inspect --agent hudson --harness codex
```

`session intake` is the local handoff helper: it turns a harness-native session id
into an attachable local runtime surface. The stable input is the harness, session
id, and resume cwd; the terminal backend is disposable. A user should be able to
materialize the same harness session through tmux, Zellij, SSH, or a later
host-control protocol without changing the session identity. It does not by
itself claim broker ownership of the endpoint; `session attach` is the operation
that binds an agent endpoint to a session record.

`scout up` may remain as a friendly alias, but internally it must resolve to a
session operation and print exactly what it did.

## Card Semantics

`scout card create` is an identity and return-address operation.

It should answer:

- what agent identity was created or reused
- what project/worktree it points at
- what harness profile is configured
- whether a compatible session is already attached
- how to start or attach a session if none exists

It should not silently bind `--harness codex` to a Claude session. If a previous
profile exists for a different harness, Scout should either create a separate
Codex profile or reject the mismatch with a clear remediation.

Some cards are intentionally disposable. Agent-hosted MCP `card_create` calls
default to a one-time reply address because review, probe, and handoff agents
often need a fresh return path without becoming permanent directory entries.
One-time cards carry lifecycle metadata (`kind: "one_time"`, creator, expiry,
and max uses), are retired after a peer uses their direct conversation, and are
pruned by retention so older disposable cards do not crowd `who`/search results.
Manual CLI cards remain persistent unless created with `scout card create
--one-time`; `scout card cleanup` retires expired or overflow one-time cards.
When a caller asks a concrete `projectPath` and no existing project card is a
clear winner, the broker may create the one-time card itself, accept the work
against that generated identity, and prune older one-time cards for the same
sender/project. This includes the case where multiple same-project cards are
equally plausible but the ask requests fresh work rather than a specific
session.

When a CLI or MCP ask provides only execution preferences, such as
`--harness codex` or `session: "new"`, Scout treats the current directory as the
project target and requests a one-time project agent for that fresh work. This
keeps "run this repo in a fresh compatible worker" cheap without forcing the
caller to pre-create or choose a stable card.

For a different repo, callers should provide `projectPath` / `--project` plus
optional `harness` / `--harness`. This is a capability request, not an identity
request: the broker chooses or creates a compatible worker, returns durable
handles (`ref`, `flightId`, `conversationId`, `workId`, `sessionId`), and may
return a situated target handle. Follow-up uses those handles; a persistent
name/pin is an explicit promotion after the worker is known good.

When the broker exposes a friendly situated target, the human-typed form is
`target:<handle>`. Agent-authored prompts and compact UI may render the same
handle as `⌖handle`. Use this for "get back to that useful situation" shorthand.
Use `session:<native-id>` for exact raw harness continuation. If the same raw id
exists in more than one harness, scope it as `session:<harness>:<native-id>`.

## Route Alias Lifetime

`scout alias set <name> --to <agent>` creates a durable route pointer with
fresh-work agent semantics. `--to session:<id>` creates a durable record whose
route is live-bound to that exact endpoint/session and therefore has existing-
session semantics. It never floats to a replacement session for the same agent.

Session-target aliases expire when the exact session is terminal or leaves the
broker's runtime-session retention boundary; configured expiry may shorten but
not extend that lifetime. Temporary unreachability is reported without
substitution. Unset and expired bindings remain available to authorized history
reads, and repointing never changes prior accepted work.

## Ask Targets And Reply Sessions

An ask has two different routes:

- the work target, which is an exact session target or an agent/project target
  that can create a fresh session
- the return target, which may be a concrete requester `sessionId`

Use `targetSessionId` when the sender wants to keep building context in one
existing harness session over many turns. Repeating the session id means
"continue here"; omitting it means Scout may route by agent/project and create
the lightest usable fresh session for the request.

The session id does not have to be broker-minted. It only has to be
**harness-known** and exact (a live broker endpoint is sufficient but not
required). Scout resolves `targetSessionId` / `session:<id>` through endpoint
aliases such as endpoint id, broker session id, `externalSessionId`, native
harness thread id, and adapter-provided aliases. When no live endpoint exists,
Scout may locate the id in the harness session store (for example
`~/.codex/sessions`) and wake a flat-dispatch cardless endpoint that resumes
that exact thread. A session known to its harness but not yet to the broker is
still resolvable; absence of a live endpoint is not evidence of absence of a
session. When a native id needs scope, use the harness-qualified form
`session:<harness>:<native-id>` or pass `execution.harness` with
`targetSessionId`. Scout must fail closed on unknown, ambiguous harness, cwd
conflict, unresumable, or wake-failed exact-session references; it must not
silently reinterpret them as fresh project or card routing.

Agent cards and labels are fresh-session targets by default. A card carries
identity, harness/profile/model hints, project root, and return-address
metadata; it does not mean "reuse whatever thread was last attached." Scout
should consult session reachability diagnostics only when the request names an exact
`targetSessionId`/`session:<id>` and that session cannot be reached.

`session: "new"` may also target an existing agent card. In that shape, the card
supplies the identity, project, harness profile, and return-address metadata;
the session policy says the work should enter fresh target context instead of
continuing a concrete prior session for that card. Scout defines a one-time
project agent when the caller routed by project and explicitly asked for one.

Use exact `agentId` only when the sender knows the intended owner. Use project
routing plus optional harness/capability when the sender knows the codebase but
not the concrete worker. That path should stay cheap and throwaway: Scout can
create or choose an ephemeral session/card as needed, and the sender does not
need to ask for a new session explicitly or invent a generic agent name.

When the sender wants the answer to land back in one specific live harness
session, the ask should carry `replyToSessionId`. The broker records that
session on the requester's return address for the message and invocation. This
keeps "reply to my current session" separate from long-lived agent identity:
cards crystallize reusable identity/profile parameters, while session ids point
at one concrete reply destination.

### Session Reuse And Forking

Session policy should be explicit because "which worker should do this" and
"which prior context should it inherit" are different questions.

| Policy | Meaning | Session id role |
| --- | --- | --- |
| `new` | Run the work in fresh model context. | No session id required. Existing project agents should not force user-visible ambiguity. |
| `reuse` | Prefer a compatible warm session as an optimization, but start fresh if none is clearly suitable. | No exact session id required. Legacy `any` maps to this policy. |
| `existing` | Continue one exact session. | `targetSessionId` is the target and must resolve to that session owner. |
| `fork` | Start a new session from an excellent prior state. | `forkFromStateId` is preferred; `forkFromSessionId` means derive a source state from that session. |

The fork case is intentionally different from `existing`. A fork should leave
the source session untouched, create a new execution session, and carry only an
excellent session state: goal, decisions, constraints, evidence, relevant
files, and next move. If the harness has a native thread-fork primitive, Scout
can use it. If not, Scout can synthesize a compact handoff from broker-owned
records and observed harness material, with the same data-ownership boundary as
ordinary session observation. It should not bulk import the source transcript
into Scout messages.

Use `clone` for the implementation mechanism that copies a harness-native
thread or state. Use `fork` for the Scout routing policy that creates a new
execution session from prior state. A fork may be implemented by native clone or
by a synthesized Scout handoff.

The strongest fork sources are curated base states: a small set of carefully
constructed states that stay useful for recurring work. These should appear
ahead of raw sessions when choosing what to fork from.

Proposed request shape:

```ts
execution: {
  session: "fork",
  forkFromStateId: "state-session-abc123-review-ready",
  // or forkFromSessionId: "session-source-abc123"
  forkContext: {
    includeBrokerRecords: true,
    includeObservedHarnessMaterial: true
  }
}
```

The work target should still be provided by `projectPath`, `agentId`, or an
explicit target label unless the fork source is deliberately meant to imply the
same project and agent profile. This keeps project routing as the work
primitive, while the fork source is only a continuity input.

## Message And Work Semantics

The old "tell means no reply needed" wording is too weak for agent experience.
Agents need two separate signals: a broker receipt that proves Scout accepted
and recorded the interaction, and a target-authored acknowledgement that the
receiving agent has started working.

Use this model instead:

| Interaction | Use When | Required Result |
| --- | --- | --- |
| Message | Status, update, note, or channel post | Broker receipt with ids |
| Invocation | Question, review, investigation, or owned work | Broker receipt plus flight ids, then target acknowledgement and later completion in the same conversation |
| Work item | Durable multi-step ownership | Work id plus progress states |

The CLI verbs can remain `send` and `ask` for compatibility, but docs and
skills should teach them as:

- `send`: post a message and return a durable receipt
- `ask`: create an invocation, return a durable receipt plus lifecycle state, and let the target acknowledge quickly before final completion

No route should depend on fire-and-forget behavior. Even a channel post should
have a receipt.

## Wake And Delivery

When a known on-demand agent has no active compatible session:

1. The broker records the message or invocation.
2. The runtime resolves the requested harness/profile.
3. If wake policy allows, Scout starts or attaches a compatible session.
4. The endpoint transitions through `waking` to `idle` or `working`.
5. Queued flights for that agent/session compatibility drain automatically.

If any step fails, the flight must move to `failed` or a clearly explainable
`waiting` state. The error should name the failed layer:

```plaintext
codex-hudai is registered, but has no active codex session.
Wake policy: on_demand.
Start failed: configured profile points at Claude session relay-hudson-claude.
Run: scout session start --agent codex-hudai --harness codex
```

## Agent-Facing Defaults

Agents should not have to reason about the entire runtime graph for ordinary
coordination. The happy path stays small:

```bash
scout ask --to hudson "Review this and report back."
scout send --to hudson "Heads up: I am taking the runtime side."
scout ask --to hudson --notify "Run the longer review and report back."
scout who
scout latest
```

Use Send only when no reply, judgment, investigation, or owned work is
expected. If work should happen asynchronously, keep it as an Ask and use
`--notify`; do not turn it into Send merely to avoid blocking.

Reply mode is separate from session placement. Background is the default for
new Scout-routed sessions. Preserve foreground as an explicit requirement when
the operator wants the task visible/openable in the destination harness UI so
they can watch or chime in. Foreground placement does not itself open or focus
that UI, and unsupported foreground placement must not silently fall back to
background.

When those commands fail, the failure must expose enough session detail that an
agent can recover without guessing or asking the human to manually relaunch a
known target.

## Compatibility Target

Future CLI, MCP, and skill updates should converge on these names:

| Concept | CLI | MCP / API |
| --- | --- | --- |
| Start a session | `scout session start ...` | `sessions_start` |
| Attach a session | `scout session attach ...` | `sessions_attach` |
| Inspect runtime state | `scout session inspect ...` | `sessions_inspect` |
| Message receipt | `scout send ...` | `messages_send` |
| Ask receipt | `scout ask ...` | `ask` |

Old commands should continue to work while emitting behavior that maps cleanly
onto these semantics.
