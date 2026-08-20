import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  FlightRecord,
  InvocationRequest,
  WorkItemRecord,
} from "@openscout/protocol";

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
});
