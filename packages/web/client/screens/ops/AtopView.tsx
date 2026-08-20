/**
 * Atop — agent activity inventory.
 *
 * Sibling of TailView. Where Tail is a time-ordered firehose ("what just
 * happened?"), Atop is the agent-level view ("what is each agent actually
 * doing — how much it's spending, what tools, how many requests, how often
 * it's asking for permission").
 *
 * Row identity = one currently-running agent (today: a Claude process with
 * its active session). Columns surface agent-life metrics: requests, tokens,
 * cache hits, tool calls, permission requests, last activity. Process
 * details (pid, parent chain, command) are still useful — they sit in the
 * drawer behind the agent row.
 *
 * **Data contract — backend grow points:**
 * Some columns (Model, Tok↓, Tok↑, Cache%) render `—` until TailEvent grows
 * to carry: `model`, `usage.input_tokens`, `usage.output_tokens`,
 * `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`. When
 * those land on the event, populate them in `deriveRows` and the columns
 * light up automatically.
 *
 * Permission requests are currently heuristic (string-matching
 * "permission-mode" in summaries). When backend adds a dedicated
 * `permission` event kind, swap the heuristic for an exact count.
 */

import "./ops-atop.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DataTable, type DataTableColumn } from "../../components/DataTable/DataTable.tsx";
import { HarnessMark, harnessLabel } from "../../components/HarnessMark.tsx";
import { ObservedTopologyPanel } from "../../components/ObservedTopologyPanel.tsx";
import { api } from "../../lib/api.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../../lib/surface-activity.ts";
import { formatClockTimestamp, timeAgoWithSuffix } from "../../lib/time.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import type {
  TailDiscoverySnapshot,
  TailDiscoveredProcess,
  TailDiscoveredTranscript,
  TailEvent,
} from "../../lib/types.ts";

/* ── Tunables ── */

const EVENT_BUFFER_LIMIT = 4_000;
const RECENT_REPLAY_LIMIT = 500;
const DISCOVERY_INTERVAL_MS = 5_000;
const ACTIVE_WINDOW_MS = 5_000;
const REQ_RATE_WINDOW_MS = 60_000;
const SUMMARY_SAMPLE_BARS = 24;
const PEEK_LINE_LIMIT = 40;

/* ── Derived view-model ── */

type AtopStatus = "tool" | "run" | "idle";

type AtopRow = {
  key: string;
  /* identity — process + session combined */
  pid: number;
  ppid: number;
  sessionId: string | null;
  transcriptPath: string | null;
  harness: string;
  attribution: TailEvent["harness"];
  project: string;
  cwd: string;
  command: string;
  parentLabel: string;

  /* lifetime */
  procRuntimeSec: number;       // process etime from `ps`
  procEtime: string;
  sessionStartAt: number | null; // first event seen for this pid in buffer
  sessionRuntimeSec: number;     // lastEventAt - sessionStartAt (capped at procRuntime)

  /* current state */
  status: AtopStatus;
  lastEventAt: number | null;
  lastEventKind: string | null;
  lastSummary: string | null;

  /* agent activity (real, derivable now) */
  reqCount: number;       // count of assistant events  → ≈ model invocations
  toolCount: number;      // count of tool-call events
  permCount: number;      // count of permission-mode events (heuristic)
  eventCount: number;

  /* agent activity (backend grow-points — rendered as `—` when null) */
  model: string | null;
  tokIn: number | null;
  tokOut: number | null;
  cacheReadIn: number | null;
  cacheWriteIn: number | null;
};

type AtopSummary = {
  total: number;
  running: number; // run | tool
  tooling: number; // tool only
  idle: number;
  harnesses: Array<{ harness: string; count: number }>;
  reqsPerMin: number;
};

type TailAttribution = TailEvent["harness"];

const ATTRIBUTION_LABEL: Record<TailAttribution, string> = {
  "scout-managed": "scout",
  "hudson-managed": "hudson",
  unattributed: "native",
};

const STATUS_LABEL: Record<AtopStatus, string> = {
  tool: "working",
  run: "active",
  idle: "idle",
};

/* ── Format helpers ── */

function commandBasename(command: string): string {
  const head = command.split(/\s+/)[0] ?? "";
  const slashIdx = head.lastIndexOf("/");
  return slashIdx >= 0 ? head.slice(slashIdx + 1) : head;
}

function shortCommand(command: string, max = 60): string {
  // Strip leading executable path; keep args trimmed.
  const tokens = command.split(/\s+/);
  if (tokens.length === 0) return command;
  tokens[0] = commandBasename(tokens[0]);
  const flat = tokens.join(" ");
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function parentLabelFromChain(
  chain: { pid: number; command: string }[],
): string {
  for (const ancestor of chain) {
    const base = commandBasename(ancestor.command);
    if (!base) continue;
    if (base === "sh" || base === "zsh" || base === "bash" || base === "login") continue;
    return base;
  }
  return chain[0]?.command ? commandBasename(chain[0].command) : "—";
}

function parseEtimeSeconds(etime: string): number {
  // ps etime forms: SS, MM:SS, HH:MM:SS, DD-HH:MM:SS
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) {
    const justSec = etime.match(/^(\d+)$/);
    if (justSec) return Number.parseInt(justSec[1], 10);
    return 0;
  }
  const [, dd, hh, mm, ss] = m;
  let total = Number.parseInt(ss, 10) + Number.parseInt(mm, 10) * 60;
  if (hh) total += Number.parseInt(hh, 10) * 3600;
  if (dd) total += Number.parseInt(dd, 10) * 86400;
  return total;
}

