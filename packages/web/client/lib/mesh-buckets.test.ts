import { describe, expect, test } from "bun:test";

import type { Agent, MeshStatus } from "./types.ts";
import { bucketAgentsByMachine } from "./mesh-buckets.ts";

function agent(id: string): Agent {
  return {
    id,
    definitionId: id,
    name: id,
    state: "available",
    staleLocalRegistration: false,
    retiredFromFleet: false,
    agentClass: "general",
  } as Agent;
}

/** The shape #906 was reported against: six current nodes, ten tailnet peers. */
function liveMesh(): MeshStatus {
  return {
    localNode: { id: "arts-mini-openscout", name: "arts-mini.local", hostName: "arts-mini.local" },
    nodes: {
      "arts-mini-openscout": { id: "arts-mini-openscout", name: "arts-mini.local", hostName: "arts-mini.local" },
      "mini-openscout": { id: "mini-openscout", name: "mini", hostName: "mini", brokerUrl: "https://mini.tail1.ts.net.:43110" },
      "ocean-iron-openscout": { id: "ocean-iron-openscout", name: "ocean-iron", hostName: "ocean-iron" },
      "air-local-openscout": { id: "air-local-openscout", name: "air.local", hostName: "air.local" },
      "studio-lab-3-openscout": { id: "studio-lab-3-openscout", name: "studio-lab-3", hostName: "studio-lab-3" },
      "arc-server-openscout": { id: "arc-server-openscout", name: "arc-server", hostName: "arc-server" },
    },
    tailscale: {
      available: true,
      running: true,
      peers: [
        { id: "p-ocean", name: "ocean-iron", hostName: "ocean-iron", dnsName: "ocean-iron.tail1.ts.net.", addresses: ["100.121.36.97"], online: true, os: "linux" },
        { id: "p-air", name: "air", hostName: "air", dnsName: "air.tail1.ts.net.", addresses: ["100.104.66.99"], online: true, os: "macOS" },
        { id: "p-mini", name: "mini", hostName: "mini", dnsName: "mini.tail1.ts.net.", addresses: ["100.123.16.74"], online: true, os: "macOS" },
        { id: "p-lab3", name: "studio-lab-3", hostName: "studio-lab-3", dnsName: "studio-lab-3.tail1.ts.net.", addresses: ["100.85.132.44"], online: true, os: "linux" },
        { id: "p-arc", name: "arc-server", hostName: "arc-server", dnsName: "arc-server.tail1.ts.net.", addresses: ["100.125.19.93"], online: true, os: "linux" },
        { id: "p-lab", name: "studio-lab", hostName: "studio-lab", dnsName: "studio-lab.tail1.ts.net.", addresses: ["100.77.8.121"], online: true, os: "linux" },
        { id: "p-lab2", name: "studio-lab-2", hostName: "studio-lab-2", dnsName: "studio-lab-2.tail1.ts.net.", addresses: ["100.95.68.37"], online: false, os: "linux" },
        { id: "p-ai", name: "ai", hostName: "ai", dnsName: "ai.tail1.ts.net.", addresses: ["100.94.240.95"], online: true, os: "linux" },
        { id: "p-ipad", name: "localhost", hostName: "localhost", dnsName: "ipad-air-5th-gen-wifi.tail1.ts.net.", addresses: ["100.89.196.79"], online: false, os: "iOS" },
        { id: "p-iphone", name: "localhost", hostName: "localhost", dnsName: "iphone-13-mini.tail1.ts.net.", addresses: ["100.94.226.89"], online: true, os: "iOS" },
      ],
    },
  } as unknown as MeshStatus;
}

