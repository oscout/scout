import type { ObserveData, ObserveEvent } from "../../lib/types.ts";

export type RetrospectiveParticipant = { name: string; model: string | null; source: string };

export function retrospectiveParticipants(data: ObserveData): RetrospectiveParticipant[] {
  const agents = data.metadata?.topology?.agents ?? [];
  const seen = new Set<string>();
  const participants: RetrospectiveParticipant[] = [];
  const add = (name: string, model: string | null, source: string) => {
    const key = `${name.toLowerCase()}\u0000${model ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    participants.push({ name, model, source });
  };
  const primaryName = data.metadata?.session?.adapterType ?? "Session agent";
  const primaryModel = data.metadata?.session?.model ?? null;
  if (primaryModel || agents.length > 0) add(primaryName, primaryModel, "session metadata");
  for (const agent of agents) add(agent.name || agent.role || agent.id, agent.model ?? null, "observed harness topology");
  return participants;
}

export function retrospectiveTimelineEvents(data: ObserveData): ObserveEvent[] {
  return data.events.filter((event) => event.kind === "boot" || event.kind === "ask" || event.kind === "system");
}

/** Prefer wall-clock event time; `t` is a session-relative offset in seconds. */
export function formatRetrospectiveTime(event: ObserveEvent): string {
  if (typeof event.at === "number" && Number.isFinite(event.at)) {
    return new Date(event.at).toLocaleTimeString();
  }
  if (typeof event.t === "number" && Number.isFinite(event.t)) {
    const seconds = Math.max(0, Math.floor(event.t));
    if (seconds < 60) return `+${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return remaining === 0 ? `+${minutes}m` : `+${minutes}m ${remaining}s`;
  }
  return "Time unavailable";
}
