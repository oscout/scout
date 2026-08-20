import type { RuntimeEnv } from "./portable-types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ScoutCapabilityMatrixSnapshot } from "@openscout/protocol";

import {
  buildHarnessReadinessProbeInputsFromCatalogSnapshot,
  buildHarnessSupportInputsFromCatalogSnapshot,
  buildRuntimeCapabilityMatrixSnapshot,
} from "./capability-matrix.js";
import { loadHarnessCatalogSnapshot, type HarnessCatalogSnapshot } from "./harness-catalog.js";
import { discoverConfiguredMcpServers } from "./mcp-discovery.js";
import {
  loadRuntimeMcpServerCatalog,
  type RuntimeMcpServerCatalogLoadResult,
} from "./mcp-server-catalog.js";
import {
  loadRuntimeModelCatalogInput,
  type RuntimeModelCatalogLoadResult,
} from "./model-catalog.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export const DEFAULT_CAPABILITY_MATRIX_CACHE_TTL_MS = 60_000;

export type BrokerCapabilityMatrixServiceOptions = {
  nodeId: string;
  env?: RuntimeEnv;
  now?: () => number;
  cachePath?: () => string;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeTextFile?: (path: string, content: string, encoding: BufferEncoding) => Promise<void>;
  ensureDirectory?: (path: string, options: { recursive: true }) => Promise<unknown>;
  loadHarnessCatalogSnapshot?: (options: { now: () => number }) => Promise<HarnessCatalogSnapshot>;
  loadRuntimeModelCatalogInput?: (options: { capturedAt: number }) => Promise<RuntimeModelCatalogLoadResult>;
  loadRuntimeMcpServerCatalog?: () => Promise<RuntimeMcpServerCatalogLoadResult>;
  discoverConfiguredMcpServers?: typeof discoverConfiguredMcpServers;
};

export function resolveCapabilityMatrixCacheTtlMs(
  env: RuntimeEnv = process.env,
): number {
  const raw = env.OPENSCOUT_CAPABILITY_MATRIX_CACHE_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_CAPABILITY_MATRIX_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_CAPABILITY_MATRIX_CACHE_TTL_MS;
}

export function defaultCapabilityMatrixCachePath(): string {
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "capability-matrix.json");
}

export function isCapabilityMatrixSnapshot(value: unknown): value is ScoutCapabilityMatrixSnapshot {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { generatedAt?: unknown }).generatedAt === "number"
    && Array.isArray((value as { sources?: unknown }).sources)
    && Array.isArray((value as { capabilities?: unknown }).capabilities)
    && Array.isArray((value as { warnings?: unknown }).warnings);
}

export function capabilityMatrixSnapshotIsFresh(
  snapshot: ScoutCapabilityMatrixSnapshot,
  now: number,
  ttlMs: number,
): boolean {
  return ttlMs > 0
    && Number.isFinite(snapshot.generatedAt)
    && now - snapshot.generatedAt >= 0
    && now - snapshot.generatedAt <= ttlMs;
}

export class BrokerCapabilityMatrixService {
  private cache: {
    snapshot: ScoutCapabilityMatrixSnapshot;
    cachedAt: number;
  } | null = null;

  constructor(private readonly options: BrokerCapabilityMatrixServiceOptions) {}

  async read(options: { force?: boolean } = {}): Promise<ScoutCapabilityMatrixSnapshot> {
    const now = this.now();
    const ttlMs = resolveCapabilityMatrixCacheTtlMs(this.options.env);
    if (!options.force && this.cache && capabilityMatrixSnapshotIsFresh(this.cache.snapshot, now, ttlMs)) {
      return this.cache.snapshot;
    }

    if (!options.force) {
      const persisted = await this.readPersisted(now, ttlMs);
      if (persisted) {
        this.cache = { snapshot: persisted, cachedAt: now };
        return persisted;
      }
    }

    const catalog = await this.loadHarnessCatalogSnapshot()({ now: () => now });
    const modelCatalog = await this.loadRuntimeModelCatalogInput()({ capturedAt: now });
    const mcpCatalog = await this.loadRuntimeMcpServerCatalog()();
    const mcpDiscovery = mcpCatalog.servers.length > 0
      ? await this.discoverConfiguredMcpServers()({
          servers: mcpCatalog.servers,
          scope: { machineId: this.options.nodeId },
          now: () => now,
        })
      : { inputs: [], warnings: [] };
    const inputs = [
      ...buildHarnessSupportInputsFromCatalogSnapshot(catalog),
      ...buildHarnessReadinessProbeInputsFromCatalogSnapshot(catalog),
      ...mcpDiscovery.inputs,
      ...(modelCatalog.input ? [modelCatalog.input] : []),
    ];
    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: catalog.generatedAt,
      scope: { machineId: this.options.nodeId },
      inputs,
      warnings: [
        ...mcpCatalog.warnings,
        ...mcpDiscovery.warnings,
        ...modelCatalog.warnings,
      ],
    });
    this.cache = { snapshot, cachedAt: now };
    if (ttlMs > 0) {
      await this.writePersisted(snapshot);
    }
    return snapshot;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private cachePath(): string {
    return (this.options.cachePath ?? defaultCapabilityMatrixCachePath)();
  }

  private loadHarnessCatalogSnapshot(): NonNullable<BrokerCapabilityMatrixServiceOptions["loadHarnessCatalogSnapshot"]> {
    return this.options.loadHarnessCatalogSnapshot ?? loadHarnessCatalogSnapshot;
  }

  private loadRuntimeModelCatalogInput(): NonNullable<BrokerCapabilityMatrixServiceOptions["loadRuntimeModelCatalogInput"]> {
    return this.options.loadRuntimeModelCatalogInput ?? loadRuntimeModelCatalogInput;
  }

  private loadRuntimeMcpServerCatalog(): NonNullable<BrokerCapabilityMatrixServiceOptions["loadRuntimeMcpServerCatalog"]> {
    return this.options.loadRuntimeMcpServerCatalog ?? loadRuntimeMcpServerCatalog;
  }

  private discoverConfiguredMcpServers(): NonNullable<BrokerCapabilityMatrixServiceOptions["discoverConfiguredMcpServers"]> {
    return this.options.discoverConfiguredMcpServers ?? discoverConfiguredMcpServers;
  }

  private async readPersisted(
    now: number,
    ttlMs: number,
  ): Promise<ScoutCapabilityMatrixSnapshot | null> {
    try {
      const raw = await (this.options.readTextFile ?? readFile)(this.cachePath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isCapabilityMatrixSnapshot(parsed) || !capabilityMatrixSnapshotIsFresh(parsed, now, ttlMs)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writePersisted(snapshot: ScoutCapabilityMatrixSnapshot): Promise<void> {
    try {
      const path = this.cachePath();
      await (this.options.ensureDirectory ?? mkdir)(dirname(path), { recursive: true });
      await (this.options.writeTextFile ?? writeFile)(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } catch {
      // Capability discovery is advisory; cache writes must not make broker reads fail.
    }
  }
}
