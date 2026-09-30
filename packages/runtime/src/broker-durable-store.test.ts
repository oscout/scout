import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  NodeDefinition,
  ThreadEventEnvelope,
} from "@openscout/protocol";

import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore, normalizeBrokerJournalEntries, type BrokerPersistenceVerification } from "./broker-durable-store.js";
import { RecoverableSQLiteProjection } from "./sqlite-projection.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";
import {
  emptyHistoryRotationPlan,
  planHistoryRotation,
  refineVerifiedRotation,
  type HistoryRotationPlan,
} from "./history-rotation.js";

function nodeEntry(id: string): BrokerJournalEntry {
  const node: NodeDefinition = {
    id,
    name: id,
    kind: "local",
    lastSeenAt: 1,
    capabilities: [],
    metadata: {},
  };
  return { kind: "node.upsert", node };
}

function threadEvent(id: string): ThreadEventEnvelope {
  return {
    id,
    conversationId: "conv-1",
    authorityNodeId: "node-1",
    seq: 1,
    kind: "message.created",
    ts: 1,
    payload: {
      message: {
        id: "msg-1",
        conversationId: "conv-1",
        actorId: "actor-1",
        originNodeId: "node-1",
        class: "agent",
        body: "hello",
        visibility: "workspace",
        policy: "durable",
        createdAt: 1,
      },
    },
  };
}

