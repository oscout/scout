import { describe, expect, test } from "bun:test";
import type { AgentEndpoint, CollaborationRecord, FlightRecord } from "@openscout/protocol";

import { createRuntimeRegistrySnapshot } from "./registry.js";
import {
  idleRelayAgentSessionCandidates,
  RelayAgentSessionReaper,
  type RelayAgentTmuxSession,
} from "./broker-relay-agent-reaper.js";

const NOW = 10_000_000;
const TTL = 60_000;

function session(overrides: Partial<RelayAgentTmuxSession> = {}): RelayAgentTmuxSession {
  return {
    name: "session-old",
    attached: 0,
    createdAtMs: NOW - TTL * 10,
    activityAtMs: NOW - TTL - 1,
    ...overrides,
  };
}

function owners(entries: Record<string, string> = { "session-old": "session-old" }): Map<string, string> {
  return new Map(Object.entries(entries));
}

function flight(state: FlightRecord["state"], overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "session-old",
    state,
    ...overrides,
  };
}

function endpoint(overrides: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint.session-old.node-1.tmux",
    agentId: "session-old",
    nodeId: "node-1",
    transport: "tmux",
    harness: "claude",
    state: "idle",
    sessionId: "session-old",
    metadata: {},
    ...overrides,
  };
}

describe("idleRelayAgentSessionCandidates", () => {
  test("reaps an attributed relay session idle past its TTL", () => {
    const candidates = idleRelayAgentSessionCandidates({
      sessions: [session()],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot(),
      now: NOW,
      idleTtlMs: TTL,
    });
    expect(candidates.map((candidate) => candidate.session.name)).toEqual(["session-old"]);
    expect(candidates[0]?.agentId).toBe("session-old");
  });

  test("never touches a session the relay registry does not claim", () => {
    expect(idleRelayAgentSessionCandidates({
      sessions: [session({ name: "operator-scratchpad" })],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot(),
      now: NOW,
      idleTtlMs: TTL,
    })).toEqual([]);
  });

  test("spares a session with an attached tmux client", () => {
    expect(idleRelayAgentSessionCandidates({
      sessions: [session({ attached: 1 })],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot(),
      now: NOW,
      idleTtlMs: TTL,
    })).toEqual([]);
  });

  test("spares fresh tmux activity and fresh creation", () => {
    expect(idleRelayAgentSessionCandidates({
      sessions: [session({ activityAtMs: NOW - TTL + 1 })],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot(),
      now: NOW,
      idleTtlMs: TTL,
    })).toEqual([]);

    expect(idleRelayAgentSessionCandidates({
      sessions: [session({ activityAtMs: null, createdAtMs: NOW - 1 })],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot(),
      now: NOW,
      idleTtlMs: TTL,
    })).toEqual([]);
  });

  test("spares an agent with an active flight, active collaboration, or active endpoint", () => {
    const base = {
      sessions: [session()],
      owners: owners(),
      now: NOW,
      idleTtlMs: TTL,
    };

    expect(idleRelayAgentSessionCandidates({
      ...base,
      snapshot: createRuntimeRegistrySnapshot({ flights: { "flight-1": flight("running") } }),
    })).toEqual([]);

    const work: CollaborationRecord = {
      id: "work-1",
      kind: "work_item",
      title: "Long-running task",
      createdById: "operator",
      ownerId: "session-old",
      state: "waiting",
      acceptanceState: "accepted",
      createdAt: NOW - TTL * 5,
      updatedAt: NOW - TTL * 5,
    };
    expect(idleRelayAgentSessionCandidates({
      ...base,
      snapshot: createRuntimeRegistrySnapshot({ collaborationRecords: { [work.id]: work } }),
    })).toEqual([]);

    const active = endpoint({ state: "active" });
    expect(idleRelayAgentSessionCandidates({
      ...base,
      snapshot: createRuntimeRegistrySnapshot({ endpoints: { [active.id]: active } }),
    })).toEqual([]);
  });

  test("spares an agent whose flight targets the instance-qualified id", () => {
    const qualified = flight("running", { targetAgentId: "session-old.codex-branch.node-local" });
    expect(idleRelayAgentSessionCandidates({
      sessions: [session()],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot({ flights: { [qualified.id]: qualified } }),
      now: NOW,
      idleTtlMs: TTL,
    })).toEqual([]);
  });

  test("extends idleness with broker-side activity", () => {
    const completed = flight("completed", { completedAt: NOW - 1 });
    expect(idleRelayAgentSessionCandidates({
      sessions: [session()],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot({ flights: { [completed.id]: completed } }),
      now: NOW,
      idleTtlMs: TTL,
    })).toEqual([]);

    const recentlyDispatched = endpoint({ metadata: { lastCompletedAt: NOW - 1 } });
    expect(idleRelayAgentSessionCandidates({
      sessions: [session()],
      owners: owners(),
      snapshot: createRuntimeRegistrySnapshot({ endpoints: { [recentlyDispatched.id]: recentlyDispatched } }),
      now: NOW,
      idleTtlMs: TTL,
    })).toEqual([]);
  });
});

