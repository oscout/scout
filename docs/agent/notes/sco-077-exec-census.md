# SCO-077 exec-site census — per-site worklist

Generated 2026-07-02 by delegated census agent (Opus). Companion to
`docs/eng/sco-077-system-probe-discipline.md`.

Scope: TypeScript under `packages/` and `apps/`, excluding `node_modules`, `dist`,
`.next`, `*.test.ts`, fixtures, and vendored/generated checkouts
(`apps/macos/.build-codex-*/checkouts/`, `apps/ios/.deriveddata/`). DB `.exec()`
(bun:sqlite) and regex `.exec()` excluded as false positives.

## Total site count

**227 in-scope subprocess call sites** — 168 sync
(`execFileSync`/`execSync`/`spawnSync`/`Bun.spawnSync`) + 59 async
(`spawn`/`Bun.spawn`/`pty.spawn`/`execFileAsync`/`host.execFile`).

## Summary — sync sites by binary (the burn-down surface)

| binary | sync sites | note |
|---|---|---|
| tmux | 29 | pane/session discovery + send-keys/kill |
| git | 18 | buildInfo, status --porcelain, worktrees, diffs |
| lsof | 9 | listener + cwd sweeps |
| openssl | 5 | cert inspection |
| tailscale | 4 | status --json + cert |
| ps | 4 | process telemetry |
| pgrep | 4 | process presence |
| which / command -v | ~22 | capability checks (mostly boot/CLI) |
| build/pkg tooling (swift, sips, iconutil, codesign, PlistBuddy, launchctl, hdiutil, cp/rm/xattr, bun, cmd.exe, sh) | ~73 | CLI/build scripts |

## Summary — sync sites by file (top)

| file | sync | dominant classification |
|---|---|---|
| apps/macos/bin/openscout-menu.ts | 26 | BOOT-OK (packaging CLI) |
| packages/web/server/create-openscout-web-server.ts | 17 | PROBE + IMPERATIVE (request/poll) |
| packages/runtime/src/local-agents.ts | 14 | IMPERATIVE + tmux.sessions PROBE |
| apps/desktop/src/cli/commands/install.ts | 12 | BOOT-OK (CLI) |
| apps/macos/bin/scout-app.ts | 11 | BOOT-OK (build CLI) |
| apps/desktop/src/cli/commands/session.ts | 10 | BOOT-OK (CLI one-shot) |
| packages/web/server/terminal-relay-session.ts | 7 | mixed PROBE/IMPERATIVE |
| packages/web/server/core/pairing/runtime/bridge/server.ts | 5 | PROBE (RPC request path) |
| packages/web/server/core/pairing/runtime/bridge/router.ts | 5 | PROBE (RPC request path) |
| packages/runtime/src/setup.ts | 5 | BOOT-OK |
| packages/web/server/core/pairing/runtime/relay-runtime.ts | 4 | tailscale.status PROBE + cert IMPERATIVE |
| apps/desktop/src/core/pairing/runtime/relay-runtime.ts | 4 | same (mirror) |
| apps/desktop/src/core/pairing/runtime/bridge/server.ts | 4 | PROBE (RPC) |
| apps/desktop/src/core/pairing/runtime/bridge/router.ts | 4 | PROBE (RPC) |
| apps/desktop/src/cli/main.ts | 4 | BOOT-OK |
| packages/web/server/session-compaction.ts | 4 | tmux.sessions PROBE + IMPERATIVE |
| packages/web/server/managed-terminal-relay.ts | 3 | net.listeners + ps.runtime PROBE |
| packages/runtime/src/harness-catalog.ts | 3 | capability (unknown/boot) |
| packages/web/server/terminal-session-discovery.ts | 2 | tmux.sessions PROBE |

## Summary — approximate by classification (sync)

- **PROBE ~53** — recurring system-fact reads (tmux/ps/lsof/git/tailscale/openssl)
  on the web + bridge + desktop server surfaces.
