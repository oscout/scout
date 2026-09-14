import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MessageRecord } from "@openscout/protocol";
import { BrokerMessageHistory } from "./broker-message-history.js";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerDurableRecordStore } from "./broker-durable-record-store.js";
import { filterMessageRecordsAsync, iterateMessageRecordsAsync, materializeMessageRecords, messageRecordCount, readMessageRecord, selectMessageRecordsAsync, withMessageCapture } from "./broker-message-records.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
const message = (id: string, createdAt = 1): MessageRecord => ({ id, createdAt, actorId: "a", conversationId: "c", originNodeId: "n", class: "agent", visibility: "workspace", policy: "durable", body: id });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function setup(records: MessageRecord[] = []) {
  const root = await mkdtemp(join(tmpdir(), "scout-async-history-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "broker.jsonl");
  await writeFile(path, records.map(message => JSON.stringify({ kind: "message.record", message }) + "\n").join(""));
  const history = await BrokerMessageHistory.create(path, { snapshotReaders: 2, coldReaders: 2 });
  const journal = new FileBackedBrokerJournal(path, { messageHistory: history });
  cleanup.push(() => journal.close());
  await journal.load();
  const runtime = createInMemoryControlRuntime(journal.snapshot(), { localNodeId: "n" });
  await runtime.upsertConversation({ id: "c", kind: "direct", title: "Test", visibility: "workspace", shareMode: "local", authorityNodeId: "n", participantIds: ["a"], metadata: {} });
  const durable = new BrokerDurableStore({ journal, projection: { async applyEntries() { return []; } }, threadEvents: { publish() {} } });
  history.setCaptureGate(durable.runWrite);
  const writer = new BrokerDurableRecordStore({ runtime, durableStore: durable, knownInvocations: new Map() });
  return { path, history, journal, runtime, writer };
}

test("journal and runtime share one complete history owner and preserve exact unusual IDs", async () => {
  const ids = ["z", "2", "10", "", "constructor", "nul\0id", "\ud800", "雪"];
  const { history, journal, runtime } = await setup(ids.map(id => message(id)));
  expect(runtime.peek().messages).toBe(history.records);
  expect(journal.snapshot().messages).toBe(history.records);
  expect(messageRecordCount(history.records)).toBe(ids.length);
  expect(() => Object.keys(history.records)).toThrow("paged enumeration");
  for (const id of ids) expect(await runtime.readMessage(id)).toEqual(message(id));
  expect(await runtime.readMessage("missing")).toBeUndefined();
  expect(Object.keys(await materializeMessageRecords(history.records))).toEqual(["2", "10", "z", "", "constructor", "nul\0id", "\ud800", "雪"]);
  const filtered = await filterMessageRecordsAsync(history.records, m => m.id === "z");
  expect(await readMessageRecord(filtered, "z")).toEqual(message("z"));
  expect(history.status().generations.captures).toBe(0);
});

test("indexed pages preserve complete production order and stable newest ties across more than one page", async () => {
  const records = Array.from({ length: 160 }, (_, i) => message(`m${i}`, (i * 31) % 23));
  const { history } = await setup(records);
  const actual: MessageRecord[] = [];
  for await (const value of iterateMessageRecordsAsync(history.records, { selection: { actorId: "a" } })) actual.push(value);
  expect(actual).toEqual(records);
  const compare = (a: MessageRecord, b: MessageRecord) => b.createdAt - a.createdAt;
  expect(await selectMessageRecordsAsync(history.records, 100, compare, () => true, { selection: { newestFirst: true } })).toEqual([...records].sort(compare).slice(0, 100));
  expect(await selectMessageRecordsAsync(Object.fromEntries(records.map(m => [m.id, m])), 5, compare, () => true, { selection: { newestFirst: true } })).toEqual([...records].sort(compare).slice(0, 5));
});

test("excess snapshots queue before capture, short reads proceed, and cancellation removes the waiter", async () => {
  const { history, journal } = await setup([message("old")]);
  const entered = [deferred(), deferred()], release = deferred();
  const active = entered.map((ready) => withMessageCapture(history.records, async captured => {
    ready.resolve(); await release.promise;
    expect(await readMessageRecord(captured, "new")).toBeUndefined();
  }, { stream: true }));
  await Promise.all(entered.map(r => r.promise));
  const abort = new AbortController();
  const cancelled = withMessageCapture(history.records, async () => { throw Error("cancelled waiter captured"); }, { stream: true, signal: abort.signal });
  const rejection = cancelled.then(() => null, error => error);
  const queued = withMessageCapture(history.records, async captured => {
    expect(await readMessageRecord(captured, "new")).toEqual(message("new"));
  }, { stream: true });
  await new Promise(r => setImmediate(r));
  expect(history.status().streams.waiting).toBe(2);
  expect(history.status().generations.captures).toBe(2);
  expect(await readMessageRecord(history.records, "old")).toEqual(message("old"));
  abort.abort(); expect(await rejection).toBeInstanceOf(Error);
  expect(history.status().streams.waiting).toBe(1);
  await journal.appendEntries([{ kind: "message.record", message: message("new") }]);
  release.resolve(); await Promise.all([...active, queued]);
  expect(history.status().streams.active).toBe(0);
  expect(history.status().generations.captures).toBe(0);
});

test("concurrent idempotent writes create one accepted message and conflicting retries cannot overwrite it", async () => {
  const { writer, history } = await setup();
  const input = { ...message("retry"), metadata: { clientMessageId: "client" } };
  const results = await Promise.all(Array.from({ length: 12 }, () => writer.recordMessage(input, { dedupeExisting: true })));
  expect(results.filter(r => !r.duplicate)).toHaveLength(1);
  expect(results.filter(r => r.duplicate)).toHaveLength(11);
  expect(messageRecordCount(history.records)).toBe(1);
  await expect(writer.recordMessage({ ...input, body: "conflict" }, { dedupeExisting: true })).rejects.toThrow("different record");
  expect(await readMessageRecord(history.records, "retry")).toEqual(input);
});

test("early iterator return and failed consumers release reader permits and captures", async () => {
  const { history } = await setup(Array.from({ length: 100 }, (_, i) => message(String(i))));
  for await (const value of iterateMessageRecordsAsync(history.records)) { expect(value.id).toBe("0"); break; }
  expect(history.status().reads.active).toBe(0);
  expect(history.status().generations.captures).toBe(0);
  await expect(withMessageCapture(history.records, async () => { throw Error("consumer failure"); }, { stream: true })).rejects.toThrow("consumer failure");
  expect(history.status().streams.active).toBe(0);
  expect(history.status().generations.captures).toBe(0);
});

test("abort releases a reader suspended at yield without waiting for another next call", async () => {
  const { history } = await setup([message("one"), message("two")]);
  const abort = new AbortController();
  const iterator = iterateMessageRecordsAsync(history.records, { signal: abort.signal });
  expect((await iterator.next()).value?.id).toBe("one");
  expect(history.status().generations.captures).toBe(1);
  abort.abort();
  await new Promise(r => setTimeout(r, 10));
  expect(history.status().generations.captures).toBe(0);
  expect(history.status().reads.active).toBe(0);
  await expect(iterator.next()).rejects.toThrow();
});

test("a failed suffix publication preserves accepted bytes and old captures, then catches up on retry", async () => {
  const { history, journal } = await setup([message("old")]);
  const manager = (history as any).generations;
  const leaf = manager.current.leaf;
  const scan = leaf.scan.bind(leaf);
  let fail = true;
  leaf.scan = async (...args: unknown[]) => { if (fail) { fail = false; throw Error("injected suffix publication failure"); } return scan(...args); };
  await withMessageCapture(history.records, async old => {
    await journal.appendEntries([{ kind: "message.record", message: message("accepted") }]);
    expect(history.status().lastError).not.toBeNull();
    expect(await readMessageRecord(old, "old")).toEqual(message("old"));
    expect(await readMessageRecord(old, "accepted")).toBeUndefined();
    expect(await readMessageRecord(history.records, "accepted")).toEqual(message("accepted"));
  }, { stream: true });
  await history.refresh();
  expect(messageRecordCount(history.records)).toBe(2);
  expect(history.status().lastError).toBeNull();
});

test("captured history survives actual canonical compaction and a new owner reconstructs it after restart", async () => {
  const { path, history, journal } = await setup([message("old"), message("2")]);
  await withMessageCapture(history.records, async old => {
    await journal.appendEntries([{ kind: "message.record", message: { ...message("old"), body: "replacement" } }]);
    const compactor = new FileBackedBrokerJournal(path, { compactionPolicy: { minimumReclaimBytes: 0, minimumReclaimRatio: 0 } });
    await compactor.load(); await compactor.close();
    await history.refresh();
    expect((await readMessageRecord(old, "old"))?.body).toBe("old");
    expect((await readMessageRecord(history.records, "old"))?.body).toBe("replacement");
  }, { stream: true });
  expect(history.status().generations.generations).toBe(1);
  await journal.close();
  const restarted = await BrokerMessageHistory.create(path);
  try { await restarted.refresh(); expect((await readMessageRecord(restarted.records, "old"))?.body).toBe("replacement"); expect(messageRecordCount(restarted.records)).toBe(2); }
  finally { await restarted.close(); }
});

test("reconciliation rejects live-endpoint candidates before opening historical message views", async () => {
  const { BrokerFlightLifecycleService } = await import("./broker-flight-lifecycle-service.js");
  const { history, runtime } = await setup([message("old")]);
  await runtime.upsertEndpoint({ id: "ep", agentId: "a", nodeId: "n", harness: "codex", transport: "local_socket", state: "active", metadata: {} } as any);
  const before = history.status().generations.released;
  const service = new BrokerFlightLifecycleService({
    runtime,
    journal: { async visitDeliveries(visit: any) { for (let i = 0; i < 100; i++) await visit({ id: `d${i}`, messageId: "old", targetKind: "agent", targetId: "a", status: "pending", transport: "local_socket" }); } },
    updateDeliveryStatus: async () => { throw Error("live endpoint must not reconcile"); },
    now: () => 1_000_000,
  } as any);
  await service.reconcileStaleLocalDeliveries();
  expect(history.status().generations.released).toBe(before);
});

test("disk snapshots keep the existing fixed UTF-8 transport buffer and full Unicode payloads", async () => {
  const { EventEmitter } = await import("node:events");
  const { writeBrokerSnapshot } = await import("./broker-snapshot-response.js");
  const input = [{ ...message("large"), body: '\u0000雪😀"\\\n'.repeat(50_000) }, message("small")];
  const { history, runtime } = await setup(input);
  const parts: Buffer[] = [];
  let maxBytes = 0;
  class Response extends EventEmitter {
    destroyed = false; writableEnded = false;
    writeHead() {}
    write(value: Uint8Array) {
      expect(value).toBeInstanceOf(Uint8Array);
      maxBytes = Math.max(maxBytes, value.byteLength); parts.push(Buffer.from(value));
      setImmediate(() => this.emit("drain")); return false;
    }
    end() { this.writableEnded = true; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const response = new Response();
  await withMessageCapture(history.records, async messages => {
    await writeBrokerSnapshot(response as any, { ...runtime.snapshot(), messages }, { encodedBodies: true, chunkBytes: 4096 });
  }, { stream: true });
  expect(maxBytes).toBeLessThanOrEqual(4096);
  expect(JSON.parse(Buffer.concat(parts).toString('utf8')).messages).toEqual(Object.fromEntries(input.map(m => [m.id, m])));
  expect(history.status().generations.captures).toBe(0);
  expect(response.eventNames()).toEqual([]);
});

test("encoded captures preserve old bytes and independent exact reads across append and release", async () => {
  const { iterateEncodedMessageRecordsAsync } = await import("./broker-message-records.js");
  const ids = ["z", "2", "", "nul\0id", "\ud800", ...Array.from({length: 140}, (_, i) => `row${i}`)];
  const { history, journal } = await setup(ids.map(id => message(id)));
  const expected = await materializeMessageRecords(history.records);
  await withMessageCapture(history.records, async old => {
    const mutable = await readMessageRecord(history.records, "z"); mutable!.body = "caller mutation";
    await journal.appendEntries([{kind:"message.record",message:{...message("z"),body:"replacement"}}]);
    const rows = [];
    for await (const encoded of iterateEncodedMessageRecordsAsync(old)) {
      expect(Object.isFrozen(encoded)).toBe(true);
      rows.push([encoded.id,JSON.parse(encoded.json)]);
    }
    expect(rows.map(row => row[0])).toEqual(Object.keys(expected));
    expect(Object.fromEntries(rows)).toEqual(expected);
    expect((await readMessageRecord(history.records,"z"))?.body).toBe("replacement");
  },{stream:true});
  const controller = new AbortController();
  const iterator = iterateEncodedMessageRecordsAsync(history.records,{signal:controller.signal})[Symbol.asyncIterator]();
  await iterator.next(); controller.abort(); await new Promise(r=>setTimeout(r,10));
  expect(history.status().generations.captures).toBe(0);
  await expect(iterator.next()).rejects.toThrow();
});

test("async encoded snapshot byte accounting follows transport drain with existing maintenance budgets", async () => {
  const { EventEmitter } = await import("node:events");
  const { writeBrokerSnapshot } = await import("./broker-snapshot-response.js");
  const { BrokerMemoryMaintenance } = await import("./broker-memory-maintenance.js");
  const input = [{...message("oversized"),body:"x".repeat(4_200_000),metadata:{large:"z".repeat(8192)}}];
  const { history,runtime } = await setup(input);
  let total = 0,charged = 0,collections = 0;
  const maintenance = new BrokerMemoryMaintenance({collect:()=>collections++});
  const parts: Buffer[] = [];
  let first!:()=>void; const stalled = new Promise<void>(r=>{first=r;});
  class Response extends EventEmitter {
    destroyed=false;writableEnded=false;blocked=true;
    writeHead() {}
    write(value:Uint8Array){parts.push(Buffer.from(value));total+=value.byteLength;if(this.blocked){first();return false;}return true;}
    end(){this.writableEnded=true;} destroy(){this.destroyed=true;this.emit("close");}
  }
  const response=new Response();
  const writing=withMessageCapture(history.records,async messages=>writeBrokerSnapshot(response as any,{...runtime.snapshot(),messages},{encodedBodies:true,onFlushedBytes:bytes=>{charged+=bytes;maintenance.snapshotEncoded(bytes);}}),{stream:true});
  await stalled;expect(charged).toBe(0);expect(collections).toBe(0);
  response.blocked=false;response.emit("drain");await writing;
  expect(charged).toBe(total);expect(collections).toBe(Math.floor(total/(2*1024*1024)));
  expect(JSON.parse(Buffer.concat(parts).toString()).messages.oversized).toEqual(input[0]);
  expect(history.status().generations.captures).toBe(0);
});

test("snapshot residency keeps encoded hot records only and message bodies out of the derived index", async () => {
  const { iterateEncodedMessageRecordsAsync } = await import("./broker-message-records.js");
  const { history, runtime, journal } = await setup(Array.from({length:500},(_,i)=>({...message(`record-${i}`),body:"x".repeat(2048)})));
  let count=0;for await(const row of iterateEncodedMessageRecordsAsync(history.records)) { expect(row.json.length).toBeGreaterThan(2048);count++; }
  expect(count).toBe(500);
  const leaf=(history as any).generations.current.leaf;
  expect(leaf.hot.size).toBe(0);
  expect(leaf.encodedHot.size).toBeLessThanOrEqual(16);
  expect(leaf.status().hotBytes).toBeLessThanOrEqual(64*1024);
  expect(leaf.db.query("SELECT COUNT(*) AS n FROM versions WHERE kind='message' AND payload IS NOT NULL").get().n).toBe(0);
  expect(runtime.peek().messages).toBe(journal.snapshot().messages);
  expect(history.status().generations.captures).toBe(0);
});

test("progressive registration does not build history, and failed fill cannot certify absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "scout-progressive-history-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "broker.jsonl");
  await writeFile(path, JSON.stringify({ kind: "message.record", message: message("old") }) + "\n");
  const history = await BrokerMessageHistory.create(path);
  const journal = new FileBackedBrokerJournal(path, { messageHistory: history, progressiveStartup: true });
  cleanup.push(() => journal.close());
  await journal.load();
  await journal.appendEntries([{ kind: "actor.upsert", actor: { id: "new", kind: "agent", displayName: "New" } }]);
  expect(journal.startupStatus().messageCount).toBeNull();
  expect(history.status().count).toBe(0);
  const refresh = history.refresh.bind(history);
  history.refresh = async () => { throw Error("injected index failure"); };
  await expect(journal.finishStartup()).rejects.toThrow("injected index failure");
  expect(journal.startupStatus()).toMatchObject({ phase: "failed", messageCount: null });
  history.refresh = refresh;
  // Recovery uses the unchanged accepted journal in a fresh owner.
  await journal.close();
  const recoveredHistory = await BrokerMessageHistory.create(path);
  const recovered = new FileBackedBrokerJournal(path, { messageHistory: recoveredHistory, progressiveStartup: true });
  cleanup.push(() => recovered.close());
  await recovered.load(); await recovered.finishStartup();
  expect(await readMessageRecord(recoveredHistory.records, "old")).toEqual(message("old"));
  expect(recovered.snapshot().actors["new"]?.displayName).toBe("New");
  expect(recovered.startupStatus().messageCount).toBe(1);
});
