import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  FlightRecord,
  InvocationRequest,
  WorkItemRecord,
} from "@openscout/protocol";

import { ActivityTransitionTracker } from "./activity-transitions.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";
import {
  projectObservedStatusForAgent,
  projectObservedStatusesFromRuntimeSnapshot,
} from "./observed-status-projection.js";

const now = 10_000;

function makeAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    agentClass: "operator",
    capabilities: ["invoke"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function makeEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state: "idle",
    metadata: {
      lastSeenAt: now - 1_000,
    },
    ...input,
  };
}

function makeInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "execute",
    task: "Run the focused tests.",
    ensureAwake: true,
    stream: false,
    createdAt: now - 2_000,
    ...input,
  };
}

function makeFlight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "inv-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    startedAt: now - 1_000,
    ...input,
  };
}

function makeWorkItem(input: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "work-1",
    kind: "work_item",
    title: "Finish the observer projection",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    state: "working",
    acceptanceState: "none",
    createdAt: now - 4_000,
    updatedAt: now - 500,
    ...input,
  };
}

describe("observed status projection", () => {
  test("uses active flights over endpoint idleness", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: { "endpoint-1": makeEndpoint({ state: "idle" }) },
      invocations: { "inv-1": makeInvocation() },
      flights: { "flight-1": makeFlight({ state: "running", summary: "Running tests" }) },
    });

    const status = projectObservedStatusForAgent(snapshot, "agent-1", { now });

    expect(status).toMatchObject({
      subjectKind: "flight",
      subjectId: "flight-1",
      phase: "running",
      activity: "working",
      confidence: 0.96,
      detail: {
        title: "Run the focused tests.",
        summary: "Running tests",
      },
    });
    expect(status.provenance[0]).toMatchObject({ source: "flight", refId: "flight-1" });
  });

  test("takes freshness from the freshest candidate, not the winning one", () => {
    // Selection is winner-take-all by rank and the flight wins, which is right
    // for *what* the agent is doing. It is wrong for *whether it is still
    // there*: the endpoint heartbeat is the only thing attesting the runtime is
    // alive, and discarding it dated a nine-minute turn to when it began.
    const startedAt = now - 9 * 60_000;
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: {
        "endpoint-1": makeEndpoint({
          state: "active",
          metadata: { lastSeenAt: now, lastStartedAt: startedAt },
        }),
      },
      invocations: { "inv-1": makeInvocation() },
      flights: { "flight-1": makeFlight({ state: "running", startedAt }) },
    });

    const status = projectObservedStatusForAgent(snapshot, "agent-1", { now });

    // What: the flight. How fresh: the endpoint.
    expect(status.subjectKind).toBe("flight");
    expect(status.activity).toBe("working");
    expect(status.updatedAt).toBe(now);
    expect(status.staleAt).toBe(now + 90_000);
  });

  test("dates time-in-state from when the activity began, not when it was last confirmed", () => {
    const startedAt = now - 9 * 60_000;
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: {
        "endpoint-1": makeEndpoint({
          state: "active",
          metadata: { lastSeenAt: now, lastStartedAt: startedAt },
        }),
      },
      invocations: { "inv-1": makeInvocation() },
      flights: { "flight-1": makeFlight({ state: "running", startedAt }) },
    });

    const status = projectObservedStatusForAgent(snapshot, "agent-1", {
      now,
      transitions: new ActivityTransitionTracker(),
    });

    expect(status.transitionAt).toBe(startedAt);
    expect(status.updatedAt).toBe(now);
  });

  test("recovers endpoint time-in-state from the record, not the heartbeat", () => {
    // The restart case: a fresh tracker has no memory, so the stamp has to come
    // out of the endpoint itself or every agent's clock resets to zero.
    const startedAt = now - 9 * 60_000;
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: {
        "endpoint-1": makeEndpoint({
          state: "active",
          metadata: { lastSeenAt: now, lastStartedAt: startedAt },
        }),
      },
    });

    const status = projectObservedStatusForAgent(snapshot, "agent-1", {
      now,
      transitions: new ActivityTransitionTracker(),
    });

    expect(status.subjectKind).toBe("endpoint");
    expect(status.activity).toBe("working");
    expect(status.transitionAt).toBe(startedAt);
  });

  test("lets collaboration attention override generic running state", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: { "endpoint-1": makeEndpoint({ state: "active" }) },
      invocations: { "inv-1": makeInvocation() },
      flights: { "flight-1": makeFlight({ state: "running" }) },
      collaborationRecords: {
        "work-1": makeWorkItem({
          state: "waiting",
          waitingOn: {
            kind: "actor",
            label: "Waiting on operator",
            targetId: "operator",
          },
        }),
      },
    });

    const status = projectObservedStatusForAgent(snapshot, "agent-1", { now });

    expect(status).toMatchObject({
      subjectKind: "work_item",
      subjectId: "work-1",
      phase: "running",
      activity: "waiting_on_actor",
      detail: {
        title: "Finish the observer projection",
        waitingOn: {
          kind: "actor",
          label: "Waiting on operator",
        },
      },
    });
    expect(status.provenance[0]).toMatchObject({ source: "collaboration_record", refId: "work-1" });
  });

  test("falls back to endpoint status when no work is active", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: { "endpoint-1": makeEndpoint({ state: "waiting" }) },
    });

    const status = projectObservedStatusForAgent(snapshot, "agent-1", { now });

    expect(status).toMatchObject({
      subjectKind: "endpoint",
      phase: "running",
      activity: "waiting_for_input",
    });
  });

  test("marks stale non-offline endpoints as inferred stalled status", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: {
        "endpoint-1": makeEndpoint({
          state: "active",
          metadata: {
            lastSeenAt: now - 120_000,
          },
        }),
      },
    });

    const status = projectObservedStatusForAgent(snapshot, "agent-1", {
      now,
      staleAfterMs: 60_000,
    });

    expect(status).toMatchObject({
      subjectKind: "endpoint",
      phase: "running",
      activity: "stalled",
      confidence: 0.58,
    });
    expect(status.provenance.map((item) => item.source)).toEqual([
      "endpoint",
      "staleness_inference",
    ]);
  });

  test("projects all agents touched by records", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      invocations: {
        "inv-2": makeInvocation({
          id: "inv-2",
          targetAgentId: "agent-2",
        }),
      },
      flights: {
        "flight-2": makeFlight({
          id: "flight-2",
          invocationId: "inv-2",
          targetAgentId: "agent-2",
          state: "queued",
        }),
      },
    });

    const statuses = projectObservedStatusesFromRuntimeSnapshot(snapshot, { now });

    expect(statuses.map((status) => status.agentId)).toEqual(["agent-1", "agent-2"]);
    expect(statuses[0]).toMatchObject({
      subjectKind: "agent",
      phase: "registered",
      activity: "unknown",
    });
    expect(statuses[1]).toMatchObject({
      subjectKind: "flight",
      phase: "registered",
      activity: "queued",
    });
  });

  test("bulk projection preserves the single-agent projection semantics", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        "agent-1": makeAgent(),
      },
      endpoints: {
        "endpoint-1": makeEndpoint({ state: "active" }),
        "endpoint-2": makeEndpoint({
          id: "endpoint-2",
          agentId: "agent-2",
          state: "waiting",
        }),
      },
      invocations: {
        "inv-1": makeInvocation(),
        "inv-3": makeInvocation({
          id: "inv-3",
          targetAgentId: "agent-3",
          createdAt: now - 1_500,
        }),
      },
      flights: {
        "flight-old": makeFlight({
          id: "flight-old",
          state: "queued",
          startedAt: now - 2_000,
        }),
        "flight-new": makeFlight({
          id: "flight-new",
          state: "running",
          startedAt: now - 1_000,
        }),
        "flight-3": makeFlight({
          id: "flight-3",
          invocationId: "inv-3",
          targetAgentId: "agent-3",
          state: "waiting",
          startedAt: now - 500,
        }),
      },
      collaborationRecords: {
        "work-old": makeWorkItem({
          id: "work-old",
          state: "open",
          updatedAt: now - 1_000,
        }),
        "work-new": makeWorkItem({
          id: "work-new",
          ownerId: "agent-4",
          nextMoveOwnerId: "agent-1",
          state: "review",
          updatedAt: now - 250,
        }),
      },
    });
    const agentIds = ["agent-1", "agent-2", "agent-3", "agent-4"];

    const bulk = projectObservedStatusesFromRuntimeSnapshot(snapshot, { now });
    const individually = agentIds.map((agentId) =>
      projectObservedStatusForAgent(snapshot, agentId, { now })
    );

    expect(bulk).toEqual(individually);
  });

  test("bulk projection enumerates each record collection only once", () => {
    const counts = new Map<string, number>();
    const counted = <T extends object>(name: string, value: T): T => new Proxy(value, {
      ownKeys(target) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return Reflect.ownKeys(target);
      },
    });
    const agents: Record<string, AgentDefinition> = {};
    const endpoints: Record<string, AgentEndpoint> = {};
    const invocations: Record<string, InvocationRequest> = {};
    const flights: Record<string, FlightRecord> = {};
    const collaborationRecords: Record<string, WorkItemRecord> = {};
    for (let index = 0; index < 64; index += 1) {
      const agentId = `agent-${index}`;
      agents[agentId] = makeAgent({ id: agentId, definitionId: agentId });
      endpoints[`endpoint-${index}`] = makeEndpoint({
        id: `endpoint-${index}`,
        agentId,
      });
      invocations[`inv-${index}`] = makeInvocation({
        id: `inv-${index}`,
        targetAgentId: agentId,
      });
      flights[`flight-${index}`] = makeFlight({
        id: `flight-${index}`,
        invocationId: `inv-${index}`,
        targetAgentId: agentId,
      });
      collaborationRecords[`work-${index}`] = makeWorkItem({
        id: `work-${index}`,
        ownerId: agentId,
        nextMoveOwnerId: agentId,
      });
    }
    const snapshot = createRuntimeRegistrySnapshot({
      agents: counted("agents", agents),
      endpoints: counted("endpoints", endpoints),
      invocations: counted("invocations", invocations),
      flights: counted("flights", flights),
      collaborationRecords: counted("collaborationRecords", collaborationRecords),
    });

    expect(projectObservedStatusesFromRuntimeSnapshot(snapshot, { now })).toHaveLength(64);
    expect(Object.fromEntries(counts)).toEqual({
      agents: 1,
      endpoints: 1,
      invocations: 1,
      flights: 1,
      collaborationRecords: 1,
    });
  });
});