- **IMPERATIVE ~30** — tmux send-keys/paste/kill/detach/new-session,
  `tailscale cert`, `open`/reveal, spawn relay/agent.
- **BOOT-OK ~85** — `apps/macos/bin/*` packaging, `apps/desktop/src/cli/*`
  one-shots, `runtime/setup.ts`, daemon-boot port/tailscale checks, capability
  `which`/`--version`.

## HIGHEST-RISK — sync reads reachable from a request path or poll (burn-down order)

These run sync on the bun event loop inside long-lived server processes (web
control-plane, mobile bridge, desktop host, runtime broker). Ordered roughly by
blast radius.

### packages/web/server/create-openscout-web-server.ts (the incident process)

- `:3820` `runGitValue` → `loadOpenScoutBuildInfo` → `GET /api/build` (route
  :5081) **and** attention snapshot (:4285): `git rev-parse --abbrev-ref HEAD`,
  `git rev-parse --short HEAD`, `git status --porcelain` — 3 git execs/request.
  **PROBE(git.buildInfo)**. *This is the exact incident cause.*
- `:651` `runGitRaw` → repo-diff request: `git diff --cached` /
  `git status --porcelain` / `git diff`. **NAMED_GIT_CATALOG**
- `:837` `resolveGitCommitRef` (worktree) → repo-diff request:
  `git rev-parse --verify ...^{commit}`. **PROBE(git.buildInfo)**
- `:2088` `tmuxPaneDetail` → runtime surface:
  `tmux display-message -p '#{pane_pid}\t#{pane_tty}\t#{pane_current_path}'`.
  **PROBE(tmux.panes)**
- `:2107` `processRowsForTty`: `ps -t <tty> -o pid=,ppid=,pgid=,comm=`.
  **PROBE(ps.runtime)**
- `:2133` `allProcessRows`: `ps -axo pid=,ppid=,pgid=,comm=`. **PROBE(ps.runtime)**
- `:2157` `allProcessCommandRows`: `ps -axo pid=,ppid=,pgid=,command=`.
  **PROBE(ps.runtime)**
- `:2242` `readProcessCwd`: `lsof -a -p <pid> -d cwd -Fn`. **PROBE(ps.runtime)**
  (proposed `ps.cwd`)
- `:3015` tmux capture (request): `tmux capture-pane`. **PROBE(tmux.panes)**

### packages/web/server/managed-terminal-relay.ts

- `:190` `tcpListenerPid`: `lsof -iTCP:<port> -sTCP:LISTEN`. **PROBE(net.listeners)**
- `:210` `processField`: `ps -p <pid> -o <field>=`. **PROBE(ps.runtime)**

### packages/web/server/terminal-session-discovery.ts

- `:54` `spawnSync tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'`.
  **PROBE(tmux.sessions)**
- `:93` `spawnSync zellij list-sessions`. **PROBE(tmux.sessions)**

### packages/web/server/terminal-relay-session.ts

- `:235` `execSync tmux has-session -t <name>`. **PROBE(tmux.sessions)**
- `:277` `execFileSync zellij list-sessions`. **PROBE(tmux.sessions)**

### packages/web/server/session-compaction.ts

- `:22` `execFileSync tmux has-session -t <name>`. **PROBE(tmux.sessions)**

### packages/web/server/work-materials.ts

- `:287` `execFileSync git -C <cwd> ...`. **NAMED_GIT_CATALOG**

### packages/web/server/core/pairing/runtime/bridge/router.ts (mobile bridge RPC handlers)

- `:369` `execSync find … *.jsonl -mtime … | xargs stat | sort | head` (5s timeout).
  **PROBE(sessions.scan)** *(proposed; query-keyed)*
- `:400` `execSync find … *.jsonl -exec stat` (10s timeout). **PROBE(sessions.scan)**
- `:1400` `execFileSync` FTS count (untrusted query). **PROBE(sessions.search)**
  *(proposed; query-keyed)*
