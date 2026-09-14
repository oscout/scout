import type { AgentLane } from "./agent-lanes-model.ts";

/** Prefer recorded names; preserve a short discriminator only for unnamed actors. */
export function floorCharacterName(lane: AgentLane): { name: string; label: string; named: boolean } {
  const name = lane.agent.name.trim();
  const harness = lane.agent.harness?.trim() || "Agent";
  const escaped = harness.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const synthesized = new RegExp(`^${escaped}\\s+(?:subagent\\s+)?[0-9a-f]{6}`, "i").test(name);
  const named = Boolean(name && !synthesized && name.toLowerCase() !== harness.toLowerCase());
  const primary = named ? name : harness;
  return { name: primary, label: named ? primary : `${primary} · ${lane.id.slice(-4)}`, named };
}
