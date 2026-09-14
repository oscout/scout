import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActorIdentity,
  AgentDefinition,
  DeliveryIntent,
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

  test("dedupes within a batch and preserves delete-then-reinsert ordering", async () => {
    const { journal } = createJournal(); await journal.load();
    const actor = sampleActor();
    const changed = { ...actor, displayName: "Changed" };
    const endpoint = {id: "ep", agentId: actor.id, nodeId: "node-1", harness: "codex" as const, transport: "local_socket" as const, state: "idle" as const};
    await journal.appendEntries({kind: "agent.endpoint.upsert", endpoint});
    const retained = await journal.appendEntries([
      {kind: "actor.upsert", actor}, {kind: "actor.upsert", actor},
      {kind: "actor.upsert", actor: changed}, {kind: "actor.upsert", actor: changed},
      {kind: "agent.endpoint.delete", endpointId: endpoint.id},
      {kind: "agent.endpoint.upsert", endpoint},
    ]);
    expect(retained).toHaveLength(4);
    expect(journal.snapshot().actors[actor.id]).toEqual(changed);
    expect(journal.snapshot().endpoints[endpoint.id]).toEqual(endpoint);
  });

  test("failed durable append does not publish copy-on-write batch state", async () => {
    const { journal, journalPath } = createJournal(); await journal.load();
    mkdirSync(journalPath);
    await expect(journal.appendEntries({kind: "agent.upsert", agent: sampleAgent()})).rejects.toThrow();
    expect(journal.snapshot().agents).toEqual({});
    expect(journal.snapshot().actors).toEqual({});
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


describe("bounded delivery listing", () => {
  test("matches filtered insertion-order slice including unusual limits and replacements", async () => {
    const { journal } = createJournal();
    await journal.load();
    const deliveries = Array.from({ length: 6001 }, (_, i) => ({
      id: `delivery-${i}`, targetId: "agent-1", targetKind: "agent" as const,
      transport: i % 2 ? "local_socket" as const : "peer_broker" as const,
      reason: "direct_message" as const, policy: "best_effort" as const,
      status: i % 3 ? "pending" as const : "acknowledged" as const,
    }));
    await journal.appendEntries({ kind: "deliveries.record", deliveries });
    const replacement = { ...deliveries[2]!, status: "pending" as const };
    deliveries[2] = replacement;
    await journal.appendEntries({ kind: "deliveries.record", deliveries: [replacement] });
    expect(journal.getDelivery("delivery-6000")).toEqual(deliveries[6000]);
    expect(journal.getDelivery("missing")).toBeUndefined();
    expect(journal.getDelivery("delivery-2")).toEqual(replacement);
    expect(journal.findDelivery(d => d.id === "delivery-6000")).toEqual(deliveries[6000]);
    expect(journal.findDelivery(() => false)).toBeUndefined();
    for (const limit of [undefined, 0, 1, 20, 5000, 7000, 1.9, -1, -3.7, NaN, Infinity, -Infinity]) {
      for (const transport of [undefined, "local_socket" as const]) {
        for (const status of [undefined, "pending" as const]) {
          const expected = deliveries.filter(d => !transport || d.transport === transport)
            .filter(d => !status || d.status === status).slice(0, limit ?? 200);
          expect(journal.listDeliveries({ limit, transport, status })).toEqual(expected);
        }
      }
    }
  });
});

test("complete delivery traversal yields and excludes later appends without freezing replacements", async () => {
  const { journal } = createJournal();
  await journal.load();
  const deliveries = Array.from({ length: 1500 }, (_, index) => ({
    id: `visit-${index}`, targetId: "agent", targetKind: "agent" as const,
    transport: "local_socket" as const, policy: "best_effort" as const,
    reason: "direct_message" as const, status: "pending" as const,
  }));
  await journal.appendEntries({ kind: "deliveries.record", deliveries });
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const seen: string[] = [];
  await journal.visitDeliveries(async (delivery) => {
    seen.push(delivery.id);
    if (seen.length === 1) {
      await journal.appendEntries({ kind: "deliveries.record", deliveries: [{ ...deliveries[0]!, id: "later" }] });
      await journal.appendEntries({ kind: "delivery.status.update", deliveryId: "visit-1400", status: "acknowledged" });
    }
    if (seen.length === 130) expect(yielded).toBe(true);
    if (delivery.id === "visit-1400") expect(delivery.status).toBe("acknowledged");
  });
  expect(seen).toEqual(deliveries.map((delivery) => delivery.id));
  expect(journal.getDelivery("later")).toBeDefined();
});


test("canonical delivery reads reconstruct status/leases/large metadata and preserve captured boundaries", async () => {
  const { journal, journalPath } = createJournal();
  await journal.load();
  const original: DeliveryIntent = {
    id: "canonical-delivery", targetId: "agent", targetKind: "agent", transport: "local_socket",
    reason: "direct_message", policy: "durable", status: "pending", messageId: "message",
    invocationId: "invocation", bindingId: "binding", targetNodeId: "node",
    metadata: { rich: "雪🦉\ud800".repeat(20000), nested: { array: [null, true, 3] } },
  };
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [original] });
  const capture = journal.captureReplayBoundary.bind(journal);
  let markCaptured!: () => void;
  let resume!: () => void;
  const captured = new Promise<void>((resolve) => { markCaptured = resolve; });
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  journal.captureReplayBoundary = async (...args) => {
    const boundary = await capture(...args); markCaptured(); await paused; return boundary;
  };
  const priorRead = journal.readCanonicalDelivery(original.id);
  await captured;
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: original.id,
    status: "leased", leaseOwner: "worker", leaseExpiresAt: 5000, metadata: { phase: "leased" } });
  resume();
  const prior = await priorRead;
  expect(prior.kind).toBe("found");
  if (prior.kind === "found") expect(prior.value).toEqual(original);
  journal.captureReplayBoundary = capture;
  const leased = await journal.readCanonicalDelivery(original.id);
  expect(leased.kind).toBe("found");
  if (leased.kind === "found") expect(leased.value).toEqual({ ...original, status: "leased",
    leaseOwner: "worker", leaseExpiresAt: 5000, metadata: { ...original.metadata, phase: "leased" } });
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: original.id, status: "completed",
    leaseOwner: null, leaseExpiresAt: null, metadata: { phase: "completed" } });
  const final = await journal.readCanonicalDelivery(original.id);
  expect(final.kind).toBe("found");
  if (final.kind === "found") {
    expect(final.value.leaseOwner).toBeUndefined();
    expect(final.value.leaseExpiresAt).toBeUndefined();
    expect(final.value.metadata).toEqual({ ...original.metadata, phase: "completed" });
  }
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: "unknown", status: "acknowledged" });
  expect((await journal.readCanonicalDelivery("unknown")).kind).toBe("not_found");
  rmSync(journalPath);
  expect((await journal.readCanonicalDelivery(original.id)).kind).toBe("unavailable");
  expect((await journal.readCanonicalDelivery("absent")).kind).toBe("unavailable");
});

