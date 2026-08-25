import { describe, expect, test } from "bun:test";

import { httpMeshUrlsForNode, meshDialRank, orderMeshDialUrls } from "./mesh-dial-order.ts";

describe("orderMeshDialUrls", () => {
  test("puts LAN before Tailscale and MagicDNS", () => {
    expect(orderMeshDialUrls([
      "https://100.123.16.74:43110",
      "https://air.tail1e8e67.ts.net:43110",
      "https://192.168.18.14:43110",
    ])).toEqual([
      "https://192.168.18.14:43110",
      "https://100.123.16.74:43110",
      "https://air.tail1e8e67.ts.net:43110",
    ]);
  });

  test("keeps .local with LAN, ahead of Tailscale", () => {
    expect(orderMeshDialUrls([
      "https://mini.tail1e8e67.ts.net:43110",
      "https://Peer-Workstation-9.local:43110",
    ])).toEqual([
      "https://Peer-Workstation-9.local:43110",
      "https://mini.tail1e8e67.ts.net:43110",
    ]);
  });

  test("dedupes and preserves relative order within a rank", () => {
    expect(orderMeshDialUrls([
      "https://192.168.18.14:43110",
      "https://192.168.18.22:43110",
      "https://192.168.18.14:43110",
    ])).toEqual([
      "https://192.168.18.14:43110",
      "https://192.168.18.22:43110",
    ]);
  });
});

describe("meshDialRank", () => {
  test("classifies LAN, Tailscale, and other hosts", () => {
    expect(meshDialRank("https://192.168.18.22:43110")).toBe(0);
    expect(meshDialRank("https://Peer-Workstation.local:43110")).toBe(0);
    expect(meshDialRank("https://100.115.12.115:43110")).toBe(1);
    expect(meshDialRank("https://air.tail1e8e67.ts.net:43110")).toBe(1);
    expect(meshDialRank("https://ocean-iron.example:43110")).toBe(2);
  });
});

describe("httpMeshUrlsForNode", () => {
  test("collects brokerUrl and http entrypoints, LAN first", () => {
    expect(httpMeshUrlsForNode({
      brokerUrl: "https://100.123.16.74:43110",
      meshEntrypoints: [
        { kind: "http", url: "https://192.168.18.14:43110" },
      ],
    })).toEqual([
      "https://192.168.18.14:43110",
      "https://100.123.16.74:43110",
    ]);
  });
});
