import {
  normalizeTerminalWorkspaceColumns as normalizeProtocolColumns,
  type TerminalWorkspaceLayout,
} from "@openscout/protocol";

export type TerminalTileDropEdge = "before" | "after";
export type TerminalTileDropAxis = "horizontal" | "vertical";

export type TerminalProjectDestination = {
  id: string;
  label: string;
  path: string;
  source: "configured" | "agent";
};

/**
 * One workspace in the deck. Named "entry" rather than "layout" because layout
 * now means the tile arrangement (solo / lanes / grid), which this carries as a
 * field.
 */
export type TerminalWorkspaceDeckEntry<T> = {
  id: string;
  name: string;
  tiles: T[];
  /** What the workspace is for, in the operator's own words. */
  purpose?: string;
  /** Resolved column count, kept for entries written before `layout`. */
  columns?: number;
  layout?: TerminalWorkspaceLayout;
  updatedAt?: number;
};

export type TerminalWorkspaceDeck<T> = {
  version: 1;
  activeWorkspaceId: string;
  workspaces: TerminalWorkspaceDeckEntry<T>[];
};

/** Highest column count a workspace may reopen with. */
export const TERMINAL_WORKSPACE_MAX_COLUMNS = 6;

export function createTerminalWorkspaceDeck<T>(
  id = "main",
  name = "Main",
): TerminalWorkspaceDeck<T> {
  return {
    version: 1,
    activeWorkspaceId: id,
    workspaces: [{ id, name, tiles: [] }],
  };
}

/**
 * A deck with no workspaces at all. Distinct from {@link createTerminalWorkspaceDeck},
 * which seeds a default workspace: a first-run surface needs to know that the
 * operator has never saved one, so it can offer to create instead of opening an
 * empty grid nobody asked for.
 */
export function emptyTerminalWorkspaceDeck<T>(): TerminalWorkspaceDeck<T> {
  return { version: 1, activeWorkspaceId: "", workspaces: [] };
}

export function normalizeTerminalWorkspaceDeck<T>(
  value: unknown,
  isTile: (value: unknown) => value is T,
  options: { allowEmpty?: boolean } = {},
): TerminalWorkspaceDeck<T> {
  const fallback = () => options.allowEmpty
    ? emptyTerminalWorkspaceDeck<T>()
    : createTerminalWorkspaceDeck<T>();
  if (!value || typeof value !== "object") return fallback();
  const candidate = value as Partial<TerminalWorkspaceDeck<unknown>>;
  if (!Array.isArray(candidate.workspaces)) return fallback();

  const workspaces: TerminalWorkspaceDeckEntry<T>[] = [];
  const seenIds = new Set<string>();
  for (const workspace of candidate.workspaces) {
    if (!workspace || typeof workspace !== "object") continue;
    const id = typeof workspace.id === "string" ? workspace.id.trim() : "";
    const name = typeof workspace.name === "string" ? workspace.name.trim() : "";
    if (!id || !name || seenIds.has(id) || !Array.isArray(workspace.tiles)) continue;
    seenIds.add(id);
    const purpose = typeof workspace.purpose === "string" ? workspace.purpose.trim() : "";
    const columns = normalizeTerminalWorkspaceColumns(workspace.columns);
    const layout = normalizeDeckLayout(workspace.layout);
    const updatedAt = typeof workspace.updatedAt === "number" && Number.isFinite(workspace.updatedAt)
      && workspace.updatedAt >= 0
      ? workspace.updatedAt
      : null;
    workspaces.push({
      id,
      name,
      tiles: workspace.tiles.filter(isTile),
      ...(purpose ? { purpose } : {}),
      ...(columns ? { columns } : {}),
      ...(layout ? { layout } : {}),
      ...(updatedAt === null ? {} : { updatedAt }),
    });
  }
  if (workspaces.length === 0) return fallback();

  const activeWorkspaceId = typeof candidate.activeWorkspaceId === "string"
    && seenIds.has(candidate.activeWorkspaceId)
    ? candidate.activeWorkspaceId
    : workspaces[0]!.id;
  return { version: 1, activeWorkspaceId, workspaces };
}

/**
 * Accept only a layout we can render. An unknown mode is dropped rather than
 * guessed at, so a workspace written by a newer build falls back to the column
 * count it also stored.
 */
function normalizeDeckLayout(value: unknown): TerminalWorkspaceLayout | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TerminalWorkspaceLayout>;
  if (candidate.mode !== "solo" && candidate.mode !== "lanes" && candidate.mode !== "grid") return null;
  if (candidate.columns === undefined) return { mode: candidate.mode };
  if (candidate.columns === "dynamic") return { mode: candidate.mode, columns: "dynamic" };
  const columns = normalizeProtocolColumns(candidate.columns);
  return { mode: candidate.mode, columns };
}