describe("BrokerDurableStore", () => {
  test("normalizes single and batch journal entries", () => {
    const first = nodeEntry("node-1");
    const second = nodeEntry("node-2");

    expect(normalizeBrokerJournalEntries(first)).toEqual([first]);
    expect(normalizeBrokerJournalEntries([first, second])).toEqual([first, second]);
  });

  test("serializes durable writes and continues after a rejected write", async () => {
    const store = new BrokerDurableStore({
      journal: {
        async appendEntries(entries) {
          return entries;
        },
      },
      projection: {
        async applyEntries() {
          return [];
        },
      },
      threadEvents: {
        publish() {},
      },
    });
    const order: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = store.runWrite(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
      throw new Error("expected failure");
    });
    const second = store.runWrite(async () => {
      order.push("second");
      return "second-result";
    });

    await Bun.sleep(0);
    expect(order).toEqual(["first:start"]);
    releaseFirst();

    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe("second-result");
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("acknowledges journal and runtime before background projection effects", async () => {
    const entry = nodeEntry("node-1");
    const publishedEvent = threadEvent("thread-event-1");
    const order: string[] = [];
    const projectionGate = Promise.withResolvers<void>();
    const store = new BrokerDurableStore({
      journal: {
        async appendEntries(entries) {
          order.push(`journal:${entries[0]?.kind}`);
          return entries;
        },
      },
      projection: {
        async applyEntries(entries) {
          order.push(`projection:${entries[0]?.kind}`);
          await projectionGate.promise;
          return [publishedEvent];
        },
      },
      threadEvents: {
        publish(events) {
          order.push(`publish:${events[0]?.id}`);
        },
      },
    });

    const committed = await store.commitEntries(entry, async (entries) => {
      order.push(`runtime:${entries[0]?.kind}`);
    });

    expect(committed).toEqual([entry]);
    expect(order).toEqual([
      "journal:node.upsert",
      "runtime:node.upsert",
      "projection:node.upsert",
    ]);

    projectionGate.resolve();
    await store.flushProjectedEntries();
    expect(order).toEqual([
      "journal:node.upsert",
      "runtime:node.upsert",
      "projection:node.upsert",
      "publish:thread-event-1",
    ]);
  });

  test("can defer projection while still applying journal and runtime effects", async () => {
    const entry = nodeEntry("node-1");
    const order: string[] = [];
    const store = new BrokerDurableStore({
      journal: {
        async appendEntries(entries) {
          order.push("journal");
          return entries;
        },
      },
      projection: {
        async applyEntries() {
          order.push("projection");
          return [];
        },
      },
      threadEvents: {
        publish() {
          order.push("publish");
        },
      },
    });

    await store.commitEntries(entry, async () => {
      order.push("runtime");
    }, { enqueueProjection: false });

    expect(order).toEqual(["journal", "runtime"]);
  });

  test("abandons a never-resolving derived projection without blocking shutdown", async () => {
    const entry = nodeEntry("node-1");
    let projectionCalls = 0;
    let published = false;
    const store = new BrokerDurableStore({
      journal: {
        async appendEntries(entries) {
          return entries;
        },
      },
      projection: {
        async applyEntries() {
          projectionCalls++;
          return await new Promise<ThreadEventEnvelope[]>(() => {});
        },
      },
      threadEvents: {
        publish() {
          published = true;
        },
      },
    });

    await store.applyProjectedEntries(entry);
    await Bun.sleep(0);
    expect(projectionCalls).toBe(1);

    store.abandonProjectedEntries();
    await expect(Promise.race([
      store.flushProjectedEntries().then(() => "flushed"),
      Bun.sleep(50).then(() => "timed-out"),
    ])).resolves.toBe("flushed");

    await store.applyProjectedEntries(nodeEntry("node-2"));
    await Bun.sleep(0);
    expect(projectionCalls).toBe(1);
    expect(published).toBe(false);
  });
});

test("startup deferral retains journal facts without queuing projection payloads", async () => {
  let defer = true; const accepted: BrokerJournalEntry[] = [], projected: BrokerJournalEntry[] = [];
  let release!: () => void;
  const eventDrain = new Promise<void>(r => { release = r; });
  const durable = new BrokerDurableStore({
    journal: { async appendEntries(entries) { accepted.push(...entries); return entries; } },
    projection: { async applyEntries(entries) { projected.push(...entries); return []; } },
    threadEvents: { publish() {} }, deferProjection: () => defer, afterRuntime: () => eventDrain,
  });
  let acknowledged = false;
  const write = durable.runWrite(async () => { await durable.commitEntries(nodeEntry("core"), async () => {}); acknowledged = true; });
  await new Promise(r => setImmediate(r));
  expect(acknowledged).toBe(false); release(); await write;
  await durable.flushProjectedEntries(); expect(projected).toHaveLength(0); expect(accepted).toHaveLength(1);
  defer = false;
  await durable.runWrite(() => durable.commitEntries(nodeEntry("live"), async () => {}));
  await durable.flushProjectedEntries(); expect(projected).toEqual([nodeEntry("live")]);
});

const boundaryRoots = new Set<string>();
afterEach(() => {
  for (const root of boundaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  boundaryRoots.clear();
});

describe("awaitProjectionBoundary", () => {
  const messageEntry = (): BrokerJournalEntry => ({
    kind: "message.record",
    message: {
      id: "m",
      conversationId: "c",
      actorId: "op",
      originNodeId: "n",
      class: "agent",
      body: "needed",
      visibility: "private",
      policy: "durable",
      createdAt: 1_699_000_000_000,
    },
  });

  function stubProjection(overrides: {
    applyEntries?: (entries: BrokerJournalEntry[]) => Promise<ThreadEventEnvelope[]>;
    health?: () => { failures: number; unavailable: string | null };
    flush?: () => Promise<void>;
    verifyPersisted?: (plan: HistoryRotationPlan) => Promise<BrokerPersistenceVerification>;
  } = {}) {
    return {
      applyEntries: overrides.applyEntries ?? (async () => []),
      ...(overrides.health ? { health: overrides.health } : {}),
      ...(overrides.flush ? { flush: overrides.flush } : {}),
      ...(overrides.verifyPersisted ? { verifyPersisted: overrides.verifyPersisted } : {}),
    };
  }

  test("resolves ok when the queue drains with no failure evidence", async () => {
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection(),
      threadEvents: { publish() {} },
    });
    await store.commitEntries(nodeEntry("n1"), async () => {});
    await expect(store.awaitProjectionBoundary()).resolves.toEqual({ ok: true });
  });

  test("refuses while the projection is disabled or otherwise unavailable", async () => {
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection({ health: () => ({ failures: 0, unavailable: "sqlite projection disabled" }) }),
      threadEvents: { publish() {} },
    });
    const boundary = await store.awaitProjectionBoundary();
    expect(boundary).toEqual({ ok: false, reason: "sqlite projection disabled" });
  });

  test("refuses while deferProjection is true", async () => {
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection(),
      threadEvents: { publish() {} },
      deferProjection: () => true,
    });
    await expect(store.awaitProjectionBoundary()).resolves.toEqual({ ok: false, reason: "projection deferred" });
  });

  test("refuses after projection writes are abandoned", async () => {
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection(),
      threadEvents: { publish() {} },
    });
    store.abandonProjectedEntries();
    await expect(store.awaitProjectionBoundary()).resolves.toEqual({ ok: false, reason: "projection writes abandoned" });
  });

  test("a failed projection makes the boundary refuse even though flush resolved", async () => {
    // Port of the F1 repro: applyEntries throws, the write queue swallows it,
    // flushProjectedEntries still resolves — only the boundary sees it.
    let failed = 0;
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection({
        async applyEntries(entries) {
          if (entries.some((entry) => entry.kind === "message.record")) {
            failed += 1;
            throw new Error("injected SQLITE_FULL");
          }
          return [];
        },
      }),
      threadEvents: { publish() {} },
    });
    await store.commitEntries(messageEntry(), async () => {});
    await store.flushProjectedEntries();
    expect(failed).toBe(1);

    const boundary = await store.awaitProjectionBoundary();
    expect(boundary.ok).toBe(false);
    if (!boundary.ok) {
      expect(boundary.reason).toContain("failed or were skipped");
    }
  });

  test("projection-reported failures (skipped entries) fail the boundary closed", async () => {
    let failures = 0;
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection({ health: () => ({ failures, unavailable: null }) }),
      threadEvents: { publish() {} },
    });
    await expect(store.awaitProjectionBoundary()).resolves.toEqual({ ok: true });
    // A later skip/failure is new evidence since the last successful boundary.
    failures = 2;
    const boundary = await store.awaitProjectionBoundary();
    expect(boundary.ok).toBe(false);
  });

  test("a failed projection refuses history rotation and the journal keeps the message line after compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-boundary-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    const cutoff = 1_700_000_000_000;

    const store = new BrokerDurableStore({
      journal,
      projection: stubProjection({
        async applyEntries(entries) {
          if (entries.some((entry) => entry.kind === "message.record")) {
            throw new Error("injected SQLITE_FULL");
          }
          return [];
        },
      }),
      threadEvents: { publish() {} },
    });

    await store.runWrite(() => store.commitEntries(messageEntry(), async () => {}));

    // The daemon's gated sequence: boundary inside runWrite, rotate only if ok.
    let journaled = false;
    await store.runWrite(async () => {
      const boundary = await store.awaitProjectionBoundary();
      expect(boundary.ok).toBe(false);
      if (boundary.ok) {
        await store.commitEntries({ kind: "history.rotate", cutoff, rotatedAt: cutoff }, async () => {});
        journaled = true;
      }
    });
    expect(journaled).toBe(false);

    // Compact and reload: with no rotate marker the message line survives.
    const reloaded = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: {
        minimumReclaimBytes: 1,
        minimumReclaimRatio: 0,
        highWaterBytes: Number.MAX_SAFE_INTEGER,
        highWaterMinimumReclaimBytes: Number.MAX_SAFE_INTEGER,
      },
    });
    await reloaded.load();
    expect((await reloaded.readEntries()).map((entry) => entry.kind)).toContain("message.record");
  });

  test("the boundary inside runWrite drains a queued write's projection before rotation is journaled", async () => {
    // Port of the F1 ordering repro: an occupied writer plus a queued message
    // write — the queued write's projection must complete before the rotate.
    const order: string[] = [];
    let releaseWriter!: () => void;
    let releaseProject!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const projectGate = new Promise<void>((resolve) => { releaseProject = resolve; });
    let projected = false;
    let rotatedBeforeProjection = false;

    const store = new BrokerDurableStore({
      journal: {
        async appendEntries(entries) {
          order.push(`journal:${entries[0]?.kind}`);
          return entries;
        },
      },
      projection: stubProjection({
        async applyEntries() {
          await projectGate;
          projected = true;
          order.push("projection");
          return [];
        },
      }),
      threadEvents: { publish() {} },
    });

    const occupied = store.runWrite(async () => { await writerGate; });
    const queued = store.runWrite(() => store.commitEntries(messageEntry(), async () => {}));
    const rotation = store.runWrite(async () => {
      const boundary = await store.awaitProjectionBoundary();
      if (boundary.ok) {
        rotatedBeforeProjection = !projected;
        await store.commitEntries({ kind: "history.rotate", cutoff: 1, rotatedAt: 1 }, async () => {});
      }
    });

    releaseWriter();
    // The queued commit runs, then the rotation's boundary must block on the
    // queued write's in-flight projection — the rotate cannot pass it.
    await queued;
    await Bun.sleep(10);
    expect(projected).toBe(false);
    releaseProject();
    await rotation;
    expect(rotatedBeforeProjection).toBe(false);
    await store.flushProjectedEntries();
    expect(order).toEqual([
      "journal:message.record",
      "projection",
      "journal:history.rotate",
      "projection",
    ]);
    await occupied;
  });

  /** The daemon's rotation sequence, reproduced against the same primitives. */
  async function rotateOnce(
    store: BrokerDurableStore,
    journal: FileBackedBrokerJournal,
    cutoff: number,
  ): Promise<
    { skipped: string } | BrokerPersistenceVerification
  > {
    return store.runWrite(async () => {
      const boundary = await store.awaitProjectionBoundary();
      if (!boundary.ok) return { skipped: boundary.reason };
      const snapshot = journal.snapshot();
      const plan = planHistoryRotation(
        snapshot,
        cutoff,
        journal.historyRotationContext(),
      );
      const { present, missing } = await store.verifyPersisted(plan);
      const attemptsById = journal.deliveryAttemptsById();
      const { evictable, retained } = refineVerifiedRotation(present, missing, {
        invocation: (id) => snapshot.invocations[id],
        flight: (id) => snapshot.flights[id],
        delivery: (id) => journal.getDelivery(id),
        deliveryAttempt: (id) => attemptsById.get(id),
      });
      await store.commitEntries(
        [{
          kind: "history.rotate",
          cutoff,
          rotatedAt: cutoff,
          evicted: {
            messageIds: [...evictable.messageIds],
            invocationIds: [...evictable.invocationIds],
            flightIds: [...evictable.flightIds],
            deliveryIds: [...evictable.deliveryIds],
            deliveryAttemptIds: [...evictable.deliveryAttemptIds],
            collaborationEventIds: [...evictable.collaborationEventIds],
          },
        }],
        async () => {},
      );
      return { present: evictable, missing: retained };
    });
  }

  const eagerCompaction = () => ({
    minimumReclaimBytes: 1,
    minimumReclaimRatio: 0,
    highWaterBytes: Number.MAX_SAFE_INTEGER,
    highWaterMinimumReclaimBytes: Number.MAX_SAFE_INTEGER,
  });

  test("verifyPersisted reports every planned id missing when the projection cannot verify", async () => {
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection(),
      threadEvents: { publish() {} },
    });
    const plan = emptyHistoryRotationPlan();
    plan.messageIds.add("m");
    const { present, missing } = await store.verifyPersisted(plan);
    expect([...missing.messageIds]).toEqual(["m"]);
    expect(present.messageIds.size).toBe(0);
  });

  test("verifyPersisted drains the queued projection write before verifying", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const store = new BrokerDurableStore({
      journal: { async appendEntries(entries) { return entries; } },
      projection: stubProjection({
        async applyEntries() {
          order.push("apply");
          await new Promise<void>((resolve) => { release = resolve; });
          return [];
        },
        async verifyPersisted(plan) {
          order.push("verify");
          return { present: plan, missing: emptyHistoryRotationPlan() };
        },
      }),
      threadEvents: { publish() {} },
    });
    const commit = store.commitEntries(messageEntry(), async () => {});
    await Bun.sleep(10);
    const verification = store.verifyPersisted(emptyHistoryRotationPlan());
    expect(order).toEqual(["apply"]);
    release();
    await commit;
    await verification;
    expect(order).toEqual(["apply", "verify"]);
  });

  // Third-pass redesign: a message whose projection failed is not in the
  // verified `present` set, so the rotate marker dooms nothing — the record
  // stays in the snapshot and journal through compaction, and the NEXT
  // rotation evicts it once the projection lands it.
  test("a message whose projection failed is verified missing, stays journaled through compaction, and is evicted once it lands", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    await journal.appendEntries([messageEntry()]);

    let fail = true;
    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        const store = new SQLiteControlPlaneStore(path);
        const record = store.recordMessage.bind(store);
        store.recordMessage = ((message: Parameters<typeof record>[0]) => {
          if (fail) throw new Error("injected malformed message");
          return record(message);
        }) as typeof record;
        return store;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    // First rotation: 'm' is unprojected — verified missing, evicted nothing.
    const first = await rotateOnce(store, journal, cutoff);
    expect("skipped" in first).toBe(false);
    if (!("skipped" in first)) {
      expect([...first.missing.messageIds]).toContain("m");
      expect(first.present.messageIds.size).toBe(0);
    }
    expect(journal.snapshot().messages["m"]).toBeDefined();

    const compacted = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: eagerCompaction(),
    });
    await compacted.load();
    expect(compacted.snapshot().messages["m"]).toBeDefined();
    expect((await compacted.readEntries()).map((entry) => entry.kind))
      .toContain("message.record");
    await compacted.close();

    // Let the record land; the next rotation verifies and evicts it.
    fail = false;
    await store.runWrite(() => store.commitEntries(messageEntry(), async () => {}));
    await store.flushProjectedEntries();
    const second = await rotateOnce(store, journal, cutoff + 1_000);
    expect("skipped" in second).toBe(false);
    if (!("skipped" in second)) {
      expect([...second.present.messageIds]).toContain("m");
      expect(second.missing.messageIds.size).toBe(0);
    }
    expect(journal.snapshot().messages["m"]).toBeUndefined();

    // Compaction drops the hot line — and only now, because SQLite provably
    // holds the row.
    const compactedAgain = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: eagerCompaction(),
    });
    await compactedAgain.load();
    expect(compactedAgain.snapshot().messages["m"]).toBeUndefined();
    await compactedAgain.close();
    const checkStore = new SQLiteControlPlaneStore(dbPath);
    expect(checkStore.readerDb.query(
      "SELECT id FROM messages WHERE id = ?1",
    ).get("m")).toMatchObject({ id: "m" });
    checkStore.close();
    projection.close();
  });

  // Third-pass redesign of the legacy-checkpoint repro: a replay checkpoint
  // can sit past a record that never landed (skipped during replay). The
  // checkpoint alone is not coverage — positive verification reports the
  // message missing and the rotation keeps it journaled.
  test("a replay checkpoint past a missing record does not certify it — verification keeps the message journaled", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    await journal.appendEntries([messageEntry()]);

    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        const store = new SQLiteControlPlaneStore(path);
        store.recordMessage = (() => {
          throw new Error("injected malformed message");
        }) as typeof store.recordMessage;
        return store;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    // The checkpoint advanced past the skipped entry — proof the old
    // checkpoint-trust model would have called this covered.
    const checkpointStore = new SQLiteControlPlaneStore(dbPath);
    expect(checkpointStore.writerDb.query(
      "SELECT COUNT(*) AS n FROM broker_journal_projection_checkpoints",
    ).get()).toMatchObject({ n: 1 });
    expect(checkpointStore.readerDb.query(
      "SELECT id FROM messages WHERE id = ?1",
    ).get("m")).toBeNull();
    checkpointStore.close();

    // Positive verification still answers "missing": the rotation journals
    // an empty eviction and the message survives compaction.
    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    if (!("skipped" in outcome)) {
      expect([...outcome.missing.messageIds]).toContain("m");
    }
    const compacted = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: eagerCompaction(),
    });
    await compacted.load();
    expect(compacted.snapshot().messages["m"]).toBeDefined();
    expect((await compacted.readEntries()).map((entry) => entry.kind))
      .toContain("message.record");
    await compacted.close();
    projection.close();
  });

  // Third-pass redesign: flights are mutable — a stored row whose state or
  // completion timestamp is stale is not coverage. The flight is retained
  // until the durable row matches the journaled record.
  test("a stale flight state in SQLite is verified missing and retained until the stored state matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    await journal.appendEntries([
      {
        kind: "node.upsert",
        node: { id: "n", meshId: "mesh-1", name: "n", advertiseScope: "local", registeredAt: 1 },
      },
      {
        kind: "actor.upsert",
        actor: { id: "op", kind: "person", displayName: "Op" },
      },
      {
        kind: "agent.upsert",
        agent: {
          id: "a",
          kind: "agent",
          displayName: "A",
          definitionId: "a",
          agentClass: "builder",
          capabilities: ["execute"],
          wakePolicy: "on_demand",
          homeNodeId: "n",
          authorityNodeId: "n",
          advertiseScope: "local",
          createdAt: 1,
        },
      },
      {
        kind: "conversation.upsert",
        conversation: {
          id: "c",
          kind: "direct",
          title: "C",
          visibility: "private",
          shareMode: "local",
          authorityNodeId: "n",
          participantIds: ["op", "a"],
        },
      },
      { kind: "message.record", message: messageEntry().message },
      {
        kind: "invocation.record",
        invocation: {
          id: "i",
          messageId: "m",
          requesterId: "op",
          requesterNodeId: "n",
          targetAgentId: "a",
          action: "execute",
          task: "work",
          ensureAwake: true,
          stream: true,
          createdAt: 1_699_000_000_000,
        },
      },
      {
        kind: "flight.record",
        flight: {
          id: "f",
          invocationId: "i",
          requesterId: "op",
          targetAgentId: "a",
          state: "completed",
          startedAt: 1_699_000_000_000,
          completedAt: 1_699_000_001_000,
        },
      },
    ]);

    let sqlite: SQLiteControlPlaneStore | undefined;
    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        sqlite = new SQLiteControlPlaneStore(path);
        return sqlite;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    // Corrupt the durable flight row: state parity fails even though the
    // row exists.
    expect(sqlite).toBeDefined();
    sqlite!.writerDb.query(
      "UPDATE flights SET state = 'failed', completed_at = completed_at + 1 WHERE id = ?1",
    ).run("f");

    const plan = planHistoryRotation(
      journal.snapshot(), cutoff, journal.historyRotationContext(),
    );
    expect(plan.flightIds.has("f")).toBe(true);
    const first = await store.verifyPersisted(plan);
    expect([...first.missing.flightIds]).toEqual(["f"]);
    expect(first.present.flightIds.size).toBe(0);
    // The message and invocation are still durable — they verify present.
    expect(first.present.messageIds.has("m")).toBe(true);
    expect(first.present.invocationIds.has("i")).toBe(true);

    // Restore the stored state; the flight now verifies present.
    sqlite!.writerDb.query(
      "UPDATE flights SET state = 'completed', completed_at = ?1 WHERE id = ?2",
    ).run(1_699_000_001_000, "f");
    const second = await store.verifyPersisted(plan);
    expect(second.present.flightIds.has("f")).toBe(true);
    expect(second.missing.flightIds.size).toBe(0);
    projection.close();
  });

  /** Base records the rotation fixtures need (FK parents for i/f/d/e). */
  const fixtureEntries = (): BrokerJournalEntry[] => [
    {
      kind: "node.upsert",
      node: { id: "n", meshId: "mesh-1", name: "n", advertiseScope: "local", registeredAt: 1 },
    },
    { kind: "actor.upsert", actor: { id: "op", kind: "person", displayName: "Op" } },
    { kind: "actor.upsert", actor: { id: "a", kind: "agent", displayName: "A" } },
    {
      kind: "agent.upsert",
      agent: {
        id: "a",
        kind: "agent",
        displayName: "A",
        definitionId: "a",
        agentClass: "builder",
        capabilities: ["execute"],
        wakePolicy: "on_demand",
        homeNodeId: "n",
        authorityNodeId: "n",
        advertiseScope: "local",
        createdAt: 1,
      },
    },
    {
      kind: "conversation.upsert",
      conversation: {
        id: "c",
        kind: "direct",
        title: "C",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "n",
        participantIds: ["op", "a"],
      },
    },
    {
      kind: "collaboration.record",
      record: {
        id: "r",
        kind: "question",
        title: "R",
        state: "open",
        acceptanceState: "pending",
        createdById: "op",
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ] as BrokerJournalEntry[];

  const OLD = 1_699_000_000_000;
  const fixtureRecords = () => ({
    message: {
      id: "m", conversationId: "c", actorId: "op", originNodeId: "n",
      class: "agent", body: "old", visibility: "private", policy: "durable", createdAt: OLD,
    },
    invocation: {
      id: "i", messageId: "m", requesterId: "op", requesterNodeId: "n",
      targetAgentId: "a", action: "execute", task: "old",
      ensureAwake: true, stream: true, createdAt: OLD,
    },
    flight: {
      id: "f", invocationId: "i", requesterId: "op", targetAgentId: "a",
      state: "completed", output: "old", startedAt: OLD, completedAt: OLD + 1_000,
    },
    delivery: {
      id: "d", messageId: "m", targetId: "a", targetKind: "agent",
      transport: "local_socket", reason: "direct_message",
      policy: "best_effort", status: "pending",
    },
    event: {
      id: "e", recordId: "r", recordKind: "question", kind: "created",
      actorId: "op", summary: "old", at: OLD,
    },
    attempt: {
      id: "a1", deliveryId: "d", attempt: 1, status: "failed", createdAt: OLD,
    },
  });
  const recordEntries = (records: ReturnType<typeof fixtureRecords>): BrokerJournalEntry[] => [
    { kind: "message.record", message: records.message },
    { kind: "invocation.record", invocation: records.invocation },
    { kind: "flight.record", flight: records.flight },
    { kind: "deliveries.record", deliveries: [records.delivery] },
    { kind: "collaboration.event.record", event: records.event },
  ] as BrokerJournalEntry[];

  // Fourth-pass finding 1: presence is not coverage — the stored row must
  // equal the journaled record through the store's own mappers. Newer
  // versions journaled but never projected verify MISSING for every
  // category (including a flight whose state/completedAt did not change),
  // the marker evicts nothing, and compaction keeps the newer lines.
  // Port of the stale-content probe.
  test("stale stored rows verify missing for every category — the marker evicts nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    const records = fixtureRecords();
    await journal.appendEntries([...fixtureEntries(), ...recordEntries(records)]);

    let fail = false;
    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        const store = new SQLiteControlPlaneStore(path);
        for (const method of [
          "recordMessage", "recordInvocation", "recordFlight",
          "recordCollaborationEvent", "recordDeliveries", "updateDeliveryStatus",
        ] as const) {
          const original = store[method].bind(store) as (...args: never[]) => unknown;
          (store as Record<string, unknown>)[method] = (...args: never[]) => {
            if (fail) throw new Error(`injected malformed newer ${method}`);
            return original(...args);
          };
        }
        return store;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    // Journal newer versions and push them through the projection — every
    // write fails, so SQLite keeps the stale rows while the journal holds
    // the new content.
    fail = true;
    const newer = fixtureRecords();
    newer.message.body = "NEW";
    newer.invocation.task = "NEW";
    // Same state AND completedAt — the old two-column parity would certify
    // this stale row; deep parity must not.
    newer.flight.output = "NEW";
    newer.delivery.status = "completed";
    newer.event.summary = "NEW";
    const newerEntries = recordEntries(newer);
    await journal.appendEntries(newerEntries);
    await projection.applyEntries(newerEntries).catch(() => {});
    await projection.flush();

    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    if (!("skipped" in outcome)) {
      for (const key of [
        "messageIds", "invocationIds", "flightIds",
        "deliveryIds", "collaborationEventIds",
      ] as const) {
        expect(outcome.present[key].size).toBe(0);
      }
      expect(outcome.missing.messageIds.has("m")).toBe(true);
      expect(outcome.missing.invocationIds.has("i")).toBe(true);
      expect(outcome.missing.flightIds.has("f")).toBe(true);
      expect(outcome.missing.deliveryIds.has("d")).toBe(true);
      expect(outcome.missing.collaborationEventIds.has("e")).toBe(true);
    }

    // Nothing was evicted — every record stays in the hot snapshot, and the
    // compacted journal keeps the NEWER lines (the only copies of the new
    // content) instead of dropping them on the strength of a stale row.
    expect(journal.snapshot().messages["m"]?.body).toBe("NEW");
    const compacted = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: eagerCompaction(),
    });
    await compacted.load();
    expect(compacted.snapshot().messages["m"]?.body).toBe("NEW");
    expect(compacted.snapshot().invocations["i"]?.task).toBe("NEW");
    expect(compacted.snapshot().flights["f"]?.output).toBe("NEW");
    expect(compacted.getDelivery("d")?.status).toBe("completed");
    expect(compacted.collaborationEventsById().get("e")?.summary).toBe("NEW");
    await compacted.close();
    projection.close();
  });

  // Fifth-pass findings: the write path normalizes records the journaled
  // record does not — mentions/attachments are sets keyed by their table
  // primary keys (last write wins), the invocation collaboration id is
  // derived from context/metadata and trimmed, and a divergent flight
  // identity is rewritten to the parent invocation's. Verification applies
  // the same normalizers to the expected side, so a healthy
  // pre-normalization record verifies present and is evicted.
  test("pre-normalization journaled shapes verify present and are evicted — write-path normalizers apply symmetrically", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();

    const message = {
      ...fixtureRecords().message,
      // Journaled order [op, a, op]: the (message_id, actor_id) key stores
      // the "last" label for op and reads back ordered by actor —
      // [a, op(last)].
      mentions: [
        { actorId: "op", label: "first" },
        { actorId: "a", label: "agent" },
        { actorId: "op", label: "last" },
      ],
      // Attachment ids journaled out of order; the id-keyed table reads
      // back ordered by id — [a-att, b-att].
      attachments: [
        { id: "b-att", mediaType: "text/plain", fileName: "b.txt" },
        { id: "a-att", mediaType: "text/plain", fileName: "a.txt" },
      ],
    };

    const invocationBase = {
      messageId: "m",
      requesterId: "op",
      requesterNodeId: "n",
      targetAgentId: "a",
      action: "execute",
      ensureAwake: true,
      stream: true,
      createdAt: OLD,
    };
    const derivedInvocations = [
      // metadata fallback — no top-level collaborationRecordId.
      { ...invocationBase, id: "i-meta", task: "meta", metadata: { collaborationRecordId: "r" } },
      // Top-level value the write path trims before storing.
      { ...invocationBase, id: "i-pad", task: "pad", collaborationRecordId: " r " },
      // Nested context fallback through the recordId key.
      { ...invocationBase, id: "i-nest", task: "nest", context: { collaboration: { recordId: "r" } } },
    ];
    const flights = derivedInvocations.map((invocation, index) => ({
      id: `f-${invocation.id}`,
      invocationId: invocation.id,
      requesterId: "op",
      targetAgentId: "a",
      state: "completed",
      startedAt: OLD + index * 1_000,
      completedAt: OLD + index * 1_000 + 500,
    }));
    // Raw FlightRecord posts can carry a divergent identity — recordFlight
    // rewrites it to the parent invocation's before storing.
    const divergentFlight = {
      id: "f-div",
      invocationId: "i-meta",
      requesterId: "stranger",
      targetAgentId: "other-agent",
      state: "completed",
      startedAt: OLD + 10_000,
      completedAt: OLD + 11_000,
    };

    await journal.appendEntries([
      ...fixtureEntries(),
      { kind: "message.record", message },
      ...derivedInvocations.map((invocation) => (
        { kind: "invocation.record", invocation }
      )),
      ...[...flights, divergentFlight].map((flight) => (
        { kind: "flight.record", flight }
      )),
    ] as BrokerJournalEntry[]);

    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => new SQLiteControlPlaneStore(path),
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    if (!("skipped" in outcome)) {
      expect([...outcome.present.messageIds]).toEqual(["m"]);
      for (const id of ["i-meta", "i-pad", "i-nest"]) {
        expect(outcome.present.invocationIds.has(id)).toBe(true);
      }
      for (const id of ["f-i-meta", "f-i-pad", "f-i-nest", "f-div"]) {
        expect(outcome.present.flightIds.has(id)).toBe(true);
      }
      for (const key of ["messageIds", "invocationIds", "flightIds"] as const) {
        expect(outcome.missing[key].size).toBe(0);
      }
    }

    // The marker applied the verified sets — the hot snapshot dropped them.
    const snapshot = journal.snapshot();
    expect(snapshot.messages["m"]).toBeUndefined();
    expect(snapshot.invocations["i-meta"]).toBeUndefined();
    expect(snapshot.flights["f-div"]).toBeUndefined();

    // And compaction drops the journaled lines — SQLite provably holds the
    // normalized records.
    const compacted = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: eagerCompaction(),
    });
    await compacted.load();
    expect(compacted.snapshot().messages["m"]).toBeUndefined();
    expect(compacted.snapshot().invocations["i-nest"]).toBeUndefined();
    expect(compacted.snapshot().flights["f-i-meta"]).toBeUndefined();
    await compacted.close();

    const checkStore = new SQLiteControlPlaneStore(dbPath);
    // The stored mention for op is the last write — proving the dedupe
    // policy, not just the ordering, round-tripped.
    expect(checkStore.readerDb.query(
      "SELECT label FROM message_mentions WHERE message_id = ?1 AND actor_id = ?2",
    ).get("m", "op")).toMatchObject({ label: "last" });
    expect(checkStore.readerDb.query(
      "SELECT collaboration_record_id AS id FROM invocations WHERE id = ?1",
    ).get("i-meta")).toMatchObject({ id: "r" });
    expect(checkStore.readerDb.query(
      "SELECT requester_id AS r, target_agent_id AS t FROM flights WHERE id = ?1",
    ).get("f-div")).toMatchObject({ r: "op", t: "a" });
    checkStore.close();
    projection.close();
  });

  // The symmetric normalization must not certify genuinely different
  // persisted data: a stale mention label, a divergent collaboration id
  // column, and a divergent flight identity column all still verify
  // missing and the records stay journaled.
  test("stale normalized fields still verify missing — mention label, collaboration id, and flight identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();

    const records = fixtureRecords();
    const message = {
      ...records.message,
      mentions: [{ actorId: "a", label: "keep" }],
    };
    const derivedInvocation = {
      ...records.invocation,
      metadata: { collaborationRecordId: "r" },
    };
    await journal.appendEntries([
      ...fixtureEntries(),
      // A second collaboration record so the corruption below stays
      // inside the collaboration_record_id FK.
      {
        kind: "collaboration.record",
        record: {
          id: "r2", kind: "question", title: "R2", state: "open",
          acceptanceState: "pending", createdById: "op", createdAt: 1, updatedAt: 1,
        },
      },
      { kind: "message.record", message },
      { kind: "invocation.record", invocation: derivedInvocation },
      { kind: "flight.record", flight: records.flight },
    ] as BrokerJournalEntry[]);

    let sqlite: SQLiteControlPlaneStore | undefined;
    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        sqlite = new SQLiteControlPlaneStore(path);
        return sqlite;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    expect(sqlite).toBeDefined();
    sqlite!.writerDb.query(
      "UPDATE message_mentions SET label = 'stale' WHERE message_id = ?1 AND actor_id = ?2",
    ).run("m", "a");
    // collaboration_record_id is FK'd — corrupt to the other record's id.
    sqlite!.writerDb.query(
      "UPDATE invocations SET collaboration_record_id = 'r2' WHERE id = ?1",
    ).run("i");
    // requester_id is FK'd to actors — corrupt to a different existing
    // actor rather than an unknown one.
    sqlite!.writerDb.query(
      "UPDATE flights SET requester_id = 'a' WHERE id = ?1",
    ).run("f");

    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    if (!("skipped" in outcome)) {
      expect(outcome.missing.messageIds.has("m")).toBe(true);
      expect(outcome.missing.invocationIds.has("i")).toBe(true);
      expect(outcome.missing.flightIds.has("f")).toBe(true);
      for (const key of ["messageIds", "invocationIds", "flightIds"] as const) {
        expect(outcome.present[key].size).toBe(0);
      }
    }

    const snapshot = journal.snapshot();
    expect(snapshot.messages["m"]).toBeDefined();
    expect(snapshot.invocations["i"]).toBeDefined();
    expect(snapshot.flights["f"]).toBeDefined();
    const compacted = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: eagerCompaction(),
    });
    await compacted.load();
    expect(compacted.snapshot().messages["m"]).toBeDefined();
    expect(compacted.snapshot().invocations["i"]).toBeDefined();
    expect(compacted.snapshot().flights["f"]).toBeDefined();
    await compacted.close();
    projection.close();
  });

  // Fourth-pass finding 3: a failed chunk lookup fails the whole answer
  // closed — fresh empty present, every planned id missing, no overlap.
  // Port of the lookup-error probe.
  test("a lookup error reports every planned id missing with an empty present set", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    const records = fixtureRecords();
    await journal.appendEntries([
      ...fixtureEntries(),
      { kind: "message.record", message: records.message },
      { kind: "invocation.record", invocation: records.invocation },
      { kind: "flight.record", flight: records.flight },
    ] as BrokerJournalEntry[]);

    let bad = false;
    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        const store = new SQLiteControlPlaneStore(path);
        const original = store.readInvocations.bind(store);
        store.readInvocations = (ids: readonly string[]) => {
          if (bad) throw new Error("SQLITE_BUSY: injected lookup failure");
          return original(ids);
        };
        return store;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    bad = true;
    const plan = planHistoryRotation(
      journal.snapshot(), cutoff, journal.historyRotationContext(),
    );
    const { present, missing } = await store.verifyPersisted(plan);
    // m verified before the failing invocation chunk — under the old code
    // it stayed in BOTH sets. Now: empty present, everything missing.
    for (const key of [
      "messageIds", "invocationIds", "flightIds",
      "deliveryIds", "deliveryAttemptIds", "collaborationEventIds",
    ] as const) {
      expect(present[key].size).toBe(0);
    }
    expect(missing.messageIds.has("m")).toBe(true);
    expect(missing.invocationIds.has("i")).toBe(true);
    expect(missing.flightIds.has("f")).toBe(true);

    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    expect(journal.snapshot().messages["m"]).toBeDefined();
    projection.close();
  });

  // The verifier contract: present and missing partition the plan. A
  // projection answer that overlaps, names unplanned ids, or leaves ids
  // unanswered is untrustworthy — throw inside the writer instead of
  // evicting on it.
  test("verifyPersisted throws when the verifier answer does not partition the plan", async () => {
    const plan = emptyHistoryRotationPlan();
    plan.messageIds.add("m");
    plan.invocationIds.add("i");

    const overlapping = (): BrokerPersistenceVerification => ({
      present: { ...emptyHistoryRotationPlan(), messageIds: new Set(["m"]) },
      missing: {
        ...emptyHistoryRotationPlan(),
        messageIds: new Set(["m"]),
        invocationIds: new Set(["i"]),
      },
    });
    const unplanned = (): BrokerPersistenceVerification => ({
      present: {
        ...emptyHistoryRotationPlan(),
        messageIds: new Set(["m"]),
        invocationIds: new Set(["i"]),
        flightIds: new Set(["f-never-planned"]),
      },
      missing: emptyHistoryRotationPlan(),
    });
    const unanswered = (): BrokerPersistenceVerification => ({
      present: { ...emptyHistoryRotationPlan(), messageIds: new Set(["m"]) },
      missing: emptyHistoryRotationPlan(),
    });

    for (const [label, answer] of [
      ["both present and missing", overlapping],
      ["unplanned", unplanned],
      ["unanswered", unanswered],
    ] as const) {
      const store = new BrokerDurableStore({
        journal: { async appendEntries(entries) { return entries; } },
        projection: stubProjection({
          verifyPersisted: async () => answer(),
        }),
        threadEvents: { publish() {} },
      });
      await expect(store.verifyPersisted(plan)).rejects.toThrow(label);
    }
  });

  // Fourth-pass finding 4: the closure re-runs over the verified answer to
  // a fixpoint. An invocation that could not be proven durable stays live,
  // so its message and terminal flight stay journaled even though both
  // verified present — eviction is all-or-nothing per component.
  test("an unverified invocation retains its verified message and flight through the post-verification closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    const records = fixtureRecords();
    await journal.appendEntries([
      ...fixtureEntries(),
      { kind: "message.record", message: records.message },
      { kind: "invocation.record", invocation: records.invocation },
      { kind: "flight.record", flight: records.flight },
    ] as BrokerJournalEntry[]);

    let fail = true;
    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        const store = new SQLiteControlPlaneStore(path);
        const recordInvocation = store.recordInvocation.bind(store);
        store.recordInvocation = ((invocation: Parameters<typeof recordInvocation>[0]) => {
          if (fail) throw new Error("injected malformed invocation");
          return recordInvocation(invocation);
        }) as typeof store.recordInvocation;
        return store;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    // The message verified present; the invocation (and its FK-dependent
    // flight row) verified missing. The refined eviction must be empty —
    // the surviving invocation re-protects its message and flight.
    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    if (!("skipped" in outcome)) {
      expect(outcome.present.messageIds.size).toBe(0);
      expect(outcome.missing.invocationIds.has("i")).toBe(true);
      expect(outcome.missing.flightIds.has("f")).toBe(true);
      expect(outcome.missing.messageIds.has("m")).toBe(true);
    }
    expect(journal.snapshot().messages["m"]).toBeDefined();
    expect(journal.snapshot().invocations["i"]).toBeDefined();
    expect(journal.snapshot().flights["f"]).toBeDefined();

    // Once the invocation and its flight land durably, the next rotation
    // retires the whole component together — nothing is retained forever.
    // The flight row failed via FK earlier; the journal dedupes identical
    // flight records, so it is applied straight to the projection (the
    // journaled line is already there — only the row is missing).
    fail = false;
    await store.runWrite(() => store.commitEntries(
      { kind: "invocation.record", invocation: records.invocation } as BrokerJournalEntry,
      async () => {},
    ));
    await projection.applyEntries([
      { kind: "flight.record", flight: records.flight } as BrokerJournalEntry,
    ]);
    await store.flushProjectedEntries();
    const second = await rotateOnce(store, journal, cutoff + 1_000);
    expect("skipped" in second).toBe(false);
    if (!("skipped" in second)) {
      expect(second.present.messageIds.has("m")).toBe(true);
      expect(second.present.invocationIds.has("i")).toBe(true);
      expect(second.present.flightIds.has("f")).toBe(true);
    }
    projection.close();
  });

  // Fourth-pass finding 2: attempts are part of the plan, verified like
  // every other category, and evicted only by exact id. An unprojected
  // attempt is verified missing and an empty marker dooms nothing — the
  // attempt line survives compaction.
  test("an unprojected delivery attempt is verified missing and survives the empty marker and compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    const records = fixtureRecords();
    await journal.appendEntries([
      ...fixtureEntries(),
      { kind: "message.record", message: records.message },
      { kind: "deliveries.record", deliveries: [records.delivery] },
      { kind: "delivery.attempt.record", attempt: records.attempt },
    ] as BrokerJournalEntry[]);

    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        const store = new SQLiteControlPlaneStore(path);
        store.recordDeliveryAttempt = (() => {
          throw new Error("injected malformed attempt");
        }) as typeof store.recordDeliveryAttempt;
        return store;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    // The pending delivery keeps the attempt out of the plan entirely —
    // the marker is empty and the unprojected attempt survives apply AND
    // compaction (the probe's exact case).
    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    expect(journal.listDeliveryAttempts("d").map((attempt) => attempt.id)).toEqual(["a1"]);

    const compacted = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: eagerCompaction(),
    });
    await compacted.load();
    expect(compacted.listDeliveryAttempts("d").map((attempt) => attempt.id)).toEqual(["a1"]);
    expect((await compacted.readEntries()).map((entry) => entry.kind))
      .toContain("delivery.attempt.record");
    await compacted.close();
    projection.close();
  });

  // An attempt whose delivery is evictable is planned, verified, and
  // evicted by exact id — and an attempt the verifier cannot prove holds
  // its whole component (delivery, then message) in the hot set.
  test("a verified delivery attempt is evicted exactly; an unverified one retains its component", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    const records = fixtureRecords();
    const completedDelivery = { ...records.delivery, status: "completed" };
    await journal.appendEntries([
      ...fixtureEntries(),
      { kind: "message.record", message: records.message },
      { kind: "deliveries.record", deliveries: [completedDelivery] },
      { kind: "delivery.attempt.record", attempt: records.attempt },
    ] as BrokerJournalEntry[]);

    const projection = new RecoverableSQLiteProjection(dbPath, journal, {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
    });
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    // Terminal delivery whose referent leaves → d is evictable → a1 is
    // planned and verified → the marker evicts m/d/a1 exactly.
    const plan = planHistoryRotation(
      journal.snapshot(), cutoff, journal.historyRotationContext(),
    );
    expect(plan.deliveryAttemptIds.has("a1")).toBe(true);
    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    if (!("skipped" in outcome)) {
      expect(outcome.present.deliveryAttemptIds.has("a1")).toBe(true);
    }
    expect(journal.listDeliveryAttempts("d")).toEqual([]);
    expect(journal.getDelivery("d")).toBeUndefined();
    projection.close();
  });

  // The flip side: the attempt's row never landed — the attempt verifies
  // missing, and the post-verification closure retains the delivery and
  // the delivery's message referent with it.
  test("an unverified delivery attempt retains its delivery and message through the closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-verify-"));
    boundaryRoots.add(root);
    const journalPath = join(root, "journal.jsonl");
    const dbPath = join(root, "projection.sqlite");
    const cutoff = 1_700_000_000_000;

    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    const records = fixtureRecords();
    const completedDelivery = { ...records.delivery, status: "completed" };
    await journal.appendEntries([
      ...fixtureEntries(),
      { kind: "message.record", message: records.message },
      { kind: "deliveries.record", deliveries: [completedDelivery] },
      { kind: "delivery.attempt.record", attempt: records.attempt },
    ] as BrokerJournalEntry[]);

    const options = {
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
      createStore: (path: string) => {
        const store = new SQLiteControlPlaneStore(path);
        store.recordDeliveryAttempt = (() => {
          throw new Error("injected malformed attempt");
        }) as typeof store.recordDeliveryAttempt;
        return store;
      },
    };
    const projection = new RecoverableSQLiteProjection(dbPath, journal, options);
    await projection.warm();
    await projection.flush();
    const store = new BrokerDurableStore({
      journal, projection, threadEvents: { publish() {} },
    });

    const outcome = await rotateOnce(store, journal, cutoff);
    expect("skipped" in outcome).toBe(false);
    if (!("skipped" in outcome)) {
      expect(outcome.missing.deliveryAttemptIds.has("a1")).toBe(true);
      // The retained attempt holds its delivery; the retained delivery
      // holds its message — the whole component stays.
      expect(outcome.missing.deliveryIds.has("d")).toBe(true);
      expect(outcome.missing.messageIds.has("m")).toBe(true);
      expect(outcome.present.deliveryAttemptIds.size).toBe(0);
      expect(outcome.present.deliveryIds.size).toBe(0);
    }
    expect(journal.listDeliveryAttempts("d").map((attempt) => attempt.id)).toEqual(["a1"]);
    expect(journal.getDelivery("d")).toBeDefined();
    expect(journal.snapshot().messages["m"]).toBeDefined();
    projection.close();
  });
});
