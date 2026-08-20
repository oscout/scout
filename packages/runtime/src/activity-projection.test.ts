import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  WorkItemRecord,
} from "@openscout/protocol";

import {
  collectActivityEventsForAgent,
  projectAgentActivityFromRuntimeSnapshot,
  projectFleetActivityFromRuntimeSnapshot,
} from "./activity-projection.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";

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
    task: "Implement activity summaries.",
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
    title: "Ship activity model",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    state: "working",
    acceptanceState: "none",
    createdAt: now - 4_000,
    updatedAt: now - 700,
    ...input,
  };
}

function makeMessage(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    actorId: "agent-1",
    originNodeId: "node-1",
    class: "agent",
    body: "I am wiring the activity projection now.",
    visibility: "workspace",
    policy: "best_effort",
    createdAt: now - 600,
    ...input,
  };
}

describe("activity projection", () => {
  test("projects running flights as working activity", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: { "endpoint-1": makeEndpoint({ state: "idle" }) },
      invocations: { "inv-1": makeInvocation() },
      flights: { "flight-1": makeFlight({ summary: "Running the runtime tests" }) },
    });

    const agent = projectAgentActivityFromRuntimeSnapshot(snapshot, "agent-1", { now });
    const fleet = projectFleetActivityFromRuntimeSnapshot(snapshot, { now });

    expect(agent).toMatchObject({
      agentId: "agent-1",
      displayName: "Agent One",
      motion: "high",
      needsYou: false,
      currentWork: {
        title: "Implement activity summaries.",
        summary: "Running the runtime tests",
      },
      latestEvent: {
        id: "flight:flight-1",
        kind: "flight",
      },
    });
    expect(fleet).toMatchObject({
      totalAgents: 1,
      workingCount: 1,
      needsYouCount: 0,
      digest: {
        label: "In motion",
        summary: "1 agent is working",
      },
    });
  });

  test("keeps idle agents quiet", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      endpoints: { "endpoint-1": makeEndpoint({ state: "idle" }) },
    });

    const fleet = projectFleetActivityFromRuntimeSnapshot(snapshot, { now });

    expect(fleet).toMatchObject({
      totalAgents: 1,
      activeCount: 0,
      quietCount: 1,
      workingCount: 0,
      needsYouCount: 0,
      digest: {
        label: "Quiet",
        summary: "No active agent work",
        motion: "none",
      },
    });
  });

  test("sorts and limits latest agent events", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { "agent-1": makeAgent() },
      invocations: {
        "inv-1": makeInvocation({ createdAt: now - 2_000 }),
      },
      flights: {
        "flight-1": makeFlight({
          state: "completed",
          startedAt: now - 1_800,
          completedAt: now - 400,
          output: "Activity projection complete",
        }),
      },
      collaborationRecords: {
        "work-1": makeWorkItem({
          updatedAt: now - 300,
          progress: { summary: "Porting the list-row density" },
        }),
      },
      messages: {
        "msg-1": makeMessage({
          id: "msg-1",
          body: "Older status update",
          createdAt: now - 500,
        }),
        "msg-2": makeMessage({
          id: "msg-2",
          body: "Newest status update",
          createdAt: now - 100,
        }),
      },
    });

    const events = collectActivityEventsForAgent(snapshot, "agent-1", 2);

    expect(events.map((event) => event.id)).toEqual(["message:msg-2", "collaboration:work-1"]);
    expect(events.map((event) => event.summary)).toEqual([
      "Newest status update",
      "Porting the list-row density",
    ]);
  });
});
