import { describe, expect, test } from "bun:test";

import { checkExpandedWebAccess, resolveDistKey, type DistKeyStore } from "./dist-access.ts";

const KEY = "osdist_secret0123456789";
const NOW = 1_780_000_000_000;

function store(key: string | null, where = "test store"): DistKeyStore {
  return { where, encrypted: true, read: () => key, write: () => false, remove: () => false };
}

function reply(status: number, body: unknown) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const check = (stores: DistKeyStore[], fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>, env: NodeJS.ProcessEnv = {}) =>
  checkExpandedWebAccess({ env, stores, fetchImpl, now: () => NOW });

describe("checkExpandedWebAccess", () => {
  test("200 with an account is granted, and asks whoami with the saved key", async () => {
    const host = reply(200, { login: "octo", label: "laptop" });
    const access = await check([store(KEY, "macOS Keychain (OPENSCOUT_DIST_KEY)")], host.fetchImpl);
    expect(access).toEqual({
      state: "granted",
      checkedAt: NOW,
      keyWhere: "macOS Keychain (OPENSCOUT_DIST_KEY)",
      account: { login: "octo", label: "laptop" },
    });
    expect(host.calls).toEqual([{ url: "https://console.openscout.app/v1/dist/whoami", auth: `Bearer ${KEY}` }]);
  });

  test("403 not_entitled is denied", async () => {
    const access = await check([store(KEY)], reply(403, { error: "not_entitled" }).fetchImpl);
    expect(access.state).toBe("denied");
  });

  test("401 is a rejected key, not a denial", async () => {
    const access = await check([store(KEY)], reply(401, { error: "unauthorized" }).fetchImpl);
    expect(access.state).toBe("credential_rejected");
  });

  test("no saved key and no SCOUT_DIST_KEY makes no request", async () => {
    const host = reply(200, { login: "octo" });
    const access = await check([store(null)], host.fetchImpl);
    expect(access).toEqual({ state: "no_credential", checkedAt: NOW });
    expect(host.calls).toHaveLength(0);
  });

  test("SCOUT_DIST_KEY wins over the saved key, as in scout web", async () => {
    const host = reply(200, { login: "octo" });
    await check([store("osdist_saved")], host.fetchImpl, { SCOUT_DIST_KEY: KEY, OPENSCOUT_DIST_URL: "https://dist.test/" });
    expect(host.calls[0]).toEqual({ url: "https://dist.test/v1/dist/whoami", auth: `Bearer ${KEY}` });
    expect(resolveDistKey({ SCOUT_DIST_KEY: KEY }, [store("osdist_saved")])?.where).toBe("SCOUT_DIST_KEY");
  });

  test.each([
    [500, { error: "internal" }],
    [503, null],
    [200, {}],
    [403, { error: "forbidden" }],
  ])("%i %j is unavailable, never granted or denied", async (status, body) => {
    const access = await check([store(KEY)], reply(status, body).fetchImpl);
    expect(access.state).toBe("unavailable");
  });

  test("a network failure is unavailable and never echoes the key", async () => {
    const access = await check([store(KEY)], async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${KEY}`);
    });
    expect(access.state).toBe("unavailable");
    expect(JSON.stringify(access)).not.toContain(KEY);
    expect(JSON.stringify(access)).toContain("[key]");
  });

  test("no state carries the key", async () => {
    for (const [status, body] of [[200, { login: "octo" }], [403, { error: "not_entitled" }], [401, {}], [502, {}]] as const) {
      const access = await check([store(KEY)], reply(status, body).fetchImpl);
      expect(JSON.stringify(access)).not.toContain(KEY);
    }
  });
});
