# Pairing Runtime Agent Notes

Source: `apps/desktop/src/core/pairing/**`, `packages/web/server/core/pairing/**`.

Status: describes shipped local pair-mode behavior. Not broker routing, mesh, or Scout comms.

Verified: 2026-08-20

## Role

Pairing runtime lets a **mobile or remote client** reach a **local harness bridge** over a relay. It is a transport and session bridge, not the Scout broker.

| Layer | Job |
|---|---|
| `scout-base` pairing supervisor | Canonical process owner; reconciles durable start/stop/restart intent and recovers controller crashes |
| `pairing-runtime-controller` | Long-lived controller: relay, bridge, snapshot, Bonjour, restart |
| `pairing runtime` (`startPairingRuntime`) | Bridge + file server + relay client + configured sessions |
| `Bridge` | Local harness session registry; WS/tRPC surface for remote control |
| `relay` | Fan-out between bridge role and mobile client role |
| `PairingService` (macOS) | Reads snapshot; writes desired-state intent; directly owns a controller only as an unavailable-supervisor fallback |

Canonical implementation path: `packages/web/server/core/pairing/`. `apps/desktop/src/core/pairing/` is transitional duplicate source.

## Model

| Noun | Meaning |
|---|---|
| `identity` | Bridge static Noise key pair at `~/.scout/pairing/identity.json` |
| `trusted_peer` | Mobile public key persisted after successful handshake |
| `relay` | WebSocket rendezvous; bridge connects outbound as bridge role |
| `managed_relay` | Locally started relay when `config.relay` is unset |
| `room` | Relay-scoped connection id inside one QR payload |
| `bridge` | Local orchestrator over harness adapters (`@openscout/agent-sessions`) |
| `session` | One adapter-backed harness process/thread inside the bridge |
| `adapter` | Harness factory: `claude-code`, `codex`, `acp`, `pi`, `opencode`, `openai` |
| `qr_payload` | Mobile join bundle: relay URL, room, bridge public key, expiry |
| `runtime_snapshot` | Machine-readable controller state at `~/.scout/pairing/runtime.json` |
| `controller_pid` | Singleton lock at `~/.scout/pairing/runtime.pid` |

## Relations

```plaintext
controller 1—1 bridge process tree (in-process)
controller 0—1 managed_relay
controller 0—1 bonjour_advertisement
bridge 1—* session
session *—1 adapter
bridge 1—1 relay_connection (outbound)
relay *—* mobile_client
identity 1—* trusted_peer
scout-base → supervises controller; macOS PairingService → writes intent → reads runtime_snapshot
```

Pairing does **not** own: broker messages, invocations, flights, deliveries, agent registry, mesh forwarding, Scout address grammar.

## Process Shape

```plaintext
scout-base
  → reconcile durable supervisor.json intent
      → pairing-runtime-controller (singleton)
          → [managed relay @ port+1] (optional)
          → startPairingRuntime()
              → Bridge @ config.port
              → file server @ port+2
              → relay client → relay URL
          → write runtime.json
          → [dns-sd Bonjour _oscout-pair._tcp] (darwin + managed relay only)
```

Default ports when `config.port` unset: bridge `43130`, relay `43131`, file server `43132`.

## State Machine

`PairingRuntimeStatus`:

| Status | Meaning |
|---|---|
| `stopped` | Controller exited cleanly |
| `starting` | (Re)launching bridge/relay |
| `connecting` | Relay join in progress or QR waiting for mobile |
| `connected` | Relay room ready |
| `paired` | Noise handshake completed with remote peer |
| `closed` | Relay/session closed |
| `error` | Startup or runtime failure; auto-restart unless intentional stop |

Controller behavior:

- second live `runtime.pid` → exit 1
- stale pid file → cleared on startup
- error → restart after 2s unless SIGINT/SIGTERM
- QR expiry → refresh payload 30s before `expiresAt`, or full restart if pairing block missing

## QR Payload

`QRPayload` / `PairingQrPayload`:

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | required |
| `relay` | url | primary relay WS/WSS URL |
| `fallbackRelays` | url[] | optional ordered fallbacks |
| `room` | uuid | relay room id |
| `publicKey` | hex | bridge static public key |
| `expiresAt` | ms epoch | default now + 5m |

`snapshot.pairing` adds rendered `qrArt` and `qrValue` (= `JSON.stringify(payload)`).

## Runtime Snapshot

`PairingRuntimeSnapshot` (`version: 1`) at `~/.scout/pairing/runtime.json`:

| Field | Meaning |
|---|---|
| `pid` | controller process id |
| `childPid` | reserved; usually null in current controller |
| `status`, `statusLabel`, `statusDetail` | operator-facing state |
| `connectedPeerFingerprint` | first 16 hex chars of remote public key when paired |
| `relay` | active relay URL |
| `secure` | from config; default true |
| `workspaceRoot` | optional project root from config |
| `sessionCount` | configured auto-start sessions |
| `identityFingerprint` | first 16 hex chars of bridge public key |
| `trustedPeerCount` | count of `trusted-peers.json` |
| `pairing` | active QR block or null |
| `startedAt`, `updatedAt` | ms epoch |

