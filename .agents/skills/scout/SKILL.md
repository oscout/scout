---
name: scout
description: >
  Use the Scout CLI (scout send, scout ask, scout search, scout who, scout wait,
  scout whoami) for agent-to-agent coordination and past harness-session search
  via the local broker. Load this skill whenever the user asks to message or ask
  another agent, find prior Codex/Claude/Kimi session work, hand off work across
  agents, continue a Scout flight/ref/session, route by project and harness,
  check who is around, or fan out a Scout request — including `/scout` and
  `@agent` mentions. Prefer `scout search` over grepping harness home dirs.
  Prefer shelling out to `scout` with structured flags over inventing agent names.
metadata:
  short-description: Use the scout command from the shell
  compatibility: claude-code,codex,opencode,pi,grok
---

# Scout CLI

Use Scout when you need shared coordination state, not just message delivery.

Baseline agent-to-agent communication should be one command with a broker
receipt:

```bash
scout send --to x "msg"    # durable message/update; returns ids
scout ask --to x "msg"     # card/label ask; fresh session, returns ids + lifecycle
scout ask --to session:<id> "msg" # continue one exact existing session
scout ask --project ../x "msg" # project known; concrete agent/session chosen by Scout
scout ask --project ../x --harness claude "msg" # capability known; broker picks/creates worker
scout ask Fable to review this       # reserved broker profile; fresh current-project session
scout ask agent Composer Review to fix the tests # exact existing @composer-review handle
```

**Past harness sessions (high priority):** when the question is what prior
Codex/Claude/Kimi (or other harness) work said or ran, use `scout search`
**before** grepping `~/.codex`, `~/.claude`, or `~/.kimi-code`:

```bash
scout search status
scout search index --source sessions --harness kimi --hours 12
scout search query "xcodebuild" --harness kimi --hours 12
```

Indexing is explicit only. Full guide: `docs/session-search.md`.
Reserved profile names `Fable`, `Kimi`, `Grok`, and `Opus` are launch
presets, not agent names. In natural-language asks they always create a fresh
session in the inferred current project through the broker-owned profile.
`scout ask --profile <name> ...` is the explicit equivalent. Fable and Opus
accept optional `--effort <level>`; Kimi and Grok reject effort until their ACP
transports expose that control. Never rewrite one of these forms as `ask --to`.

When a human says `agent <name> to <request>`, normalize the text between
`agent` and `to` to a lowercase dash-separated handle and resolve it exactly.
For example, `agent Composer Review` means `@composer-review`. Zero or multiple
matches require disambiguation; do not choose by locality or similarity.
Direct `scout ask --to <target>` continues to mean an existing target.

When the workspace is known and there is one intended recipient, use that direct path first. Do not run `whoami`, `who`, or `latest` unless the sender is unclear, the target is ambiguous, or the command fails.
When the project is known but the concrete agent is not, use `scout ask --project <path>` instead of discovering an agent name first. When the desired capability matters, add `--harness <claude|codex|...>`. Do **not** guess generic handles such as `claude.main` as a first move.

Default routing ladder:

1. **Capability request:** project path + harness/capability, e.g. `scout ask --project /Users/example/dev/talkie --harness claude "Review the spec."`
2. **Continuity request:** a returned `ref`, `flightId`, `conversationId`, `workId`, or `session:<id>` from the broker receipt.
3. **Named sibling:** promote/name/pin a known-good dispatched worker only after Scout has routed it; prefer broker-suggested mnemonic handles over invented generic names.

Scout can answer five questions when the route is not already obvious:

1. Who am I here?
2. Who is around?
3. What is the latest?
4. What did past harness sessions say/do about a topic?
5. Do I need the full live UI?

Treat that as an orientation loop, not a mandatory preflight.

### Session search (past harness work)

For “which session built X / mentioned Y / ran this command?” across Codex,
Claude, Kimi, etc., use **explicit** knowledge search — not ad-hoc greps of
home directories and not broker `latest` (broker activity ≠ harness transcripts):

```bash
scout search status
scout search index --source sessions --harness kimi --hours 12   # explicit warm-up
scout search query "xcodebuild" --harness kimi --hours 12
```

Indexing is never ambient. If query reports not warmed, run `index` for that
span first. Full guide: `docs/session-search.md`.

## Remote onboarding (OpenScout product context)

