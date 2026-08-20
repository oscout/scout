import { describe, expect, test } from "bun:test";

import { buildPeerSeeds, discoverMeshNodes, resolveDiscoveredBrokerUrl } from "./mesh-discovery.js";

describe("resolveDiscoveredBrokerUrl", () => {
  test("uses the successfully probed route when a remote peer advertises loopback", () => {
    expect(resolveDiscoveredBrokerUrl(
      "http://127.0.0.1:43110",
      "http://100.64.0.22:43110",
    )).toBe("http://100.64.0.22:43110");
    expect(resolveDiscoveredBrokerUrl(
      "http://127.12.34.56:43110",
      "https://ocean-iron.tailnet.example:43110",
    )).toBe("https://ocean-iron.tailnet.example:43110");
  });

  test("rejects wildcard, localhost, invalid, and non-http advertised routes", () => {
    const observed = "https://192.168.1.22:43110";
    for (const advertised of [
      "http://0.0.0.0:43110",
      "http://[::]:43110",
      "http://[::1]:43110",
      "http://[::ffff:127.0.0.1]:43110",
      "http://localhost:43110",
      "http://peer.localhost:43110",
      "mesh://peer",
      "not a URL",
    ]) {
      expect(resolveDiscoveredBrokerUrl(advertised, observed)).toBe(observed);
    }
  });

  test("promotes the proven route when another private route is advertised", () => {
    expect(resolveDiscoveredBrokerUrl(
      "https://10.42.0.42:43110/",
      "https://100.121.36.97:43110",
    )).toBe("https://100.121.36.97:43110");
  });

  test("falls back to the observed route when no route is advertised", () => {
    expect(resolveDiscoveredBrokerUrl(
      undefined,
      "http://100.64.0.22:43110/",
    )).toBe("http://100.64.0.22:43110");
  });
});

describe("Tailnet mesh discovery", () => {
  test("probes authenticated HTTPS before legacy HTTP for each Tailnet host", () => {
    expect(buildPeerSeeds(
      "ocean-iron",
      ["100.121.36.97"],
      "ocean-iron.tailnet.example.",
      43110,
    )).toEqual([
      "https://ocean-iron.tailnet.example.:43110",
      "https://ocean-iron:43110",
      "https://100.121.36.97:43110",
      "http://ocean-iron.tailnet.example.:43110",
      "http://ocean-iron:43110",
      "http://100.121.36.97:43110",
    ]);
  });

  test("delegates HTTPS discovery to the signed-card pinned peer client", async () => {
    const calls: Array<{ baseUrl: string; path: string }> = [];
    const peerFetch = async (baseUrl: string, path: string): Promise<Response> => {
      calls.push({ baseUrl, path });
      return Response.json({
        id: "ocean-iron-openscout",
        meshId: "openscout",
        name: "ocean-iron",
        advertiseScope: "mesh",
        brokerUrl: "http://127.0.0.1:43110",
        capabilities: ["broker", "mesh"],
        registeredAt: 1,
        lastSeenAt: 1,
      });
    };

    await expect(discoverMeshNodes({
      localNodeId: "mac-openscout",
      localBrokerUrl: "http://127.0.0.1:43110",
      defaultPort: 43110,
      meshId: "openscout",
      seeds: ["https://100.121.36.97:43110"],
      peerFetch,
      readTailscalePeers: async () => [],
    })).resolves.toMatchObject({
      discovered: [{
        id: "ocean-iron-openscout",
        brokerUrl: "https://100.121.36.97:43110",
      }],
    });
    expect(calls).toEqual([{
      baseUrl: "https://100.121.36.97:43110",
      path: "/v1/node",
    }]);
  });
});
