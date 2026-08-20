import {
  invokeAcpAgent,
  type AcpAgentInvocationResult,
} from "./acp-agent-invocation.js";

export interface GrokAcpInvocationOptions {
  sessionId: string;
  poolKey?: string;
  resumeSessionId?: string;
  cwd: string;
  prompt: string;
  name?: string;
  timeoutMs?: number;
  adapterOptions?: Record<string, unknown>;
}

export type GrokAcpInvocationResult = AcpAgentInvocationResult;

export async function invokeGrokAcpAgent(
  options: GrokAcpInvocationOptions,
): Promise<GrokAcpInvocationResult> {
  return await invokeAcpAgent({
    ...options,
    adapterType: "grok-acp",
    label: "Grok ACP",
  });
}
