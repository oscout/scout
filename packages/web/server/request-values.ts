import { AGENT_HARNESSES, type AgentHarness } from "@openscout/protocol";

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Request coercion must recognize the same harness values as the protocol.
export const KNOWN_AGENT_HARNESSES = new Set<string>(AGENT_HARNESSES);

export function coerceAgentHarness(value: unknown): AgentHarness | undefined {
  const normalized = optionalString(value)?.trim();
  return normalized && KNOWN_AGENT_HARNESSES.has(normalized)
    ? (normalized as AgentHarness)
    : undefined;
}
