import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { DistKeyStore } from "@openscout/runtime/dist-access";
import type { SoloProProbes } from "@openscout/runtime/solo-pro";

import { mountSoloProRoutes } from "./solo-pro.ts";
import {
  createOpenScoutWebServer,
  installWebServerTestHooks,
  loadWebServerUnderTest,
  makeStaticRoot,
  useIsolatedOpenScoutHome,
} from "../web-server-test-harness.ts";

await loadWebServerUnderTest();
installWebServerTestHooks();

const KEY = "osdist_route0123456789";
const VERSION = "1.4.0";
const INSTALLED = `/support/web/full/${VERSION}`;

const probes: SoloProProbes = {
  platform: "darwin",
  installedFullClient: (version) => (version === VERSION ? INSTALLED : null),
  installedFullClientVersions: () => [VERSION],
  nativeApp: async () => ({ state: "installed", path: "/Applications/Scout.app", version: VERSION, development: false, running: { app: true, menu: true } }),
  herdrInstalled: async () => true,
  herdrRunningSessions: async () => 1,
};

function setup(options: {
  key?: string | null;
  respond?: () => Promise<Response>;
  readKey?: () => Promise<string | null>;
  probes?: SoloProProbes;
} = {}) {
  let keyReads = 0;
  let storeBuilds = 0;
  let requests = 0;
  const store: DistKeyStore = {
    where: "macOS Keychain (OPENSCOUT_DIST_KEY)",
    encrypted: true,
    read: async () => {
      keyReads += 1;
      if (options.readKey) return options.readKey();
      return options.key === undefined ? KEY : options.key;
    },
    write: async () => {
      throw new Error("the routes must never write a key");
    },
    remove: async () => {
      throw new Error("the routes must never remove a key");
    },
  };
  const app = new Hono();
  mountSoloProRoutes(app, {
    scoutVersion: VERSION,
    served: { profile: "full", root: INSTALLED },
    env: {},
    probes: options.probes ?? probes,
    keyStores: async () => {
      storeBuilds += 1;
      return [store];
    },
    fetchImpl: async () => {
      requests += 1;
      return options.respond ? options.respond() : Response.json({ login: "octo", label: null });
    },
  });
  return { app, counts: () => ({ keyReads, requests }), storeBuilds: () => storeBuilds };
}

