import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrokerJournalEntry, FileBackedBrokerJournal } from "./broker-journal.ts";
import { RecoverableSQLiteProjection } from "./sqlite-projection.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createProjectionOptions(overrides: {
  busyOnFirstOpen?: boolean;
  failOnOpen?: Error;
  busyOnFirstEvent?: boolean;
  fatalOnFirstEvent?: boolean;
  busyOnFirstMessage?: boolean;
  disabled?: boolean;
  replayEntries?: BrokerJournalEntry[];
  replayYieldEvery?: number;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-projection-"));
  tempRoots.add(root);

  const stats = {
    createStoreCalls: 0,
    closeCalls: 0,
    recordEventCalls: 0,
    recordMessageCalls: 0,
    replayCalls: 0,
    replayOrder: [] as string[],
  };

  const busyError = new Error("SQLITE_BUSY: database is locked");
  const fatalError = new Error("database disk image is malformed");

  const store = {
    close(): void {
      stats.closeCalls += 1;
    },
    recordEvent(): void {
      stats.recordEventCalls += 1;
      if (overrides.fatalOnFirstEvent && stats.recordEventCalls === 1) {
        throw fatalError;
      }
      if (overrides.busyOnFirstEvent && stats.recordEventCalls === 1) {
        throw busyError;
      }
    },
    recordMessage(message: { id: string }): [] {
      stats.recordMessageCalls += 1;
      stats.replayOrder.push(`message:${message.id}`);
      if (overrides.busyOnFirstMessage && stats.recordMessageCalls === 1) {
        throw busyError;
      }
      return [];
    },
    listActivityItems(): [] {
      return [];
    },
    latestThreadSeq(): number {
      return 0;
    },
    oldestThreadSeq(): number {
      return 0;
    },
    listThreadEvents(): [] {
      return [];
    },
    getThreadSnapshot(): null {
      return null;
    },
    upsertNode(node: { id: string }): void {
      stats.replayOrder.push(`node:${node.id}`);
    },
    upsertActor(actor: { id: string }): void {
      stats.replayOrder.push(`actor:${actor.id}`);
    },
    upsertAgent(): void {},
    upsertEndpoint(): void {},
    upsertConversation(conversation: { id: string }): void {
      stats.replayOrder.push(`conversation:${conversation.id}`);
    },
    upsertBinding(): void {},
    recordInvocation(): void {},
    recordFlight(): void {},
    recordCollaborationRecord(): void {},
    recordCollaborationEvent(): void {},
    recordDeliveries(): void {},
    recordDeliveryAttempt(): void {},
    updateDeliveryStatus(): void {},
    recordScoutDispatch(): void {},
  };

  const journal = {
    replay: async (visitor: (entry: BrokerJournalEntry) => void | Promise<void>): Promise<void> => {
      stats.replayCalls += 1;
      for (const entry of overrides.replayEntries ?? []) {
        await visitor(entry);
      }
    },
  } as unknown as FileBackedBrokerJournal;

  return {
    stats,
    projection: new RecoverableSQLiteProjection(
      join(root, "projection.sqlite"),
      journal,
      {
        disabled: overrides.disabled,
        replayYieldEvery: overrides.replayYieldEvery,
        createStore: () => {
          stats.createStoreCalls += 1;
          if (overrides.failOnOpen) {
            throw overrides.failOnOpen;
          }
          if (overrides.busyOnFirstOpen && stats.createStoreCalls === 1) {
            throw busyError;
          }
          return store as never;
        },
      },
    ),
  };
}

function sampleMessageEntry(): BrokerJournalEntry {
  return {
    kind: "message.record",
    message: {
      id: "msg-1",
      conversationId: "conv-1",
      actorId: "actor-1",
      originNodeId: "node-1",
      class: "agent",
      body: "hello",
      visibility: "private",
      policy: "durable",
      createdAt: 1_700_000_000_000,
    },
  };
}

describe("RecoverableSQLiteProjection", () => {
  test("reports ready after opening the projection store", async () => {
    const { projection } = createProjectionOptions();

    expect(projection.statusSnapshot()).toEqual({
      state: "degraded",
      detail: "SQLite projection is not ready.",
    });

    projection.warm();
    await projection.flush();

    expect(projection.statusSnapshot()).toEqual({ state: "ready", detail: null });
  });

  test("streams two replay passes and prepares FK parents before child records", async () => {
    const message = sampleMessageEntry();
    const { projection, stats } = createProjectionOptions({ replayEntries: [message] });

    projection.warm();
    await projection.flush();

    expect(stats.replayCalls).toBe(2);
    expect(stats.replayOrder).toEqual([
      "node:node-1",
      "actor:actor-1",
      "conversation:conv-1",
      "message:msg-1",
    ]);
  });

  test("yields to the event loop between replay batches", async () => {
    const { projection } = createProjectionOptions({
      replayEntries: [sampleMessageEntry()],
      replayYieldEvery: 1,
    });
    let eventLoopTurnReached = false;
    const marker = setImmediate(() => {
      eventLoopTurnReached = true;
    });

    projection.warm();
    await projection.flush();
    clearImmediate(marker);

    expect(eventLoopTurnReached).toBe(true);
  });

  test("reports the projection failure when opening degrades", async () => {
    const failure = new Error("schema v15 is newer than this build's v14");
    const { projection } = createProjectionOptions({ failOnOpen: failure });

    projection.warm();
    await projection.flush();

    expect(projection.statusSnapshot()).toEqual({
      state: "degraded",
      detail: failure.message,
    });
  });

  test("reports disabled without opening the projection store", async () => {
    const { projection, stats } = createProjectionOptions({ disabled: true });

    projection.warm();
    await projection.flush();

    expect(projection.statusSnapshot()).toEqual({
      state: "disabled",
      detail: "SQLite projection is disabled by configuration.",
    });
    expect(stats.createStoreCalls).toBe(0);
  });

  test("does not invalidate the store when opening the projection hits SQLITE_BUSY", async () => {
    const { projection, stats } = createProjectionOptions({ busyOnFirstOpen: true });

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-1",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-2",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    expect(stats.createStoreCalls).toBe(2);
    expect(stats.closeCalls).toBe(0);
    expect(stats.recordEventCalls).toBe(1);
  });

  test("preserves the projection store when SQLite reports busy contention", async () => {
    const { projection, stats } = createProjectionOptions({ busyOnFirstEvent: true });

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-1",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-2",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    expect(stats.createStoreCalls).toBe(1);
    expect(stats.closeCalls).toBe(0);
    expect(stats.recordEventCalls).toBe(2);
  });

  test("still invalidates the projection store on malformed database errors", async () => {
    const { projection, stats } = createProjectionOptions({ fatalOnFirstEvent: true });

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-1",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-2",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    expect(stats.createStoreCalls).toBe(2);
    expect(stats.closeCalls).toBe(1);
    expect(stats.recordEventCalls).toBe(2);
  });

  test("keeps a busy batch replay from poisoning later projection calls", async () => {
    const { projection, stats } = createProjectionOptions({ busyOnFirstMessage: true });

    await projection.applyEntries(sampleMessageEntry());
    await projection.applyEntries(sampleMessageEntry());

    expect(stats.createStoreCalls).toBe(1);
    expect(stats.closeCalls).toBe(0);
    expect(stats.recordMessageCalls).toBe(2);
  });
});
