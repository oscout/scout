import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "./context.ts";
import { readScoutWebJson } from "./web-api.ts";

describe("readScoutWebJson", () => {
  test("retries a loopback 401 with a bootstrapped session cookie", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (url.endsWith("/api/bootstrap.js")) {
        return new Response("window.__OPENSCOUT_WEB_BOOTSTRAP__ = {};", {
          headers: {
            "content-type": "application/javascript",
            "set-cookie": "openscout_web_session=local-secret; Path=/; HttpOnly; SameSite=Strict",
          },
        });
      }
      if (!headers.has("cookie")) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ gauges: [] });
    }) as typeof fetch;
    const context = createScoutCommandContext({
      env: { OPENSCOUT_WEB_URL: "http://127.0.0.1:43120" },
    });

    const payload = await readScoutWebJson<{ gauges: unknown[] }>(
      context,
      "/api/service-budgets?refresh=1",
      { fetchImpl },
    );

    expect(payload).toEqual({ gauges: [] });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:43120/api/service-budgets?refresh=1",
      "http://127.0.0.1:43120/api/bootstrap.js",
      "http://127.0.0.1:43120/api/service-budgets?refresh=1",
    ]);
    expect(calls[0]?.headers.get("cookie")).toBeNull();
    expect(calls[2]?.headers.get("cookie")).toBe("openscout_web_session=local-secret");
    expect(calls[2]?.headers.get("authorization")).toBeNull();
  });

  test("does not bootstrap when the first loopback request succeeds", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return Response.json({ gauges: [] });
    }) as typeof fetch;
    const context = createScoutCommandContext({
      env: { OPENSCOUT_WEB_URL: "http://127.0.0.1:43120" },
    });

    await expect(readScoutWebJson(context, "/api/service-budgets", { fetchImpl }))
      .resolves.toEqual({ gauges: [] });
    expect(calls).toEqual(["http://127.0.0.1:43120/api/service-budgets"]);
  });

  test("uses an explicit bearer for a configured non-loopback web URL", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const context = createScoutCommandContext({
      env: {
        OPENSCOUT_WEB_URL: "https://scout.example",
        OPENSCOUT_WEB_AUTH_TOKEN: "configured-secret",
      },
    });

    await expect(readScoutWebJson<{ ok: boolean }>(context, "/api/health", { fetchImpl }))
      .resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer configured-secret");
    expect(calls[0]?.headers.get("cookie")).toBeNull();
  });

  test("surfaces authenticated API error details", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/bootstrap.js")) {
        return new Response("bootstrap", {
          headers: { "set-cookie": "openscout_web_session=local-secret; Path=/" },
        });
      }
      return Response.json({ error: "quota feed unavailable" }, { status: 503 });
    }) as typeof fetch;
    const context = createScoutCommandContext({
      env: { OPENSCOUT_WEB_URL: "http://localhost:43120" },
    });

    await expect(readScoutWebJson(context, "/api/service-budgets", { fetchImpl }))
      .rejects.toThrow("Scout web API request failed: quota feed unavailable");
  });
});
