# LAN-direct (workstream C) — design note

Status: **proposed, awaiting review** (no code changed yet)
Date: 2026-06-24

Goal: a same-network phone reaches its Mac with **no external hop** (not Tailscale,
not `wss://mesh.oscout.net`), while mesh stays as the out-of-home fallback.

## What exists today (verified)

- The bridge is an **outbound client** of a relay: phone → relay → bridge. The relay
  is a dumb forwarder that keys clients by `clientId`; the bridge holds one Noise
  transport per phone (`relay-client.ts`).
- Identity is a **single persistent keypair** (`~/.scout/pairing/identity.json`); each
  `connectToRelay()` mints a fresh room UUID.
- `startManagedRelay(port+1=43131)` stands up a local Noise rendezvous — but the
  controller only starts it **during pair mode AND only when no remote relay is
  configured** (`pairing-runtime-controller.ts:130`, `resolvedRelayUrl ? null : …`).
  The default config sets `relay: wss://mesh.oscout.net`, so **43131 never runs**.
- The always-on bridge on **43130 is plaintext** and has a **local consumer**
  (`createScoutPairingBridgeClient` — the web server drives it), so it can't simply
  be flipped to Noise/advertised for phones.
- iOS already **prefers LAN** (`scout.lan.enabled` on; Bonjour routes ranked first;
  auto `ws://` LAN fallback). `BonjourRelayDiscovery.swift:145` ignores adverts tagged
  `mode=discovery`.

## Decision: dual relay-client presence

Make the Mac **present in two relay rooms at once** — the existing remote (mesh) room
**and** an always-on **local** Noise relay (43131) — by running a **second
relay-client** from the same runtime. Both clients dial the **same bridge server**
with the **same identity**; the relay's `clientId` multiplexing keeps phones-via-mesh
and phones-via-LAN cleanly separated. No relay/bridge protocol change.

Why not the alternatives:
- *Phone connects straight to bridge 43130*: rejected — 43130 is plaintext with a
  local consumer; needs a separate secure listener + advert. More surface area.
- *One relay-client, swap upstreams*: doesn't give simultaneous reachability.

Collision review (from the relay-presence investigation):
- **Identity** singular → fine; each relay keeps its own `roomByBridgeKey` map.
- **Room id** differs per relay → fine.
- **Bridge server** shared → fine; `clientId` multiplex.

## Changes (orchestration only, ~100–200 LOC)

1. `pairing-runtime-controller.ts` — start an **always-on local relay** (43131) when the
   web server is up, **decoupled from pair mode** and **independent of** whether a
   remote relay is configured (today it's local **xor** remote; we want **and**).
2. `runtime.ts` — connect a relay-client to **each** relay URL (local + remote), not one.
3. Advertise the local relay **route-grade** (Bonjour TXT **without** `mode=discovery`,
   so iOS uses it as a candidate) — alongside the discovery beacon, distinct instance.
4. iOS — already LAN-preferring; ensure the stored post-pair route set includes the LAN
   route (or rely on Bonjour discovery + `/resolve`).

## Open sub-decisions (resolve while implementing)

- **Local-relay lifecycle**: own it in the controller startup (always-on) vs lazy on
  first terminal/connect. Lean: controller startup, so "tmux-style" it's already up.
- **Advert coexistence**: the discovery beacon (`mode=discovery`, for "Add a Mac") and
  the route-grade local-relay advert must coexist as separate `_oscout-pair._tcp`
  instances without fighting (the beacon currently stands down during pair mode).
- **Reconnect persistence**: confirm a phone that paired remotely still discovers and
  prefers the LAN route on the same network (Bonjour + `/resolve`, no re-pair).

## Blast radius & verification

- Server-side (controller/runtime/relay-runtime) → **rebuild the cli/web bundle +
  respawn the controller**. Medium-high risk (dual-presence routing; don't regress mesh).
- Verify: `dns-sd -B` shows a non-`discovery` advert on `43131`; on the same LAN a
  sim/phone connects with `currentRoute == .lan` and **no `:443`/mesh socket**; pull
  off-LAN → falls back to mesh.

Related: `reference_lan_beacon_advertises_dead_relay`, `reference_bridge_runs_from_cli_bundle`.
