import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ThreadWatchProtocolError } from "./thread-events.js";
import {
  a2aJson,
  badRequest,
  conflict,
  json,
  jsonWithHeaders,
  notFound,
  parseBooleanQueryParam,
  parseLimit,
  parseSince,
  readRequestBody,
  readValidatedRequestBody,
  requestAbortSignal,
  serverTimingHeader,
  threadWatchError,
  throwIfAborted,
} from "./broker-http-helpers.js";

class FakeResponse extends EventEmitter {
  body = "";
  headers: Record<string, string> | undefined;
  status: number | undefined;
  writableEnded = false;

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
    this.writableEnded = true;
  }
}

describe("broker http helpers", () => {
  test("reads JSON request bodies and treats an empty body as an object", async () => {
    const request = new PassThrough();
    const parsed = readRequestBody<{ ok?: boolean }>(request as never);
    request.end(JSON.stringify({ ok: true }));

    await expect(parsed).resolves.toEqual({ ok: true });

    const emptyRequest = new PassThrough();
    const empty = readRequestBody<Record<string, never>>(emptyRequest as never);
    emptyRequest.end();

    await expect(empty).resolves.toEqual({});
  });

  test("rejects oversized and non-JSON request bodies", async () => {
    const oversized = new PassThrough();
    const oversizedResult = readRequestBody(oversized as never, { maxBytes: 4 });
    oversized.end(JSON.stringify({ too: "large" }));
    await expect(oversizedResult).rejects.toMatchObject({
      status: 413,
      code: "request_entity_too_large",
    });

    const nonJson = new PassThrough() as PassThrough & { headers?: Record<string, string> };
    nonJson.headers = { "content-type": "text/plain" };
    const nonJsonResult = readRequestBody(nonJson as never);
    nonJson.end("hello");
    await expect(nonJsonResult).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    });
  });

  test("validates JSON request bodies with a schema", async () => {
    const schema = z.object({
      id: z.string().min(1),
      count: z.number().int().positive(),
    });

    const validRequest = new PassThrough();
    const valid = readValidatedRequestBody(validRequest as never, schema);
    validRequest.end(JSON.stringify({ id: "item-1", count: 2 }));
    await expect(valid).resolves.toEqual({ id: "item-1", count: 2 });

    const invalidRequest = new PassThrough();
    const invalid = readValidatedRequestBody(invalidRequest as never, schema);
    invalidRequest.end(JSON.stringify({ id: "", count: 0 }));
    await expect(invalid).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
    await expect(invalid).rejects.toThrow("id:");
  });

  test("aborts active request work on caller disconnect", () => {
    const request = new EventEmitter();
    const response = new FakeResponse();
    const signal = requestAbortSignal(request as never, response as never);

    response.emit("close");

    expect(signal.aborted).toBe(true);
    expect(() => throwIfAborted(signal)).toThrow("Broker request aborted by caller");
  });

  test("writes common JSON response shapes", () => {
    const ok = new FakeResponse();
    json(ok as never, 201, { ok: true });
    expect(ok.status).toBe(201);
    expect(ok.headers?.["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(ok.body)).toEqual({ ok: true });

    const missing = new FakeResponse();
    notFound(missing as never);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: "not_found" });

    const bad = new FakeResponse();
    badRequest(bad as never, new Error("nope"));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: "bad_request", detail: "nope" });

    const stale = new FakeResponse();
    conflict(stale as never, "lease changed");
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ error: "conflict", detail: "lease changed" });
  });

  test("writes A2A and CORS-aware JSON responses with canonical content types", () => {
    const a2a = new FakeResponse();
    a2aJson(a2a as never, 200, { jsonrpc: "2.0" }, { "x-test": "1" });
    expect(a2a.headers?.["cache-control"]).toBe("no-cache");
    expect(a2a.headers?.["x-test"]).toBe("1");
    expect(a2a.headers?.["content-type"]).toBe("application/json; charset=utf-8");

    const cors = new FakeResponse();
    jsonWithHeaders(cors as never, 200, { ok: true }, { "access-control-allow-origin": "*" });
    expect(cors.headers?.["access-control-allow-origin"]).toBe("*");
    expect(cors.headers?.["content-type"]).toBe("application/json; charset=utf-8");
  });

  test("formats Server-Timing headers with safe tokens and bounded durations", () => {
    expect(serverTimingHeader([
      { name: "tail live", dur: 12.345 },
      { name: "broker-fetch", dur: -1, desc: "tail \"proxy\"" },
      { name: "   " },
    ])).toBe('tail-live;dur=12.3, broker-fetch;dur=0.0;desc="tail proxy"');
  });

  test("replaces oversized Server-Timing headers with a small marker", () => {
    expect(serverTimingHeader([
      { name: "tail-live", dur: 1, desc: "x".repeat(3000) },
    ])).toBe('server-timing-truncated;desc="oversize"');
  });

  test("maps thread-watch protocol errors and query parameters", () => {
    const response = new FakeResponse();
    threadWatchError(response as never, new ThreadWatchProtocolError(403, {
      error: "not_authorized",
      message: "denied",
    }));
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "not_authorized", message: "denied" });

    expect(parseBooleanQueryParam("true")).toBe(true);
    expect(parseBooleanQueryParam("0")).toBe(false);
    expect(parseBooleanQueryParam("maybe")).toBeUndefined();
    expect(parseLimit(new URL("http://broker.test/events?limit=999"))).toBe(500);
    expect(parseLimit(new URL("http://broker.test/events?limit=-1"))).toBe(100);
    expect(parseSince(new URL("http://broker.test/events?since=42"))).toBe(42);
    expect(parseSince(new URL("http://broker.test/events"))).toBeNull();
  });
});
