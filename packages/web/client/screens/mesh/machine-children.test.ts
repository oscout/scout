import { describe, expect, test } from "bun:test";

import { canvasMachineBuckets, machineChildren, machineRowMeta } from "./machine-children.ts";
import type { MachineBucket } from "../../lib/mesh-buckets.ts";
import type { MeshNodeStateView } from "../../lib/mesh-node-state.ts";

function bucket(overrides: Partial<MachineBucket> = {}): MachineBucket {
  return {
    machineId: "arc-server-openscout",
    machineLabel: "arc-server",
    kind: "peer",
    reachability: "peer",
    agents: [],
    node: null,
    ...overrides,
  } as unknown as MachineBucket;
}

function agent(id: string, state = "callable") {
  return { id, name: id, state, updatedAt: 1 } as never;
}

function view(overrides: Partial<MeshNodeStateView> = {}): MeshNodeStateView {
  return {
    machineId: "arc-server-openscout",
    kind: "peer",
    label: "arc-server",
    network: "reachable",
    broker: "answered",
    detail: "full",
    source: "node-state",
    checkedAt: 1_000,
    observedAt: 1_000,
    stale: false,
    checking: false,
    error: null,
    node: null,
    workload: null,
    roster: [],
    sessions: null,
    work: null,
    failures: 0,
    nextAttemptAt: null,
    ...overrides,
  } as MeshNodeStateView;
}

describe("machineChildren", () => {
  test("lists this host's agents from the shared roster", () => {
    const children = machineChildren(
      bucket({ kind: "this", reachability: "this", agents: [agent("a"), agent("b")] as never }),
      null,
    );
    expect(children.map((child) => child.key)).toEqual(["a", "b"]);
    expect(children[0]?.agent).not.toBeNull();
  });

  test("never hangs local agents under a remote machine", () => {
    // The bucket still carries whatever the shared /api/agents response placed
    // here. That response is capped and filtered and shared with other screens:
    // it is what made a remote card appear and then vanish (#906).
    const children = machineChildren(
      bucket({ agents: [agent("leftover-from-a-full-response")] as never }),
      null,
    );
    expect(children).toEqual([]);
  });

  test("lists a remote machine's own roster once it reports", () => {
    const children = machineChildren(
      bucket({ agents: [agent("leftover")] as never }),
      view({
        roster: [
          {
            id: "exedev.arc-server",
            title: "Exedev",
            role: null,
            projectRoot: "/home/exedev",
            state: "working",
            statusLabel: "in a turn",
            lastSeenAt: 900,
          },
        ],
      }),
    );
    expect(children.map((child) => child.key)).toEqual(["exedev.arc-server"]);
    expect(children[0]?.tone).toBe("in_turn");
    // A remote row is a reading, not a handle to open.
    expect(children[0]?.agent).toBeNull();
  });
});

describe("machineRowMeta", () => {
  test("says it has not been checked rather than showing a dash", () => {
    expect(machineRowMeta(bucket(), null, false)).toBe("not checked yet");
  });

  test("shows counts only once the machine has reported them", () => {
    const meta = machineRowMeta(
      bucket(),
      view({ workload: { total: 9, working: 2, available: 7, offline: 0, truncated: false, unattributed: 0 } }),
      false,
    );
    expect(meta).toBe("2/9");
  });

  test("does not invent a working count a source could not attest", () => {
    const meta = machineRowMeta(
      bucket(),
      view({
        source: "snapshot",
        detail: "roster",
        workload: { total: 9, working: null, available: null, offline: null, truncated: false, unattributed: 3 },
      }),
      false,
    );
    expect(meta).toBe("9");
  });

  test("marks a stale reading as last known", () => {
    const meta = machineRowMeta(
      bucket(),
      view({ stale: true, workload: { total: 4, working: 1, available: 3, offline: 0, truncated: false, unattributed: 0 } }),
      false,
    );
    expect(meta).toBe("1/4 · last known");
  });
});


test("map inventory survives full-to-summary roster replacement without remote chips", () => {
  const mesh = { localNode: { id: "local", name: "local" }, nodes: {
    local: { id: "local", name: "local" }, remote: { id: "remote", name: "remote" },
  }, tailscale: { peers: [], running: true } } as unknown as import("../../lib/types.ts").MeshStatus;
  const local = { id: "local-agent", definitionId: "local-agent", name: "local-agent", state: "available", homeNodeId: "local", agentClass: "general" } as import("../../lib/types.ts").Agent;
  const remote = { ...local, id: "remote-agent", definitionId: "remote-agent", homeNodeId: "remote" };
  const full = canvasMachineBuckets([local, remote], mesh);
  const summary = canvasMachineBuckets([local], mesh);
  expect(full).toEqual(summary);
  expect(full.find((b) => b.machineId === "remote")?.agents).toEqual([]);
  expect(full.find((b) => b.machineId === "local")?.agents.map((a) => a.id)).toEqual(["local-agent"]);
});
