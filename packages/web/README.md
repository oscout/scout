# Scout Web

Scout's baseline web control plane: the local Bun/Hono server, a coherent
operator UI, and the reusable interface primitives needed to compose it. The
web app ships inside `@openscout/scout` and should remain fully useful without
private product code.

> **Migration status:** `packages/web` is still workspace-private while the
> public package and release boundaries are established. The target is for this
> repository to release `@openscout/web` in lockstep with the public package
> family and for the private product to consume that exact version. Do not read
> the target composition model below as a claim that the cutover is complete.

## What lives here

- the local navigation and application shell;
- setup and health, agents and sessions, conversations and send/ask, flights
  and work, activity, runtimes and capabilities, projects, mesh and pairing,
  and settings views;
- shared loading, empty, error, approval, and connection states;
- protocol-backed client boundaries and reusable UI primitives;
- the Bun/Hono server and bundled static client assets.

The public `@openscout/scout` package vendors the production build outputs.

## Target composition model

The private product should extend this baseline through a trusted, build-time
composition API. That public API will expose documented contracts for routes,
navigation, bounded slots, namespaced server routes, and capability providers,
along with shared design tokens, components, and the broker client. The private
build compiles those public exports with its own product contributions; it does
not copy this directory or import unpublished `src/` paths.

The dependency is strictly one-way. Public web code never imports or assumes
private code, and removing every private contribution must still leave a useful
baseline Scout control plane.

## Requirements

