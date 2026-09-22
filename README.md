<p align="center">
  <img src=".github/assets/readme-hero.svg" alt="Scout — your personal agent cloud" width="100%" />
</p>

<p align="center">
  <strong>Your personal agent cloud.</strong><br />
  A local control plane and mesh network for coding agents across the machines you own.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@openscout/scout"><img alt="npm version" src="https://img.shields.io/npm/v/@openscout/scout?style=flat-square&label=npm&color=94d59a&labelColor=171a16" /></a>
  <a href="https://github.com/oscout/scout/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-f7f4ea?style=flat-square&labelColor=171a16" /></a>
  <a href="https://openscout.app"><img alt="OpenScout" src="https://img.shields.io/badge/built_for-OpenScout-dde6d8?style=flat-square&labelColor=171a16" /></a>
</p>

---

Scout is the CLI, broker, runtime, protocol, and web control surface behind the
OpenScout agent mesh. It gives Codex, Claude Code, Cursor, Pi, and future
harnesses one explicit coordination model instead of a pile of one-off relays.
It also implements a **Model Context Protocol (MCP) server** that exposes local
agent coordination tools to MCP clients over stdio. See [MCP setup](#mcp-server).

> **Local control plane + mesh network = your personal agent cloud.** Control
> stays with you while Scout makes sessions reachable and useful across your
> own machines.

> **Current posture:** Scout is for high-trust local developer pilots. It is
> not yet a hardened multi-tenant or compliance-ready control plane.

## Start on Apple-silicon macOS in 60 seconds

Scout uses [Bun](https://bun.sh) 1.3 or newer as its runtime.

```bash
bun add -g @openscout/scout

scout setup
scout doctor
scout who
```

On Linux, Scout uses the same package but runs its broker as a foreground
process under your process manager. Follow the [quickstart](./docs/quickstart.md)
for that lifecycle.

Then route real work from any project:

```bash
scout ask --project . --harness codex \
  "Review this repository and return the three highest-leverage improvements."
```

Scout resolves or starts the right local session, records the request with the
broker, and returns durable handles for follow-up.

## MCP server

OpenScout includes an MCP server implemented with the official TypeScript
`@modelcontextprotocol/sdk`, using `McpServer` and `StdioServerTransport`.
The `scout mcp` command starts it over stdin/stdout. MCP clients call tools that
connect to Scout's local broker; the internal Scout protocol describes broker
records and is separate from the MCP interface exposed to clients.

### Install and connect

Requires **Bun 1.3 or newer** on macOS or Linux. Initialize the local broker
before using coordination tools:

```bash
bun add -g @openscout/scout
scout setup
scout doctor
```

Add this entry to an MCP client's command-based stdio configuration:

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

The client must be able to find `bunx` on its PATH. The client launches the
server and communicates over stdio; this command does not start a public HTTP
MCP endpoint. Only connect trusted clients: coordination tools can launch local
coding agents, send messages, and update broker-owned work.

### MCP tools

Representative tools exposed by the server:

| Tools | Purpose |
| --- | --- |
| `whoami` | Identify the current broker actor and project context. |
| `agents_search`, `agents_resolve` | Discover and resolve coding-agent targets. |
| `ask` | Request work, investigation, review, or a reply from an agent. |
| `messages_send`, `messages_inbox`, `messages_reply` | Send updates, read messages, and reply in context. |
| `invocations_get`, `invocations_wait` | Observe an existing flight and its result. |
| `work_update` | Report progress or change the state of existing work. |

Use MCP `tools/list` to inspect the current tool names and input schemas.
`ask` creates owned work; `messages_send` is for updates that need no reply.
The broker remains the canonical writer of coordination records.

### Implementation and verification

- [MCP server implementation](./apps/desktop/src/core/mcp/scout-mcp.ts): SDK imports, tool registrations, and stdio transport.
- [CLI entry point](./apps/desktop/src/cli/commands/mcp.ts): the `scout mcp` command.
- [MCP tests](./apps/desktop/src/core/mcp/scout-mcp.test.ts): client/server connection, `tools/list`, and tool behavior.
- [Package registry metadata](./packages/cli/server.json): `io.github.oscout/scout`, npm package, and stdio launch arguments.
- [MCP API guide](./docs/mcp-api-posture.md) and [CLI setup guide](./packages/cli/README.md#mcp-server).

## The small model

| You mean… | Use… | What Scout records |
| --- | --- | --- |
| “Heads up.” | `scout send --to <target>` | A durable message |
| “Do this and get back to me.” | `scout ask --to <target>` | An invocation, flight, and reply path |
| “Start fresh in this project.” | `scout ask --project . --harness <harness>` | A capability-routed session |
| “Continue that exact run.” | `scout ask --to session:<id>` | A continuation on one concrete session |
| “Coordinate the group.” | `scout send --channel <name>` | An explicit channel message |

One target is a DM. Group coordination uses a named channel. Broadcast is
opt-in. Routing lives in structured metadata—not in accidental `@mentions`
inside the message body.

## One broker, many surfaces

<!-- arc:control-plane:start -->

<!-- Generated from .github/diagrams/control-plane.arc.json by @arach/arc. -->

```text
                                                    ╔══════════════════════╗
                     ╔══════════════════════╗       ║ ◆ Local broker       ║
                     ║ ◆ Scout surfaces     ║       ║ canonical writer     ║
┌────────────────┐   ║ CLI + local web      ║   ┌──▶║ route + run          ║
│ ◆ Operator     │ ┌▶║ one control plane    ║───┘   ║                      ║
│ or agent       │─┘ ║                      ║       ╚══════════════════════╝
└────────────────┘   ╚══════════════════════╝                   │
                                                                │
                                                                │
                                              ┌─────────────────┴─────────┐
                                              │                           │
                                              ▼                           │
                                  ╔═══════════════════════╗               ▼
                                  ║ ◆ Harnesses + mesh    ║      ┌────────────────┐
                                  ║ Codex · Claude · ACP  ║      │ ◆ Records      │
                                  ║ reachable peers       ║      │ durable        │
                                  ║                       ║      │                │
                                  ╚═══════════════════════╝      └────────────────┘
```

<!-- arc:control-plane:end -->

The broker is the canonical writer for Scout-owned coordination records.
Harness transcripts remain observed source material; Scout does not bulk-import
them as first-party conversation history. “Mesh” means reachability and
coordination—not global consensus or exactly-once delivery.

## What ships here

| Surface | Path | Role |
| --- | --- | --- |
| CLI package | [`packages/cli`](./packages/cli) | `scout` command and bundled distribution |
| Broker/runtime | [`packages/runtime`](./packages/runtime) | routing, mesh, pairing, knowledge, durable work |
| Shared protocol | [`packages/protocol`](./packages/protocol) | wire types, identities, runtime catalog |
| Harness sessions | [`packages/agent-sessions`](./packages/agent-sessions) | observed session descriptors and lifecycle |
| Web control plane | [`packages/web`](./packages/web) | baseline local operator UI, reusable web primitives, app shell, and local server |
| Trace tooling | [`packages/session-trace`](./packages/session-trace) | portable trace model and React viewer |
| Native services | [`crates`](./crates) | `scoutd`, repo service, portable voice core |

### Public core, private product

This is the destination for Scout's strong public primitives **and** a complete
baseline web control plane. A public installation should support the ordinary
local workflow—setup and health, agents and sessions, conversations and
requests, work and activity, runtimes, projects, mesh, and settings—without
private-only placeholders.

The product split is an active migration, not a claim that the repositories and
release pipeline have already been cut over. The target is one-way: the private
OpenScout product consumes exact released public packages and adds native apps,
hosted services, advanced operations, and product-specific UI through trusted
build-time web composition. It must not carry copied public source or a mirrored
`packages/web`, and public Scout must never depend on private code.

See the [public-source boundary](./docs/public-source-boundary.md) for current
migration status, target ownership, and release invariants.

## Work on Scout

```bash
git clone https://github.com/oscout/scout.git
cd scout
bun install

bun run --cwd packages/cli build
./packages/cli/bin/scout --version
```

Run `bun run sync-exec:fence` before submitting changes that add or modify shell
execution. Use the package-local checks for the area you changed; the complete
suite is available through `bun run check` and `bun run test:unit`.

## Go deeper

- [Install and verify](./install.md) — supported installation paths and clear success criteria
- [CLI guide](./packages/cli/README.md) — setup, routing, profiles, sessions, and operator commands
- [Runtime guide](./packages/runtime/README.md) — broker and runtime internals
- [Protocol guide](./packages/protocol/README.md) — integration contracts and shared types
- [Agent sessions](./packages/agent-sessions/README.md) — harness observation and session models
- [Public-source boundary](./docs/public-source-boundary.md) — what ships here and how package/source parity stays verifiable
- [Release guide](./docs/releases.md) — reviewed-source, package, tag, and registry invariants
- [OpenScout for macOS](./releases/macos/README.md) — public downloads, updater trust, and verification
- [Architecture diagram source](./.github/diagrams/control-plane.arc.json) — editable Arc model behind the README diagram
- [Brand assets](./.github/assets/README.md) — canonical mark, hero, avatar, and social preview sources
- [OpenScout](https://openscout.app) — product context and project home

## License

Apache-2.0. See [LICENSE](./LICENSE).
