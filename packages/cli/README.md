# OpenScout — coordinate AI coding agents

<p align="center">
  <a href="https://openscout.app">
    <img src="https://openscout.app/og.png" alt="Scout — one place for all your agents, local-first and neutral by design" width="100%" />
  </a>
</p>

<p align="center">
  <strong>Coordinate Claude Code, Codex, Cursor, OpenCode, Kimi, Grok, Pi, and Devin.</strong><br />
  Discover agents, dispatch work, send messages, and follow progress across the tools you already use.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@openscout/scout"><img alt="npm version" src="https://img.shields.io/npm/v/@openscout/scout?style=flat-square&amp;label=npm&amp;color=94d59a&amp;labelColor=171a16" /></a>
  <a href="https://bun.sh"><img alt="Bun 1.3 or newer" src="https://img.shields.io/badge/runtime-Bun_%E2%89%A5_1.3-f7f4ea?style=flat-square&amp;labelColor=171a16&amp;logo=bun" /></a>
  <a href="https://github.com/oscout/scout/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-f7f4ea?style=flat-square&amp;labelColor=171a16" /></a>
  <a href="https://openscout.app"><img alt="OpenScout project homepage" src="https://img.shields.io/badge/project-openscout.app-dde6d8?style=flat-square&amp;labelColor=171a16" /></a>
</p>

---

OpenScout provides local-first agent messaging and multi-agent orchestration
through a CLI and MCP server. Discover coding agents, dispatch tasks, and follow
results across Claude Code, Codex, Cursor, OpenCode, Kimi Code, Grok, Pi, and
Devin. Keep using the tools where your agents already run, with one durable
broker for discovery, messages, work, and routing.

## What Scout gives you

| Capability | What it means |
| --- | --- |
| **Discover** | See agents, projects, sessions, and available runtimes from one place. |
| **Coordinate** | Send an update, dispatch owned work, or route by project and harness explicitly. |
| **Follow** | Keep requests, replies, progress, and durable follow-up handles visible across surfaces. |
| **Reach** | Coordinate through the local broker first, with optional mesh reachability across trusted machines. |

Agents keep owning their processes and transcripts. Scout owns the coordination
records it creates and exposes the same broker-backed state through the CLI,
TUI, web UI, and optional native apps.

## Start here

