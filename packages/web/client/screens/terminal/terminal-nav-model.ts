import {
  terminalNavGroup,
  type TerminalListItem,
  type TerminalNavGroup,
} from "../../lib/terminal-sessions.ts";
import { terminalSessionActivityAt, terminalSessionStateRank } from "./session-table.ts";

/**
 * Navigator modes: the rail's grouping axis. The fleet axis orders by
 * intentionality (herdr → named tmux → generated tmux → background); the other
 * axes re-cut the same list by project, by recency, or by attention state.
 * All pure: the same items in always produce the same sections out.
 */
export type TerminalNavMode = "fleet" | "places" | "time" | "attention";

export type TerminalNavSection = {
  key: string;
  label: string;
  items: TerminalListItem[];
};

export const TERMINAL_NAV_MODES: ReadonlyArray<{
  id: TerminalNavMode;
  label: string;
  title: string;
}> = [
  { id: "fleet", label: "Fleet", title: "Group by fleet: herdr, tmux, background" },
  { id: "places", label: "Places", title: "Group by project" },
  { id: "time", label: "Time", title: "Group by last activity" },
  { id: "attention", label: "Attention", title: "Group by attention state: attached, live, detached, exited" },
];

const FLEET_SECTIONS: ReadonlyArray<{ id: TerminalNavGroup; label: string }> = [
  { id: "herdr", label: "Herdr" },
  { id: "tmux-named", label: "Tmux" },
  { id: "tmux-auto", label: "Tmux · auto" },
  { id: "external", label: "Background" },
];

const NOW_BUCKET_MS = 15 * 60 * 1_000;
const TODAY_BUCKET_MS = 24 * 60 * 60 * 1_000;
const WEEK_BUCKET_MS = 7 * 24 * 60 * 60 * 1_000;

const TIME_BUCKETS = [
  { key: "now", label: "Now", maxAgeMs: NOW_BUCKET_MS },
  { key: "today", label: "Today", maxAgeMs: TODAY_BUCKET_MS },
  { key: "week", label: "This week", maxAgeMs: WEEK_BUCKET_MS },
  { key: "older", label: "Older", maxAgeMs: null },
  { key: "unknown", label: "Unknown", maxAgeMs: null },
] as const;

const ATTENTION_SECTIONS = [
  { key: "attached", label: "Attached", rank: 3 },
  { key: "live", label: "Live", rank: 2 },
  { key: "detached", label: "Detached", rank: 1 },
  { key: "exited", label: "Exited", rank: 0 },
] as const;

function groupByFleet(items: TerminalListItem[]): TerminalNavSection[] {
  return FLEET_SECTIONS
    .map((section) => ({
      key: section.id,
      label: section.label,
      items: items.filter((item) => terminalNavGroup(item) === section.id),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * Projects are ordered by their most recent activity — the project you touched
 * last sits on top — with the catch-all labels ("backend-only", "unscoped")
 * sunk to the bottom since they name an absence, not a place.
 */
function groupByPlaces(items: TerminalListItem[]): TerminalNavSection[] {
  const byProject = new Map<string, TerminalListItem[]>();
  for (const item of items) {
    const group = byProject.get(item.project);
    if (group) group.push(item);
    else byProject.set(item.project, [item]);
  }
  const catchAll = new Set(["backend-only", "unscoped"]);
  const sections = [...byProject.entries()].map(([project, groupItems]) => ({
    key: `project:${project}`,
    label: project,
    items: groupItems,
    latestActivity: Math.max(
      ...groupItems.map((item) => terminalSessionActivityAt(item) ?? 0),
    ),
    isCatchAll: catchAll.has(project),
  }));
  sections.sort((left, right) => {
    if (left.isCatchAll !== right.isCatchAll) return left.isCatchAll ? 1 : -1;
    if (left.latestActivity !== right.latestActivity) return right.latestActivity - left.latestActivity;
    return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
  });
  return sections.map(({ key, label, items: groupItems }) => ({ key, label, items: groupItems }));
}

function groupByTime(items: TerminalListItem[], now: number): TerminalNavSection[] {
  const bucketOf = (item: TerminalListItem): string => {
    const activityAt = terminalSessionActivityAt(item);
    if (activityAt === null) return "unknown";
    const age = Math.max(0, now - activityAt);
    for (const bucket of TIME_BUCKETS) {
      if (bucket.maxAgeMs !== null && age < bucket.maxAgeMs) return bucket.key;
    }
    return "older";
  };
  return TIME_BUCKETS
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      items: items.filter((item) => bucketOf(item) === bucket.key),
    }))
    .filter((section) => section.items.length > 0);
}

function groupByAttention(items: TerminalListItem[]): TerminalNavSection[] {
  return ATTENTION_SECTIONS
    .map((section) => ({
      key: section.key,
      label: section.label,
      items: items.filter((item) => terminalSessionStateRank(item) === section.rank),
    }))
    .filter((section) => section.items.length > 0);
}

export function groupTerminalNavItems(
  items: TerminalListItem[],
  mode: TerminalNavMode,
  now = Date.now(),
): TerminalNavSection[] {
  switch (mode) {
    case "fleet":
      return groupByFleet(items);
    case "places":
      return groupByPlaces(items);
    case "time":
      return groupByTime(items, now);
    case "attention":
      return groupByAttention(items);
  }
}