- [Node.js](https://nodejs.org) on your `PATH`
- [Bun](https://bun.sh) on your `PATH`

## Run From Source

```bash
bun --cwd packages/web dev
bun --cwd packages/web dev:edge
bun --cwd packages/web dev:server
```

Then open the URL printed in the terminal (default port `43120`).

The Bun/Hono application server binds to `0.0.0.0` by default, treats `scout.local` as the local portal name, and derives the node URL as `<machine>.scout.local` unless the user configures a short alias such as `m1`. The Scout local named-edge flow is name resolution first, then Caddy, then the application server: `scout server edge` publishes/resolves `scout.local` and `<node>.scout.local`, runs Caddy against the active web port, and serves HTTP on port `80` for zero-cert local browsing. HTTPS is available only when explicitly requested with `--edge-scheme https` or `--edge-scheme both` plus `scout server trust`.

Caddy is the only reverse proxy in this path. Its generated configuration uses bounded upstream retry waiting so short Bun restarts do not immediately become browser errors. The Bun process owns application state and background services directly; it does not spawn or balance a second request-worker pool.

The chat client requests the ten most recent conversations for the active machine scope and preloads a bounded recent tail with two concurrent requests. Opened histories are retained in a ten-chat LRU cache: while a chat is resident, immutable older messages are reused and focus/reconnect recovery refreshes and merges only the latest tail. Broker events for the open chat append directly to that same cache, so routine polling does not replace the full transcript.

The ordinary control-plane context path requests a coherent 24-hour registry
working set from the broker, coalesces concurrent reads, and caches that result
for a short TTL. It rehydrates from the broker after expiry or a successful
write. Rich agent views still contain full-snapshot reads during the migration;
those are compatibility gaps, not the target client contract. Lifetime history
stays broker-owned and should be read through bounded, purpose-specific APIs.

Realtime Scoutbot voice is a flagged high-trust pilot. The host app's **Settings → Voice** toggle resolves the client flag for its embedded surface; there is no second browser-local opt-in. The billable server route stays closed unless the host starts the web server with `OPENSCOUT_REALTIME_VOICE_ENABLED=1`, and the operator still explicitly starts each call from the footer Voice control. Calls use the configured server-side OpenAI API key. The selected durable Scoutbot chat preserves context when a call stops or the panel closes, and the voice surface can start or restore a recent chat. An explicit operator request to coordinate with an agent is sent immediately through the broker and its delivery result is reported; downstream harness permission and review gates still apply. Allowlisted, non-destructive app navigation can be applied directly during a call. Host-local SQLite leases default to one active call and four starts per minute; see [`docs/design/realtime-voice-design-pass.md`](../../docs/design/realtime-voice-design-pass.md) for the tuning variables and boundary details.

## Package surface

Today, the standalone npm release surface is `@openscout/scout`; it includes the
`scout` CLI, local broker/runtime, and this web server/client. During the
migration, this workspace package intentionally remains `private: true`.

The target public release family adds `@openscout/web` as a supported package,
released in lockstep with protocol, agent-sessions, runtime, and Scout. Private
consumers pin exact versions and import only documented exports. The primary
installation experience remains `@openscout/scout`; users are not expected to
assemble the package family themselves.

## Build (maintainers)

From the repo root:

```bash
npm --prefix packages/web run build
```

This builds:

- `dist/client/` via Vite
- `dist/openscout-web-server.mjs` via `bun build`
- `dist/pairing-runtime-controller.mjs` for the pairing runtime
- `dist/openscout-terminal-relay.mjs` for the Node-hosted PTY relay

When Hudson updates the relay session runtime, refresh the vendored fallback with:

```bash
bun --cwd packages/web relay:sync
```

## Local dev (UI only)

Run the standalone web server and the Vite client together:

```bash
bun --cwd packages/web dev
```

`bun dev` prefers the standard Scout ports in the main checkout and worktree-specific port bands in extra git worktrees. If a preferred port is already taken, it increments until it finds an open one.

### HudsonKit source

Source builds use a sibling Hudson checkout automatically when
`../hudson/packages/web/hudsonkit` exists. That lets Scout pick up current
HudsonKit UI primitives without waiting for an npm publish. To force the
published package instead:

```bash
OPENSCOUT_WEB_HUDSONKIT_SOURCE=package bun --cwd packages/web dev
```

Set `HUDSON_SDK_PATH=/path/to/hudson/packages/web/hudsonkit` to point at a
non-sibling checkout.

To run the app through the local Scout names in one process, use:

```bash
bun --cwd packages/web dev:edge -- --local-name m1
```

`dev:edge` starts the Bun app server, Vite, Bonjour/mDNS name publication for `scout.local` and `<name>.scout.local`, and Caddy reverse proxying on local port `80` plus `443` by default. The Caddyfile is generated with the actual Bun port chosen for that run, so the edge stays correct when the default port is busy or a worktree gets an isolated port band.

Installed CLI users get the Caddy dependency through `scout setup` on macOS via Homebrew. The base Scout LaunchAgent supervises the normal local edge after setup; source-only development still requires `caddy` on PATH or `OPENSCOUT_CADDY_BIN` pointing at a Caddy executable before running `dev:edge`.

The local edge also owns the cold-start screen. If Caddy can resolve the Scout name but the web app health check fails, it serves a small "Start Scout" page from the same origin. The button posts to Caddy's internal `/__openscout/web/start` control path, which proxies to the always-on broker and starts the web server without exposing broker ports to the browser URL.

If you need to run them separately:

```bash
bun --cwd packages/web dev:client
OPENSCOUT_WEB_VITE_URL=http://127.0.0.1:43122 bun --cwd packages/web dev:server
```

### Dev routing

The public route table stays small and explicit:

- `/api/*` is the Bun API surface
- `/api/health` is the canonical application health endpoint
- `/ws/terminal` is the terminal/takeover WebSocket
- `/ws/hmr` is the Vite hot-reload WebSocket in dev
- everything else is client traffic

In the installed package, Bun serves the bundled static client directly. In source/dev mode, Bun remains the public server but forwards client asset requests and `/ws/hmr` to Vite.

For a local edge proxy, keep Bun as the application server and reverse-proxy to it. The default generated config includes HTTP for zero-cert local browsing and same-origin control paths for broker-owned startup:

```caddyfile
http://scout.local {
  handle /__openscout/web/start {
    rewrite * /v1/web/start
    reverse_proxy 127.0.0.1:BROKER_PORT
  }

  handle {
    reverse_proxy 127.0.0.1:PORT_NUMBER
  }

  handle_errors {
    respond "Start Scout fallback page" 200
  }
}

http://*.scout.local {
  handle /__openscout/web/start {
    rewrite * /v1/web/start
    reverse_proxy 127.0.0.1:BROKER_PORT
  }

  handle {
    reverse_proxy 127.0.0.1:PORT_NUMBER
  }

  handle_errors {
    respond "Start Scout fallback page" 200
  }
}
```

Use the port number the Bun app server is listening on. The default is `43120`, or the value passed with `--port` / `OPENSCOUT_WEB_PORT`.

### Cleanup

`bun dev` records each run under `.openscout/dev/web`, and cleanup uses that state first before falling back to a small Scout-only sweep around the local Scout port block.

To clear stale Scout dev listeners:

```bash
bun run dev:cleanup:ports
```
