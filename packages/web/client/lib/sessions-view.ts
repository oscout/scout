/**
 * Sessions view — the queue projection of the Messages rail. One row per task
 * conversation, grouped by a switchable abstraction. The queue is the view
 * that is ALLOWED to move; the Agents view stays still.
 *
 * Pure module: type-only imports so it stays runnable under bun test.
 */

import type { Agent, FleetAsk, SessionEntry } from "./types.ts";
import type { SessionsGroupKey } from "./messages-rail-prefs.ts";
import {
  fleetAskForSession,
  type FleetActiveAskIndex,
} from "./fleet-active-asks.ts";
import { conversationalMessagePreview } from "./message-visibility.ts";

export type QueueSession = Pick<
  SessionEntry,
  "id" | "agentId" | "agentName" | "lastMessageAt"
>;
type QueueAgent = Pick<Agent, "id" | "name" | "project" | "projectRoot">;
type QueueAsk = Pick<FleetAsk, "status">;

export type SessionGroup<S extends QueueSession> = {
  label: string;
  sessions: S[];
};

export const NO_PROJECT_LABEL = "No project";

/** Same fallback ladder the group rail uses: project name, else repo basename. */
export function projectLabelForAgent(
  agent: Pick<Agent, "project" | "projectRoot"> | undefined,
): string {
  const project = agent?.project?.trim();
  if (project) return project;
  const root = agent?.projectRoot?.trim();
  if (root) {
    const base = root.replace(/\/+$/, "").split("/").pop();
    if (base) return base;
  }
  return NO_PROJECT_LABEL;
}

/**
 * A task-thread title. Untitled DMs display-title as the agent name, which is
 * useless in a list of same-agent tasks — fall through to the preview, then
 * the branch, then whatever the display title was.
 */
export function taskThreadTitle(
  s: Pick<SessionEntry, "title" | "agentName" | "preview" | "currentBranch" | "id">,
): string {
  const title = (s.title ?? "").trim() || s.agentName || s.id;
  const name = (s.agentName ?? "").trim().toLowerCase();
  if (title && title.trim().toLowerCase() !== name) return title;
  const preview = s.preview
    ? conversationalMessagePreview(s.preview).replace(/\s+/g, " ").trim()
    : "";
  if (preview) return preview.length > 64 ? `${preview.slice(0, 61)}…` : preview;
  return s.currentBranch ?? title;
}

export type QueueState = "needs_you" | "working" | "queued" | "quiet";

const STATE_LABELS: Record<QueueState, string> = {
  needs_you: "Needs you",
  working: "Working",
  queued: "Starting",
  quiet: "Quiet",
};
const STATE_ORDER: QueueState[] = ["needs_you", "working", "queued", "quiet"];

/** Per-session state from its conversation-scoped ask. */
export function queueSessionState(ask: QueueAsk | undefined): QueueState {
  if (ask?.status === "needs_attention") return "needs_you";
  if (ask?.status === "working") return "working";
  if (ask?.status === "queued") return "queued";
  return "quiet";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Today", "Yesterday", "This week", "Earlier"] as const;

export function dayBucket(lastMessageAt: number | null, now: number): string {
  if (!lastMessageAt) return "Earlier";
  // Local calendar days — "Today" means the user's today, not a UTC bucket.
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const delta = Math.round((startOfDay(now) - startOfDay(lastMessageAt)) / DAY_MS);
  if (delta <= 0) return "Today";
  if (delta === 1) return "Yesterday";
  if (delta < 7) return "This week";
  return "Earlier";
}

/**
 * Group the queue. Section order is fixed per key (alphabetical for
 * project/agent with the no-project bucket last; ladder order for day/state);
 * WITHIN a group rows sort by recency.
 */
export function groupQueueSessions<S extends QueueSession>(
  sessions: S[],
  by: SessionsGroupKey,
  agentById: Map<string, QueueAgent>,
  activeAsks: FleetActiveAskIndex,
  now: number,
): Array<SessionGroup<S>> {
  const label = (s: S): string => {
    const agent = s.agentId ? agentById.get(s.agentId) : undefined;
    switch (by) {
      case "project":
        return projectLabelForAgent(agent);
      case "agent":
        return agent?.name ?? s.agentName ?? "Unknown agent";
      case "day":
        return dayBucket(s.lastMessageAt, now);
      case "state":
        return STATE_LABELS[
          queueSessionState(fleetAskForSession(activeAsks, s))
        ];
    }
  };

  const buckets = new Map<string, S[]>();
  for (const s of sessions) {
    const key = label(s);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(s);
    else buckets.set(key, [s]);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }

  const orderedLabels = (() => {
    const labels = [...buckets.keys()];
    if (by === "day") {
      return DAY_LABELS.filter((l) => buckets.has(l));
    }
    if (by === "state") {
      return STATE_ORDER.map((s) => STATE_LABELS[s]).filter((l) => buckets.has(l));
    }
    return labels.sort((a, b) => {
      if (a === NO_PROJECT_LABEL) return 1;
      if (b === NO_PROJECT_LABEL) return -1;
      return a.localeCompare(b);
    });
  })();

  return orderedLabels.map((l) => ({ label: l, sessions: buckets.get(l)! }));
}
