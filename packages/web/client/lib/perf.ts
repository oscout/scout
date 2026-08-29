/**
 * Lightweight client performance instrumentation.
 *
 * Two signals feed one ring buffer: API request timings (recorded by
 * `lib/api.ts`) and route-transition paints (recorded by the router's
 * navigate choke point). Slow entries log to the console immediately;
 * the full buffer and per-path aggregates are reachable from DevTools
 * via `window.__scoutPerf.entries()` / `window.__scoutPerf.summary()`.
 */

export type ApiPerfEntry = {
  kind: "api";
  method: string;
  path: string;
  ms: number;
  bytes: number;
  ok: boolean;
  at: number;
};

export type NavPerfEntry = {
  kind: "nav";
  from: string;
  to: string;
  ms: number;
  at: number;
};

export type PerfEntry = ApiPerfEntry | NavPerfEntry;

const RING_MAX = 400;
const SLOW_API_MS = 600;
const SLOW_NAV_MS = 300;

const entries: PerfEntry[] = [];

function push(entry: PerfEntry): void {
  entries.push(entry);
  if (entries.length > RING_MAX) entries.splice(0, entries.length - RING_MAX);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (bytes >= 1_024) return `${Math.round(bytes / 1_024)}KB`;
  return `${bytes}B`;
}

/** Strip query params so aggregates group by endpoint, not by argument. */
function pathKey(path: string): string {
  const cut = path.indexOf("?");
  return cut === -1 ? path : path.slice(0, cut);
}

export function recordApiTiming(entry: Omit<ApiPerfEntry, "kind" | "at">): void {
  push({ kind: "api", at: Date.now(), ...entry });
  if (entry.ms >= SLOW_API_MS) {
    console.info(
      `[scout-perf] slow api ${entry.method} ${entry.path} ${Math.round(entry.ms)}ms ${formatBytes(entry.bytes)}${entry.ok ? "" : " (failed)"}`,
    );
  }
}

/**
 * Start timing a route transition. Completion is a double
 * requestAnimationFrame after the navigation publishes: the second frame
 * fires once the newly mounted route has committed and painted, which is
 * the "the app responded" moment — data fetched after mount shows up as
 * adjacent api entries, not in this number.
 */
export function beginNavTiming(from: string, to: string): void {
  if (typeof requestAnimationFrame !== "function") return;
  const startedAt = performance.now();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const ms = performance.now() - startedAt;
      push({ kind: "nav", from, to, ms, at: Date.now() });
      if (ms >= SLOW_NAV_MS) {
        console.info(`[scout-perf] slow nav ${from} -> ${to} ${Math.round(ms)}ms to first paint`);
      }
    });
  });
}

type PerfSummaryRow = {
  key: string;
  count: number;
  avgMs: number;
  maxMs: number;
  totalBytes: number;
};

export function perfSummary(): PerfSummaryRow[] {
  const byKey = new Map<string, { count: number; totalMs: number; maxMs: number; totalBytes: number }>();
  for (const entry of entries) {
    const key = entry.kind === "api" ? `${entry.method} ${pathKey(entry.path)}` : `nav ${entry.to}`;
    const row = byKey.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, totalBytes: 0 };
    row.count += 1;
    row.totalMs += entry.ms;
    row.maxMs = Math.max(row.maxMs, entry.ms);
    if (entry.kind === "api") row.totalBytes += entry.bytes;
    byKey.set(key, row);
  }
  return [...byKey.entries()]
    .map(([key, row]) => ({
      key,
      count: row.count,
      avgMs: Math.round(row.totalMs / row.count),
      maxMs: Math.round(row.maxMs),
      totalBytes: row.totalBytes,
    }))
    .sort((a, b) => b.maxMs - a.maxMs);
}

declare global {
  interface Window {
    __scoutPerf?: {
      entries: () => PerfEntry[];
      summary: () => PerfSummaryRow[];
    };
  }
}

if (typeof window !== "undefined") {
  window.__scoutPerf = {
    entries: () => [...entries],
    summary: perfSummary,
  };
}
