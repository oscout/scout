import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActorIdentity,
  AgentDefinition,
  DurableAction,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import {
  FileBackedBrokerJournal,
  type FileBackedBrokerJournalOptions,
  type BrokerJournalReplayBarrier,
} from "./broker-journal.ts";

const journalRoots = new Set<string>();

afterEach(() => {
  for (const root of journalRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  journalRoots.clear();
});

function createJournal(
  options: FileBackedBrokerJournalOptions = {},
): { journal: FileBackedBrokerJournal; journalPath: string } {
  const root = mkdtempSync(join(tmpdir(), "openscout-broker-journal-"));
  journalRoots.add(root);
  const journalPath = join(root, "broker-journal.jsonl");
  return {
    journal: new FileBackedBrokerJournal(journalPath, options),
    journalPath,
  };
}

function sampleActor(): ActorIdentity {
  return {
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["builder"],
    metadata: {
      workspace: "/tmp/agent-one",
    },
  };
}

function sampleAgent(): AgentDefinition {
  return {
    ...sampleActor(),
    kind: "agent",
    definitionId: "agent-1",
    agentClass: "builder",
    capabilities: ["chat", "execute"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
  };
}

function sampleMessage(): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    visibility: "private",
    policy: "durable",
    createdAt: 1_700_000_000_000,
  };
}

function sampleInvocation(): InvocationRequest {
  return {
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "execute",
    task: "Run the issue runner.",
    ensureAwake: true,
    stream: true,
    createdAt: 1_700_000_000_001,
  };
}

function sampleFlight(): FlightRecord {
  return {
    id: "flt-1",
    invocationId: "inv-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    summary: "Running issue work.",
    startedAt: 1_700_000_000_002,
  };
}

function sampleDurableAction(input: Partial<DurableAction> = {}): DurableAction {
  return {
    id: "action-1",
    kind: "message_delivery",
    subjectId: "delivery-1",
    authorityCellId: "node-1",
    state: "pending",
    idempotencyKey: "delivery-1:create",
    leaseGeneration: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...input,
  };
}

function sampleReplayBarrier(id: string): BrokerJournalReplayBarrier {
  return {
    id,
    projectionId: "control-plane",
    projectionVersion: 1,
    createdAt: 1_700_000_000_000,
  };
}

