import { describe, expect, test } from "bun:test";
import {
  createOpenScoutWebServer,
  flushPromises,
  makeDiscoverySnapshot,
  makeStaticRoot,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: stream routes", () => {
  test("waits for canonical broker data before serving a cold tail cache", async () => {
    const fetchUrls: string[] = [];
    let resolveBroker!: (response: Response) => void;
    globalThis.fetch = ((input) => {
      fetchUrls.push(String(input));
      return new Promise<Response>((resolve) => {
        resolveBroker = resolve;
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    let settled = false;
    const request = server.app.request("http://localhost/api/tail/recent?limit=10");
    void request.then(() => {
      settled = true;
    });
    await flushPromises();

    expect(fetchUrls[0]).toContain("/v1/tail/recent?limit=10");
    expect(settled).toBe(false);

    resolveBroker(new Response(JSON.stringify({
      generatedAt: 1,
      limit: 10,
      cursor: "tail-1",
      events: [{ id: "tail-1", ts: 1 }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const response = await request;

    expect(response.status).toBe(200);
    expect(response.headers.get("x-openscout-tail-state")).toBe("hit");
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).toContain("web-tail-cache");
    await expect(response.json()).resolves.toMatchObject({
      generatedAt: 1,
      cursor: "tail-1",
      events: [{ id: "tail-1", ts: 1 }],
    });
  });

  test("forwards recent assistant reply mode to the broker as a distinct tail query", async () => {
    let requestedUrl: URL | null = null;
    globalThis.fetch = (async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({
        generatedAt: 1,
        limit: 200,
        cursor: "reply-1",
        events: [{ id: "reply-1", ts: 1 }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    try {
      const response = await server.app.request(
        "http://localhost/api/tail/recent?limit=200&transcripts=1&mode=assistant-replies&windowMs=300000",
      );

      expect(response.status).toBe(200);
      expect(requestedUrl?.pathname).toBe("/v1/tail/recent");
      expect(requestedUrl?.searchParams.get("limit")).toBe("200");
      expect(requestedUrl?.searchParams.get("transcripts")).toBe("true");
      expect(requestedUrl?.searchParams.get("mode")).toBe("assistant-replies");
      expect(requestedUrl?.searchParams.get("windowMs")).toBe("300000");
    } finally {
      await server.stop();
    }
  });

  test("refreshes tail recent cache in the background with server timing from broker", async () => {
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchUrls.push(String(input));
      return new Response(JSON.stringify({
        generatedAt: 1,
        limit: 10,
        cursor: "tail-1",
        events: [{ id: "tail-1", ts: 1 }],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "server-timing": "tail-live;dur=1.2",
        },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const first = await server.app.request("http://localhost/api/tail/recent?limit=10");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      generatedAt: 1,
      cursor: "tail-1",
      events: [{ id: "tail-1", ts: 1 }],
    });

    const second = await server.app.request("http://localhost/api/tail/recent?limit=10");
    expect(fetchUrls[0]).toContain("/v1/tail/recent?limit=10");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-openscout-tail-state")).toBe("hit-refreshing");
    const timing = second.headers.get("server-timing") ?? "";
    expect(timing).toContain("tail-live;dur=1.2");
    expect(timing).toContain("web-broker-fetch");
    expect(timing).toContain("web-json");
    await expect(second.json()).resolves.toMatchObject({
      generatedAt: 1,
      cursor: "tail-1",
      events: [{ id: "tail-1", ts: 1 }],
    });
  });

  test("caps oversized upstream Server-Timing before serving cached tail data", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        generatedAt: 1,
        limit: 10,
        cursor: null,
        events: [],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "server-timing": `tail-live;desc="${"x".repeat(3000)}"`,
        },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const first = await server.app.request("http://localhost/api/tail/recent?limit=10");
    expect(first.status).toBe(200);
    await flushPromises();

    const second = await server.app.request("http://localhost/api/tail/recent?limit=10");

    expect(second.status).toBe(200);
    const timing = second.headers.get("server-timing") ?? "";
    expect(timing.length).toBeLessThan(512);
    expect(timing).toContain('server-timing-truncated;desc="oversize"');
  });

  test("forces tail discovery refresh before serving cached broker data", async () => {
    const fetchUrls: string[] = [];
    let brokerGeneratedAt = 0;
    globalThis.fetch = (async (input) => {
      fetchUrls.push(String(input));
      brokerGeneratedAt += 1;
      return new Response(JSON.stringify(makeDiscoverySnapshot(brokerGeneratedAt)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      tailRuntime: {
        getTailDiscovery: async () => makeDiscoverySnapshot(0),
      },
    });

    const first = await server.app.request("http://localhost/api/tail/discover");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ generatedAt: 1 });

    const forced = await server.app.request("http://localhost/api/tail/discover?force=1");

    expect(forced.status).toBe(200);
    expect(fetchUrls.at(-1)).toContain("/v1/tail/discover?force=1");
    await expect(forced.json()).resolves.toMatchObject({ generatedAt: 2 });
  });

  test("returns an explicit error instead of an empty snapshot when the cold broker refresh fails", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "tail_unavailable" }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "server-timing": "tail-discover;dur=9.4",
        },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/tail/recent?limit=10");

    expect(response.status).toBe(502);
    expect(response.headers.get("x-openscout-tail-state")).toBe("empty-error");
    expect(response.headers.get("x-openscout-tail-warning")).toContain("broker tail unavailable (503)");
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).toContain("tail-discover;dur=9.4");
    expect(timing).toContain("web-broker-fetch");
    await expect(response.json()).resolves.toMatchObject({
      error: "broker tail unavailable",
      detail: "broker tail unavailable (503)",
    });
  });

  test("keeps serving the last good tail snapshot while retrying a failed refresh", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({
          generatedAt: 1,
          limit: 10,
          cursor: "tail-1",
          events: [{ id: "tail-1", ts: 1 }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "tail_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const first = await server.app.request("http://localhost/api/tail/recent?limit=10");
    expect(first.status).toBe(200);
    await first.json();

    const refresh = await server.app.request("http://localhost/api/tail/recent?limit=10");
    expect(refresh.status).toBe(200);
    await refresh.json();
    await flushPromises();

    const stale = await server.app.request("http://localhost/api/tail/recent?limit=10");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-openscout-tail-state")).toBe("stale-retrying");
    expect(stale.headers.get("x-openscout-tail-warning")).toContain("broker tail unavailable (503)");
    await expect(stale.json()).resolves.toMatchObject({
      generatedAt: 1,
      cursor: "tail-1",
      events: [{ id: "tail-1", ts: 1 }],
    });
  });

  test("proxies repo-watch snapshots through the web API", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({
        generatedAt: 1_780_760_000_000,
        projects: [],
        totals: {
          projects: 0,
          worktrees: 0,
          dirtyWorktrees: 0,
          conflictedWorktrees: 0,
          attentionWorktrees: 0,
          attachedAgents: 0,
          attachedSessions: 0,
        },
        warnings: [],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/api/repo-watch?force=1&includeTail=true&includeDiff=true&includeLastCommit=1&native=1&maxRoots=32&maxWorktrees=12&scanBudgetMs=12000&ignored=true",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      generatedAt: 1_780_760_000_000,
      totals: { projects: 0, worktrees: 0 },
    });
    expect(fetchCalls).toEqual([
      "http://broker.test/v1/repo-watch/snapshot?force=1&includeTail=1&includeDiff=1&includeLastCommit=1&native=1&maxRoots=32&maxWorktrees=12&scanBudgetMs=12000",
    ]);
  });
});
