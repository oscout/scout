import { describe, expect, test } from "bun:test";

import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";

import {
  BrokerRuntimeCatalogService,
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
      now: () => now,
      env: {
        OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "60",
        OPENSCOUT_RUNTIME_CATALOG_URL: "https://catalog.test/runtime.json",
      },
      cachePath: () => "/not-used/runtime.json",
      readTextFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      writeTextFile: async () => {},
      ensureDirectory: async () => undefined,
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
