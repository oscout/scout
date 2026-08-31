<p align="center">
  <a href="https://openscout.app">
    <img src="https://openscout.app/og.png" alt="Scout — one place for all your agents, local-first and neutral by design" width="100%" />
  </a>
</p>

<p align="center">
  <strong>The coordination layer for the coding agents you already run.</strong><br />
  Discover agents, dispatch work, send messages, and follow progress across the tools you already use.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@openscout/scout"><img alt="npm version" src="https://img.shields.io/npm/v/@openscout/scout?style=flat-square&amp;label=npm&amp;color=94d59a&amp;labelColor=171a16" /></a>
  <a href="https://bun.sh"><img alt="Bun 1.3 or newer" src="https://img.shields.io/badge/runtime-Bun_%E2%89%A5_1.3-f7f4ea?style=flat-square&amp;labelColor=171a16&amp;logo=bun" /></a>
  <a href="https://github.com/oscout/scout/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-f7f4ea?style=flat-square&amp;labelColor=171a16" /></a>
  <a href="https://openscout.app"><img alt="OpenScout project homepage" src="https://img.shields.io/badge/project-openscout.app-dde6d8?style=flat-square&amp;labelColor=171a16" /></a>
</p>

---

Scout is a local-first control plane for AI agents. It sits underneath Claude
Code, Codex, Cursor, Pi, and other harnesses, giving them one durable broker for
discovery, messages, work, and routing without moving agents out of the tools
where they already run.

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

Scout requires [Bun 1.3 or newer](https://bun.sh). The full broker and service
package currently targets Apple Silicon macOS.

```bash
bun add -g @openscout/scout
scout setup
scout doctor
```

Prefer npm for global packages? `npm install -g @openscout/scout` installs the
same package; Bun is still required at runtime.

Installing the package does not silently start services. `scout setup`
configures the local broker and attempts to start it explicitly; `scout doctor`
then verifies that the broker and project inventory are healthy.

## Make your first handoff

Route work by project and harness instead of guessing an agent name:

```bash
scout whoami
scout runtimes
scout ask --project . --harness codex \
  "Review this repository and return the three highest-leverage improvements."
```

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

Scout has host integrations for Claude Code, Codex, Cursor, Pi, and Hermes, plus
MCP, ACP, Slack, Telegram, voice, and webhook paths where those transports are
configured. The broker provides the shared coordination model; each harness
keeps its native runtime and workflow.

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
- [Current status and scope](https://openscout.app/docs/current-posture)
- [Public source](https://github.com/oscout/scout)
- [Issues](https://github.com/oscout/scout/issues)

## License

Apache-2.0. See the [license](https://github.com/oscout/scout/blob/main/LICENSE)
and [notice](https://github.com/oscout/scout/blob/main/packages/cli/NOTICE).
