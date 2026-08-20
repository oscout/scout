import type { HerdrAgentStatus, HerdrPaneProjection } from "@openscout/protocol";

/**
 * The herdr session screen's pane table: the same panes the layout replica
 * draws, in a sortable row form. The replica answers "where is everything",
 * the table answers "which of these do I want" — by status, by directory, by
 * drift, or by what a pane last printed. Every column sorts; that is the
 * point of the table over the map.
 */
export type HerdrPaneColumn = "pane" | "harness" | "status" | "directory" | "tab" | "drift" | "output";

export type HerdrPaneSort = {
  column: HerdrPaneColumn;
  direction: "asc" | "desc";
};

/**
 * One table row: the pane projection, the label of the tab it sits in (rows
 * come from the active tab, but the column keeps the table self-describing),
 * and the pane's last visible text when a peek has supplied it.
 */
export type HerdrPaneRow = {
  pane: HerdrPaneProjection;
  tabLabel: string;
  /** Raw peek tail (last few lines); null until the first peek lands. */
  output: string | null;
};

/**
 * Default sort: the panes doing something come first, then alphabetical. An
 * operator opening the table is looking for live work far more often than for
 * an alphabetical index.
 */
export const DEFAULT_HERDR_PANE_SORT: HerdrPaneSort = {
  column: "status",
  direction: "desc",
};

export const HERDR_PANE_COLUMNS: ReadonlyArray<{
  id: HerdrPaneColumn;
  label: string;
  /** Which direction to start in when the column is first clicked. */
  initialDirection: "asc" | "desc";
}> = [
  { id: "pane", label: "Pane", initialDirection: "asc" },
  { id: "harness", label: "Harness", initialDirection: "asc" },
  { id: "status", label: "Status", initialDirection: "desc" },
  { id: "directory", label: "Directory", initialDirection: "asc" },
  { id: "tab", label: "Tab", initialDirection: "asc" },
  { id: "drift", label: "Drift", initialDirection: "desc" },
  { id: "output", label: "Last output", initialDirection: "asc" },
];

/**
 * Rank for the status column. Working outranks blocked because motion beats
 * attention; unknown sinks because it is the absence of a signal, not one.
 */
export function herdrPaneStatusRank(status: HerdrAgentStatus): number {
  switch (status) {
    case "working": return 4;
    case "blocked": return 3;
    case "idle": return 2;
    case "done": return 1;
    case "unknown": return 0;
  }
}

export function herdrPaneLabel(pane: HerdrPaneProjection): string {
  return pane.label ?? pane.paneId;
}

export function herdrPaneDirectory(pane: HerdrPaneProjection): string {
  return pane.foregroundCwd ?? pane.cwd ?? "";
}

/**
 * How far the pane's viewport has drifted from the live bottom edge, in
 * scrollback lines — 0 means the pane is pinned to live output. Null when the
 * host does not report scroll state.
 */
export function herdrPaneDrift(pane: HerdrPaneProjection): number | null {
  return pane.scroll?.offsetFromBottom ?? null;
}

/**
 * The last non-empty line of a peek tail, trimmed — the one-line answer to
 * "what is this pane doing" for the Output column. ANSI escape sequences are
 * stripped; the peek body is raw terminal text.
 */
export function lastOutputLine(body: string | null): string | null {
  if (!body) return null;
  const stripped = body.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const lines = stripped.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line) return line;
  }
  return null;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Sort rows. Stable in two senses: ties fall back to the pane label so the
 * order never wobbles between polls, and the comparison is pure so a re-sort
 * of the same rows always produces the same list. Rows missing a value
 * (drift, output) sort last in either direction rather than pretending to
 * be the smallest or the largest.
 */
export function sortHerdrPaneRows(
  rows: readonly HerdrPaneRow[],
  sort: HerdrPaneSort,
): HerdrPaneRow[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    // Rows missing a value (drift, output) sort last in EITHER direction
    // rather than pretending to be the smallest or the largest — so the null
    // ordering is applied unsigned, before the direction factor.
    const nullOrder = compareHerdrPaneNulls(left, right, sort.column);
    if (nullOrder !== 0) return nullOrder;
    const primary = compareHerdrPaneColumn(left, right, sort.column) * factor;
    return primary !== 0 ? primary : compareText(herdrPaneLabel(left.pane), herdrPaneLabel(right.pane));
  });
}

/** Null bias for the nullable columns: the row with a value wins, always. */
function compareHerdrPaneNulls(
  left: HerdrPaneRow,
  right: HerdrPaneRow,
  column: HerdrPaneColumn,
): number {
  const values = (row: HerdrPaneRow): unknown => column === "drift"
    ? herdrPaneDrift(row.pane)
    : column === "output"
      ? lastOutputLine(row.output)
      : true;
  const leftValue = values(left);
  const rightValue = values(right);
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return 0;
}

function compareHerdrPaneColumn(
  left: HerdrPaneRow,
  right: HerdrPaneRow,
  column: HerdrPaneColumn,
): number {
  switch (column) {
    case "pane":
      return compareText(herdrPaneLabel(left.pane), herdrPaneLabel(right.pane));
    case "harness":
      return compareText(left.pane.agent ?? "", right.pane.agent ?? "");
    case "status":
      return herdrPaneStatusRank(left.pane.agentStatus) - herdrPaneStatusRank(right.pane.agentStatus);
    case "directory":
      return compareText(herdrPaneDirectory(left.pane), herdrPaneDirectory(right.pane));
    case "tab":
      return compareText(left.tabLabel, right.tabLabel);
    case "drift":
      return compareNullable(herdrPaneDrift(left.pane), herdrPaneDrift(right.pane));
    case "output":
      return compareNullable(lastOutputLine(left.output), lastOutputLine(right.output));
  }
}

function compareNullable<T extends string | number>(left: T | null, right: T | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return typeof left === "string" && typeof right === "string"
    ? compareText(left, right)
    : Number(left) - Number(right);
}

/** Next sort state when a column header is clicked. */
export function toggleHerdrPaneSort(
  current: HerdrPaneSort,
  column: HerdrPaneColumn,
): HerdrPaneSort {
  if (current.column === column) {
    return { column, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  const initial = HERDR_PANE_COLUMNS.find((candidate) => candidate.id === column)?.initialDirection ?? "asc";
  return { column, direction: initial };
}
