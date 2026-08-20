import {
  Activity,
  ChevronRight,
  Clock,
  Eye,
  Folder,
  Layers,
  LogIn,
  Power,
  RefreshCw,
  Terminal as TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistentState } from "@hudsonkit";
import {
  collapseHerdrSessionItems,
  fetchTerminalSessions,
  surfaceKey,
  terminalListItems,
  terminalSurfaceIdsEqual,
} from "../../lib/terminal-sessions.ts";
import type { TerminalSessionRecord } from "@openscout/protocol";
import { makeSearchHandoff, rovingTabIndex, useListArrowNav, useSlashToFocus } from "../../lib/keyboard-nav.ts";
import { useScout } from "../../scout/Provider.tsx";
import { agentStateLabel } from "../../lib/agent-state.ts";
import { controlTerminalSurface, resolveAgentTerminalSurface } from "../../lib/terminal-relay.ts";
import type { Agent } from "../../lib/types.ts";
import { sortTerminalSessionItems, terminalSessionLifecycle } from "./session-table.ts";
import {
  groupTerminalNavItems,
  TERMINAL_NAV_MODES,
  type TerminalNavMode,
} from "./terminal-nav-model.ts";
import "../../scout/slots/ctx-panel.css";
import "../../scout/slots/terminal-left-panel.css";

const TERMINAL_NAV_REFRESH_MS = 8_000;
type TerminalNavSort = "recent" | "name";

const TERMINAL_NAV_SORTS: ReadonlyArray<{ id: TerminalNavSort; label: string }> = [
  { id: "recent", label: "Recent" },
  { id: "name", label: "A–Z" },
];

/**
 * The rail is a navigator, not a single list: the same targets can be cut by
 * fleet intentionality, by project, by recency, or by attention state. The
 * mode switcher picks the axis; search and sort apply inside whatever grouping
 * the axis produces.
 */
const TERMINAL_NAV_MODE_ICONS: Record<TerminalNavMode, typeof Layers> = {
  fleet: Layers,
  places: Folder,
  time: Clock,
  attention: Activity,
};

