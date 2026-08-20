import { describe, expect, test } from "bun:test";
import {
  legacyScoutServiceLabels,
  parseArgs,
  waitForWeb,
} from "./restart-all.mjs";

// Process-ownership coverage moved with the model itself; the tree, the stop
// order, and the verification rules now live in
// apps/desktop/src/cli/app-lifecycle.ts and are tested alongside it. What stays
// here is what this script still owns: its own dev-only flags.
describe("scout:up", () => {
  test("parses canonical lifecycle options", () => {
    expect(parseArgs(["bun", "restart-all.mjs", "--fresh", "--no-ios", "--web-port", "44000"])).toMatchObject({
      fresh: true,
      ios: false,
      verifyOnly: false,
      webPort: 44000,
    });
    expect(parseArgs(["bun", "restart-all.mjs", "--verify-only"])).toMatchObject({
      verifyOnly: true,
      ios: false,
    });
  });

  test("recognizes supervisor labels replaced by the canonical service", () => {
    expect(legacyScoutServiceLabels("dev")).toEqual(["dev.openscout", "com.openscout"]);
    expect(legacyScoutServiceLabels("prod")).toEqual(["dev.openscout", "com.openscout"]);
    expect(legacyScoutServiceLabels("custom")).toEqual(["com.openscout.custom"]);
  });

  test("claims the local web credential before probing protected routes", async () => {
    const requests: Array<{ path: string; cookie: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ path: url.pathname, cookie: request.headers.get("cookie") });
        if (url.pathname === "/api/bootstrap.js") {
          return new Response("window.__OPENSCOUT__ = {};", {
            headers: {
              "content-type": "application/javascript",
              "set-cookie": "openscout_web_session=test-token; Path=/; HttpOnly; SameSite=Strict",
            },
          });
        }
        if (url.pathname === "/api/health") {
          return request.headers.get("cookie") === "openscout_web_session=test-token"
            ? Response.json({ ok: true, surface: "openscout-web" })
            : Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const cookie = await waitForWeb(`http://127.0.0.1:${server.port}`, "/tmp/test-web.log");
      expect(cookie).toBe("openscout_web_session=test-token");
      expect(requests).toEqual([
        { path: "/api/bootstrap.js", cookie: null },
        { path: "/api/health", cookie: "openscout_web_session=test-token" },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
