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

describe("bucketAgentsByMachine", () => {
  test("keeps fleet agents on the local bucket and hides localhost tailnet peers", () => {
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
});
