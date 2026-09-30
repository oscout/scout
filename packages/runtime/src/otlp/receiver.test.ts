import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { decodeOtlpRequest, encodeOtlpResponse } from "./codec.js";
import { otlpPaths, resolveOtlpLimits, resolveOtlpPort } from "./config.js";
import { startOtlpReceiver } from "./receiver.js";
import { sanitizeOtlpRequest, type OtlpSignal } from "./sanitize.js";
import { otlpSchema } from "./schema.generated.js";
import { OtlpObservationStore } from "./store.js";
import { parseOtlpArguments } from "./standalone.js";
import { startBrokerOtlpReceiver } from "./broker-lifecycle.js";
import { openRuntimeSqliteDatabase } from "../sqlite-adapter.js";

const root = protobuf.Root.fromJSON(otlpSchema).resolveAll();
const names = { traces: ["trace", "Trace"], logs: ["logs", "Logs"], metrics: ["metrics", "Metrics"] } as const;
const rejectedFields = { traces: "rejectedSpans", logs: "rejectedLogRecords", metrics: "rejectedDataPoints" } as const;
const directories: string[] = [];
const servers: Awaited<ReturnType<typeof startOtlpReceiver>>[] = [];
const secret = "PRIVATE CONTENT SENTINEL";
const attribute = (key: string, stringValue: string) => ({ key, value: { stringValue } });
const synthetic = (signal: OtlpSignal, count = 1, service = "synthetic-agent") => {
  const resource = { attributes: [attribute("service.name", service), attribute("session.id", "test-session"), attribute("user.email", secret)] };
  const attributes = [attribute("session.id", "test-session"), attribute("gen_ai.prompt", secret)];
  const items = Array.from({ length: count }, () => ({
    attributes, timeUnixNano: "1789872335795123456", startTimeUnixNano: "1789872335700000000",
    endTimeUnixNano: "1789872335895123456", asInt: "9007199254740993",
    body: { stringValue: secret }, name: secret, status: { code: 2, message: secret },
  }));
  if (signal === "traces") return { resourceSpans: [{ resource, scopeSpans: [{ spans: items }] }] };
  if (signal === "logs") return { resourceLogs: [{ resource, scopeLogs: [{ logRecords: items }] }] };
  return { resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [{ name: "tokens", sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: items } }] }] }] };
};
function type(signal: OtlpSignal, direction: "Request" | "Response") {
  const [namespace, name] = names[signal];
  return root.lookupType(`opentelemetry.proto.collector.${namespace}.v1.Export${name}Service${direction}`);
}
function directory() {
  const path = mkdtempSync(join(tmpdir(), "scout-otlp-test-"));
  directories.push(path);
  return path;
}
async function start(limits: Parameters<typeof startOtlpReceiver>[0]["limits"] = {}) {
  const receiver = await startOtlpReceiver({ databasePath: join(directory(), "observations.sqlite"), port: 0, limits });
  servers.push(receiver);
  return receiver;
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function jsonPost(server: { url: string }, signal: OtlpSignal, data: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(otlpPaths[signal], server.url), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
}

describe("OTLP wire codec", () => {
  for (const signal of ["traces", "logs", "metrics"] as const) {
    test(`${signal}: synthetic JSON/protobuf equivalence and response counts`, () => {
      const value = synthetic(signal);
      const json = decodeOtlpRequest(signal, Buffer.from(JSON.stringify(value)), "application/json", 32);
      const binary = decodeOtlpRequest(signal, type(signal, "Request").encode(type(signal, "Request").fromObject(value)).finish(), "application/x-protobuf", 32);
      expect(json).toEqual(binary);
      const result = type(signal, "Response").toObject(type(signal, "Response").decode(encodeOtlpResponse(signal, "application/x-protobuf", 7)), { longs: String });
      expect(result).toEqual({ partialSuccess: { [rejectedFields[signal]]: "7" } });
      expect(JSON.parse(Buffer.from(encodeOtlpResponse(signal, "application/json", 7)).toString())).toEqual(result);
      expect(encodeOtlpResponse(signal, "application/x-protobuf", 0).length).toBe(0);
      expect(decodeOtlpRequest(signal, Buffer.from("{}"), "application/json", 32)).toEqual({});
    });
  }
  test("OTLP hex IDs are not protobuf JSON base64", () => {
    const ids = { traceId: "ABCDEF0123456789ABCDEF0123456789", spanId: "ABCDEF0123456789" };
    const value = { resourceSpans: [{ scopeSpans: [{ spans: [ids] }] }] };
    const decoded = decodeOtlpRequest("traces", Buffer.from(JSON.stringify(value)), "application/json", 32);
    const span = (decoded as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe(ids.traceId.toLowerCase());
    expect(span.spanId).toBe(ids.spanId.toLowerCase());
  });
  test("ignores unknown fields but rejects malformed known fields, oneofs and enum names", () => {
    expect(decodeOtlpRequest("logs", Buffer.from('{"future":42}'), "application/json", 32)).toEqual({});
    for (const value of [[], { resourceLogs: "wrong" }, { resourceLogs: [null] }, { resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityNumber: "INFO" }] }] }] }, { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "x", intValue: "1" } }] }] }] }]) {
      expect(() => decodeOtlpRequest("logs", Buffer.from(JSON.stringify(value)), "application/json", 32)).toThrow();
    }
    for (const bytes of [[0], [10, 100, 1], [11], [255, 255]]) expect(() => decodeOtlpRequest("logs", new Uint8Array(bytes), "application/x-protobuf", 32)).toThrow();
  });
  test("caps known recursive AnyValue depth before decoding", () => {
    let body: unknown = { stringValue: "deep" };
    for (let i = 0; i < 40; i++) body = { arrayValue: { values: [body] } };
    const value = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body }] }] }] };
    expect(() => decodeOtlpRequest("logs", Buffer.from(JSON.stringify(value)), "application/json", 32)).toThrow();
    const bytes = type("logs", "Request").encode(type("logs", "Request").fromObject(value)).finish();
    expect(() => decodeOtlpRequest("logs", bytes, "application/x-protobuf", 32)).toThrow();
  });
});

