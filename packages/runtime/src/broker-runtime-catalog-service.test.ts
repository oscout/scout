import { describe, expect, test } from "bun:test";

import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";

import {
  BrokerRuntimeCatalogService,
  DEFAULT_RUNTIME_CATALOG_REFRESH_MS,
  DEFAULT_RUNTIME_CATALOG_URL,
  MAX_RUNTIME_CATALOG_BYTES,
  compareRuntimeCatalogRevisions,
} from "./broker-runtime-catalog-service.js";

describe("BrokerRuntimeCatalogService", () => {
  test("orders date-like revisions numerically", () => {
    expect(compareRuntimeCatalogRevisions("2026-08-12.10", "2026-08-12.2")).toBeGreaterThan(0);
    expect(compareRuntimeCatalogRevisions("2026-08-12.1", "2026-08-12.1")).toBe(0);
  });

  test("keeps last-known-good data when a refresh is malformed", async () => {
    let now = 1_000;
    const service = new BrokerRuntimeCatalogService({
      writeTextFile: async () => {}, ensureDirectory: async () => {},
      now: () => now,
      env: {
        OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "60",
        OPENSCOUT_RUNTIME_CATALOG_URL: "https://catalog.test/runtime.json",
      },
      cachePath: () => "/not-used/runtime.json",
      readTextFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      fetch: async () => new Response(JSON.stringify(SCOUT_RUNTIME_CATALOG), {
        status: 200,
        headers: { etag: "one" },
      }),
    });
    const first = await service.read();
    expect(first.source).toBe("remote");
    expect(first.catalog.revision).toBe(SCOUT_RUNTIME_CATALOG.revision);

    now += 61;
    const broken = new BrokerRuntimeCatalogService({
      writeTextFile: async () => {}, ensureDirectory: async () => {},
      now: () => now,
      env: { OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "60" },
      readTextFile: async () => JSON.stringify({
        schemaVersion: "openscout.runtime-catalog-cache.v1",
        catalog: first.catalog,
        checkedAt: first.checkedAt,
        etag: first.etag,
      }),
      fetch: async () => new Response("{}", { status: 200 }),
    });
    const fallback = await broken.read();
    expect(fallback.source).toBe("persisted");
    expect(fallback.catalog.revision).toBe(SCOUT_RUNTIME_CATALOG.revision);
    expect(fallback.warnings[0]).toContain("using persisted revision");
  });

  test("never lets persisted or remote data downgrade the bundled revision", async () => {
    const older = { ...SCOUT_RUNTIME_CATALOG, revision: "2026-08-11.9" };
    const service = new BrokerRuntimeCatalogService({
      writeTextFile: async () => {}, ensureDirectory: async () => {},
      now: () => 2_000,
      env: { OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "60" },
      readTextFile: async () => JSON.stringify({
        schemaVersion: "openscout.runtime-catalog-cache.v1",
        catalog: older,
        checkedAt: 1_900,
      }),
      fetch: async () => Response.json(older),
    });

    const snapshot = await service.read();

    expect(snapshot.source).toBe("bundled");
    expect(snapshot.catalog.revision).toBe(SCOUT_RUNTIME_CATALOG.revision);
    expect(snapshot.warnings[0]).toContain("stale revision");
  });

  test("quarantines an oversized remote catalog", async () => {
    const service = new BrokerRuntimeCatalogService({
      writeTextFile: async () => {}, ensureDirectory: async () => {},
      now: () => 2_000,
      env: { OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "60" },
      readTextFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_RUNTIME_CATALOG_BYTES + 1) },
      }),
    });

    const snapshot = await service.read();

    expect(snapshot.source).toBe("bundled");
    expect(snapshot.warnings[0]).toContain("exceeds");
  });
});