function formatRuntime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h${String(m).padStart(2, "0")}`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return `${d}d${String(h).padStart(2, "0")}h`;
}

function formatRelative(ms: number | null, now: number): string {
  return timeAgoWithSuffix(ms, now) || "—";
}

function formatTimestamp(ts: number): string {
  return formatClockTimestamp(ts) || "—";
}

function shortSession(sessionId: string | null): string {
  if (!sessionId) return "—";
  return sessionId.slice(0, 8);
}

function displayHarness(source: string | null | undefined): string {
  return source?.trim().toLowerCase() || "unknown";
}

function classPart(value: string): string {
  return displayHarness(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function harnessChipClass(harness: string): string {
  return `s-atop-chip s-atop-chip--harness s-atop-chip--harness-${classPart(harness)}`;
}

/* ── Derive ──
 *
 * One row per currently-running agent (process). Per-pid stats are folded out
 * of the event buffer in a single pass so cost is O(events) per render.
 *
 * To unlock the placeholder columns (Model, Tok↓, Tok↑, Cache%) once the
 * backend extends `TailEvent`:
 *   - `model`: take from the latest event that carries it (assistant events).
 *   - `tokIn` / `tokOut`: sum `usage.input_tokens` and `usage.output_tokens`
 *     across all assistant events for the pid.
 *   - `cacheReadIn` / `cacheWriteIn`: sum `usage.cache_read_input_tokens` and
 *     `usage.cache_creation_input_tokens` similarly. Cache hit rate is a
 *     render-time derivation: cacheReadIn / (cacheReadIn + tokIn).
 */

const PERMISSION_HINT = /permission-mode/i;

type EventStats = {
  firstEventAt: number;
  lastEventAt: number;
  lastKind: string;
  lastSummary: string;
  reqCount: number;
  toolCount: number;
  permCount: number;
  eventCount: number;
  sessionId: string | null;
  model: string | null;
  tokIn: number | null;
  tokOut: number | null;
  cacheReadIn: number | null;
  cacheWriteIn: number | null;
};

function isPermissionEvent(event: TailEvent): boolean {
  if (event.kind !== "system") return false;
  return PERMISSION_HINT.test(event.summary);
}

function isRequestEvent(event: TailEvent): boolean {
  // One assistant turn ≈ one model invocation ≈ one billable request.
  return event.kind === "assistant";
}

function deriveRows(
  discovery: TailDiscoverySnapshot | null,
  events: TailEvent[],
  now: number,
): AtopRow[] {
  if (!discovery) return [];

  const byPid = new Map<number, EventStats>();
  const bySession = new Map<string, EventStats>();
  for (const event of events) {
    let stats = byPid.get(event.pid);
    if (!stats) {
      stats = {
        firstEventAt: event.ts,
        lastEventAt: event.ts,
        lastKind: event.kind,
        lastSummary: event.summary,
        reqCount: 0,
        toolCount: 0,
        permCount: 0,
        eventCount: 0,
        sessionId: event.sessionId || null,
        model: null,
        tokIn: null,
        tokOut: null,
        cacheReadIn: null,
        cacheWriteIn: null,
      };
      byPid.set(event.pid, stats);
    }
    if (event.ts < stats.firstEventAt) stats.firstEventAt = event.ts;
    if (event.ts >= stats.lastEventAt) {
      stats.lastEventAt = event.ts;
      stats.lastKind = event.kind;
      stats.lastSummary = event.summary;
    }
    stats.eventCount++;
    if (event.kind === "tool") stats.toolCount++;
    if (isRequestEvent(event)) stats.reqCount++;
    if (isPermissionEvent(event)) stats.permCount++;
    if (event.sessionId && !stats.sessionId) stats.sessionId = event.sessionId;

    if (event.sessionId) {
      let sessionStats = bySession.get(event.sessionId);
      if (!sessionStats) {
        sessionStats = {
          firstEventAt: event.ts,
          lastEventAt: event.ts,
          lastKind: event.kind,
          lastSummary: event.summary,
          reqCount: 0,
          toolCount: 0,
          permCount: 0,
          eventCount: 0,
          sessionId: event.sessionId,
          model: null,
          tokIn: null,
          tokOut: null,
          cacheReadIn: null,
          cacheWriteIn: null,
        };
        bySession.set(event.sessionId, sessionStats);
      }
      if (event.ts < sessionStats.firstEventAt) sessionStats.firstEventAt = event.ts;
      if (event.ts >= sessionStats.lastEventAt) {
        sessionStats.lastEventAt = event.ts;
        sessionStats.lastKind = event.kind;
        sessionStats.lastSummary = event.summary;
      }
      sessionStats.eventCount++;
      if (event.kind === "tool") sessionStats.toolCount++;
      if (isRequestEvent(event)) sessionStats.reqCount++;
      if (isPermissionEvent(event)) sessionStats.permCount++;
    }
  }

  const processByCwd = new Map<string, TailDiscoveredProcess>();
  for (const proc of discovery.processes) {
    if (!proc.cwd) continue;
    const key = sourceCwdKey(proc.source, proc.cwd);
    const current = processByCwd.get(key);
    if (!current || proc.pid < current.pid) {
      processByCwd.set(key, proc);
    }
  }

  const latestTranscriptKeyByCwd = new Map<string, string>();
  const latestTranscriptMtimeByCwd = new Map<string, number>();
  for (const transcript of discovery.transcripts ?? []) {
    const cwdKey = sourceCwdKey(transcript.source, transcript.cwd);
    const rowKey = rowKeyForTranscript(transcript);
    const currentMtime = latestTranscriptMtimeByCwd.get(cwdKey) ?? Number.NEGATIVE_INFINITY;
    const currentKey = latestTranscriptKeyByCwd.get(cwdKey) ?? "";
    if (transcript.mtimeMs > currentMtime || (transcript.mtimeMs === currentMtime && rowKey > currentKey)) {
      latestTranscriptMtimeByCwd.set(cwdKey, transcript.mtimeMs);
      latestTranscriptKeyByCwd.set(cwdKey, rowKey);
    }
  }

  const usedProcessIds = new Set<number>();

  const buildRow = (
    key: string,
    proc: TailDiscoveredProcess | null,
    stats: EventStats | undefined,
    transcript: TailDiscoveredTranscript | null,
  ): AtopRow => {
    if (proc) {
      usedProcessIds.add(proc.pid);
    }
    let status: AtopStatus = "idle";
    const lastActivityAt = Math.max(stats?.lastEventAt ?? 0, transcript?.mtimeMs ?? 0);
    if (stats) {
      const fresh = now - stats.lastEventAt < ACTIVE_WINDOW_MS;
      if (fresh) status = stats.lastKind === "tool" ? "tool" : "run";
    }
    if (status === "idle" && now - lastActivityAt < 60_000) {
      status = "run";
    }
    const procRuntimeSec = proc ? parseEtimeSeconds(proc.etime) : 0;
    const sessionStartAt = stats?.firstEventAt ?? null;
    const sessionRuntimeSec = stats && stats.firstEventAt < stats.lastEventAt
      ? Math.min(
          Math.max(0, Math.round((stats.lastEventAt - stats.firstEventAt) / 1000)),
          procRuntimeSec || Number.POSITIVE_INFINITY,
        )
      : 0;
    const pid = proc?.pid ?? virtualPidForKey(key);
    const cwd = transcript?.cwd ?? proc?.cwd ?? "";
    return {
      key,
      pid,
      ppid: proc?.ppid ?? 0,
      sessionId: transcript?.sessionId ?? stats?.sessionId ?? null,
      transcriptPath: transcript?.transcriptPath ?? null,
      harness: displayHarness(transcript?.source ?? proc?.source),
      attribution: proc?.harness ?? transcript?.harness ?? "unattributed",
      project: transcript?.project?.trim() || (cwd ? basename(cwd) : "(unknown)"),
      cwd,
      command: proc?.command ?? `${transcript?.source ?? "unknown"} transcript`,
      parentLabel: proc ? parentLabelFromChain(proc.parentChain ?? []) : "transcript",
      procRuntimeSec,
      procEtime: proc?.etime ?? "0",
      sessionStartAt,
      sessionRuntimeSec,
      status,
      lastEventAt: lastActivityAt || null,
      lastEventKind: stats?.lastKind ?? null,
      lastSummary: stats?.lastSummary ?? null,
      reqCount: stats?.reqCount ?? 0,
      toolCount: stats?.toolCount ?? 0,
      permCount: stats?.permCount ?? 0,
      eventCount: stats?.eventCount ?? 0,
      model: stats?.model ?? null,
      tokIn: stats?.tokIn ?? null,
      tokOut: stats?.tokOut ?? null,
      cacheReadIn: stats?.cacheReadIn ?? null,
      cacheWriteIn: stats?.cacheWriteIn ?? null,
    };
  };

  const transcriptRows = (discovery.transcripts ?? []).map((transcript) => {
    const key = rowKeyForTranscript(transcript);
    const cwdKey = sourceCwdKey(transcript.source, transcript.cwd);
    const proc = latestTranscriptKeyByCwd.get(cwdKey) === key
      ? processByCwd.get(cwdKey) ?? null
      : null;
    const stats = transcript.sessionId ? bySession.get(transcript.sessionId) : undefined;
    return buildRow(key, proc, stats, transcript);
  });

  const processRows = discovery.processes
    .filter((proc) => !usedProcessIds.has(proc.pid))
    .map((proc) => buildRow(rowKeyForProcess(proc), proc, byPid.get(proc.pid), null));

  return [...transcriptRows, ...processRows];
}

function cacheHitRate(row: AtopRow): number | null {
  // cache_read / (cache_read + input). Returns null until backend feeds
  // both numerators in.
  if (row.cacheReadIn == null || row.tokIn == null) return null;
  const denom = row.cacheReadIn + row.tokIn;
  if (denom === 0) return null;
  return row.cacheReadIn / denom;
}

function fmtCount(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${Math.round(n * 100)}%`;
}