When you need OpenScout semantics before routing locally:

1. `scout whoami --json` — sender, broker URL, `discovery` URLs, and `projectAgentsMd` when Scout finds one
2. Fetch `discovery.manifest` (or `https://openscout.app/.well-known/scout.json`)
3. Read `discovery.agentInstructions`, then `discovery.agentsGuide`
4. Follow `discovery.llms` / `discovery.nav` when you need deeper docs

Well-known paths on the site: `/.well-known/agent.md` (singular entry), `/.well-known/agents.md` (plural alias), `/agents.md` (full guide).

In a git checkout, prefer the repo's **`AGENTS.md`** for project-specific build/test/style rules.

## Resolve the CLI only when needed

If `scout` is missing from `PATH`, locate the binary:

```bash
scout env --json
```

If `scout` is not on `PATH`, or the installed `scout` on `PATH` is stale for this checkout, use:

```bash
bun /Users/example/dev/openscout/packages/cli/bin/scout.mjs env --json
```

## Fast path

When the workspace is known and there is one intended recipient, do not burn extra commands on orientation first.

- CLI message/update: `scout send --to x "msg"`
- CLI invocation: `scout ask --to x "msg"`
- CLI project-routed invocation: `scout ask --project ../x "msg"`
- CLI capability-routed invocation: `scout ask --project ../x --harness claude "msg"`
- Known offline / on-demand agents are supposed to wake on first delivery. Do not ask the operator to bring up a known target just to send the first message.

The broker/runtime should return durable ids such as `conversationId`, `messageId`, `flightId`, `workId`, or a short `ref`. Use those handles for follow-up. When the broker also returns a friendly handle for the dispatched worker, treat it as the human mnemonic; do not invent a generic agent name. Only fall back to orientation when the route is ambiguous or the sender context is wrong.

Use `scout send --to ...` instead of placing the route inside the message body. Legacy `scout send "@x msg"` exists for compatibility, but body mention parsing can turn quoted agent names into route candidates. With `--to`, text such as `@codex` inside the body remains payload.

## Spec-backed handoffs

When the work is defined in a durable spec, prompt, plan, or handoff file, send
a short Scout ask that points to the file instead of pasting the full contents
into the message. This is for traceability, not message-size limits: Scout
messages are local, but the file should remain the source of truth for review,
diffs, and follow-up.

Use a shape like:

```bash
scout ask --project /path/to/repo --harness claude \
  "Please implement docs/eng/sco-068-unified-native-settings.md. Use that spec as the source of truth. Report changed files, checks run, and blockers."
```

Prefer repo-relative paths when the target is in the same checkout. Use an
absolute path only when that makes the file unambiguous for the target. Paste
the full text only when the recipient cannot access the file, and say why.

## Orientation loop

Run the smallest command that answers the uncertainty. Prefer broker-provided
dispatch and remediation output over manual spelunking; orientation commands are
debug tools, not mandatory preflights.

```bash
scout whoami       # sender unclear
scout inbox --latest 10 --json
scout who          # target unknown or ambiguous
scout channel triage --latest 10 --json
scout latest       # recent activity needed
scout server open  # full UI needed
```

Interpret them like this:

- `scout whoami` answers identity and default routing context from the current workspace.
- `scout inbox --latest N --json` answers "what messages are addressed to me?"
- `scout who` answers who is online, discovered, or recently active.
- `scout channel <name> --latest N --json` answers "what was just said in this channel?"
- `scout latest` answers recent broker activity without making you tail raw logs.
- `scout server open` opens the full UI and will start the server if it is not already running.

Use the web UI when you need conversation history, multiple agents at once, or spatial context.
Do not call broker HTTP endpoints directly or read relay files for Scout messages; use MCP tools when available, otherwise use these CLI reads.

## One true paths by surface

The semantics do not change by host. Only the verbs change:

