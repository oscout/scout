import { isStrReplaceTool } from "./lane-edit-display.ts";
import type { ObserveEvent } from "./types.ts";

export type GrokLaneSystemKind = "permission" | "phase" | "turn";

export type GrokLaneSystemParts = {
  kind: GrokLaneSystemKind;
  tool?: string;
  decision?: string;
  phase?: string;
  turn?: number;
  model?: string;
};

const PERMISSION_LINE = /^permission ([a-z_]+) · ([A-Za-z][\w-]*)$/i;
const PHASE_LINE = /^phase · ([a-z0-9_]+)$/i;
const TURN_LINE = /^turn (\d+)(?: · (.+))?$/i;

/** Grok lifecycle phases that add no signal in a lane trace. */
export const GROK_LANE_NOISE_PHASES = new Set([
  "waiting_for_model",
  "streaming_reasoning",
  "streaming_text",
  "tool_execution",
  "permission_prompt",
]);

export function parseGrokLaneSystemText(text: string): GrokLaneSystemParts | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const permission = trimmed.match(PERMISSION_LINE);
  if (permission?.[1] && permission[2]) {
    return {
      kind: "permission",
      decision: permission[1].toLowerCase(),
      tool: permission[2],
    };
  }

  const phase = trimmed.match(PHASE_LINE);
  if (phase?.[1]) {
    return { kind: "phase", phase: phase[1] };
  }

  const turn = trimmed.match(TURN_LINE);
  if (turn?.[1]) {
    return {
      kind: "turn",
      turn: Number(turn[1]),
      model: turn[2]?.trim() || undefined,
    };
  }

  return null;
}

export function grokLanePhaseIsNoise(phase: string): boolean {
  return GROK_LANE_NOISE_PHASES.has(phase.trim().toLowerCase());
}

export function humanizeGrokLanePhase(phase: string): string {
  return phase.trim().replace(/_/g, " ");
}

function fileLeaf(path: string): string {
  const clean = path.trim().replace(/\/+$/u, "");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

export function grokLaneGutterLabel(
  event: Pick<ObserveEvent, "kind" | "text" | "tool" | "arg">,
): string | null {
  if (event.kind === "tool") {
    if (event.tool === "res") return "result";
    if (isStrReplaceTool(event.tool)) {
      const path = event.arg?.trim();
      return path ? fileLeaf(path) : "edit";
    }
    return event.tool?.trim() || "tool";
  }

  const parsed = parseGrokLaneSystemText(event.text ?? "");
  if (!parsed) return null;

  if (parsed.kind === "permission" && parsed.tool) return parsed.tool;
  if (parsed.kind === "phase") return "phase";
  if (parsed.kind === "turn") return "turn";

  return null;
}