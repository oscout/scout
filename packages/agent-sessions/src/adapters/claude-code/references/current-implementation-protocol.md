# Claude Code Current Implementation Protocol Notes

This reference captures the protocol assumptions encoded by the current
[adapter.ts](../adapter.ts) adapter.

## Process Model

- The adapter starts one persistent `claude` subprocess.
- It uses:
  - `--print`
  - `--input-format stream-json`
  - `--output-format stream-json`
  - `--include-partial-messages`
- Optional adapter options currently used:
  - `model`
  - `resume`

## Ownership Boundary

Claude Code owns its own filesystem ecosystem. The adapter may inspect
Claude-owned state to understand what Claude is doing, but it must not create,
edit, or delete Claude-owned files or settings.

Read-only inspection may include Claude session JSONL, discovered project
metadata, native `Agent` tool calls, and Claude team/task/subagent topology.
Prohibited adapter writes include `.claude` project files, subagent definitions,
team config, task lists, and MCP settings.

Explicit setup commands outside the adapter may register Scout with a Claude
host when the operator asks for that installation. That is a user-directed setup
operation, not adapter runtime behavior.

## Outbound Messages

The adapter writes newline-delimited JSON objects to stdin.

Observed outbound message types:

- `user`
- `tool_result`

`user` carries:

- `session_id`
- `message.role = "user"`
- `message.content`
- `parent_tool_use_id = null`

`tool_result` is used to answer `AskUserQuestion`.

## Inbound Event Types

The adapter currently routes these event types:

- `system`
- `assistant`
- `tool_use`
- `tool_result`
- `result`
- `error`

It currently ignores `stream_event` and similar auxiliary events.

## Normalized Behavior

- `assistant` text becomes completed `text` blocks.
- `assistant` thinking/reasoning becomes completed `reasoning` blocks.
- `stream_event` text and thinking deltas update streaming `text` and
  `reasoning` blocks.
- `tool_use` becomes `action` blocks, except `AskUserQuestion`, which becomes a
  `question` block.
- `tool_result` updates the correlated action block output and status.
- `result` ends the active turn.
- `error` emits an error block and fails the turn.
- Claude agent-team topology, when matched to the current session or cwd, is
  attached to `session.providerMeta.observedTopology` using
  `ObservedHarnessTopology`.

## Important Limitations

- File references are appended to prompt text rather than sent through a native
  file attachment protocol.
- There is no normalized approval decision channel.
- Claude-owned topology is observed only. The adapter does not author Claude
  subagents, teams, task files, or MCP configuration.
