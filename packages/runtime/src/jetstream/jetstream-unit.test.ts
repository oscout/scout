import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageRecord } from "@openscout/protocol";

import type { BrokerJournalEntry, BrokerJournalReplayBarrier, BrokerJournalReplayBoundary } from "../broker-journal.js";
import { assertLoopbackJetStreamHost, resolveJetStreamConfig } from "./config.js";
import { ScoutStreamDeduplicator } from "./consumer.js";
import {
  decodeScoutStreamEvent,
  encodeScoutStreamEvent,
  jetStreamFilterSubject,
  jetStreamSubject,
  jetStreamToken,
  messagePostedStreamEvent,
  scoutStreamEventId,
} from "./events.js";
import {
  JetStreamJournalPublisher,
  isPublishableEntry,
  readJetStreamPublisherProgress,
} from "./publisher.js";
import { resolveNatsServerBinary } from "./sidecar.js";

function messageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "chn-1",
    actorId: "actor-1",
    originNodeId: "node-1",
    body: "hello",
    createdAt: 1_700_000_000_000,
    class: "agent",
    visibility: "private",
    policy: "durable",
    ...overrides,
  } as MessageRecord;
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "openscout-jetstream-unit-"));
}

describe("jetstream config", () => {
  test("is opt-in and loopback only", () => {
    const root = temporaryRoot();
    try {
      const config = resolveJetStreamConfig({ OPENSCOUT_JETSTREAM_HOME: root } as NodeJS.ProcessEnv);
      expect(config.enabled).toBe(false);
      expect(config.host).toBe("127.0.0.1");
      expect(config.startPosition).toBe("now");
      expect(config.storeDirectory.startsWith(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a non-loopback bind", () => {
    expect(() => assertLoopbackJetStreamHost("0.0.0.0")).toThrow(/non-loopback/);
    expect(() => assertLoopbackJetStreamHost("192.168.1.10")).toThrow(/non-loopback/);
    // IPv6 loopback is out of scope for this slice rather than silently accepted.
    expect(() => assertLoopbackJetStreamHost("::1")).toThrow(/non-loopback/);
    expect(assertLoopbackJetStreamHost("localhost")).toBe("127.0.0.1");
  });

  test("rejects a duplicate window narrower than the checkpoint interval", () => {
    expect(() => resolveJetStreamConfig({} as NodeJS.ProcessEnv, {
      checkpointIntervalMs: 60_000,
      duplicateWindowMs: 30_000,
    })).toThrow(/duplicate window/);
  });
});

describe("stream event identity and subjects", () => {
  test("event id is derived from the record, not the attempt", () => {
    const first = messagePostedStreamEvent({ message: messageRecord(), publisherNodeId: "node-1" });
    const second = messagePostedStreamEvent({ message: messageRecord(), publisherNodeId: "node-1" });
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).toBe(scoutStreamEventId("message.posted", "msg-1"));
  });

  test("never carries the message body", () => {
    const event = messagePostedStreamEvent({
      message: messageRecord({ body: "a private sentence" }),
      publisherNodeId: "node-1",
    });
    const encoded = new TextDecoder().decode(encodeScoutStreamEvent(event));
    expect(encoded).not.toContain("a private sentence");
    expect(Object.keys(event.message)).not.toContain("body");
  });

  test("preserves source identity and authority separately", () => {
    const event = messagePostedStreamEvent({
      message: messageRecord({ originNodeId: "node-origin" }),
      publisherNodeId: "node-publisher",
    });
    expect(event.originNodeId).toBe("node-origin");
    expect(event.publisherNodeId).toBe("node-publisher");
  });

  test("tokenises ids that are not valid NATS subject tokens", () => {
    expect(jetStreamToken("chn-abc_123")).toBe("chn-abc_123");
    expect(jetStreamToken("a.b")).toMatch(/^h[0-9a-f]{32}$/);
    expect(jetStreamToken("a.b")).toBe(jetStreamToken("a.b"));
    expect(jetStreamToken("with space")).not.toContain(" ");
  });

  test("a publisher subject matches its own conversation filter", () => {
    const subject = jetStreamSubject({
      publisherNodeId: "node-1",
      kind: "message.posted",
      conversationId: "chn-1",
    });
    expect(subject).toBe("scout.v1.node-1.message_posted.chn-1");
    expect(jetStreamFilterSubject({ kind: "message.posted", conversationId: "chn-1" }))
      .toBe("scout.v1.*.message_posted.chn-1");
    // An omitted dimension is a wildcard; only an *explicitly empty* selector is an error.
    expect(jetStreamFilterSubject({ conversationId: "chn-1" }))
      .toBe("scout.v1.*.*.chn-1");
  });

  test("decode rejects anything that is not a v1 event", () => {
    expect(decodeScoutStreamEvent("not json")).toBeNull();
    expect(decodeScoutStreamEvent(JSON.stringify({ v: 2, kind: "message.posted" }))).toBeNull();
    expect(decodeScoutStreamEvent(JSON.stringify({ v: 1, kind: "other.kind" }))).toBeNull();
    const valid = messagePostedStreamEvent({ message: messageRecord(), publisherNodeId: "n" });
    expect(decodeScoutStreamEvent(encodeScoutStreamEvent(valid))?.eventId).toBe(valid.eventId);
  });
});

describe("publishable entries", () => {
  test("only canonical message records qualify", () => {
    expect(isPublishableEntry({ kind: "message.record", message: messageRecord() })).toBe(true);
    expect(isPublishableEntry({
      kind: "control.event.record",
      event: { id: "evt", kind: "presence.updated", ts: 1, actorId: "a", payload: {} as never },
    } as BrokerJournalEntry)).toBe(false);
    expect(isPublishableEntry({
      kind: "conversation.read_cursor.upsert",
      cursor: {} as never,
    } as BrokerJournalEntry)).toBe(false);
  });
});

describe("publisher progress", () => {
  test("absent, invalid and valid are three different answers", () => {
    const root = temporaryRoot();
    try {
      const path = join(root, "progress.json");
      expect(readJetStreamPublisherProgress(path).kind).toBe("absent");

      writeFileSync(path, "{ not json", "utf8");
      expect(readJetStreamPublisherProgress(path).kind).toBe("invalid");

      writeFileSync(path, JSON.stringify({
        version: 1,
        projectionId: "jetstream-publisher",
        projectionVersion: 999,
        barrierId: "b",
        updatedAt: 1,
      }), "utf8");
      const mismatched = readJetStreamPublisherProgress(path);
      expect(mismatched.kind).toBe("invalid");

      writeFileSync(path, JSON.stringify({
        version: 1,
        projectionId: "jetstream-publisher",
        projectionVersion: 1,
        barrierId: "barrier-1",
        updatedAt: 1,
      }), "utf8");
      const ok = readJetStreamPublisherProgress(path);
      expect(ok.kind).toBe("ok");
      expect(ok.kind === "ok" && ok.progress.barrierId).toBe("barrier-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a corrupt progress file blocks every publishing path", async () => {
    const root = temporaryRoot();
    try {
      const progressPath = join(root, "progress.json");
      writeFileSync(progressPath, "{{{", "utf8");
      const before = Bun.file(progressPath).size;

      const published: string[] = [];
      const barriers: BrokerJournalReplayBarrier[] = [];
      const publisher = new JetStreamJournalPublisher({
        config: resolveJetStreamConfig({} as NodeJS.ProcessEnv, {
          enabled: true,
          progressPath,
          checkpointIntervalMs: 1_000,
          duplicateWindowMs: 60_000,
        }),
        connection: {
          publishEvent: async (subject: string) => {
            published.push(subject);
            return { seq: 1, duplicate: false, attempts: 1 };
          },
        } as never,
        journal: {
          captureReplayBoundary: async (options?: { barrier?: BrokerJournalReplayBarrier }) => {
            if (options?.barrier) barriers.push(options.barrier);
            return { endByteExclusive: 0 } satisfies BrokerJournalReplayBoundary;
          },
          replay: async (visitor) => {
            await visitor({ kind: "message.record", message: messageRecord() });
            return { afterBarrierFound: true, visitedEntries: 1 };
          },
        },
        publisherNodeId: "node-1",
      });

      await publisher.start();
      expect(publisher.snapshot().blocked).toBe(true);
      expect(publisher.snapshot().state).toBe("degraded");

      // Every downstream path must stay closed, including shutdown's final pass.
      publisher.notifyCommitted([{ kind: "message.record", message: messageRecord() }]);
      await publisher.checkpoint();
      await publisher.stop();

      expect(published).toEqual([]);
      expect(barriers).toEqual([]);
      expect(Bun.file(progressPath).size).toBe(before);
      expect(await Bun.file(progressPath).text()).toBe("{{{");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a first-enable `now` boundary is committed without publishing history", async () => {
    const root = temporaryRoot();
    try {
      const progressPath = join(root, "progress.json");
      const published: string[] = [];
      let replays = 0;
      const publisher = new JetStreamJournalPublisher({
        config: resolveJetStreamConfig({} as NodeJS.ProcessEnv, {
          enabled: true,
          progressPath,
          startPosition: "now",
          checkpointIntervalMs: 1_000,
          duplicateWindowMs: 60_000,
        }),
        connection: {
          publishEvent: async (subject: string) => {
            published.push(subject);
            return { seq: 1, duplicate: false, attempts: 1 };
          },
        } as never,
        journal: {
          captureReplayBoundary: async () => ({ endByteExclusive: 0 }),
          replay: async (visitor) => {
            replays += 1;
            await visitor({ kind: "message.record", message: messageRecord() });
            return { afterBarrierFound: true, visitedEntries: 1 };
          },
        },
        publisherNodeId: "node-1",
      });

      await publisher.establishStartBoundary();
      expect(published).toEqual([]);
      expect(replays).toBe(0);
      const progress = readJetStreamPublisherProgress(progressPath);
      expect(progress.kind).toBe("ok");
      await publisher.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("consumer-side suppression", () => {
  test("admits an id once and evicts at capacity", () => {
    const dedupe = new ScoutStreamDeduplicator(2);
    expect(dedupe.admit("a")).toBe(true);
    expect(dedupe.admit("a")).toBe(false);
    expect(dedupe.admit("b")).toBe(true);
    expect(dedupe.admit("c")).toBe(true);
    expect(dedupe.size).toBe(2);
    // "a" was evicted: bounded suppression, not durable idempotency.
    expect(dedupe.admit("a")).toBe(true);
  });
});

describe("binary resolution", () => {
  test("an absolute path that does not exist resolves to null", () => {
    expect(resolveNatsServerBinary("/definitely/not/here/nats-server")).toBeNull();
  });
});
