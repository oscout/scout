import {
  ChevronRight,
  Eye,
  LogIn,
  Power,
  RefreshCw,
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
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { HerdrMark } from "../../components/HerdrMark.tsx";
import { fetchHerdrTopology } from "../../lib/herdr-topology.ts";
import { timeAgo } from "../../lib/time.ts";
import { isEditableTarget, rovingTabIndex, useListArrowNav } from "../../lib/keyboard-nav.ts";
import { useScout } from "../../scout/Provider.tsx";
import { agentStateLabel, isAgentInTurn } from "../../lib/agent-state.ts";
import { controlTerminalSurface, resolveAgentTerminalSurface } from "../../lib/terminal-relay.ts";
import type { Agent } from "../../lib/types.ts";
import {
  sortTerminalSessionItems,
  terminalSessionActivityAt,
  terminalSessionLifecycle,
} from "./session-table.ts";
import {
  groupTerminalNavItems,
  isStoppedHostItem,
  normalizeTerminalNavMode,
  projectLabel,
  TERMINAL_NAV_MODES,
  type TerminalNavMode,
  type TerminalNavSection,
} from "./terminal-nav-model.ts";
import {
  markedHarness,
  summarizeHerdrTopology,
  terminalNavRow,
  type TerminalNavHerdrSummary,
  type TerminalNavRowModel,
} from "./terminal-nav-row.ts";
import "../../scout/slots/ctx-panel.css";
import "../../scout/slots/terminal-left-panel.css";

const TERMINAL_NAV_REFRESH_MS = 8_000;
type TerminalNavSort = "recent" | "name";
type TerminalListItemRow = ReturnType<typeof terminalListItems>[number];

/**
 * Every row's mark sits in one 34px tile (see terminal-left-panel.css) so the
 * column lines up; what changes is the glyph inside. herdr fills its tile,
 * which is what sets a layout apart from a single agent.
 */
const TERMINAL_NAV_GLYPH = 18;
const TERMINAL_NAV_HERDR_GLYPH = 26;
const TERMINAL_NAV_CHIP_GLYPH = 13;
/**
 * A herdr layout's harnesses: a small overlapped pile, each with its pane
 * count badged on. 12px is half the logos' 24-unit grid, so on a 2x screen
 * every unit is one device pixel; centred in an 18px disc it sits on whole
 * pixels too. The outline keeps hairline details solid at this size.
 */
const TERMINAL_NAV_PANE_GLYPH = 12;
const TERMINAL_NAV_PANE_OUTLINE = 0.35;

/**
 * The rail is an index with two cuts of the same terminals: Projects and
 * Recent. A row says what is in a terminal (who is working, what they last
 * did, which harnesses a herdr layout holds) rather than how it is hosted,
 * and stopped herdr layouts fold to one line per group.
 */

export function TerminalLeft() {
  const { route, navigate, agents } = useScout();
  const [state, setState] = useState<
    | { state: "loading"; sessions: TerminalSessionRecord[] }
    | { state: "ready"; sessions: TerminalSessionRecord[] }
    | { state: "failed"; sessions: TerminalSessionRecord[]; error: string }
  >({ state: "loading", sessions: [] });
  const sort: TerminalNavSort = "recent";
  const [storedNavMode, setNavMode] = usePersistentState<string>("terminal-nav-mode", "projects");
  const navMode: TerminalNavMode = normalizeTerminalNavMode(storedNavMode);
  const [herdrSummaries, setHerdrSummaries] = useState<ReadonlyMap<string, TerminalNavHerdrSummary>>(new Map());
  const [expandedStopped, setExpandedStopped] = useState<ReadonlySet<string>>(new Set());
  const [inactiveExpanded, setInactiveExpanded] = useState(false);
  const [releasingItemId, setReleasingItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = useListArrowNav();
  /**
   * Finding a terminal has one door: the field on the Terminals stage. The
   * rail no longer carries a search box of its own, so "/" pressed while the
   * rail is showing goes to that field — opening the stage first when a
   * terminal session, not the picker, is on screen.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const focusFind = () => {
        const field = document.querySelector<HTMLInputElement>("[data-terminal-find]");
        if (!field) return false;
        field.focus();
        field.select();
        return true;
      };
      if (focusFind()) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      navigate({ view: "terminal" });
      // The stage mounts on the next paint; retry once after it does.
      requestAnimationFrame(() => { if (!focusFind()) requestAnimationFrame(focusFind); });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

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
  // A running herdr session's record carries no folder and no agents; its
  // topology does. Read it for live sessions only, on the rail's own cadence.
  const liveHerdrNames = useMemo(
    () => items
      .filter((item) => item.surface.backend === "herdr" && !isStoppedHostItem(item))
      .map((item) => item.surface.sessionName)
      .sort()
      .join("\n"),
    [items],
  );
  useEffect(() => {
    const names = liveHerdrNames ? liveHerdrNames.split("\n") : [];
    if (names.length === 0) {
      setHerdrSummaries(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(names.map(async (name) => {
      const summary = await fetchHerdrTopology(name).then(summarizeHerdrTopology).catch(() => null);
      return [name, summary] as const;
    })).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, TerminalNavHerdrSummary>();
      for (const [name, summary] of entries) if (summary) next.set(name, summary);
      setHerdrSummaries(next);
    });
    return () => {
      cancelled = true;
    };
  }, [liveHerdrNames, state.sessions]);
  const rowModels = useMemo(() => {
    const models = new Map<string, TerminalNavRowModel>();
    for (const item of items) {
      const owner = agents.find((agent) => {
        const surface = resolveAgentTerminalSurface(agent);
        return surface != null
          && surface.backend === item.surface.backend
          && surface.sessionName === item.surface.sessionName;
      }) ?? null;
      const herdr = item.surface.backend === "herdr"
        ? herdrSummaries.get(item.surface.sessionName) ?? null
        : null;
      models.set(item.id, terminalNavRow(item, owner, herdr));
    }
    return models;
  }, [agents, herdrSummaries, items]);
  const currentItems = items.filter((item) => terminalSessionLifecycle(item) === "current");
  const navSections = groupTerminalNavItems(currentItems, navMode, {
    isWorking: (item) => rowModels.get(item.id)?.working ?? false,
    projectOf: (item) => item.surface.backend === "herdr"
      ? herdrSummaries.get(item.surface.sessionName)?.project ?? null
      : null,
  });
  const inactiveItems = items.filter((item) => terminalSessionLifecycle(item) === "inactive");
  const reviewItems = items.filter((item) => terminalSessionLifecycle(item) === "review");
  const inactiveCount = inactiveItems.length + reviewItems.length;
  const reviewCount = reviewItems.length;
  const showInactive = inactiveExpanded;
  const visibleAgents = agentTargets;
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
  const firstRowId = navSections.find((section) => section.items.length > 0)?.items[0]?.id
    ?? (showInactive ? inactiveItems[0]?.id ?? reviewItems[0]?.id : undefined)
    ?? (visibleAgents[0] ? `agent:${visibleAgents[0].id}` : undefined);
  const stoppedCount = currentItems.filter(isStoppedHostItem).length;
  const summary = state.state === "loading" && items.length === 0
    ? "Syncing"
    : `${currentItems.length - stoppedCount} running${stoppedCount > 0 ? ` · ${stoppedCount} stopped` : ""}`;
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
  const renderTerminalItem = (item: TerminalListItemRow, options: { withProject?: boolean } = {}) => {
    const active = isActiveTerminalItem(item);
    const lifecycle = terminalSessionLifecycle(item);
    const releasing = releasingItemId === item.id;
    const row = rowModels.get(item.id) ?? terminalNavRow(item, null, null);
    const activityAt = terminalSessionActivityAt(item);
    const when = row.working ? "now" : activityAt !== null ? timeAgo(activityAt) : "";
    const place = row.panes?.project ?? projectLabel(item);
    return (
      <div
        key={item.id}
        className={`terminal-nav-row${active ? " terminal-nav-row--active" : ""}${lifecycle === "review" ? " terminal-nav-row--review" : ""}${row.panes ? " terminal-nav-row--layout" : ""}`}
        title={item.surface.sessionName}
      >
        <button
          type="button"
          data-list-primary
          className="terminal-nav-row-select"
          tabIndex={rovingTabIndex(active, hasAnyActive, item.id === firstRowId)}
          onClick={() => navigate(terminalRouteFor(item))}
        >
          <span className="terminal-nav-mark" data-kind={row.mark.kind}>
            {row.mark.kind === "herdr" ? (
              <HerdrMark size={TERMINAL_NAV_HERDR_GLYPH} title={null} />
            ) : row.mark.kind === "harness" ? (
              <HarnessMark harness={row.mark.harness} size={TERMINAL_NAV_GLYPH} title={null} />
            ) : (
              <span className="terminal-nav-mark-shell">&gt;_</span>
            )}
            {row.working && <span className="terminal-nav-mark-working" aria-label="working" />}
          </span>
          <span className="terminal-nav-row-main">
            <span className="terminal-nav-row-title">
              <span className="terminal-nav-row-name">{row.title}</span>
              {row.panes && row.panes.paneCount > 0 && (
                <span className="terminal-nav-panes">
                  {row.panes.panes.map((group) => (
                    <span
                      key={group.harness}
                      className={`terminal-nav-pane-chip${group.working > 0 ? " terminal-nav-pane-chip--working" : ""}`}
                      title={`${group.count} ${group.harness}${group.working > 0 ? `, ${group.working} working` : ""}`}
                    >
                      <HarnessMark harness={group.harness} size={TERMINAL_NAV_PANE_GLYPH} outline={TERMINAL_NAV_PANE_OUTLINE} title={null} />
                      {group.count > 1 ? (
                        <span className="terminal-nav-pane-count">{group.count}</span>
                      ) : group.working > 0 ? (
                        <span className="terminal-nav-pane-count terminal-nav-pane-count--dot" />
                      ) : null}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="terminal-nav-row-detail">
              {[
                row.handle,
                options.withProject ? place : null,
                row.panes && row.panes.paneCount > 0
                  ? `${row.panes.paneCount} ${row.panes.paneCount === 1 ? "pane" : "panes"}${row.panes.working > 0 ? ` · ${row.panes.working} working` : ""}`
                  : null,
              ].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span className="terminal-nav-row-when">
            {lifecycle === "review" ? <span className="terminal-nav-badge terminal-nav-badge--review">review</span> : when}
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

  const renderStoppedFold = (section: TerminalNavSection) => {
    if (section.stopped.length === 0) return null;
    const expanded = expandedStopped.has(section.key);
    const names = section.stopped.map((item) => item.surface.sessionName).join(" · ");
    return (
      <>
        <button
          type="button"
          className="terminal-nav-stopped"
          aria-expanded={expanded}
          title={`Stopped herdr layouts: ${names}`}
          onClick={() => setExpandedStopped((current) => {
            const next = new Set(current);
            if (next.has(section.key)) next.delete(section.key);
            else next.add(section.key);
            return next;
          })}
        >
          <span className="terminal-nav-stopped-mark"><HerdrMark size={TERMINAL_NAV_GLYPH} title={null} /></span>
          <span className="terminal-nav-stopped-count">
            {section.stopped.length} stopped {section.stopped.length === 1 ? "layout" : "layouts"}
          </span>
          <ChevronRight size={12} strokeWidth={1.8} className="terminal-nav-stopped-chevron" />
          {!expanded && <span className="terminal-nav-stopped-names">{names}</span>}
        </button>
        {expanded && section.stopped.map((item) => renderTerminalItem(item, { withProject: navMode === "recent" }))}
      </>
    );
  };
  const renderSection = (section: TerminalNavSection) => {
    if (section.items.length === 0 && section.stopped.length === 0) return null;
    const when = section.working
      ? "now"
      : section.latestActivity !== null ? timeAgo(section.latestActivity) : "";
    return (
      <div className="terminal-nav-section" key={section.key}>
        <div className={`terminal-nav-section-title${section.working ? " terminal-nav-section-title--working" : ""}`}>
          <span>{section.label}</span>
          {navMode === "projects" && when && <span className="terminal-nav-section-when">{when}</span>}
          <span>{section.items.length || ""}</span>
        </div>
        {section.items.map((item) => renderTerminalItem(item, { withProject: navMode === "recent" }))}
        {renderStoppedFold(section)}
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
      <div className="terminal-nav-modes" role="tablist" aria-label="Index terminals by">
        {TERMINAL_NAV_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="tab"
            title={mode.title}
            aria-selected={navMode === mode.id}
            className={`terminal-nav-mode${navMode === mode.id ? " terminal-nav-mode--active" : ""}`}
            onClick={() => setNavMode(mode.id)}
          >
            {mode.label}
          </button>
        ))}
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
        {items.length === 0 && visibleAgents.length === 0 && state.state !== "loading" ? (
          <div className="ctx-panel-empty">No terminal targets</div>
        ) : (
          <>
            {navSections.map((section) => renderSection(section))}
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
                    {inactiveItems.map((item) => renderTerminalItem(item))}
                    {reviewItems.length > 0 && (
                      <div className="terminal-nav-section-title terminal-nav-section-title--review">
                        <span>Review after 30 days</span>
                        <span>{reviewItems.length}</span>
                      </div>
                    )}
                    {reviewItems.map((item) => renderTerminalItem(item))}
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
                      {markedHarness(agent.harness) ? (
                        <span className="terminal-nav-mark" data-kind="harness">
                          <HarnessMark harness={markedHarness(agent.harness)!} size={TERMINAL_NAV_GLYPH} title={null} />
                          {isAgentInTurn(agent.state, agent) && <span className="terminal-nav-mark-working" aria-label="working" />}
                        </span>
                      ) : (
                        <span className={`terminal-nav-agent-dot${terminalSurface ? " terminal-nav-agent-dot--bound" : ""}`} aria-hidden />
                      )}
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

function basename(path: string | null | undefined): string | null {
  const trimmed = path?.trim().replace(/\/+$/u, "");
  if (!trimmed) return null;
  return trimmed.split("/").pop() || trimmed;
}
