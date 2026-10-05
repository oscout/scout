import type { RuntimeEnv } from "./portable-types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseScoutRuntimeCatalog,
  SCOUT_RUNTIME_CATALOG,
  type ScoutOwnedRuntimeCatalog,
} from "@openscout/protocol";
import { applyRuntimeModelContextWindows } from "@openscout/agent-sessions/model-catalog";

import { assertTestIsolatedUserData, resolveOpenScoutSupportPaths } from "./support-paths.js";

export const DEFAULT_RUNTIME_CATALOG_REFRESH_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RUNTIME_CATALOG_URL = "https://openscout.app/.well-known/runtime-catalog.v1.json";
export const MAX_RUNTIME_CATALOG_BYTES = 1_048_576;

export type BrokerRuntimeCatalogSnapshot = {
  schemaVersion: "openscout.runtime-catalog-snapshot.v1";
  catalog: ScoutOwnedRuntimeCatalog;
  source: "remote" | "persisted" | "bundled";
  checkedAt: number;
  nextCheckAt: number;
  url: string;
  etag?: string;
  warnings: string[];
};

type PersistedRuntimeCatalog = {
  schemaVersion: "openscout.runtime-catalog-cache.v1";
  catalog: unknown;
  checkedAt: number;
  etag?: string;
  url?: string;
  warnings?: string[];
};

