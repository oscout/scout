import { describe, expect, test } from "bun:test";

import {
  projectPeerSnapshot,
  type PeerSnapshotProjectionOptions,
} from "./peer-snapshot-projection.ts";

function stream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function options(overrides: Partial<PeerSnapshotProjectionOptions> = {}): PeerSnapshotProjectionOptions {
  return { nodeId: "arc-server-openscout", limit: 24, maxBytes: 64 * 1024 * 1024, ...overrides };
}

/** The shape older brokers actually serve: whole registry, sections in order. */
function snapshot(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    nodes: { "arc-server-openscout": { id: "arc-server-openscout", name: "arc-server" } },
    actors: { op: { id: "op" } },
    agents: {
      "exedev.arc-server": {
        id: "exedev.arc-server",
        displayName: "Exedev",
        homeNodeId: "arc-server-openscout",
        metadata: { role: "Agent", projectRoot: "/home/exedev" },
      },
      "remix-lab.main.ocean-iron": {
        id: "remix-lab.main.ocean-iron",
        displayName: "Remix Lab",
        homeNodeId: "ocean-iron-openscout",
      },
      "orphan.agent": { id: "orphan.agent", displayName: "Orphan" },
    },
    endpoints: {
      "ep-1": { id: "ep-1", agentId: "exedev.arc-server", nodeId: "arc-server-openscout", harness: "claude", transport: "tmux", state: "active", lastSeenAt: 1_000 },
      "ep-2": { id: "ep-2", agentId: "remix-lab.main.ocean-iron", nodeId: "ocean-iron-openscout", harness: "codex", state: "active" },
    },
    conversations: { c1: { id: "c1", title: "unrelated" } },
    messages: { m1: { id: "m1", body: 'a secret with { braces } and "quotes" and a trailing backslash \\' } },
    flights: {
      "flt-1": { id: "flt-1", state: "running", targetAgentId: "exedev.arc-server", createdAt: 900 },
      "flt-2": { id: "flt-2", state: "running", targetAgentId: "remix-lab.main.ocean-iron" },
    },
    collaborationRecords: {},
    ...extra,
  });
}

