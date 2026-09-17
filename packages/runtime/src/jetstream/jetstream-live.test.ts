/**
 * Real-NATS integration tests.
 *
 * Excluded from the root `test:unit` by its `**\/*live.test.ts` ignore pattern;
 * run them with `bun run --cwd packages/runtime test:live:jetstream`.
 *
 * Every test owns an isolated server: reserved loopback ports, a temp store
 * directory, a temp progress file, and a per-test stream name. Nothing here
 * touches the operator's installed nats-server, the OpenScout support
 * directory, or the ports in `OPENSCOUT_PORTS`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EPHEMERAL_CONTROL_EVENT_KINDS,
  type ControlEvent,
  type MessageRecord,
} from "@openscout/protocol";

import { FileBackedBrokerJournal, type BrokerJournalEntry } from "../broker-journal.js";
import { resolveJetStreamConfig, type JetStreamRuntimeConfig } from "./config.js";
import {
  JetStreamStreamOwnershipError,
  ScoutJetStreamConnection,
} from "./connection.js";
import {
  ScoutStreamDeduplicator,
  openScoutEventConsumer,
  type ScoutEventConsumer,
  type ScoutStreamDelivery,
} from "./consumer.js";
import { jetStreamSubject, messagePostedStreamEvent } from "./events.js";
import { JetStreamJournalPublisher, readJetStreamPublisherProgress } from "./publisher.js";
import {
  JetStreamBinaryMissingError,
  JetStreamPortOccupiedError,
  NatsJetStreamSidecar,
  probeTcpPort,
} from "./sidecar.js";
import {
  createIsolatedJetStreamHarness,
  hasNatsServerBinary,
  type IsolatedJetStreamHarness,
} from "./test-support.js";

const NODE_ID = "node-test";
const hasNats = hasNatsServerBinary();

let messageCounter = 0;

function messageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  messageCounter += 1;
  return {
    id: `msg-live-${messageCounter}`,
    conversationId: "chn-alpha",
    actorId: "actor-1",
    originNodeId: NODE_ID,
    class: "agent",
    body: "hello",
    visibility: "private",
    policy: "durable",
    createdAt: Date.now(),
    ...overrides,
  };
}

function entry(message: MessageRecord): BrokerJournalEntry {
  return { kind: "message.record", message };
}

/**
 * Drain up to `count` deliveries, or give up at the deadline.
 *
 * Deliberately deadline-bounded rather than blocking: several tests assert that
 * *nothing* arrives, and a plain `for await` would hang on that.
 */
async function takeEvents(
  consumer: ScoutEventConsumer,
  count: number,
  options: { ack?: boolean; timeoutMs?: number } = {},
): Promise<ScoutStreamDelivery[]> {
  const ack = options.ack ?? true;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const collected: ScoutStreamDelivery[] = [];
  // An abandoned `next()` cannot be cancelled by `return()` — that queues
  // behind it. The signal stops the underlying stream, which is what lets a
  // "nothing should arrive" assertion finish without closing the consumer.
  const controller = new AbortController();
  const iterator = consumer.events({ signal: controller.signal });
  try {
    while (collected.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!next || next.done) break;
      if (ack) next.value.ack();
      collected.push(next.value);
    }
  } finally {
    controller.abort();
    await iterator.return(undefined as never).catch(() => undefined);
  }
  return collected;
}