| Meaning | CLI | MCP | Venue rule |
| ------- | --- | --- | ---------- |
| Resolve who you are | `scout whoami` | `whoami` | use when sender context is unclear |
| Read your addressed messages | `scout inbox --latest 20 --json` | `messages_inbox` | use before replying when context may be missing |
| Read a named channel | `scout channel <name> --latest 20 --json` | `messages_channel` | use for group/channel context |
| Inspect broker-native messages/status/errors | `scout latest` | `broker_feed` | use when delivery, dispatch, unblock, or flight status matters |
| Find or confirm a target | `scout who`, `scout latest`, `scout @x...` disambiguation | `agents_search`, `agents_resolve` | use when direct routing is ambiguous |
| Search past harness sessions | `scout search status\|index\|query` (explicit warm-up) | — | see `docs/session-search.md`; not broker messages |
| Message / status / reply | `scout send --to x "msg"` | `messages_send` with explicit target fields | one target -> DM |
| Invocation / requested reply | `scout ask --to x "msg"` | `ask` with `to` | one target -> DM; card target starts fresh |
| Continue exact prior context | `scout ask --to session:<id> "msg"` | `ask` with `targetSessionId` | only path that reuses/stickies a harness session |
| Project/capability-routed invocation | `scout ask --project ../x --harness claude "msg"` | `ask` with `projectPath` plus optional `harness` | use when the project/capability is known but no concrete agent/session is selected |
| Progress / waiting / review / done | same DM, plus work handle when available | `work_update` | stay in the same DM or channel |
| Fresh reply-ready identity | `scout card create` | `card_create` | pro integration layer; identity and return address, not normal work routing |
| Harness session lifecycle | `scout session ...` / `scout up` alias | `sessions_*` once available | pro integration layer; start/attach/inspect concrete sessions |
| Everybody on this broker | `scout broadcast` | `messages_send` with `channel="shared"` | shared broadcast only |

Do not invent a second routing model for Claude, Codex, the CLI, MCP, or the UI. The same rules apply everywhere:

- one target -> DM
- group coordination -> explicit channel
- everyone -> shared broadcast
- message/update -> send
- invocation / requested reply -> ask
- follow-up stays in the same DM or explicit channel
- message body text is payload, not routing metadata

## Runtime sessions

Scout agents are stable identities. Scout sessions are concrete harness
conversations/processes that can receive work. Use **session** as the noun when
talking about Claude, Codex, or future harness lifecycle. The cheapest fresh-start path is usually project + harness; Scout can choose/create the concrete worker and return the durable handle.

Agent cards, labels, and exact agent ids are fresh-session targets for new
work. They carry identity, project, harness/profile/model hints, and return
address information; they do not mean "reuse the last thread." Use
`session:<id>` or MCP `targetSessionId` only when the user explicitly wants one
concrete prior Codex/Claude session.

`scout card create` creates or describes an identity and return address. It does
not guarantee a live harness session unless a command explicitly starts one.

`scout up` is a convenience prewarm command. Treat it as an alias for explicit
session start/attach semantics:

```bash
scout session start --agent hudson --harness codex
scout session attach --agent hudson --harness codex --session <id>
scout session inspect --agent hudson --harness codex
```

If the current CLI does not yet expose `scout session`, use `scout up` only for
prewarming and report any harness/session mismatch clearly. A Codex target must
not silently bind to a Claude session. If wake fails, preserve the returned ids
and state the failed layer instead of asking the human to manually relaunch a
known target.

## Operator-safe orchestration

Agent orchestration should preserve the operator's active context. Starting,
waking, routing, or inspecting another agent is not permission to open a UI,
attach a terminal, focus a window, or steal input.

Default to quiet coordination unless the operator explicitly wants to follow
the work in the destination harness UI:

- prefer broker-routed `scout ask --to ...` or `scout ask --project ...`; let
  Scout resolve, wake, or create the concrete session in the background
- use `scout up` only as a prewarm/register step, not as a reason to switch the
  human into that target's interface
- do not call `scout server open`, attach to a harness session, or focus another
  surface unless the user asked to watch, inspect, or interact with it
- if a runtime/surface command offers a background, non-attaching, or
  non-focusing option, choose that by default
- keep any returned `conversationId`, `messageId`, `flightId`, `workId`, or
  session id and report that handle instead of pulling the operator into a new
  view

Reply mode and session placement are independent:

- reply mode controls whether the caller waits inline, returns for a later
  notification, or does not wait
- session placement controls where a newly created harness session lives and
  whether the harness's native UI can list/open it
- background placement is the default for ordinary delegated work
- preserve foreground as an explicit requirement when the operator asks to
  watch, chime in, or continue directly in the destination harness UI; a live
  harness-to-harness handoff is a common case
- if the route cannot honor foreground placement, report that limitation; do
  not silently create a background substitute