- `:1407` `execFileSync` FTS preview lines. **PROBE(sessions.search)**

### packages/web/server/core/pairing/runtime/bridge/server.ts

- `:901` FTS count `execFileSync`; `:909` FTS preview `execFileSync`.
  **PROBE(sessions.search)**
- `:1212` `execSync` (5s); `:1246` `execSync` (10s) — session-file scans.
  **PROBE(sessions.scan)**

### packages/web/server/core/pairing/runtime/bridge/mobile-terminal-provision.ts

- `:117` `execSync` on provision request. **PROBE / unknown** (trace: provisioning RPC)

### packages/web/server/core/pairing/runtime/relay-runtime.ts

- `:80` `readTailscaleStatus`: `tailscale status --self=true --peers=false --json`
  → `resolveRelayEndpoint`. **PROBE(tailscale.status)** — doc calls for
  `fresh({maxAgeMs:5000})` here.
- `:62` `openssl x509 -checkend 86400`; `:66` `openssl x509 -issuer -subject`.
  **PROBE(cert.status)** *(proposed)*

### apps/desktop/src/core/** (mirror of the web pairing/relay/bridge code — same host process class)

- `core/broker/attention.ts:868` `runGit` → `git -C <cwd> ...`. **NAMED_GIT_CATALOG**
- `core/pairing/runtime/relay-runtime.ts:80` `tailscale status …`.
  **PROBE(tailscale.status)**; `:62/:66` openssl. **PROBE(cert.status)**
- `core/pairing/runtime/bridge/router.ts:232,262,1284,1291` `execSync` session
  scans/FTS (request RPC). **PROBE(sessions.scan/search)**
- `core/pairing/runtime/bridge/server.ts:876,881,1180,1214` `execSync`
  (request RPC). **PROBE(sessions.scan/search)**

### packages/runtime/src/local-agents.ts

- `:2516` `execFileSync tmux has-session -t <name>` (send-prompt path).
  **PROBE(tmux.sessions)**

## Companion flag — IMPERATIVE but sync-on-request (not probes; must become async)

Genuine actions reachable from request paths that are still sync today (doc
§"imperative ops must be async with timeouts"):

- `create-openscout-web-server.ts:2377,2387` (new-session/resume), `:2473,2477`
  (send-keys C-c/C-d), `:2489` (detach-client), `:3562,3569,3576`
  (`open`/`explorer.exe`/`xdg-open` reveal).
- `session-compaction.ts:33,34` (`tmux send-keys` -l / Enter).
- `local-agents.ts:2986,2988,2992,3001,3016,3029`
  (send-keys/load-buffer/paste-buffer/delete-buffer), `:3422,4283`
  (`tmux kill-session` / send-keys C-c), `:3594,3595,3616` (chmod + new pane).
- `terminal-relay-session.ts:245,306,310` (tmux/zellij create),
  `relay-runtime.ts:184` (`tailscale cert`).

## Explicitly NOT highest-risk (verified boot/CLI, sync acceptable)

- `packages/runtime/src/tailscale.ts:184` (`readStatusJsonSync` →
  `readTailscaleSelfWebHostsSync`): traced to `app-server-origin.ts:67`,
  `base-daemon.ts:91`, `broker-daemon.ts:214`, `broker-process-manager.ts:178`,
  `desktop cli/commands/server.ts:361` — all **startup origin resolution**.
  **BOOT-OK.** (The per-request tailscale storm from the incident is the *async*
  `tailscale.ts:152` mesh path + the two relay-runtime `:80` sync sites above,
  not this one.)
- `packages/runtime/src/base-daemon.ts:382` (`lsof` port check before spawning
  broker) — **BOOT-OK**.
- All of `apps/macos/bin/*` and `apps/desktop/src/cli/*` sync sites —
  packaging/CLI one-shots. **BOOT-OK.**
