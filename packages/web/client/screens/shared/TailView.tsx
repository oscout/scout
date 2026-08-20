import "../ops/ops-tail.css";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SlidePanel } from "../../components/SlidePanel/SlidePanel.tsx";
import { HarnessMark, harnessLabel } from "../../components/HarnessMark.tsx";
import { api } from "../../lib/api.ts";
import {
  formatClockTimestamp,
  normalizeTimestampMs,
} from "../../lib/time.ts";
import {
  collapseTailDisplayRows,
  isTailNoiseEvent,
  shortTailSession,
  TAIL_KIND_GLYPH as KIND_GLYPH,
  TAIL_KIND_LABEL as KIND_LABEL,
  type TailDisplayMode,
} from "../../lib/tail-display.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import { useScout } from "../../scout/Provider.tsx";
import type {
  Route,
  TailDiscoverySnapshot,
  TailEvent,
  TailEventKind,
} from "../../lib/types.ts";

const BUFFER_LIMIT = 5_000;
const DEFAULT_RECENT_LIMIT = 500;
const DISCOVERY_REFRESH_MS = 30_000;
const DISPLAY_MODE_STORAGE_KEY = "openscout:tail-display-mode";

type TailAttribution = TailEvent["harness"];

const ATTRIBUTION_LABEL: Record<TailAttribution, string> = {
  "scout-managed": "scout",
  "hudson-managed": "hudson",
  unattributed: "native",
};

const ORIGIN_ABBR: Record<TailAttribution, string> = {
  "scout-managed": "sc",
  "hudson-managed": "hu",
  unattributed: "na",
};

type TailViewVariant = "tail" | "issues";
type TailViewChrome = "full" | "embedded";
type TailFilterScope = "all" | "context";
type IssueSeverity = "warn" | "error";
type IssueFilter = "warn-plus" | "errors-only" | "all";
type ClassifiedTailEvent = {
  event: TailEvent;
  severity: IssueSeverity | null;
};

type SourceCount = {
  source: string;
  count: number;
};

function displayHarness(source: string | null | undefined): string {
  return source?.trim().toLowerCase() || "unknown";
}

function summarizeSources(
  discovery: TailDiscoverySnapshot | null,
  events: TailEvent[],
): SourceCount[] {
  const counts = new Map<string, number>();
  const sourceRows = discovery?.transcripts?.length
    ? discovery.transcripts
    : discovery?.processes.length
      ? discovery.processes
      : events;

  for (const row of sourceRows) {
    const source = displayHarness(row.source);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

function formatTime(ts: number): string {
  return formatClockTimestamp(ts, { milliseconds: true }) || "—";
}

function tailRowKey(event: TailEvent, index: number, repeatCount = 1): string {
  return `${event.id}:${event.ts}:${repeatCount}:${index}`;
}

function readStoredDisplayMode(): TailDisplayMode {
  try {
    const stored = sessionStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
    if (stored === "work" || stored === "all") return stored;
  } catch {
    // ignore storage failures
  }
  return "work";
}

const ERROR_TEXT_RE = /\b(error|failed|failure|exception|panic|timeout|timed out|refused|crash|fatal|non[- ]?zero|exit(?:ed)? with code [1-9])\b/i;
const WARN_TEXT_RE = /\b(warn(?:ing)?|deprecated|retry|rate limit|rate-limited|blocked|skipped|interrupted|aborted|stale|conflict|permission denied|denied)\b/i;

function issueFromText(text: string): IssueSeverity | null {
  const normalized = text.replace(/[_-]+/g, " ");
  if (ERROR_TEXT_RE.test(normalized)) return "error";
  if (WARN_TEXT_RE.test(normalized)) return "warn";
  return null;
}

function isMeaningful(value: unknown): boolean {
  if (value == null) return false;
  if (value === false) return false;
  if (typeof value === "string" && !value.trim()) return false;
  return true;
}

function issueFromRaw(value: unknown, depth = 0): IssueSeverity | null {
  if (value == null || depth > 4) return null;
  if (typeof value === "string") return null;
  if (typeof value !== "object") return null;

  if (Array.isArray(value)) {
    let fallback: IssueSeverity | null = null;
    for (const entry of value.slice(0, 40)) {
      const severity = issueFromRaw(entry, depth + 1);
      if (severity === "error") return "error";
      fallback ??= severity;
    }
    return fallback;
  }

  let fallback: IssueSeverity | null = null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    const lowerKey = key.toLowerCase();
    if ((lowerKey === "is_error" || lowerKey === "failed") && entry === true) {
      return "error";
    }
    if (lowerKey === "error" && isMeaningful(entry)) {
      return "error";
    }
    if ((lowerKey === "warning" || lowerKey === "warn") && isMeaningful(entry)) {
      fallback = "warn";
    }
    if (
      typeof entry === "string" &&
      (lowerKey === "level" ||
        lowerKey === "severity" ||
        lowerKey === "status" ||
        lowerKey === "type" ||
        lowerKey === "subtype")
    ) {
      const severity = issueFromText(entry);
      if (severity === "error") return "error";
      fallback ??= severity;
    }
    const nested = issueFromRaw(entry, depth + 1);
    if (nested === "error") return "error";
    fallback ??= nested;
  }
  return fallback;
}

function classifyTailIssue(event: TailEvent): IssueSeverity | null {
  const rawSeverity = issueFromRaw(event.raw);
  if (rawSeverity === "error") return "error";
  if (event.kind === "tool-result" || event.kind === "system" || event.kind === "other") {
    const textSeverity = issueFromText(event.summary);
    if (textSeverity === "error") return "error";
    return rawSeverity ?? textSeverity;
  }
  return rawSeverity;
}

function issueFilterAllows(severity: IssueSeverity | null, filter: IssueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "warn-plus") return severity != null;
  return severity === "error";
}