function basename(p: string): string {
  if (!p) return "";
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function rowKeyForTranscript(transcript: TailDiscoveredTranscript): string {
  return `session:${transcript.source}:${transcript.sessionId ?? transcript.transcriptPath}`;
}

function rowKeyForProcess(process: TailDiscoveredProcess): string {
  return `process:${process.source}:${process.pid}`;
}

function virtualPidForKey(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return -((hash >>> 0) % 900_000 + 1_000);
}

function sourceCwdKey(source: string, cwd: string | null | undefined): string {
  return `${source}\0${cwd ?? ""}`;
}

function summarize(rows: AtopRow[], events: TailEvent[], now: number): AtopSummary {
  const cutoff = now - REQ_RATE_WINDOW_MS;
  let reqEvents = 0;
  for (const event of events) {
    if (!isRequestEvent(event)) continue;
    if (event.ts >= cutoff) reqEvents++;
  }
  const summary: AtopSummary = {
    total: rows.length,
    running: 0,
    tooling: 0,
    idle: 0,
    harnesses: [],
    reqsPerMin: reqEvents,
  };
  const harnessCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.status === "tool") {
      summary.tooling++;
      summary.running++;
    } else if (row.status === "run") {
      summary.running++;
    } else {
      summary.idle++;
    }
    harnessCounts.set(row.harness, (harnessCounts.get(row.harness) ?? 0) + 1);
  }
  summary.harnesses = [...harnessCounts.entries()]
    .map(([harness, count]) => ({ harness, count }))
    .sort((a, b) => b.count - a.count || a.harness.localeCompare(b.harness));
  return summary;
}

