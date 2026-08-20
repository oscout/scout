import {
  Check,
  Copy,
  Crosshair,
  Eye,
  LogIn,
  RefreshCw,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import type {
  HerdrAgentStatus,
  HerdrPaneProjection,
  HerdrTabProjection,
} from "@openscout/protocol";

import { usePersistentState } from "@hudsonkit";

import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { compactTerminalPath } from "../../lib/terminal-sessions.ts";
import { createTerminalHostSession } from "../../lib/terminal-hosts.ts";
import type { TerminalRoute } from "../../lib/terminal-relay.ts";
import { focusHerdrPane, useHerdrPaneOutputs, useHerdrPanePeek, useHerdrTopology } from "../../lib/herdr-topology.ts";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import {
  DEFAULT_HERDR_PANE_SORT,
  HERDR_PANE_COLUMNS,
  herdrPaneDirectory,
  herdrPaneDrift,
  herdrPaneLabel,
  lastOutputLine,
  sortHerdrPaneRows,
  toggleHerdrPaneSort,
  type HerdrPaneSort,
} from "./herdr-pane-table.ts";

const HERDR_PANE_SORT_STORAGE_KEY = "openscout.herdr.pane-table-sort.v1";

/**
 * The relay route into this session: a full herdr client in the web terminal,
 * attached to the SAME session (workspaces, tabs, panes keep running for every
 * other client). `terminalAgent` is inert for herdr — the relay spawns the
 * herdr client, not a harness.
 */
export function herdrTerminalRoute(sessionName: string): TerminalRoute {
  return {
    view: "terminal",
    terminalBackend: "herdr",
    terminalAgent: "shell",
    terminalTabId: `herdr-${sessionName}`,
    terminalSessionName: sessionName,
  };
}

/**
 * Projection of a herdr session: workspaces, tabs, panes, the agent state
 * herdr reports, and a faithful replica of the active tab's layout. Panes are
 * entered, not managed — clicking one focuses it in herdr and opens the web
 * terminal on the session; layout changes stay herdr's job.
 */
export function HerdrSessionScreen({
  sessionName,
  navigate,
}: {
  sessionName: string;
  navigate: (route: TerminalRoute) => void;
}) {
  const { topology, error, refresh } = useHerdrTopology(sessionName);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [diveInPaneId, setDiveInPaneId] = useState<string | null>(null);
  const [startState, setStartState] = useState<"idle" | "starting" | "failed">("idle");
  const [startError, setStartError] = useState<string | null>(null);

  const attachCommand = sessionName === "default" ? "herdr" : `herdr session attach ${sessionName}`;
  const running = topology?.running ?? false;

  const start = useCallback(() => {
    setStartState("starting");
    setStartError(null);
    void createTerminalHostSession("herdr", { sessionName })
      .then(() => {
        setStartState("idle");
        refresh();
      })
      .catch((cause) => {
        setStartState("failed");
        setStartError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [sessionName, refresh]);

  const openTerminal = useCallback(() => {
    navigate(herdrTerminalRoute(sessionName));
  }, [navigate, sessionName]);

  // Enter through a pane: focus it in herdr first (focus is shared with every
  // attached client — that is the point) so the web terminal lands on it.
  const enterPane = useCallback((pane: HerdrPaneProjection) => {
    void focusHerdrPane(sessionName, pane.terminalId ?? pane.paneId).catch(() => {});
    navigate(herdrTerminalRoute(sessionName));
  }, [navigate, sessionName]);

  return (
    <div className="s-term s-herdr">
      <header className="s-herdr-header">
        <div className="s-herdr-title">
          <span className="s-herdr-mark"><TerminalIcon size={16} strokeWidth={1.8} /></span>
          <strong>{sessionName}</strong>
          <span className={`s-herdr-state ${running ? "s-herdr-state--live" : ""}`}>
            {topology ? (running ? "running" : "stopped") : "loading"}
          </span>
        </div>
        <div className="s-herdr-actions">
          {running && (
            <button
              type="button"
              className="s-term-workspace-action s-term-workspace-action--primary"
              onClick={openTerminal}
              title="Open a live web terminal attached to this session"
            >
              <LogIn size={13} strokeWidth={1.8} />
              Open terminal
            </button>
          )}
          <AttachCommand command={attachCommand} />
          <button type="button" className="s-term-icon-button" onClick={refresh} title="Refresh" aria-label="Refresh">
            <RefreshCw size={14} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {error && <div className="s-herdr-error">{error}</div>}

      {topology && !running && (
        <div className="s-herdr-empty">
          <TerminalIcon size={22} strokeWidth={1.5} />
          <strong>This herdr session is stopped.</strong>
          <span>The session still exists — herdr sessions are persistent. Start it and the projection fills in.</span>
          <button
            type="button"
            className="s-term-workspace-action s-term-workspace-action--primary"
            onClick={start}
            disabled={startState === "starting"}
          >
            {startState === "starting" ? "Starting…" : "Start it"}
          </button>
          {startError && <code>{startError}</code>}
        </div>
      )}

      {topology && running && topology.workspaces.length === 0 && (
        <div className="s-herdr-empty">
          <TerminalIcon size={22} strokeWidth={1.5} />
          <strong>No workspaces yet.</strong>
          <span>Open this session in herdr to create one — layout is herdr's job, Scout just watches.</span>
        </div>
      )}

      {topology && running && topology.workspaces.length > 0 && (() => {
        // One tab strip across every workspace: herdr tabs are the unit the
        // operator thinks in, so second and third tabs render as tabs, not as
        // more stacked windows. The active tab owns the window replica below.
        const entries = topology.workspaces.flatMap((workspace) =>
          workspace.tabs.map((tab) => ({ workspace, tab })),
        );
        if (entries.length === 0) return null;
        const herdrActiveTabId = topology.workspaces.find((workspace) => workspace.focused)?.activeTabId
          ?? topology.workspaces[0]?.activeTabId
          ?? null;
        const activeEntry = entries.find((entry) => entry.tab.tabId === selectedTabId)
          ?? entries.find((entry) => entry.tab.tabId === herdrActiveTabId)
          ?? entries[0];
        const { workspace: activeWorkspace, tab: activeTab } = activeEntry;
        const selectTab = (tabId: string) => {
          setSelectedTabId(tabId);
          setDiveInPaneId(null);
        };
        return (
          <section className="s-herdr-workspace">
            <div className="s-herdr-workspace-head">
              <span className="s-herdr-workspace-label">{activeWorkspace.label ?? activeWorkspace.workspaceId}</span>
              <AgentStatusBadge status={activeWorkspace.agentStatus} />
            </div>
            <div className="s-herdr-tabs" role="tablist">
              {entries.map(({ workspace, tab }) => (
                <button
                  key={tab.tabId}
                  type="button"
                  role="tab"
                  aria-selected={tab.tabId === activeTab.tabId}
                  className={`s-herdr-tab ${tab.tabId === activeTab.tabId ? "s-herdr-tab--active" : ""}`}
                  title={`${workspace.label ?? workspace.workspaceId} · ${tab.label ?? tab.tabId}`}
                  onClick={() => selectTab(tab.tabId)}
                >
                  <AgentStatusDot status={tab.agentStatus} />
                  <span>{tab.label ?? `Tab ${tab.number ?? ""}`}</span>
                  <TabHarnessMarks tab={tab} />
                  <span className="s-herdr-tab-count">{tab.panes.length}</span>
                </button>
              ))}
            </div>
            {activeTab.layout && (
              <HerdrTabLayoutReplica
                tab={activeTab}
                diveInPaneId={diveInPaneId}
                onEnterPane={enterPane}
                onToggleDiveIn={(paneId) => setDiveInPaneId((current) =>
                  current === paneId ? null : paneId
                )}
              />
            )}
            <HerdrPaneTable
              sessionName={sessionName}
              tab={activeTab}
              onEnterPane={enterPane}
            />
            {diveInPaneId && (() => {
              const diveInPane = activeTab.panes.find((pane) => pane.paneId === diveInPaneId);
              return diveInPane ? (
                <HerdrPaneLiveView
                  sessionName={sessionName}
                  pane={diveInPane}
                  onClose={() => setDiveInPaneId(null)}
                />
              ) : null;
            })()}
          </section>
        );
      })()}
    </div>
  );
}

/**
 * The active tab's real arrangement, rendered from herdr's layout geometry at
 * terminal-cell proportions — a map of the session, not a set of terminals.
 * Clicking a pane focuses it in herdr and opens the web terminal on the
 * session; the hover eye on a pane opens the read-only live peek instead.
 */
function HerdrTabLayoutReplica({
  tab,
  diveInPaneId,
  onEnterPane,
  onToggleDiveIn,
}: {
  tab: HerdrTabProjection;
  diveInPaneId: string | null;
  onEnterPane: (pane: HerdrPaneProjection) => void;
  onToggleDiveIn: (paneId: string) => void;
}) {
  const layout = tab.layout;
  if (!layout) return null;
  const { area } = layout;
  const panesById = new Map(tab.panes.map((pane) => [pane.paneId, pane]));
  // Terminal cells are ~twice as tall as they are wide; scale rows by 2 so the
  // replica reads at the same proportions as the real screen.
  const aspectRatio = `${area.width} / ${Math.max(area.height * 2, 1)}`;
  return (
    <div className="s-herdr-layout-window">
      <div className="s-herdr-layout-titlebar">
        <span className="s-herdr-layout-lights" aria-hidden="true"><i /><i /><i /></span>
        <span className="s-herdr-layout-title">
          {tab.label ?? `Tab ${tab.number ?? ""}`} — {layout.panes.length} {layout.panes.length === 1 ? "pane" : "panes"}
        </span>
        <span className="s-herdr-layout-hint">click a pane to enter</span>
      </div>
      <div className="s-herdr-layout" style={{ aspectRatio }} role="group" aria-label={`Layout of ${tab.label ?? tab.tabId}`}>
        {layout.panes.map((layoutPane) => {
          const pane = panesById.get(layoutPane.paneId);
          const { rect } = layoutPane;
          const style = {
            left: `${((rect.x - area.x) / area.width) * 100}%`,
            top: `${((rect.y - area.y) / area.height) * 100}%`,
            width: `${(rect.width / area.width) * 100}%`,
            height: `${(rect.height / area.height) * 100}%`,
          };
          const diveIn = pane?.paneId === diveInPaneId;
          return (
            <div
              key={layoutPane.paneId}
              role="button"
              tabIndex={0}
              className={`s-herdr-layout-pane ${layoutPane.focused ? "s-herdr-layout-pane--focused" : ""}`}
              style={style}
              onClick={() => pane && onEnterPane(pane)}
              onKeyDown={(event) => {
                if (pane && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  onEnterPane(pane);
                }
              }}
              title={pane ? `Enter ${pane.label ?? pane.paneId} — focus it and open the web terminal` : layoutPane.paneId}
            >
              <span className="s-herdr-layout-pane-head">
                {pane && <AgentStatusDot status={pane.agentStatus} />}
                {pane?.agent && <HarnessMark harness={pane.agent} size={12} className="s-herdr-agent-mark" />}
                <strong className="s-herdr-pane-label">{pane?.label ?? layoutPane.paneId}</strong>
              </span>
              {pane?.foregroundCwd && <span className="s-herdr-cwd">{compactTerminalPath(pane.foregroundCwd)}</span>}
              {pane && (
                <button
                  type="button"
                  className={`s-herdr-layout-pane-peek ${diveIn ? "s-herdr-layout-pane-peek--active" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleDiveIn(pane.paneId);
                  }}
                  title={diveIn ? "Close the live view" : "Watch this pane live"}
                  aria-label={diveIn ? "Close the live view" : "Watch this pane live"}
                  aria-pressed={diveIn}
                >
                  <Eye size={13} strokeWidth={1.8} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The pane table: the active tab's panes as sortable rows — the tabular
 * counterpart to the layout replica above it. The replica answers "where is
 * everything"; the table answers "which of these do I want", sortable by
 * status, directory, drift, or what a pane last printed. Row actions mirror
 * the replica's contract: enter focuses the pane in herdr and opens the web
 * terminal; the eye expands the row with the pane's last visible lines; the
 * crosshair only shifts focus in the herdr client.
 */
function HerdrPaneTable({
  sessionName,
  tab,
  onEnterPane,
}: {
  sessionName: string;
  tab: HerdrTabProjection;
  onEnterPane: (pane: HerdrPaneProjection) => void;
}) {
  const [sort, setSort] = usePersistentState<HerdrPaneSort>(
    HERDR_PANE_SORT_STORAGE_KEY,
    DEFAULT_HERDR_PANE_SORT,
  );
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null);
  const [focusError, setFocusError] = useState<string | null>(null);
  const paneIds = useMemo(() => tab.panes.map((pane) => pane.paneId), [tab.panes]);
  const outputs = useHerdrPaneOutputs(sessionName, paneIds, { lines: 6 });
  const tabLabel = tab.label ?? `Tab ${tab.number ?? ""}`;
  const rows = useMemo(
    () => sortHerdrPaneRows(
      tab.panes.map((pane) => ({ pane, tabLabel, output: outputs[pane.paneId] ?? null })),
      sort,
    ),
    [tab.panes, tabLabel, outputs, sort],
  );

  const focusPane = useCallback((pane: HerdrPaneProjection) => {
    setFocusError(null);
    void focusHerdrPane(sessionName, pane.terminalId ?? pane.paneId)
      .catch((cause) => setFocusError(cause instanceof Error ? cause.message : String(cause)));
  }, [sessionName]);

  return (
    <div className="s-herdr-table-wrap">
      <table className="s-herdr-table" aria-label={`Panes of ${tabLabel}`}>
        <thead>
          <tr>
            {HERDR_PANE_COLUMNS.map((column) => (
              <th
                key={column.id}
                scope="col"
                aria-sort={sort.column === column.id
                  ? (sort.direction === "asc" ? "ascending" : "descending")
                  : "none"}
              >
                <button type="button" onClick={() => setSort(toggleHerdrPaneSort(sort, column.id))}>
                  <span>{column.label}</span>
                  <em aria-hidden="true">
                    {sort.column === column.id ? (sort.direction === "asc" ? "▲" : "▼") : "·"}
                  </em>
                </button>
              </th>
            ))}
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ pane, tabLabel: rowTab, output }) => {
            const expanded = pane.paneId === expandedPaneId;
            const lastLine = lastOutputLine(output);
            const drift = herdrPaneDrift(pane);
            const directory = herdrPaneDirectory(pane);
            return (
              <Fragment key={pane.paneId}>
                <tr
                  className={pane.focused ? "is-focused" : undefined}
                  onClick={() => onEnterPane(pane)}
                  title={`Enter ${herdrPaneLabel(pane)} — focus it and open the web terminal`}
                >
                  <td className="s-herdr-table-pane">
                    <AgentStatusDot status={pane.agentStatus} />
                    <strong title={pane.paneId}>{herdrPaneLabel(pane)}</strong>
                    {pane.focused && <span className="s-herdr-focused">focused in herdr</span>}
                  </td>
                  <td className="s-herdr-table-harness">
                    {pane.agent
                      ? (
                        <span title={pane.agent} className="s-herdr-table-harness-mark">
                          <HarnessMark harness={pane.agent} size={13} className="s-herdr-agent-mark" />
                        </span>
                      )
                      : (
                        <span title="shell — no agent running" className="s-herdr-table-harness-mark">
                          <TerminalIcon size={12} strokeWidth={1.8} />
                        </span>
                      )}
                  </td>
                  <td>
                    {pane.agentStatus === "unknown" ? "—" : <AgentStatusBadge status={pane.agentStatus} />}
                  </td>
                  <td className="s-herdr-table-dir" title={directory || undefined}>
                    {directory ? compactTerminalPath(directory) : "—"}
                  </td>
                  <td>{rowTab}</td>
                  <td
                    className="s-herdr-table-drift"
                    title={drift === null
                      ? undefined
                      : drift === 0
                        ? "Pinned to live output"
                        : `Scrolled up ${drift} ${drift === 1 ? "line" : "lines"} from the live edge`}
                  >
                    {drift === null ? "—" : drift === 0 ? "live" : `↑${drift}`}
                  </td>
                  <td className="s-herdr-table-output" title={lastLine ?? undefined}>
                    {lastLine ?? "—"}
                  </td>
                  <td className="s-herdr-table-actions">
                    <button
                      type="button"
                      className={`s-term-icon-button${expanded ? " is-active" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpandedPaneId((current) => (current === pane.paneId ? null : pane.paneId));
                      }}
                      title={expanded ? "Hide the pane's last lines" : "Show the pane's last lines"}
                      aria-label={expanded ? "Hide the pane's last lines" : "Show the pane's last lines"}
                      aria-pressed={expanded}
                    >
                      <Eye size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      className="s-term-icon-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        focusPane(pane);
                      }}
                      title="Focus this pane in the herdr client"
                      aria-label="Focus this pane in the herdr client"
                    >
                      <Crosshair size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      className="s-term-icon-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEnterPane(pane);
                      }}
                      title="Enter — focus it and open the web terminal"
                      aria-label="Enter — focus it and open the web terminal"
                    >
                      <LogIn size={13} strokeWidth={1.8} />
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr className="s-herdr-table-expand">
                    <td colSpan={HERDR_PANE_COLUMNS.length + 1}>
                      {output
                        ? <pre>{output}</pre>
                        : <span className="s-herdr-peek-reason">No output captured yet.</span>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {focusError && <div className="s-herdr-error">{focusError}</div>}
    </div>
  );
}

function AttachCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="s-herdr-attach"
      title="Copy attach command — open this session in the herdr client"
      onClick={() => {
        void copyTextToClipboard(command).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
      <code>{command}</code>
    </button>
  );
}

/**
 * The dive-in: one pane's live content as a lightbox over the whole console,
 * refreshing on a poll. Still a read-only projection — herdr renders the
 * terminal, Scout watches it; the hands-on path remains the attach command or
 * focus-in-herdr handoff. Escape or a click on the backdrop closes it.
 */
function HerdrPaneLiveView({
  sessionName,
  pane,
  onClose,
}: {
  sessionName: string;
  pane: HerdrPaneProjection;
  onClose: () => void;
}) {
  const { body, reason, loading, refresh } = useHerdrPanePeek(sessionName, pane.paneId, { lines: 48 });
  const [focusError, setFocusError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const focus = useCallback(() => {
    setFocusError(null);
    void focusHerdrPane(sessionName, pane.terminalId ?? pane.paneId)
      .catch((cause) => setFocusError(cause instanceof Error ? cause.message : String(cause)));
  }, [sessionName, pane.terminalId, pane.paneId]);

  return (
    <div className="s-herdr-lightbox" onClick={onClose} role="presentation">
      <section
        className="s-herdr-live"
        aria-label={`Live view of ${pane.label ?? pane.paneId}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="s-herdr-live-head">
          <AgentStatusDot status={pane.agentStatus} />
          {pane.agent && <HarnessMark harness={pane.agent} size={13} className="s-herdr-agent-mark" />}
          <strong className="s-herdr-pane-label">{pane.label ?? pane.paneId}</strong>
          <AgentStatusBadge status={pane.agentStatus} />
          {pane.foregroundCwd && <span className="s-herdr-cwd">{compactTerminalPath(pane.foregroundCwd)}</span>}
          <span className="s-herdr-pane-spacer" />
          <button
            type="button"
            className="s-term-icon-button"
            onClick={focus}
            title="Focus this pane in the herdr client"
            aria-label="Focus this pane in the herdr client"
          >
            <Crosshair size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="s-term-icon-button"
            onClick={refresh}
            title="Refresh now"
            aria-label="Refresh now"
          >
            <RefreshCw size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="s-term-icon-button s-term-icon-button--danger"
            onClick={onClose}
            title="Close the live view (Esc)"
            aria-label="Close the live view"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>
        <div className="s-herdr-live-body">
          {body !== null
            ? <pre>{body}</pre>
            : loading
              ? <span className="s-herdr-peek-reason">Loading…</span>
              : <span className="s-herdr-peek-reason">{reason ?? "No preview available."}</span>}
        </div>
        {focusError && <div className="s-herdr-error">{focusError}</div>}
      </section>
    </div>
  );
}

/** One-word status for badges, in herdr's own vocabulary. */
export function herdrAgentStatusLabel(status: HerdrAgentStatus): string {
  return status;
}

export function AgentStatusDot({ status }: { status: HerdrAgentStatus }) {
  return <span className={`s-herdr-dot s-herdr-dot--${status}`} aria-hidden="true" />;
}

export function AgentStatusBadge({ status }: { status: HerdrAgentStatus }) {
  if (status === "unknown") return null;
  return <span className={`s-herdr-badge s-herdr-badge--${status}`}>{herdrAgentStatusLabel(status)}</span>;
}

/** Small harness marks for a tab's distinct agents — which runtimes live here. */
function TabHarnessMarks({ tab }: { tab: HerdrTabProjection }) {
  const agents = [...new Set(
    tab.panes.map((pane) => pane.agent).filter((agent): agent is string => Boolean(agent)),
  )].slice(0, 4);
  if (agents.length === 0) return null;
  return (
    <span className="s-herdr-tab-marks">
      {agents.map((agent) => (
        <HarnessMark key={agent} harness={agent} size={11} className="s-herdr-agent-mark" />
      ))}
    </span>
  );
}

/** Compact per-tab summary for tight spaces (the workspace hosted tile). */
export function herdrTabSummary(tab: HerdrTabProjection): { label: string; statuses: HerdrAgentStatus[] } {
  return {
    label: tab.label ?? `Tab ${tab.number ?? ""}`,
    statuses: tab.panes.map((pane) => pane.agentStatus),
  };
}
