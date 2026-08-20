import { describe, expect, test } from "bun:test";

import type {
  NodeDefinition,
  ThreadEventEnvelope,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore, normalizeBrokerJournalEntries } from "./broker-durable-store.js";

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

  test("commits journal entries before applying runtime and projection effects", async () => {
    const entry = nodeEntry("node-1");
    const publishedEvent = threadEvent("thread-event-1");
    const order: string[] = [];
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
});
