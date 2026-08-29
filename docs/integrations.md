# Host Integrations

OpenScout's core broker, runtime, protocol, CLI, desktop app, and mobile app live
in this repository. Host-specific integrations can live beside this repo when
they are independently installable packages for another host's install surface.

This keeps the OpenScout root focused on the product control plane while still
making the integration surface discoverable.

## Current Integrations

| Host | Repository | Page | Purpose |
| --- | --- | --- | --- |
| Slack | [`packages/slack`](../packages/slack) | [Scout for Slack](../packages/slack/README.md) · [setup skill](../.agents/skills/setup-scout-slack/SKILL.md) | Socket Mode bridge from mentions, DMs, threads, and files into durable Scout coding work. |
| pi | [`arach/pi-scout`](https://github.com/arach/pi-scout) | [`arach.github.io/pi-scout`](https://arach.github.io/pi-scout/) | pi extension for Scout `send`, `ask`, `who`, and broker-backed coordination from pi sessions. |
| Claude Code | [`arach/claude-scout`](https://github.com/arach/claude-scout) | [`arach.github.io/claude-scout`](https://arach.github.io/claude-scout/) | Claude Code plugin with `/scout:*` commands and Scout channel integration. |
| Codex | [`arach/codex-scout`](https://github.com/arach/codex-scout) | [`arach.github.io/codex-scout`](https://arach.github.io/codex-scout/) | Codex plugin with Scout MCP tools and coordination guidance. |
| Cursor | [`arach/cursor-scout`](https://github.com/arach/cursor-scout) | [`arach.github.io/cursor-scout`](https://arach.github.io/cursor-scout/) | Cursor MCP configuration and installer that points Cursor at `scout mcp`. |
| Hermes Agent | [`arach/hermes-scout`](https://github.com/arach/hermes-scout) | [`github.com/arach/hermes-scout`](https://github.com/arach/hermes-scout) | Hermes plugin that bridges Scout MCP tools into Hermes sessions. |
| Herdr | [`ogulcancelik/herdr`](https://github.com/ogulcancelik/herdr) | [`herdr.dev/docs`](https://herdr.dev/docs/) | Terminal host and agent-state surface for observing and controlling supported agent panes around Scout-compatible sessions. |

## Compatibility Model

Scout uses **host integration** as the umbrella term for first-class
compatibility with another agent tool, terminal host, or IDE. A host integration
can contribute one or more roles:

- execution harness: Scout can route work into a session backed by that runtime
- agent host: the tool can host a Scout-aware agent surface or plugin
- MCP host: the tool can connect to `scout mcp`
- terminal host: the tool can expose or control terminal panes that contain
  Scout-compatible sessions
- agent-state surface: the tool can report lifecycle, focus, approval, or
  session state around agents Scout cares about

`harness` remains the narrower runtime field. Claude Code, Codex, Cursor, and
pi can be harness-backed execution targets. Hermes and Herdr are first-class
host integrations, but they are not Scout harnesses: Hermes is an agent/MCP
host, and Herdr is a terminal host plus agent-state surface. Do not add
`hermes` or `herdr` to `--harness` or `execution.harness` unless an explicit
execution adapter is implemented.

## Shared Routing Guidance For Integrations

Every host integration should teach the same low-churn workflow:

1. **Capability request:** pass project directory plus optional harness/capability
   (`projectPath` + `harness`, or `scout ask --project <path> --harness <rt>`).
2. **Broker dispatch:** let Scout choose/wake/create a compatible worker instead
   of asking the user or agent to guess names such as `claude.main`.
3. **Durable handle:** display the returned `ref`, `flightId`, `conversationId`,
   `workId`, session id, and any broker-suggested situated target handle.
4. **Follow-up:** continue by that handle. Humans type saved situated targets as
   `target:<name>`; agents and compact UI may render the same handle as
   `⌖name`.
5. **Promotion:** name or pin a long-lived sibling only after the routed worker is
   known good, preferably using the broker-suggested mnemonic.

Integrations should expose `projectPath` and `harness` in their ask surfaces
where the host allows it. `who`/resolve/search remain useful for inspecting or
disambiguating a specific target, but they are not a required preflight for
project-routed work.

## Relationship To This Repo

Use links and install docs rather than git submodules by default.

Submodules are useful when this repo must build, test, or vendor another
repository at an exact commit. The current Scout host integrations do not need
that coupling: they shell out to the installed `scout` CLI or talk to the local
broker, and their compatibility boundary is the published Scout protocol and CLI
behavior.

Keep integration source in a separate repository when:

- the host has its own plugin marketplace or install flow
- the integration can be installed without cloning OpenScout
- the package should have its own release cadence
- the integration depends on Scout's public CLI/protocol surface rather than
  private app internals

Keep integration source in this repository when:

- it depends on unreleased internal code
- it is still shaping the core protocol or broker API
- local product development needs cross-package changes in one commit

## Local Development

Recommended sibling checkout layout:

```plaintext
~/dev/
├── openscout/
├── pi-scout/
├── claude-scout/
├── codex-scout/
├── cursor-scout/
├── hermes-scout/
└── herdr/
```

That layout keeps the product repo clean while making related host integrations
easy to work on side by side.