describe("projectPeerSnapshot", () => {
  test("keeps only what belongs to the node that was asked about", async () => {
    const projection = await projectPeerSnapshot(stream(snapshot()), options());

    expect(projection.agents.map((a) => a.id)).toEqual(["exedev.arc-server"]);
    expect(projection.endpoints.map((e) => e.id)).toEqual(["ep-1"]);
    expect(projection.flights.map((f) => f.id)).toEqual(["flt-1"]);
    expect(projection.matched).toEqual({ agents: 1, endpoints: 1, flights: 1 });
    expect(projection.scanned.agents).toBe(3);
    expect(projection.unattributed).toBe(2);
  });

  test("reports which sections it actually read", async () => {
    const projection = await projectPeerSnapshot(stream(snapshot()), options());
    expect(projection.complete.sort()).toEqual(["agents", "endpoints", "flights"]);
  });

  test("survives braces and escaped quotes inside unrelated sections", async () => {
    // The message body above contains { } and escaped quotes; a scanner that
    // does not track strings would lose the structure and drop later sections.
    const projection = await projectPeerSnapshot(stream(snapshot(), 3), options());
    expect(projection.flights.map((f) => f.id)).toEqual(["flt-1"]);
  });

  test("reads the same result whatever the chunk boundaries are", async () => {
    for (const size of [1, 2, 5, 13, 997, 1_000_000]) {
      const projection = await projectPeerSnapshot(stream(snapshot(), size), options());
      expect(projection.agents.map((a) => a.id)).toEqual(["exedev.arc-server"]);
      expect(projection.flights.map((f) => f.id)).toEqual(["flt-1"]);
    }
  });

  test("bounds the kept records while keeping the totals exact", async () => {
    const agents: Record<string, unknown> = {};
    for (let i = 0; i < 50; i += 1) {
      agents[`a${i}`] = { id: `a${i}`, displayName: `A${i}`, homeNodeId: "arc-server-openscout" };
    }
    const projection = await projectPeerSnapshot(
      stream(JSON.stringify({ agents, endpoints: {}, flights: {} })),
      options({ limit: 5 }),
    );

    expect(projection.agents).toHaveLength(5);
    expect(projection.matched.agents).toBe(50);
    expect(projection.scanned.agents).toBe(50);
  });

  test("stops at the byte ceiling and says the counts are partial", async () => {
    const agents: Record<string, unknown> = {};
    for (let i = 0; i < 400; i += 1) {
      agents[`a${i}`] = { id: `a${i}`, displayName: `padding-${"x".repeat(200)}`, homeNodeId: "arc-server-openscout" };
    }
    const projection = await projectPeerSnapshot(
      stream(JSON.stringify({ agents, flights: {} }), 512),
      options({ maxBytes: 4_096 }),
    );

    expect(projection.truncated).toBe(true);
    expect(projection.complete).not.toContain("agents");
    expect(projection.bytesRead).toBeLessThan(20_000);
  });

  test("does not carry message or conversation material off the peer", async () => {
    const projection = await projectPeerSnapshot(stream(snapshot()), options());
    const wire = JSON.stringify(projection);
    expect(wire).not.toContain("a secret");
    expect(wire).not.toContain("unrelated");
  });

  test("matches work by the agents it found, not by the node id alone", async () => {
    // flights carry no nodeId; a flight counts only when its target is an agent
    // this scan already attributed to the node.
    const projection = await projectPeerSnapshot(stream(snapshot()), options({ nodeId: "ocean-iron-openscout" }));
    expect(projection.agents.map((a) => a.id)).toEqual(["remix-lab.main.ocean-iron"]);
    expect(projection.flights.map((f) => f.id)).toEqual(["flt-2"]);
  });

  test("an empty body is not an empty machine", async () => {
    const projection = await projectPeerSnapshot(null, options());
    expect(projection.complete).toEqual([]);
    expect(projection.matched.agents).toBe(0);
  });

  test("attributes work even when the peer sends flights before agents", async () => {
    // Section order is the peer's choice, and JSON objects carry no promise
    // about it. "Nothing in flight" must not mean "flights happened to come
    // first in this build's serializer".
    const body = JSON.stringify({
      flights: {
        "flt-1": { id: "flt-1", state: "running", targetAgentId: "exedev.arc-server", startedAt: 900 },
        "flt-2": { id: "flt-2", state: "running", targetAgentId: "remix-lab.main.ocean-iron" },
      },
      agents: {
        "exedev.arc-server": { id: "exedev.arc-server", displayName: "Exedev", homeNodeId: "arc-server-openscout" },
        "remix-lab.main.ocean-iron": { id: "remix-lab.main.ocean-iron", homeNodeId: "ocean-iron-openscout" },
      },
      endpoints: {},
    });

    const projection = await projectPeerSnapshot(stream(body), options());

    expect(projection.matched.flights).toBe(1);
    expect(projection.flights.map((flight) => flight.id)).toEqual(["flt-1"]);
  });

  test("keeps running work when the cap cannot hold every record", async () => {
    // The live case: 82 work records, room for a handful. Insertion order puts
    // the oldest first, so an unranked cap fills with finished work.
    const flights: Record<string, unknown> = {};
    for (let index = 0; index < 60; index += 1) {
      flights[`old-${index}`] = {
        id: `old-${index}`,
        state: "completed",
        targetAgentId: "exedev.arc-server",
        startedAt: 1_000 + index,
        completedAt: 2_000 + index,
      };
    }
    flights["live-1"] = { id: "live-1", state: "running", targetAgentId: "exedev.arc-server", startedAt: 10 };

    const projection = await projectPeerSnapshot(stream(snapshot({ flights })), options({ limit: 3 }));

    expect(projection.matched.flights).toBe(61);
    expect(projection.flights[0]?.id).toBe("live-1");
    expect(projection.flights.length).toBe(3);
  });

  test("drops a single record that grows past the per-record bound", async () => {
    const huge = "y".repeat(800 * 1024);
    const body = JSON.stringify({
      agents: {
        "bloated.agent": {
          id: "bloated.agent",
          homeNodeId: "arc-server-openscout",
          metadata: { blob: huge },
        },
        "exedev.arc-server": {
          id: "exedev.arc-server",
          displayName: "Exedev",
          homeNodeId: "arc-server-openscout",
        },
      },
      endpoints: {},
      flights: {},
    });

    const projection = await projectPeerSnapshot(stream(body, 64 * 1024), options());

    expect(projection.oversizeRecords).toBe(1);
    // The scan recovers: the record after the one we abandoned still lands.
    expect(projection.agents.map((agent) => agent.id)).toEqual(["exedev.arc-server"]);
  });
});