function issueFilterLabel(filter: IssueFilter): string {
  switch (filter) {
    case "errors-only":
      return "errors";
    case "warn-plus":
      return "warnings or errors";
    case "all":
      return "all session events";
  }
}

function matchesFilter(
  event: TailEvent,
  query: string,
  severity: IssueSeverity | null = null,
  scope: TailFilterScope = "all",
): boolean {
  if (!query) return true;
  const attribution = ATTRIBUTION_LABEL[event.harness];
  const issueWords = severity === "error"
    ? "error failed failure issue"
    : severity === "warn"
      ? "warn warning issue"
      : "";
  const searchableParts = scope === "context"
    ? [
        event.project,
        event.cwd,
        event.sessionId,
        event.source,
        event.harness,
        attribution,
        issueWords,
      ]
    : [
        event.summary,
        event.project,
        event.cwd,
        event.sessionId,
        event.source,
        event.harness,
        attribution,
        issueWords,
      ];
  const haystack = searchableParts.join(" ").toLowerCase();
  // Pipe-separated terms are OR-matched ("hudson|claude" matches either)
  const terms = query.toLowerCase().split("|").map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.some((term) => haystack.includes(term));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function tailMetadataText(event: TailEvent): string {
  const rows = [
    ["time", formatFullTime(event.ts)],
    ["kind", event.kind],
    ["project", event.project],
    ["cwd", event.cwd || "—"],
    ["session", event.sessionId || "—"],
    ["source", harnessLabel(event.source)],
    ["origin", ATTRIBUTION_LABEL[event.harness]],
    ["pid", event.parentPid != null ? `${event.pid} <- ${event.parentPid}` : String(event.pid)],
  ];
  return rows.map(([key, value]) => `${key}: ${value}`).join("\n");
}

function tailDetailSnapshot(event: TailEvent) {
  const sourceLabel = harnessLabel(event.source);
  const originLabel = ATTRIBUTION_LABEL[event.harness];
  const raw = safeJson(event.raw ?? event);
  const metadata = [
    { label: "Time", value: formatFullTime(event.ts) },
    { label: "Kind", value: event.kind },
    { label: "Project", value: event.project },
    { label: "Cwd", value: event.cwd || "—" },
    { label: "Session", value: event.sessionId || "—" },
    { label: "Source", value: sourceLabel },
    { label: "Origin", value: originLabel },
    {
      label: "Pid",
      value: event.parentPid != null ? `${event.pid} <- ${event.parentPid}` : String(event.pid),
    },
  ];
  return {
    source: "tail",
    focus: "item",
    title: `${event.kind} · ${sourceLabel}`,
    meta: `${formatFullTime(event.ts)} · ${event.project} · ${shortTailSession(event.sessionId)}`,
    body: event.summary,
    metadata,
    copy: [
      { label: "Copy message", value: event.summary },
      { label: "Copy metadata", value: tailMetadataText(event) },
      { label: "Copy raw", value: raw },
    ],
    action: event.sessionId
      ? { label: "Open session", route: { view: "sessions", sessionId: event.sessionId } }
      : null,
  };
}

function publishOpsDetail(detail: unknown) {
  if (typeof window === "undefined") return;
  const target = window as typeof window & { scoutOpsDetailSnapshot?: unknown };
  target.scoutOpsDetailSnapshot = detail;
  window.dispatchEvent(new CustomEvent("scout:ops-detail", { detail }));
}

export function TailView({
  navigate,
  initialFilter,
  variant = "tail",
  chrome = "full",
  filterLabel,
  filterScope = "all",
}: {
  navigate?: (r: Route) => void;
  initialFilter?: string;
  variant?: TailViewVariant;
  chrome?: TailViewChrome;
  filterLabel?: string;
  filterScope?: TailFilterScope;
} = {}) {
  const { route } = useScout();
  const issueMode = variant === "issues";
  const embedded = chrome === "embedded";
  const [events, setEvents] = useState<TailEvent[]>([]);
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [filter, setFilter] = useState(initialFilter ?? "");
  const [filterOpen, setFilterOpen] = useState(Boolean(initialFilter) && !embedded);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("warn-plus");
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [selected, setSelected] = useState<TailEvent | null>(null);
  const [displayMode, setDisplayMode] = useState<TailDisplayMode>(readStoredDisplayMode);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const wasAtBottomRef = useRef(true);

  const handleEvent = useCallback((event: TailEvent) => {
    setEvents((prev) => {
      const next = prev.length >= BUFFER_LIMIT
        ? [...prev.slice(prev.length - BUFFER_LIMIT + 1), event]
        : [...prev, event];
      return next;
    });
  }, []);

  useTailEvents(handleEvent);

  useEffect(() => {
    setFilter(initialFilter ?? "");
    setFilterOpen(Boolean(initialFilter) && !embedded);
  }, [embedded, initialFilter]);

  useEffect(() => {
    try {
      sessionStorage.setItem(DISPLAY_MODE_STORAGE_KEY, displayMode);
    } catch {
      // ignore storage failures
    }
  }, [displayMode]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ limit: String(DEFAULT_RECENT_LIMIT) });
        if (embedded || initialFilter) {
          params.set("transcripts", "true");
        }
        const result = await api<{ events: TailEvent[] }>(
          `/api/tail/recent?${params.toString()}`,
        );
        if (!cancelled) setEvents(result.events ?? []);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embedded, initialFilter]);

  useEffect(() => {
    if (embedded) return;
    publishOpsDetail(selected ? tailDetailSnapshot(selected) : null);
    return () => publishOpsDetail(null);
  }, [embedded, selected]);

  const loadDiscovery = useCallback(async () => {
    try {
      const snap = await api<TailDiscoverySnapshot>("/api/tail/discover");
      setDiscovery(snap);
    } catch {
      /* swallow */
    }
  }, []);

  useEffect(() => {
    void loadDiscovery();
    const id = setInterval(() => void loadDiscovery(), DISCOVERY_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadDiscovery]);

  const classifiedEvents = useMemo<ClassifiedTailEvent[]>(
    () => events.map((event) => ({ event, severity: classifyTailIssue(event) })),
    [events],
  );

  const issueCounts = useMemo(() => {
    let warn = 0;
    let error = 0;
    for (const entry of classifiedEvents) {
      if (entry.severity === "error") error++;
      if (entry.severity === "warn") warn++;
    }
    return { warn, error, total: warn + error };
  }, [classifiedEvents]);

  const filtered = useMemo(() => {
    return classifiedEvents.filter(({ event, severity }) => {
      if (issueMode && !issueFilterAllows(severity, issueFilter)) return false;
      return matchesFilter(event, filter, severity, filterScope);
    });
  }, [classifiedEvents, filter, filterScope, issueFilter, issueMode]);

  const displayRows = useMemo(() => {
    const narrowed = filtered.filter(({ event }) =>
      displayMode === "all" || !isTailNoiseEvent(event),
    );
    return collapseTailDisplayRows(
      narrowed.map((row) => ({ event: row.event, meta: row.severity })),
    );
  }, [displayMode, filtered]);

  // Auto-scroll-to-bottom unless paused.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (paused) {
      setPendingCount((prev) => prev + 1);
      return;
    }
    body.scrollTop = body.scrollHeight;
  }, [displayRows, paused]);

  // Detect manual scroll-up to engage pause.
  const handleScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    const atBottom = distance < 24;
    wasAtBottomRef.current = atBottom;
    if (atBottom) {
      setPaused(false);
      setPendingCount(0);
    } else if (!paused) {
      setPaused(true);
    }
  }, [paused]);

  const focusFilter = useCallback((seed: string) => {
    setFilter(seed);
    setFilterOpen(true);
    requestAnimationFrame(() => filterInputRef.current?.focus());
  }, []);

  const navigateToSession = useCallback(
    (sessionId: string) => {
      if (!sessionId || !navigate) return;
      openContent(navigate, { view: "sessions", sessionId }, { returnTo: route });
    },
    [navigate, route],
  );

  const jumpToLive = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    setPaused(false);
    setPendingCount(0);
  }, []);

  // Keyboard shortcuts: /, Esc, G
  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target?.isContentEditable ?? false);

      if (event.key === "/" && !inEditable) {
        event.preventDefault();
        setFilterOpen(true);
        requestAnimationFrame(() => filterInputRef.current?.focus());
        return;
      }
      if (event.key === "Escape") {
        // Sheet escape is handled inside <SlidePanel>; here we only handle filter close.
        if (filterOpen && document.activeElement === filterInputRef.current) {
          event.preventDefault();
          setFilterOpen(false);
          filterInputRef.current?.blur();
          setFilter("");
          return;
        }
      }
      if ((event.key === "g" || event.key === "G") && !inEditable) {
        event.preventDefault();
        jumpToLive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, filterOpen, jumpToLive]);

  const totals = discovery?.totals;
  const transcriptCount = totals?.transcripts ?? discovery?.transcripts?.length ?? 0;
  const harnessCounts = useMemo(() => summarizeSources(discovery, events), [discovery, events]);

  return (
    <div className={`s-tail s-tail--${chrome}`}>
      <div className={`s-tail-status${issueMode ? " s-tail-status--issues" : ""}`}>
        <span className="s-tail-status-cluster s-tail-status-cluster--metrics">
          <span className={`s-tail-live-dot${paused ? " s-tail-live-dot--paused" : ""}`} aria-hidden="true" />
          <span className={`s-tail-status-state${paused ? " s-tail-status-state--paused" : ""}`}>
            {paused ? "paused" : "live"}
          </span>
        </span>
        {!issueMode && (
          <span className="s-tail-status-cluster s-tail-status-cluster--display">
            <span className="s-tail-status-key">view</span>
            <span className="s-tail-issue-filter" role="group" aria-label="Tail display mode">
              <button
                type="button"
                className={`s-tail-issue-filter-btn${
                  displayMode === "work" ? " s-tail-issue-filter-btn--active" : ""
                }`}
                onClick={() => setDisplayMode("work")}
                aria-pressed={displayMode === "work"}
              >
                work
              </button>
              <button
                type="button"
                className={`s-tail-issue-filter-btn${
                  displayMode === "all" ? " s-tail-issue-filter-btn--active" : ""
                }`}
                onClick={() => setDisplayMode("all")}
                aria-pressed={displayMode === "all"}
              >
                all:{filtered.length}
              </button>
            </span>
          </span>
        )}
        {issueMode && (
          <span className="s-tail-status-cluster s-tail-status-cluster--issues">
            <span className="s-tail-status-key">flt</span>
            <span className="s-tail-issue-filter" role="group" aria-label="Alert severity filter">
              <button
                type="button"
                className={`s-tail-issue-filter-btn${
                  issueFilter === "errors-only" ? " s-tail-issue-filter-btn--active" : ""
                }`}
                onClick={() => setIssueFilter("errors-only")}
                aria-pressed={issueFilter === "errors-only"}
              >
                err:{issueCounts.error}
              </button>
              <button
                type="button"
                className={`s-tail-issue-filter-btn${
                  issueFilter === "warn-plus" ? " s-tail-issue-filter-btn--active" : ""
                }`}
                onClick={() => setIssueFilter("warn-plus")}
                aria-pressed={issueFilter === "warn-plus"}
              >
                wrn+:{issueCounts.total}
              </button>
              <button
                type="button"
                className={`s-tail-issue-filter-btn${
                  issueFilter === "all" ? " s-tail-issue-filter-btn--active" : ""
                }`}
                onClick={() => setIssueFilter("all")}
                aria-pressed={issueFilter === "all"}
              >
                all:{events.length}
              </button>
            </span>
          </span>
        )}
        <span className="s-tail-status-spacer" />
        <span className="s-tail-status-cluster s-tail-status-cluster--harnesses">
          <span className="s-tail-status-key">src</span>
          <span className="s-tail-status-inline">
            {harnessCounts.length > 0 ? (
              harnessCounts.slice(0, 4).map((entry) => (
                <span key={entry.source} className="s-tail-status-src">
                  <HarnessMark harness={entry.source} size={10} title={null} />
                  <span>{harnessLabel(entry.source)}:{entry.count}</span>
                </span>
              ))
            ) : (
              <span className="s-tail-status-src">—</span>
            )}
          </span>
        </span>
        {filter && embedded && (
          <span className="s-tail-status-filter" title={filter}>
            q={filterLabel ?? "filtered"}
          </span>
        )}
      </div>

      {filterOpen && (
        <div className="s-tail-filter">
          <span className="s-tail-filter-prompt">/</span>
          <input
            ref={filterInputRef}
            className="s-tail-filter-input"
            value={filter}
            placeholder="substring across summary · project · session"
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                filterInputRef.current?.blur();
              }
            }}
            autoFocus
            spellCheck={false}
          />
          <span className="s-tail-filter-hint">esc to clear</span>
        </div>
      )}

      <div className="s-tail-body" ref={bodyRef} onScroll={handleScroll}>
        {displayRows.length === 0 ? (
          <div className="s-tail-empty">
            <span className="s-tail-empty-title">
              {issueMode ? "No alert events" : "Waiting for events"}<span className="s-tail-empty-cursor" aria-hidden="true" />
            </span>
            <span className="s-tail-empty-body">
              {filter ? (
                embedded ? (
                  <>no events match <strong>{filterLabel ?? "this work filter"}</strong></>
                ) : (
                  <>no events match filter <strong>{filter}</strong></>
                )
              ) : issueMode ? (
                <>no {issueFilterLabel(issueFilter)} in the buffered session tail</>
              ) : transcriptCount ? (
                <>watching {transcriptCount} transcript{transcriptCount === 1 ? "" : "s"} · no events yet</>
              ) : (
                <>agent tool calls, messages, and system events stream here</>
              )}
            </span>
            {!transcriptCount && !filter && (
              <span className="s-tail-empty-hint">
                Start a session to see traffic<span className="s-tail-empty-hint-sep"> · </span>
                <code>scout watch --tail</code>
              </span>
            )}
          </div>
        ) : (
          displayRows.map(({ event, repeatCount, meta: severity }, index) => (
            <TailRow
              key={tailRowKey(event, index, repeatCount)}
              event={event}
              repeatCount={repeatCount}
              issueSeverity={severity}
              selected={selected === event}
              onSelect={setSelected}
              onProjectClick={focusFilter}
              onSessionClick={navigateToSession}
            />
          ))
        )}
        {paused && pendingCount > 0 && (
          <div
            className="s-tail-divider"
            onClick={jumpToLive}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                jumpToLive();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Resume live tail · ${pendingCount} new`}
          >
            ── paused · {pendingCount} new · click or press G to jump back to live ──
          </div>
        )}
      </div>

      {embedded ? (
        <div className="s-tail-keys s-tail-keys--embedded">
          <span>{displayRows.length} / {events.length} lines buffered</span>
          {paused && pendingCount > 0 && <span>{pendingCount} new</span>}
        </div>
      ) : (
        <div className="s-tail-keys">
          <span><kbd>j</kbd><kbd>k</kbd> scroll</span>
          <span><kbd>/</kbd> filter</span>
          <span><kbd>G</kbd> live</span>
          <span><kbd>esc</kbd> clr</span>
          <span className="s-tail-keys-spacer" />
          <span>{displayRows.length}/{events.length} buf</span>
        </div>
      )}

      {embedded && selected && (
        <TailDetailSheet
          event={selected}
          onClose={() => setSelected(null)}
          onProjectClick={focusFilter}
          onSessionClick={navigateToSession}
        />
      )}
    </div>
  );
}

function TailRow({
  event,
  repeatCount = 1,
  issueSeverity,
  selected,
  onSelect,
  onProjectClick,
  onSessionClick,
}: {
  event: TailEvent;
  repeatCount?: number;
  issueSeverity?: IssueSeverity | null;
  selected: boolean;
  onSelect: (event: TailEvent) => void;
  onProjectClick?: (project: string) => void;
  onSessionClick?: (sessionId: string) => void;
}) {
  const attributionLabel = ATTRIBUTION_LABEL[event.harness];
  const sourceLabel = harnessLabel(event.source);
  const issueClass = issueSeverity ? ` s-tail-row--issue s-tail-row--issue-${issueSeverity}` : "";
  return (
    <div
      className={`s-tail-row s-tail-row--${event.kind}${issueClass}${selected ? " s-tail-row--selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(event)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(event);
        }
      }}
    >
      <span className="s-tail-cell-time">{formatTime(event.ts)}</span>
      <span className="s-tail-token s-tail-token--harness" title={`source: ${sourceLabel}`}>
        <HarnessMark harness={event.source} size={11} title={null} />
        <span className="s-tail-harness-label">{sourceLabel}</span>
      </span>
      <span
        className="s-tail-token s-tail-token--origin"
        title={`origin: ${attributionLabel}`}
      >
        {ORIGIN_ABBR[event.harness]}
      </span>
      <span className="s-tail-cell-context">
        <TailLink
          className="s-tail-link s-tail-link--project"
          onClick={onProjectClick ? () => onProjectClick(event.project) : undefined}
          title={`Filter to ${event.project}`}
        >
          {event.project}
        </TailLink>
        <span className="s-tail-sep">/</span>
        <TailLink
          className="s-tail-link s-tail-link--session"
          onClick={
            onSessionClick && event.sessionId
              ? () => onSessionClick(event.sessionId)
              : undefined
          }
          title={event.sessionId ? `Open session ${event.sessionId}` : undefined}
        >
          {shortTailSession(event.sessionId)}
        </TailLink>
        <span className="s-tail-sep">:</span>
        <span className="s-tail-cell-pid" title={event.pid > 0 ? `pid ${event.pid}` : "file-backed log"}>
          {event.pid > 0 ? event.pid : "log"}
        </span>
      </span>
      <span className="s-tail-kind" title={event.kind}>
        <span className={`s-tail-glyph s-tail-glyph--${event.kind}`}>{KIND_GLYPH[event.kind]}</span>
        <span className="s-tail-kind-label">{KIND_LABEL[event.kind]}</span>
      </span>
      <span className="s-tail-summary">
        {issueSeverity === "error" ? "✕ " : issueSeverity === "warn" ? "△ " : null}
        {event.summary}
        {repeatCount > 1 ? (
          <span className="s-tail-repeat" title={`${repeatCount} identical events collapsed`}>
            {" "}×{repeatCount}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Inline hyperlink-style span. If `onClick` is provided, the span renders as a
 * clickable element that swallows row-click propagation; otherwise it renders
 * as plain text. Used so identifiers in a row (project, session) are
 * navigable without conflicting with the row's open-detail click.
 */
function TailLink({
  className,
  onClick,
  title,
  children,
}: {
  className: string;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
}) {
  if (!onClick) return <span className={className} title={title}>{children}</span>;
  return (
    <span
      className={`${className} s-tail-link--active`}
      role="link"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
    >
      {children}
    </span>
  );
}

function formatFullTime(ts: number): string {
  const tsMs = normalizeTimestampMs(ts);
  if (tsMs === null) return "—";
  const d = new Date(tsMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "undefined";
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (_match, key, str, lit, num) => {
      if (key) return `<span class="s-tail-jk">${key}</span>`;
      if (str) return `<span class="s-tail-js">${str}</span>`;
      if (lit) return `<span class="s-tail-jl">${lit}</span>`;
      if (num) return `<span class="s-tail-jn">${num}</span>`;
      return _match;
    },
  );
}

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; name?: string; input?: unknown; id?: string };
type ToolResultBlock = {
  type: "tool_result";
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
};
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

function getContentBlocks(raw: unknown): ContentBlock[] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const message = obj.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? obj.content) as unknown;
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return null;
}

