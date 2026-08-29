# scoutd Agent Notes

Source: `crates/scoutd/**`, `packages/runtime/src/broker-process-manager.ts`.

Status: native service kernel plus bounded native read projections — still not broker logic.

Verified: 2026-07-14

## Role

`scoutd` is the Rust local daemon at the root of the Scout process tree. It installs launchd, supervises the Bun base composer, exposes doctor/status JSON, repairs stale process ownership, and hosts read-only native projections outside the broker/web request queues.

| Owns | Does not own |
|---|---|
| launchd plist install/bootout | message routing |
| `supervise` child lifecycle | invocations / flights |
| broker reachability probe | harness sessions |
| orphan/stale process diagnosis | mesh forwarding |
| `scoutd-state.json` | protocol records |
| bounded journal-derived read projections | canonical coordination writes |
| mode-`0600` Unix-socket NDJSON for native reads | routing decisions or broker snapshots on demand |

Legacy binary name `openscout-supervisor` is compatibility-only; doctor still recognizes `supervise` orphans.

## Model

| Noun | Meaning |
|---|---|
| `scoutd` | Rust CLI + long-running supervisor |
| `scout-base` | Bun process composer (`openscout-runtime.mjs base`) |
| `scout-broker` | broker child started by base |
| `scout-web` / `scout-edge` / `OpenScoutMenu` | optional children under base |
| `launchd` | macOS service keeper for `scoutd supervise` |
| `daemon_state` | `scoutd-state.json` in runtime directory |
| `service_status` | merged launchd + health + process-tree view |

## Process Shape

```plaintext
launchd
  → scoutd supervise
      → scoutd probes serve        (probes + native read projection/socket)
      → scout-base   (openscout-runtime.mjs base — daemon runs in-process)
          → scout-broker   (openscout-runtime.mjs broker — daemon runs in-process)
          → scout-web
          → scout-edge (caddy)
          → OpenScoutMenu (optional)
```

`openscout-runtime.mjs` imports the long-lived daemon entry in-process (no
second bun child per hop), so scoutd → scout-base → scout-broker is three
processes, not five.

Operator path: `scout` CLI → shells out to `scoutd` for service commands when available.

## Commands

| Command | Mode | Effect |
|---|---|---|
| `status [--json]` | one-shot | launchd label, child pids, broker health |
| `doctor [--json]` | one-shot | actionable repair report |
| `install [--json]` | one-shot | write launchd plist if missing |
| `start [--json]` | one-shot | `launchctl kickstart` |
| `stop [--json]` | one-shot | `launchctl bootout` |
| `restart [--json]` | one-shot | stop then start |
| `uninstall [--json]` | one-shot | stop, bootout legacy, remove plist |
| `--version` / `version` | one-shot | print daemon package version and optional build git SHA |
| `supervise` | long-running | spawn/restart base with backoff |

## Daemon State

`scoutd-state.json` (runtime dir):

| Field | Meaning |
|---|---|
| `version` | `scoutd` package version from `CARGO_PKG_VERSION` |
| `gitSha` | optional compile-time git SHA (`SCOUTD_GIT_SHA`) or null |
| `startedAtMs` | supervise epoch |
| `basePid` | current `scout-base` pid or null |
| `baseState` | `running` \| `exited` \| `stopping` \| `stopped` |
| `restartCount` | base restart tally |
| `restartBackoffMs` | current bounded restart delay, 1000→30000 ms |
| `lastChildExit` | last base exit `{ atMs, code, signal, description }` or null |
| `runtimeBuild` | source/bundle identity captured when the supervised base process starts |

Written every ~2s while child alive; updated on exit/restart/shutdown.

## Native Read Projection

The probe child tails `<controlHome>/broker-journal.jsonl` on a background Rust
thread. It projects current non-retired/non-stale agents, preferred endpoints,
node labels, and active flight state into a small sorted agent list. The last
usable list is persisted as `native-read-agents-v1.json` in the control home.

Clients send `openscout.native.read.request/v1` on the existing probe Unix socket.
Snapshot mode returns one bounded frame. Subscribe mode keeps the socket open,
returns an initial `openscout.native.read.snapshot/v1` frame, then pushes another
sequenced bounded snapshot only when the material agent projection changes.
`openscout.native.read.event/v1` heartbeat frames detect dead connections without
polling the broker. Requests and frames are newline-delimited JSON.

The projection is disposable and stale-while-revalidate. The broker journal remains
canonical. Projection parsing, persistence, or a slow native client must never block
the broker writer or routing path.

## Supervise Behavior

- spawn: `bun <runtime-entrypoint> base` with broker env passthrough
- child exit → log → backoff 1s→30s → respawn unless shutdown requested
- child stdout/stderr append to scoutd-owned `stdout.log` / `stderr.log`; before
  each spawn, files above 512 KiB retain a bounded tail in `.1` and are truncated
- every five minutes, sweep exact Scout-owned stale-process evidence: expired managed
  process leases and orphaned duplicate `_oscout-pair._tcp` advertisements that
  have a live replacement; set `OPENSCOUT_PROCESS_SWEEP=0` only for debugging
- the supervised broker separately sweeps idle cardless sessions every five
  minutes and retires them after 24 hours with no endpoint, flight, work-item,
  or question activity; tune with `OPENSCOUT_CARDLESS_SESSION_IDLE_TTL_MS` and
  `OPENSCOUT_CARDLESS_SESSION_SWEEP_INTERVAL_MS`
