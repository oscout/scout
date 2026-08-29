import "./knowledge-search.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  ChevronDown,
  Clock,
  Filter,
  Loader2,
  Search as SearchIcon,
  Sparkles,
  X,
} from "lucide-react";

import type { Route } from "../../lib/types.ts";
import { api } from "../../lib/api.ts";
import { formatClockTimestamp } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import {
  createEmptySearchFilters,
  displaySnippet,
  firstTranscriptRef,
  groupHitsBySession,
  highlightParts,
  KNOWLEDGE_SEARCH_DEFAULTS,
  KNOWLEDGE_SOURCE_KIND_LABELS,
  parseSearchFiltersFromUrl,
  resultMomentBits,
  resultMomentHeadline,
  resultRoutingContext,
  resultSessionGoal,
  SEARCH_SOURCE_KIND_ORDER,
  SEARCH_TIME_WINDOW_OPTIONS,
  searchFiltersAreActive,
  searchFiltersAreEqual,
  searchTimeWindowLabel,
  searchTimeWindowMs,
  transcriptSessionId,
  type IndexResponse,
  type KnowledgeFacetValue,
  type KnowledgeHit,
  type KnowledgeStatus,
  type SearchFilters,
  type SearchResponse,
  type SearchTimeWindow,
} from "../../lib/knowledge-search.ts";
import type { SearchPrimitivesResponse } from "./search-primitives.ts";
import {
  getKnowledgeSearchSnapshot,
  KNOWLEDGE_SEARCH_REINDEX_TTL_MS,
  knowledgeSearchFilterKey,
  updateKnowledgeSearchSnapshot,
} from "./knowledge-search-store.ts";

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

function activateHitFromKeyboard(event: KeyboardEvent<HTMLElement>, activate: () => void) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

async function fetchStatus(): Promise<KnowledgeStatus> {
  return api<KnowledgeStatus>("/api/knowledge/status");
}

async function fetchPrimitives(keys: string[]): Promise<SearchPrimitivesResponse> {
  const params = new URLSearchParams();
  for (const key of keys) params.append("key", key);
  params.set("limit", "200");
  return api<SearchPrimitivesResponse>(`/api/knowledge/search-primitives?${params.toString()}`);
}

async function searchKnowledge(
  q: string,
  filters: SearchFilters,
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, limit: String(KNOWLEDGE_SEARCH_DEFAULTS.hitLimit) });
  if (filters.sourceKinds.length > 0) {
    for (const kind of filters.sourceKinds) params.append("sourceKind", kind);
  }
  for (const harness of filters.harness) params.append("harness", harness);
  for (const project of filters.project) params.append("project", project);
  const sinceMs = searchTimeWindowMs(filters.timeWindow);
  if (sinceMs != null) params.set("updatedAfterMs", String(sinceMs));
  return api<SearchResponse>(`/api/knowledge/search?${params.toString()}`);
}

async function indexSessions(force = false): Promise<IndexResponse> {
  return api<IndexResponse>("/api/knowledge/sessions/index", {
    method: "POST",
    body: JSON.stringify({
      days: KNOWLEDGE_SEARCH_DEFAULTS.days,
      limit: KNOWLEDGE_SEARCH_DEFAULTS.sessionLimit,
      force,
    }),
  });
}

const TIME_WINDOWS = SEARCH_TIME_WINDOW_OPTIONS;

