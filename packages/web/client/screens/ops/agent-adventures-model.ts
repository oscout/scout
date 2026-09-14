import type { ObserveEvent } from "../../lib/types.ts";
import { observeEventWallMs } from "../../lib/lane-observe.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

export type AdventureKind = "start" | "think" | "read" | "edit" | "tool" | "message" | "wait" | "end" | "stopped";
export type AdventureStop = { id: string; event: ObserveEvent; at: number; kind: AdventureKind; label: string; artifact: string };
export type AdventureJourney = { id: string; stops: AdventureStop[]; partial: boolean; closed: boolean };
const labels: Record<AdventureKind, string> = { start: "Trailhead", think: "Lookout", read: "Field library", edit: "Workbench", tool: "Tool shed", message: "Post station", wait: "Waiting camp", end: "Turn complete", stopped: "Journey interrupted" };

export function adventureKind(event: ObserveEvent): AdventureKind | null {
  const text = event.text.trim().toLowerCase();
  // Lifecycle markers must be records, never a phrase inside agent prose or tool arguments.
  if (event.kind === "note" || event.kind === "system" || event.kind === "boot") {
    if (/^(task started|turn started|\[turn_started\])$/.test(text)) return "start";
    if (/^(task complete|task completed|turn complete|turn completed|turn ended|\[turn_ended\])$/.test(text)) return "end";
    if (/^(?:(?:turn|task) (?:aborted|failed|cancelled|canceled))(?:$|[ :])/.test(text)) return "stopped";
    if (/\b(waiting|approval required|permission requested|blocked)\b/.test(text)) return "wait";
    return null;
  }
  if (event.kind === "think") return "think";
  if (event.kind === "ask" || event.kind === "message") return "message";
  const tool = event.tool?.toLowerCase() ?? "";
  if (/wait|sleep|request_user_input/.test(tool)) return "wait";
  if (event.diff || /(?:^|[._/])(?:edit|write|write_file|edit_file|apply_patch|multiedit|str_replace_editor)$/.test(tool)) return "edit";
  if (/read|search|find|open|view|fetch/.test(tool)) return "read";
  return event.kind === "tool" ? "tool" : null;
}

/** Event order supplies distance. Wall clocks only filter history, never imply progress. */
export function adventureJourneys(lane: AgentLane, horizon: number): AdventureJourney[] {
  const seen = new Set<string>();
  const stops = (lane.observe?.events ?? []).flatMap(event => {
    const at = observeEventWallMs(event, lane.observe?.metadata?.session?.sessionStart);
    const kind = adventureKind(event);
    if (at === null || at > horizon || !kind || seen.has(event.id)) return [];
    seen.add(event.id);
    return [{ id: `${lane.id}:${event.id}`, event, at, kind, label: labels[kind], artifact: event.arg || event.tool || event.text }];
  }).sort((a, b) => a.at - b.at);
  const journeys: AdventureJourney[] = [];
  let journey: AdventureJourney | undefined;
  for (const stop of stops) {
    if (!journey || stop.kind === "start" || journey.closed) {
      journey = { id: stop.id, stops: [], partial: stop.kind !== "start", closed: false };
      journeys.push(journey);
    }
    journey.stops.push(stop);
    journey.closed = stop.kind === "end" || stop.kind === "stopped";
  }
  return journeys;
}
