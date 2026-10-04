import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  checkExpandedWebAccess,
  keychainDistKeyStore,
  resolveDistKey,
  storeCommandRunner,
  type DistKeyStore,
} from "./dist-access.ts";
import { resetExecSystemTransportForTests, setExecSystemSpawnForTests } from "./system-probes/exec.js";

const KEY = "osdist_secret0123456789";
const NOW = 1_780_000_000_000;

function store(key: string | null, where = "test store"): DistKeyStore {
  return { where, encrypted: true, read: async () => key, write: async () => false, remove: async () => false };
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
    expect((await resolveDistKey({ SCOUT_DIST_KEY: KEY }, [store("osdist_saved")]))?.where).toBe("SCOUT_DIST_KEY");
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

/* ── store commands ─────────────────────────────────────────────────────── */

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end(input?: unknown): void };
  killed: boolean;
  exitCode: number | null;
  kill(signal?: string): boolean;
  unref(): void;
};

/** A child process that never touches a real store: it answers only when told to, or never. */
function fakeStoreCommands(answer: (child: FakeChild) => void = () => {}) {
  const spawned: Array<{ command: string; args: string[]; stdin: string | null; child: FakeChild }> = [];
  setExecSystemSpawnForTests(((command: string, args: string[] = []) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      exitCode: null,
      unref() {},
    }) as FakeChild;
    const record = { command, args: [...args], stdin: null as string | null, child };
    child.stdin = { end: (input?: unknown) => { record.stdin = input === undefined ? null : String(input); } };
    child.kill = () => {
      child.killed = true;
      return true;
    };
    spawned.push(record);
    queueMicrotask(() => answer(child));
    return child;
  }) as never);
  return spawned;
}

describe("store commands", () => {
  afterEach(() => resetExecSystemTransportForTests());

  test("a store that never answers gives up within the time limit and never blocks the event loop", async () => {
    const spawned = fakeStoreCommands();
    const store = keychainDistKeyStore(storeCommandRunner({ timeoutMs: 100 }));
    const started = Date.now();
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 10);
    try {
      expect(await store.read()).toBeNull();
    } finally {
      clearInterval(ticker);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
    // The loop kept running while the read was pending.
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(spawned[0]!.command).toBe("security");
    expect(spawned[0]!.child.killed).toBe(true);
  });

  test("a found key comes back trimmed; a missing one is null", async () => {
    fakeStoreCommands((child) => {
      child.stdout.emit("data", Buffer.from(`${KEY}\n`));
      child.emit("close", 0, null);
    });
    expect(await keychainDistKeyStore(storeCommandRunner({ timeoutMs: 1_000 })).read()).toBe(KEY);

    fakeStoreCommands((child) => child.emit("close", 44, null));
    const run = storeCommandRunner({ timeoutMs: 1_000 });
    expect(await run("security", ["find-generic-password"])).toEqual({ status: 44, stdout: "" });
    expect(await keychainDistKeyStore(run).read()).toBeNull();
  });

  test("saving sends the key on stdin, never in argv", async () => {
    const spawned = fakeStoreCommands((child) => child.emit("close", 0, null));
    expect(await keychainDistKeyStore(storeCommandRunner({ timeoutMs: 1_000 })).write(KEY)).toBe(true);
    expect(spawned[0]!.args).toEqual(["-i"]);
    expect(spawned[0]!.args.join(" ")).not.toContain(KEY);
    expect(spawned[0]!.stdin).toContain(KEY);
  });
});
