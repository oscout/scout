import type { TerminalListItem } from "../../lib/terminal-sessions.ts";

/**
 * Columns the session picker's table view can sort by. Every column sorts —
 * that is the point of the table view over the list: the list answers "what is
 * there", the table answers "which of these do I want", and that question is
 * asked by host, by state, by project, or by recency depending on the day.
 */
export type TerminalSessionColumn = "name" | "host" | "state" | "project" | "activity";

export type TerminalSessionSort = {
  column: TerminalSessionColumn;
  direction: "asc" | "desc";
};

export const TERMINAL_SESSION_INACTIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
export const TERMINAL_SESSION_REVIEW_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;
export type TerminalSessionLifecycle = "current" | "inactive" | "review";

/**
 * Default sort: the sessions doing something come first, then the most
 * recently active. An operator opening the picker is looking for live work far
 * more often than for an alphabetical index.
 */
export const DEFAULT_TERMINAL_SESSION_SORT: TerminalSessionSort = {
  column: "state",
  direction: "desc",
};

export const TERMINAL_SESSION_COLUMNS: ReadonlyArray<{
  id: TerminalSessionColumn;
  label: string;
  /** Which direction to start in when the column is first clicked. */
  initialDirection: "asc" | "desc";
}> = [
  { id: "name", label: "Session", initialDirection: "asc" },
  { id: "host", label: "Host", initialDirection: "asc" },
  { id: "state", label: "State", initialDirection: "desc" },
  { id: "project", label: "Project", initialDirection: "asc" },
  { id: "activity", label: "Activity", initialDirection: "desc" },
];

/**
 * Rank for the state column. Attached outranks live because someone is in
 * there; exited sinks because it is a tombstone, not a target.
 */
export function terminalSessionStateRank(item: TerminalListItem): number {
  const attached = typeof item.session.metadata?.attachedClients === "number"
    ? item.session.metadata.attachedClients
    : 0;
  if (item.surface.state === "exited") return 0;
  if (attached > 0) return 3;
  if (item.surface.state === "detached") return 1;
  return 2;
}

export function terminalSessionStateLabel(item: TerminalListItem): string {
  const attached = typeof item.session.metadata?.attachedClients === "number"
    ? item.session.metadata.attachedClients
    : null;
  if (item.surface.state === "exited") return "exited";
  if (attached && attached > 0) return `${attached} attached`;
  return item.surface.state ?? "live";
}

/**
 * Last activity, in epoch ms, or null when the host does not report one.
 *
 * Discovered records are stamped with the moment they were probed, which is
 * not activity and must not be presented as it. Tmux reports its own last
 * activity; start time remains a compatibility fallback for older hosts.
 */
export function terminalSessionActivityAt(item: TerminalListItem): number | null {
  const activityAt = item.session.metadata?.activityAt;
  if (typeof activityAt === "number" && Number.isFinite(activityAt) && activityAt > 0) return activityAt;
  const startedAt = item.session.metadata?.startedAt;
  if (typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0) return startedAt;
  if (item.origin === "backend") return null;
  return item.session.updatedAt || null;
}

/**
 * Project a terminal surface into the lifecycle policy. Unknown activity stays
 * current: absence of evidence must never become permission to stop work.
 */
export function terminalSessionLifecycle(
  item: TerminalListItem,
  now = Date.now(),
): TerminalSessionLifecycle {
  // Start time is useful for sorting an old host, but it is not proof of
  // inactivity. Lifecycle decisions require last activity (or Scout's own
  // durable update timestamp for registered records).
  const hostActivityAt = item.session.metadata?.activityAt;
  const activityAt = typeof hostActivityAt === "number"
    && Number.isFinite(hostActivityAt)
    && hostActivityAt > 0
    ? hostActivityAt
    : item.origin === "backend"
      ? null
      : item.session.updatedAt || null;
  if (activityAt === null) return "current";
  const age = Math.max(0, now - activityAt);
  if (age >= TERMINAL_SESSION_REVIEW_AFTER_MS) return "review";
  if (age >= TERMINAL_SESSION_INACTIVE_AFTER_MS) return "inactive";
  return "current";
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Sort rows. Stable in two senses: ties fall back to the session name so the
 * order never wobbles between renders, and the comparison is pure so a re-sort
 * of the same rows always produces the same list.
 */
export function sortTerminalSessionItems(
  items: readonly TerminalListItem[],
  sort: TerminalSessionSort,
): TerminalListItem[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    const primary = compareTerminalSessionColumn(left, right, sort.column) * factor;
    return primary !== 0 ? primary : compareText(left.title, right.title);
  });
}

function compareTerminalSessionColumn(
  left: TerminalListItem,
  right: TerminalListItem,
  column: TerminalSessionColumn,
): number {
  switch (column) {
    case "name":
      return compareText(left.title, right.title);
    case "host":
      return compareText(left.surface.backend, right.surface.backend);
    case "state":
      return terminalSessionStateRank(left) - terminalSessionStateRank(right);
    case "project":
      return compareText(left.project, right.project);
    case "activity": {
      // Rows with no reported activity sort last in either direction rather
      // than pretending to be the oldest or the newest.
      const leftAt = terminalSessionActivityAt(left);
      const rightAt = terminalSessionActivityAt(right);
      if (leftAt === null && rightAt === null) return 0;
      if (leftAt === null) return -1;
      if (rightAt === null) return 1;
      return leftAt - rightAt;
    }
  }
}

/** Next sort state when a column header is clicked. */
export function toggleTerminalSessionSort(
  current: TerminalSessionSort,
  column: TerminalSessionColumn,
): TerminalSessionSort {
  if (current.column === column) {
    return { column, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  const initial = TERMINAL_SESSION_COLUMNS.find((candidate) => candidate.id === column)?.initialDirection ?? "asc";
  return { column, direction: initial };
}
