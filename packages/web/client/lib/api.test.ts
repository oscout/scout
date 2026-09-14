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

  test("transparently refreshes session on 401 and retries the request", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      urls.push(url);
      if (url === "/api/bootstrap.js") {
        return new Response("window.__OPENSCOUT_WEB_BOOTSTRAP__ = {};", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }
      if (url === "/api/fleet") {
        if (urls.filter((u) => u === "/api/fleet").length === 1) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ value: 99 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await api<{ value: number }>("/api/fleet");
    expect(result).toEqual({ value: 99 });
    expect(urls).toEqual(["/api/fleet", "/api/bootstrap.js", "/api/fleet"]);
  });

  test("fails closed if 401 persists after session refresh attempt", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      urls.push(url);
      if (url === "/api/bootstrap.js") {
        return new Response("{}", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(api("/api/fleet")).rejects.toThrow("unauthorized");
  });

  test("replays a failure report POST unchanged after refreshing an expired session", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const body = JSON.stringify({ attemptId: "failed-query-1", attempt: { id: "failed-query-1", status: "failed" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, init });
      if (path === "/api/bootstrap.js") {
        expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
        return new Response("", { status: 200 });
      }
      if (requests.length === 1) return new Response("Unauthorized", { status: 401 });
      return Response.json({ conversationId: "report-1" });
    }) as typeof fetch;

    await expect(api("/api/broker/dispatch-review", { method: "POST", body })).resolves.toEqual({ conversationId: "report-1" });
    expect(requests.map((request) => request.path)).toEqual([
      "/api/broker/dispatch-review", "/api/bootstrap.js", "/api/broker/dispatch-review",
    ]);
    for (const request of [requests[0], requests[2]]) {
      expect(request?.init?.method).toBe("POST");
      expect(request?.init?.body).toBe(body);
      expect(new Headers(request?.init?.headers).get("content-type")).toBe("application/json");
    }
  });


  test("stops after one failure report retry when refreshed credentials are still rejected", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      return path === "/api/bootstrap.js"
        ? new Response("", { status: 200 })
        : new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    await expect(api("/api/broker/dispatch-review", { method: "POST", body: "{}" })).rejects.toThrow("Unauthorized");
    expect(paths).toEqual([
      "/api/broker/dispatch-review", "/api/bootstrap.js", "/api/broker/dispatch-review",
    ]);
  });


});

describe("owned API request cancellation", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => clearApiGetCache());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearApiGetCache();
  });

  test("owned cancellation never cancels a concurrent shared GET, in either arrival order", async () => {
    for (const ownedFirst of [false, true]) {
      clearApiGetCache();
      const pending: { signal?: AbortSignal | null; resolve: (response: Response) => void }[] = [];
      globalThis.fetch = ((_path, init) => new Promise<Response>((resolve, reject) => {
        pending.push({ signal: init?.signal, resolve });
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })) as typeof fetch;
      const controller = new AbortController();
      const owned = ownedFirst ? api("/api/owned", { signal: controller.signal }) : undefined;
      const shared = api("/api/owned");
      const cancelled = owned ?? api("/api/owned", { signal: controller.signal });
      const otherShared = api("/api/owned");
      expect(pending.length).toBe(2);
      const rejection = cancelled.catch((error: Error) => error);
      controller.abort();
      expect((await rejection as Error).message).toBe("Aborted");
      const sharedFetch = pending.find((request) => !request.signal)!;
      sharedFetch.resolve(new Response(JSON.stringify({ source: "shared" })));
      await expect(shared).resolves.toEqual({ source: "shared" });
      await expect(otherShared).resolves.toEqual({ source: "shared" });
    }
  });

  test("successful signal-bearing GETs do not populate or overwrite shared settled cache", async () => {
    let value = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({ value: ++value }))) as unknown as typeof fetch;
    const path = "/api/owned-cache";
    await api(path, { signal: new AbortController().signal });
    expect(peekApiGet(path, 30_000)).toBeNull();
    await api(path);
    await api(path, { signal: new AbortController().signal });
    expect(peekApiGet<{ value: number }>(path, 30_000)).toEqual({ value: 2 });
  });

  test("a reply watch aborts its actual API transport on deadline and disposal", async () => {
    const { watchAgentReply } = await import("../screens/ops/agent-reply-watch.ts");
    for (const timeout of [false, true]) {
      const timers = new Map<number, () => void>();
      let transportAborts = 0;
      globalThis.fetch = ((_path, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          transportAborts++;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })) as typeof fetch;
      const states: string[] = [];
      const dispose = watchAgentReply(0, (signal) => api("/api/messages?conversationId=owned", { signal }), (state) => states.push(state.status), (fn, delay) => {
        timers.set(delay, fn);
        return () => { timers.delete(delay); };
      });
      timers.get(2500)!();
      if (timeout) timers.get(300_000)!();
      else dispose();
      await Promise.resolve();
      await Promise.resolve();
      expect(transportAborts).toBe(1);
      expect(timers.size).toBe(0);
      expect(states).toEqual(timeout ? ["waiting", "timed-out"] : ["waiting"]);
    }
  });
});
