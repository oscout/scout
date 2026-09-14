import { floorPreviewText } from "./floor-preview-text.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import { floorActorState } from "./agent-floor-actor.ts";
import { floorContextEvents } from "./floor-context-model.ts";

function prose(value: string | undefined, limit: number): string {
  const clean = floorPreviewText(value, limit);
  if (!clean || /<realtime_|^\s*(?:\{|\[|```|text\(|const |await )/.test(clean)) return "";
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

export function characterContext(lane: AgentLane, now: number) {
  const state = floorActorState(lane, now);
  const latest = floorContextEvents([lane], now, ["tool", "message", "ask"], 1)[0];
  const task = prose(lane.facts?.currentTask, 220);
  let activity = "";
  if (latest) {
    const event = latest.event;
    if (event.kind === "tool") {
      const tool = event.tool || "tool";
      activity = /read|open|view/i.test(tool) ? "Reading context" : /edit|write|patch/i.test(tool) ? "Updating files" : /search|grep|find/i.test(tool) ? "Searching the workspace" : /bash|exec|terminal/i.test(tool) ? "Running a command" : `Using ${tool}`;
      const detail = prose(event.arg, 120);
      if (detail && /read|open|view|edit|write|search|grep|find/i.test(tool)) activity += ` · ${detail}`;
    } else activity = prose(event.text, 180) || (event.kind === "ask" ? "Asking for input" : "Sharing an update");
  }
  const settled = state.posture === "quiet";
  const summary = state.posture === "attention" || state.posture === "blocked"
    ? `${state.label}${task ? ` · ${task}` : ""}`
    : settled ? task ? `Last task · ${task}` : activity ? `Last activity · ${activity}` : "No recent updates"
    : activity || task || state.label;
  return { summary: prose(summary, 76), task, activity, at: latest?.at, state: state.label };
}