describe("bucketAgentsByMachine", () => {
  test("keeps fleet agents on the local bucket and hides true loopback tailnet peers", () => {
    const mesh = {
      localNode: { id: "arts-mini-openscout", name: "arts-mini.local", hostName: "arts-mini.local" },
      nodes: {
        "arts-mini-openscout": { id: "arts-mini-openscout", name: "arts-mini.local", hostName: "arts-mini.local" },
      },
      tailscale: {
        available: true,
        running: true,
        peers: [
          { id: "peer-localhost", hostName: "localhost", dnsName: "localhost.", online: true },
          { id: "peer-arc", hostName: "arc-server", dnsName: "arc-server.tailnet.ts.net.", online: true },
        ],
      },
    } as unknown as MeshStatus;

    const buckets = bucketAgentsByMachine([
      agent("arc-author"),
      agent("session-mr8idz7a-gn5ntd"),
    ], mesh);

    const local = buckets.find((bucket) => bucket.machineId === "arts-mini-openscout");
    expect(local?.agents.map((row) => row.id)).toEqual(["arc-author"]);
    expect(buckets.some((bucket) => bucket.machineLabel === "localhost")).toBe(false);
    expect(buckets.some((bucket) => bucket.machineLabel === "arc-server")).toBe(true);
  });

  test("does not resurrect agents from peers filtered out of the mesh snapshot", () => {
    const mesh = {
      localNode: { id: "local-node", name: "Local", hostName: "local.test" },
      nodes: {
        "local-node": { id: "local-node", name: "Local", hostName: "local.test" },
        "current-peer": { id: "current-peer", name: "Current", hostName: "current.test" },
      },
      tailscale: { available: false, running: false, peers: [] },
    } as unknown as MeshStatus;
    const current = agent("current-agent");
    current.authorityNodeId = "current-peer";
    const filtered = agent("filtered-agent");
    filtered.authorityNodeId = "wrong-or-stale-peer";

    const buckets = bucketAgentsByMachine([current, filtered], mesh);

    expect(buckets.find((bucket) => bucket.machineId === "current-peer")?.agents).toEqual([current]);
    expect(buckets.some((bucket) => bucket.machineId === "wrong-or-stale-peer")).toBe(false);
  });

  // ── #906: inventory is independent of the agent roster ────────────────────

  test("renders every current mesh node even when the agent roster carries none of them", () => {
    // Exactly the failure: /api/agents?detail=summary returns only local cards.
    const buckets = bucketAgentsByMachine([agent("local-only-agent")], liveMesh());

    const nodeRows = buckets.filter((bucket) => bucket.kind === "node").map((bucket) => bucket.machineId);
    expect(nodeRows.sort()).toEqual([
      "air-local-openscout",
      "arc-server-openscout",
      "mini-openscout",
      "ocean-iron-openscout",
      "studio-lab-3-openscout",
    ]);
    for (const row of buckets.filter((bucket) => bucket.kind === "node")) {
      expect(row.agents).toEqual([]);
      expect(row.reachability).toBe("peer");
    }
  });

  test("a registered node never also appears as an anonymous tailnet row", () => {
    const buckets = bucketAgentsByMachine([], liveMesh());

    const tailnetRows = buckets.filter((bucket) => bucket.kind === "tailnet").map((bucket) => bucket.machineLabel);
    expect(tailnetRows.sort()).toEqual([
      "ai",
      "ipad-air-5th-gen-wifi",
      "iphone-13-mini",
      "studio-lab",
      "studio-lab-2",
    ]);
    expect(buckets.filter((bucket) => bucket.machineLabel === "arc-server")).toHaveLength(1);
  });

  test("tailnet devices reporting hostName localhost keep their MagicDNS identity", () => {
    const buckets = bucketAgentsByMachine([], liveMesh());

    const ipad = buckets.find((bucket) => bucket.machineLabel === "ipad-air-5th-gen-wifi");
    expect(ipad?.kind).toBe("tailnet");
    expect(ipad?.tailnet?.os).toBe("iOS");
    expect(ipad?.presence).toBe("unreachable");
    expect(buckets.find((bucket) => bucket.machineLabel === "iphone-13-mini")?.presence).toBe("reachable");
  });

  test("adopts tailnet evidence for node presence and stays unknown without it", () => {
    const mesh = liveMesh();
    // ocean-iron has an online tailnet twin; drop arc-server's twin entirely.
    mesh.tailscale.peers = mesh.tailscale.peers.filter((peer) => peer.id !== "p-arc");

    const buckets = bucketAgentsByMachine([], mesh);

    expect(buckets.find((bucket) => bucket.machineId === "ocean-iron-openscout")?.presence).toBe("reachable");
    const arc = buckets.find((bucket) => bucket.machineId === "arc-server-openscout");
    expect(arc?.presence).toBe("unknown");
    // Unknown is not "down" — the row must not be ghosted before anything probed it.
    expect(arc?.online).toBe(true);
  });

  test("a node whose tailnet twin is offline reads unreachable", () => {
    const mesh = liveMesh();
    mesh.tailscale.peers = mesh.tailscale.peers.map((peer) =>
      peer.id === "p-mini" ? { ...peer, online: false } : peer,
    );

    const buckets = bucketAgentsByMachine([], mesh);
    const mini = buckets.find((bucket) => bucket.machineId === "mini-openscout");
    expect(mini?.presence).toBe("unreachable");
    expect(mini?.online).toBe(false);
  });

  test("a stopped tailscale backend downgrades peer presence to unknown, not offline", () => {
    const mesh = liveMesh();
    mesh.tailscale.running = false;

    const buckets = bucketAgentsByMachine([], mesh);
    expect(buckets.find((bucket) => bucket.machineId === "air-local-openscout")?.presence).toBe("unknown");
    expect(buckets.find((bucket) => bucket.machineId === "air-local-openscout")?.online).toBe(true);
  });

  test("attaches remote agents to their node row and carries node identity", () => {
    const remote = agent("exedev.arc-server");
    remote.authorityNodeId = "arc-server-openscout";
    remote.homeNodeId = "arc-server-openscout";

    const buckets = bucketAgentsByMachine([agent("local-agent"), remote], liveMesh());

    const arc = buckets.find((bucket) => bucket.machineId === "arc-server-openscout");
    expect(arc?.agents.map((row) => row.id)).toEqual(["exedev.arc-server"]);
    expect(arc?.node?.nodeId).toBe("arc-server-openscout");
    expect(buckets.find((bucket) => bucket.kind === "this")?.agents.map((row) => row.id)).toEqual(["local-agent"]);
  });

  test("orders this host, then peers, then tailnet-only rows", () => {
    const buckets = bucketAgentsByMachine([], liveMesh());
    const kinds = buckets.map((bucket) => bucket.kind);
    expect(kinds[0]).toBe("this");
    expect(kinds.indexOf("tailnet")).toBeGreaterThan(kinds.lastIndexOf("node"));
  });
});
