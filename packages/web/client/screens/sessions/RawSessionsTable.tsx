import "../ops/ops-atop.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DataTable, type DataTableColumn } from "../../components/DataTable/DataTable.tsx";
import { api, peekApiGet } from "../../lib/api.ts";
import {
  formatAbsoluteTimestamp,
  normalizeTimestampMs,
  timeAgo,
} from "../../lib/time.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import { useScout } from "../../scout/Provider.tsx";
import type {
  Route,
  TailDiscoveredProcess,
  TailDiscoveredTranscript,
  TailDiscoverySnapshot,
  TailEvent,
} from "../../lib/types.ts";

type SessionColumnKey = "status" | "session" | "project" | "updated" | "size" | "path";

const DISCOVERY_INTERVAL_MS = 10_000;
const RECENT_REPLAY_LIMIT = 500;
const RECENT_EVENT_LIMIT = 1_000;
const ACTIVE_WINDOW_MS = 60_000;
const DISCOVERY_PATH = "/api/tail/discover";
const RECENT_EVENTS_PATH = `/api/tail/recent?limit=${RECENT_REPLAY_LIMIT}`;
const ROUTE_CACHE_MAX_AGE_MS = 30_000;

type SessionStatus = "run" | "idle";

type RawSessionRow = {
  refId: string;
  source: string;
  project: string;
  cwd: string | null;
  transcriptPath: string;
  sessionId: string | null;
  mtimeMs: number;
  size: number;
  status: SessionStatus;
  statusLabel: string;
  lastEvent: TailEvent | null;
  process: TailDiscoveredProcess | null;
};

const COLUMNS: DataTableColumn<RawSessionRow, SessionColumnKey>[] = [
  {
    key: "status",
    label: "status",
    cls: "s-atop-col-status",
    kind: "text",
    sortable: false,
    defaultWidth: 96,
    minWidth: 70,
    render: (row) => (
      <span className={`s-atop-status s-atop-status--${row.status}`}>
        <span className="s-atop-status-dot" aria-hidden="true" />
        {row.statusLabel}
      </span>
    ),
  },
  {
    key: "session",
    label: "session",
    cls: "s-atop-col-agent",
    kind: "text",
    sortable: false,
    defaultWidth: 168,
    minWidth: 110,
    maxWidth: 280,
    render: (row) => (
      <div className="s-atop-agent-cell" title={row.sessionId ?? row.refId}>
        <span className={`s-atop-chip s-atop-chip--harness s-atop-chip--harness-${classPart(row.source)}`}>
          {row.source}
        </span>
        <span className="s-atop-agent-id">{row.refId.slice(0, 8)}</span>
      </div>
    ),
  },
  {
    key: "project",
    label: "project",
    cls: "s-atop-col-project",
    kind: "text",
    sortable: false,
    defaultWidth: 200,
    minWidth: 96,
    maxWidth: 360,
    render: (row) => <span title={row.cwd ?? row.project}>{row.project}</span>,
  },
  {
    key: "updated",
    label: "updated",
    cls: "s-atop-col-last",
    kind: "time",
    sortable: false,
    defaultWidth: 86,
    minWidth: 64,
    render: (row) => (
      <span title={formatAbsoluteTimestamp(row.mtimeMs)}>
        {timeAgo(Math.max(
          normalizeTimestampMs(row.mtimeMs) ?? 0,
          normalizeTimestampMs(row.lastEvent?.ts) ?? 0,
        )) || "-"}
      </span>
    ),
  },
  {
    key: "size",
    label: "size",
    cls: "s-atop-col-runtime",
    kind: "number",
    sortable: false,
    defaultWidth: 80,
    minWidth: 64,
    render: (row) => formatBytes(row.size),
  },
  {
    key: "path",
    label: "path",
    kind: "text",
    sortable: false,
    defaultWidth: 360,
    minWidth: 160,
    maxWidth: 800,
    render: (row) => <span title={row.transcriptPath}>{row.cwd ?? row.transcriptPath}</span>,
  },
];

function normalizeSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = pathLeaf(trimmed);
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function pathLeaf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function pathParent(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.at(-1) ?? "";
}

function classPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}