describe("FileBackedBrokerJournal", () => {
  test("reports startup scan and compaction diagnostics without record payloads", async () => {
    const { journal, journalPath } = createJournal();
    const actor = sampleActor();
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor }),
        "",
        "{not-json",
        JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: "Updated" } }),
        JSON.stringify({ kind: "message.record", message: sampleMessage() }),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = await journal.load();

    expect(report.validEntries).toBe(3);
    expect(report.invalidLines).toBe(1);
    expect(report.blankLines).toBe(1);
    expect(report.compactionRequired).toBe(true);
    expect(report.estimatedReclaimBytes).toBeGreaterThan(0);
    expect(report.estimatedReclaimRatio).toBeGreaterThan(0);
    expect(report.compactionReason).not.toBeNull();
    expect(report.countsByKind).toEqual({
      "actor.upsert": 2,
      "message.record": 1,
    });
    expect(report.sourceBytes).toBeGreaterThan(report.compactedBytes);
    expect(report.totalMs).toBeGreaterThanOrEqual(report.scanMs + report.compactionMs);
    expect(JSON.stringify(report)).not.toContain("hello");
    expect(journal.loadReport()).toEqual(report);
  });

  test("does not rewrite the whole journal for a trivial duplicate", async () => {
    const { journal, journalPath } = createJournal();
    const actor = sampleActor();
    const supersededLine = JSON.stringify({ kind: "actor.upsert", actor });
    const originalContents = [
      supersededLine,
      JSON.stringify({
        kind: "message.record",
        message: { ...sampleMessage(), body: "x".repeat(32_000) },
      }),
      JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: "Updated" } }),
    ].join("\n") + "\n";
    writeFileSync(journalPath, originalContents, "utf8");

    const report = await journal.load();

    expect(report.compactionRequired).toBe(false);
    expect(report.compactionReason).toBeNull();
    expect(report.estimatedReclaimBytes).toBe(Buffer.byteLength(supersededLine, "utf8") + 1);
    expect(report.estimatedReclaimRatio).toBeLessThan(0.05);
    expect(report.compactionMs).toBe(0);
    expect(report.compactedBytes).toBe(report.sourceBytes);
    expect(readFileSync(journalPath, "utf8")).toBe(originalContents);
    expect(journal.snapshot().actors["agent-1"]?.displayName).toBe("Updated");
  });

  test("uses the high-water policy when a large journal has bounded reclaim", async () => {
    const { journal, journalPath } = createJournal({
      compactionPolicy: {
        minimumReclaimBytes: 100_000,
        minimumReclaimRatio: 0.99,
        highWaterBytes: 1_000,
        highWaterMinimumReclaimBytes: 100,
      },
    });
    const actor = sampleActor();
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor }),
        JSON.stringify({
          kind: "message.record",
          message: { ...sampleMessage(), body: "x".repeat(2_000) },
        }),
        JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: "Updated" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = await journal.load();

    expect(report.compactionRequired).toBe(true);
    expect(report.compactionReason).toBe("high_water");
    expect((await journal.readEntries()).filter((entry) => entry.kind === "actor.upsert"))
      .toHaveLength(1);
  });

  test("skips redundant entity upserts on append", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();

    const first = await journal.appendEntries([
      { kind: "actor.upsert", actor: sampleActor() },
      { kind: "agent.upsert", agent: sampleAgent() },
    ]);
    const second = await journal.appendEntries([
      { kind: "actor.upsert", actor: sampleActor() },
      { kind: "agent.upsert", agent: sampleAgent() },
    ]);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);

    const lines = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });

    expect(lines.filter((entry) => entry.kind === "actor.upsert")).toHaveLength(1);
    expect(lines.filter((entry) => entry.kind === "agent.upsert")).toHaveLength(1);
  });

  test("replays a stable byte boundary while later appends remain queued for projection", async () => {
    const { journal } = createJournal();
    await journal.load();
    await journal.appendEntries({ kind: "actor.upsert", actor: sampleActor() });

    const boundary = await journal.captureReplayBoundary();
    await journal.appendEntries({ kind: "message.record", message: sampleMessage() });

    const boundedKinds: string[] = [];
    await journal.replay((entry) => {
      boundedKinds.push(entry.kind);
    }, boundary);
    const allKinds = (await journal.readEntries()).map((entry) => entry.kind);

    expect(boundedKinds).toEqual(["actor.upsert"]);
    expect(allKinds).toEqual(["actor.upsert", "message.record"]);
  });

  test("captures an opaque barrier atomically and resumes after it without exposing barriers", async () => {
    const { journal } = createJournal();
    await journal.load();
    await journal.appendEntries({ kind: "actor.upsert", actor: sampleActor() });

    const firstBarrier = sampleReplayBarrier("barrier-1");
    const firstBoundary = await journal.captureReplayBoundary({ barrier: firstBarrier });
    await journal.appendEntries({ kind: "message.record", message: sampleMessage() });
    const secondBoundary = await journal.captureReplayBoundary({
      barrier: sampleReplayBarrier("barrier-2"),
    });

    const replayedKinds: string[] = [];
    const report = await journal.replay((entry) => {
      replayedKinds.push(entry.kind);
    }, secondBoundary, { afterBarrier: firstBarrier });

    expect(firstBoundary.barrier).toEqual(firstBarrier);
    expect(report).toEqual({ afterBarrierFound: true, visitedEntries: 1 });
    expect(replayedKinds).toEqual(["message.record"]);
    expect((await journal.readEntries()).map((entry) => entry.kind)).toEqual([
      "actor.upsert",
      "journal.replay_barrier",
      "message.record",
      "journal.replay_barrier",
    ]);
    expect(journal.snapshot().messages["msg-1"]).toEqual(sampleMessage());
  });

  test("fails closed when a requested replay barrier is absent", async () => {
    const { journal } = createJournal();
    await journal.load();
    await journal.appendEntries({ kind: "message.record", message: sampleMessage() });

    const replayedKinds: string[] = [];
    const report = await journal.replay((entry) => {
      replayedKinds.push(entry.kind);
    }, undefined, { afterBarrier: sampleReplayBarrier("missing") });

    expect(report).toEqual({ afterBarrierFound: false, visitedEntries: 0 });
    expect(replayedKinds).toEqual([]);
  });

  test("does not resume from a same-id marker owned by another projection", async () => {
    const { journal } = createJournal();
    await journal.load();
    const barrier = sampleReplayBarrier("shared-id");
    const boundary = await journal.captureReplayBoundary({ barrier });

    const report = await journal.replay(() => {
      throw new Error("foreign barrier must not release replay");
    }, boundary, {
      afterBarrier: { ...barrier, projectionId: "foreign-projection" },
    });

    expect(report).toEqual({ afterBarrierFound: false, visitedEntries: 0 });
  });

  test("skips identical flight records while preserving state transitions", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();
    const running = sampleFlight();
    const completed = {
      ...running,
      state: "completed" as const,
      summary: "Issue work complete.",
      completedAt: running.startedAt + 1_000,
    };

    expect(await journal.appendEntries({ kind: "flight.record", flight: running })).toHaveLength(1);
    expect(await journal.appendEntries({ kind: "flight.record", flight: structuredClone(running) })).toHaveLength(0);
    expect(await journal.appendEntries({ kind: "flight.record", flight: completed })).toHaveLength(1);
    expect(await journal.appendEntries({ kind: "flight.record", flight: structuredClone(completed) })).toHaveLength(0);

    const flightEntries = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; flight?: FlightRecord })
      .filter((entry) => entry.kind === "flight.record");
    expect(flightEntries.map((entry) => entry.flight?.state)).toEqual(["running", "completed"]);
  });

  test("compacts superseded upserts on load while preserving non-upsert entries", async () => {
    const { journal, journalPath } = createJournal();
    const actor = sampleActor();
    const updatedActor = {
      ...actor,
      displayName: "Agent One Updated",
    };

    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor }),
        JSON.stringify({
          kind: "journal.replay_barrier",
          barrier: sampleReplayBarrier("retained-barrier"),
        }),
        JSON.stringify({ kind: "message.record", message: sampleMessage() }),
        JSON.stringify({ kind: "actor.upsert", actor: updatedActor }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const compactedEntries = await journal.readEntries();
    expect(compactedEntries).toHaveLength(3);
    expect(compactedEntries.filter((entry) => entry.kind === "actor.upsert")).toHaveLength(1);
    expect(compactedEntries.filter((entry) => entry.kind === "message.record")).toHaveLength(1);
    expect(compactedEntries.map((entry) => entry.kind)).toEqual([
      "journal.replay_barrier",
      "message.record",
      "actor.upsert",
    ]);
    expect(journal.snapshot().actors["agent-1"]?.displayName).toBe("Agent One Updated");
  });

  test("compacts identical flight records on load while preserving transitions", async () => {
    const { journal, journalPath } = createJournal();
    const running = sampleFlight();
    const completed = {
      ...running,
      state: "completed" as const,
      summary: "Issue work complete.",
      completedAt: running.startedAt + 1_000,
    };

    writeFileSync(
      journalPath,
      [
        running,
        structuredClone(running),
        completed,
        structuredClone(completed),
      ].map((flight) => JSON.stringify({ kind: "flight.record", flight })).join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const compactedEntries = await journal.readEntries();
    expect(compactedEntries).toHaveLength(2);
    expect(compactedEntries.map((entry) => (
      entry.kind === "flight.record" ? entry.flight.state : entry.kind
    ))).toEqual(["running", "completed"]);
    expect(journal.snapshot().flights["flt-1"]?.state).toBe("completed");
  });

  test("replays invocation records into snapshots", async () => {
    const { journal, journalPath } = createJournal();

    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "invocation.record", invocation: sampleInvocation() }),
        JSON.stringify({ kind: "flight.record", flight: sampleFlight() }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const snapshot = journal.snapshot();
    expect(snapshot.invocations["inv-1"]).toEqual(expect.objectContaining({
      targetAgentId: "agent-1",
    }));
    expect(snapshot.flights["flt-1"]).toEqual(expect.objectContaining({
      invocationId: "inv-1",
    }));
  });

  test("looks up durable actions by idempotency key after replay", async () => {
    const { journal, journalPath } = createJournal();

    writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "durable.action.record",
        action: sampleDurableAction(),
      }) + "\n",
      "utf8",
    );

    await journal.load();

    expect(journal.getDurableActionByIdempotencyKey({
      authorityCellId: "node-1",
      kind: "message_delivery",
      idempotencyKey: "delivery-1:create",
    })?.id).toBe("action-1");
    expect(journal.getDurableActionByIdempotencyKey({
      authorityCellId: "node-other",
      kind: "message_delivery",
      idempotencyKey: "delivery-1:create",
    })).toBeNull();
  });
});