function TailDetailSheet({
  event,
  onClose,
  onProjectClick,
  onSessionClick,
}: {
  event: TailEvent;
  onClose: () => void;
  onProjectClick?: (project: string) => void;
  onSessionClick?: (sessionId: string) => void;
}) {
  const [showRaw, setShowRaw] = useState(true);
  const attributionLabel = ATTRIBUTION_LABEL[event.harness];
  const sourceLabel = harnessLabel(event.source);
  const issueSeverity = classifyTailIssue(event);
  const blocks = getContentBlocks(event.raw);

  return (
    <SlidePanel
      open
      onClose={onClose}
      side="right"
      owner="openscout.tail"
      resizable
      defaultSize={620}
      minSize={400}
      maxSize={960}
      ariaLabel="Tail event detail"
    >
        <div className="s-slide-header s-tail-sheet-header">
          <span className={`s-tail-glyph s-tail-glyph--${event.kind}`}>{KIND_GLYPH[event.kind]}</span>
          <span className="s-tail-sheet-kind">{KIND_LABEL[event.kind]}</span>
          {issueSeverity && (
            <span className={`s-tail-token s-tail-token--issue-${issueSeverity}`}>
              {issueSeverity === "error" ? "✕" : "△"}
            </span>
          )}
          <span className="s-tail-token s-tail-token--harness">
            <HarnessMark harness={event.source} size={12} title={null} />
            <span className="s-tail-harness-label">{sourceLabel}</span>
          </span>
          <span className="s-tail-token s-tail-token--origin" title={`origin: ${attributionLabel}`}>
            {ORIGIN_ABBR[event.harness]}
          </span>
          <span className="s-slide-spacer" />
          <span className="s-tail-sheet-time">{formatFullTime(event.ts)}</span>
          <button type="button" className="s-slide-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="s-slide-body s-tail-sheet-body">
          <section className="s-tail-sheet-section">
            <div className="s-tail-sheet-grid">
              <span className="s-tail-sheet-key">project</span>
              <span className="s-tail-sheet-val">
                <TailLink
                  className="s-tail-link s-tail-link--project"
                  onClick={onProjectClick ? () => onProjectClick(event.project) : undefined}
                  title={`Filter to ${event.project}`}
                >
                  {event.project}
                </TailLink>
              </span>
              <span className="s-tail-sheet-key">cwd</span>
              <span className="s-tail-sheet-val s-tail-sheet-val--mono">{event.cwd || "—"}</span>
              <span className="s-tail-sheet-key">session</span>
              <span className="s-tail-sheet-val s-tail-sheet-val--mono">
                <TailLink
                  className="s-tail-link s-tail-link--session"
                  onClick={
                    onSessionClick && event.sessionId
                      ? () => onSessionClick(event.sessionId)
                      : undefined
                  }
                  title={event.sessionId ? `Open session ${event.sessionId}` : undefined}
                >
                  {event.sessionId || "—"}
                </TailLink>
              </span>
              <span className="s-tail-sheet-key">harness</span>
              <span className="s-tail-sheet-val s-tail-sheet-val--harness">
                <HarnessMark harness={event.source} size={13} title={null} />
                <span>{sourceLabel}</span>
              </span>
              <span className="s-tail-sheet-key">origin</span>
              <span className="s-tail-sheet-val s-tail-sheet-val--mono">{attributionLabel}</span>
              <span className="s-tail-sheet-key">pid</span>
              <span className="s-tail-sheet-val s-tail-sheet-val--mono">
                {event.pid}
                {event.parentPid != null ? ` ← ${event.parentPid}` : ""}
              </span>
            </div>
          </section>

          <section className="s-tail-sheet-section">
            <h4 className="s-tail-sheet-h">summary</h4>
            <div className="s-tail-sheet-summary">{event.summary}</div>
          </section>

          {blocks && blocks.length > 0 && (
            <section className="s-tail-sheet-section">
              <h4 className="s-tail-sheet-h">content</h4>
              {blocks.map((block, i) => (
                <ContentBlockView key={i} block={block} />
              ))}
            </section>
          )}

          <section className="s-tail-sheet-section">
            <button
              type="button"
              className="s-tail-sheet-toggle"
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw ? "▾" : "▸"} raw event
            </button>
            {showRaw && (
              <pre
                className="s-tail-sheet-json"
                dangerouslySetInnerHTML={{ __html: highlightJson(event.raw ?? event) }}
              />
            )}
          </section>
        </div>
    </SlidePanel>
  );
}

