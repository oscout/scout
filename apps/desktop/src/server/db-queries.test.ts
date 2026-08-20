import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDb,
  queryActivity,
  queryAgents,
  queryFleet,
  queryFlights,
  queryMobileAgentDetail,
  queryWorkItemById,
  queryWorkItems,
} from "./db-queries.ts";
import { SQLiteControlPlaneStore } from "../../../../packages/runtime/src/sqlite-store.ts";

const tempRoots = new Set<string>();
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;

afterEach(() => {
  closeDb();
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createSeededStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-desktop-db-queries-"));
  tempRoots.add(root);
  process.env.OPENSCOUT_CONTROL_HOME = root;
  const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));

  store.upsertNode({
    id: "node-1",
    meshId: "mesh-1",
    name: "Test node",
    advertiseScope: "local",
    registeredAt: Date.now(),
  });
  store.upsertActor({
    id: "operator",
    kind: "person",
    displayName: "Operator",
  });
  store.upsertActor({
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
  });
  store.upsertAgent({
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
  });
  store.upsertEndpoint({
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "claude",
    transport: "claude_stream_json",
    state: "active",
    sessionId: "session-1",
    cwd: join(tmpdir(), "openscout-agent-1", "cwd"),
    projectRoot: join(tmpdir(), "openscout-agent-1"),
  });
  store.upsertConversation({
    id: "conv-1",
    kind: "direct",
    title: "Direct",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["agent-1", "operator"],
  });
  store.recordCollaborationRecord({
    id: "work-1",
    kind: "work_item",
    title: "Observed work",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    conversationId: "conv-1",
    state: "working",
    acceptanceState: "none",
    requestedById: "operator",
    createdAt: 90,
    updatedAt: 90,
  });
  store.recordCollaborationRecord({
    id: "work-1-child",
    kind: "work_item",
    title: "Child work",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    parentId: "work-1",
    conversationId: "conv-1",
    state: "open",
    acceptanceState: "none",
    requestedById: "agent-1",
    createdAt: 95,
    updatedAt: 95,
  });
  store.recordCollaborationEvent({
    id: "event-1",
    recordId: "work-1",
    recordKind: "work_item",
    kind: "claimed",
    actorId: "agent-1",
    summary: "Claimed for implementation",
    at: 110,
  });
  store.recordInvocation({
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "Do the work",
    collaborationRecordId: "work-1",
    conversationId: "conv-1",
    ensureAwake: true,
    stream: false,
    createdAt: 100,
  });
  store.recordFlight({
    id: "flight-1",
    invocationId: "inv-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    summary: "In progress",
    startedAt: 101,
  });

  return store;
}