test("canonical delivery coverage rejects malformed records and survives journal compaction/restart", async () => {
  const { journal, journalPath } = createJournal({ compactionPolicy: { minimumReclaimBytes: 1 } });
  await journal.load();
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [{ id: "d", targetId: "a", targetKind: "agent",
    transport: "local_socket", reason: "mention", policy: "durable", status: "pending", metadata: { a: 1 } }] });
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: "d", status: "acknowledged", metadata: { b: 2 } });
  await journal.appendEntries({ kind: "actor.upsert", actor: { id: "a", kind: "agent", displayName: "before" } });
  await journal.appendEntries({ kind: "actor.upsert", actor: { id: "a", kind: "agent", displayName: "after" } });
  const expected = await journal.readCanonicalDelivery("d");
  const restarted = new FileBackedBrokerJournal(journalPath, { compactionPolicy: { minimumReclaimBytes: 1 } });
  expect((await restarted.load()).compactionRequired).toBe(true);
  const actual = await restarted.readCanonicalDelivery("d");
  expect(actual.kind).toBe("found");
  if (expected.kind === "found" && actual.kind === "found") expect(actual.value).toEqual(expected.value);
  const valid = readFileSync(journalPath, "utf8");
  for (const suffix of ["bad-json", JSON.stringify({ kind: "delivery.status.update", deliveryId: "d", status: "delivered" }),
    JSON.stringify({ kind: "deliveries.record", deliveries: [{ id: "bad", status: "pending" }] })]) {
    writeFileSync(journalPath, valid + suffix + "\n");
    expect((await restarted.readCanonicalDelivery("d")).kind).toBe("unavailable");
    expect((await restarted.readCanonicalDelivery("absent")).kind).toBe("unavailable");
  }
});