describe.skipIf(!hasNats)("jetstream transport (real nats-server)", () => {
  let harness: IsolatedJetStreamHarness;
  let connection: ScoutJetStreamConnection;

  beforeAll(async () => {
    harness = await createIsolatedJetStreamHarness();
    connection = new ScoutJetStreamConnection({ config: harness.config, name: "test-publisher" });
    await connection.connect();
    await connection.ensureStream();
  });

  afterAll(async () => {
    await connection?.close().catch(() => undefined);
    await harness?.dispose();
  });

  async function publish(message: MessageRecord): Promise<void> {
    const event = messagePostedStreamEvent({ message, publisherNodeId: NODE_ID });
    await connection.publishEvent(
      jetStreamSubject({
        prefix: harness.config.subjectPrefix,
        publisherNodeId: NODE_ID,
        kind: event.kind,
        conversationId: event.conversationId,
      }),
      event,
    );
  }

  test("two independent consumers each receive every event", async () => {
    const conversationId = `chn-fanout-${Date.now()}`;
    const left = await openScoutEventConsumer({
      connection,
      durableName: `fanout-left-${Date.now()}`,
      deliver: "all",
      conversationIds: [conversationId],
    });
    const right = await openScoutEventConsumer({
      connection,
      durableName: `fanout-right-${Date.now()}`,
      deliver: "all",
      conversationIds: [conversationId],
    });
    try {
      const message = messageRecord({ conversationId });
      await publish(message);

      // Both must see it, and one acking must not advance the other.
      const [leftEvents, rightEvents] = await Promise.all([
        takeEvents(left, 1, { ack: true }),
        takeEvents(right, 1, { ack: false }),
      ]);
      expect(leftEvents.map((d) => d.event.message.id)).toEqual([message.id]);
      expect(rightEvents.map((d) => d.event.message.id)).toEqual([message.id]);
      expect(left.name).not.toBe(right.name);

      const leftInfo = await left.info();
      expect(leftInfo.num_pending).toBe(0);
      expect(leftInfo.ack_floor.stream_seq).toBeGreaterThan(0);
    } finally {
      await left.destroy();
      await right.destroy();
    }
  }, 30_000);

  test("an offline durable consumer replays past a fetch batch boundary", async () => {
    const conversationId = `chn-replay-${Date.now()}`;
    const durableName = `replay-${Date.now()}`;
    // Registered, then offline before anything was published.
    const first = await openScoutEventConsumer({
      connection,
      durableName,
      deliver: "all",
      conversationIds: [conversationId],
    });
    await first.close();

    // More than one fetch batch, so replay cannot be an artifact of batch size.
    const total = 120;
    const ids: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const message = messageRecord({ conversationId, id: `msg-replay-${index}` });
      ids.push(message.id);
      await publish(message);
    }

    const resumed = await openScoutEventConsumer({
      connection,
      durableName,
      deliver: "all",
      conversationIds: [conversationId],
    });
    try {
      const events = await takeEvents(resumed, total, { timeoutMs: 25_000 });
      expect(events.length).toBe(total);
      expect(events.map((d) => d.event.message.id)).toEqual(ids);
    } finally {
      await resumed.destroy();
    }
  }, 60_000);

  test("an unacked delivery is redelivered with the same identity and deduped", async () => {
    const conversationId = `chn-redelivery-${Date.now()}`;
    const consumer = await openScoutEventConsumer({
      connection,
      durableName: `redelivery-${Date.now()}`,
      deliver: "all",
      conversationIds: [conversationId],
      ackWaitMs: 1_000,
      maxDeliver: 3,
    });
    try {
      const message = messageRecord({ conversationId });
      await publish(message);

      const dedupe = new ScoutStreamDeduplicator();
      const sideEffects: string[] = [];
      const deliveries: ScoutStreamDelivery[] = [];
      const controller = new AbortController();
      const iterator = consumer.events({ signal: controller.signal });
      const deadline = Date.now() + 15_000;
      while (deliveries.length < 2 && Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          iterator.next(),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 3_000);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!next || next.done) continue;
        deliveries.push(next.value);
        if (dedupe.admit(next.value.event.eventId)) sideEffects.push(next.value.event.eventId);
        // The first delivery is deliberately never acked: ack-wait must redeliver.
        if (deliveries.length >= 2) next.value.ack();
      }
      controller.abort();
      await iterator.return(undefined as never).catch(() => undefined);

      expect(deliveries.length).toBe(2);
      expect(deliveries[1]!.event.eventId).toBe(deliveries[0]!.event.eventId);
      expect(deliveries[1]!.streamSeq).toBe(deliveries[0]!.streamSeq);
      expect(deliveries[1]!.deliveryCount).toBeGreaterThan(deliveries[0]!.deliveryCount);
      // Redelivery is the transport's contract; suppressing the repeated side
      // effect is the consumer's.
      expect(sideEffects).toEqual([deliveries[0]!.event.eventId]);
    } finally {
      await consumer.destroy();
    }
  }, 40_000);

  test("a stable event id collapses a republish into one stream message", async () => {
    const conversationId = `chn-dedupe-${Date.now()}`;
    const message = messageRecord({ conversationId });
    const event = messagePostedStreamEvent({ message, publisherNodeId: NODE_ID });
    const subject = jetStreamSubject({
      prefix: harness.config.subjectPrefix,
      publisherNodeId: NODE_ID,
      kind: event.kind,
      conversationId,
    });
    const first = await connection.publishEvent(subject, event);
    const second = await connection.publishEvent(subject, event);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);
  }, 20_000);

  test("delivery-time authorization withholds events and honours revocation", async () => {
    const conversationId = `chn-authz-${Date.now()}`;
    let member = false;
    const consumer = await openScoutEventConsumer({
      connection,
      durableName: `authz-${Date.now()}`,
      deliver: "all",
      conversationIds: [conversationId],
      // Evaluated per event against current state, never encoded in the subject:
      // an event already sitting in the stream must not replay to a revoked member.
      authorize: () => member,
    });
    try {
      await publish(messageRecord({ conversationId, id: "msg-authz-denied" }));
      expect(await takeEvents(consumer, 1, { timeoutMs: 3_000 })).toEqual([]);

      member = true;
      await publish(messageRecord({ conversationId, id: "msg-authz-allowed" }));
      const allowed = await takeEvents(consumer, 1, { timeoutMs: 10_000 });
      expect(allowed.map((d) => d.event.message.id)).toEqual(["msg-authz-allowed"]);

      // Revoked again: the already-published event must stay withheld.
      member = false;
      await publish(messageRecord({ conversationId, id: "msg-authz-revoked" }));
      expect(await takeEvents(consumer, 1, { timeoutMs: 3_000 })).toEqual([]);
    } finally {
      await consumer.destroy();
    }
  }, 40_000);

  test("an explicitly empty selector is rejected instead of widening", async () => {
    await expect(openScoutEventConsumer({ connection, conversationIds: [] }))
      .rejects.toThrow(/empty list selects nothing/);
    await expect(openScoutEventConsumer({ connection, kinds: [] }))
      .rejects.toThrow(/empty list selects nothing/);
  }, 15_000);

  test("a stream this runtime did not create is refused, not rewritten", async () => {
    const foreign = await createIsolatedJetStreamHarness();
    const other = new ScoutJetStreamConnection({ config: foreign.config, name: "owner-test" });
    try {
      const jsm = await other.manager();
      await jsm.streams.add({
        name: foreign.config.streamName,
        subjects: [`${foreign.config.subjectPrefix}.>`],
        description: "someone else's stream",
      });
      await expect(other.ensureStream()).rejects.toThrow(JetStreamStreamOwnershipError);
      // Refused, not reconciled: the foreign description survives untouched.
      const info = await jsm.streams.info(foreign.config.streamName);
      expect(info.config.description).toBe("someone else's stream");
    } finally {
      await other.close();
      await foreign.dispose();
    }
  }, 40_000);
});

