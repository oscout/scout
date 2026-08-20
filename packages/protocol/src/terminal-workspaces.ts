/**
 * Durable terminal workspaces.
 *
 * A workspace is a named, server-owned arrangement of agent-CLI tiles. It is
 * the Scout object the three clients had each invented privately —
 * `openscout.terminal.workspaces.v1` in localStorage,
 * `scout.terminals.workspaces.v1` in UserDefaults, and nothing at all on iOS —
 * with the same version number, the same idea, and no synchronization.
 *
 * Where this stands TODAY, so nobody reads more into it than is built: the web
 * client treats the record as its source of truth, seeding its deck from it and
 * writing changes back. macOS still keeps its own UserDefaults store and has no
 * reference to `/api/terminal-workspaces`, and iOS has nothing. "One workspace
 * on all three clients" is the direction this type exists to make possible, not
 * something it has delivered; the other two clients follow.
 *
 * The load-bearing design decision is that a cell stores INTENT, not just a
 * binding. A saved cell that only remembers "tmux session scout-tmux-cell-7"
 * is worth nothing after a reboot: tmux is empty and the name resolves to
 * nothing. A cell that also remembers which host to use, what directory, and
 * how to resume the harness can be rebuilt. This is the same conclusion
 * tmux-resurrect/continuum reached — persist intent and replay it, never
 * process state — and what macOS's `restoreCommandLine` already does in a
 * cruder form.
 */

import {
  terminalSurfaceMatchesId,
  terminalSurfaceNodeId,
  terminalSurfaceNodeScopeMatches,
} from "./terminal-sessions.js";
import type { TerminalSessionRecord, TerminalSurface } from "./terminal-sessions.js";
import { parseTerminalSurfaceId } from "./terminal-surface-id.js";
import type { TerminalHostId, TerminalSurfaceId } from "./terminal-surface-id.js";

/**
 * Everything needed to re-materialize a cell when nothing live matches it.
 * Every field is optional because a workspace authored before a given field
 * existed must still resolve; what a cell cannot say, reconciliation refuses to
 * invent.
 */
export type TerminalWorkspaceCellIntent = {
  /** Host to materialize on. Absent means "whatever the operator's default is". */
  hostId?: TerminalHostId | null;
  /** Durable per-cell host session name. This is what makes a tile reattach. */
  sessionName?: string | null;
  /** Working directory to open in. */
  cwd?: string | null;
  /** Harness to resume, when the cell is an agent rather than a shell. */
  harness?: string | null;
  /** Harness-native resume command, e.g. `claude --resume <id>`. */
  resumeCommand?: string | null;
};

export type TerminalWorkspaceCell = {
  /** Stable cell id. Minted once, at authoring; never derived from a name. */
  id: string;
  /** Durable handle for the surface this cell last bound to. */
  surfaceId?: TerminalSurfaceId | null;
  /** Registry record that surface belonged to, when it had one. */
  terminalSessionId?: string | null;
  intent: TerminalWorkspaceCellIntent;
};

/**
 * How a workspace arranges its tiles.
 *
 * Three shapes, not a list of named presets: one tile, N side-by-side lanes, or
 * a 2D grid. The old SOLO/SPLIT/TRIO/QUAD taxonomy conflated the shape with a
 * particular tile count, which is why authoring was capped at four and a
 * nine-tile workspace silently truncated — "Quad" was both a layout and a size.
 * Size is now just how many cells exist.
 */
export type TerminalWorkspaceLayoutMode = "solo" | "lanes" | "grid";

/**
 * `"dynamic"` fits the column count to the number of tiles instead of pinning
 * it, so adding a tile re-flows the workspace rather than leaving a hole.
 */
export type TerminalWorkspaceColumnCount = number | "dynamic";

export type TerminalWorkspaceLayout = {
  mode: TerminalWorkspaceLayoutMode;
  columns?: TerminalWorkspaceColumnCount;
};