describe("desktop db query flights", () => {
  test("surfaces durable collaboration joins from invocations", () => {
    const store = createSeededStore();

    try {
      const flights = queryFlights({ collaborationRecordId: "work-1" });

      expect(flights).toEqual([
        {
          id: "flight-1",
          invocationId: "inv-1",
          agentId: "agent-1",
          agentName: "Agent One",
          conversationId: "conv-1",
          collaborationRecordId: "work-1",
          state: "running",
          summary: "In progress",
          startedAt: 101,
          completedAt: null,
        },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("desktop db query agents", () => {
  test("does not mark queued backlog as working when nothing is executing", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({
        id: "agent-2",
        kind: "agent",
        displayName: "Agent Two",
      });
      store.upsertAgent({
        id: "agent-2",
        kind: "agent",
        definitionId: "agent-2",
        displayName: "Agent Two",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertEndpoint({
        id: "endpoint-2",
        agentId: "agent-2",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        sessionId: "session-2",
        cwd: join(tmpdir(), "openscout-agent-2", "cwd"),
        projectRoot: join(tmpdir(), "openscout-agent-2"),
      });
      store.upsertConversation({
        id: "conv-2",
        kind: "direct",
        title: "Direct Two",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-2", "operator"],
      });
      store.recordInvocation({
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-2",
        action: "consult",
        task: "Check later",
        conversationId: "conv-2",
        ensureAwake: true,
        stream: false,
        createdAt: 200,
      });
      store.recordFlight({
        id: "flight-2",
        invocationId: "inv-2",
        requesterId: "operator",
        targetAgentId: "agent-2",
        state: "queued",
        summary: "Queued for later delivery",
        startedAt: 201,
      });

      const listEntry = queryAgents(10).find((entry) => entry.id === "agent-2");
      const detail = queryMobileAgentDetail("agent-2");

      expect(listEntry?.state).toBe("available");
      expect(detail?.state).toBe("available");
      expect(detail?.activeFlights.map((flight) => flight.state)).toEqual(["queued"]);
    } finally {
      store.close();
    }
  });

  test("filters duplicate replies and stale-flight reconciliation from top activity", () => {
    const store = createSeededStore();

    try {
      store.recordMessage({
        id: "msg-operator",
        conversationId: "conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Please check this",
        visibility: "private",
        policy: "durable",
        createdAt: 150,
      });
      store.recordMessage({
        id: "msg-reply",
        conversationId: "conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Done.",
        replyToMessageId: "msg-operator",
        visibility: "private",
        policy: "durable",
        createdAt: 160,
      });
      store.recordFlight({
        id: "flight-stale",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        summary: "Agent One did not finish cleanly.",
        error: "Stale running flight reconciled: endpoint endpoint-1 moved to offline",
        startedAt: 155,
        completedAt: 170,
      });
      store.recordInvocation({
        id: "inv-dup-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Reply once",
        conversationId: "conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 171,
      });
      store.recordFlight({
        id: "flight-dup-1",
        invocationId: "inv-dup-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Agent One replied.",
        startedAt: 172,
        completedAt: 180,
      });
      store.recordInvocation({
        id: "inv-dup-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Reply twice",
        conversationId: "conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 173,
      });
      store.recordFlight({
        id: "flight-dup-2",
        invocationId: "inv-dup-2",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Agent One replied.",
        startedAt: 174,
        completedAt: 181,
      });

      const activity = queryActivity(20);

      expect(activity.some((item) => item.id === "activity:message:msg-reply")).toBe(false);
      expect(activity.some((item) => item.id === "activity:flight:flight-stale")).toBe(false);
      expect(activity.some((item) => item.id === "activity:message:msg-operator")).toBe(true);
      expect(activity.some((item) => item.id === "activity:flight:flight-1")).toBe(true);
      expect(activity.filter((item) => item.title === "Agent One replied." && item.kind === "flight_updated")).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("desktop db query work items", () => {
  test("projects active work rows from collaboration and execution state", () => {
    const store = createSeededStore();

    try {
      const work = queryWorkItems({ agentId: "agent-1" });

      expect(work).toEqual([
        {
          id: "work-1",
          title: "Observed work",
          summary: null,
          ownerId: "agent-1",
          ownerName: "Agent One",
          nextMoveOwnerId: "agent-1",
          nextMoveOwnerName: "Agent One",
          conversationId: "conv-1",
          state: "working",
          acceptanceState: "none",
          priority: null,
          currentPhase: "Working",
          attention: "silent",
          activeChildWorkCount: 1,
          activeFlightCount: 1,
          lastMeaningfulAt: 110,
          lastMeaningfulSummary: "Claimed for implementation",
        },
        {
          id: "work-1-child",
          title: "Child work",
          summary: null,
          ownerId: "agent-1",
          ownerName: "Agent One",
          nextMoveOwnerId: "agent-1",
          nextMoveOwnerName: "Agent One",
          conversationId: "conv-1",
          state: "open",
          acceptanceState: "none",
          priority: null,
          currentPhase: "Open",
          attention: "silent",
          activeChildWorkCount: 0,
          activeFlightCount: 0,
          lastMeaningfulAt: 95,
          lastMeaningfulSummary: "Child work",
        },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("desktop db query work item by id", () => {
  test("returns detail with ordered timeline, child work, and active flights", () => {
    const store = createSeededStore();

    try {
      store.recordCollaborationEvent({
        id: "event-2",
        recordId: "work-1",
        recordKind: "work_item",
        kind: "progressed",
        actorId: "agent-1",
        summary: "Implemented first pass",
        at: 150,
      });

      const detail = queryWorkItemById("work-1");
      expect(detail).not.toBeNull();
      if (!detail) throw new Error("missing detail");

      expect(detail.id).toBe("work-1");
      expect(detail.title).toBe("Observed work");
      expect(detail.createdAt).toBe(90);
      expect(detail.updatedAt).toBe(90);
      expect(detail.parentId).toBeNull();
      expect(detail.childWork.map((child) => child.id)).toEqual(["work-1-child"]);
      expect(detail.activeFlights.map((flight) => flight.id)).toEqual(["flight-1"]);

      const descendingTimestamps = detail.timeline.map((item) => item.at);
      const sorted = [...descendingTimestamps].sort((a, b) => b - a);
      expect(descendingTimestamps).toEqual(sorted);

      const kinds = detail.timeline.map((item) => `${item.kind}:${item.id}`);
      expect(kinds).toContain("collaboration_event:event:event-1");
      expect(kinds).toContain("collaboration_event:event:event-2");
      expect(kinds).toContain("flight_started:flight:flight-1:started");
      expect(kinds.some((kind) => kind.startsWith("message:"))).toBe(false);
    } finally {
      store.close();
    }
  });

  test("returns null for unknown id", () => {
    const store = createSeededStore();
    try {
      expect(queryWorkItemById("does-not-exist")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("desktop db query fleet", () => {
  test("surfaces activity, work, flights, and attention across observables", () => {
    const store = createSeededStore();

    try {
      store.recordMessage({
        id: "msg-1",
        conversationId: "conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Please finish the work.",
        visibility: "private",
        policy: "durable",
        createdAt: 111,
      });
      store.recordCollaborationEvent({
        id: "event-2",
        recordId: "work-1",
        recordKind: "work_item",
        kind: "progressed",
        actorId: "agent-1",
        summary: "Moved to the next step",
        at: 120,
      });
      store.recordInvocation({
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Keep going",
        collaborationRecordId: "work-1",
        conversationId: "conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 130,
      });
      store.recordFlight({
        id: "flight-2",
        invocationId: "inv-2",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        summary: "Build failed",
        startedAt: 131,
        completedAt: 132,
      });

      store.upsertActor({
        id: "agent-2",
        kind: "agent",
        displayName: "Agent Two",
      });
      store.upsertAgent({
        id: "agent-2",
        kind: "agent",
        definitionId: "agent-2",
        displayName: "Agent Two",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertEndpoint({
        id: "endpoint-2",
        agentId: "agent-2",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "active",
        sessionId: "session-2",
        cwd: join(tmpdir(), "openscout-agent-2", "cwd"),
        projectRoot: join(tmpdir(), "openscout-agent-2"),
      });
      store.upsertConversation({
        id: "conv-2",
        kind: "direct",
        title: "Direct Two",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-2", "operator"],
      });
      store.recordMessage({
        id: "msg-2",
        conversationId: "conv-2",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Please review this branch.",
        visibility: "private",
        policy: "durable",
        createdAt: 140,
      });
      store.recordCollaborationRecord({
        id: "work-2",
        kind: "work_item",
        title: "Review required",
        createdById: "operator",
        ownerId: "agent-2",
        nextMoveOwnerId: "agent-2",
        conversationId: "conv-2",
        state: "review",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: 141,
        updatedAt: 141,
      });
      store.recordCollaborationEvent({
        id: "event-3",
        recordId: "work-2",
        recordKind: "work_item",
        kind: "review_requested",
        actorId: "operator",
        summary: "Needs review",
        at: 142,
      });

      store.upsertActor({
        id: "agent-3",
        kind: "agent",
        displayName: "Agent Three",
      });
      store.upsertAgent({
        id: "agent-3",
        kind: "agent",
        definitionId: "agent-3",
        displayName: "Agent Three",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertEndpoint({
        id: "endpoint-3",
        agentId: "agent-3",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "active",
        sessionId: "session-3",
        cwd: join(tmpdir(), "openscout-agent-3", "cwd"),
        projectRoot: join(tmpdir(), "openscout-agent-3"),
      });
      store.recordInvocation({
        id: "inv-4",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-2",
        action: "consult",
        task: "Synthetic stale failure",
        conversationId: "conv-2",
        ensureAwake: true,
        stream: false,
        createdAt: 143,
      });
      store.recordFlight({
        id: "flight-4",
        invocationId: "inv-4",
        requesterId: "operator",
        targetAgentId: "agent-2",
        state: "failed",
        summary: "Agent Two did not finish cleanly.",
        error: "Stale running flight reconciled: endpoint endpoint-2 started newer work at 1234567890",
        startedAt: 144,
        completedAt: 145,
      });

      const fleet = queryFleet({ limit: 10, activityLimit: 20 });

      expect(fleet.totals).toMatchObject({
        observables: 3,
        interrupt: 1,
        badge: 1,
        silent: 1,
      });
      expect(fleet.observables.map((observable) => [observable.id, observable.attention])).toEqual([
        ["agent-1", "interrupt"],
        ["agent-2", "badge"],
        ["agent-3", "silent"],
      ]);

      const agent1 = fleet.observables.find((observable) => observable.id === "agent-1");
      expect(agent1).not.toBeNull();
      expect(agent1).toMatchObject({
        kind: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        conversationId: "dm.operator.agent-1",
        activeFlightCount: 1,
        activeWorkCount: 2,
        messageCount: 1,
        attention: "interrupt",
      });
      expect(agent1?.activeFlights.map((flight) => flight.id)).toEqual(["flight-1"]);
      expect(agent1?.recentActivity.map((item) => item.kind)).toEqual([
        "flight_updated",
        "invocation_recorded",
        "collaboration_event",
        "ask_opened",
        "collaboration_event",
      ]);
      expect(agent1?.lastActivity?.kind).toBe("flight_updated");

      const agent2 = fleet.observables.find((observable) => observable.id === "agent-2");
      expect(agent2).not.toBeNull();
      expect(agent2).toMatchObject({
        kind: "agent",
        actorId: "agent-2",
        agentId: "agent-2",
        conversationId: "dm.operator.agent-2",
        activeFlightCount: 0,
        activeWorkCount: 1,
        messageCount: 1,
        attention: "badge",
      });
      expect(agent2?.recentActivity.map((item) => item.kind)).toContain("collaboration_event");
      expect(agent2?.recentActivity.map((item) => item.kind)).toContain("ask_opened");

      const agent3 = fleet.observables.find((observable) => observable.id === "agent-3");
      expect(agent3).not.toBeNull();
      expect(agent3).toMatchObject({
        kind: "agent",
        actorId: "agent-3",
        agentId: "agent-3",
        activeFlightCount: 0,
        activeWorkCount: 0,
        messageCount: 0,
        attention: "silent",
      });
      expect(agent3?.recentActivity).toEqual([]);

      expect(fleet.activity.map((item) => item.ts)).toEqual([...fleet.activity.map((item) => item.ts)].sort((a, b) => b - a));
      expect(fleet.activity.map((item) => item.kind)).toEqual(expect.arrayContaining([
        "invocation_recorded",
        "flight_updated",
        "collaboration_event",
        "ask_opened",
      ]));
      expect(fleet.activity.some((item) => item.id === "activity:flight:flight-4")).toBe(false);
    } finally {
      store.close();
    }
  });
});
