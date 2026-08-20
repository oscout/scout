import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { installScoutApiMiddleware } from "./server-core.ts";

function createApp() {
  const app = new Hono();
  installScoutApiMiddleware(app, "test");
  app.get("/api/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("installScoutApiMiddleware", () => {
  test("allows same-origin loopback API requests", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/api/ping", {
      headers: {
        origin: "http://localhost",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("rejects cross-origin API requests", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/api/ping", {
      headers: {
        origin: "https://example.com",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  test("rejects non-loopback API hosts", async () => {
    const app = createApp();
    const response = await app.request("http://evil.test/api/ping");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});
