import type { TerminalListItem } from "../../lib/terminal-sessions.ts";
import { terminalSessionActivityAt } from "./session-table.ts";

/**
 * The rail is an index with two cuts of the same terminals: by project, and by
 * recency. Both are pure — the same items and context in always produce the
 * same sections out — so the ordering rules live here and are tested here.
 *
 * Two things both cuts agree on:
 *
 * - **Working leads.** A terminal where work is moving right now (an agent in
 *   a turn, a herdr pane reporting `working`) sorts as "now", whatever its
 *   recorded activity time says. The caller decides what counts as working.
 * - **Stopped folds.** A herdr session whose server is down still exists and
 *   still reattaches, but it is not a place anything is happening. Sections
 *   carry their stopped sessions separately so the rail can fold them to one
 *   line instead of listing them among live terminals.
 */
export type TerminalNavMode = "projects" | "recent";

export type TerminalNavSection = {
  key: string;
  label: string;
  /** Running terminals, working first, then most recent. */
  items: TerminalListItem[];
  /** Stopped host sessions that belong here, folded by the rail. */
  stopped: TerminalListItem[];
  /** Latest activity across the section's running items; null when unknown. */
  latestActivity: number | null;
  /** True when anything in the section is working now. */
  working: boolean;
};

export type TerminalNavContext = {
  now?: number;
  /** Work is moving in this terminal right now. */
  isWorking?: (item: TerminalListItem) => boolean;
  /** Overrides the record's project, e.g. from a live herdr topology. */
  projectOf?: (item: TerminalListItem) => string | null;
};

export const TERMINAL_NAV_MODES: ReadonlyArray<{
  id: TerminalNavMode;
  label: string;
  title: string;
}> = [
  { id: "projects", label: "Projects", title: "Group by project" },
  { id: "recent", label: "Recent", title: "Group by last activity" },
];

/** Labels that name an absence rather than a place; they sink to the bottom. */
const CATCH_ALL_PROJECTS = new Set(["backend-only", "unscoped"]);
export const HOME_PROJECT_LABEL = "Home";

/**
 * A herdr session is `live` while its server answers; anything else means the
 * server is down (herdr has no detach — tmux's "detached" means running with
 * nobody looking, herdr's means stopped).
 */
export function isStoppedHostItem(item: TerminalListItem): boolean {
  return item.surface.backend === "herdr" && item.surface.state !== "live";
}

/** A terminal opened in the home directory itself, not in a project under it. */
function isHomeDirectory(path: string | null | undefined): boolean {
  return /^\/(?:Users|home)\/[^/]+\/?$/u.test(path?.trim() ?? "");
}

export function projectLabel(item: TerminalListItem, context: TerminalNavContext = {}): string {
  const override = context.projectOf?.(item);
  if (override) return override;
  if (isHomeDirectory(item.session.cwd)) return HOME_PROJECT_LABEL;
  return item.project;
}

function sinks(label: string): boolean {
  return CATCH_ALL_PROJECTS.has(label) || label === HOME_PROJECT_LABEL;
}

function compareNames(left: TerminalListItem, right: TerminalListItem): number {
  return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" });
}

/** Working first, then most recent activity, then name; unknown activity last. */
function orderItems(items: TerminalListItem[], context: TerminalNavContext): TerminalListItem[] {
  const working = (item: TerminalListItem) => context.isWorking?.(item) ?? false;
  return [...items].sort((left, right) => {
    const workingRank = Number(working(right)) - Number(working(left));
    if (workingRank !== 0) return workingRank;
    const leftAt = terminalSessionActivityAt(left) ?? -1;
    const rightAt = terminalSessionActivityAt(right) ?? -1;
    if (leftAt !== rightAt) return rightAt - leftAt;
    return compareNames(left, right);
  });
}

function latestActivity(items: TerminalListItem[]): number | null {
  const times = items.map(terminalSessionActivityAt).filter((value): value is number => value !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

function indexByProjects(items: TerminalListItem[], context: TerminalNavContext): TerminalNavSection[] {
  const byProject = new Map<string, TerminalListItem[]>();
  for (const item of items) {
    const label = projectLabel(item, context);
    const group = byProject.get(label);
    if (group) group.push(item);
    else byProject.set(label, [item]);
  }
  const sections = [...byProject.entries()].map(([label, groupItems]): TerminalNavSection => {
    const running = groupItems.filter((item) => !isStoppedHostItem(item));
    return {
      key: `project:${label}`,
      label,
      items: orderItems(running, context),
      stopped: [...groupItems.filter(isStoppedHostItem)].sort(compareNames),
      latestActivity: latestActivity(running),
      working: running.some((item) => context.isWorking?.(item) ?? false),
    };
  });
  // The project you touched last sits on top; a project with work moving now
  // outranks any recorded time. Places that name an absence sink.
  return sections.sort((left, right) => {
    if (sinks(left.label) !== sinks(right.label)) return sinks(left.label) ? 1 : -1;
    if (left.working !== right.working) return left.working ? -1 : 1;
    const leftAt = left.latestActivity ?? -1;
    const rightAt = right.latestActivity ?? -1;
    if (leftAt !== rightAt) return rightAt - leftAt;
    return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
  });
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

type RecentBucket = "working" | "hour" | "today" | "yesterday" | "week" | "older" | "unknown";

const RECENT_BUCKETS: ReadonlyArray<{ key: RecentBucket; label: string }> = [
  { key: "working", label: "Working now" },
  { key: "hour", label: "Last hour" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" },
  { key: "older", label: "Older" },
  { key: "unknown", label: "No activity reported" },
];

/** Local midnight at the start of the day containing `now`. */
function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function indexByRecent(items: TerminalListItem[], context: TerminalNavContext, now: number): TerminalNavSection[] {
  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const bucketOf = (item: TerminalListItem): RecentBucket => {
    if (context.isWorking?.(item)) return "working";
    const at = terminalSessionActivityAt(item);
    if (at === null) return "unknown";
    if (now - at < HOUR_MS) return "hour";
    if (at >= today) return "today";
    if (at >= yesterday) return "yesterday";
    if (now - at < 7 * DAY_MS) return "week";
    return "older";
  };
  const running = items.filter((item) => !isStoppedHostItem(item));
  const sections = RECENT_BUCKETS.map((bucket): TerminalNavSection => {
    const bucketItems = running.filter((item) => bucketOf(item) === bucket.key);
    return {
      key: bucket.key,
      label: bucket.label,
      items: orderItems(bucketItems, context),
      stopped: [],
      latestActivity: latestActivity(bucketItems),
      working: bucket.key === "working",
    };
  }).filter((section) => section.items.length > 0);
  const stopped = items.filter(isStoppedHostItem);
  if (stopped.length > 0) {
    sections.push({
      key: "stopped",
      label: "Stopped",
      items: [],
      stopped: [...stopped].sort(compareNames),
      latestActivity: null,
      working: false,
    });
  }
  return sections;
}

export function groupTerminalNavItems(
  items: TerminalListItem[],
  mode: TerminalNavMode,
  context: TerminalNavContext = {},
): TerminalNavSection[] {
  const now = context.now ?? Date.now();
  return mode === "recent"
    ? indexByRecent(items, context, now)
    : indexByProjects(items, context);
}

/** Persisted modes from before the index had two cuts map onto the nearest one. */
export function normalizeTerminalNavMode(value: unknown): TerminalNavMode {
  if (value === "recent" || value === "time" || value === "attention") return "recent";
  return "projects";
}