function matchesQuery(row: RawSessionRow, query: string): boolean {
  if (!query) return true;
  const haystack = [
    row.refId,
    row.sessionId ?? "",
    row.source,
    row.project,
    row.cwd ?? "",
    row.transcriptPath,
    row.lastEvent?.summary ?? "",
    row.process?.command ?? "",
  ].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function processKey(process: TailDiscoveredProcess): string {
  return `${process.source}\0${process.cwd ?? ""}`;
}

function transcriptKey(transcript: TailDiscoveredTranscript): string {
  return `${transcript.source}\0${transcript.cwd ?? ""}`;
}

function buildRows(
  discovery: TailDiscoverySnapshot | null,
  events: TailEvent[],
  now: number,
): RawSessionRow[] {
  if (!discovery?.transcripts?.length) return [];

  const latestEventBySession = new Map<string, TailEvent>();
  for (const event of events) {
    const current = latestEventBySession.get(event.sessionId);
    if (!current || event.ts > current.ts) {
      latestEventBySession.set(event.sessionId, event);
    }
  }

  const processByCwd = new Map<string, TailDiscoveredProcess>();
  for (const process of discovery.processes) {
    if (!process.cwd) continue;
    const current = processByCwd.get(processKey(process));
    if (!current || process.pid < current.pid) {
      processByCwd.set(processKey(process), process);
    }
  }

  return discovery.transcripts
    .map((transcript) => {
      const refId = normalizeSessionRef(transcript.sessionId)
        ?? normalizeSessionRef(transcript.transcriptPath);
      if (!refId) return null;

      const lastEvent = transcript.sessionId
        ? latestEventBySession.get(transcript.sessionId) ?? null
        : null;
      const process = processByCwd.get(transcriptKey(transcript)) ?? null;
      const lastActivity = Math.max(transcript.mtimeMs, lastEvent?.ts ?? 0);
      const active = Boolean(process) || now - lastActivity <= ACTIVE_WINDOW_MS;
      const project = transcript.project?.trim()
        || (transcript.cwd ? pathLeaf(transcript.cwd) : pathParent(transcript.transcriptPath))
        || "unknown";

      return {
        refId,
        source: transcript.source || "unknown",
        project,
        cwd: transcript.cwd,
        transcriptPath: transcript.transcriptPath,
        sessionId: transcript.sessionId,
        mtimeMs: transcript.mtimeMs,
        size: transcript.size,
        status: active ? "run" : "idle",
        statusLabel: active ? "active" : "idle",
        lastEvent,
        process,
      } satisfies RawSessionRow;
    })
    .filter((row): row is RawSessionRow => row !== null)
    .sort((left, right) => {
      const leftActivity = Math.max(left.mtimeMs, left.lastEvent?.ts ?? 0);
      const rightActivity = Math.max(right.mtimeMs, right.lastEvent?.ts ?? 0);
      return rightActivity - leftActivity || left.project.localeCompare(right.project);
    });
}

/** Composable sessions table — discovery, filtering, and keyboard nav. No secondary nav shell. */
export function RawSessionsTable({
  navigate,
}: {
  navigate: (r: Route) => void;
}) {
  const { route } = useScout();
  const [initialDiscovery] = useState(() =>
    peekApiGet<TailDiscoverySnapshot>(DISCOVERY_PATH, ROUTE_CACHE_MAX_AGE_MS),
  );
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(initialDiscovery);
  const [events, setEvents] = useState<TailEvent[]>(() =>
    peekApiGet<{ events: TailEvent[] }>(RECENT_EVENTS_PATH, ROUTE_CACHE_MAX_AGE_MS)?.events ?? [],
  );
  const [loading, setLoading] = useState(initialDiscovery === null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement | null>(null);

  const loadDiscovery = useCallback(async () => {
    setError(null);
    try {
      setDiscovery(await api<TailDiscoverySnapshot>(DISCOVERY_PATH));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDiscovery();
    const id = setInterval(() => void loadDiscovery(), DISCOVERY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadDiscovery]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api<{ events: TailEvent[] }>(
          RECENT_EVENTS_PATH,
        );
        if (!cancelled) setEvents(result.events ?? []);
      } catch {
        /* recent replay is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useTailEvents((event) => {
    setEvents((prev) => {
      const next = prev.length >= RECENT_EVENT_LIMIT
        ? [...prev.slice(prev.length - RECENT_EVENT_LIMIT + 1), event]
        : [...prev, event];
      return next;
    });
  });

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const rows = useMemo(
    () => buildRows(discovery, events, now),
    [discovery, events, now],
  );

  const sources = useMemo(
    () => [...new Set(rows.map((row) => row.source))].sort(),
    [rows],
  );

  const filtered = useMemo(
    () => rows.filter((row) =>
      (sourceFilter === "all" || row.source === sourceFilter)
      && matchesQuery(row, query.trim())
    ),
    [rows, sourceFilter, query],
  );

  useEffect(() => {
    if (selectedIdx >= filtered.length) {
      setSelectedIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIdx]);

  const openSelected = useCallback((row: RawSessionRow | undefined) => {
    if (!row) return;
    openContent(navigate, { view: "sessions", sessionId: row.refId }, { returnTo: route });
  }, [navigate, route]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target?.isContentEditable ?? false);

      if (event.key === "/" && !inEditable) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (inEditable) {
        if (event.key === "Escape" && target === searchRef.current) {
          setQuery("");
          searchRef.current?.blur();
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setSelectedIdx((idx) => filtered.length === 0 ? 0 : Math.min(filtered.length - 1, idx + 1));
        return;
      }
      if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setSelectedIdx((idx) => Math.max(0, idx - 1));
        return;
      }
      if (event.key === "Enter" || event.key === "o") {
        event.preventDefault();
        openSelected(filtered[selectedIdx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selectedIdx, openSelected]);

  const visibleRows = error ? [] : filtered;
  const rowId = useCallback((row: RawSessionRow) => `${row.source}:${row.transcriptPath}`, []);
  const indexById = useMemo(
    () => new Map(filtered.map((row, index) => [rowId(row), index])),
    [filtered, rowId],
  );

  return (
    <div className="s-atop s-atop--sessions">
      <div className="s-atop-fbar">
        <label className="s-atop-search">
          <span className="s-atop-search-prompt">/</span>
          <input
            ref={searchRef}
            className="s-atop-search-input"
            placeholder="filter sessions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd className="s-atop-search-kbd">/</kbd>
        </label>
        <span className="s-atop-fbar-label">source</span>
        <button
          type="button"
          className={`s-atop-pill${sourceFilter === "all" ? " s-atop-pill--on" : ""}`}
          onClick={() => setSourceFilter("all")}
        >
          all
          <span className="s-atop-pill-ct">{rows.length}</span>
        </button>
        {sources.map((source) => (
          <button
            key={source}
            type="button"
            className={`s-atop-pill${sourceFilter === source ? " s-atop-pill--on" : ""}`}
            onClick={() => setSourceFilter(source)}
          >
            {source}
            <span className="s-atop-pill-ct">
              {rows.filter((row) => row.source === source).length}
            </span>
          </button>
        ))}
        <div className="s-atop-fbar-spacer" />
      </div>

      <DataTable
        rows={visibleRows}
        columns={COLUMNS}
        rowId={rowId}
        storageKey="openscout.sessions.cols"
        rowBindings={(id) => ({
          onMouseEnter: () => {
            const index = indexById.get(id);
            if (index != null) setSelectedIdx(index);
          },
          onFocus: () => {
            const index = indexById.get(id);
            if (index != null) setSelectedIdx(index);
          },
        })}
        onRowClick={(row) => openSelected(row)}
        rowClassName={(row) => (indexById.get(rowId(row)) === selectedIdx ? "s-atop-row--selected" : undefined)}
        empty={error
          ? { title: "Discovery failed", body: error }
          : {
              title: "No raw sessions",
              body: query ? "No sessions match the current filter." : "No transcript sessions were discovered.",
            }}
        loading={loading}
        density="compact"
        className="s-atop-data-table"
        ariaLabel="Raw sessions"
      />

      <div className="s-atop-keys">
        <span><kbd>/</kbd>filter</span>
        <span><kbd>j/k</kbd>select</span>
        <span><kbd>enter</kbd>open</span>
        <span className="s-atop-keys-spacer" />
        <span className="s-atop-keys-count">
          <strong>{filtered.length}</strong> sessions
        </span>
      </div>
    </div>
  );
}
