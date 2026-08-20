import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installScoutApiMiddleware,
  isAuthorizedScoutWebSocketRequest,
  registerScoutWebAssets,
  resolveScoutWebBindHost,
  SCOUT_WEB_AUTH_COOKIE,
  shouldIssueLocalScoutWebCredential,
} from "./server-core.ts";

const testDirectories = new Set<string>();
const TEST_AUTH_TOKEN = "test-openscout-web-token";

function authorizedHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("authorization", `Bearer ${TEST_AUTH_TOKEN}`);
  return result;
}

afterEach(() => {
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function createApp(options?: Parameters<typeof installScoutApiMiddleware>[2]) {
  const app = new Hono();
  installScoutApiMiddleware(app, "test", { authToken: TEST_AUTH_TOKEN, ...options });
  app.get("/api/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("installScoutApiMiddleware", () => {
  test("allows same-origin loopback API requests", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/api/ping", {
      headers: authorizedHeaders({
        origin: "http://localhost",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("allows same-origin API requests through the unspecified bind address", async () => {
    const app = createApp();
    const response = await app.request("http://0.0.0.0:43122/api/ping", {
      headers: authorizedHeaders({
        origin: "http://0.0.0.0:43122",
      }),
    });

    expect(response.status).toBe(200);
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

  test("allows configured Scout mDNS API hosts", async () => {
    const app = createApp({
      trustedHosts: ["scout.hudson-mini.local"],
    });
    const response = await app.request("http://scout.hudson-mini.local/api/ping", {
      headers: authorizedHeaders({
        origin: "http://scout.hudson-mini.local",
      }),
    });

    expect(response.status).toBe(200);
  });

  test("rejects a spoofed loopback Host from a non-loopback peer", async () => {
    const app = createApp({ resolvePeerAddress: () => "192.168.1.50" });
    const response = await app.request("http://localhost/api/ping");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  test("allows a loopback Host from a loopback peer", async () => {
    const app = createApp({ resolvePeerAddress: () => "::ffff:127.0.0.1" });
    const response = await app.request("http://localhost/api/ping", {
      headers: authorizedHeaders({ origin: "http://localhost" }),
    });

    expect(response.status).toBe(200);
  });

  test("trusts configured mDNS hosts regardless of peer address", async () => {
    const app = createApp({
      trustedHosts: ["scout.hudson-mini.local"],
      resolvePeerAddress: () => "192.168.1.50",
    });
    const response = await app.request("http://scout.hudson-mini.local/api/ping", {
      headers: authorizedHeaders({ origin: "http://scout.hudson-mini.local" }),
    });

    expect(response.status).toBe(200);
  });

  test("allows configured public origins through a loopback proxy", async () => {
    const app = createApp({
      trustedHosts: ["scout.hudson-mini.local"],
      trustedOrigins: ["https://scout.hudson-mini.local"],
    });
    const response = await app.request("http://127.0.0.1:43120/api/ping", {
      headers: authorizedHeaders({
        origin: "https://scout.hudson-mini.local",
      }),
    });

    expect(response.status).toBe(200);
  });

  test("denies an unauthenticated loopback client", async () => {
    const app = createApp({ resolvePeerAddress: () => "127.0.0.1" });
    const response = await app.request("http://localhost/api/ping", {
      headers: { origin: "http://localhost" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="OpenScout Web"');
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("denies an unauthenticated LAN client even on a trusted mDNS host", async () => {
    const app = createApp({
      trustedHosts: ["scout.hudson-mini.local"],
      resolvePeerAddress: () => "192.168.1.50",
    });
    const response = await app.request("http://scout.hudson-mini.local/api/ping", {
      headers: { origin: "http://scout.hudson-mini.local" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("accepts the credential from the HttpOnly session cookie", async () => {
    const app = createApp({ resolvePeerAddress: () => "127.0.0.1" });
    const response = await app.request("http://localhost/api/ping", {
      headers: {
        origin: "http://localhost",
        cookie: `${SCOUT_WEB_AUTH_COOKIE}=${TEST_AUTH_TOKEN}`,
      },
    });

    expect(response.status).toBe(200);
  });

  test("fails closed before an unauthenticated mutation handler runs", async () => {
    let mutationRan = false;
    const app = new Hono();
    installScoutApiMiddleware(app, "test", {
      authToken: TEST_AUTH_TOKEN,
      trustedHosts: ["scout.hudson-mini.local"],
      resolvePeerAddress: () => "192.168.1.50",
    });
    app.post("/api/mutate", (c) => {
      mutationRan = true;
      return c.json({ ok: true });
    });

    const response = await app.request("http://scout.hudson-mini.local/api/mutate", {
      method: "POST",
      headers: { origin: "http://scout.hudson-mini.local" },
    });

    expect(response.status).toBe(401);
    expect(mutationRan).toBe(false);
  });

});

describe("resolveScoutWebBindHost", () => {
  test("defaults to loopback", () => {
    expect(resolveScoutWebBindHost({})).toBe("127.0.0.1");
  });

  test("rejects LAN binds without explicit opt-in", () => {
    expect(() => resolveScoutWebBindHost({ OPENSCOUT_WEB_HOST: "0.0.0.0" }))
      .toThrow("OPENSCOUT_WEB_ALLOW_LAN=1");
  });

  test("accepts a LAN bind with explicit opt-in", () => {
    expect(resolveScoutWebBindHost({
      OPENSCOUT_WEB_HOST: "0.0.0.0",
      OPENSCOUT_WEB_ALLOW_LAN: "1",
    })).toBe("0.0.0.0");
  });
});

describe("isAuthorizedScoutWebSocketRequest", () => {
  const options = { trustedHosts: ["scout.hudson-mini.local"] };

  test("denies an unauthenticated LAN WebSocket on a trusted mDNS host", () => {
    const request = new Request("http://scout.hudson-mini.local/api/terminal/ws", {
      headers: {
        origin: "http://scout.hudson-mini.local",
        upgrade: "websocket",
      },
    });

    expect(isAuthorizedScoutWebSocketRequest(
      request,
      TEST_AUTH_TOKEN,
      options,
      "192.168.1.50",
    )).toBe(false);
  });

  test("accepts an authenticated LAN WebSocket only after all defense gates pass", () => {
    const request = new Request("http://scout.hudson-mini.local/api/terminal/ws", {
      headers: authorizedHeaders({
        origin: "http://scout.hudson-mini.local",
        upgrade: "websocket",
      }),
    });

    expect(isAuthorizedScoutWebSocketRequest(
      request,
      TEST_AUTH_TOKEN,
      options,
      "192.168.1.50",
    )).toBe(true);
  });
});

describe("shouldIssueLocalScoutWebCredential", () => {
  test("issues a cookie only to a direct loopback request", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://localhost/__openscout/bootstrap.js"),
      "127.0.0.1",
    )).toBe(true);
  });

  test("issues a credential through the local edge for a same-Mac client", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://m1.scout.local/__openscout/bootstrap.js", {
        headers: { "x-forwarded-for": "192.168.1.20" },
      }),
      "127.0.0.1",
      ["192.168.1.20"],
    )).toBe(true);
  });

  test("does not issue a credential through the local edge for another LAN client", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://m1.scout.local/__openscout/bootstrap.js", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      }),
      "127.0.0.1",
      ["192.168.1.20"],
    )).toBe(false);
  });

  test("does not trust a forwarded chain even when it contains a local address", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://m1.scout.local/__openscout/bootstrap.js", {
        headers: { "x-forwarded-for": "192.168.1.20, 192.168.1.50" },
      }),
      "127.0.0.1",
      ["192.168.1.20"],
    )).toBe(false);
  });

  test("rejects malformed or non-IP forwarding values", () => {
    for (const forwardedFor of ["192.168.1.20,", "localhost", "not-an-ip"]) {
      expect(shouldIssueLocalScoutWebCredential(
        new Request("http://m1.scout.local/__openscout/bootstrap.js", {
          headers: { "x-forwarded-for": forwardedFor },
        }),
        "127.0.0.1",
        ["192.168.1.20"],
      )).toBe(false);
    }
  });

  test("accepts an IPv4-mapped form of this Mac's address", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://m1.scout.local/__openscout/bootstrap.js", {
        headers: { "x-forwarded-for": "::ffff:192.168.1.20" },
      }),
      "::1",
      ["192.168.1.20"],
    )).toBe(true);
  });

  test("rejects the standardized Forwarded header", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://m1.scout.local/__openscout/bootstrap.js", {
        headers: {
          forwarded: "for=192.168.1.20",
          "x-forwarded-for": "192.168.1.20",
        },
      }),
      "127.0.0.1",
      ["192.168.1.20"],
    )).toBe(false);
  });

  test("does not issue a credential directly to a LAN peer", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://scout.local/__openscout/bootstrap.js"),
      "192.168.1.50",
    )).toBe(false);
  });
});

describe("registerScoutWebAssets", () => {
  function createStaticRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "openscout-web-assets-"));
    testDirectories.add(root);
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><body>Scout</body>", "utf8");
    writeFileSync(join(root, "assets", "index-AbCd1234.js"), "export {};", "utf8");
    writeFileSync(join(root, "assets", "index.js"), "export {};", "utf8");
    return root;
  }

  test("caches fingerprinted assets immutably while keeping HTML uncached", async () => {
    const app = new Hono();
    await registerScoutWebAssets(app, {
      assetMode: "static",
      staticRoot: createStaticRoot(),
      defaultViteUrl: "http://127.0.0.1:43122",
    });

    const assetResponse = await app.request("http://localhost/assets/index-AbCd1234.js");
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    const unhashedAssetResponse = await app.request("http://localhost/assets/index.js");
    expect(unhashedAssetResponse.status).toBe(200);
    expect(unhashedAssetResponse.headers.get("cache-control")).toBeNull();

    for (const path of ["/index.html", "/projects"]) {
      const htmlResponse = await app.request(`http://localhost${path}`);
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get("cache-control")).toBe("no-store");
    }
  });
});
