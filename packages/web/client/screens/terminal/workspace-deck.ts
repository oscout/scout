import {
  normalizeTerminalWorkspaceDeck,
  type TerminalWorkspaceDeck,
  type TerminalWorkspaceDeckEntry,
} from "../../lib/terminal-workspace.ts";
import {
  parseTerminalSurfaceId,
  resolveTerminalWorkspaceColumns,
  terminalSurfaceMatchesId,
  terminalWorkspaceLayoutOf,
} from "@openscout/protocol";
import type {
  TerminalSessionRecord,
  TerminalWorkspaceCell,
  TerminalWorkspaceCellIntent,
  TerminalWorkspaceRecord,
  TerminalWorkspaceRecordInput,
} from "@openscout/protocol";
import type { Route } from "../../lib/types.ts";

type TerminalRoute = Extract<Route, { view: "terminal" }>;
/**
 * Hosts a cell may be started on. Wider than the route's backend union: a cell
 * can name any host with a registered adapter that can create sessions, even
 * one the browser relay cannot render — Scout still creates a real durable
 * session, and the tile says where to find it.
 */
export type TerminalCellBackend = NonNullable<TerminalRoute["terminalBackend"]> | "herdr";
export type TerminalCellAgent = NonNullable<TerminalRoute["terminalAgent"]>;

/**
 * One authored slot in a workspace. `id` is minted once, when the cell is
 * created, and then persisted: it is what makes a slot the same slot across
 * reloads, so the terminal session it opens can be reattached instead of
 * replaced. Never derive it from a display name or from a timestamp read at
 * entry time.
 */
export type TerminalWorkspaceCellDefinition =
  | { id: string; kind: "fresh"; backend: TerminalCellBackend; agent: TerminalCellAgent }
  | { id: string; kind: "registered"; terminalSessionId: string; terminalSurfaceKey: string };

export type TerminalWorkspaceDefinition = TerminalWorkspaceDeckEntry<TerminalWorkspaceCellDefinition>;
export type TerminalWorkspaceDeckState = TerminalWorkspaceDeck<TerminalWorkspaceCellDefinition>;

export const TERMINAL_WORKSPACES_STORAGE_KEY = "openscout.terminal.workspaces.v1";
export const TERMINAL_WORKSPACES_STORAGE_VERSION = 2;
export const TERMINAL_WORKSPACE_VIEW_STORAGE_KEY = "openscout.terminal.workspace-view.v1";
export const TERMINAL_DEFAULT_GRID_COLUMNS = 2;

export function createTerminalDeckId(prefix: string): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/** Longest readable slice of a cell id kept in a host session name. */
const CELL_NAME_SLICE = 24;

/**
 * Multiplexer session name for a cell. Derived from the cell's persisted id, so
 * re-entering a workspace reattaches to the session that cell opened last time.
 * Minting a name at entry (as this screen used to) abandons a live session on
 * every reload, which is why web tiles were not durable at all.
 *
 * The name is an ADDRESS on a host that all of Scout shares, so it has to be
 * unique across the whole library, and the readable part cannot carry that on
 * its own. Two ways it collided before: a cell id is only unique within its
 * workspace, so two workspaces each holding `slot-1` both claimed
 * `scout-tmux-slot-1`; and sanitizing collapsed distinct ids onto one name,
 * with `a:b` and `a b` both becoming `scout-tmux-a-b`. Either way two tiles
 * attach to, and send control verbs to, the same host session.
 *
 * So the readable slice stays readable and a short digest of the exact
 * (workspace, cell, backend) triple carries the identity. The digest is taken
 * over the raw ids, before sanitizing, which is what makes inputs that sanitize
 * alike still land on different names.
 *
 * The result must satisfy the relay's session-name validator
 * (`/^[A-Za-z0-9_][A-Za-z0-9_-]*$/`) before it reaches a CLI, and stay clear of
 * tmux's `.`/`:` targeting syntax — the sanitizer's allowed set already does.
 */
