import { api } from "../../lib/api.ts";
import type { RepoDiffLayerKind, ScoutRepoDiffSnapshot } from "./types.ts";

export type RepoDiffCacheRecord = {
  snapshot: ScoutRepoDiffSnapshot;
  fetchedAt: number;
  cacheHit: boolean;
};

export type RepoDiffCacheRead = Omit<RepoDiffCacheRecord, "cacheHit"> & {
  ageMs: number;
  fresh: boolean;
};

const DEFAULT_LAYERS: RepoDiffLayerKind[] = ["branch", "unstaged", "staged"];
const DEFAULT_MAX_AGE_MS = 30_000;
const MAX_CACHE_ENTRIES = 24;
const DEFAULT_PREFETCH_LIMIT = 12;

const cache = new Map<string, Omit<RepoDiffCacheRecord, "cacheHit">>();
const inFlight = new Map<string, {
  force: boolean;
  request: Promise<RepoDiffCacheRecord>;
}>();
const queuedPrefetches = new Set<string>();
let prefetchQueue = Promise.resolve();

type RepoDiffRequestCacheMode = "prefer" | "reload" | "only";
export type RepoDiffRequestTier = "summary" | "patch";
export type RepoDiffSessionRequest = {
  sessionId?: string | null;
  agentId?: string | null;
  include?: "changed" | "all";
};
export type RepoDiffRequestOptions = {
  cache?: RepoDiffRequestCacheMode;
  rehydrate?: boolean;
  tier?: RepoDiffRequestTier;
  cacheScope?: string;
  files?: readonly string[];
  session?: RepoDiffSessionRequest | null;
};

export function buildRepoDiffUrl(
  path: string,
  layers: readonly RepoDiffLayerKind[] = DEFAULT_LAYERS,
  options: RepoDiffRequestOptions = {},
): string {
  const params = new URLSearchParams();
  if (options.session) {
    const sessionId = options.session.sessionId?.trim();
    const agentId = options.session.agentId?.trim();
    if (sessionId) params.set("sessionId", sessionId);
    if (agentId) params.set("agentId", agentId);
    if (options.session.include) params.set("include", options.session.include);
  } else {
    params.set("path", path);
    for (const file of options.files ?? []) {
      const trimmed = file.trim();
      if (trimmed) params.append("file", trimmed);
    }
  }
  for (const layer of layers) params.append("layer", layer);
  if (options.cache) params.set("cache", options.cache);
  if (options.rehydrate) params.set("rehydrate", "1");
  if (options.tier) params.set("tier", options.tier);
  return `/api/repo-diff/${options.session ? "session" : "worktree"}?${params.toString()}`;
}

function cacheKey(
  path: string,
  layers: readonly RepoDiffLayerKind[],
  options: Pick<RepoDiffRequestOptions, "files" | "session" | "tier" | "cacheScope"> = {},
): string {
  const scope = options.session
    ? `session:${options.session.sessionId ?? ""}:${options.session.agentId ?? ""}:${options.session.include ?? "changed"}`
    : `worktree:${(options.files ?? []).join("\n")}`;
  return `${path}\u0000${layers.join(",")}\u0000${options.tier ?? "summary"}\u0000${options.cacheScope ?? ""}\u0000${scope}`;
}

function trimCache(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function readRepoDiffCache(
  path: string,
  layers: readonly RepoDiffLayerKind[] = DEFAULT_LAYERS,
  options: Pick<RepoDiffRequestOptions, "files" | "session" | "tier" | "cacheScope"> = {},
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): RepoDiffCacheRead | null {
  const record = cache.get(cacheKey(path, layers, options));
  if (!record) return null;
  const ageMs = Math.max(0, Date.now() - record.fetchedAt);
  return {
    ...record,
    ageMs,
    fresh: ageMs <= maxAgeMs,
  };
}

export async function fetchRepoDiffSnapshot(
  path: string,
  layers: readonly RepoDiffLayerKind[] = DEFAULT_LAYERS,
  options: {
    force?: boolean;
    tier?: RepoDiffRequestTier;
    cacheScope?: string;
    files?: readonly string[];
    session?: RepoDiffSessionRequest | null;
  } = {},
): Promise<RepoDiffCacheRecord> {
  const key = cacheKey(path, layers, options);
  const active = inFlight.get(key);
  if (active && (!options.force || active.force)) {
    return active.request;
  }

  if (!options.force) {
    const existing = cache.get(key);
    if (existing && Date.now() - existing.fetchedAt <= DEFAULT_MAX_AGE_MS) {
      return { ...existing, cacheHit: true };
    }
  }

  const url = buildRepoDiffUrl(path, layers, {
    ...(options.force
      ? { cache: "reload" as const }
      : { cache: "prefer" as const, rehydrate: true }),
    files: options.files,
    session: options.session,
    tier: options.tier ?? "summary",
  });
  const request = api<ScoutRepoDiffSnapshot>(url).then((snapshot) => {
    const record = { snapshot, fetchedAt: Date.now() };
    cache.delete(key);
    cache.set(key, record);
    trimCache();
    return { ...record, cacheHit: false };
  });

  inFlight.set(key, { force: options.force === true, request });
  try {
    return await request;
  } finally {
    if (inFlight.get(key)?.request === request) {
      inFlight.delete(key);
    }
  }
}

export function prefetchRepoDiffSnapshot(
  path: string,
  layers: readonly RepoDiffLayerKind[] = DEFAULT_LAYERS,
): void {
  const key = cacheKey(path, layers, { tier: "summary" });
  if (readRepoDiffCache(path, layers, { tier: "summary" })?.fresh) return;
  if (inFlight.has(key) || queuedPrefetches.has(key)) return;
  queuedPrefetches.add(key);
  prefetchQueue = prefetchQueue
    .catch(() => undefined)
    .then(() => fetchRepoDiffSnapshot(path, layers).then(
      () => undefined,
      () => undefined,
    ))
    .finally(() => {
      queuedPrefetches.delete(key);
    });
}

export function prefetchRepoDiffSnapshots(
  paths: readonly string[],
  layers: readonly RepoDiffLayerKind[] = DEFAULT_LAYERS,
  options: { limit?: number } = {},
): void {
  const limit = Math.max(0, Math.min(options.limit ?? DEFAULT_PREFETCH_LIMIT, MAX_CACHE_ENTRIES));
  for (const path of paths.slice(0, limit)) {
    prefetchRepoDiffSnapshot(path, layers);
  }
}

export function repoDiffCacheAgeLabel(ageMs: number): string {
  if (ageMs < 5_000) return "just now";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