export type TerminalWorkspaceRecord = {
  id: string;
  name: string;
  purpose: string;
  /**
   * Resolved column count at the time of writing. Kept for records and clients
   * that predate {@link layout}; `layout` wins when both are present.
   */
  columns: number;
  layout?: TerminalWorkspaceLayout;
  cells: TerminalWorkspaceCell[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type TerminalWorkspaceRecordInput = {
  id?: string;
  name: string;
  purpose?: string;
  columns?: number;
  layout?: TerminalWorkspaceLayout;
  cells?: TerminalWorkspaceCell[];
  metadata?: Record<string, unknown>;
};

/** Highest column count a workspace may reopen with. */
export const TERMINAL_WORKSPACE_MAX_COLUMNS = 6;
export const TERMINAL_WORKSPACE_DEFAULT_COLUMNS = 2;

/**
 * The layout a workspace should open with, folding a pre-layout record forward.
 *
 * A record written before layouts existed carries only a column count, so the
 * mode is inferred from how that count relates to the cells: one cell is solo,
 * a count that fits every cell on one row is lanes, anything else was a grid.
 */
export function terminalWorkspaceLayoutOf(input: {
  layout?: TerminalWorkspaceLayout | null;
  columns?: number | null;
  cellCount?: number;
}): TerminalWorkspaceLayout {
  if (input.layout?.mode) {
    return {
      mode: input.layout.mode,
      ...(input.layout.columns === undefined ? {} : { columns: normalizeTerminalWorkspaceColumnCount(input.layout.columns) }),
    };
  }
  const cellCount = input.cellCount ?? 0;
  const columns = normalizeTerminalWorkspaceColumns(input.columns ?? TERMINAL_WORKSPACE_DEFAULT_COLUMNS);
  if (cellCount <= 1) return { mode: "solo" };
  if (columns >= cellCount) return { mode: "lanes", columns };
  return { mode: "grid", columns };
}

/**
 * Column count to render with.
 *
 * Solo is always one. A dynamic lane count is the tile count, so every tile
 * gets its own lane; a dynamic grid is the squarest arrangement that holds
 * them. Both clamp, because past a handful of columns a terminal is too narrow
 * to read.
 */
export function resolveTerminalWorkspaceColumns(
  layout: TerminalWorkspaceLayout,
  input: { tileCount: number },
): number {
  const tileCount = Math.max(1, Math.floor(input.tileCount) || 1);
  if (layout.mode === "solo") return 1;
  if (layout.columns === undefined || layout.columns === "dynamic") {
    const dynamic = layout.mode === "lanes" ? tileCount : Math.ceil(Math.sqrt(tileCount));
    return Math.max(1, Math.min(TERMINAL_WORKSPACE_MAX_COLUMNS, dynamic));
  }
  return normalizeTerminalWorkspaceColumns(layout.columns);
}

export function normalizeTerminalWorkspaceColumnCount(value: unknown): TerminalWorkspaceColumnCount {
  return value === "dynamic" ? "dynamic" : normalizeTerminalWorkspaceColumns(value);
}

/**
 * Read a stored `layout_json` column back, or null when there is nothing
 * trustworthy in it.
 *
 * Every store that persists a workspace decodes the layout through this, and
 * that is the point: `layout_json` was added to the schema and then read by one
 * handle and ignored by the other, so a layout written through the web server
 * came back as `null` through the runtime store. One decoder means one answer.
 *
 * The mode is validated rather than trusted. It flows straight into the
 * client's grid resolver, so a value that is not one of the three shapes must
 * become "no stored layout" — which folds forward from the column count — and
 * not a mode nothing can render.
 */
export function parseTerminalWorkspaceLayoutJson(
  value: string | null | undefined,
): TerminalWorkspaceLayout | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<TerminalWorkspaceLayout>;
  const mode = candidate.mode;
  if (mode !== "solo" && mode !== "lanes" && mode !== "grid") return null;
  return {
    mode,
    ...(candidate.columns === undefined
      ? {}
      : { columns: normalizeTerminalWorkspaceColumnCount(candidate.columns) }),
  };
}

export function terminalWorkspaceLayoutLabel(layout: TerminalWorkspaceLayout): string {
  if (layout.mode === "solo") return "Solo";
  const shape = layout.mode === "lanes" ? "Lanes" : "Grid";
  return layout.columns === undefined || layout.columns === "dynamic"
    ? `${shape} · dynamic`
    : `${shape} · ${layout.columns} column${layout.columns === 1 ? "" : "s"}`;
}

export type TerminalWorkspaceCellStatus = "live" | "revivable" | "unavailable";

/** What reconciliation needs to know about a host, with no host access. */
export type TerminalWorkspaceHostState = {
  id: TerminalHostId;
  installed: boolean;
  /** Whether Scout can materialize a session on this host headlessly. */
  canCreate: boolean;
};

export type TerminalWorkspaceRevivePlan = {
  hostId: TerminalHostId;
  sessionName: string;
  cwd: string | null;
  /** Harness resume command to run inside the revived surface, when known. */
  resumeCommand: string | null;
};

export type TerminalWorkspaceCellResolution = {
  cellId: string;
  status: TerminalWorkspaceCellStatus;
  surfaceId: TerminalSurfaceId | null;
  terminalSessionId: string | null;
  surface: TerminalSurface | null;
  /** Operator-facing reason, in product language. */
  detail: string;
  /** Present exactly when the status is `revivable`. */
  revive: TerminalWorkspaceRevivePlan | null;
};

export type TerminalWorkspaceResolution = {
  workspaceId: string;
  cells: TerminalWorkspaceCellResolution[];
  liveCount: number;
  revivableCount: number;
  unavailableCount: number;
};

/**
 * Map every saved cell to a live surface, a restorable-but-dead one, or an
 * unavailable one.
 *
 * This is the only honest answer to a reboot. tmux and zellij sessions do not
 * survive a restart; a workspace that stored intent can rebuild itself, and one
 * that stored only a session name cannot. Judgement lives here, on the server
 * side of the wire, so all three clients inherit the same answer instead of
 * each re-deriving it — and it never fabricates a record: a cell with nothing
 * to rebuild from reports `unavailable` and says why.
 */
export function reconcileTerminalWorkspace(
  workspace: TerminalWorkspaceRecord,
  input: {
    sessions: readonly TerminalSessionRecord[];
    hosts: readonly TerminalWorkspaceHostState[];
    /** Host used when a cell's intent names none. */
    defaultHostId?: TerminalHostId | null;
    /**
     * This host's own Scout node id. The observations passed in were made HERE,
     * so this is the node whose cells they can prove live; a cell scoped to any
     * other node is not answered by them. Absent means the caller cannot say,
     * and then no node-scoped cell is claimed by a node-less observation.
     */
    localNodeId?: string | null;
  },
): TerminalWorkspaceResolution {
  const cells = workspace.cells.map((cell) => resolveTerminalWorkspaceCell(cell, input));
  return {
    workspaceId: workspace.id,
    cells,
    liveCount: cells.filter((cell) => cell.status === "live").length,
    revivableCount: cells.filter((cell) => cell.status === "revivable").length,
    unavailableCount: cells.filter((cell) => cell.status === "unavailable").length,
  };
}

function resolveTerminalWorkspaceCell(
  cell: TerminalWorkspaceCell,
  input: {
    sessions: readonly TerminalSessionRecord[];
    hosts: readonly TerminalWorkspaceHostState[];
    defaultHostId?: TerminalHostId | null;
    localNodeId?: string | null;
  },
): TerminalWorkspaceCellResolution {
  const live = findLiveSurface(cell, input.sessions, input.localNodeId?.trim() || null);
  if (live) {
    return {
      cellId: cell.id,
      status: "live",
      surfaceId: live.surface.surfaceId ?? cell.surfaceId ?? null,
      terminalSessionId: live.session.id,
      surface: live.surface,
      detail: "Running",
      revive: null,
    };
  }

  const hostId = cell.intent.hostId ?? input.defaultHostId ?? null;
  const sessionName = cell.intent.sessionName?.trim() || null;
  if (!hostId || !sessionName) {
    return unavailable(cell, "This tile was saved without enough detail to reopen it.");
  }

  const host = input.hosts.find((candidate) => candidate.id === hostId) ?? null;
  if (!host) {
    return unavailable(cell, `This tile needs ${hostId}, which Scout does not know about.`);
  }
  if (!host.installed) {
    return unavailable(cell, `This tile needs ${hostId}, which is not installed here.`);
  }
  if (!host.canCreate) {
    return unavailable(cell, `Scout cannot reopen ${hostId} sessions for you; open it there and come back.`);
  }

  return {
    cellId: cell.id,
    status: "revivable",
    surfaceId: cell.surfaceId ?? null,
    terminalSessionId: cell.terminalSessionId ?? null,
    surface: null,
    detail: "Not running. Scout can start it again.",
    revive: {
      hostId,
      sessionName,
      cwd: cell.intent.cwd?.trim() || null,
      resumeCommand: cell.intent.resumeCommand?.trim() || null,
    },
  };
}

function unavailable(
  cell: TerminalWorkspaceCell,
  detail: string,
): TerminalWorkspaceCellResolution {
  return {
    cellId: cell.id,
    status: "unavailable",
    surfaceId: cell.surfaceId ?? null,
    terminalSessionId: cell.terminalSessionId ?? null,
    surface: null,
    detail,
    revive: null,
  };
}

/**
 * Whether a record is an OBSERVATION of the host rather than something Scout
 * wrote down once. Only an observation can prove a surface is running.
 */
function isHostObservedRecord(session: TerminalSessionRecord): boolean {
  // `metadata.registryState` is the pre-`origin` signal; both are honoured
  // until every writer has moved over.
  return session.origin === "discovered" || session.metadata?.registryState === "discovered";
}

/**
 * A cell binds to a live surface by durable handle first. The intent's session
 * name is the fallback, because a surface re-created under the same name on the
 * same host IS the tile's session — that is the whole point of stable per-cell
 * names — while a record id is not enough on its own, since ids move when a
 * discovered session is renamed.
 *
 * Two rules make the answer an observation instead of a memory, and a review
 * reproduced what happens without them.
 *
 * Only a host-observed record can establish "live". A registry record is
 * written once, at intake, with `state: "live"` baked in, and it is never
 * updated again — so after a reboot every saved tile still resolved to
 * `{status: "live", detail: "Running"}` against a host that had nothing on it.
 * Scout was reporting its own filing cabinet back to the operator as the state
 * of their machine.
 *
 * And only `state === "live"` counts. `detached` means different things per
 * host — for tmux it is a running session with no client, for herdr it is a
 * session whose server is STOPPED — so accepting "anything but exited" reported
 * stopped herdr sessions as running. Hosts that stay attachable while detached
 * report `live` from their adapter, so requiring it costs nothing and stops
 * that.
 *
 * When an observation is found, the registry record for the same surface is
 * preferred as the cell's record: it carries the harness and resume command a
 * discovered record cannot know. The SURFACE always comes from the observation,
 * because that is the one with the current state.
 *
 * The third rule is that a machine only speaks for itself. The name fallback is
 * matched under the same node scoping as the handle, because otherwise it
 * quietly reopened the hole the handle matcher closed: a cell scoped to `node-b`
 * whose intent named `scout-tmux-cell-1` bound to THIS host's session of that
 * name, so `node-a` and `node-b` both reported the one discovered session
 * Running. One observed session never proves more than one node's workspace
 * live.
 */
function findLiveSurface(
  cell: TerminalWorkspaceCell,
  sessions: readonly TerminalSessionRecord[],
  localNodeId: string | null,
): { session: TerminalSessionRecord; surface: TerminalSurface } | null {
  const observedSessions = sessions.filter(isHostObservedRecord);
  const handle = cell.surfaceId?.trim() || null;
  const sessionName = cell.intent.sessionName?.trim() || null;
  const hostId = cell.intent.hostId ?? null;
  // The cell's node is whatever its durable handle names; a cell with only an
  // intent names no machine and keeps matching wherever it lands.
  const cellNodeId = parseTerminalSurfaceId(handle)?.nodeId ?? null;

  const matches = (surface: TerminalSurface): boolean => {
    if (surface.state !== "live") return false;
    if (handle && terminalSurfaceMatchesId(surface, handle, { localNodeId })) return true;
    if (!sessionName || surface.sessionName !== sessionName) return false;
    if (hostId && surface.backend !== hostId) return false;
    return terminalSurfaceNodeScopeMatches({
      handleNodeId: cellNodeId,
      surfaceNodeId: terminalSurfaceNodeId(surface),
      localNodeId,
    });
  };

  for (const session of observedSessions) {
    const surface = session.surfaces.find(matches);
    if (!surface) continue;
    // Under the same node rule: a registry record from another machine that
    // happens to hold this session name is not the identity of the session
    // observed here, and lending it would put a foreign record id on a local
    // surface.
    const registryRecord = sessions.find((candidate) =>
      !isHostObservedRecord(candidate)
      && candidate.surfaces.some((known) =>
        known.backend === surface.backend
        && known.sessionName === surface.sessionName
        && terminalSurfaceNodeScopeMatches({
          handleNodeId: terminalSurfaceNodeId(known),
          surfaceNodeId: terminalSurfaceNodeId(surface),
          localNodeId,
        })
      )
    );
    return { session: registryRecord ?? session, surface };
  }
  return null;
}

export function normalizeTerminalWorkspaceColumns(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TERMINAL_WORKSPACE_DEFAULT_COLUMNS;
  return Math.max(1, Math.min(TERMINAL_WORKSPACE_MAX_COLUMNS, Math.floor(value)));
}
