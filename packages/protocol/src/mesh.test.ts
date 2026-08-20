import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL,
  DEFAULT_OPENSCOUT_MOBILE_PAIRING_RELAY_URL,
  OPENSCOUT_IROH_MESH_ALPN,
  OPENSCOUT_MESH_PROTOCOL_VERSION,
  buildUnsignedMeshPresence,
  type NodeMeshEntrypoint,
} from "./mesh.ts";

describe("mesh entrypoint contract", () => {
  test("uses the first OpenScout Mesh protocol identifiers", () => {
    expect(OPENSCOUT_MESH_PROTOCOL_VERSION).toBe(1);
    expect(OPENSCOUT_IROH_MESH_ALPN).toBe("openscout/mesh/0");
    expect(DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL).toBe("https://mesh.oscout.net");
    expect(DEFAULT_OPENSCOUT_MOBILE_PAIRING_RELAY_URL).toBe("wss://mesh.oscout.net/v1/relay");
  });

  test("builds short-lived unsigned presence for Cloudflare rendezvous", () => {
    const entrypoint: NodeMeshEntrypoint = {
      kind: "iroh",
      endpointId: "endpoint-id",
      endpointAddr: { id: "endpoint-id", addrs: [] },
      alpn: OPENSCOUT_IROH_MESH_ALPN,
      bridgeProtocolVersion: OPENSCOUT_MESH_PROTOCOL_VERSION,
    };

    expect(
      buildUnsignedMeshPresence({
        node: {
          id: "node-1",
          meshId: "mesh-1",
          name: "MacBook Pro",
        },
        entrypoints: [entrypoint],
        issuedAt: 1000,
        ttlMs: 5000,
      }),
    ).toEqual({
      v: 1,
      meshId: "mesh-1",
      nodeId: "node-1",
      nodeName: "MacBook Pro",
      issuedAt: 1000,
      expiresAt: 6000,
      entrypoints: [entrypoint],
    });
  });

  test("allows mobile pairing entrypoints for OSN discovery", () => {
    const entrypoint: NodeMeshEntrypoint = {
      kind: "mobile_pairing",
      relay: "wss://relay.oscout.net",
      fallbackRelays: ["wss://relay.tailnet.ts.net:43131"],
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 60_000,
    };

    expect(
      buildUnsignedMeshPresence({
        node: {
          id: "node-1",
          meshId: "mesh-1",
          name: "MacBook Pro",
        },
        entrypoints: [entrypoint],
        issuedAt: 1000,
        ttlMs: 5000,
      }).entrypoints[0],
    ).toEqual(entrypoint);
  });
});