test("normal catalog reads use one daily request including after service restart", async () => {
  let now = 1_000;
  let persisted = "";
  let requests = 0;
  const options = {
    now: () => now,
    readTextFile: async () => { if (!persisted) throw new Error("missing"); return persisted; },
    writeTextFile: async (_path: string, value: string) => { persisted = value; },
    ensureDirectory: async () => {},
    fetch: async () => { requests++; return Response.json(SCOUT_RUNTIME_CATALOG, { headers: { etag: '"daily"' } }); },
  };
  const first = await new BrokerRuntimeCatalogService(options).read();
  expect(DEFAULT_RUNTIME_CATALOG_REFRESH_MS).toBe(86_400_000);
  now += 60_000;
  const restarted = new BrokerRuntimeCatalogService(options);
  const cached = await restarted.read();
  expect(cached.source).toBe("persisted");
  expect(cached.checkedAt).toBe(first.checkedAt);
  expect(requests).toBe(1);
  now = first.nextCheckAt;
  await restarted.read();
  expect(requests).toBe(2);
});

test("force refresh coalesces inside TTL and persists a conditional304 check", async () => {
  let now = 10_000;
  let persisted = JSON.stringify({ schemaVersion: "openscout.runtime-catalog-cache.v1", catalog: SCOUT_RUNTIME_CATALOG,
    checkedAt: now, url: DEFAULT_RUNTIME_CATALOG_URL, etag: '"saved"' });
  let requests = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const options = {
    now: () => now,
    readTextFile: async () => persisted,
    writeTextFile: async (_path: string, text: string) => { persisted = text; },
    ensureDirectory: async () => {},
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      requests++;
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"saved"');
      await gate;
      return new Response(null, { status: 304 });
    },
  };
  const service = new BrokerRuntimeCatalogService(options);
  await service.read();
  expect(requests).toBe(0);
  now += 1_000;
  const reads = [service.read({ force: true }), service.read({ force: true }), service.read()];
  finish();
  const results = await Promise.all(reads);
  expect(requests).toBe(1);
  expect(results.every((entry) => entry.checkedAt === now)).toBe(true);
  expect(JSON.parse(persisted).checkedAt).toBe(now);
  const restarted = await new BrokerRuntimeCatalogService(options).read();
  expect(restarted.checkedAt).toBe(now);
  expect(requests).toBe(1);
});

test("new published model and disabled choices are adopted without editing the bundled seed", async () => {
  const seed = JSON.stringify(SCOUT_RUNTIME_CATALOG);
  const updated = { ...SCOUT_RUNTIME_CATALOG, revision: "2099-01-01.1", harnesses: SCOUT_RUNTIME_CATALOG.harnesses.map((entry) =>
    entry.id === "codex" ? { ...entry, models: [
      { id: "future-published-model", label: "Future published model", enabled: true, default: true,
        reasoningEfforts: ["high" as const], defaultReasoningEffort: "high" as const },
      ...entry.models.map((model) => ({ ...model, enabled: false, default: false })),
    ] } : entry) };
  const snapshot = await new BrokerRuntimeCatalogService({
      writeTextFile: async () => {}, ensureDirectory: async () => {},
    readTextFile: async () => { throw new Error("missing"); },
    fetch: async () => Response.json(updated),
  }).read();
  expect(snapshot.catalog.harnesses.find((entry) => entry.id === "codex")?.models.filter((entry) => entry.enabled).map((entry) => entry.id))
    .toEqual(["future-published-model"]);
  expect(JSON.stringify(SCOUT_RUNTIME_CATALOG)).toBe(seed);
});

test("offline expired saved data survives while corrupt saved data falls back to bundled", async () => {
  for (const saved of ["{bad-json", JSON.stringify({ schemaVersion: "openscout.runtime-catalog-cache.v1",
    catalog: { ...SCOUT_RUNTIME_CATALOG, revision: "2099-01-01.1" }, checkedAt: 1 })]) {
    const snapshot = await new BrokerRuntimeCatalogService({
      writeTextFile: async () => {}, ensureDirectory: async () => {}, now: () => 90_000_000,
      readTextFile: async () => saved, fetch: async () => { throw new Error("offline"); },
    }).read();
    expect(snapshot.source).toBe(saved.startsWith("{bad") ? "bundled" : "persisted");
    expect(snapshot.warnings[0]).toContain("offline");
    expect(snapshot.catalog.harnesses.some((entry) => entry.id === "codex" && entry.models.some((model) => model.enabled))).toBe(true);
  }
});


