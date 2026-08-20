import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { api, clearApiGetCache, peekApiGet } from "./api.ts";

describe("api GET dedupe", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearApiGetCache();
  });

  afterEach(() => {
    clearApiGetCache();
    globalThis.fetch = originalFetch;
  });

  test("dedupes concurrent GET requests", async () => {
    let calls = 0;
    let release!: () => void;

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify({ value: 7 }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = api<{ value: number }>("/api/fleet");
    const second = api<{ value: number }>("/api/fleet");

    expect(calls).toBe(1);
    release();

    await expect(first).resolves.toEqual({ value: 7 });
    await expect(second).resolves.toEqual({ value: 7 });
  });

  test("does not reuse completed GET responses", async () => {
    let calls = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ value: calls }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(api<{ value: number }>("/api/fleet")).resolves.toEqual({ value: 1 });
    await expect(api<{ value: number }>("/api/fleet")).resolves.toEqual({ value: 2 });
    expect(calls).toBe(2);
  });

  test("keeps successful GETs synchronously available for warm route remounts", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    expect(peekApiGet<{ calls: number }>("/api/example", 30_000)).toBeNull();
    await expect(api<{ calls: number }>("/api/example")).resolves.toEqual({ calls: 1 });
    expect(peekApiGet<{ calls: number }>("/api/example", 30_000)).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  });

  test("does not dedupe non-GET requests", async () => {
    let calls = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ ok: true, calls }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(api("/api/mesh/announce", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true, calls: 1 });
    await expect(api("/api/mesh/announce", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true, calls: 2 });
    expect(calls).toBe(2);
  });

  test("cache reads never apply to writes", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await api("/api/example");
    expect(peekApiGet("/api/example", 30_000, { method: "POST" })).toBeNull();
  });

  test("reports the endpoint when a successful response is not JSON", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("<!doctype html><title>Missing API proxy</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;

    await expect(api("/api/mesh/announce", { method: "POST", body: "{}" })).rejects.toThrow(
      "Expected JSON from /api/mesh/announce but received text/html; charset=utf-8",
    );
  });
});
