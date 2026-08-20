import { stateColor } from "../../lib/colors.ts";
import { agentStateLabel } from "../../lib/agent-state.ts";
import type { MissionGroupMode } from "../../lib/mission-control-store.ts";

/** A log that has not emitted inside this window is no longer "live". */
export const ACTIVE_EVENT_WINDOW_MS = 60_000;

export type MissionGroupFields = {
  activityLabel: string;
  workspace: string | null | undefined;
  harness: string | null | undefined;
  state: string | null | undefined;
  source: "scout" | "native";
};

export function missionGroupLabel(
  subject: MissionGroupFields,
  mode: MissionGroupMode,
): string {
  switch (mode) {
    case "activity":
      return subject.activityLabel;
    case "workspace":
      return subject.workspace?.trim() || "Unassigned";
    case "harness":
      return subject.harness?.trim() || "Unknown harness";
    case "state":
      return agentStateLabel(subject.state ?? null);
    case "source":
      return subject.source === "native" ? "Native sessions" : "Scout agents";
  }
}

export const KIND_LABEL: Record<string, string> = {
  think: "think",
  tool: "tool",
  ask: "ask",
  message: "msg",
  note: "note",
  system: "sys",
  boot: "boot",
};

export function stateChipColor(state: string): string {
  return stateColor(state);
}