export function TerminalLeft() {
  const { route, navigate, agents } = useScout();
  const [state, setState] = useState<
    | { state: "loading"; sessions: TerminalSessionRecord[] }
    | { state: "ready"; sessions: TerminalSessionRecord[] }
    | { state: "failed"; sessions: TerminalSessionRecord[]; error: string }
  >({ state: "loading", sessions: [] });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TerminalNavSort>("recent");
  const [navMode, setNavMode] = usePersistentState<TerminalNavMode>("terminal-nav-mode", "fleet");
  const [inactiveExpanded, setInactiveExpanded] = useState(false);
  const [releasingItemId, setReleasingItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = useListArrowNav();
  const onSearchKeyDown = makeSearchHandoff(() => listRef.current);
  useSlashToFocus(useCallback(() => inputRef.current, []));

  const load = useCallback((options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setState((current) => ({ state: "loading", sessions: current.sessions }));
    }
    void fetchTerminalSessions({ includeDiscovered: true })
      .then((sessions) => {
        setState({ state: "ready", sessions });
      })
      .catch((error) => {
        if (options.silent) return;
        setState((current) => ({
          state: "failed",
          sessions: current.sessions,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        load({ silent: true });
      }
    };
    const interval = window.setInterval(refreshIfVisible, TERMINAL_NAV_REFRESH_MS);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [load]);

  // Raw per-surface items stay around for agent dedup (a pane-level agent
  // surface must match even when its herdr session collapsed to one row);
  // the rail itself displays one row per herdr session.
  const allItems = useMemo(() => terminalListItems(state.sessions), [state.sessions]);
  const items = useMemo(
    () => sortTerminalSessionItems(
      collapseHerdrSessionItems(allItems),
      sort === "recent"
        ? { column: "activity", direction: "desc" }
        : { column: "name", direction: "asc" },
    ),
    [sort, allItems],
  );
  const agentTargets = useMemo(
    () => sortTerminalAgentsForNav(agents, sort).filter((agent) => {
      const surface = resolveAgentTerminalSurface(agent);
      if (!surface) return true;
      return !allItems.some((item) =>
        item.surface.backend === surface.backend
        && item.surface.sessionName === surface.sessionName
        && (surface.paneId == null || item.surface.paneId === surface.paneId)
      );
    }),
    [agents, allItems, sort],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = normalizedQuery
    ? items.filter((item) => item.searchable.includes(normalizedQuery))
    : items;
  const currentItems = visibleItems.filter((item) => terminalSessionLifecycle(item) === "current");
  const navSections = groupTerminalNavItems(currentItems, navMode);
  const inactiveItems = visibleItems.filter((item) => terminalSessionLifecycle(item) === "inactive");
  const reviewItems = visibleItems.filter((item) => terminalSessionLifecycle(item) === "review");
  const inactiveCount = normalizedQuery
    ? inactiveItems.length + reviewItems.length
    : items.filter((item) => terminalSessionLifecycle(item) !== "current").length;
  const reviewCount = normalizedQuery
    ? reviewItems.length
    : items.filter((item) => terminalSessionLifecycle(item) === "review").length;
  const showInactive = inactiveExpanded || Boolean(normalizedQuery);
  const visibleAgents = normalizedQuery
    ? agentTargets.filter((agent) => terminalAgentSearchable(agent).includes(normalizedQuery))
    : agentTargets;
  const activeTerminalSurfaceKey = route.view === "terminal" ? route.terminalSurfaceKey ?? null : null;
  const activeTerminalSessionId = route.view === "terminal" ? route.terminalSessionId ?? null : null;
  const isActiveTerminalItem = (item: ReturnType<typeof terminalListItems>[number]) =>
    terminalSurfaceIdsEqual(item.key, activeTerminalSurfaceKey)
    && (!activeTerminalSessionId || item.session.id === activeTerminalSessionId);
  const activeAgentKey = route.view === "terminal" && route.agentId ? `agent:${route.agentId}` : null;
  const hasAnyActive = Boolean(
    currentItems.some(isActiveTerminalItem)
    || (showInactive && [...inactiveItems, ...reviewItems].some(isActiveTerminalItem))
    || (activeAgentKey != null && visibleAgents.some((agent) => `agent:${agent.id}` === activeAgentKey)),
  );
  const firstRowId = currentItems[0]?.id
    ?? (showInactive ? inactiveItems[0]?.id ?? reviewItems[0]?.id : undefined)
    ?? (visibleAgents[0] ? `agent:${visibleAgents[0].id}` : undefined);
  const summary = state.state === "loading"
    ? "Syncing"
    : normalizedQuery
      ? `${visibleItems.length + visibleAgents.length}/${items.length + agentTargets.length}`
      : `${items.length + agentTargets.length} targets`;
  const terminalRouteFor = (
    item: ReturnType<typeof terminalListItems>[number],
    mode?: "takeover" | "observe",
  ) => ({
    view: "terminal" as const,
    terminalSessionId: item.session.id,
    terminalSurfaceKey: surfaceKey(item.surface),
    ...(mode ? { mode } : {}),
  });
  const terminalRouteForAgent = (agent: Agent, mode: "takeover" | "observe" = "takeover") => ({
    view: "terminal" as const,
    agentId: agent.id,
    mode,
  });
  const releaseTerminal = async (item: ReturnType<typeof terminalListItems>[number]) => {
    if (item.surface.backend !== "tmux") return;
    if (!window.confirm(
      `Release inactive terminal ${item.surface.sessionName}? The tmux surface will stop, but any associated Scout agent remains available and can be started again.`,
    )) return;
    setReleasingItemId(item.id);
    setActionError(null);
    try {
      await controlTerminalSurface({
        backend: "tmux",
        sessionName: item.surface.sessionName,
        paneId: item.surface.paneId ?? null,
        socketDir: item.surface.socketDir ?? null,
      }, "release");
      load({ silent: true });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setReleasingItemId(null);
    }
  };
  const renderTerminalItem = (item: ReturnType<typeof terminalListItems>[number]) => {
    const active = isActiveTerminalItem(item);
    const lifecycle = terminalSessionLifecycle(item);
    const releasing = releasingItemId === item.id;
    return (
      <div
        key={item.id}
        className={`terminal-nav-row${active ? " terminal-nav-row--active" : ""}${lifecycle === "review" ? " terminal-nav-row--review" : ""}`}
        title={item.surface.sessionName}
      >
        <button
          type="button"
          data-list-primary
          className="terminal-nav-row-select"
          tabIndex={rovingTabIndex(active, hasAnyActive, item.id === firstRowId)}
          onClick={() => navigate(terminalRouteFor(item))}
        >
          <TerminalIcon className="terminal-nav-row-icon" size={14} strokeWidth={1.7} />
          <span className="terminal-nav-row-main">
            <span className="terminal-nav-row-title"><span>{item.title}</span></span>
            <span className="terminal-nav-row-detail">{item.detail || item.session.sourceSessionId}</span>
          </span>
          <span className="terminal-nav-badges">
            <span className="terminal-nav-badge terminal-nav-badge--backend">{item.surface.backend}</span>
            <span className={`terminal-nav-badge${lifecycle === "review" ? " terminal-nav-badge--review" : ""}`}>
              {lifecycle === "current" ? item.condition : lifecycle}
            </span>
          </span>
        </button>
        <div className="terminal-nav-row-actions">
          <button
            type="button"
            className={`terminal-nav-action${route.view === "terminal" && active && route.mode === "takeover" ? " terminal-nav-action--selected" : ""}`}
            onClick={() => navigate(terminalRouteFor(item, "takeover"))}
            title="Enter this terminal"
            aria-label="Enter this terminal"
          >
            <LogIn size={12} strokeWidth={1.8} />
            <span>Enter</span>
          </button>
          <button
            type="button"
            className={`terminal-nav-action${route.view === "terminal" && active && route.mode === "observe" ? " terminal-nav-action--selected" : ""}`}
            onClick={() => navigate(terminalRouteFor(item, "observe"))}
            title="Observe this terminal read-only"
            aria-label="Observe this terminal read-only"
          >
            <Eye size={12} strokeWidth={1.8} />
            <span>Observe</span>
          </button>
          {lifecycle === "review" && item.surface.backend === "tmux" && (
            <button
              type="button"
              className="terminal-nav-action terminal-nav-action--release"
              onClick={() => void releaseTerminal(item)}
              disabled={releasing}
              title="Release this inactive tmux surface; keep the agent"
              aria-label="Release this inactive tmux surface; keep the agent"
            >
              <Power size={12} strokeWidth={1.8} />
              <span>{releasing ? "Releasing" : "Release"}</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="ctx-panel terminal-nav">
      <div className="terminal-nav-head">
        <div>
          <div className="terminal-nav-title">Terminals</div>
          <div className="terminal-nav-summary">{summary}</div>
        </div>
        <button
          type="button"
          className="terminal-nav-refresh"
          onClick={() => load()}
          disabled={state.state === "loading"}
          title="Refresh terminals"
          aria-label="Refresh terminals"
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
      </div>
      <div className="terminal-nav-modes" role="group" aria-label="Group terminals">
        {TERMINAL_NAV_MODES.map((mode) => {
          const ModeIcon = TERMINAL_NAV_MODE_ICONS[mode.id];
          return (
            <button
              key={mode.id}
              type="button"
              title={mode.title}
              aria-label={mode.title}
              aria-pressed={navMode === mode.id}
              className={`terminal-nav-mode${navMode === mode.id ? " terminal-nav-mode--active" : ""}`}
              onClick={() => setNavMode(mode.id)}
            >
              <ModeIcon size={13} strokeWidth={1.8} />
            </button>
          );
        })}
      </div>
      <div className="ctx-panel-toolbar terminal-nav-toolbar">
        <input
          ref={inputRef}
          type="text"
          className="ctx-panel-search-input"
          placeholder="Search…  (/)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        <div className="ctx-panel-sort" role="group" aria-label="Sort terminals">
          {TERMINAL_NAV_SORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              title={option.id === "recent" ? "Sort by most recent" : "Sort alphabetically"}
              aria-pressed={sort === option.id}
              className={`ctx-panel-sort-option${sort === option.id ? " ctx-panel-sort-option--active" : ""}`}
              onClick={() => setSort(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {state.state === "failed" && (
        <div className="terminal-nav-error">{state.error}</div>
      )}
      {actionError && <div className="terminal-nav-error">{actionError}</div>}
      <div
        ref={listRef}
        className="terminal-nav-list"
        onKeyDown={onListKeyDown}
      >
        {visibleItems.length === 0 && visibleAgents.length === 0 && state.state !== "loading" ? (
          <div className="ctx-panel-empty">{items.length + agentTargets.length === 0 ? "No terminal targets" : "No matches"}</div>
        ) : (
          <>
            {navSections.map((section) => {
              if (section.items.length === 0) return null;
              return (
                <div className="terminal-nav-section" key={section.key}>
                  <div className="terminal-nav-section-title">
                    <span>{section.label}</span>
                    <span>{section.items.length}</span>
                  </div>
                  {section.items.map(renderTerminalItem)}
                </div>
              );
            })}
            {currentItems.length === 0 && state.state !== "loading" && (
              <div className="terminal-nav-empty">No sessions</div>
            )}

            {inactiveCount > 0 && (
              <div className="terminal-nav-section terminal-nav-section--inactive">
                <button
                  type="button"
                  className="terminal-nav-inactive-toggle"
                  aria-expanded={showInactive}
                  onClick={() => setInactiveExpanded((expanded) => !expanded)}
                >
                  <ChevronRight size={13} strokeWidth={1.8} />
                  <span>Inactive</span>
                  <span>{inactiveCount}</span>
                  {reviewCount > 0 && <span className="terminal-nav-review-count">{reviewCount} review</span>}
                </button>
                {showInactive && (
                  <>
                    {inactiveItems.map(renderTerminalItem)}
                    {reviewItems.length > 0 && (
                      <div className="terminal-nav-section-title terminal-nav-section-title--review">
                        <span>Review after 30 days</span>
                        <span>{reviewItems.length}</span>
                      </div>
                    )}
                    {reviewItems.map(renderTerminalItem)}
                  </>
                )}
              </div>
            )}

            <div className="terminal-nav-section">
              <div className="terminal-nav-section-title">
                <span>Available agents</span>
                <span>{visibleAgents.length}</span>
              </div>
              {visibleAgents.map((agent) => {
                const key = `agent:${agent.id}`;
                const active = key === activeAgentKey;
                const terminalSurface = resolveAgentTerminalSurface(agent);
                return (
                  <div
                    key={agent.id}
                    className={`terminal-nav-row terminal-nav-row--agent${active ? " terminal-nav-row--active" : ""}`}
                    title={agent.name}
                  >
                    <button
                      type="button"
                      data-list-primary
                      className="terminal-nav-row-select"
                      tabIndex={rovingTabIndex(active, hasAnyActive, key === firstRowId)}
                      onClick={() => navigate(terminalRouteForAgent(agent))}
                    >
                      <span className={`terminal-nav-agent-dot${terminalSurface ? " terminal-nav-agent-dot--bound" : ""}`} aria-hidden />
                      <span className="terminal-nav-row-main">
                        <span className="terminal-nav-row-title">
                          <span>{agent.name}</span>
                        </span>
                        <span className="terminal-nav-row-detail">{terminalAgentDetail(agent)}</span>
                      </span>
                      <span className="terminal-nav-badges">
                        <span className="terminal-nav-badge terminal-nav-badge--backend">{terminalSurface?.backend ?? agent.harness ?? "agent"}</span>
                        <span className="terminal-nav-badge">{terminalSurface ? "bound" : agentStateLabel(agent.state)}</span>
                      </span>
                    </button>
                    <div className="terminal-nav-row-actions">
                      <button
                        type="button"
                        className={`terminal-nav-action${route.view === "terminal" && active && route.mode === "takeover" ? " terminal-nav-action--selected" : ""}`}
                        onClick={() => navigate(terminalRouteForAgent(agent, "takeover"))}
                        title="Enter this agent terminal"
                        aria-label="Enter this agent terminal"
                      >
                        <LogIn size={12} strokeWidth={1.8} />
                        <span>Enter</span>
                      </button>
                      {terminalSurface && (
                        <button
                          type="button"
                          className={`terminal-nav-action${route.view === "terminal" && active && route.mode === "observe" ? " terminal-nav-action--selected" : ""}`}
                          onClick={() => navigate(terminalRouteForAgent(agent, "observe"))}
                          title="Observe this agent terminal read-only"
                          aria-label="Observe this agent terminal read-only"
                        >
                          <Eye size={12} strokeWidth={1.8} />
                          <span>Observe</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {visibleAgents.length === 0 && (
                <div className="terminal-nav-empty">No agents</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function sortTerminalAgentsForNav(agents: Agent[], sort: TerminalNavSort): Agent[] {
  return [...agents]
    .filter((agent) => !agent.retiredFromFleet && !agent.staleLocalRegistration)
    .sort((a, b) => {
      const nameRank = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      if (sort === "name") return nameRank || a.id.localeCompare(b.id);
      const updatedRank = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      return updatedRank || nameRank || a.id.localeCompare(b.id);
    });
}

function terminalAgentDetail(agent: Agent): string {
  const workspace = agent.project
    ?? basename(agent.cwd)
    ?? basename(agent.projectRoot)
    ?? agent.definitionId;
  return [
    agent.handle ? `@${agent.handle}` : null,
    agent.harness,
    workspace,
    agent.branch,
  ].filter(Boolean).join(" · ");
}

function terminalAgentSearchable(agent: Agent): string {
  return [
    agent.name,
    agent.handle,
    agent.harness,
    agent.state,
    agent.project,
    agent.branch,
    agent.cwd,
    agent.projectRoot,
    agent.definitionId,
  ].filter(Boolean).join(" ").toLowerCase();
}

function basename(path: string | null | undefined): string | null {
  const trimmed = path?.trim().replace(/\/+$/u, "");
  if (!trimmed) return null;
  return trimmed.split("/").pop() || trimmed;
}
