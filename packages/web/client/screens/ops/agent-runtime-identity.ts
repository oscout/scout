import type { Agent, AgentObservePayload } from "../../lib/types.ts";

export function resolveAgentRuntimeIdentity(
  agent: Pick<Agent, "model" | "providerName">,
  observe: AgentObservePayload | undefined,
): { model: string | null; provider: string | null } {
  return {
    model: observe?.data.metadata?.session?.model ?? agent.model ?? null,
    provider: observe?.data.metadata?.session?.modelProvider ?? agent.providerName ?? null,
  };
}