describe("OTLP receiver", () => {
  for (const signal of ["traces", "logs", "metrics"] as const) {
    for (const encoding of ["application/json", "application/x-protobuf"] as const) {
      test(`${signal}: ${encoding}, gzip, inspection only`, async () => {
        const server = await start();
        const input = synthetic(signal);
        const body = encoding === "application/json" ? Buffer.from(JSON.stringify(input)) : type(signal, "Request").encode(type(signal, "Request").fromObject(input)).finish();
        const response = await fetch(new URL(otlpPaths[signal], server.url), { method: "POST", headers: { "Content-Type": encoding, "Content-Encoding": "gzip" }, body: gzipSync(body) });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(encoding);
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(encoding === "application/json" ? JSON.parse(Buffer.from(bytes).toString()) : type(signal, "Response").toObject(type(signal, "Response").decode(bytes))).toEqual({});
        await server.flush();
        const records = await (await fetch(new URL(otlpPaths.observations, server.url))).json() as any[];
        expect(records.length).toBe(1);
        expect(records[0].signal).toBe(signal);
        expect(JSON.stringify(records)).not.toContain(secret);
        if (signal === "metrics") expect(records[0].data.asInt).toBe("9007199254740993");
        else expect(records[0].data[signal === "traces" ? "startTimeUnixNano" : "timeUnixNano"]).toBe(signal === "traces" ? "1789872335700000000" : "1789872335795123456");
        const status = await (await fetch(new URL(otlpPaths.health, server.url))).json() as any;
        expect(status.mode).toBe("inspection-only");
        expect(status.accepted[signal]).toBe(1);
        expect(status.store.rows).toBe(1);
      });
    }
    test(`${signal}: counts all original items in partial success`, async () => {
      const server = await start({ maxQueueItems: 1, maxItems: 2, flushIntervalMs: 60_000 });
      const response = await jsonPost(server, signal, synthetic(signal, 4));
      expect(await response.json()).toEqual({ partialSuccess: { [rejectedFields[signal]]: "3" } });
      expect(server.status().accepted[signal]).toBe(1);
      await server.flush();
      expect(server.status().store.rows).toBe(1);
    });
  }
  test("per-resource admission leaves room for another emitter and never evicts accepted entries", async () => {
    const server = await start({ maxResourceQueueItems: 1, maxQueueItems: 3, flushIntervalMs: 60_000 });
    expect(await (await jsonPost(server, "logs", synthetic("logs", 2, "a"))).json()).toEqual({ partialSuccess: { rejectedLogRecords: "1" } });
    expect(await (await jsonPost(server, "logs", synthetic("logs", 1, "b"))).json()).toEqual({});
    expect(server.status().queue.items).toBe(2);
    await server.flush();
    const rows = await (await fetch(new URL(otlpPaths.observations, server.url))).json() as any[];
    expect(rows.map((r) => r.resource["service.name"])).toEqual(["a", "b"]);
  });
  test("rejects byte-full queue, invalid transport, malformed bodies and forbidden browser origins/hosts", async () => {
    const server = await start({ maxQueueBytes: 1 });
    expect(await (await jsonPost(server, "logs", synthetic("logs"))).json()).toEqual({ partialSuccess: { rejectedLogRecords: "1" } });
    expect((await jsonPost(server, "logs", {}, { Origin: "https://untrusted.invalid" })).status).toBe(403);
    expect((await jsonPost(server, "logs", {}, { Host: "localhost.evil.invalid" })).status).toBe(403);
    expect((await jsonPost(server, "logs", {}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await jsonPost(server, "logs", {}, { "Content-Encoding": "br" })).status).toBe(415);
    expect((await jsonPost(server, "logs", [])).status).toBe(400);
    expect((await fetch(new URL(otlpPaths.logs, server.url))).status).toBe(405);
    expect((await fetch(new URL("/not-a-route", server.url))).status).toBe(404);
    expect((await fetch(new URL(otlpPaths.health, server.url), { headers: { Origin: "null" } })).status).toBe(403);
  });
  test("caps wire bytes and gzip decompressed bytes", async () => {
    const server = await start({ maxWireBytes: 100, maxDecodedBytes: 200 });
    expect((await jsonPost(server, "logs", { ignored: "x".repeat(200) })).status).toBe(413);
    const response = await fetch(new URL(otlpPaths.logs, server.url), { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: gzipSync(Buffer.from(JSON.stringify({ ignored: "x".repeat(5000) }))) });
    expect(response.status).toBe(413);
  });
  test("body deadline releases concurrency; overload is not falsely acknowledged", async () => {
    const server = await start({ maxConcurrentRequests: 1, requestTimeoutMs: 250 });
    const request = await partialPost(server.url, otlpPaths.logs);
    const pending = new Promise<number>((resolve, reject) => {
      let head = "";
      request.on("data", (chunk) => {
        head += chunk.toString("latin1");
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
        if (status) resolve(Number(status[1]));
      });
      request.on("error", reject);
    });
    for (let i = 0; i < 1000 && server.status().inFlightRequests === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(server.status().inFlightRequests).toBe(1);
    expect((await jsonPost(server, "logs", {})).status).toBe(503);
    expect(await pending).toBe(408);
    expect((await jsonPost(server, "logs", {})).status).toBe(200);
  });
  test("client disconnect releases a body slot without an unhandled request error", async () => {
    const server = await start({ maxConcurrentRequests: 1 });
    const request = await partialPost(server.url, otlpPaths.logs);
    request.on("error", () => undefined);
    for (let i = 0; i < 1000 && server.status().inFlightRequests === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(server.status().inFlightRequests).toBe(1);
    request.destroy();
    for (let i = 0; i < 1000 && server.status().inFlightRequests !== 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(server.status().inFlightRequests).toBe(0);
    expect((await jsonPost(server, "logs", {})).status).toBe(200);
  });
  test("histogram rejection counts data points rather than metric containers", async () => {
    const server = await start({ maxQueueItems: 1, flushIntervalMs: 60_000 });
    const body = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "latency", histogram: { dataPoints: [{ count: "3" }, { count: "4" }] } }] }] }] };
    expect(await (await jsonPost(server, "metrics", body)).json()).toEqual({ partialSuccess: { rejectedDataPoints: "1" } });
  });
  test("persistence failures are observable and not retried endlessly", async () => {
    const server = await start({ flushIntervalMs: 60_000 });
    const mock = spyOn(OtlpObservationStore.prototype, "append").mockImplementation(() => { throw new Error(secret); });
    try {
      await jsonPost(server, "logs", synthetic("logs"));
      await server.flush();
      expect(server.status().persistenceFailures).toBe(1);
      expect(server.status().persistenceLost).toBe(1);
      expect(server.status().queue.items).toBe(0);
      expect(JSON.stringify(server.status())).not.toContain(secret);
    } finally { mock.mockRestore(); }
  });
  test("close drains accepted records and is idempotent; occupied port leaves no DB lock", async () => {
    const path = join(directory(), "close.sqlite");
    const server = await startOtlpReceiver({ databasePath: path, port: 0, limits: { flushIntervalMs: 60_000 } });
    servers.push(server);
    const port = Number(new URL(server.url).port);
    const failedPath = join(directory(), "failed.sqlite");
    await expect(startOtlpReceiver({ databasePath: failedPath, port })).rejects.toThrow();
    const reopenFailed = new OtlpObservationStore(failedPath, resolveOtlpLimits());
    reopenFailed.close();
    await jsonPost(server, "logs", synthetic("logs"));
    await server.close();
    await server.close();
    const reopened = new OtlpObservationStore(path, resolveOtlpLimits());
    try { expect(reopened.recent().length).toBe(1); } finally { reopened.close(); }
  });
});