export function terminalCellSessionName(
  backend: TerminalCellBackend,
  cellId: string,
  workspaceId: string,
): string {
  const slice = cellId
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^[^A-Za-z0-9_]+/u, "")
    .slice(0, CELL_NAME_SLICE)
    .replace(/-+$/u, "");
  const digest = shortDigest(JSON.stringify([workspaceId, cellId, backend]));
  return `scout-${backend}-${slice || "cell"}-${digest}`;
}

/**
 * FNV-1a, 32 bits, as eight lowercase hex characters.
 *
 * Hand-rolled and synchronous on purpose: this runs in a browser bundle where
 * `crypto.subtle` is async and `node:crypto` does not exist, and the name it
 * feeds must be derivable in one expression at render time. Thirty-two bits is
 * ample for distinguishing the cells of one operator's workspace library.
 */
function shortDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function createFreshTerminalCell(
  backend: TerminalCellBackend,
  agent: TerminalCellAgent = "shell",
): TerminalWorkspaceCellDefinition {
  return { id: createTerminalDeckId("cell"), kind: "fresh", backend, agent };
}

export function isTerminalWorkspaceCell(value: unknown): value is TerminalWorkspaceCellDefinition {
  if (!value || typeof value !== "object") return false;
  const cell = value as Partial<TerminalWorkspaceCellDefinition>;
  if (typeof cell.id !== "string" || !cell.id.trim()) return false;
  if (cell.kind === "fresh") return typeof cell.backend === "string" && typeof cell.agent === "string";
  if (cell.kind === "registered") {
    return typeof cell.terminalSessionId === "string" && typeof cell.terminalSurfaceKey === "string";
  }
  return false;
}

/**
 * Restore the workspace deck from storage, folding forward the v1 shape: a bare
 * array of definitions whose cells carried no ids. Legacy cells are keyed by
 * workspace + slot, which is the identity macOS already gives its tiles, so an
 * upgraded workspace keeps reattaching to the sessions its slots opened.
 */
/**
 * Project a server-owned workspace record onto the local deck shape.
 *
 * The server record is the truth; the deck is a cache of it, so a workspace
 * authored on one device opens on another. A cell that names a live host
 * session becomes a fresh tile bound to that session name; a cell that carries
 * a surface handle becomes a registered tile.
 */
export function terminalWorkspaceLayoutFromRecord(
  record: TerminalWorkspaceRecord,
): TerminalWorkspaceDefinition {
  return {
    id: record.id,
    name: record.name,
    ...(record.purpose ? { purpose: record.purpose } : {}),
    columns: record.columns,
    ...(record.layout ? { layout: record.layout } : {}),
    updatedAt: record.updatedAt,
    tiles: record.cells.map((cell): TerminalWorkspaceCellDefinition => {
      if (cell.surfaceId && cell.terminalSessionId) {
        return {
          id: cell.id,
          kind: "registered",
          terminalSessionId: cell.terminalSessionId,
          terminalSurfaceKey: cell.surfaceId,
        };
      }
      return {
        id: cell.id,
        kind: "fresh",
        backend: isTerminalCellBackend(cell.intent.hostId) ? cell.intent.hostId : "pty",
        agent: "shell",
      };
    }),
  };
}

/**
 * The reverse projection. Every cell carries the intent needed to rebuild it
 * after a reboot — the host, the durable session name, and where known the
 * working directory and harness resume command — because a cell that remembers
 * only a surface handle is worth nothing once the host is empty.
 *
 * Registered cells used to be written with `intent: {}`, which threw that away
 * for exactly the tiles that had the most to say: a cell bound to a registry
 * record knows its host and session name from its own surface handle, and the
 * record knows the directory and the resume command. Saved as an empty intent,
 * such a tile reconciled to "saved without enough detail to reopen it" the
 * moment its host restarted — with the detail sitting right there, unread.
 */