describe("/api/solo-pro", () => {
  test("GET reads no key and makes no request, however often it is polled", async () => {
    const { app, counts, storeBuilds } = setup();
    for (let i = 0; i < 3; i += 1) {
      const response = await app.request("http://localhost/api/solo-pro");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json() as { phase: string; access: { state: string } };
      expect(body).toMatchObject({ phase: "unconfirmed", access: { state: "unchecked" } });
    }
    expect(counts()).toEqual({ keyReads: 0, requests: 0 });
    // The key stores aren't even built until someone checks.
    expect(storeBuilds()).toBe(0);
  });

  test("a pending keychain read during a check doesn't hold other requests", async () => {
    let answer: (key: string | null) => void = () => {};
    const { app, counts } = setup({ readKey: () => new Promise((resolve) => { answer = resolve; }) });
    const check = app.request("http://localhost/api/solo-pro/access/check", { method: "POST" });
    await Bun.sleep(0);
    expect(counts().keyReads).toBe(1);

    const meanwhile = await app.request("http://localhost/api/solo-pro");
    expect(meanwhile.status).toBe(200);
    expect(await meanwhile.json()).toMatchObject({ access: { state: "unchecked" } });

    answer(KEY);
    const checked = await (await check).json() as { phase: string };
    expect(checked.phase).toBe("active");
    expect(counts()).toEqual({ keyReads: 1, requests: 1 });
  });

  test("a pending native-app probe doesn't hold other requests", async () => {
    let release: () => void = () => {};
    let calls = 0;
    const slow: SoloProProbes = {
      ...probes,
      // The first probe hangs (a stuck ps); later ones answer.
      nativeApp: () => {
        calls += 1;
        if (calls > 1) return probes.nativeApp();
        return new Promise((resolve) => {
          release = () => resolve({ state: "missing", searched: [] });
        });
      },
    };
    const { app } = setup({ probes: slow });
    let firstDone = false;
    const first = app.request("http://localhost/api/solo-pro").then((response) => {
      firstDone = true;
      return response;
    });
    await Bun.sleep(0);
    const second = await app.request("http://localhost/api/solo-pro");
    expect(second.status).toBe(200);
    expect(firstDone).toBe(false);

    release();
    const body = await (await first).json() as { components: Array<{ id: string; installed: string }> };
    expect(body.components.find((component) => component.id === "native_app")?.installed).toBe("missing");
  });

  test("POST check asks once, and later GETs reuse the answer without asking again", async () => {
    const { app, counts } = setup();
    const checked = await (await app.request("http://localhost/api/solo-pro/access/check", { method: "POST" })).json() as { phase: string };
    expect(checked.phase).toBe("active");
    const again = await (await app.request("http://localhost/api/solo-pro")).json() as { phase: string; access: { tier: string } };
    expect(again).toMatchObject({ phase: "active", access: { tier: "solo_pro" } });
    expect(counts().requests).toBe(1);
  });

  test("concurrent checks share one request", async () => {
    const { app, counts } = setup();
    await Promise.all([1, 2, 3].map(() => app.request("http://localhost/api/solo-pro/access/check", { method: "POST" })));
    expect(counts().requests).toBe(1);
  });

  test("an account service that is down keeps the previous answer out: unconfirmed, not denied", async () => {
    const { app } = setup({ respond: async () => new Response("bad gateway", { status: 502 }) });
    const body = await (await app.request("http://localhost/api/solo-pro/access/check", { method: "POST" })).json() as {
      phase: string;
      access: { state: string; tier: string | null };
    };
    expect(body).toMatchObject({ phase: "unconfirmed", access: { state: "unavailable", tier: null } });
  });

  test("a granted answer that later fails to refresh is reported as unconfirmed, not kept as granted", async () => {
    let up = true;
    const { app } = setup({
      respond: async () => {
        if (up) return Response.json({ login: "octo" });
        throw new Error("offline");
      },
    });
    await app.request("http://localhost/api/solo-pro/access/check", { method: "POST" });
    up = false;
    const body = await (await app.request("http://localhost/api/solo-pro/access/check", { method: "POST" })).json() as { phase: string };
    expect(body.phase).toBe("unconfirmed");
  });

  test("missing credentials: no request, and the recovery is scout web login", async () => {
    const { app, counts } = setup({ key: null });
    const raw = await (await app.request("http://localhost/api/solo-pro/access/check", { method: "POST" })).text();
    expect(JSON.parse(raw)).toMatchObject({ phase: "unconfirmed", access: { state: "no_credential" } });
    expect(raw).toContain("scout web login");
    expect(counts().requests).toBe(0);
  });

  test("no response ever carries the download key", async () => {
    for (const respond of [
      async () => Response.json({ login: "octo" }),
      async () => Response.json({ error: "not_entitled" }, { status: 403 }),
      async () => Response.json({ error: "unauthorized" }, { status: 401 }),
      async () => {
        throw new Error(`refused: Authorization: Bearer ${KEY}`);
      },
    ]) {
      const { app } = setup({ respond });
      const checked = await (await app.request("http://localhost/api/solo-pro/access/check", { method: "POST" })).text();
      const read = await (await app.request("http://localhost/api/solo-pro")).text();
      expect(checked).not.toContain(KEY);
      expect(read).not.toContain(KEY);
    }
  });

  test("GET never installs: there is no install route, and other methods are not handled", async () => {
    const { app } = setup();
    expect((await app.request("http://localhost/api/solo-pro/install", { method: "POST" })).status).toBe(404);
    expect((await app.request("http://localhost/api/solo-pro", { method: "POST" })).status).toBe(404);
  });
});

describe("createOpenScoutWebServer: Solo Pro routes", () => {
  test("GET /api/solo-pro is mounted ahead of the /api catch-all and starts unchecked", async () => {
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = `${home}/.openscout`;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/solo-pro");
    expect(response.status).toBe(200);
    const body = await response.json() as { phase: string; access: { state: string }; components: Array<{ id: string }> };
    expect(body.phase).toBe("unconfirmed");
    expect(body.access.state).toBe("unchecked");
    expect(body.components.map((component) => component.id)).toEqual(["full_web_app", "native_app", "herdr"]);
  });
});