- foreground placement never authorizes opening, focusing, or taking over the
  native app

Use visible surfaces intentionally:

```bash
scout ask --project ../api "Run the narrow auth tests and report the result."
scout up hudson              # prewarm only when routing/remediation asks for it
scout server open            # only when the user wants the full live UI
```

If a task needs a long-running helper, prefer an Ask or background host worker
that reports back through the same DM, channel, work item, or flight. Escalate to
the operator only when the target is blocked, ambiguous, or asking for human
input.

## Frequent questions

Map common operator/agent questions to one command:

| Question                        | Command                                             |
| ------------------------------- | --------------------------------------------------- |
| "Who am I?"                     | `scout whoami`                                      |
| "Who's around?"                 | `scout who`                                         |
| "What's the latest?"            | `scout latest`                                      |
| "What did sessions say about X?"| `scout search` (index then query; `docs/session-search.md`) |
| "Open Scout"                    | `scout server open`                                 |
| "Open a specific page in Scout" | `scout server open --path /agents/<agent-or-route>` |

Do not make agents rediscover these patterns from scratch. Teach them as the default Scout muscle memory.

## Routing is decided by addressee count, not verb

Scout has three destinations: **DM**, **named channel**, **shared broadcast**. Pick by who the message is for:

| Situation                            | Destination             | Command                                           |
| ------------------------------------ | ----------------------- | ------------------------------------------------- |
| You're addressing one specific agent | DM (two-party, private) | `scout send --to x "msg"` or `scout ask --to x "msg"` |
| You're posting into a named channel  | that channel            | `scout send --channel foo "msg"`                  |
| You want every agent to see it       | `channel.shared`        | `scout broadcast "msg"`                           |

`channel.shared` is a broadcast surface, not a default. A pointed `@x` message is a DM. Do **not** rely on implicit fallback to `channel.shared`; if you do not name an addressee, or you name several addressees without an explicit channel, the command is wrong.

## One-to-one work handoff

When one project agent is asking one other agent to do concrete work, the correct default is:

1. Keep the exchange in a DM
2. Preserve the acting agent identity
3. Keep progress, review, and completion in that same DM
4. Resolve the acting sender with `scout whoami` only if the host cannot preserve it from the current workspace

This is the common failure mode to avoid:

- the work is really from Premotion to Hudson
- but the broker record looks like it came from the human operator
- or the metadata makes it look shared/public even though the route was actually private

Use this pattern instead:

```bash
scout ask --to hudson "Build the editable CodeViewer and report back with the integration-ready surface."
```

If the shell or host path might not preserve the acting agent identity automatically, make it explicit:

```bash
scout ask --as premotion.master.mini --to hudson "Build the editable CodeViewer and report back with the integration-ready surface."
```

Coding-agent hosts (Cursor `CURSOR_AGENT=1`, Claude `CLAUDECODE=1` / cloud
session vars, Codex `CODEX_CI` / `CODEX_THREAD_ID`, Scout-managed harnesses)
infer the project-scoped sender for `scout ask` automatically — omit `--as`
unless you need a different identity than `scout whoami` reports. Check
`codingAgentHost` in `scout whoami --json` to see which vendor signal matched.

Until Scout has a first-class work-handoff CLI surface, use a DM `ask` for one-to-one delegation and phrase the task as owned work, not as a public channel update.

If the ask returns a `workItem` / `workId`, treat that as the durable handle for the delegated work:

- keep the conversation in the same DM
- update the same work item when the state materially changes
- append meaningful progress, waiting, review, or done transitions instead of minting a second record

When the Scout MCP tools are available, use `work_update` to keep that handle current.

## Broker reply mode

When a turn contains `SCOUT BROKER REPLY MODE`, a `ScoutReplyContext` block,
or an active Scout MCP reply context, you are answering an inbound broker ask.
This is a reply lifecycle, not a new outbound message.

Default behavior for direct broker-invoked asks:

- your final assistant response is the broker-visible reply
- do not call `messages_reply`, `scout_reply`, `scout send`,
  `messages_send`, or `ask` to answer the requester
- only use Scout tools if you need to ask or delegate to another agent while solving the request
- return only the reply intended for the requester

