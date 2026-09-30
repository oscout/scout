import type { Hono } from "hono";
import { performance } from "node:perf_hooks";
import type { Context } from "hono";
import { relayEventStream } from "../server-core.ts";
import { resolveScoutBrokerUrl } from "../core/broker/service.ts";
import { scoutBrokerPaths } from "../core/broker/paths.ts";
import type { DiscoverySnapshot, TailDiscoveryScope } from "@openscout/runtime/tail";
import { snapshotRecentBroadcasts, subscribeBroadcast } from "../core/broadcast/service.ts";
import { createSignedScoutServicesRestartUrl, parseScoutServicesRestartTarget } from "../scout-services-deeplink.ts";
import { parseOptionalPositiveInt } from "../http-helpers.ts";
import { TailRecentPayload, BrokerJsonCache } from "../broker-json-cache.ts";

type ServerTimingMetric = {
  name: string;
  dur?: number;
  desc?: string;
};

const MAX_SERVER_TIMING_HEADER_LENGTH = 2048;

const TRUNCATED_SERVER_TIMING_HEADER = 'server-timing-truncated;desc="oversize"';

function serverTimingToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]+/g, "-") || "metric";
}

function serverTimingDescription(value: string): string {
  return value.replace(/["\\]/g, "");
}

function formatServerTiming(metrics: ServerTimingMetric[]): string {
  return metrics
    .filter((metric) => metric.name.trim())
    .map((metric) => {
      const parts = [serverTimingToken(metric.name)];
      if (metric.dur !== undefined && Number.isFinite(metric.dur)) {
        parts.push(`dur=${Math.max(0, metric.dur).toFixed(1)}`);
      }
      if (metric.desc?.trim()) {
        parts.push(`desc="${serverTimingDescription(metric.desc.trim())}"`);
      }
      return parts.join(";");
    })
    .join(", ");
}

function boundedServerTimingHeader(value: string): string {
  const trimmed = value.replace(/[\r\n]+/g, " ").trim();
  return trimmed.length <= MAX_SERVER_TIMING_HEADER_LENGTH
    ? trimmed
    : TRUNCATED_SERVER_TIMING_HEADER;
}

function appendServerTimingHeader(
  upstream: string | null,
  metrics: ServerTimingMetric[],
): string {
  const local = formatServerTiming(metrics);
  return boundedServerTimingHeader([
    upstream ? boundedServerTimingHeader(upstream) : null,
    local || null,
  ].filter(Boolean).join(", "));
}

const TAIL_DISCOVERY_SCOPES = new Set<TailDiscoveryScope>(["hot", "shallow", "deep"]);

function parseTailDiscoveryScope(value: string | undefined): TailDiscoveryScope | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return TAIL_DISCOVERY_SCOPES.has(normalized as TailDiscoveryScope)
    ? (normalized as TailDiscoveryScope)
    : undefined;
}

function tailDiscoveryProcessKey(source: string, cwd: string | null | undefined): string | null {
  const cleanCwd = cwd?.trim();
  return cleanCwd ? `${source}\u0000${cleanCwd}` : null;
}

function limitTailDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  limit: number | undefined,
): DiscoverySnapshot {
  if (!limit || limit <= 0) return snapshot;
  const transcripts = snapshot.transcripts.slice(0, limit);
  const transcriptProcessKeys = new Set(
    transcripts
      .map((transcript) => tailDiscoveryProcessKey(transcript.source, transcript.cwd))
      .filter((key): key is string => Boolean(key)),
  );
  const processIds = new Set<string>();
  const processes: DiscoverySnapshot["processes"] = [];
  for (const process of snapshot.processes) {
    const key = tailDiscoveryProcessKey(process.source, process.cwd);
    if (!key || !transcriptProcessKeys.has(key)) continue;
    const processId = `${process.source}\u0000${process.pid}`;
    if (processIds.has(processId)) continue;
    processIds.add(processId);
    processes.push(process);
    if (processes.length >= limit) break;
  }
  for (const process of snapshot.processes) {
    if (processes.length >= limit) break;
    const processId = `${process.source}\u0000${process.pid}`;
    if (processIds.has(processId)) continue;
    processIds.add(processId);
    processes.push(process);
  }
  return {
    ...snapshot,
    processes,
    transcripts,
  };
}