export function terminalWorkspaceRecordInputFromLayout(
  layout: TerminalWorkspaceDefinition,
  options: { sessions?: readonly TerminalSessionRecord[] } = {},
): TerminalWorkspaceRecordInput & { id: string } {
  return {
    id: layout.id,
    name: layout.name,
    purpose: layout.purpose ?? "",
    columns: resolveTerminalWorkspaceColumns(
      terminalWorkspaceLayoutOf({ layout: layout.layout, columns: layout.columns, cellCount: layout.tiles.length }),
      { tileCount: layout.tiles.length },
    ),
    layout: terminalWorkspaceLayoutOf({
      layout: layout.layout,
      columns: layout.columns,
      cellCount: layout.tiles.length,
    }),
    cells: layout.tiles.map((cell): TerminalWorkspaceCell => {
      if (cell.kind === "registered") {
        return {
          id: cell.id,
          surfaceId: cell.terminalSurfaceKey,
          terminalSessionId: cell.terminalSessionId,
          intent: registeredCellIntent(cell, options.sessions ?? []),
        };
      }
      return {
        id: cell.id,
        intent: {
          hostId: cell.backend,
          // A disposable shell has no session to reattach to, and saying it
          // does would promise a revive that cannot happen.
          sessionName: cell.backend === "pty"
            ? null
            : terminalCellSessionName(cell.backend, cell.id, layout.id),
        },
      };
    }),
  };
}

/**
 * What a registered cell can honestly say about rebuilding itself.
 *
 * The surface handle already names a host and a session — that is what a
 * surface id IS — so those come from parsing it rather than from a lookup that
 * may miss. Directory and resume command come from the registry record when
 * one is still around; when it is not, the cell says what it knows and stays
 * quiet about the rest, which is what makes reconciliation's refusal to invent
 * a rebuild meaningful.
 */
function registeredCellIntent(
  cell: Extract<TerminalWorkspaceCellDefinition, { kind: "registered" }>,
  sessions: readonly TerminalSessionRecord[],
): TerminalWorkspaceCellIntent {
  const address = parseTerminalSurfaceId(cell.terminalSurfaceKey);
  const record = sessions.find((candidate) =>
    candidate.id === cell.terminalSessionId
    || candidate.surfaces.some((surface) => terminalSurfaceMatchesId(surface, cell.terminalSurfaceKey))
  );
  return {
    ...(address ? { hostId: address.backend, sessionName: address.hostSession } : {}),
    ...(record?.cwd ? { cwd: record.cwd } : {}),
    ...(record?.harness ? { harness: record.harness } : {}),
    ...(record?.resumeCommand ? { resumeCommand: record.resumeCommand } : {}),
  };
}

function isTerminalCellBackend(value: unknown): value is TerminalCellBackend {
  return value === "pty" || value === "tmux" || value === "zellij" || value === "herdr";
}

export function restoreTerminalWorkspaceDeck(stored: unknown): TerminalWorkspaceDeckState {
  if (!Array.isArray(stored)) {
    return normalizeTerminalWorkspaceDeck(stored, isTerminalWorkspaceCell, { allowEmpty: true });
  }
  const workspaces = stored.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const legacy = entry as {
      id?: unknown;
      name?: unknown;
      purpose?: unknown;
      columns?: unknown;
      cells?: unknown;
      updatedAt?: unknown;
    };
    if (typeof legacy.id !== "string" || !legacy.id.trim()) return [];
    const cells = Array.isArray(legacy.cells) ? legacy.cells : [];
    return [{
      id: legacy.id,
      name: typeof legacy.name === "string" && legacy.name.trim() ? legacy.name : legacy.id,
      purpose: legacy.purpose,
      columns: legacy.columns,
      updatedAt: legacy.updatedAt,
      tiles: cells.map((cell, index) => ({
        ...(cell as Record<string, unknown>),
        id: `${legacy.id}-${index}`,
      })),
    }];
  });
  return normalizeTerminalWorkspaceDeck(
    { version: 1, activeWorkspaceId: workspaces[0]?.id ?? "", workspaces },
    isTerminalWorkspaceCell,
    { allowEmpty: true },
  );
}