describe.skipIf(!hasNats)("jetstream journal publisher (real nats-server)", () => {
  let harness: IsolatedJetStreamHarness;

  beforeAll(async () => {
    harness = await createIsolatedJetStreamHarness();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  function journalRoot(): string {
    return mkdtempSync(join(tmpdir(), "openscout-jetstream-journal-"));
  }

  async function openJournal(root: string): Promise<FileBackedBrokerJournal> {
    const journal = new FileBackedBrokerJournal(join(root, "journal.log"));
    await journal.load();
    return journal;
  }

  function newPublisher(input: {
    journal: FileBackedBrokerJournal;
    progressPath: string;
    connection: ScoutJetStreamConnection;
    config?: JetStreamRuntimeConfig;
    startPosition?: "now" | "beginning";
  }): JetStreamJournalPublisher {
    return new JetStreamJournalPublisher({
      config: {
        ...(input.config ?? harness.config),
        progressPath: input.progressPath,
        startPosition: input.startPosition ?? "now",
        // Passes are driven explicitly so each assertion names its own cause;
        // the background interval is exercised by the unit suite.
        checkpointIntervalMs: 60_000,
      },
      connection: input.connection,
      journal: input.journal,
      publisherNodeId: NODE_ID,
    });
  }

  test("default start position publishes no history, then publishes new commits", async () => {
    const root = journalRoot();
    const journal = await openJournal(root);
    const connection = new ScoutJetStreamConnection({ config: harness.config, name: "pub-start" });
    const conversationId = `chn-start-${Date.now()}`;
    try {
      await connection.connect();
      await connection.ensureStream();
      // Pre-existing private history the operator never asked to export.
      await journal.appendEntries([entry(messageRecord({ conversationId, id: "msg-historical" }))]);

      const consumer = await openScoutEventConsumer({
        connection,
        durableName: `start-${Date.now()}`,
        deliver: "all",
        conversationIds: [conversationId],
      });
      const progressPath = join(root, "progress.json");
      const publisher = newPublisher({ journal, progressPath, connection });
      await publisher.establishStartBoundary();
      await publisher.start();

      const fresh = messageRecord({ conversationId, id: "msg-after-enable" });
      await journal.appendEntries([entry(fresh)]);
      publisher.notifyCommitted([entry(fresh)]);
      await publisher.checkpoint();

      const events = await takeEvents(consumer, 2, { timeoutMs: 8_000 });
      expect(events.map((d) => d.event.message.id)).toEqual(["msg-after-enable"]);
      // The live path and an overlapping catch-up pass may both publish the
      // same id; the duplicate window is what collapses them server-side, and
      // the consumer above is the proof that exactly one event exists.
      const snapshot = publisher.snapshot();
      expect(snapshot.publishedEvents - snapshot.duplicateEvents).toBe(1);

      await consumer.destroy();
      await publisher.stop();
    } finally {
      await connection.close();
      await journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("an explicit beginning start position publishes the existing range", async () => {
    const root = journalRoot();
    const journal = await openJournal(root);
    const connection = new ScoutJetStreamConnection({ config: harness.config, name: "pub-begin" });
    const conversationId = `chn-begin-${Date.now()}`;
    try {
      await connection.connect();
      await connection.ensureStream();
      const ids = ["msg-begin-a", "msg-begin-b", "msg-begin-c"];
      for (const id of ids) {
        await journal.appendEntries([entry(messageRecord({ conversationId, id }))]);
      }

      const consumer = await openScoutEventConsumer({
        connection,
        durableName: `begin-${Date.now()}`,
        deliver: "all",
        conversationIds: [conversationId],
      });
      const publisher = newPublisher({
        journal,
        progressPath: join(root, "progress.json"),
        connection,
        startPosition: "beginning",
      });
      await publisher.establishStartBoundary();
      await publisher.start();

      const events = await takeEvents(consumer, ids.length, { timeoutMs: 15_000 });
      expect(events.map((d) => d.event.message.id)).toEqual(ids);

      await consumer.destroy();
      await publisher.stop();
    } finally {
      await connection.close();
      await journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("no committed source event is lost while NATS is unavailable", async () => {
    const outage = await createIsolatedJetStreamHarness();
    const root = journalRoot();
    const journal = await openJournal(root);
    const connection = new ScoutJetStreamConnection({ config: outage.config, name: "pub-outage" });
    const conversationId = `chn-outage-${Date.now()}`;
    const progressPath = join(root, "progress.json");
    try {
      await connection.connect();
      await connection.ensureStream();
      const publisher = newPublisher({
        journal, progressPath, connection, config: outage.config,
      });
      await publisher.establishStartBoundary();
      await publisher.start();
      const enabledAt = readJetStreamPublisherProgress(progressPath);
      expect(enabledAt.kind).toBe("ok");

      // Transport down. Commits must still succeed: the journal is canonical and
      // an event transport is never allowed to become a write dependency.
      await outage.stopServer();
      const outageIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const message = messageRecord({ conversationId, id: `msg-outage-${index}` });
        outageIds.push(message.id);
        await journal.appendEntries([entry(message)]);
        publisher.notifyCommitted([entry(message)]);
      }
      await publisher.checkpoint();
      const stalled = publisher.snapshot();
      expect(stalled.state).toBe("degraded");
      expect(stalled.publishedEvents).toBe(0);
      // Progress must not advance past events that were never acked.
      const stalledProgress = readJetStreamPublisherProgress(progressPath);
      expect(stalledProgress.kind === "ok" && enabledAt.kind === "ok"
        && stalledProgress.progress.barrierId === enabledAt.progress.barrierId).toBe(true);
      await publisher.stop();
      await connection.close();

      await outage.startServer();
      const reconnected = new ScoutJetStreamConnection({
        config: outage.config, name: "pub-outage-2",
      });
      await reconnected.connect();
      await reconnected.ensureStream();
      const consumer = await openScoutEventConsumer({
        connection: reconnected,
        durableName: `outage-${Date.now()}`,
        deliver: "all",
        conversationIds: [conversationId],
      });

      const recovered = newPublisher({
        journal, progressPath, connection: reconnected, config: outage.config,
      });
      await recovered.start();

      const events = await takeEvents(consumer, outageIds.length, { timeoutMs: 20_000 });
      // Nothing lost, and journal order preserved within the conversation.
      expect(events.map((d) => d.event.message.id)).toEqual(outageIds);
      const advanced = readJetStreamPublisherProgress(progressPath);
      expect(advanced.kind === "ok" && stalledProgress.kind === "ok"
        && advanced.progress.barrierId !== stalledProgress.progress.barrierId).toBe(true);

      await consumer.destroy();
      await recovered.stop();
      await reconnected.close();
    } finally {
      await journal.close();
      rmSync(root, { recursive: true, force: true });
      await outage.dispose();
    }
  }, 90_000);

  test("a publisher that never learns of a commit still publishes it after restart", async () => {
    const root = journalRoot();
    const journal = await openJournal(root);
    const connection = new ScoutJetStreamConnection({ config: harness.config, name: "pub-crash" });
    const conversationId = `chn-crash-${Date.now()}`;
    const progressPath = join(root, "progress.json");
    try {
      await connection.connect();
      await connection.ensureStream();
      const publisher = newPublisher({ journal, progressPath, connection });
      await publisher.establishStartBoundary();
      await publisher.start();

      const consumer = await openScoutEventConsumer({
        connection,
        durableName: `crash-${Date.now()}`,
        deliver: "all",
        conversationIds: [conversationId],
      });

      // The crash boundary: the journal accepted the record, the publisher was
      // never notified, and the process ended before any checkpoint. Dropping
      // the publisher without stop() is the SIGKILL stand-in.
      await journal.appendEntries([entry(messageRecord({ conversationId, id: "msg-crash" }))]);

      const restarted = newPublisher({ journal, progressPath, connection });
      await restarted.start();

      const dedupe = new ScoutStreamDeduplicator();
      const events = await takeEvents(consumer, 1, { timeoutMs: 15_000 });
      const admitted = events.filter((d) => dedupe.admit(d.event.eventId));
      expect(admitted.map((d) => d.event.message.id)).toEqual(["msg-crash"]);

      await consumer.destroy();
      await restarted.stop();
    } finally {
      await connection.close();
      await journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("progress survives journal compaction rewriting every byte offset", async () => {
    const root = journalRoot();
    const journalPath = join(root, "journal.log");
    const connection = new ScoutJetStreamConnection({ config: harness.config, name: "pub-compact" });
    const conversationId = `chn-compact-${Date.now()}`;
    const progressPath = join(root, "progress.json");
    let journal = new FileBackedBrokerJournal(journalPath);
    try {
      await journal.load();
      await connection.connect();
      await connection.ensureStream();
      const publisher = newPublisher({ journal, progressPath, connection });
      await publisher.establishStartBoundary();
      await publisher.start();

      const consumer = await openScoutEventConsumer({
        connection,
        durableName: `compact-${Date.now()}`,
        deliver: "all",
        conversationIds: [conversationId],
      });

      const before = messageRecord({ conversationId, id: "msg-before-compaction" });
      await journal.appendEntries([entry(before)]);
      publisher.notifyCommitted([entry(before)]);
      await publisher.checkpoint();
      await publisher.stop();

      // Churn superseded registry records so compaction has something to
      // reclaim, then reopen with a policy that forces the rewrite.
      const churn: BrokerJournalEntry[] = [];
      for (let index = 0; index < 400; index += 1) {
        churn.push({
          kind: "node.upsert",
          node: {
            id: "node-churn",
            meshId: "mesh-test",
            name: `churn-${index}`,
            advertiseScope: "local",
            registeredAt: Date.now(),
            lastSeenAt: Date.now() + index,
          },
        });
      }
      await journal.appendEntries(churn);
      const sizeBefore = statSync(journalPath).size;
      await journal.close();

      journal = new FileBackedBrokerJournal(journalPath, {
        compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
      });
      const report = await journal.load();
      expect(report.compactionRequired).toBe(true);
      expect(statSync(journalPath).size).toBeLessThan(sizeBefore);

      // The committed barrier must still be locatable, and the record committed
      // after it must publish. A byte-offset cursor fails exactly here.
      const after = messageRecord({ conversationId, id: "msg-after-compaction" });
      await journal.appendEntries([entry(after)]);
      const resumed = newPublisher({ journal, progressPath, connection });
      await resumed.start();
      const snapshot = resumed.snapshot();
      expect(snapshot.state).toBe("live");
      expect(snapshot.failedPasses).toBe(0);

      const events = await takeEvents(consumer, 2, { timeoutMs: 20_000 });
      expect(events.map((d) => d.event.message.id))
        .toEqual(["msg-before-compaction", "msg-after-compaction"]);

      await consumer.destroy();
      await resumed.stop();
    } finally {
      await connection.close();
      await journal.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("ephemeral presence never reaches the stream", async () => {
    const root = journalRoot();
    const journal = await openJournal(root);
    const connection = new ScoutJetStreamConnection({ config: harness.config, name: "pub-presence" });
    try {
      await connection.connect();
      await connection.ensureStream();
      const publisher = newPublisher({
        journal, progressPath: join(root, "progress.json"), connection,
        startPosition: "beginning",
      });

      // Presence is ephemeral by construction and is not written to the journal
      // in normal operation. Forcing one in anyway proves the publisher's own
      // filter is the barrier, not merely upstream policy.
      expect(EPHEMERAL_CONTROL_EVENT_KINDS.has("presence.updated")).toBe(true);
      const presence = {
        id: "evt-presence",
        kind: "presence.updated",
        ts: Date.now(),
        actorId: "actor-1",
        payload: { actorId: "actor-1", state: "active" },
      } as unknown as ControlEvent;
      await journal.appendEntries([{ kind: "control.event.record", event: presence }]);

      await publisher.establishStartBoundary();
      await publisher.start();
      await publisher.checkpoint();
      expect(publisher.snapshot().publishedEvents).toBe(0);

      await publisher.stop();
    } finally {
      await connection.close();
      await journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("jetstream sidecar lifecycle", () => {
  test("a missing binary is one actionable error, with no restart loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-jetstream-missing-"));
    try {
      const config = resolveJetStreamConfig(
        { OPENSCOUT_JETSTREAM_HOME: root } as NodeJS.ProcessEnv,
        {
          enabled: true,
          serverBinary: join(root, "definitely-not-nats-server"),
          port: 45_999,
          monitorPort: 45_998,
        },
      );
      let spawns = 0;
      const sidecar = new NatsJetStreamSidecar({
        config,
        spawnProcess: ((): never => {
          spawns += 1;
          throw new Error("must not spawn");
        }) as never,
      });
      await expect(sidecar.start()).rejects.toThrow(JetStreamBinaryMissingError);
      expect(spawns).toBe(0);
      expect(sidecar.status().state).toBe("unavailable");
      // Repeating the attempt repeats the same actionable advice rather than
      // entering the respawn backoff.
      await expect(sidecar.start()).rejects.toThrow(/brew install nats-server/);
      await sidecar.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(!hasNats)("start and stop leave no listener and no pid file behind", async () => {
    const local = await createIsolatedJetStreamHarness();
    try {
      expect(await local.sidecar.healthy()).toBe(true);
      expect(existsSync(local.config.pidPath)).toBe(true);
      await local.stopServer();
      expect(await probeTcpPort(local.config.host, local.config.port)).toBe(false);
      expect(existsSync(local.config.pidPath)).toBe(false);
    } finally {
      await local.dispose();
    }
  }, 40_000);

  test.skipIf(!hasNats)("an occupied port is refused, never adopted", async () => {
    const occupied = await createIsolatedJetStreamHarness();
    try {
      // Stands in for the operator's own nats-server: same port, different
      // state. It must never be signalled, reconfigured, or restarted.
      const intruder = new NatsJetStreamSidecar({
        config: { ...occupied.config, pidPath: join(occupied.root, "intruder.pid") },
      });
      await expect(intruder.start()).rejects.toThrow(JetStreamPortOccupiedError);
      expect(await occupied.sidecar.healthy()).toBe(true);
    } finally {
      await occupied.dispose();
    }
  }, 40_000);
});