Surfaces read snapshot; they do not infer pairing health from logs alone.

## Config

`~/.scout/pairing/config.json`:

| Field | Default | Meaning |
|---|---|---|
| `relay` | null → managed relay | External relay WS URL |
| `secure` | `true` | Noise on local bridge connections |
| `port` | `43130` | Bridge listen port |
| `workspace.root` | null | Workspace browse root |
| `sessions[]` | `[]` | Auto-started bridge sessions |
| `adapters{}` | `{}` | Named adapter overrides |

Paths root: `~/.scout/pairing/`.

## Bridge Contract

Bridge owns local harness execution only.

| Operation | Effect |
|---|---|
| `createSession(adapter, options)` | spawn adapter-backed session |
| `send(prompt)` | prompt one session |
| `interrupt(sessionId)` | stop active turn |
| `answerQuestion(answer)` | resolve adapter question block |
| `closeSession(sessionId)` | tear down one session |

Bridge never holds provider API keys in its own layer; adapters run locally with harness-native auth.

Remote control path: relay → Noise transport → bridge router/tRPC → bridge registry.

Mobile terminal provisioning returns a device-scoped tmux workspace derived
from the app installation's SSH public key and normalized device class. The
legacy `scout` workspace remains the compatibility fallback for older clients
or brokers. Status requests accept only that generated namespace and return
metadata, and the requested workspace must match the paired device's managed
SSH grant. Terminal transcript content never crosses the bridge.

## Security

| Mechanism | Rule |
|---|---|
| Bridge identity | Persistent key pair; phone initiates Noise handshake |
| Bridge on relay | Noise responder |
| Trusted peers | Saved after successful pairing |
| QR | Expires; invalid after `expiresAt` |
| Identity files | mode `0600` |

Bonjour (darwin, managed relay): service `_oscout-pair._tcp`, TXT `v`, `pk`, `fp`, `scheme`, optional `fallbackRelays`.

## Surfaces

| Surface | Entry | Reads | Writes |
|---|---|---|---|
| Controller | `pairing-runtime-controller` bin | config, identity | `runtime.json`, `runtime.pid` |
| In-process API | `startScoutPairingSession({ onEvent })` | snapshot | ephemeral session only |
| macOS menu | `PairingService` | snapshot, config, identity | durable supervisor intent (`start`, `stop`, `restart`) |
| Mobile | scans `qrValue` | — | connects via relay |

Env override: `OPENSCOUT_PAIRING_RUNTIME_CONTROLLER_BIN`.

## Events (in-process service)

`ScoutPairingEvent`:

| Type | When |
|---|---|
| `pairing_ready` | QR payload available |
| `status` | `connecting` \| `connected` \| `paired` \| `closed` \| `error` |

Prefer `runtime.json` for cross-process UI; use events only inside one Node process.

## Invariants

1. At most one live pairing-runtime-controller per machine (`runtime.pid` lock).
2. `scout-base` is the normal controller owner; macOS and web controls mutate durable intent instead of owning separate controllers.
3. An explicitly stopped controller stays stopped across base restarts; an unexpected controller exit is restarted automatically.
4. Snapshot is the cross-process truth for menu/web observers.
5. Pairing sessions are harness-local; they are not broker endpoints unless separately registered.
6. QR payload must include relay, room, public key, and unexpired `expiresAt`.
7. Managed relay starts at `port + 1` when `config.relay` is absent.
8. Controller restart preserves identity and trusted peers; it regenerates room/QR.
9. Stale pid or corrupt snapshot is cleared on controller startup, not silently reused.
10. Adapter type mismatch is a bridge error, not a broker routing fallback.

## Forbidden

- Treat pairing `session` as a Scout broker `session` without explicit registration.
- Route `scout send` / `scout ask` through pairing by default.
- Bulk-import bridge event streams into broker message tables.
- Run two controllers against one `runtime.pid` path.
- Assume Bonjour exists off macOS or with external relay-only config.

## Code Map

| Concern | Path |
|---|---|
| Controller | `**/pairing/pairing-runtime-controller.ts` |
| Snapshot/pid | `**/pairing/runtime/runtime-state.ts` |
| Runtime start | `**/pairing/runtime/runtime.ts` |
| Bridge | `**/pairing/runtime/bridge/bridge.ts` |
| Relay client | `**/pairing/runtime/bridge/relay-client.ts` |
| Managed relay | `**/pairing/runtime/relay-runtime.ts` |
| Identity/QR | `**/pairing/runtime/security/identity.ts` |
| macOS shell | `apps/macos/.../PairingService.swift` |

## Verification

```bash
# unit contract for durable intent, singleton claim, and stale-owner recovery
bun test packages/runtime/src/pairing-supervisor.test.ts

# build/restart the canonical suite, then verify ownership and readiness
bun run scout:up --no-ios
bun run scout:verify
```

Expect one `pairing-runtime-controller` owned by `scout-base`. Controller crashes
are recovered, explicit stop remains stopped, restart replaces the controller,
and `runtime.json` remains the shared observer snapshot.
