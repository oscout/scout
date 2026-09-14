import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createRuntimeRegistrySnapshot } from "./registry.js";
import { writeBrokerSnapshot } from "./broker-snapshot-response.js";
class Response extends EventEmitter {
  body = "";
  writes = 0;
  destroyed = false;
  writableEnded = false;
  stalled = false;
  writeHead() {}
  write(value: string) { this.writes++; this.body += value; return !this.stalled; }
  end() { this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}
const snapshot = () => createRuntimeRegistrySnapshot({messages: Object.fromEntries(
  Array.from({length: 80}, (_, i) => [`m-${i}`, {id: `m-${i}`, body: '"雪\\\n'.repeat(30), metadata: {nested: [1,null,true]}, conversationId: "c", actorId: "a", originNodeId: "n", class: "agent", visibility: "private", policy: "durable", createdAt: i}]),
)});
describe("bounded snapshot response", () => {
  test("preserves JSON shape, escaping and every historical record", async () => {
    const response = new Response(); const input = snapshot();
    await writeBrokerSnapshot(response, input, {chunkBytes: 1024});
    expect(JSON.parse(response.body)).toEqual(JSON.parse(JSON.stringify(input)));
    expect(response.writes).toBeGreaterThan(10);
    expect(response.writableEnded).toBe(true);
    expect(response.eventNames()).toEqual([]);
  });
  test("pauses serialization for a slow reader and resumes without duplicate records", async () => {
    const response = new Response(); response.stalled = true;
    const input = snapshot(); const writing = writeBrokerSnapshot(response, input, {chunkBytes:1024});
    await Bun.sleep(5);
    expect(response.writes).toBe(1);
    response.stalled = false; response.emit("drain"); await writing;
    expect(JSON.parse(response.body)).toEqual(JSON.parse(JSON.stringify(input)));
    expect(response.eventNames()).toEqual([]);
  });
  test("releases listeners when a stalled consumer disconnects", async () => {
    const response = new Response(); response.stalled = true;
    const writing = writeBrokerSnapshot(response, snapshot(), {chunkBytes:1024});
    await Bun.sleep(5); response.destroy(); await writing;
    expect(response.writes).toBe(1);
    expect(response.writableEnded).toBe(false);
    expect(response.eventNames()).toEqual([]);
  });
  test("closes a stalled consumer after its drain deadline", async () => {
    const response = new Response(); response.stalled = true;
    await writeBrokerSnapshot(response, snapshot(), {chunkBytes:1024,drainTimeoutMs:5});
    expect(response.destroyed).toBe(true);
    expect(response.writes).toBe(1);
    expect(response.eventNames()).toEqual([]);
  });
});