export function normalizeTerminalWorkspaceColumns(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const columns = Math.floor(value);
  if (columns < 1) return null;
  return Math.min(columns, TERMINAL_WORKSPACE_MAX_COLUMNS);
}

export function addTerminalWorkspace<T>(
  deck: TerminalWorkspaceDeck<T>,
  id: string,
  name?: string,
): TerminalWorkspaceDeck<T> {
  if (!id.trim() || deck.workspaces.some((workspace) => workspace.id === id)) return deck;
  const workspace = { id, name: name?.trim() || nextTerminalWorkspaceName(deck), tiles: [] as T[] };
  return {
    ...deck,
    activeWorkspaceId: workspace.id,
    workspaces: [...deck.workspaces, workspace],
  };
}

function nextTerminalWorkspaceName<T>(deck: TerminalWorkspaceDeck<T>): string {
  const usedNames = new Set(deck.workspaces.map((workspace) => workspace.name));
  let index = deck.workspaces.length + 1;
  while (usedNames.has(`Workspace ${index}`)) index += 1;
  return `Workspace ${index}`;
}

/**
 * Insert or replace a workspace by id and make it active. Replacing keeps the
 * workspace where it already sat, so saving an edit does not reshuffle the
 * library under the operator.
 */
export function upsertTerminalWorkspace<T>(
  deck: TerminalWorkspaceDeck<T>,
  layout: TerminalWorkspaceDeckEntry<T>,
): TerminalWorkspaceDeck<T> {
  const id = layout.id.trim();
  if (!id) return deck;
  const next = { ...layout, id };
  const exists = deck.workspaces.some((workspace) => workspace.id === id);
  const workspaces = exists
    ? deck.workspaces.map((workspace) => workspace.id === id ? next : workspace)
    : [next, ...deck.workspaces];
  return { ...deck, activeWorkspaceId: id, workspaces };
}

export function updateTerminalWorkspace<T>(
  deck: TerminalWorkspaceDeck<T>,
  id: string,
  patch: Partial<Omit<TerminalWorkspaceDeckEntry<T>, "id">>,
): TerminalWorkspaceDeck<T> {
  const index = deck.workspaces.findIndex((workspace) => workspace.id === id);
  if (index < 0) return deck;
  const current = deck.workspaces[index]!;
  const next = { ...current, ...patch };
  const unchanged = (Object.keys(patch) as Array<keyof typeof patch>)
    .every((key) => current[key] === next[key]);
  if (unchanged) return deck;
  return { ...deck, workspaces: deck.workspaces.map((workspace, candidate) => candidate === index ? next : workspace) };
}

export function selectTerminalWorkspace<T>(
  deck: TerminalWorkspaceDeck<T>,
  id: string,
): TerminalWorkspaceDeck<T> {
  if (id === deck.activeWorkspaceId || !deck.workspaces.some((workspace) => workspace.id === id)) {
    return deck;
  }
  return { ...deck, activeWorkspaceId: id };
}

export function closeTerminalWorkspace<T>(
  deck: TerminalWorkspaceDeck<T>,
  id: string,
  options: { allowEmpty?: boolean } = {},
): TerminalWorkspaceDeck<T> {
  if (deck.workspaces.length <= 1) {
    if (!options.allowEmpty) return deck;
    return deck.workspaces[0]?.id === id ? emptyTerminalWorkspaceDeck<T>() : deck;
  }
  const index = deck.workspaces.findIndex((workspace) => workspace.id === id);
  if (index < 0) return deck;
  const workspaces = deck.workspaces.filter((workspace) => workspace.id !== id);
  const activeWorkspaceId = deck.activeWorkspaceId === id
    ? workspaces[Math.min(index, workspaces.length - 1)]!.id
    : deck.activeWorkspaceId;
  return { ...deck, activeWorkspaceId, workspaces };
}

export function renameTerminalWorkspace<T>(
  deck: TerminalWorkspaceDeck<T>,
  id: string,
  name: string,
): TerminalWorkspaceDeck<T> {
  const nextName = name.trim();
  if (!nextName) return deck;
  let changed = false;
  const workspaces = deck.workspaces.map((workspace) => {
    if (workspace.id !== id || workspace.name === nextName) return workspace;
    changed = true;
    return { ...workspace, name: nextName };
  });
  return changed ? { ...deck, workspaces } : deck;
}