describe("RelayAgentSessionReaper", () => {
  function buildReaper(input: {
    sessions: RelayAgentTmuxSession[];
    owners?: Map<string, string>;
    snapshots?: Array<ReturnType<typeof createRuntimeRegistrySnapshot>>;
  }) {
    const killed: string[] = [];
    const reconciled: Array<{ liveSessionNames: ReadonlySet<string> }> = [];
    const snapshots = input.snapshots ?? [createRuntimeRegistrySnapshot()];
    let snapshotIndex = 0;
    const reaper = new RelayAgentSessionReaper({
      snapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!,
      listTmuxSessions: async () => input.sessions,
      listSessionOwners: async () => input.owners ?? owners(),
      killSession: async (sessionName) => {
        killed.push(sessionName);
      },
      reconcileLeases: (reconcileInput) => {
        reconciled.push({ liveSessionNames: reconcileInput.liveSessionNames });
      },
      idleTtlMs: TTL,
      now: () => NOW,
    });
    return { reaper, killed, reconciled };
  }

  test("startup sweep reaps a previous-run orphan and drops it from the live set", async () => {
    const orphan = session({ name: "session-orphan", activityAtMs: NOW - TTL * 100 });
    const fresh = session({ name: "session-fresh", activityAtMs: NOW - 1 });
    const { reaper, killed, reconciled } = buildReaper({
      sessions: [orphan, fresh],
      owners: owners({ "session-orphan": "session-orphan", "session-fresh": "session-fresh" }),
    });

    expect(await reaper.sweep("startup")).toBe(1);
    expect(killed).toEqual(["session-orphan"]);
    expect([...reconciled[0]!.liveSessionNames]).toEqual(["session-fresh"]);
  });

  test("a flight dispatched between selection and kill wins the race", async () => {
    const idle = createRuntimeRegistrySnapshot();
    const busy = createRuntimeRegistrySnapshot({ flights: { "flight-1": flight("running") } });
    const { reaper, killed } = buildReaper({
      sessions: [session()],
      snapshots: [idle, busy],
    });

    expect(await reaper.sweep("periodic")).toBe(0);
    expect(killed).toEqual([]);
  });

  test("a kill failure is contained and the sweep continues", async () => {
    const first = session({ name: "session-a" });
    const second = session({ name: "session-b" });
    const killed: string[] = [];
    const reaper = new RelayAgentSessionReaper({
      snapshot: () => createRuntimeRegistrySnapshot(),
      listTmuxSessions: async () => [first, second],
      listSessionOwners: async () => owners({ "session-a": "session-a", "session-b": "session-b" }),
      killSession: async (sessionName) => {
        if (sessionName === "session-a") {
          throw new Error("tmux unavailable");
        }
        killed.push(sessionName);
      },
      idleTtlMs: TTL,
      now: () => NOW,
    });

    expect(await reaper.sweep("periodic")).toBe(1);
    expect(killed).toEqual(["session-b"]);
  });
});