If the active reply context says `replyPath: mcp_reply`, use the provided
reply tool (for example `messages_reply` or `scout_reply`) instead of relying
on final-response capture. `messages_reply` is a normal threaded message in
the existing conversation; it should not create a fresh ask or owned-work
lifecycle. A visible conversation/message reference alone is not an MCP reply
context; direct broker-invoked asks still rely on final assistant response
capture. If there is no active reply context, use normal Scout routing:
`messages_send`/`scout send` for messages and updates, and `ask`/`scout ask`
for new invocations and requested work.

## Send vs Ask

Scout has two compatible CLI verbs. Choose intentionally, but expect both to
return broker receipts.

### Send

Use **Send** only for messages, updates, and notes where no reply, judgment,
investigation, or owned work is expected.

Phrasing:

- "tell @x ..."
- "let @x know ..."
- "@x done with X"
- status updates

Command:

```bash
scout send --to x "msg"
```

This lands in the `@x` DM and should return durable ids such as
`conversationId` and `messageId`. Treat "fire-and-forget" as a UI choice, not
as the underlying Scout contract.

Do not use Send as a non-blocking Ask. If the target needs to do anything and
report back, use Ask with notification semantics.

### Ask

Use **Ask** when a reply, judgment, investigation, or owned work is needed.

Phrasing:

- "ask @x ..."
- "@x can you check ...?"
- anything ending in `?`
- slow targets
- multi-turn follow-up

Command:

```bash
scout ask --to x "msg"
scout ask --project ../x "msg"
scout ask --project ../x --harness claude "msg"
scout ask --to x --notify "take the next pass and report back"
```

`--notify` is the asynchronous Ask path: return after the broker receipt and
surface completion later. MCP callers use `replyMode: "notify"`. This preserves
the invocation and flight lifecycle that Send does not create.

Use `--project` when you know the codebase path but do not care which concrete
agent/session handles it. Add `--harness` when the capability matters. Scout
resolves or creates the right instance for that project and should return the
`ref`/ids/friendly handle to use for follow-up.

If your host has a background worker or subagent primitive, **run Ask there instead of blocking the parent**. The parent should keep working and surface the reply when the background task completes. Prefer Scout's `--notify` / `replyMode: "notify"` path when it is available.

Prompt shape for the background worker:

```text
Run: scout ask --to hudson "<your question>"
Return the reply text only.
```

Inline `scout ask` is acceptable only when your host cannot delegate background work.

## Fan-out and broadcast

### Fan-out

If the user's message contains multiple `@name` mentions, do not send one ambiguous multi-target post without an explicit channel.

Choose one of these on purpose:

- send one Scout action per target and keep those DMs separate
- or create/use a named channel if the user explicitly wants group coordination
- or use `scout broadcast` if the message is truly for everyone

### Broadcast

For true broadcasts use `scout broadcast`:

```bash
scout broadcast "shipping 0.3.0 in 15min, pause long flights"
```

Confirm with the user before broadcasting to more than 4 targets.

## Addressing

Agent identity has six dimensions: `definitionId`, `workspaceQualifier`, `profile`, `harness`, `model`, `node`. Canonical form:

```
@<definitionId>[.<workspaceQualifier>][.profile:<profile>][.harness:<harness>][.model:<model>][.node:<node>]
```

When a short `@name` could match multiple live agents, pin the dimension you care about with a typed qualifier:

- `@vox.harness:codex` — the Codex-backed Vox
- `@vox.harness:claude` — the Claude-backed Vox
- `@lattices#codex?5.5` — shorthand for the Codex-backed Lattices on a 5.5 model
- `@lattices#claude?sonnet` — shorthand for the Claude-backed Lattices on Sonnet
- `@arc.profile:reviewer` — the reviewer profile of Arc
- `@vox.harness:codex.node:mini` — fully qualified across machines

Aliases:

- `runtime:` = `harness:`
- `persona:` = `profile:`
- `branch:` / `worktree:` = workspace qualifier
- `#<harness>` = `harness:<harness>`
- `?<model>` = `model:<model>`

Use typed qualifiers or shorthand any time the user's request implies a specific harness, model, or profile. Do not rely on short-name resolution to guess right.

Product handles are reserved. Do not treat `@scout` or `@openscout` as aliases for a normal orchestration persona. For the local product inbox, use `scout send --to scout "..."`; the broker owns any legacy/internal aliasing. Use `@scoutbot` only when the user specifically needs Scoutbot-style orchestration.