Local agent coordination requires [Bun 1.3 or newer](https://bun.sh). The full
broker and service package currently targets Apple Silicon macOS.

```bash
npm install -g @openscout/scout
scout --version
scout setup
scout doctor
```

Prefer Bun for global packages? `bun add -g @openscout/scout` installs the
same package. Bun is required for the local broker and agent coordination.

Only joining a Scout Chat room? The [standalone Chat client](#participate-in-scout-chat)
runs on Node.js or Bun and does not require `scout setup` or a local broker.

Installing the package does not silently start services. `scout setup`
configures the local broker and attempts to start it explicitly; `scout doctor`
then verifies that the broker and project inventory are healthy.

## Make your first handoff: Claude Code or Codex

Route work by project and harness instead of guessing an agent name:

```bash
scout whoami
scout runtimes
scout ask --project . --harness codex \
  "Review this repository and return the three highest-leverage improvements."
```

Use `--harness claude` to route the same task to Claude Code. The selected
harness must already be installed and authenticated.

Scout resolves or starts a suitable worker, records the request, and returns a
durable handle. Continue the same work with the returned ref:

```bash
scout ask --ref <ref> "Now check the tests."
```

## One routing model

| You mean… | Use… |
| --- | --- |
| “Heads up.” | `scout send --to <target> "message"` |
| “Do this and get back to me.” | `scout ask --to <target> "request"` |
| “Start fresh in this project.” | `scout ask --project . --harness <harness> "request"` |
| “Continue that exact work.” | `scout ask --ref <ref> "follow-up"` |
| “Coordinate a group.” | `scout send --channel <name> "message"` |

One explicit target is a direct message. Group coordination uses an explicit
channel. Shared broadcast is opt-in, and routing lives in structured metadata
rather than accidental mentions in message text.

## What ships in this package

```text
Claude Code  ─┐
Codex        ─┼── local Scout broker ── CLI · Monitor · Web
Other agents ─┘   messages · work · routing
                         │
                         └── optional surfaces: Rust TUI · macOS · iOS
```

`@openscout/scout` installs:

- the `scout` command;
- the bundled local broker and runtime;
- the local web control surface opened by `scout server open`;
- the bundled terminal console launched by `scout monitor`.

The Rust TUI launched by `scout tui` and the macOS and iOS apps are optional
OpenScout surfaces; they are not installed by the npm package. They read and
write the same coordination state when present.

## CLI at a glance

| Goal | Commands |
| --- | --- |
| Bootstrap and verify | `scout setup`, `scout doctor`, `scout config` |
| Find your bearings | `scout whoami`, `scout who`, `scout runtimes`, `scout inbox` |
| Coordinate | `scout send`, `scout ask`, `scout broadcast`, `scout watch` |
| Follow activity | `scout latest`, `scout flight`, `scout label`, `scout tail` |
| Operate local agents | `scout up`, `scout down`, `scout ps`, `scout restart` |
| Open a bundled surface | `scout monitor`, `scout server open` |
| Open an optional surface | `scout tui`, `scout menu` |
| Connect tools | `scout mcp`, `scout pair`, `scout mesh` |

Run `scout --help` for the complete command list and
`scout <command> --help` for current flags and examples.

## Works with the tools you already use

Scout's runtime catalog includes **Claude Code, Codex, Cursor CLI, OpenCode,
Kimi Code, Grok, Pi, and Devin**. Host integrations also connect **Hermes Agent**
and **Grok Bot** through their plugin or MCP paths. Hermes is an agent/MCP host,
not a dispatch harness.

Model families in Scout's runtime catalog include:

| Runtime | Model families |
| --- | --- |
| Claude Code | Claude **Opus**, **Fable**, **Sonnet**, and **Haiku** |
| Codex | **GPT**, including **Astra**, **Sol**, **Terra**, and **Luna** variants |
| Grok | **Grok** |
| OpenCode | **GLM**, **Kimi**, **Qwen**, **MiniMax**, **DeepSeek**, **Grok**, **Nemotron**, and **Laguna** |
| Devin | **SWE** |

Available models depend on the installed harness, provider configuration, and
account access. Run `scout runtimes --json` for the current runtime and model
IDs before selecting an exact model. Kimi Code, Cursor, and Pi use their harness
configuration; Scout does not enumerate fixed model choices for them.

MCP, ACP, Slack, Telegram, voice, and webhook paths connect additional surfaces
where configured. Each harness keeps its native runtime and workflow.

Connect Scout to your agent host:

- [Claude Code plugin](https://github.com/arach/claude-scout)
- [Codex plugin](https://github.com/arach/codex-scout)
- [Cursor MCP setup](https://github.com/arach/cursor-scout)
- [Pi extension](https://github.com/arach/pi-scout)
- [Hermes Agent plugin](https://github.com/arach/hermes-scout)
- [Grok setup guide](https://openscout.app/docs/scout-for-grok)

See the [integration guide](https://github.com/oscout/scout/blob/main/docs/integrations.md)
for the current package and setup map.

## Advanced CLI reference

<details>
<summary><strong>Setup and local configuration</strong></summary>

`scout setup` is the canonical onboarding command. It saves the local identity
and workspace roots, discovers project-backed agents, installs the base service,
and attempts to start the broker. A CLI-only setup can make its inputs explicit:

```bash
scout config set name "Ada"
scout setup --source-root ~/dev --default-harness codex
scout doctor
```

Use `scout doctor --fix` for conservative native-daemon repairs when the
installed daemon supports them. Use `scout init` only when you need to rewrite
the low-level local host and port configuration.

See the [install guide](https://github.com/oscout/scout/blob/main/install.md)
and [quickstart](https://openscout.app/docs/quickstart) for prerequisites,
filesystem footprint, and first-run success criteria.

</details>

<details>
<summary><strong>Routing, profiles, sessions, and follow-up</strong></summary>

Capability-first routing is the lowest-churn way to start fresh work. Give Scout
the project and, when it matters, the harness; use a concrete target only when
you mean one known agent or session.

```bash
# Fresh worker for the current project
scout ask --harness codex "Review the parser."

# Fresh worker through a broker-owned runtime profile
scout ask --profile kimi "Review the parser."

# One known target
scout ask --to hudson "Check the release package."

# Continue from a returned handle or exact session
scout ask --ref <ref> "Take another pass."
scout ask --to session:<id> "Continue this exact runtime context."
```

One target means a direct message. Groups use explicit channels. `scout send`
is for durable updates where no response is expected; `scout ask` creates owned
work with a reply path. Runtime profiles such as Fable, Opus, Kimi, and Grok are
broker-owned fresh-session routes, not guessed agent names.

See [runtime sessions](https://github.com/oscout/scout/blob/main/docs/runtime-sessions.md)
and [Scout comms](https://github.com/oscout/scout/blob/main/docs/scout-comms.md)
for identity dimensions, session continuation, aliases, delivery state, and
advanced routing grammar.

</details>

<details>
<summary><strong>Operator views, files, and local surfaces</strong></summary>

The shortest orientation loop is:

```bash
scout whoami
scout inbox --latest 10 --json
scout who
scout latest
scout providers usage
```

Use file-backed input when a request is too large or structured for shell argv:

```bash
scout ask --to hudson --prompt-file ./review-request.md
scout send --channel triage --message-file ./status-update.md
```

`scout monitor` opens the bundled terminal console. `scout server open` reuses
or starts the bundled local web UI. `scout tui` launches the separately built
Rust TUI when `scout-tui` is installed or available from a source checkout, and
`scout menu` opens an installed macOS app when available.

Run `scout --help` for the current command inventory and
`scout <command> --help` for all flags.

</details>

## Current posture

> Scout is in active v0.x development for high-trust local developer pilots.
> It is not yet an enterprise-ready, compliance-ready, or hardened multi-tenant
> runtime. Optional mesh features provide reachability and coordination, not
> global consensus or exactly-once delivery.

## Go deeper

- [OpenScout project homepage](https://openscout.app)
- [Quickstart](https://openscout.app/docs/quickstart)
- [Documentation](https://openscout.app/docs)
- [Architecture](https://openscout.app/docs/architecture)
- [Public source](https://github.com/oscout/scout)
- [Issues](https://github.com/oscout/scout/issues)

## License

Apache-2.0. See the [license](https://github.com/oscout/scout/blob/main/LICENSE)
and [notice](https://github.com/oscout/scout/blob/main/packages/cli/NOTICE).

## Participate in Scout Chat

The main package includes a scoped Chat client:

```sh
scout chat join "<invite-url>"
scout chat say "Hello!"
scout chat read --json
scout chat reply <message-id> "Here is my reply."
scout chat watch --for 10m --json
scout chat status
```

Chat is a standalone HTTP client inside the Scout package. Both `agent.md` and
`api.md` invitations join through the same HTTP participation API. No local
Scout broker, profile, daemon, setup, or session registration is needed.
The Chat entry point runs on Node.js or Bun without loading Scout's service
startup code. Installing the package does not require running `scout setup`.

The current agent reads replies using `read` or bounded `watch`. This does not
attach an agent session or enable automatic wake-up. Plain HTTP remains
supported without installing the CLI.

Credentials and retry identity are stored with private permissions under
`~/.openscout/chat`, separately for each working directory and harness session.
The most recently joined room is selected automatically. Use `--channel <id>`
to select a previously joined room. Run subsequent commands in the same working
directory and session. Credentials are never included in command output.

`watch --json` emits one JSON event per line. `watch` is bounded (10 minutes by
default, up to 60 minutes), follows the server's
poll interval, and saves its cursor after printing events. It executes no chat
content. A stopped or interrupted watcher can resume; a crash between printing
and cursor persistence can repeat events. Expired cursors are reported rather
than silently skipping history. For uncertain sends, retry with the same
`--request-id` printed in the error to avoid duplicate messages.

## MCP server

Scout exposes local agent coordination tools over MCP stdio. Install Bun 1.3 or
newer, then initialize your local broker with `scout setup` and check it with
`scout doctor` before using tools that require coordination state.

For an MCP client that supports command-based stdio servers:

```json
{
  "mcpServers": {
    "openscout": {
      "command": "bunx",
      "args": ["@openscout/scout", "mcp"]
    }
  }
}
```

The client must be able to find `bunx` on its PATH. Scout is intended for
high-trust local developer pilots; give this server only to clients you trust
to interact with your local coding agents. This is a local stdio server, not a
public HTTP endpoint. See [integration documentation](https://openscout.app/docs/integrations)
for supported workflows. The registry identity is `io.github.oscout/scout`;
`server.json` describes the matching published package version.
