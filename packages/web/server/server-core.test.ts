import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createScoutRequestPeerAddressRegistry,
  installScoutApiMiddleware,
  isAuthorizedScoutWebSocketRequest,
  isScoutWebRequestAllowedFromPeer,
  registerScoutWebAssets,
  resolveScoutWebBindHost,
  resolveScoutWebLanAccessScope,
  SCOUT_WEB_AUTH_COOKIE,
  SCOUT_WEB_LOGIN_API_PATH,
  SCOUT_WEB_LOGOUT_API_PATH,
  shouldIssueFrontDoorScoutWebCredential,
  shouldIssueLocalScoutWebCredential,
} from "./server-core.ts";
import { createScoutWebSessionStore } from "./web-sessions.ts";

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

describe("createScoutRequestPeerAddressRegistry", () => {
  test("preserves a socket peer across an authenticated request clone", () => {
    const registry = createScoutRequestPeerAddressRegistry();
    const cloned = new Request(new Request("http://localhost/api/bootstrap.js"), {
      headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}` },
    });
    registry.remember(cloned, "127.0.0.1");

    expect(registry.resolve({ req: { raw: cloned } } as Context)).toBe("127.0.0.1");
  });
});

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

describe("pairing-only LAN access", () => {
  test("parses the LAN scope strictly", () => {
    expect(resolveScoutWebLanAccessScope({})).toBe("full");
    expect(resolveScoutWebLanAccessScope({ OPENSCOUT_WEB_LAN_SCOPE: "pairing" })).toBe("pairing");
    expect(() => resolveScoutWebLanAccessScope({ OPENSCOUT_WEB_LAN_SCOPE: "public" }))
      .toThrow("Unsupported OPENSCOUT_WEB_LAN_SCOPE");
  });

  test("allows remote peers only exact GET /pair", () => {
    const remote = "192.168.1.50";
    expect(isScoutWebRequestAllowedFromPeer(
      new Request("http://mac.local/pair?route=lan"),
      remote,
      "pairing",
    )).toBe(true);
    expect(isScoutWebRequestAllowedFromPeer(
      new Request("http://mac.local/.host-info"),
      remote,
      "pairing",
    )).toBe(false);
    expect(isScoutWebRequestAllowedFromPeer(
      new Request("http://mac.local/pair", { method: "POST" }),
      remote,
      "pairing",
    )).toBe(false);
    expect(isScoutWebRequestAllowedFromPeer(
      new Request("http://mac.local/pair", { headers: { upgrade: "websocket" } }),
      remote,
      "pairing",
    )).toBe(false);
  });

  test("keeps loopback and explicitly full listeners available", () => {
    const privileged = new Request("http://localhost/.host-info");
    expect(isScoutWebRequestAllowedFromPeer(privileged, "127.0.0.1", "pairing")).toBe(true);
    expect(isScoutWebRequestAllowedFromPeer(privileged, "192.168.1.50", "full")).toBe(true);
    expect(isScoutWebRequestAllowedFromPeer(privileged, undefined, "pairing")).toBe(false);
  });

  test("keeps a remote browser remote through the loopback edge", () => {
    const headers = { "x-forwarded-for": "192.168.1.50" };
    expect(isScoutWebRequestAllowedFromPeer(
      new Request("http://m1.scout.local/.host-info", { headers }),
      "127.0.0.1",
      "pairing",
    )).toBe(false);
    expect(isScoutWebRequestAllowedFromPeer(
      new Request("http://m1.scout.local/pair", { headers }),
      "127.0.0.1",
      "pairing",
    )).toBe(true);
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

describe("minted browser WebSocket sessions", () => {
  test("uses the same session validity for HTTP and WebSocket paths", () => {
    const sessions = createScoutWebSessionStore({ path: null });
    const token = sessions.mint({ label: "login" });
    const request = new Request("http://scout.hudson-mini.local/api/terminal/ws", {
      headers: { origin: "http://scout.hudson-mini.local", cookie: `${SCOUT_WEB_AUTH_COOKIE}=${token}` },
    });
    const options = { trustedHosts: ["scout.hudson-mini.local"], sessions };
    expect(isAuthorizedScoutWebSocketRequest(request, TEST_AUTH_TOKEN, options, "192.168.1.50")).toBe(true);
    sessions.revoke(token);
    expect(isAuthorizedScoutWebSocketRequest(request, TEST_AUTH_TOKEN, options, "192.168.1.50")).toBe(false);
  });
});

describe("login request bounds and durable session errors", () => {
  test.each([true, false])("rejects an oversized body (Content-Length present: %s)", async (withLength) => {
    const sessions = createScoutWebSessionStore({ path: null });
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });
    const body = JSON.stringify({ token: TEST_AUTH_TOKEN, padding: "x".repeat(5000) });
    const response = await app.request("http://localhost/api/login", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(withLength ? { "content-length": String(body.length) } : {}) }, body,
    });
    expect(response.status).toBe(413);
    expect(sessions.size()).toBe(0);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rejects an oversized stream even with an understated Content-Length", async () => {
    let cancelled = false;
    const sessions = createScoutWebSessionStore({ path: null });
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(2048)); }, cancel() { cancelled = true; } });
    const response = await app.request(new Request("http://localhost/api/login", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", "content-length": "1" }, body,
    }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(sessions.size()).toBe(0);
  });

  test("reports failed session persistence without issuing or clearing a cookie", async () => {
    const sessions = { mint: () => { throw new Error("synthetic persistence failure"); }, validate: () => true, revoke: () => { throw new Error("synthetic persistence failure"); } };
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });
    for (const path of ["login", "logout"]) {
      const response = await app.request(`http://localhost/api/${path}`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", cookie: `${SCOUT_WEB_AUTH_COOKIE}=sws_synthetic` }, body: JSON.stringify({ token: TEST_AUTH_TOKEN }) });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
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

  test("does not trust a remote X-Real-IP through the local edge", () => {
    expect(shouldIssueLocalScoutWebCredential(
      new Request("http://m1.scout.local/__openscout/bootstrap.js", {
        headers: { "x-real-ip": "192.168.1.50" },
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

describe("shouldIssueFrontDoorScoutWebCredential", () => {
  const FRONT_DOORS = ["https://studio-lab-3.exe.xyz"];
  const forwardedExeRequest = (headers: Record<string, string> = {}) =>
    new Request("http://studio-lab-3.exe.xyz/api/bootstrap.js", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.9",
        ...headers,
      },
    });

  test("issues to a forwarded browser through a declared front door", () => {
    expect(shouldIssueFrontDoorScoutWebCredential(
      forwardedExeRequest(),
      "127.0.0.1",
      FRONT_DOORS,
    )).toBe(true);
  });

  test("delegation ignores multi-hop and standardized forwarding headers", () => {
    expect(shouldIssueFrontDoorScoutWebCredential(
      forwardedExeRequest({
        "x-forwarded-for": "203.0.113.9, 10.1.2.3",
        forwarded: "for=203.0.113.9;proto=https",
      }),
      "127.0.0.1",
      FRONT_DOORS,
    )).toBe(true);
  });

  test("refuses when no front doors are declared", () => {
    expect(shouldIssueFrontDoorScoutWebCredential(
      forwardedExeRequest(),
      "127.0.0.1",
      [],
    )).toBe(false);
  });

  test("refuses an undeclared host even from a loopback peer", () => {
    expect(shouldIssueFrontDoorScoutWebCredential(
      new Request("http://other-lab.exe.xyz/api/bootstrap.js", {
        headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" },
      }),
      "127.0.0.1",
      FRONT_DOORS,
    )).toBe(false);
  });

  test("refuses a non-loopback peer hitting the port directly", () => {
    for (const peer of ["100.64.0.10", "192.168.1.50", undefined]) {
      expect(shouldIssueFrontDoorScoutWebCredential(
        forwardedExeRequest(),
        peer,
        FRONT_DOORS,
      )).toBe(false);
    }
  });

  test("accepts a declared extra front-door proxy peer", () => {
    expect(shouldIssueFrontDoorScoutWebCredential(
      forwardedExeRequest(),
      "10.0.0.7",
      FRONT_DOORS,
      ["10.0.0.7"],
    )).toBe(true);
  });

  test("an https front door requires forwarded HTTPS", () => {
    expect(shouldIssueFrontDoorScoutWebCredential(
      new Request("http://studio-lab-3.exe.xyz/api/bootstrap.js", {
        headers: { "x-forwarded-for": "203.0.113.9" },
      }),
      "127.0.0.1",
      FRONT_DOORS,
    )).toBe(false);
  });
});

describe("operator login endpoint", () => {
  function createSessionAuthority(): ScoutWebSessionAuthority & { minted: string[]; revoked: string[] } {
    const minted: string[] = [];
    const revoked: string[] = [];
    return {
      minted,
      revoked,
      mint: () => {
        const token = `sws_test_${minted.length}`;
        minted.push(token);
        return token;
      },
      validate: (token) => minted.includes(token) && !revoked.includes(token),
      revoke: (token) => {
        revoked.push(token);
      },
    };
  }

  function loginRequest(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    };
  }

  test("mints a session cookie for the correct operator token", async () => {
    const sessions = createSessionAuthority();
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });

    const response = await app.request("http://localhost/api/login", loginRequest({ token: TEST_AUTH_TOKEN }));

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SCOUT_WEB_AUTH_COOKIE}=sws_test_0`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=");
    expect(cookie).not.toContain("Secure");
  });

  test("marks the cookie Secure behind a forwarded-HTTPS edge", async () => {
    const sessions = createSessionAuthority();
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });

    const response = await app.request("http://localhost/api/login", {
      ...loginRequest({ token: TEST_AUTH_TOKEN }),
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  test("rejects a wrong operator token without setting a cookie", async () => {
    const sessions = createSessionAuthority();
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });

    const response = await app.request("http://localhost/api/login", loginRequest({ token: "wrong" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(sessions.minted).toEqual([]);
  });

  test("rejects a malformed login body", async () => {
    const app = createApp({ resolvePeerAddress: () => "127.0.0.1" });
    const response = await app.request("http://localhost/api/login", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: "not json",
    });

    expect(response.status).toBe(400);
  });

  test("a minted session cookie authenticates API requests", async () => {
    const sessions = createSessionAuthority();
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });
    const session = sessions.mint();

    const response = await app.request("http://localhost/api/ping", {
      headers: {
        origin: "http://localhost",
        cookie: `${SCOUT_WEB_AUTH_COOKIE}=${session}`,
      },
    });

    expect(response.status).toBe(200);
  });

  test("logout revokes the presented session and clears the cookie", async () => {
    const sessions = createSessionAuthority();
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });
    const session = sessions.mint();

    const response = await app.request("http://localhost/api/logout", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        cookie: `${SCOUT_WEB_AUTH_COOKIE}=${session}`,
      },
    });

    expect(response.status).toBe(200);
    expect(sessions.revoked).toEqual([session]);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    const replayed = await app.request("http://localhost/api/ping", {
      headers: {
        origin: "http://localhost",
        cookie: `${SCOUT_WEB_AUTH_COOKIE}=${session}`,
      },
    });
    expect(replayed.status).toBe(401);
  });

  test("an expired or unknown session cookie still gets 401", async () => {
    const sessions = createSessionAuthority();
    const app = createApp({ sessions, resolvePeerAddress: () => "127.0.0.1" });

    const response = await app.request("http://localhost/api/ping", {
      headers: {
        origin: "http://localhost",
        cookie: `${SCOUT_WEB_AUTH_COOKIE}=sws_unknown`,
      },
    });

    expect(response.status).toBe(401);
  });
});