## Resolution rule

Short `@name` should resolve when the broker can map it to **exactly one known target**.

Offline / on-demand is still routable. The broker should register the target if needed and wake it on first send / ask.

If `scout send --to x "..."` or `scout ask --to x ...` returns `unresolved`, treat that as **route unclear or target unknown in the current broker context**, not as proof the target is merely offline.

If the CLI reports multiple candidates, re-run with a typed qualifier. If the route still fails, options are:

- Inspect the route: `scout who`, `scout latest`, or `scout server open`
- Disambiguate with a typed qualifier: `@x.harness:codex`
- Use the full FQN: `@x.host.x-main-abc123`
- Pro integration only: create a fresh project-scoped identity when you are
  intentionally managing return addresses: `scout card create`
- Use `scout up` only when you are explicitly prewarming a target or registering one the broker truly does not know yet
- Tell the user the route is ambiguous or the target is unknown; do not ask them to manually bring up a known target just to deliver a message

## Broker coaching

Scout should spend broker-side reasoning to reduce sender burden. If a command
is plausible, prefer actionable diagnostics like:

```text
@hudson#codex resolved to codex-hudai.main.air-local, but no compatible Codex
session is attached. Try:
  scout session start --agent codex-hudai --harness codex
```

If the broker gives candidates, retry with the best fully qualified target. If
it names a missing session or harness mismatch, follow that remediation. Do not
turn every failure into a full `who` / `latest` loop unless the broker's guidance
is genuinely insufficient.

## Token accounting

Scout may track token or usage metadata for messages, invocations, sessions,
and broker diagnostics. Treat those numbers as internal coordination telemetry,
not user-facing blame.
Exact counts should come from the harness/model when available; estimates must be
marked.

Keep two ledgers separate:

- protocol overhead: tokens Scout adds for routing, context wrappers, receipts,
  diagnostics, summaries, wake/attach, and broker coaching
- harness execution: tokens the target model spends doing the delegated work

Use accounting to prefer lower-total-cost flows, for example one broker
diagnostic that prevents many repeated `who` / `latest` / retry loops.

The desired trend is fewer low-value protocol tokens for boilerplate
orientation ("who am I", "who is up", "how do I create a card") and more
high-value protocol tokens for agent onboarding, feature guidance, useful
context, and targeted recovery coaching.

## Decision rule

Use **Ask** by default when the next sentence is effectively:

- "Do this and get back to me."
- "Investigate this and tell me what you found."
- "Take ownership of the next step."
- "Review this and return a judgment."

Use **Send** when the next sentence is effectively:

- "Heads up."
- "I am working on this now."
- "Please note this constraint."
- "You can ignore the earlier path."

When in doubt, use Ask.

## Pro integration: dedicated agent cards

Use `scout card create` when you are intentionally managing Scout identity
infrastructure and need a project-scoped relay identity with its own inbox and
return address. This is not the default way to ask for work; use `scout ask`
or MCP `ask` for that. For new capability work, route by project/harness first;
name or pin a durable sibling only after Scout has returned a known-good worker
and, when available, a broker-suggested mnemonic handle.

Use it when:

- you are in a worktree and want the agent bound to that exact path and branch
- you need a dedicated alias instead of reusing a shared project agent
- you want to hand another agent a clean reply target immediately

Examples:

```bash
scout card create
scout card create ~/dev/openscout-worktrees/shell-fix --name shellfix --harness claude
```

After creating the card, prefer the friendly handle such as `@shellfix`.

## Compatibility notes

- `scout relay ask` and `scout relay send` are accepted as namespace aliases. Do not use them in new prompts.
- `scout` is the canonical CLI binary. Do not use `openscout` in new prompts or examples.
- Legacy `scout send "@x msg"` is accepted as body-mention shorthand. Do not use it in new prompts when a structured target field is available.
- For agent-to-agent delegation, rely on the current workspace identity by default. Check `scout whoami` and use `--as <agent>` only when the acting project agent might not be preserved by the host, shell, or bridge.

## When not to use Scout

- Do not use Scout for work inside the same agent when no cross-agent communication is needed.
- Do not invent ad hoc retry loops in prompts when the background worker already gives you tracked waiting.
- Do not read the broker's internal storage directly. Go through the `scout` CLI or Scout web UI.
