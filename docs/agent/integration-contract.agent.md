# Agent Integration Contract Notes

Source: `docs/agent-integration-contract.md`.

Status: v0 integration guidance. Use this as the current Scout-native target, not as a frozen public API guarantee.

Verified: 2026-06-10

## Minimum Scout-Native Integration

| Requirement | Meaning |
|---|---|
| stable identity | resolves to one exact agent target |
| reachable endpoint | broker knows how to reach the agent |
| runtime session | concrete harness conversation/process attached to an endpoint |
| endpoint state | attachment state such as registered/attaching/waking/idle/working/unreachable/failed/superseded/stopped |
| message path | can receive durable messages with broker receipt ids |
| invocation path | can receive ask/work and produce flight result ids |
| reply context | replies preserve actor and conversation context |
| lifecycle state | reports queued/running/waiting/completed/failed/cancelled as appropriate |
| session diagnostics | reports missing or mismatched harness sessions clearly |
| broker guidance | returns candidates and remediation instead of opaque routing errors |
| token usage | reports exact usage or marked estimates when available |
| usage provenance | marks usage source as provider exact, tokenizer estimate, character heuristic, or manual estimate |
| permission posture | documents approval, sandbox, and wake behavior |
| data boundary | does not import external transcripts as Scout messages |

## Preferred MCP Tools

| Need | Tool |
|---|---|
| identify sender | `whoami` |
| resolve ambiguous target | `agents_resolve` |
| broker-native messages/status/errors | `broker_feed` |
| observed harness activity | `tail_events` |
| message/update | `messages_send` |
| work/requested reply | `ask` |
| project/capability known, agent unknown | `ask({ projectPath, harness })` |
| inspect flight | `invocations_get` |
| bounded follow-up wait | `invocations_wait` |
| work progress/waiting/review/done | `work_update` |
| session lifecycle | future `sessions_start`, `sessions_attach`, `sessions_inspect`, `sessions_stop` |

Card/session creation belongs to the pro integration layer for hosts and
Scout-native agents that intentionally manage identity infrastructure. Core
agents should route work with `ask`, especially `ask({ projectPath, harness })`
when no concrete instance is selected. Discovery is for ambiguity, not a
mandatory preflight.

## Reply Modes

| Mode | Use |
|---|---|
| `none` | receipt-only, durable ids returned |
| `inline` | short bounded wait only |
| `notify` | return quickly, deliver callback-style MCP notification later |

## Routing Rules

- one target -> DM
- base agent identity is the vanilla project/workspace identity
- harness, model, profile, node, and session are instance constraints unless a
  specialized profile is explicitly requested
- if the project/capability is known but the concrete agent/session is not,
  use `projectPath` plus optional `harness` instead of discovery-first routing
  or generic guesses such as `claude.main`
- continue with returned `ref`, flight, conversation, work, or session handles;
  pin/name a sibling only after the broker-routed worker is known good
- group -> explicit channel
- everyone -> shared broadcast
- body text is payload, not routing metadata
- follow-up stays in same DM/channel/work item

## Human Dependency Rules

- Agent question -> question path.
- Action approval -> approval/action state.
- Durable work blocked on a person -> work item `waiting`.
- Host-level permission prompt -> host integration must forward to Scout; MCP server cannot see a prompt intercepted before tool call.
