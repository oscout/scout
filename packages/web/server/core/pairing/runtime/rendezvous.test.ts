import { describe, expect, test } from "bun:test";

import { buildPairingRendezvousNode, startPairingRendezvousPublisher } from "./rendezvous.ts";
import type { PairingRuntimeSnapshot } from "./runtime-state.ts";

describe("pairing runtime OSN rendezvous", () => {
  test("builds a mobile pairing entrypoint from the live runtime snapshot", () => {
    const node = buildPairingRendezvousNode(makeSnapshot(), {
      env: {
        OPENSCOUT_MESH_ID: "openscout",
        OPENSCOUT_NODE_ID: "mac-mini-openscout",
        OPENSCOUT_NODE_NAME: "Arach's Mac mini",
      },
      now: 30_000,
    });

    expect(node).toMatchObject({
      id: "mac-mini-openscout",
      meshId: "openscout",
      name: "Arach's Mac mini",
      advertiseScope: "mesh",
      lastSeenAt: 30_000,
    });
    expect(node.meshEntrypoints).toEqual([
      {
        kind: "mobile_pairing",
        relay: "wss://mesh.oscout.net/v1/relay",
        fallbackRelays: ["wss://backup.oscout.net/v1/relay"],
        room: "room-1",
        publicKey: "a".repeat(64),
        expiresAt: 70_000,
        lastSeenAt: 12_000,
        metadata: {
          source: "openscout-pairing-runtime",
        },
      },
    ]);
  });

  test("does not start a publisher unless rendezvous is configured", () => {
    expect(startPairingRendezvousPublisher(() => makeSnapshot(), { env: {} })).toBeNull();
  });
});

function makeSnapshot(): PairingRuntimeSnapshot {
  return {
    version: 1,
    pid: 123,
    childPid: null,
    status: "connecting",
    statusLabel: "Pairing Ready",
    statusDetail: "Relay room room-1 is waiting for Scout.",
    connectedPeerFingerprint: null,
    relay: "wss://mesh.oscout.net/v1/relay",
    secure: true,
    lanDiscoveryAdvertised: false,
    workspaceRoot: null,
    sessionCount: 0,
    identityFingerprint: "aaaaaaaaaaaaaaaa",
    trustedPeerCount: 1,
    pairing: {
      relay: "wss://mesh.oscout.net/v1/relay",
      fallbackRelays: ["wss://backup.oscout.net/v1/relay"],
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 70_000,
      qrArt: "qr",
      qrValue: "{}",
    },
    startedAt: 10_000,
    updatedAt: 12_000,
  };
}
