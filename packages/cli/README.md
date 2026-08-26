# Scout CLI

The `scout` command is the front door to the local Scout control plane. It
discovers coding-agent sessions, routes messages and work through the broker,
and returns durable handles for follow-up across harnesses and machines.

> **Requires [Bun](https://bun.sh) 1.3 or newer.** The bundled native service
> supports Apple-silicon macOS. Linux runs the broker as a foreground process
> under your process manager. On macOS, install Bun with `brew install bun`.

## Install

```bash
bun add -g @openscout/scout
scout --help
```

`@openscout/scout` is the public package name. It installs the `scout` command and carries the bundled broker/runtime and web UI. Installing it does not start services; commands such as `scout setup`, `scout up`, and `scout server start` activate them explicitly.

On Linux, `scout setup` initializes the local state but cannot install or start
a system service. Run `openscout-runtime broker` in a separate supervised
process, then use `scout doctor` from another shell to verify readiness.

## Canonical Flow

```bash
scout setup
scout doctor
scout whoami
scout who
scout latest
scout runtimes
scout providers usage
scout ask --project ../talkie --harness claude "can you review our docs?"
```

`scout setup` is the canonical onboarding entry point. It creates or updates:

- `~/Library/Application Support/OpenScout/settings.json`
- `~/Library/Application Support/OpenScout/relay-agents.json` as compatibility
  configuration that the broker reconciles into its canonical live state
- `.openscout/project.json` for the current repo when needed

It also discovers local and project-backed agents from your configured workspace roots, installs the base Scout service, attempts to start it, and ensures Caddy is available for the local `scout.local` edge. On macOS, setup installs missing Caddy with `brew install caddy`; otherwise install Caddy yourself or set `OPENSCOUT_CADDY_BIN`.

`scout doctor --fix` asks the native `scoutd` daemon to run conservative repairs
when that daemon version exposes them. Use `scout doctor --fix --yes` for
non-interactive install scripts; older or missing `scoutd` binaries simply leave
the normal doctor report intact.

For a CLI-only onboarding pass, save the same identity, workspace roots, and
runtime choice used by the app flows:

```bash
scout config set name "Ada"
scout setup --source-root ~/dev --default-harness codex
scout runtimes
```

`scout setup` creates `~/.openscout/config.json` when it is missing. Use
`scout init` when you only want to rewrite the local host/port config, for
example `scout init --force --broker-port 43110 --web-port 43120
--pairing-port 43130`.

When the input is not a known subcommand and includes exactly one `@agent` mention, Scout treats it as an implicit `ask`: it records durable work with the broker, waits for the target to acknowledge or complete immediately, and leaves later completion visible through the conversation or flight follow-up. For example:

```bash
scout @dewey can you review our docs?
scout hey @hudson please inspect the failing test
scout --as vox --timeout 900 @talkie take another pass on the keyboard port
```

Reserved leading profile names are deterministic fresh-session routes for the
current project, not shorthand agent names:

```bash
scout ask Fable to review the parser
scout ask Opus high to fix the tests
scout ask --profile kimi "review the parser"
```

The broker owns each profile's harness/model/default mapping. `--effort` is an
optional Fable/Opus override; Kimi and Grok reject it until their ACP transports
expose reasoning-effort control. Direct `scout ask --to fable ...` always means
an existing target named `fable`; it is never silently converted to a profile.

For a natural-language existing target, use an explicit `agent` prefix and
`to` delimiter:

```bash
scout ask agent Composer Review to fix the tests
```

Scout normalizes that name to exact handle `@composer-review`. Zero or multiple
agent/session matches fail with disambiguation instead of choosing by locality
or similarity.

## One Routing Model

The routing rules do not change by harness, UI, or host:

- one target -> DM
- group coordination -> explicit channel
- everyone -> `scout broadcast`
- tell / update -> `scout send`
- owned work / requested reply -> `scout ask`
- follow-up stays in the same DM or explicit channel

Short mutable callback names are broker-owned route aliases:

```bash
scout alias set review --to scope.main.dev-mac-mini-local
scout alias set patch --to session:019eff52-9347-7470-ba5c-6bfe99d8dd83
scout alias resolve patch
scout alias repoint patch --to session:<new-id> --if-revision 1
scout alias unset patch --if-revision 2
scout ask --to alias:review "take a fresh pass"
```

Aliases are scoped to the current project/local host unless `--project` or
`--host` is supplied. They point at existing targets and never create or rename
cards. Native bare agent names win; `alias:<name>` is the explicit form.

The lowest-churn fresh start is **capability first**: pass the project path and
optional harness, then let the broker choose or create the concrete worker.
Do not guess generic names like `claude.main` just because you want Claude. Use
the returned `ref`, flight, conversation, work, or session handle for follow-up.
If the worker proves useful, promote it to a named/pinned sibling after the fact
using the broker-suggested handle when one is returned.

When sender, target, or recent activity is unclear, the shortest orientation loop is:

```bash
scout whoami
scout inbox --latest 10 --json
scout who
scout channel triage --latest 10 --json
scout latest
scout latest --channel triage --messages --limit 3
```

Use `channel <name> --latest <count> --json` for the cheapest agent-facing
channel catch-up. It reads broker messages for that channel and exits. Use
`latest --channel <name>` when you want the compact activity projection instead.
Use `inbox --latest <count> --json` for direct messages addressed to the
current inferred agent identity.

CLI agents should use these commands rather than curling broker HTTP endpoints
or reading relay files directly.

### Sender identity

`scout send`, `scout ask`, and `scout broadcast` all use the
same default sender identity. Most of the time you should let Scout infer it
from your current context. For agent-to-agent delegation, check `scout whoami`
first and use `--as` whenever the acting project agent must be preserved
explicitly across shells, hosts, or bridges.

`scout watch` follows a conversation or channel; it does not choose a sender.

Inspect the current default once:

```bash
scout whoami
```

Default sender resolution is:

1. `--as <agent>` for that command
2. `OPENSCOUT_AGENT` when the current session already has a bound agent
3. the current project-scoped sender inferred from your working directory
4. your operator name when you're outside a project context

Coding-agent hosts use the project-scoped sender for `scout ask` automatically when
the CLI detects a host harness signal:

- **Scout-managed:** `OPENSCOUT_AGENT`, `OPENSCOUT_MANAGED_AGENT`
- **Cursor:** `CURSOR_AGENT=1`
- **Claude Code:** `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_REMOTE`, session ids
- **Codex:** `CODEX_THREAD_ID`, `CODEX_CI=1`, `CODEX_SANDBOX`, proposed `AGENT=codex`

Run `scout whoami --json` to see which signal matched. Human terminal shells still
default to `operator` unless `--as` or a host signal is present.

That keeps ordinary collaboration simple:

```bash
scout send --to vox "heads up: I’m on the runtime side"
scout ask --to vox "can you confirm the broker fix?"
scout ask --project ../talkie --harness claude "review the build spec"
scout ask --harness codex "review this in a fresh Codex worker"
```

Known on-demand or offline agents are supposed to wake on first delivery. `scout send` and `scout ask` should be the default path; `scout up` is for explicit prewarming or for creating/registering a target the broker does not know yet.

Prefer `scout send --to <agent> "message"` for tells. Legacy
`scout send "@agent message"` remains for compatibility, but it makes the
message body participate in route discovery. With `--to`, quoted handles inside
the text stay text.

### File-backed input

Use a file when the primary prompt or message is too large or too structured to
belong in shell argv.

Nomenclature:

- **Prompt file**: the primary work prompt for `scout ask`; pass it with `--prompt-file <path>`.
- **Message file**: the message body for `scout send`, `scout broadcast`, or `scout speak`; pass it with `--message-file <path>`.
- **Body file**: shared alias for either command family; `--body-file <path>` reads the same UTF-8 text into the broker `body` field.

Examples:

```bash
scout ask --to hudson --prompt-file ./handoff.md
scout @hudson --prompt-file ./review-request.md
scout send --channel triage --message-file ./status-update.md
scout broadcast --message-file ./maintenance-window.md
```

The file is read locally before dispatch. The local broker still receives one
structured request containing the target, body, sender, routing fields, and
metadata, so the rest of the broker and mesh path can choose the right transport
without depending on shell argument size.

### One-to-one delegation

When one project agent is delegating concrete work to one other agent, treat it
as a private handoff:

- keep it in a DM, not `channel.shared`
- preserve the acting project agent as the sender
- keep progress and completion in that same DM

Today the best CLI surface for that handoff is `scout ask`, because it opens a
DM by default when no explicit channel is pinned:

```bash
scout whoami
scout ask --to hudson "Build the editable CodeViewer and report back with the integration-ready surface."
```

If the invoking shell or host path might not already be bound to the acting
project agent, make it explicit:

```bash
scout ask --as premotion.master.mini --to hudson "Build the editable CodeViewer and report back with the integration-ready surface."
```

Use `channel.shared` only when the work is genuinely for a group, not for a
single owner.

### Label-scoped catch-up

Use labels to tie related asks together without creating a new workflow object:

```bash
scout ask --to hudson --label release:0.2.66 "Review the package bump."
scout ask --to lattices --label release:0.2.66 "Check the install path."
scout label feed release:0.2.66 --since 10m
scout label watch release:0.2.66 --interval 2
scout label brief release:0.2.66
```

Labels are plain metadata. They can mean a goal, release, milestone, incident,
or any local convention. `scout label watch` streams a normalized firehose of
matching Scout-owned activity; `scout label brief` gives a compact digest. Scout
does not assign a lifecycle to the label.

### Addressing specific agents

Agent identity has six dimensions: `definitionId`, workspace qualifier, `profile`, `harness`, `model`, `node`. Canonical form:

```
@<definitionId>[.<workspaceQualifier>][.profile:<profile>][.harness:<harness>][.model:<model>][.node:<node>]
```

Short `@name` only resolves when exactly one matching agent is available from the current context. If multiple agents share a name (e.g. one Codex-backed, one Claude-backed), pin the dimension you care about with a typed qualifier:

```bash
scout send --to vox.harness:codex "message from hudson: please retry the build"
scout ask --to vox.harness:claude "what did the reviewer flag?"
scout ask --to arc.profile:reviewer "take another pass"
scout ask --to vox.harness:codex.node:mini "run locally on mini"
scout ask --to lattices#codex?5.5 "take task A"
scout ask --to lattices#claude?sonnet "take task B"
```

Aliases: `runtime:` = `harness:`, `persona:` = `profile:`, `branch:` / `worktree:` = workspace qualifier. Shorthand `#codex` maps to `harness:codex`; `?sonnet` or `?5.5` maps to `model:<model>`. Dimensions combine in any order.

If direct send/ask still comes back unresolved, treat that as a routing problem, not a mere "target is offline" problem. The right follow-up is to disambiguate the target, inspect broker context with `scout who` / `scout latest`, or create/register the missing identity. Do not default to pushing the bring-up step back onto the operator for a known target.

For current-project work where the harness is the only important choice, omit
`--to` and `--project`; Scout infers the current project and creates or chooses
a compatible worker:

```bash
scout ask --harness codex "take a fresh pass on this repo"
```

That routes by the current project path and asks the broker to create or choose
a compatible worker. For another repo, pass the repo path explicitly:

```bash
scout ask --project ../talkie --harness claude "review the modular build spec"
```

Use an exact `--ref` or `session:<id>` only when the intent is to continue prior
context. If the broker returns a friendly worker handle, treat it as the human
mnemonic; promote/pin it only after the routed worker proves useful.

Local product handoffs use the public Scout address:

```bash
scout send --to scout "message for the local Scout inbox"
```

Broker names and concrete node or agent ids are diagnostic details. Normal send
output should say whether the message was sent, not which broker or internal
session handled it. Reusing an existing session is an explicit continuity
choice, not the default.

Session refs are separate route targets for continuing a concrete bound
session. Use the bare `ref:<suffix>` form in receipts/history, and pass the
suffix with `--ref`; do not encode refs into `@agent#harness?model` identity
syntax.

```bash
scout ask --ref 7f3a9c21 "continue from that handoff"
scout send --ref 7f3a9c21 "status for that same session"
```

Diagnostic views may show both layers, for example:

```text
sent to Scout via DM (ref:7f3a9c21)
```

## Current Commands

```bash
scout --help
scout version
scout doctor
scout setup
scout runtimes
scout providers usage
scout whoami
scout send
scout speak
scout ask
scout watch
scout who
scout latest
scout broadcast
scout up
scout down
scout ps
scout restart
scout menu
scout pair
scout server start
scout server open
scout tui
```

### Provider Usage (`scout providers usage`)

Read every quota window from the live `/providers` feed without opening the
web UI. Status-only provider cards are intentionally omitted:

```bash
scout providers usage
scout providers usage --json
scout providers usage --cached
```

The default command refreshes the shared service-budget pipeline and prints
every available quota window with percent used and remaining, the local reset
time, source, and observation freshness. `--cached` skips live provider probes
when a recent server snapshot is available; a cold or expired cache still reads
the providers normally.

### Menu Bar App (`scout menu`)

On macOS, `scout menu` is the quick launcher for the native menu bar app.

```bash
scout menu
scout menu status
scout menu restart
scout menu quit
```

If you run it from an OpenScout repo checkout, Scout prefers the repo helper at
`apps/macos/bin/openscout-menu.ts`, so it can auto-build and launch the app bundle for you.
Outside the repo, it opens an installed `OpenScout Menu` app when available.

### Web UI (`scout server start`, `scout server open`)

Runs the current OpenScout web UI used by the repo’s `bun run dev` entry. **Bun must be on your PATH.** Published CLI builds ship `dist/scout-control-plane-web.mjs` and `dist/client/` (Vite build); when `dist/client/index.html` is present, **`scout server start` defaults to static assets** unless you pass `--vite-url` to proxy a dev server.

```bash
scout whoami
scout who
scout latest
scout server open
scout server start
scout server start --port 43120
scout server open --path /agents/arc-codex-2.master.mini
scout server start --public-origin http://scout.local
scout server edge --local-name m1
scout server start --vite-url http://127.0.0.1:43173   # SPA dev server
scout server start --static --static-root /custom/client
```

`scout server open` reuses an already-running matching Scout server on that port, or starts one in the background and opens the browser for you. Use `scout server` or `scout server help` for full flags.

The application server binds to `0.0.0.0` by default, treats `scout.local` as the local portal name, and derives the node URL as `<machine>.scout.local` unless the user configures a short alias such as `m1`. `scout server edge` publishes `scout.local` plus the node host with Bonjour/mDNS and runs Caddy against the active web port. The managed edge defaults to HTTP on port `80` for zero-cert local browsing. HTTPS remains an explicit opt-in via `--edge-scheme https` or `--edge-scheme both` plus `scout server trust`.

`scout setup` verifies Caddy for this path. The setup command installs it with Homebrew on macOS when `caddy` is not already available, but Scout still runs Caddy directly with the generated `~/.scout/local-edge/Caddyfile` instead of registering a separate Homebrew service. The base LaunchAgent is labelled `app.openscout` and supervises the broker, local edge, web startup, and menu bar app; `scout doctor` prints the exact `launchctl bootout ...` command for the current mode.

When the edge is up but the web app is down, Caddy serves a same-origin "Start Scout" page. The button calls Caddy's internal `/__openscout/web/start` path, which proxies to the always-on broker and starts the web server while keeping the user-facing URL at `scout.local` or `<name>.scout.local`.

`packages/web` remains the internal web workspace. Published installs get that same server and client through `@openscout/scout`.

For source development, `bun run dev:edge -- --local-name m1` starts the web dev stack and the local edge together. It generates Caddy config against the actual selected dev port, so worktree-specific ports and busy-port fallback still route through `scout.local`.
