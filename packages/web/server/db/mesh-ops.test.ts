/**
 * Mesh Ops query tests — seeds a control-plane SQLite store the way
 * db-queries.test.ts does, then asserts the mesh-ops projection: labels
 * parsing, latest-flight rollup, host attribution via the owner agent,
 * the machineId filter, and the done-recency window.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteControlPlaneStore } from "../../../runtime/src/sqlite-store.ts";
import { closeDb } from "./internal/db.ts";
import {
  MESH_OPS_DONE_RECENCY_MS,
  queryMeshOpsItems,
  queryMeshOpsWorkRecord,
} from "./mesh-ops.ts";

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

const RECENT_DONE_AT = Date.now() - 60 * 60 * 1000;
const STALE_DONE_AT = Date.now() - MESH_OPS_DONE_RECENCY_MS - 60 * 60 * 1000;

function createSeededStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-web-mesh-ops-"));
  tempRoots.add(root);
  process.env.OPENSCOUT_CONTROL_HOME = root;
  const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));

  store.upsertNode({
    id: "node-a",
    meshId: "mesh-1",
    name: "Studio Mac",
    advertiseScope: "local",
    registeredAt: Date.now(),
  });
  store.upsertNode({
    id: "node-b",
    meshId: "mesh-1",
    name: "Cloud Box",
    advertiseScope: "mesh",
    registeredAt: Date.now(),
  });
  store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
  store.upsertActor({ id: "agent-1", kind: "agent", displayName: "Agent One" });
  store.upsertActor({ id: "agent-2", kind: "agent", displayName: "Agent Two" });
  store.upsertAgent({
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: "node-a",
    authorityNodeId: "node-a",
    advertiseScope: "local",
  });
  // authorityNodeId wins over homeNodeId for host attribution.
  store.upsertAgent({
    id: "agent-2",
    kind: "agent",
    definitionId: "agent-2",
    displayName: "Agent Two",
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: "node-a",
    authorityNodeId: "node-b",
    advertiseScope: "mesh",
  });
  store.upsertEndpoint({
    id: "ep-1",
    agentId: "agent-1",
    nodeId: "node-a",
    harness: "claude",
    transport: "tmux",
    state: "online",
    projectRoot: "/work/alpha",
  });
  store.upsertConversation({
    id: "c.conv-1",
    kind: "direct",
    title: "Direct",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-a",
    participantIds: ["agent-1", "operator"],
  });

  // Active work item on node-a with labels and a completed latest flight.
  store.recordCollaborationRecord({
    id: "work-1",
    kind: "work_item",
    title: "Labeled work",
    summary: "Summary one",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    conversationId: "c.conv-1",
    state: "working",
    acceptanceState: "none",
    requestedById: "operator",
    labels: ["mesh", "ops"],
    createdAt: 90,
    updatedAt: 90,
  });
  store.recordInvocation({
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: "node-a",
    targetAgentId: "agent-1",
    action: "consult",
    task: "Do the work",
    collaborationRecordId: "work-1",
    conversationId: "c.conv-1",
    ensureAwake: true,
    stream: false,
    createdAt: 100,
  });
  store.recordFlight({
    id: "flight-1",
    invocationId: "inv-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "completed",
    summary: "Finished the thing",
    startedAt: 101,
    completedAt: 110,
  });

  // Active work item attributed to node-b via authorityNodeId.
  store.recordCollaborationRecord({
    id: "work-2",
    kind: "work_item",
    title: "Remote work",
    createdById: "operator",
    ownerId: "agent-2",
    nextMoveOwnerId: "agent-2",
    conversationId: "c.conv-1",
    state: "waiting",
    acceptanceState: "none",
    requestedById: "operator",
    waitingOn: { kind: "condition", label: "Waiting on CI" },
    createdAt: 95,
    updatedAt: 95,
  });

  // Recently done — inside the recency window.
  store.recordCollaborationRecord({
    id: "work-3",
    kind: "work_item",
    title: "Recently done work",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    conversationId: "c.conv-1",
    state: "done",
    acceptanceState: "accepted",
    requestedById: "operator",
    createdAt: RECENT_DONE_AT - 1000,
    updatedAt: RECENT_DONE_AT,
  });

  // Stale done — outside the recency window.
  store.recordCollaborationRecord({
    id: "work-4",
    kind: "work_item",
    title: "Stale done work",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    conversationId: "c.conv-1",
    state: "done",
    acceptanceState: "accepted",
    requestedById: "operator",
    createdAt: STALE_DONE_AT - 1000,
    updatedAt: STALE_DONE_AT,
  });

  // Operator-owned — no agent row, so host attribution is null.
  store.recordCollaborationRecord({
    id: "work-5",
    kind: "work_item",
    title: "Operator work",
    createdById: "operator",
    ownerId: "operator",
    nextMoveOwnerId: "operator",
    conversationId: "c.conv-1",
    state: "open",
    acceptanceState: "none",
    requestedById: "operator",
    createdAt: 96,
    updatedAt: 96,
  });

  // Failed latest flight — interrupt attention, must sort first.
  store.recordCollaborationRecord({
    id: "work-6",
    kind: "work_item",
    title: "Failed work",
    createdById: "operator",
    ownerId: "agent-2",
    nextMoveOwnerId: "agent-2",
    conversationId: "c.conv-1",
    state: "working",
    acceptanceState: "none",
    requestedById: "operator",
    createdAt: 80,
    updatedAt: 80,
  });
  store.recordInvocation({
    id: "inv-6",
    requesterId: "operator",
    requesterNodeId: "node-b",
    targetAgentId: "agent-2",
    action: "consult",
    task: "Risky work",
    collaborationRecordId: "work-6",
    conversationId: "c.conv-1",
    ensureAwake: true,
    stream: false,
    createdAt: 105,
  });
  store.recordFlight({
    id: "flight-6",
    invocationId: "inv-6",
    requesterId: "operator",
    targetAgentId: "agent-2",
    state: "failed",
    summary: "Blew up",
    startedAt: 106,
    completedAt: 120,
  });

  return store;
}

function corruptLabelsJson(recordId: string): void {
  const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
  try {
    rawDb.query("UPDATE collaboration_records SET labels_json = ?1 WHERE id = ?2")
      .run("{not json", recordId);
  } finally {
    rawDb.close();
  }
}

function itemById(items: ReturnType<typeof queryMeshOpsItems>, id: string) {
  const item = items.find((candidate) => candidate.id === id);
  expect(item, `expected ${id} in mesh-ops items`).toBeDefined();
  return item!;
}

describe("queryMeshOpsItems", () => {
  test("includes active and recently-done items, excludes stale done", () => {
    createSeededStore();
    const items = queryMeshOpsItems();
    const ids = items.map((item) => item.id);
    expect(ids).toContain("work-1");
    expect(ids).toContain("work-2");
    expect(ids).toContain("work-3");
    expect(ids).toContain("work-5");
    expect(ids).toContain("work-6");
    expect(ids).not.toContain("work-4");
  });

  test("parses labels and tolerates invalid labels_json", () => {
    createSeededStore();
    corruptLabelsJson("work-2");
    const items = queryMeshOpsItems();
    expect(itemById(items, "work-1").labels).toEqual(["mesh", "ops"]);
    expect(itemById(items, "work-2").labels).toEqual([]);
    expect(itemById(items, "work-5").labels).toEqual([]);
  });

  test("projects waitingOn from detail_json", () => {
    createSeededStore();
    const items = queryMeshOpsItems();
    expect(itemById(items, "work-2").waitingOn).toEqual({
      kind: "condition",
      label: "Waiting on CI",
    });
    expect(itemById(items, "work-1").waitingOn).toBeNull();
  });

  test("projects the latest flight rollup", () => {
    createSeededStore();
    const items = queryMeshOpsItems();
    const work1 = itemById(items, "work-1");
    expect(work1.latestFlight).toEqual({
      id: "flight-1",
      state: "completed",
      summary: "Finished the thing",
      startedAt: 101,
      completedAt: 110,
    });
    expect(work1.activeFlightCount).toBe(0);
    expect(itemById(items, "work-2").latestFlight).toBeNull();
  });

  test("attributes hosts via the owner agent node and project root", () => {
    createSeededStore();
    const items = queryMeshOpsItems();
    const work1 = itemById(items, "work-1");
    expect(work1.hostNodeId).toBe("node-a");
    expect(work1.hostLabel).toBe("Studio Mac");
    expect(work1.projectRoot).toBe("/work/alpha");
    expect(work1.ownerName).toBe("Agent One");

    const work2 = itemById(items, "work-2");
    expect(work2.hostNodeId).toBe("node-b");
    expect(work2.hostLabel).toBe("Cloud Box");
    expect(work2.projectRoot).toBeNull();

    const work5 = itemById(items, "work-5");
    expect(work5.hostNodeId).toBeNull();
    expect(work5.hostLabel).toBeNull();
  });

  test("filters by machineId using authorityNodeId ?? homeNodeId", () => {
    createSeededStore();
    const nodeBItems = queryMeshOpsItems({ machineId: "node-b" });
    expect(nodeBItems.map((item) => item.id).sort()).toEqual(["work-2", "work-6"]);

    const nodeAItems = queryMeshOpsItems({ machineId: "node-a" });
    const nodeAIds = nodeAItems.map((item) => item.id);
    expect(nodeAIds).toContain("work-1");
    expect(nodeAIds).toContain("work-3");
    expect(nodeAIds).not.toContain("work-2");
    expect(nodeAIds).not.toContain("work-5");
  });

  test("orders by attention: interrupt before badge before silent", () => {
    createSeededStore();
    const items = queryMeshOpsItems();
    const work6 = itemById(items, "work-6");
    const work2 = itemById(items, "work-2");
    const work1 = itemById(items, "work-1");
    expect(work6.attention).toBe("interrupt");
    expect(work2.attention).toBe("badge");
    expect(work1.attention).toBe("silent");
    expect(items[0]?.id).toBe("work-6");
    expect(items.indexOf(work6)).toBeLessThan(items.indexOf(work2));
    expect(items.indexOf(work2)).toBeLessThan(items.indexOf(work1));
  });

  test("computes phase and last-meaningful markers like the work surface", () => {
    createSeededStore();
    const items = queryMeshOpsItems();
    const work1 = itemById(items, "work-1");
    expect(work1.currentPhase).toBe("Working");
    expect(work1.lastMeaningfulAt).toBe(110);
    // Matches projectWorkItemRow: with no active flight the candidate summary
    // falls back to the latest flight's phase label.
    expect(work1.lastMeaningfulSummary).toBe("Completed");
  });
});

describe("queryMeshOpsWorkRecord", () => {
  test("reconstructs the full work-item record for upsert round-trips", () => {
    createSeededStore();
    const record = queryMeshOpsWorkRecord("work-2");
    expect(record).toEqual({
      id: "work-2",
      kind: "work_item",
      title: "Remote work",
      summary: undefined,
      createdById: "operator",
      ownerId: "agent-2",
      nextMoveOwnerId: "agent-2",
      conversationId: "c.conv-1",
      parentId: undefined,
      priority: undefined,
      labels: undefined,
      relations: undefined,
      createdAt: 95,
      updatedAt: 95,
      metadata: undefined,
      state: "waiting",
      acceptanceState: "none",
      requestedById: "operator",
      waitingOn: { kind: "condition", label: "Waiting on CI" },
      progress: undefined,
      startedAt: undefined,
      reviewRequestedAt: undefined,
      completedAt: undefined,
    });
  });

  test("returns null for unknown or non-work-item ids", () => {
    createSeededStore();
    expect(queryMeshOpsWorkRecord("missing")).toBeNull();
  });
});