/* ── Sorting ── */

type SortKey =
  | "status"
  | "agent"
  | "project"
  | "reqs"
  | "tokIn"
  | "tokOut"
  | "cache"
  | "tools"
  | "perms"
  | "last"
  | "runtime";

const STATUS_RANK: Record<AtopStatus, number> = { tool: 0, run: 1, idle: 2 };

function nullishNum(n: number | null | undefined): number {
  return n == null ? -1 : n;
}

function compare(a: AtopRow, b: AtopRow, key: SortKey, dir: 1 | -1): number {
  switch (key) {
    case "status":
      return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * dir;
    case "agent": {
      // Use harness then short session for stable ordering.
      const ha = a.harness.localeCompare(b.harness);
      if (ha !== 0) return ha * dir;
      return (a.sessionId ?? "").localeCompare(b.sessionId ?? "") * dir;
    }
    case "project":
      return a.project.localeCompare(b.project) * dir;
    case "reqs":
      return (a.reqCount - b.reqCount) * dir;
    case "tokIn":
      return (nullishNum(a.tokIn) - nullishNum(b.tokIn)) * dir;
    case "tokOut":
      return (nullishNum(a.tokOut) - nullishNum(b.tokOut)) * dir;
    case "cache":
      return (nullishNum(cacheHitRate(a)) - nullishNum(cacheHitRate(b))) * dir;
    case "tools":
      return (a.toolCount - b.toolCount) * dir;
    case "perms":
      return (a.permCount - b.permCount) * dir;
    case "last": {
      const av = a.lastEventAt ?? 0;
      const bv = b.lastEventAt ?? 0;
      return (av - bv) * dir;
    }
    case "runtime":
      return (a.sessionRuntimeSec - b.sessionRuntimeSec) * dir;
  }
}