function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    const text = (block as TextBlock).text ?? "";
    return <div className="s-tail-sheet-text">{text}</div>;
  }
  if (block.type === "tool_use") {
    const t = block as ToolUseBlock;
    return (
      <div className="s-tail-sheet-block s-tail-sheet-block--tool">
        <div className="s-tail-sheet-block-head">
          <span className="s-tail-glyph s-tail-glyph--tool">*</span>
          <span className="s-tail-sheet-block-title">{t.name ?? "tool_use"}</span>
        </div>
        <pre
          className="s-tail-sheet-json"
          dangerouslySetInnerHTML={{ __html: highlightJson(t.input ?? {}) }}
        />
      </div>
    );
  }
  if (block.type === "tool_result") {
    const r = block as ToolResultBlock;
    const isString = typeof r.content === "string";
    return (
      <div
        className={`s-tail-sheet-block s-tail-sheet-block--tool-result${
          r.is_error ? " s-tail-sheet-block--err" : ""
        }`}
      >
        <div className="s-tail-sheet-block-head">
          <span className="s-tail-glyph s-tail-glyph--tool-result">=</span>
          <span className="s-tail-sheet-block-title">
            tool_result{r.is_error ? " · error" : ""}
          </span>
        </div>
        {isString ? (
          <pre className="s-tail-sheet-pre">{r.content as string}</pre>
        ) : (
          <pre
            className="s-tail-sheet-json"
            dangerouslySetInnerHTML={{ __html: highlightJson(r.content ?? {}) }}
          />
        )}
      </div>
    );
  }
  return (
    <div className="s-tail-sheet-block">
      <div className="s-tail-sheet-block-head">
        <span className="s-tail-glyph s-tail-glyph--other">·</span>
        <span className="s-tail-sheet-block-title">{block.type}</span>
      </div>
      <pre
        className="s-tail-sheet-json"
        dangerouslySetInnerHTML={{ __html: highlightJson(block) }}
      />
    </div>
  );
}