function createBrokerJsonCache<T>(): BrokerJsonCache<T> {
  return {
    data: null,
    inFlight: null,
    lastError: null,
    serverTiming: null,
    refreshedAt: null,
  };
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 180);
}

function scheduleBrokerJsonRefresh<T>(
  cache: BrokerJsonCache<T>,
  url: URL,
  label: string,
): Promise<void> {
  if (cache.inFlight) return cache.inFlight;
  const fetchStart = performance.now();
  cache.inFlight = (async () => {
    let upstreamTiming: string | null = null;
    const metrics: ServerTimingMetric[] = [];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      upstreamTiming = res.headers.get("server-timing");
      metrics.push({ name: "web-broker-fetch", dur: performance.now() - fetchStart });
      if (!res.ok) {
        throw new Error(`${label} unavailable (${res.status})`);
      }
      const parseStart = performance.now();
      const data = await res.json() as T;
      metrics.push({ name: "web-json", dur: performance.now() - parseStart });
      cache.data = data;
      cache.lastError = null;
      cache.refreshedAt = Date.now();
      cache.serverTiming = appendServerTimingHeader(upstreamTiming, metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cache.lastError = message;
      metrics.push({
        name: "web-broker-fetch",
        dur: performance.now() - fetchStart,
        desc: "error",
      });
      cache.serverTiming = appendServerTimingHeader(upstreamTiming, metrics);
    } finally {
      cache.inFlight = null;
    }
  })();
  return cache.inFlight;
}

function cachedBrokerJsonState<T>(cache: BrokerJsonCache<T>): string {
  if (cache.data) {
    if (cache.lastError) return cache.inFlight ? "stale-retrying" : "stale";
    return cache.inFlight ? "hit-refreshing" : "hit";
  }
  if (cache.lastError) return cache.inFlight ? "empty-retrying" : "empty-error";
  return cache.inFlight ? "empty-refreshing" : "empty";
}

async function serveCachedBrokerJson<T>(
  c: Context,
  cache: BrokerJsonCache<T>,
  url: URL,
  label: string,
  options: { forceRefresh?: boolean; transform?: (data: T) => T } = {},
): Promise<Response> {
  const start = performance.now();
  if (options.forceRefresh) {
    if (cache.inFlight) {
      await cache.inFlight;
    }
    await scheduleBrokerJsonRefresh(cache, url, label);
  } else {
    const refresh = scheduleBrokerJsonRefresh(cache, url, label);
    if (cache.data === null) {
      await refresh;
    }
  }
  const state = cachedBrokerJsonState(cache);
  c.header("Cache-Control", "no-store");
  c.header("X-OpenScout-Tail-State", state);
  if (cache.lastError) {
    c.header("X-OpenScout-Tail-Warning", headerSafe(cache.lastError));
  }
  c.header("Server-Timing", appendServerTimingHeader(cache.serverTiming, [{
    name: "web-tail-cache",
    dur: performance.now() - start,
    desc: state,
  }]));
  if (cache.data === null) {
    return c.json({
      error: `${label} unavailable`,
      ...(cache.lastError ? { detail: cache.lastError } : {}),
    }, 502);
  }
  const data = options.transform ? options.transform(cache.data) : cache.data;
  return c.json(data);
}