test("active delivery traversal excludes later appends after filtering terminal records", async () => {
  const { journal } = createJournal();
  await journal.load();
  const delivery: DeliveryIntent = { id: "active-first", targetId: "agent", targetKind: "agent",
    transport: "local_socket", policy: "best_effort", reason: "direct_message", status: "pending" };
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [
    delivery, { ...delivery, id: "terminal", status: "completed" }, { ...delivery, id: "active-last" },
  ] });
  const seen: string[] = [];
  await journal.visitDeliveries(async (current) => {
    seen.push(current.id);
    if (current.id === "active-first") {
      await journal.appendEntries({ kind: "deliveries.record", deliveries: [{ ...delivery, id: "later" }] });
    }
  }, { activeOnly: true });
  expect(seen).toEqual(["active-first", "active-last"]);
  expect(journal.getDelivery("later")).toBeDefined();
});

describe("progressive startup", () => {
  test("defers compaction, preserves writes during prefix rewrite and is restart exact", async () => {
    const { journal, journalPath } = createJournal({ progressiveStartup: true,
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
    const actor = sampleActor();
    writeFileSync(journalPath, Array.from({ length: 2000 }, (_, i) => JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: `old-${i}` } }) + "\n").join(""));
    const report = await journal.load();
    expect(report.compactionRequired).toBe(true);
    expect(report.compactionMs).toBe(0);
    expect(journal.snapshot().actors[actor.id]?.displayName).toBe("old-1999");
    const hydration = journal.finishStartup();
    for (let i = 0; i < 20; i++) await journal.appendEntries([{ kind: "actor.upsert", actor: { ...actor, displayName: `accepted-${i}` } }]);
    await hydration;
    expect(journal.startupStatus().phase).toBe("complete");
    const restarted = new FileBackedBrokerJournal(journalPath);
    await restarted.load();
    expect(restarted.snapshot().actors[actor.id]?.displayName).toBe("accepted-19");
    await journal.close(); await restarted.close();
  });

  test("startup hydration rejects before load instead of caching a false completion", async () => {
    const { journal } = createJournal({ progressiveStartup: true });
    await expect(journal.finishStartup()).rejects.toThrow("must be loaded");
    await journal.load(); await journal.finishStartup();
    expect(journal.startupStatus().phase).toBe("complete");
    await journal.close();
  });
});

test("failed background compaction leaves the canonical prefix and accepted suffix recoverable", async () => {
  const { journal, journalPath } = createJournal({ progressiveStartup: true,
    compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
  const actor = sampleActor();
  writeFileSync(journalPath, Array.from({ length: 128 }, (_, i) => JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: `old-${i}` } }) + "\n").join(""));
  await journal.load();
  // Inject a failed streaming reader after output has begun, while accepting a
  // concurrent command. The original file must remain the recovery authority.
  const internal = journal as unknown as { visitEntries: (...args: any[]) => Promise<any> };
  const visit = internal.visitEntries.bind(journal);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  internal.visitEntries = (visitor, options) => visit(async (entry: unknown, index: number, bytes: number) => {
    if (index === 0) { entered(); await resume; }
    await visitor(entry, index, bytes);
    if (index === 32) throw Error("injected compaction read failure");
  }, options);
  const hydration = journal.finishStartup();
  const rejected = hydration.catch(error => error);
  await started;
  await journal.appendEntries([{ kind: "actor.upsert", actor: { ...actor, displayName: "accepted-during-failure" } }]);
  release();
  expect(await rejected).toBeInstanceOf(Error);
  expect(journal.startupStatus().phase).toBe("failed");
  const recovered = new FileBackedBrokerJournal(journalPath);
  await recovered.load();
  expect(recovered.snapshot().actors[actor.id]?.displayName).toBe("accepted-during-failure");
  await journal.close(); await recovered.close();
});