/* ── Sparkline ── */

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 88;
  const h = 18;
  if (values.length < 2) {
    return <svg className="s-atop-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} />;
  }
  const max = Math.max(1, ...values);
  const dx = w / (values.length - 1);
  const pts = values
    .map((v, i) => `${(i * dx).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="s-atop-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline fill="none" stroke={color} strokeWidth="1.25" points={pts} />
    </svg>
  );
}

/* ── Main view ── */

export function AtopView() {
  const [events, setEvents] = useState<TailEvent[]>([]);
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [search, setSearch] = useState("");
  const [harnessFilter, setHarnessFilter] = useState<Set<string>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<Set<AtopStatus>>(() => new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "status", dir: 1 });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const runHistoryRef = useRef<number[]>([]);
  const toolHistoryRef = useRef<number[]>([]);
  const [runHistory, setRunHistory] = useState<number[]>([]);
  const [toolHistory, setToolHistory] = useState<number[]>([]);

  /* event ingestion */
  const handleEvent = useCallback((event: TailEvent) => {
    setEvents((prev) => {
      const next = prev.length >= EVENT_BUFFER_LIMIT
        ? [...prev.slice(prev.length - EVENT_BUFFER_LIMIT + 1), event]
        : [...prev, event];
      return next;
    });
  }, []);
  useTailEvents(handleEvent);

  /* initial replay */
  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    const loadRecent = async () => {
      if (loaded || !isScoutSurfaceActive()) return;
      try {
        const result = await api<{ events: TailEvent[] }>(
          `/api/tail/recent?limit=${RECENT_REPLAY_LIMIT}`,
        );
        if (!cancelled) {
          loaded = true;
          setEvents(result.events ?? []);
        }
      } catch {
        /* swallow */
      }
    };
    void loadRecent();
    const stopActivationListener = onScoutSurfaceActivated(() => void loadRecent());
    return () => {
      cancelled = true;
      stopActivationListener();
    };
  }, []);

  /* polled discovery */
  const loadDiscovery = useCallback(async () => {
    if (!isScoutSurfaceActive()) return;
    try {
      const snap = await api<TailDiscoverySnapshot>("/api/tail/discover");
      setDiscovery(snap);
    } catch {
      /* swallow */
    }
  }, []);
  useEffect(() => {
    void loadDiscovery();
    const id = setInterval(() => void loadDiscovery(), DISCOVERY_INTERVAL_MS);
    const stopActivationListener = onScoutSurfaceActivated(() => void loadDiscovery());
    return () => {
      clearInterval(id);
      stopActivationListener();
    };
  }, [loadDiscovery]);

  /* clock ticker so "12s ago" stays fresh */
  useEffect(() => {
    const id = setInterval(() => {
      if (isScoutSurfaceActive()) setNow(Date.now());
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  /* derive */
  const rows = useMemo(
    () => deriveRows(discovery, events, now),
    [discovery, events, now],
  );
  const summary = useMemo(() => summarize(rows, events, now), [rows, events, now]);

  /* sample summary into sparklines */
  useEffect(() => {
    runHistoryRef.current = [...runHistoryRef.current, summary.running].slice(-SUMMARY_SAMPLE_BARS);
    toolHistoryRef.current = [...toolHistoryRef.current, summary.tooling].slice(-SUMMARY_SAMPLE_BARS);
    setRunHistory(runHistoryRef.current);
    setToolHistory(toolHistoryRef.current);
  }, [summary.running, summary.tooling]);

  /* available filter options (only show pills for axes that have variety) */
  const harnessOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((row) => set.add(row.harness));
    return [...set];
  }, [rows]);

  const statusOptions = useMemo(() => {
    const set = new Set<AtopStatus>();
    rows.forEach((row) => set.add(row.status));
    return [...set];
  }, [rows]);

  /* filter + sort */
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (harnessFilter.size > 0 && !harnessFilter.has(row.harness)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(row.status)) return false;
      if (!q) return true;
      const attribution = ATTRIBUTION_LABEL[row.attribution];
      const hay = `${row.pid} ${row.project} ${row.command} ${row.harness} ${row.attribution} ${attribution} ${row.sessionId ?? ""} ${row.transcriptPath ?? ""} ${row.lastSummary ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, harnessFilter, statusFilter]);

  const secondarySort = useMemo(
    () => (sort.key === "status" ? undefined : (a: AtopRow, b: AtopRow) => STATUS_RANK[a.status] - STATUS_RANK[b.status]),
    [sort.key],
  );

  const displayRows = useMemo(() => (
    filteredRows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const primary = compare(left.row, right.row, sort.key, sort.dir);
        if (primary !== 0) return primary;
        const secondary = secondarySort?.(left.row, right.row) ?? 0;
        if (secondary !== 0) return secondary;
        return left.index - right.index;
      })
      .map((entry) => entry.row)
  ), [filteredRows, sort, secondarySort]);

  /* keep selected row valid */
  useEffect(() => {
    if (selectedKey == null) return;
    if (!rows.some((row) => row.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [rows, selectedKey]);

  /* keyboard nav */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target?.isContentEditable ?? false);
      if (event.key === "Escape" && selectedKey != null) {
        event.preventDefault();
        setSelectedKey(null);
        return;
      }
      if (inEditable) return;
      const isDown = event.key === "j" || event.key === "ArrowDown";
      const isUp = event.key === "k" || event.key === "ArrowUp";
      if (isDown || isUp) {
        if (displayRows.length === 0) return;
        event.preventDefault();
        const idx = displayRows.findIndex((row) => row.key === selectedKey);
        const next = isDown
          ? displayRows[Math.min(displayRows.length - 1, idx < 0 ? 0 : idx + 1)]
          : displayRows[Math.max(0, idx < 0 ? 0 : idx - 1)];
        if (next) setSelectedKey(next.key);
        return;
      }
      if (event.key === "Enter" && selectedKey != null) {
        event.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [displayRows, selectedKey]);

  const toggleHarness = (harness: string) => {
    setHarnessFilter((prev) => {
      const next = new Set(prev);
      if (next.has(harness)) next.delete(harness);
      else next.add(harness);
      return next;
    });
  };
  const toggleStatus = (status: AtopStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const selectedRow = useMemo(
    () => (selectedKey != null ? rows.find((row) => row.key === selectedKey) ?? null : null),
    [rows, selectedKey],
  );
  const selectedProcess = useMemo(
    () => (selectedRow
      ? discovery?.processes.find((process) => process.pid === selectedRow.pid) ?? null
      : null),
    [discovery, selectedRow],
  );
  const selectedEvents = useMemo(() => {
    if (!selectedRow) return [];
    return events
      .filter((event) => selectedRow.sessionId ? event.sessionId === selectedRow.sessionId : event.pid === selectedRow.pid)
      .slice(-PEEK_LINE_LIMIT);
  }, [events, selectedRow]);

  return (
    <div className="s-atop">
      <SummaryStrip summary={summary} runHistory={runHistory} toolHistory={toolHistory} />
      <ObservedTopologyPanel
        title="Harness families"
        size="compact"
        maxAgents={6}
        maxTasks={3}
        showEmpty
      />

      <FilterBar
        search={search}
        onSearch={setSearch}
        harnessOptions={harnessOptions}
        harnessFilter={harnessFilter}
        onToggleHarness={toggleHarness}
        statusOptions={statusOptions}
        statusFilter={statusFilter}
        onToggleStatus={toggleStatus}
        summary={summary}
      />

      <DataTable
        rows={filteredRows}
        columns={COLUMNS}
        rowId={(row) => row.key}
        storageKey="openscout.atop.cols"
        sort={sort}
        onSortChange={setSort}
        secondarySort={secondarySort}
        onRowClick={(row) => setSelectedKey(row.key)}
        rowClassName={(row) => (selectedKey === row.key ? "s-atop-row--selected" : undefined)}
        empty={{ title: "no agents match", body: "adjust filters or start a session to populate" }}
        density="compact"
        className="s-atop-data-table"
        ariaLabel="Agent activity inventory"
      />

      <KeyHints
        shown={displayRows.length}
        total={rows.length}
        hasSelection={selectedKey != null}
      />

      {selectedRow && (
        <DetailPanel
          row={selectedRow}
          process={selectedProcess}
          events={selectedEvents}
          now={now}
          onClose={() => setSelectedKey(null)}
        />
      )}
    </div>
  );
}

/* ── Sub-components ── */

function SummaryStrip({
  summary,
  runHistory,
  toolHistory,
}: {
  summary: AtopSummary;
  runHistory: number[];
  toolHistory: number[];
}) {
  return (
    <div className="s-atop-summary">
      <div className="s-atop-summary-cell s-atop-summary-cell--primary">
        <div className="s-atop-summary-num">
          <strong>{summary.running}</strong>
          <span className="s-atop-summary-of">/ {summary.total}</span>
        </div>
        <span className="s-atop-summary-lbl">active</span>
        <Sparkline values={runHistory} color="var(--green)" />
      </div>
      <div className="s-atop-summary-cell">
        <div className="s-atop-summary-num">
          <strong>{summary.tooling}</strong>
        </div>
        <span className="s-atop-summary-lbl">working</span>
        <Sparkline values={toolHistory} color="var(--accent)" />
      </div>
      <div className="s-atop-summary-cell">
        <div className="s-atop-summary-num">
          <strong>{summary.idle}</strong>
        </div>
        <span className="s-atop-summary-lbl">idle</span>
      </div>
      <div className="s-atop-summary-cell s-atop-summary-cell--breakdown">
        <span className="s-atop-summary-lbl">harness</span>
        <div className="s-atop-summary-row">
          {summary.harnesses.length > 0 ? (
            summary.harnesses.slice(0, 4).map((entry) => (
              <span key={entry.harness} className={harnessChipClass(entry.harness)}>
                <HarnessMark harness={entry.harness} size={11} title={null} />
                {harnessLabel(entry.harness)} {entry.count}
              </span>
            ))
          ) : (
            <span className="s-atop-chip s-atop-chip--mute">none</span>
          )}
        </div>
      </div>
      <div className="s-atop-summary-spacer" />
      <div className="s-atop-summary-cell s-atop-summary-cell--rate">
        <div className="s-atop-summary-num">
          <strong>{summary.reqsPerMin}</strong>
          <span className="s-atop-summary-of">/ min</span>
        </div>
        <span className="s-atop-summary-lbl">requests</span>
      </div>
    </div>
  );
}

function FilterBar({
  search,
  onSearch,
  harnessOptions,
  harnessFilter,
  onToggleHarness,
  statusOptions,
  statusFilter,
  onToggleStatus,
  summary,
}: {
  search: string;
  onSearch: (v: string) => void;
  harnessOptions: string[];
  harnessFilter: Set<string>;
  onToggleHarness: (h: string) => void;
  statusOptions: AtopStatus[];
  statusFilter: Set<AtopStatus>;
  onToggleStatus: (s: AtopStatus) => void;
  summary: AtopSummary;
}) {
  const harnessCount = (harness: string): number =>
    summary.harnesses.find((entry) => entry.harness === harness)?.count ?? 0;
  const statusCount = (status: AtopStatus): number => {
    if (status === "tool") return summary.tooling;
    if (status === "run") return summary.running - summary.tooling;
    return summary.idle;
  };
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      const inEditable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target?.isContentEditable ?? false);
      if (inEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="s-atop-fbar">
      <div className="s-atop-search">
        <span className="s-atop-search-prompt">▸</span>
        <input
          ref={inputRef}
          className="s-atop-search-input"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="filter by pid · project · command · summary"
          spellCheck={false}
        />
        <span className="s-atop-search-kbd">/</span>
      </div>

      {harnessOptions.length > 1 && (
        <>
          <span className="s-atop-fbar-label">harness</span>
          {harnessOptions.map((harness) => {
            const on = harnessFilter.has(harness);
            return (
              <button
                key={harness}
                className={`s-atop-pill s-atop-pill--harness${on ? " s-atop-pill--on" : ""}`}
                onClick={() => onToggleHarness(harness)}
              >
                <HarnessMark harness={harness} size={11} title={null} />
                {harnessLabel(harness)}
                <span className="s-atop-pill-ct">{harnessCount(harness)}</span>
              </button>
            );
          })}
        </>
      )}

      {statusOptions.length > 1 && (
        <>
          <span className="s-atop-fbar-label">status</span>
          {(["tool", "run", "idle"] as AtopStatus[])
            .filter((s) => statusOptions.includes(s))
            .map((status) => {
              const on = statusFilter.has(status);
              return (
                <button
                  key={status}
                  className={`s-atop-pill s-atop-pill--status-${status}${on ? " s-atop-pill--on" : ""}`}
                  onClick={() => onToggleStatus(status)}
                >
                  {STATUS_LABEL[status]}
                  <span className="s-atop-pill-ct">{statusCount(status)}</span>
                </button>
              );
            })}
        </>
      )}

      <div className="s-atop-fbar-spacer" />
    </div>
  );
}

const COLUMNS: DataTableColumn<AtopRow, SortKey>[] = [
  {
    key: "status",
    label: "Status",
    cls: "s-atop-col-status",
    kind: "text",
    defaultWidth: 96,
    minWidth: 70,
    sortValue: (row) => STATUS_RANK[row.status],
    render: (row) => (
      <span className={`s-atop-status s-atop-status--${row.status}`}>
        <span className="s-atop-status-dot" />
        {STATUS_LABEL[row.status]}
      </span>
    ),
  },
  {
    key: "agent",
    label: "Agent",
    cls: "s-atop-col-agent",
    kind: "text",
    tip: "Harness · short session id",
    defaultWidth: 168,
    minWidth: 110,
    sortValue: (row) => `${row.harness}\0${row.sessionId ?? ""}`,
    render: (row) => (
      <div className="s-atop-agent-cell">
        <span
          className={harnessChipClass(row.harness)}
          title={`origin: ${ATTRIBUTION_LABEL[row.attribution]}`}
        >
          <HarnessMark harness={row.harness} size={11} title={null} />
          {harnessLabel(row.harness)}
        </span>
        <span className="s-atop-agent-id" title={row.sessionId ?? `pid ${row.pid}`}>
          {shortSession(row.sessionId)}
        </span>
      </div>
    ),
  },
  {
    key: "project",
    label: "Project",
    cls: "s-atop-col-project",
    kind: "text",
    defaultWidth: 200,
    minWidth: 96,
    maxWidth: 480,
    sortValue: (row) => row.project,
    render: (row) => <span title={row.cwd}>{row.project}</span>,
  },
  {
    key: "reqs",
    label: "Reqs",
    cls: "s-atop-col-num",
    kind: "number",
    tip: "Model invocations (assistant turns) for this session",
    defaultWidth: 64,
    minWidth: 56,
    sortValue: (row) => row.reqCount,
    render: (row) => <MetricValue value={row.reqCount || null} />,
  },
  {
    key: "tokIn",
    label: "Tok ↓",
    cls: "s-atop-col-num",
    kind: "number",
    tip: "Input tokens — populated when backend emits usage",
    defaultWidth: 64,
    minWidth: 56,
    sortValue: (row) => row.tokIn,
    render: (row) => <MetricValue value={row.tokIn} />,
  },
  {
    key: "tokOut",
    label: "Tok ↑",
    cls: "s-atop-col-num",
    kind: "number",
    tip: "Output tokens — populated when backend emits usage",
    defaultWidth: 64,
    minWidth: 56,
    sortValue: (row) => row.tokOut,
    render: (row) => <MetricValue value={row.tokOut} />,
  },
  {
    key: "cache",
    label: "Cache",
    cls: "s-atop-col-num",
    kind: "number",
    tip: "Cache hit rate — populated when backend emits usage",
    defaultWidth: 64,
    minWidth: 56,
    sortValue: (row) => cacheHitRate(row),
    render: (row) => <MetricPct value={cacheHitRate(row)} />,
  },
  {
    key: "tools",
    label: "Tools",
    cls: "s-atop-col-num",
    kind: "number",
    defaultWidth: 64,
    minWidth: 56,
    sortValue: (row) => row.toolCount,
    render: (row) => <MetricValue value={row.toolCount || null} />,
  },
  {
    key: "perms",
    label: "Perms",
    cls: "s-atop-col-num",
    kind: "number",
    tip: "Permission requests — heuristic count of permission-mode events",
    defaultWidth: 64,
    minWidth: 56,
    sortValue: (row) => row.permCount,
    render: (row) => <MetricValue value={row.permCount || null} accent={row.permCount > 0 ? "amber" : undefined} />,
  },
  {
    key: "last",
    label: "Last",
    cls: "s-atop-col-last",
    kind: "time",
    defaultWidth: 86,
    minWidth: 64,
    sortValue: (row) => row.lastEventAt,
    render: (row) => formatRelative(row.lastEventAt, Date.now()),
  },
  {
    key: "runtime",
    label: "Runtime",
    cls: "s-atop-col-runtime",
    kind: "number",
    tip: "Session duration (active period in current buffer)",
    defaultWidth: 80,
    minWidth: 64,
    sortValue: (row) => row.sessionRuntimeSec,
    render: (row) => formatRuntime(row.sessionRuntimeSec),
  },
];

function MetricValue({
  value,
  accent,
}: {
  value: number | null;
  accent?: "amber" | "green";
}) {
  const cls = value == null
    ? "s-atop-col-num s-atop-col-num--dim"
    : `s-atop-col-num${accent ? ` s-atop-col-num--${accent}` : ""}`;
  return <span className={cls}>{fmtCount(value)}</span>;
}

function MetricPct({ value }: { value: number | null }) {
  const cls = value == null
    ? "s-atop-col-num s-atop-col-num--dim"
    : "s-atop-col-num";
  return <span className={cls}>{fmtPct(value)}</span>;
}

function KeyHints({
  shown,
  total,
  hasSelection,
}: {
  shown: number;
  total: number;
  hasSelection: boolean;
}) {
  return (
    <div className="s-atop-keys">
      <span className="s-atop-keys-count">
        <strong>{shown}</strong> / {total} agents
      </span>
      <span className="s-atop-keys-spacer" />
      <span><kbd>/</kbd> filter</span>
      <span><kbd>j</kbd>/<kbd>k</kbd> select</span>
      <span><kbd>click</kbd> drill in</span>
      {hasSelection && <span><kbd>esc</kbd> close</span>}
    </div>
  );
}

function DetailPanel({
  row,
  process,
  events,
  now,
  onClose,
}: {
  row: AtopRow;
  process: TailDiscoveredProcess | null;
  events: TailEvent[];
  now: number;
  onClose: () => void;
}) {
  const toolHistogram = useMemo(() => {
    const hist: Record<string, number> = {};
    for (const event of events) {
      if (event.kind !== "tool") continue;
      const match = event.summary.match(/^([a-z_][a-z0-9_]*)/i);
      const name = match ? match[1] : "(tool)";
      hist[name] = (hist[name] ?? 0) + 1;
    }
    const entries = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return entries.map(([name, count]) => ({ name, count, frac: count / max }));
  }, [events]);

  const peekEvents = events.slice(-PEEK_LINE_LIMIT).reverse();

  return (
    <aside
      className="s-atop-drawer"
      aria-label={`Agent ${row.key}`}
    >
        <header className="s-atop-drawer-head">
          <div className="s-atop-drawer-head-meta">
            <span className={`s-atop-status s-atop-status--${row.status}`}>
              <span className="s-atop-status-dot" />
              {STATUS_LABEL[row.status]}
            </span>
            <span className="s-atop-drawer-pid">{row.pid > 0 ? `pid ${row.pid}` : "transcript"}</span>
            <span
              className={harnessChipClass(row.harness)}
              title={`origin: ${ATTRIBUTION_LABEL[row.attribution]}`}
            >
              <HarnessMark harness={row.harness} size={11} title={null} />
              {harnessLabel(row.harness)}
            </span>
            <span className="s-atop-drawer-session">session {shortSession(row.sessionId)}</span>
          </div>
          <h2 className="s-atop-drawer-title">{row.project}</h2>
          <p className="s-atop-drawer-sub">
            session {shortSession(row.sessionId)} · runtime {formatRuntime(row.sessionRuntimeSec)}
            {" · last activity "}{formatRelative(row.lastEventAt, now)}
          </p>
          <button className="s-atop-drawer-close" onClick={onClose} aria-label="Close (Esc)">✕</button>
        </header>

        <div className="s-atop-drawer-body">
          <section>
            <h3 className="s-atop-drawer-h3">Activity</h3>
            <div className="s-atop-metrics">
              <Metric label="Requests" value={fmtCount(row.reqCount || null)} />
              <Metric label="Tools" value={fmtCount(row.toolCount || null)} />
              <Metric
                label="Permissions"
                value={fmtCount(row.permCount || null)}
                accent={row.permCount > 0 ? "amber" : undefined}
              />
              <Metric label="Tok in" value={fmtCount(row.tokIn)} dim={row.tokIn == null} />
              <Metric label="Tok out" value={fmtCount(row.tokOut)} dim={row.tokOut == null} />
              <Metric
                label="Cache hit"
                value={fmtPct(cacheHitRate(row))}
                dim={cacheHitRate(row) == null}
              />
              <Metric label="Model" value={row.model ?? "—"} dim={row.model == null} />
              <Metric label="Events" value={fmtCount(row.eventCount || null)} />
            </div>
          </section>

          {toolHistogram.length > 0 && (
            <section>
              <h3 className="s-atop-drawer-h3">Tool calls</h3>
              <ul className="s-atop-histo">
                {toolHistogram.map((tool) => (
                  <li key={tool.name}>
                    <span className="s-atop-histo-name">{tool.name}</span>
                    <span className="s-atop-histo-bar">
                      <span
                        className="s-atop-histo-fill"
                        style={{ width: `${(tool.frac * 100).toFixed(1)}%` }}
                      />
                    </span>
                    <span className="s-atop-histo-count">{tool.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="s-atop-drawer-h3">
              Recent activity
              <span className="s-atop-drawer-h3-aside">{events.length} buffered</span>
            </h3>
            {peekEvents.length === 0 ? (
              <div className="s-atop-peek-empty">no events buffered for this agent yet</div>
            ) : (
              <ol className="s-atop-peek">
                {peekEvents.map((event) => (
                  <li key={event.id} className={`s-atop-peek-row s-atop-peek-row--${event.kind}`}>
                    <span className="s-atop-peek-time">{formatTimestamp(event.ts)}</span>
                    <span className="s-atop-peek-kind">{event.kind}</span>
                    <span className="s-atop-peek-text">{event.summary}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="s-atop-drawer-section--secondary">
            <h3 className="s-atop-drawer-h3">Process</h3>
            <code className="s-atop-codeblock">{row.command}</code>
            <dl className="s-atop-kvs">
              <dt>PID</dt>
              <dd>{row.pid > 0 ? row.pid : "transcript-only"}</dd>
              <dt>Parent</dt>
              <dd>{row.parentLabel} (ppid {row.ppid})</dd>
              <dt>Process etime</dt>
              <dd>{row.procEtime}</dd>
              {row.transcriptPath && (
                <>
                  <dt>Transcript</dt>
                  <dd>{row.transcriptPath}</dd>
                </>
              )}
              <dt>Origin</dt>
              <dd>{ATTRIBUTION_LABEL[row.attribution]}</dd>
              <dt>CWD</dt>
              <dd>{row.cwd || "(none)"}</dd>
            </dl>
            {process?.parentChain && process.parentChain.length > 0 && (
              <ol className="s-atop-chain">
                {process.parentChain.map((p) => (
                  <li key={p.pid}>
                    <span className="s-atop-chain-pid">{p.pid}</span>
                    <span className="s-atop-chain-cmd">{shortCommand(p.command, 80)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
    </aside>
  );
}

function Metric({
  label,
  value,
  dim,
  accent,
}: {
  label: string;
  value: string;
  dim?: boolean;
  accent?: "amber" | "green";
}) {
  const cls = `s-atop-metric${dim ? " s-atop-metric--dim" : ""}${accent ? ` s-atop-metric--${accent}` : ""}`;
  return (
    <div className={cls}>
      <span className="s-atop-metric-lbl">{label}</span>
      <span className="s-atop-metric-val">{value}</span>
    </div>
  );
}