export function mountStreamRoutes(app: Hono) {
  const tailDiscoveryCaches = new Map<string, BrokerJsonCache<DiscoverySnapshot>>();
  const tailRecentCaches = new Map<string, BrokerJsonCache<TailRecentPayload>>();

  app.get("/api/events", async (c) => {
    const brokerUrl = resolveScoutBrokerUrl();
    try {
      return await relayEventStream(`${brokerUrl}/v1/events/stream`, {
        signal: c.req.raw.signal,
      });
    } catch {
      return c.text("Broker unreachable", 502);
    }
  });

  app.get("/api/tail/discover", async (c) => {
    const url = new URL(scoutBrokerPaths.v1.tailDiscover, resolveScoutBrokerUrl());
    const forceRefresh = c.req.query("force") === "true" || c.req.query("force") === "1";
    const scope = parseTailDiscoveryScope(c.req.query("scope"));
    const limitParam = parseOptionalPositiveInt(c.req.query("limit"));
    if (forceRefresh) {
      url.searchParams.set("force", "1");
    }
    if (scope) {
      url.searchParams.set("scope", scope);
    }
    if (limitParam !== undefined) {
      url.searchParams.set("limit", String(limitParam));
    }
    const cacheKey = `scope=${scope ?? "default"};limit=${limitParam ?? "all"}`;
    let cache = tailDiscoveryCaches.get(cacheKey);
    if (!cache) {
      cache = createBrokerJsonCache<DiscoverySnapshot>();
      tailDiscoveryCaches.set(cacheKey, cache);
    }
    return serveCachedBrokerJson(
      c,
      cache,
      url,
      "broker tail discovery",
      {
        forceRefresh,
        transform: (data) => limitTailDiscoverySnapshot(data, limitParam),
      },
    );
  });

  app.get("/api/repo-watch", async (c) => {
    const url = new URL(scoutBrokerPaths.v1.repoWatchSnapshot, resolveScoutBrokerUrl());
    for (const key of ["force", "includeTail", "includeDiff", "includeLastCommit", "native"]) {
      const value = c.req.query(key);
      if (value === "1" || value === "true") url.searchParams.set(key, "1");
    }
    for (const key of ["maxRoots", "maxWorktrees", "maxFilesPerWorktree", "scanBudgetMs"]) {
      const value = parseOptionalPositiveInt(c.req.query(key));
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    try {
      const res = await fetch(url, { signal: c.req.raw.signal });
      if (!res.ok) {
        return c.json({ error: `broker repo-watch unavailable (${res.status})` }, 502);
      }
      return c.json(await res.json());
    } catch {
      return c.json({ error: "broker repo-watch unavailable" }, 502);
    }
  });

  app.post("/api/scout-services/restart-link", async (c) => {
    let target = parseScoutServicesRestartTarget(c.req.query("target"));
    if (!target) {
      try {
        const body = await c.req.json<{ target?: string }>();
        target = parseScoutServicesRestartTarget(body.target);
      } catch {
        // Body is optional; query-string target is enough.
      }
    }

    if (!target) {
      return c.json({ error: "unsupported Scout Services restart target" }, 400);
    }

    return c.json(createSignedScoutServicesRestartUrl(target));
  });

  app.get("/api/tail/recent", async (c) => {
    const limitParam = parseOptionalPositiveInt(c.req.query("limit"), 500) ?? 500;
    const includeTranscripts = c.req.query("transcripts") === "true" || c.req.query("transcripts") === "1";
    const mode = c.req.query("mode") === "assistant-replies" ? "assistant-replies" : null;
    const requestedWindowMs = parseOptionalPositiveInt(c.req.query("windowMs"));
    const windowMs = requestedWindowMs === undefined
      ? undefined
      : Math.min(requestedWindowMs, 24 * 60 * 60 * 1_000);
    const url = new URL(scoutBrokerPaths.v1.tailRecent, resolveScoutBrokerUrl());
    url.searchParams.set("limit", String(limitParam));
    if (includeTranscripts) {
      url.searchParams.set("transcripts", "true");
    }
    if (mode) {
      url.searchParams.set("mode", mode);
    }
    if (windowMs !== undefined) {
      url.searchParams.set("windowMs", String(windowMs));
    }
    const cacheKey = `limit=${limitParam};transcripts=${includeTranscripts ? "1" : "0"};mode=${mode ?? "all"};window=${windowMs ?? "all"}`;
    let cache = tailRecentCaches.get(cacheKey);
    if (!cache) {
      cache = createBrokerJsonCache<TailRecentPayload>();
      tailRecentCaches.set(cacheKey, cache);
    }
    return serveCachedBrokerJson(
      c,
      cache,
      url,
      "broker tail",
    );
  });

  // /api/tail/stream removed — clients now subscribe to broker tail.events
  // directly via tRPC over WebSocket. See packages/web/client/lib/tail-events.ts.

  app.get("/api/broadcast/recent", (c) => {
    const limitParam = parseOptionalPositiveInt(c.req.query("limit"), 50) ?? 50;
    return c.json({ broadcasts: snapshotRecentBroadcasts(limitParam) });
  });

  app.get("/api/broadcast/stream", (c) => {
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        };

        const recent = snapshotRecentBroadcasts(50);
        for (const broadcast of recent) {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(broadcast)}\n\n`));
        }
        safeEnqueue(
          encoder.encode(`event: ready\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`),
        );

        const unsubscribe = subscribeBroadcast((broadcast) => {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(broadcast)}\n\n`));
        });

        const heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
        }, 15_000);

        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        signal.addEventListener("abort", close, { once: true });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}
