export type AgentLanesLayoutMode = "lanes" | "grid" | "floor";

export type AgentLanesGridColumns = "auto" | "2" | "3" | "4";

export const AGENT_LANES_LAYOUT_OPTIONS: ReadonlyArray<{
  key: AgentLanesLayoutMode;
  label: string;
}> = [
  { key: "lanes", label: "lanes" },
  { key: "grid", label: "grid" },
  { key: "floor", label: "floor" },
];

export const AGENT_LANES_GRID_COLUMN_OPTIONS: ReadonlyArray<{
  key: AgentLanesGridColumns;
  label: string;
}> = [
  { key: "auto", label: "auto" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
  { key: "4", label: "4" },
];

export function normalizeAgentLanesLayoutMode(
  value: string | null | undefined,
  embedded = false,
): AgentLanesLayoutMode {
  if (value === "grid") return "grid";
  if (value === "floor") return embedded ? "lanes" : "floor";
  return "lanes";
}

export function normalizeAgentLanesGridColumns(
  value: string | null | undefined,
): AgentLanesGridColumns {
  if (value === "2" || value === "3" || value === "4") return value;
  return "auto";
}

export function agentLanesLayoutOptions(
  embedded: boolean,
): ReadonlyArray<{ key: AgentLanesLayoutMode; label: string }> {
  return embedded
    ? AGENT_LANES_LAYOUT_OPTIONS.filter((option) => option.key !== "floor")
    : AGENT_LANES_LAYOUT_OPTIONS;
}