export function updateActiveTerminalWorkspaceTiles<T>(
  deck: TerminalWorkspaceDeck<T>,
  update: T[] | ((tiles: T[]) => T[]),
): TerminalWorkspaceDeck<T> {
  let changed = false;
  const workspaces = deck.workspaces.map((workspace) => {
    if (workspace.id !== deck.activeWorkspaceId) return workspace;
    const tiles = typeof update === "function"
      ? (update as (tiles: T[]) => T[])(workspace.tiles)
      : update;
    if (tiles === workspace.tiles) return workspace;
    changed = true;
    return { ...workspace, tiles };
  });
  return changed ? { ...deck, workspaces } : deck;
}

type ConfiguredTerminalProject = {
  id: string;
  title: string;
  root: string;
};

type ObservedTerminalProject = {
  id: string;
  name: string;
  project: string | null;
  projectRoot: string | null;
  cwd: string | null;
  updatedAt: number | null;
};

export function resolveTerminalProjectDestinations(
  configuredProjects: readonly ConfiguredTerminalProject[],
  observedProjects: readonly ObservedTerminalProject[],
): TerminalProjectDestination[] {
  const observed = observedProjects
    .map((project, index) => {
      const path = normalizeTerminalProjectPath(project.projectRoot ?? project.cwd);
      if (!path) return null;
      return {
        id: `agent:${project.id}`,
        label: cleanTerminalProjectLabel(project.project) ?? basename(path) ?? project.name,
        path,
        source: "agent" as const,
        updatedAt: project.updatedAt ?? 0,
        index,
      };
    })
    .filter((project): project is NonNullable<typeof project> => project !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.index - right.index);

  const activityById = new Map<string, number>();
  for (const project of observed) {
    activityById.set(project.id.replace(/^agent:/u, ""), project.updatedAt);
  }

  const configured = configuredProjects
    .map((project, index) => {
      const path = normalizeTerminalProjectPath(project.root);
      if (!path) return null;
      return {
        id: `configured:${project.id}`,
        label: cleanTerminalProjectLabel(project.title) ?? basename(path) ?? path,
        path,
        source: "configured" as const,
        updatedAt: Math.max(
          activityById.get(project.id) ?? 0,
          ...observed.filter((candidate) => terminalProjectPathsMatch(candidate.path, path))
            .map((candidate) => candidate.updatedAt),
        ),
        index,
      };
    })
    .filter((project): project is NonNullable<typeof project> => project !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.index - right.index);

  const destinations: TerminalProjectDestination[] = [];
  const seenPaths: string[] = [];
  for (const project of [...configured, ...observed]) {
    if (seenPaths.some((path) => terminalProjectPathsMatch(path, project.path))) continue;
    seenPaths.push(project.path);
    destinations.push({
      id: project.id,
      label: project.label,
      path: project.path,
      source: project.source,
    });
  }
  return destinations;
}

export function terminalProjectCdCommand(path: string): string {
  if (path.startsWith("~/")) {
    return `cd -- ~/'${path.slice(2).replaceAll("'", "'\\''")}'`;
  }
  return `cd -- '${path.replaceAll("'", "'\\''")}'`;
}

function normalizeTerminalProjectPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || /[\0\r\n]/u.test(trimmed)) return null;
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/u, "");
}

function terminalProjectPathsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.startsWith("~/")) return right.endsWith(left.slice(1));
  if (right.startsWith("~/")) return left.endsWith(right.slice(1));
  return false;
}

function cleanTerminalProjectLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function basename(path: string): string | null {
  if (path === "/") return "/";
  return path.split("/").pop() || null;
}

export function terminalWorkspaceDropPlacement(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
  columnCount: number,
): { edge: TerminalTileDropEdge; axis: TerminalTileDropAxis } {
  if (columnCount > 1) {
    return {
      axis: "horizontal",
      edge: point.x < bounds.left + bounds.width / 2 ? "before" : "after",
    };
  }
  return {
    axis: "vertical",
    edge: point.y < bounds.top + bounds.height / 2 ? "before" : "after",
  };
}

export function moveTerminalWorkspaceItem<T extends { id: string }>(
  items: readonly T[],
  sourceId: string,
  destinationId: string,
  edge: TerminalTileDropEdge,
): T[] {
  if (sourceId === destinationId) return [...items];

  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const destinationIndex = items.findIndex((item) => item.id === destinationId);
  if (sourceIndex < 0 || destinationIndex < 0) return [...items];

  const next = [...items];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return [...items];

  const adjustedDestination = next.findIndex((item) => item.id === destinationId);
  const insertionIndex = edge === "after" ? adjustedDestination + 1 : adjustedDestination;
  next.splice(Math.max(0, insertionIndex), 0, source);
  return next;
}