function FilterChip({
  active,
  onClick,
  count,
  label,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  label: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={`ks-chip${active ? " ks-chip--active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel ?? label}
    >
      <span className="ks-chip-label">{label}</span>
      {typeof count === "number" ? (
        <span className="ks-chip-count" aria-hidden="true">{formatCount(count)}</span>
      ) : null}
    </button>
  );
}

function titleCase(value: string): string {
  if (!value) return value;
  return value
    .split(/[\s_-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function topFacetValues(
  facets: KnowledgeFacetValue[] | undefined,
  key: string,
  limit = 6,
): KnowledgeFacetValue[] {
  if (!facets) return [];
  return facets
    .filter((entry) => entry.key === key && entry.value.length > 0)
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);
}

function filterChipsActive(filters: SearchFilters): boolean {
  return filters.sourceKinds.length > 0
    || filters.harness.length > 0
    || filters.project.length > 0
    || filters.timeWindow !== "all";
}

function summarizeFilters(filters: SearchFilters): string {
  const parts: string[] = [];
  if (filters.sourceKinds.length > 0) {
    parts.push(filters.sourceKinds.map((kind) => KNOWLEDGE_SOURCE_KIND_LABELS[kind] ?? kind).join(" + "));
  }
  if (filters.harness.length > 0) parts.push(filters.harness.map(titleCase).join(" + "));
  if (filters.project.length > 0) parts.push(filters.project.join(" + "));
  if (filters.timeWindow !== "all") parts.push(searchTimeWindowLabel(filters.timeWindow));
  return parts.length > 0 ? `Filters: ${parts.join(" · ")}` : "";
}

export function KnowledgeSearchScreen({
  navigate,
  mode: _mode,
  hitId,
  routeFilters,
}: {
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  /** Kept for route compatibility; search is one surface now. */
  mode?: Extract<Route, { view: "search" }>["mode"];
  /** Deep-linked hit selection from `?hit=` (SCO-082 Phase B). */
  hitId?: string;
  /** Router-owned filter state, including browser back/forward updates. */
  routeFilters?: SearchFilters;
}) {
  const { selectedKnowledgeHit, inspectKnowledgeHit, clearKnowledgeHit } = useScout();

  // Initial filter state comes from the URL (handles deep links + browser back/forward).
  const initialFilters = useMemo<SearchFilters>(() => {
    if (routeFilters) return routeFilters;
    if (typeof window === "undefined") return createEmptySearchFilters();
    return parseSearchFiltersFromUrl(window.location.search);
  }, [routeFilters]);

  // Warm start: seed from the module-level session snapshot so a remount
  // paints the last status/results/facets instantly. The mount effect below
  // still refreshes status in the background.
  const [storeSeed] = useState(() => getKnowledgeSearchSnapshot());
  const [status, setStatus] = useState<KnowledgeStatus | null>(storeSeed.status);
  const [primitives, setPrimitives] = useState<SearchPrimitivesResponse | null>(storeSeed.facets);
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [hits, setHits] = useState<KnowledgeHit[]>(() => (
    storeSeed.lastFilterKey
      && storeSeed.lastFilterKey === knowledgeSearchFilterKey(initialFilters)
      ? storeSeed.results
      : []
  ));
  const [searching, setSearching] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(storeSeed.status !== null);
  const [primitivesLoaded, setPrimitivesLoaded] = useState(storeSeed.facets !== null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const hasIndex = (status?.chunks ?? 0) > 0;
  const activeJob = status?.activeJobs[0] ?? null;
  const sessionResults = useMemo(() => groupHitsBySession(hits), [hits]);
  const isBusy = indexing || Boolean(activeJob);
  const trimmedQuery = filters.query.trim();
  const filtersActive = searchFiltersAreActive(filters);

  // Browser back/forward updates the router first; mirror that durable state
  // into the controlled search form without resetting equivalent local state.
  useEffect(() => {
    if (!routeFilters) return;
    setFilters((current) => searchFiltersAreEqual(current, routeFilters) ? current : routeFilters);
  }, [routeFilters]);

  // Hit list ordering for keyboard navigation.
  const flatMoments = useMemo<KnowledgeHit[]>(() => {
    const ordered: KnowledgeHit[] = [];
    for (const session of sessionResults) ordered.push(...session.moments);
    return ordered;
  }, [sessionResults]);

  const applySearchResponse = useCallback(
    (next: SearchFilters, response: SearchResponse) => {
      setHits(response.hits);
      setStatus(response.status);
      updateKnowledgeSearchSnapshot({
        results: response.hits,
        status: response.status,
        lastFilterKey: knowledgeSearchFilterKey(next),
      });
      const deepLinked = hitId
        ? response.hits.find((entry) => entry.id === hitId)
        : undefined;
      const nextHit = deepLinked ?? response.hits[0];
      if (nextHit) {
        inspectKnowledgeHit(nextHit, next.query, next);
      } else {
        clearKnowledgeHit();
      }
    },
    [hitId, inspectKnowledgeHit, clearKnowledgeHit],
  );

  const runSearch = useCallback(
    async (nextFilters: SearchFilters) => {
      const trimmed = nextFilters.query.trim();
      if (!trimmed) {
        setHits([]);
        clearKnowledgeHit();
        return;
      }
      setSearching(true);
      try {
        setError(null);
        applySearchResponse(nextFilters, await searchKnowledge(trimmed, nextFilters));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSearching(false);
      }
    },
    [applySearchResponse, clearKnowledgeHit],
  );

  const refreshIndex = useCallback(async (force = false) => {
    setIndexing(true);
    try {
      setError(null);
      const response = await indexSessions(force);
      setStatus(response.status);
      setStatusLoaded(true);
      updateKnowledgeSearchSnapshot({ status: response.status, indexedAt: Date.now() });
      const live = filtersRef.current;
      if (response.status.chunks > 0 && live.query.trim()) {
        applySearchResponse(live, await searchKnowledge(live.query.trim(), live));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  }, [applySearchResponse]);

  // Always refresh the default session window when the page opens.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let freshStatus: KnowledgeStatus | null = null;
      try {
        const next = await fetchStatus();
        if (cancelled) return;
        freshStatus = next;
        setStatus(next);
        setStatusLoaded(true);
        updateKnowledgeSearchSnapshot({ status: next });
        setError(null);
      } catch {
        // Indexing below will surface a hard failure if status is also unavailable.
      }

      if (cancelled) return;
      // Skip the POST re-index when this session indexed recently and the
      // live status still reports an indexed corpus; keep re-indexing when
      // the recency window lapsed (new transcripts must become searchable),
      // the index is missing, or the fresh status could not confirm it.
      const { indexedAt } = getKnowledgeSearchSnapshot();
      const recentlyIndexed = indexedAt !== null
        && Date.now() - indexedAt < KNOWLEDGE_SEARCH_REINDEX_TTL_MS;
      if (recentlyIndexed && (freshStatus?.chunks ?? 0) > 0) {
        return;
      }
      setIndexing(true);
      try {
        setError(null);
        const response = await indexSessions(false);
        if (cancelled) return;
        setStatus(response.status);
        setStatusLoaded(true);
        updateKnowledgeSearchSnapshot({ status: response.status, indexedAt: Date.now() });
        const live = filtersRef.current;
        if (response.status.chunks > 0 && live.query.trim()) {
          applySearchResponse(live, await searchKnowledge(live.query.trim(), live));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatusLoaded(true);
        }
      } finally {
        if (!cancelled) setIndexing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySearchResponse]);

  // Lazy-load facet primitives once the index is ready (so we have values).
  useEffect(() => {
    if (!hasIndex || primitivesLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchPrimitives(["harness", "project", "sourceKind"]);
        if (!cancelled) {
          setPrimitives(next);
          setPrimitivesLoaded(true);
          updateKnowledgeSearchSnapshot({ facets: next });
        }
      } catch {
        if (!cancelled) setPrimitivesLoaded(true); // fall back to "no facets" quietly
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasIndex, primitivesLoaded]);

  // Re-run search whenever filters change AND we have an indexed corpus to query.
  useEffect(() => {
    if (!hasIndex) return;
    const timer = window.setTimeout(() => {
      void runSearch(filters);
    }, KNOWLEDGE_SEARCH_DEFAULTS.debounceMs);
    return () => window.clearTimeout(timer);
  }, [filters, hasIndex, runSearch]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasIndex && !indexing) {
      void refreshIndex(false);
      return;
    }
    void runSearch(filters);
  };

  const updateFilters = useCallback((patch: Partial<SearchFilters>) => {
    setFilters((current) => {
      const next = { ...current, ...patch };
      if (searchFiltersAreEqual(current, next)) return current;
      navigate({
        view: "search",
        ...(_mode ? { mode: _mode } : {}),
        filters: next,
      }, { replace: true });
      return next;
    });
  }, [_mode, navigate]);

  const clearAll = useCallback(() => {
    const next = createEmptySearchFilters();
    setFilters(next);
    navigate({
      view: "search",
      ...(_mode ? { mode: _mode } : {}),
      filters: next,
    }, { replace: true });
  }, [_mode, navigate]);

  const focusFirstHit = useCallback(() => {
    if (flatMoments[0]) {
      inspectKnowledgeHit(flatMoments[0], filtersRef.current.query);
    }
  }, [flatMoments, inspectKnowledgeHit]);

  // Hot-keys: "/" focuses the input, "Esc" clears, j/k moves selection.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const inField = target
        && (target.tagName === "INPUT"
          || target.tagName === "TEXTAREA"
          || target.isContentEditable);
      if (event.key === "/" && !inField) {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".ks-search-input");
        input?.focus();
        input?.select();
      } else if (event.key === "Escape" && !inField) {
        if (flatMoments.length > 0) clearKnowledgeHit();
        else clearAll();
      } else if (!inField && (event.key === "j" || event.key === "k")) {
        if (flatMoments.length === 0) return;
        event.preventDefault();
        const currentIndex = selectedKnowledgeHit
          ? flatMoments.findIndex((hit) => hit.id === selectedKnowledgeHit.id)
          : -1;
        const nextIndex = event.key === "j"
          ? Math.min(flatMoments.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
        const targetHit = flatMoments[nextIndex];
        if (targetHit) inspectKnowledgeHit(targetHit, filtersRef.current.query);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flatMoments, inspectKnowledgeHit, clearKnowledgeHit, selectedKnowledgeHit, clearAll]);

  const updatedLabel = status
    ? formatClockTimestamp(status.generatedAt) || "just now"
    : "—";

  const footStatus = isBusy
    ? activeJob
      ? `Indexing ${formatCount(activeJob.progress.indexed ?? 0)} of ${formatCount(activeJob.progress.discovered ?? 0)}`
      : hasIndex
        ? `Refreshing last ${KNOWLEDGE_SEARCH_DEFAULTS.days} days in the background`
        : `Building last ${KNOWLEDGE_SEARCH_DEFAULTS.days} days of sessions`
    : hasIndex
      ? `${formatCount(status?.chunks ?? 0)} moments · last ${KNOWLEDGE_SEARCH_DEFAULTS.days} days · updated ${updatedLabel}`
      : statusLoaded
        ? "No index yet"
        : "Loading index";

  const harnessOptions = topFacetValues(primitives?.facets, "harness");
  const projectOptions = topFacetValues(primitives?.facets, "project");

  return (
    <main className="ks-page">
      <div className="ks-shell">
        <header className="ks-header">
          <div className="ks-header-titles">
            <span className="ks-eyebrow">Search</span>
            <h1>Find anything you ran, opened, or decided</h1>
            <p>Search across sessions, skills, MCP tools, codebase, and context packs from the last {KNOWLEDGE_SEARCH_DEFAULTS.days} days.</p>
          </div>
        </header>

        <form className="ks-search-form" onSubmit={onSubmit} role="search">
          <SearchIcon size={17} strokeWidth={1.75} aria-hidden="true" />
          <input
            value={filters.query}
            onChange={(event) => updateFilters({ query: event.target.value })}
            placeholder="Search topics, files, decisions, agents…"
            className="ks-search-input"
            spellCheck={false}
            autoFocus
            aria-label="Search OpenScout knowledge"
          />
          {filters.query ? (
            <button
              type="button"
              className="ks-search-clear"
              onClick={() => updateFilters({ query: "" })}
              aria-label="Clear search"
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : (
            <span className="ks-search-hint" aria-hidden="true">/</span>
          )}
          {searching ? <Loader2 size={15} className="ks-spin" aria-hidden="true" /> : null}
        </form>

        <section className="ks-filterbar" aria-label="Search filters">
          <div className="ks-filterbar-row">
            <span className="ks-filterbar-label">
              <Filter size={12} aria-hidden="true" />
              Source
            </span>
            <div className="ks-chip-row" role="group" aria-label="Source kind filters">
              {SEARCH_SOURCE_KIND_ORDER.map((kind) => (
                <FilterChip
                  key={kind}
                  active={filters.sourceKinds.includes(kind)}
                  onClick={() => updateFilters({
                    sourceKinds: filters.sourceKinds.includes(kind)
                      ? filters.sourceKinds.filter((entry) => entry !== kind)
                      : [...filters.sourceKinds, kind],
                  })}
                  label={KNOWLEDGE_SOURCE_KIND_LABELS[kind] ?? kind}
                />
              ))}
            </div>
          </div>

          {harnessOptions.length > 0 ? (
            <div className="ks-filterbar-row">
              <span className="ks-filterbar-label">
                <Sparkles size={12} aria-hidden="true" />
                Agent
              </span>
              <div className="ks-chip-row" role="group" aria-label="Harness filters">
                {harnessOptions.map((entry) => (
                  <FilterChip
                    key={`harness:${entry.value}`}
                    active={filters.harness.includes(entry.value)}
                    onClick={() => updateFilters({
                      harness: filters.harness.includes(entry.value)
                        ? filters.harness.filter((current) => current !== entry.value)
                        : [...filters.harness, entry.value],
                    })}
                    label={titleCase(entry.value)}
                    count={entry.count}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {projectOptions.length > 0 ? (
            <div className="ks-filterbar-row">
              <span className="ks-filterbar-label">
                <ChevronDown size={12} aria-hidden="true" />
                Project
              </span>
              <div className="ks-chip-row" role="group" aria-label="Project filters">
                {projectOptions.map((entry) => (
                  <FilterChip
                    key={`project:${entry.value}`}
                    active={filters.project.includes(entry.value)}
                    onClick={() => updateFilters({
                      project: filters.project.includes(entry.value)
                        ? filters.project.filter((current) => current !== entry.value)
                        : [...filters.project, entry.value],
                    })}
                    label={entry.value}
                    count={entry.count}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <div className="ks-filterbar-row ks-filterbar-row--inline">
            <span className="ks-filterbar-label">
              <Clock size={12} aria-hidden="true" />
              Time
            </span>
            <div className="ks-chip-row" role="group" aria-label="Time window filter">
              <FilterChip
                active={filters.timeWindow === "all"}
                onClick={() => updateFilters({ timeWindow: "all" })}
                label="Any time"
              />
              {TIME_WINDOWS.map((option) => (
                <FilterChip
                  key={option.value}
                  active={filters.timeWindow === option.value}
                  onClick={() => updateFilters({ timeWindow: option.value as SearchTimeWindow })}
                  label={option.label}
                />
              ))}
            </div>
            {filterChipsActive(filters) ? (
              <button type="button" className="ks-clear-all" onClick={clearAll}>
                Clear filters
              </button>
            ) : null}
          </div>
        </section>

        {error ? (
          <section className="ks-error" role="alert">
            {error}
          </section>
        ) : null}

        {!hasIndex && !error ? (
          <div className="ks-empty-state">
            <strong>{indexing ? "Preparing your session index" : "Preparing search"}</strong>
            <span>
              First load builds the last {KNOWLEDGE_SEARCH_DEFAULTS.days} days
              {" "}(up to {formatCount(KNOWLEDGE_SEARCH_DEFAULTS.sessionLimit)} sessions).
              You can keep this page open — results appear as soon as the index is ready.
            </span>
          </div>
        ) : null}

        {hasIndex ? (
          <div className="ks-hit-list" role="listbox" aria-label="Search results">
            <div className="ks-hit-list-head" aria-live="polite">
              <span>
                {searching
                  ? "Searching…"
                  : trimmedQuery
                    ? `${formatCount(sessionResults.length)} session${sessionResults.length === 1 ? "" : "s"}`
                    : "Ready"}
              </span>
              {trimmedQuery && hits.length > 0 ? (
                <span className="ks-hit-list-meta">
                  {formatCount(hits.length)} moment{hits.length === 1 ? "" : "s"}
                  {filtersActive ? <> · <button type="button" className="ks-text-action" onClick={clearAll}>Clear filters</button></> : null}
                </span>
              ) : null}
            </div>

            {trimmedQuery && sessionResults.length === 0 && !searching ? (
              <div className="ks-empty-hit">
                <strong>No matches for “{trimmedQuery}”</strong>
                <span>
                  Try a project name, file path, or topic from recent work
                  {filtersActive ? ", or clear one of the filters above." : "."}
                </span>
                <div className="ks-empty-hit-actions">
                  <button type="button" className="ks-text-action" onClick={() => updateFilters({ query: "" })}>
                    Clear query
                  </button>
                  {filtersActive ? (
                    <button type="button" className="ks-text-action" onClick={clearAll}>
                      Clear all filters
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {!trimmedQuery ? (
              <div className="ks-empty-hit ks-empty-hit--quiet">
                <strong>Start with a query</strong>
                <span>
                  Type a topic, file path, agent, or session hint. Use{" "}
                  <kbd>/</kbd> to focus this field, <kbd>j</kbd>/<kbd>k</kbd> to walk results, <kbd>↵</kbd> to select, <kbd>⌘↵</kbd> to open the session.
                </span>
                <button type="button" className="ks-text-action" onClick={focusFirstHit} disabled={hits.length === 0}>
                  Pick the first result automatically
                </button>
              </div>
            ) : null}

            <div className="ks-hit-list-body">
              {sessionResults.map((session, sessionIndex) => {
                const best = session.best;
                const routing = resultRoutingContext(best);
                const goal = resultSessionGoal(best);
                const sessionId = transcriptSessionId(firstTranscriptRef(best));
                const openSession = () => {
                  if (!sessionId) return;
                  navigate({ view: "sessions", sessionId });
                };
                const sessionSelected = session.moments.some(
                  (moment) => selectedKnowledgeHit?.id === moment.id,
                );

                return (
                  <section
                    key={session.collectionId}
                    className={`ks-session${sessionSelected ? " ks-session--selected" : ""}`}
                    aria-label={`Session ${sessionIndex + 1}`}
                  >
                    <header className="ks-session-head">
                      <div className="ks-session-topline">
                        <div className="ks-session-meta">
                          {routing.agent ? <span className="ks-hit-chip">{routing.agent}</span> : null}
                          {routing.project ? <span>{routing.project}</span> : null}
                          {routing.session ? (
                            <span className="ks-hit-session" title={sessionId ?? routing.session}>
                              session {routing.session}
                            </span>
                          ) : null}
                          <span className="ks-session-count">
                            {formatCount(session.moments.length)} match{session.moments.length === 1 ? "" : "es"}
                          </span>
                        </div>
                        {routing.when ? <time className="ks-hit-when">{routing.when}</time> : null}
                      </div>
                      <button
                        type="button"
                        className="ks-session-goal"
                        onClick={openSession}
                        title={sessionId ? "Open session" : undefined}
                      >
                        {goal}
                      </button>
                    </header>

                    <div className="ks-session-moments">
                      {session.moments.map((hit) => {
                        const momentHeadline = resultMomentHeadline(hit, filters.query);
                        const selected = selectedKnowledgeHit?.id === hit.id;
                        const resultSnippet = displaySnippet(hit, filters.query, 200);
                        const momentBits = resultMomentBits(hit);
                        const selectHit = () => inspectKnowledgeHit(hit, filters.query);
                        const openMomentSession = () => {
                          const id = transcriptSessionId(firstTranscriptRef(hit)) ?? sessionId;
                          if (!id) {
                            selectHit();
                            return;
                          }
                          navigate({ view: "sessions", sessionId: id });
                        };

                        return (
                          <article
                            key={hit.id}
                            className={`ks-hit${selected ? " ks-hit--selected" : ""}`}
                            role="option"
                            aria-selected={selected}
                            tabIndex={0}
                            onClick={selectHit}
                            onDoubleClick={openMomentSession}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                openMomentSession();
                                return;
                              }
                              activateHitFromKeyboard(event, selectHit);
                            }}
                          >
                            <div className="ks-hit-body">
                              {momentBits.length > 0 ? (
                                <div className="ks-hit-details ks-hit-details--moment" aria-label="Turn">
                                  {momentBits.map((bit) => (
                                    <span key={bit} className="ks-hit-details-strong">{bit}</span>
                                  ))}
                                </div>
                              ) : null}

                              <h3 className="ks-hit-title">{momentHeadline}</h3>

                              {resultSnippet && resultSnippet !== momentHeadline ? (
                                <p className="ks-hit-snippet">
                                  <HighlightedText text={resultSnippet} query={filters.query} />
                                </p>
                              ) : null}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <footer className="ks-foot-status" aria-live="polite">
        <span className="ks-foot-status-facts">
          {isBusy ? <Loader2 size={12} className="ks-spin" aria-hidden="true" /> : null}
          {footStatus}
          {filterChipsActive(filters) ? <> · {summarizeFilters(filters)}</> : null}
        </span>
        <button
          type="button"
          className="ks-text-action"
          onClick={() => void refreshIndex(true)}
          disabled={indexing}
        >
          {indexing ? "Updating…" : "Update index"}
        </button>
      </footer>
    </main>
  );
}
