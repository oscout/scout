---
name: scout
description: >
  Use Scout to ask an agent for work, tell an agent an FYI, search past harness
  sessions, reach the operator, or continue a flight. Load this skill whenever
  the user wants to message or ask another agent, ping or question the
  operator, find prior Codex/Claude/Kimi session work, hand off or fan out
  work, continue a Scout flight/ref/session, route by project, harness, or
  machine, or check who is around — including `/scout` and `@agent` mentions.
  Prefer connected Scout MCP tools; use the Scout CLI when MCP is unavailable or
  the operator asks for it. Prefer `scout search` over grepping harness home
  dirs. Never invent agent names. Never use `scout send`.
metadata:
  short-description: Ask, tell, and search through Scout
  compatibility: claude-code,codex,opencode,pi,grok
---

# Scout

Scout is the local broker that lets agents ask each other for work and reach
the operator. This skill holds only the judgment calls; syntax lives in the
places below.

## Where to look

- `scout help --detail`: every command with examples. `scout <command> --help` gives exact flags.
- MCP tool schemas, when Scout MCP is connected (check deferred tools too). Prefer MCP over the CLI.
- `scout status` shows this project, broker health, who's around and blocked work. `scout doctor` is for when something's broken. `scout runtimes` shows which harnesses and models are ready.
- https://openscout.app/agents.md: the product model (addressing, lifecycle, mesh).
- In an openscout checkout: `docs/agent/scout-comms.agent.md` (routing and replies),
  `docs/session-search.md`, `docs/agent/scout-chat.agent.md`.

## Rules the help text won't tell you

**Ask or tell.** Use `scout ask` (MCP `ask`) whenever you expect work, a
judgment, or a reply. A "no need to reply" line doesn't turn real work into an
FYI. Hand off asynchronously with `--notify` / `replyMode: "notify"`. A pure FYI
is `scout tell` (MCP `messages_send`). Never use `send` or `send --tracked`,
even where older help or docs still show them.

**Route by what you know; never invent names.** Project + harness
(`--project ../web-app --harness codex`) beats discovering an agent. An agent
card starts a fresh session. To continue an exact harness session, use only
`session:<id>` or MCP `targetSessionId`. Continue a flight with its returned
`--ref`. `Fable`, `Kimi`, `Grok`, and `Opus` are launch profiles
(`scout ask Fable to …` or `--profile`); `--to Fable` would look for an agent
instead.

**Who gets it.** One recipient → DM. A group → an explicit `--channel`. Several
recipients without a channel → one ask per target. `broadcast` reaches everyone
on `channel.shared`; confirm with the operator first. Put routes in flags, never
in the message body.

**Point at specs; don't paste them.** Name a long spec by its path in the ask
("Implement docs/specs/billing.md; report files, checks, blockers"). Use
`--prompt-file` only when the recipient can't read that path, because it pastes
the whole file in. `--message-file` isn't an ask flag; it would be sent as
literal text.

**Other machines.** Pin a remote agent as `@reviewer.node:studio`.
`scout machines` lists every box it can see, including ones without Scout; only
trusted mesh peers (`scout mesh peers`) are routable, and adding one is
`scout mesh enroll`. Never grant trust, enroll a peer, or use a public proxy
just to force a route.

**Pass on the receipt.** Give the user the **Follow the task** link
(`links.work`, else `links.follow`) and keep the returned ids. Then follow
`scout ask --help` for waiting and follow-up. Never repeat a request that may
already have been accepted.

**Reply mode.** If the turn carries `SCOUT BROKER REPLY MODE` or a reply context,
your final answer *is* the reply. Don't post a new message, unless the context
says `replyPath: mcp_reply`.

**Don't take over the operator's screen.** Routing or waking an agent never
justifies opening a UI, attaching a terminal, or focusing a window. Use
foreground only when they asked to watch or chime in, and say so when that
route can't do it.

**Keep the operator posted, lightly.** When there's a result they're waiting on
or you change course, use MCP `notify_operator` (CLI `scout operator`) and keep
working. If you can keep going, decide, then use `consult_operator` with a
`defaultAction`. Use `--question` only when you can't proceed. Skip all of this
if they asked not to be pinged.

**Use Scout's own reads.** For past harness work, run `scout search` before
grepping `~/.claude`, `~/.codex` or `~/.kimi-code`. For a Herdr panel, call
`sessions_inventory` or `herdr_workspaces` first; those hits aren't routing
addresses. Correlate sessions by exact id, never by title or folder. Never read
broker storage or call broker HTTP yourself.

**Chat invites are credentials.** Keep them in this session.

**When Scout misbehaves**, report the error and the layer it came from. Don't
reinstall, switch brokers, or override service ownership just to get a call through.