describe("OTLP retention and lifecycle", () => {
  test("TTL, per-resource/global limits, reopen, privacy permissions and single-writer exclusion", () => {
    const path = join(directory(), "window.sqlite");
    let now = 1000;
    const limits = resolveOtlpLimits({ ttlMs: 100, maxRows: 2, maxResourceRows: 1 });
    const store = new OtlpObservationStore(path, limits, () => now);
    const observations = (service: string, count: number) => sanitizeOtlpRequest("logs", synthetic("logs", count, service), now, limits).observations;
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => new OtlpObservationStore(path, limits, () => now)).toThrow();
      store.append(observations("a", 2));
      store.append(observations("b", 1));
      store.append(observations("c", 1));
      expect(store.status().rows).toBe(2);
      expect(store.status().retentionEvicted).toBe(2);
      now += 101;
      expect(store.recent().length).toBe(0);
      store.cleanup();
      expect(store.status().rows).toBe(0);
    } finally { store.close(); }
    const reopened = new OtlpObservationStore(path, limits, () => now);
    try { expect(reopened.status().rows).toBe(0); } finally { reopened.close(); }
  });
  test("refuses to adopt unrelated SQLite data", () => {
    const path = join(directory(), "unrelated.sqlite");
    const original = openRuntimeSqliteDatabase(path, { create: true });
    original.exec("CREATE TABLE original (value TEXT); INSERT INTO original VALUES ('preserve');");
    original.close?.();
    expect(() => new OtlpObservationStore(path, resolveOtlpLimits())).toThrow("Not a supported OTLP observation database");
    const reopened = openRuntimeSqliteDatabase(path);
    try {
      expect(reopened.query<{ value: string }>("SELECT value FROM original").get()?.value).toBe("preserve");
      expect(reopened.query<{ count: number }>("SELECT count(*) AS count FROM sqlite_master WHERE name = 'otlp_observations'").get()?.count).toBe(0);
    } finally { reopened.close?.(); }
  });
  test("serialized byte budget evicts oldest rows", () => {
    const limits = resolveOtlpLimits({ maxStoreBytes: 1 });
    const store = new OtlpObservationStore(join(directory(), "bytes.sqlite"), limits);
    try {
      store.append(sanitizeOtlpRequest("logs", synthetic("logs"), Date.now(), limits).observations);
      expect(store.status()).toEqual({ rows: 0, bytes: 0, retentionEvicted: 1 });
    } finally { store.close(); }
  });
  test("validates configuration and standalone arguments", () => {
    for (const bad of ["", "x", "12x", "0", "65536", "1.5"]) expect(() => resolveOtlpPort(bad)).toThrow();
    expect(resolveOtlpPort(0, true)).toBe(0);
    for (const bad of [0, -1, Infinity, 1.5]) expect(() => resolveOtlpLimits({ maxItems: bad })).toThrow();
    expect(() => resolveOtlpLimits({ unexpected: 1 } as any)).toThrow();
    expect(() => parseOtlpArguments(["serve"], {})).toThrow();
    expect(parseOtlpArguments(["serve", "--database", "/chosen/path", "--port", "45310"], {})).toMatchObject({ command: "serve", port: 45310 });
    expect(() => parseOtlpArguments(["tail", "--limit", "501"], {})).toThrow();
  });
  test("broker receiver is opt-in and configuration/bind failures only disable telemetry", async () => {
    let warnings = 0;
    const path = directory();
    expect(await startBrokerOtlpReceiver(path, {}, () => warnings++)).toBeUndefined();
    expect(warnings).toBe(0);
    expect(await startBrokerOtlpReceiver(path, { OPENSCOUT_OTLP_ENABLED: "1", OPENSCOUT_OTLP_PORT: "bad" }, () => warnings++)).toBeUndefined();
    const occupied = await start();
    expect(await startBrokerOtlpReceiver(path, { OPENSCOUT_OTLP_ENABLED: "1", OPENSCOUT_OTLP_PORT: new URL(occupied.url).port }, () => warnings++)).toBeUndefined();
    expect(warnings).toBe(2);
  });
});

/**
 * Headers plus the first byte of a body that never finishes, over a raw
 * socket. node:http's client may hold a partial body until end() (Bun on
 * Linux does), so the receiver would never see the request arrive.
 */
function partialPost(base: string | URL, path: string): Promise<Socket> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{`);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}
