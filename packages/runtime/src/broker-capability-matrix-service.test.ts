import { describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeModelCatalogInput } from "./capability-matrix.js";
import {
  BrokerCapabilityMatrixService,
  capabilityMatrixSnapshotIsFresh,
  isCapabilityMatrixSnapshot,
  resolveCapabilityMatrixCacheTtlMs,
} from "./broker-capability-matrix-service.js";

function modelInput(capturedAt: number): RuntimeModelCatalogInput {
  return {
    kind: "model_catalog",
    id: "local-models",
    name: "Local Models",
    capturedAt,
    raw: {},
    models: [{
      providerId: "local",
      modelId: "scout-small",
      displayName: "Scout Small",
      features: { streaming: true },
    }],
  };
}

function createService(input: {
  now: () => number;
  cachePath: string;
  env?: NodeJS.ProcessEnv;
  calls: { generated: number };
}) {
  return new BrokerCapabilityMatrixService({
    nodeId: "node-1",
    env: input.env,
    now: input.now,
    cachePath: () => input.cachePath,
    async loadHarnessCatalogSnapshot({ now }) {
      input.calls.generated += 1;
      return {
        version: 1,
        generatedAt: now(),
        entries: [],
      };
    },
    async loadRuntimeModelCatalogInput({ capturedAt }) {
      return {
        input: modelInput(capturedAt),
        warnings: ["model warning"],
      };
    },
    async loadRuntimeMcpServerCatalog() {
      return {
        servers: [],
        warnings: ["mcp warning"],
      };
    },
    async discoverConfiguredMcpServers() {
      return {
        inputs: [],
        warnings: ["discovery warning"],
      };
    },
  });
}

describe("BrokerCapabilityMatrixService", () => {
  test("parses cache TTL and validates persisted snapshot freshness", () => {
    expect(resolveCapabilityMatrixCacheTtlMs({})).toBe(60_000);
    expect(resolveCapabilityMatrixCacheTtlMs({ OPENSCOUT_CAPABILITY_MATRIX_CACHE_TTL_MS: "0" })).toBe(0);
    expect(resolveCapabilityMatrixCacheTtlMs({ OPENSCOUT_CAPABILITY_MATRIX_CACHE_TTL_MS: "bad" })).toBe(60_000);

    const snapshot = {
      generatedAt: 1_000,
      sources: [],
      capabilities: [],
      warnings: [],
    };
    expect(isCapabilityMatrixSnapshot(snapshot)).toBe(true);
    expect(capabilityMatrixSnapshotIsFresh(snapshot, 1_100, 500)).toBe(true);
    expect(capabilityMatrixSnapshotIsFresh(snapshot, 1_600, 500)).toBe(false);
    expect(capabilityMatrixSnapshotIsFresh(snapshot, 1_100, 0)).toBe(false);
  });

  test("uses in-memory cache before regenerating or reading persisted cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-capability-cache-"));
    const cachePath = join(home, "capability-matrix.json");
    let now = 1_000;
    const calls = { generated: 0 };
    const service = createService({
      now: () => now,
      cachePath,
      calls,
    });

    const first = await service.read();
    now = 1_100;
    const second = await service.read();

    expect(second).toBe(first);
    expect(calls.generated).toBe(1);
    expect(first.capabilities).toContainEqual(expect.objectContaining({
      id: "cap:model:local:scout-small",
      displayName: "Scout Small",
    }));
    expect(first.warnings).toEqual(["mcp warning", "model warning"]);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual(first);
  });

  test("loads fresh persisted cache before invoking discovery loaders", async () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-capability-persisted-"));
    const cachePath = join(home, "capability-matrix.json");
    const persisted = {
      generatedAt: 2_000,
      sources: [],
      capabilities: [],
      warnings: ["persisted"],
    };
    await writeFile(cachePath, `${JSON.stringify(persisted)}\n`, "utf8");
    const calls = { generated: 0 };
    const service = createService({
      now: () => 2_100,
      cachePath,
      calls,
    });

    await expect(service.read()).resolves.toEqual(persisted);
    expect(calls.generated).toBe(0);
  });

  test("force and zero TTL bypass caches", async () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-capability-force-"));
    const cachePath = join(home, "capability-matrix.json");
    let now = 3_000;
    const calls = { generated: 0 };
    const service = createService({
      now: () => now,
      cachePath,
      env: { OPENSCOUT_CAPABILITY_MATRIX_CACHE_TTL_MS: "0" },
      calls,
    });

    const first = await service.read();
    now = 3_001;
    const second = await service.read();
    const forced = await service.read({ force: true });

    expect(first.generatedAt).toBe(3_000);
    expect(second.generatedAt).toBe(3_001);
    expect(forced.generatedAt).toBe(3_001);
    expect(calls.generated).toBe(3);
  });
});