test("a failed daily check persists its attempt and warning across restart, while force retries", async () => {
  let now = 1_000;
  let persisted = "";
  let requests = 0;
  const options = {
    now: () => now,
    readTextFile: async () => { if (!persisted) throw new Error("missing"); return persisted; },
    writeTextFile: async (_path: string, value: string) => { persisted = value; },
    ensureDirectory: async () => {},
    fetch: async () => { requests++; throw new Error("offline"); },
  };
  const failed = await new BrokerRuntimeCatalogService(options).read();
  expect(failed.catalog).toEqual(SCOUT_RUNTIME_CATALOG);
  expect(failed.warnings[0]).toContain("offline");
  now += 60_000;
  const restarted = new BrokerRuntimeCatalogService(options);
  const saved = await restarted.read();
  expect(requests).toBe(1);
  expect(saved.checkedAt).toBe(failed.checkedAt);
  expect(saved.warnings).toEqual(failed.warnings);
  await restarted.read({ force: true });
  expect(requests).toBe(2);
  now += DEFAULT_RUNTIME_CATALOG_REFRESH_MS;
  await new BrokerRuntimeCatalogService(options).read();
  expect(requests).toBe(3);
});

test("a failed override endpoint never reuses an ETag issued by the old endpoint", async () => {
  let persisted = JSON.stringify({ schemaVersion: "openscout.runtime-catalog-cache.v1", catalog: SCOUT_RUNTIME_CATALOG,
    checkedAt: 1_000, url: DEFAULT_RUNTIME_CATALOG_URL, etag: '"old-endpoint"' });
  const requestHeaders: Headers[] = [];
  const options = {
    now: () => 2_000,
    env: { OPENSCOUT_RUNTIME_CATALOG_URL: "https://catalog.test/override.json" },
    readTextFile: async () => persisted,
    writeTextFile: async (_path: string, value: string) => { persisted = value; },
    ensureDirectory: async () => {},
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers));
      throw new Error("override offline");
    },
  };
  const service = new BrokerRuntimeCatalogService(options);
  await service.read();
  await service.read({ force: true });
  expect(requestHeaders).toHaveLength(2);
  expect(requestHeaders.every((headers) => !headers.has("if-none-match"))).toBe(true);
  expect(JSON.parse(persisted).etag).toBeUndefined();
  expect(JSON.parse(persisted).url).toBe(options.env.OPENSCOUT_RUNTIME_CATALOG_URL);
});


test("default catalog persistence refuses unisolated test writes before filesystem access", async () => {
  const previous = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  let directoryWrites = 0;
  try {
    const snapshot = await new BrokerRuntimeCatalogService({
      readTextFile: async () => { throw new Error("missing"); },
      ensureDirectory: async () => { directoryWrites++; throw new Error("blocked filesystem sentinel"); },
      fetch: async () => Response.json(SCOUT_RUNTIME_CATALOG),
    }).read();
    expect(snapshot.catalog).toEqual(SCOUT_RUNTIME_CATALOG);
    expect(directoryWrites).toBe(0);
  } finally {
    if (previous !== undefined) process.env.OPENSCOUT_SUPPORT_DIRECTORY = previous;
  }
});


test("explicit refresh promotes a cold read awaiting fresh saved data to one network check", async () => {
  let finishRead!: () => void;
  const readGate = new Promise<void>((resolve) => { finishRead = resolve; });
  let requests = 0;
  const service = new BrokerRuntimeCatalogService({
    now: () => 2_000,
    readTextFile: async () => {
      await readGate;
      return JSON.stringify({ schemaVersion: "openscout.runtime-catalog-cache.v1", catalog: SCOUT_RUNTIME_CATALOG,
        checkedAt: 1_000, url: DEFAULT_RUNTIME_CATALOG_URL, etag: '"saved"' });
    },
    ensureDirectory: async () => {}, writeTextFile: async () => {},
    fetch: async () => { requests++; return new Response(null, { status: 304 }); },
  });
  const normal = service.read();
  const force = service.read({ force: true });
  const coalesced = service.read({ force: true });
  finishRead();
  const results = await Promise.all([normal, force, coalesced]);
  expect(requests).toBe(1);
  expect(results.every((snapshot) => snapshot.checkedAt === 2_000)).toBe(true);
  await service.read();
  expect(requests).toBe(1);
});