export type BrokerRuntimeCatalogServiceOptions = {
  env?: RuntimeEnv;
  now?: () => number;
  fetch?: typeof fetch;
  cachePath?: () => string;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeTextFile?: (path: string, content: string, encoding: BufferEncoding) => Promise<void>;
  ensureDirectory?: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export function resolveRuntimeCatalogRefreshMs(env: RuntimeEnv = process.env): number {
  const value = env.OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS?.trim();
  if (!value) return DEFAULT_RUNTIME_CATALOG_REFRESH_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RUNTIME_CATALOG_REFRESH_MS;
}

export function resolveRuntimeCatalogUrl(env: RuntimeEnv = process.env): string {
  return env.OPENSCOUT_RUNTIME_CATALOG_URL?.trim() || DEFAULT_RUNTIME_CATALOG_URL;
}

export function defaultRuntimeCatalogCachePath(): string {
  return join(resolveOpenScoutSupportPaths().catalogDirectory, "runtime-catalog-cache.v1.json");
}

export function compareRuntimeCatalogRevisions(a: string, b: string): number {
  const tokenize = (value: string): Array<string | number> => value
    .split(/([0-9]+)/u)
    .filter(Boolean)
    .map((part) => /^\d+$/u.test(part) ? Number(part) : part);
  const left = tokenize(a);
  const right = tokenize(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? "";
    const r = right[index] ?? "";
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l < r ? -1 : 1;
    return String(l).localeCompare(String(r));
  }
  return 0;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_CATALOG_BYTES) {
    throw new Error(`catalog body exceeds ${MAX_RUNTIME_CATALOG_BYTES} bytes`);
  }
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RUNTIME_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error(`catalog body exceeds ${MAX_RUNTIME_CATALOG_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

export class BrokerRuntimeCatalogService {
  private snapshot: BrokerRuntimeCatalogSnapshot | null = null;
  private loadPromise: Promise<BrokerRuntimeCatalogSnapshot> | null = null;
  private forceRequested = false;

  constructor(private readonly options: BrokerRuntimeCatalogServiceOptions = {}) {}

  async read(options: { force?: boolean } = {}): Promise<BrokerRuntimeCatalogSnapshot> {
    if (this.loadPromise) {
      if (options.force) this.forceRequested = true;
      return this.loadPromise;
    }
    const now = this.now();
    const refreshMs = resolveRuntimeCatalogRefreshMs(this.options.env);
    if (!options.force && this.snapshot && now < this.snapshot.nextCheckAt) return this.snapshot;
    this.forceRequested = options.force === true;
    this.loadPromise = this.readOrRefresh(now, refreshMs)
      .finally(() => { this.loadPromise = null; this.forceRequested = false; });
    return this.loadPromise;
  }

  private async readOrRefresh(now: number, refreshMs: number): Promise<BrokerRuntimeCatalogSnapshot> {
    const persisted = this.snapshot ?? await this.readPersisted(refreshMs, now);
    const bundled = this.bundled(now, refreshMs);
    const fallback = persisted
      && compareRuntimeCatalogRevisions(persisted.catalog.revision, bundled.catalog.revision) >= 0
      ? persisted : bundled;
    if (persisted && !this.forceRequested && now < persisted.nextCheckAt) {
      return this.remember({ ...fallback, checkedAt: persisted.checkedAt, nextCheckAt: persisted.nextCheckAt });
    }
    return this.refresh(now, refreshMs, fallback);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async refresh(now: number, refreshMs: number, fallback: BrokerRuntimeCatalogSnapshot): Promise<BrokerRuntimeCatalogSnapshot> {
    const url = resolveRuntimeCatalogUrl(this.options.env);
    try {
      const headers = new Headers({ accept: "application/json" });
      if (fallback.etag && fallback.url === url) headers.set("if-none-match", fallback.etag);
      const response = await (this.options.fetch ?? fetch)(url, {
        headers,
        cache: "no-cache",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 304) {
        if (!headers.has("if-none-match")) throw new Error("received 304 without a cached ETag");
        const unchanged = { ...fallback, checkedAt: now, nextCheckAt: now + refreshMs,
          etag: response.headers.get("etag") ?? fallback.etag, warnings: [] };
        this.remember(unchanged);
        await this.writePersisted(unchanged);
        return unchanged;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseScoutRuntimeCatalog(await readBoundedJson(response));
      if (!parsed.ok) throw new Error(parsed.errors.join("; "));
      const revisionOrder = compareRuntimeCatalogRevisions(parsed.catalog.revision, fallback.catalog.revision);
      if (revisionOrder < 0) {
        throw new Error(`stale revision ${parsed.catalog.revision} is older than ${fallback.catalog.revision}`);
      }
      if (revisionOrder === 0 && JSON.stringify(parsed.catalog) !== JSON.stringify(fallback.catalog)) {
        throw new Error(`revision ${parsed.catalog.revision} changed content without being incremented`);
      }
      const snapshot: BrokerRuntimeCatalogSnapshot = {
        schemaVersion: "openscout.runtime-catalog-snapshot.v1",
        catalog: parsed.catalog,
        source: "remote",
        checkedAt: now,
        nextCheckAt: now + refreshMs,
        url,
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        warnings: [],
      };
      this.remember(snapshot);
      await this.writePersisted(snapshot);
      return snapshot;
    } catch (error) {
      const failed = this.remember({
        ...fallback,
        checkedAt: now,
        nextCheckAt: now + refreshMs,
        url,
        // An ETag only validates contents at the endpoint that issued it.
        etag: fallback.url === url ? fallback.etag : undefined,
        warnings: [`Runtime catalog refresh failed; using ${fallback.source} revision ${fallback.catalog.revision}: ${error instanceof Error ? error.message : String(error)}`],
      });
      await this.writePersisted(failed);
      return failed;
    }
  }

  private bundled(now: number, refreshMs: number): BrokerRuntimeCatalogSnapshot {
    return {
      schemaVersion: "openscout.runtime-catalog-snapshot.v1",
      catalog: SCOUT_RUNTIME_CATALOG,
      source: "bundled",
      checkedAt: now,
      nextCheckAt: now + refreshMs,
      url: resolveRuntimeCatalogUrl(this.options.env),
      warnings: [],
    };
  }

  private remember(snapshot: BrokerRuntimeCatalogSnapshot): BrokerRuntimeCatalogSnapshot {
    const windows: Record<string, number> = {};
    for (const harness of snapshot.catalog.harnesses) {
      for (const model of harness.models) {
        if (model.contextWindowTokens) windows[model.id] = model.contextWindowTokens;
      }
    }
    applyRuntimeModelContextWindows(windows);
    this.snapshot = snapshot;
    return snapshot;
  }

  private async readPersisted(refreshMs: number, now: number): Promise<BrokerRuntimeCatalogSnapshot | null> {
    try {
      const raw = await (this.options.readTextFile ?? readFile)(
        (this.options.cachePath ?? defaultRuntimeCatalogCachePath)(),
        "utf8",
      );
      const cached = JSON.parse(raw) as PersistedRuntimeCatalog;
      if (cached.schemaVersion !== "openscout.runtime-catalog-cache.v1" || !Number.isFinite(cached.checkedAt)
        || cached.checkedAt < 0 || cached.checkedAt > now) return null;
      const parsed = parseScoutRuntimeCatalog(cached.catalog);
      if (!parsed.ok) return null;
      return {
        schemaVersion: "openscout.runtime-catalog-snapshot.v1",
        catalog: parsed.catalog,
        source: "persisted",
        checkedAt: cached.checkedAt,
        nextCheckAt: (cached.url ?? DEFAULT_RUNTIME_CATALOG_URL) !== resolveRuntimeCatalogUrl(this.options.env) ? 0 : cached.checkedAt + refreshMs,
        url: cached.url ?? DEFAULT_RUNTIME_CATALOG_URL,
        ...(typeof cached.etag === "string" ? { etag: cached.etag } : {}),
        warnings: Array.isArray(cached.warnings)
          ? cached.warnings.filter((warning): warning is string => typeof warning === "string") : [],
      };
    } catch {
      return null;
    }
  }

  private async writePersisted(snapshot: BrokerRuntimeCatalogSnapshot): Promise<void> {
    try {
      if (!this.options.writeTextFile && !this.options.cachePath) {
        assertTestIsolatedUserData("persist the runtime model catalog", "OPENSCOUT_SUPPORT_DIRECTORY");
      }
      const path = (this.options.cachePath ?? defaultRuntimeCatalogCachePath)();
      await (this.options.ensureDirectory ?? mkdir)(dirname(path), { recursive: true });
      const value: PersistedRuntimeCatalog = {
        schemaVersion: "openscout.runtime-catalog-cache.v1",
        catalog: snapshot.catalog,
        checkedAt: snapshot.checkedAt,
        url: snapshot.url,
        ...(snapshot.warnings.length ? { warnings: snapshot.warnings } : {}),
        ...(snapshot.etag ? { etag: snapshot.etag } : {}),
      };
      await (this.options.writeTextFile ?? writeFile)(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    } catch {
      // The in-memory and bundled catalogs remain valid if persistence fails.
    }
  }
}