- SIGINT/SIGTERM → `stopping` → terminate child (12s budget) → `stopped`
- forwards optional launch env: mesh, node, tailscale, web portal hosts

## Config Resolution

`scoutd` resolves the same service paths as TypeScript `resolveBrokerServiceConfig()`:

| Input | Typical value |
|---|---|
| `broker_host` | `127.0.0.1` (local) or `0.0.0.0` (mesh advertise) |
| `broker_port` | `43110` default |
| `broker_url` | `http://127.0.0.1:43110` |
| `broker_socket_path` | unix socket under support dir |
| `support_directory` | `~/Library/Application Support/OpenScout` |
| `runtime_directory` | support/runtime |
| `launch_agent_path` | `~/Library/LaunchAgents/com.openscout.scoutd.plist` |
| `runtime_entrypoint` | `packages/runtime/bin/openscout-runtime.mjs` |

The machine-wide launchd service should resolve `runtime_entrypoint` from one
stable canonical checkout or installed package artifact. Do not repoint the
shared service at an experimental worktree: worktrees that can change the
control-plane schema must use an isolated `OPENSCOUT_CONTROL_HOME`, service
label, and port set so their migration ledger cannot advance the operator's
canonical database.

## Health / Doctor

Doctor merges:

- launchd loaded/running state
- `scoutd-state.json` child pid alive?
- restart telemetry from `scoutd-state.json` (`restartCount`, backoff, last child exit)
- broker HTTP or unix socket `/health` (or equivalent)
- stale orphans: legacy `openscout-supervisor supervise`, duplicate brokers, zombie base
- running runtime identity vs the current source/bundle build manifest

Runtime freshness states are `current`, `pinned`, `stale`, and `unverified`.
CLI builds write `dist/build-manifest.json`; scoutd records the identity that it
actually launched in `scoutd-state.json` and compares it with the currently
configured source or artifact. An older build is intentional only when
`OPENSCOUT_RUNTIME_BUILD_PIN=<commit>` is set. Set
`OPENSCOUT_RUNTIME_BUILD_PIN_REASON` as well so status/doctor explains why the
pin exists. A pin mismatch is still stale; a missing identity is unverified.

Output schema: `scout.doctor.v1` phases (CLI wraps same config).

`doctor --fix` remains conservative and opt-in. The always-on process sweep is
narrower still: it terminates only an expired leased process group whose live
command matches the lease's isolated profile marker, or an orphaned OpenScout
pairing advertisement when the same identity and port have a live replacement.
Harness/session retirement remains broker-owned and must use broker lifecycle
state; scoutd must not infer that an agent is stale from process age alone.
The broker rechecks cardless-session eligibility immediately before stopping a
harness, and only retires an `idle` session with no nonterminal flight and no
open work/question ownership.

## Invariants

1. Exactly one intended `scoutd supervise` per machine service label.
2. `scoutd` never embeds Bun; it execs configured `bun` + runtime entrypoint.
3. Broker business logic stays in the TypeScript broker process; Rust projections are read-only derivations.
4. `scout-base` remains the Bun orchestrator for broker/web/edge/menu children.
5. Status/doctor read daemon state file; they do not guess from log tail alone.
6. Legacy supervisor process names count as conflicts in doctor until cleaned.
7. Native read requests never synchronously call the web server or broker HTTP API.

## Forbidden

- Implement routing or flight semantics in `scoutd`.
- Write broker records or treat a native projection/cache as canonical.
- Turn the native read service into a synchronous proxy for `/v1/snapshot` or `/api/agents`.
- Replace `scout-base` child composition with Rust reimplementation.
- Treat `scoutd` as the broker canonical writer.
- Require `scoutd` for dev-only `bun ... server open` paths (optional acceleration).

## Code Map

| Concern | Path |
|---|---|
| Rust daemon | `crates/scoutd/src/main.rs` |
| Native read projection | `crates/scoutd/src/native_read_service.rs` |
| Unix-socket request/stream server | `crates/scoutd/src/probes.rs` |
| TS service config | `packages/runtime/src/broker-process-manager.ts` |
| Bun base composer | `packages/runtime/src/base-daemon.ts` |
| Runtime entry | `packages/runtime/bin/openscout-runtime.mjs` |
| Transcript discovery/firehose | `packages/runtime/src/tail/**` |

## Transcript Firehose Boundary

`scoutd` does not parse harness transcripts. The supervised Bun broker owns the
single runtime tail service, discovers harness-owned logs, and publishes bounded
`TailEvent` observations through broker HTTP reads and the `tail.events` tRPC
subscription. This keeps transcript parsing out of the Rust service kernel and
keeps harness logs as observed source material rather than Scout-owned records.

Kimi Code discovery lives in `packages/runtime/src/tail/kimi-source.ts`. It reads
`~/.kimi-code/sessions/**/agents/*/wire.jsonl` by default (or
`$KIMI_CODE_HOME/sessions`; tests and operators may use
`OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT`). A Kimi session's `agents/main/wire.jsonl`
uses the parent `session_<uuid>` ID. Spawned agent logs use
`session_<uuid>:agent-N`, so every wire file has an independent watcher and
cursor while retaining its parent session identity.

## Verification

```bash
cargo run --manifest-path crates/scoutd/Cargo.toml -- status --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- doctor --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- --version
scout doctor --json
```

Expect: broker reachable when base running; `basePid` matches live `scout-base`.
