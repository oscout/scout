/**
 * Herdr session topology, projected for Scout clients.
 *
 * Herdr owns the real thing: workspaces, tabs, panes, layouts, and the agent
 * records inside them. This type is a READ-ONLY PROJECTION of that topology —
 * what Scout's terminals view needs to represent a herdr session faithfully
 * without becoming a second layout manager. Layout coordinates and split
 * ratios are included read-only so a client can render the arrangement
 * faithfully; there are deliberately no mutation verbs here: if a client wants
 * to change the topology, the handoff is the herdr client itself (`herdr
 * session attach`, `herdr agent focus`), not a Scout control.
 *
 * The server builds this from `herdr --session <n> workspace list`,
 * `tab list`, and `pane list` JSON, plus the per-tab layout geometry from
 * `herdr --session <n> api snapshot`. A session whose server is stopped
 * projects from its persisted `session.json` instead — same shape, marked by
 * `running: false` and `savedAt`; geometry, terminal ids, and live agent
 * status are simply absent from a persisted projection. A session with no
 * persisted state projects as `{ running: false, workspaces: [] }` — an
 * ordinary state, not an error.
 */

/** Agent state as herdr reports it, never as Scout infers it. */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * The harness-native session reference herdr reports for a pane (e.g. a Claude
 * session id). Opaque to Scout: carried so clients can correlate, never parsed.
 */
export type HerdrAgentSessionRef = {
  agent: string;
  kind: string;
  source: string;
  value: string;
};

export type HerdrPaneProjection = {
  paneId: string;
  /** Herdr's stable terminal id; `herdr agent <verb>` accepts it as a target. */
  terminalId: string | null;
  tabId: string;
  workspaceId: string;
  label: string | null;
  /** Detected/reported agent label, e.g. "claude". Null for plain shells. */
  agent: string | null;
  agentStatus: HerdrAgentStatus;
  agentSession: HerdrAgentSessionRef | null;
  cwd: string | null;
  foregroundCwd: string | null;
  focused: boolean;
  /**
   * Scrollback position as herdr reports it. `maxOffsetFromBottom` is the
   * pane's backlog depth — the cheapest activity signal the projection has.
   * Null when the host does not report scroll state (older herdr).
   */
  scroll: HerdrPaneScroll | null;
};

export type HerdrPaneScroll = {
  maxOffsetFromBottom: number;
  offsetFromBottom: number;
  viewportRows: number;
};

/**
 * Layout geometry for one tab, read from `herdr api snapshot`. Rects are
 * absolute terminal cell coordinates as herdr reports them (the area includes
 * herdr's chrome offset); clients normalize against `area` to render a
 * proportional replica.
 */
export type HerdrLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type HerdrLayoutPane = {
  paneId: string;
  focused: boolean;
  rect: HerdrLayoutRect;
};

export type HerdrLayoutSplit = {
  id: string | null;
  direction: "right" | "down" | null;
  ratio: number | null;
  rect: HerdrLayoutRect | null;
};

export type HerdrTabLayout = {
  tabId: string;
  workspaceId: string;
  area: HerdrLayoutRect;
  focusedPaneId: string | null;
  zoomed: boolean;
  panes: HerdrLayoutPane[];
  splits: HerdrLayoutSplit[];
};

export type HerdrTabProjection = {
  tabId: string;
  workspaceId: string;
  label: string | null;
  number: number | null;
  focused: boolean;
  agentStatus: HerdrAgentStatus;
  panes: HerdrPaneProjection[];
  /** Per-tab pane geometry; null when the snapshot did not cover this tab. */
  layout: HerdrTabLayout | null;
};

export type HerdrWorkspaceProjection = {
  workspaceId: string;
  label: string | null;
  number: number | null;
  focused: boolean;
  activeTabId: string | null;
  agentStatus: HerdrAgentStatus;
  tabs: HerdrTabProjection[];
};

export type HerdrSessionTopology = {
  /** Herdr session name, e.g. "openscout". */
  session: string;
  /** Whether the session's herdr server answered. */
  running: boolean;
  workspaces: HerdrWorkspaceProjection[];
  /** Server wall-clock when the projection was observed. */
  observedAt: number;
  /**
   * When the projection came from the persisted session state (server stopped),
   * the mtime of that state — the session's last known change. Absent when the
   * projection is live.
   */
  savedAt?: number | null;
};

export function emptyHerdrSessionTopology(session: string, running: boolean): HerdrSessionTopology {
  return { session, running, workspaces: [], observedAt: Date.now() };
}
