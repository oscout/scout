import { api } from "./api.ts";
import type { Agent } from "./types.ts";

type DirectConversationResult = {
  chatId?: string | null;
  conversationId?: string | null;
  cId?: string | null;
  id?: string | null;
};

export async function ensureAgentChat(
  agent: Pick<Agent, "id" | "name" | "conversationId"> & Partial<Pick<Agent, "projectRoot" | "cwd" | "selector" | "defaultSelector">>,
): Promise<string> {
  const existing = agent.conversationId?.trim();
  if (existing) return existing;

  const projectPath = agent.projectRoot?.trim() || agent.cwd?.trim();
  const result = await api<DirectConversationResult>("/api/conversations/direct", {
    method: "POST",
    body: JSON.stringify({
      agentId: agent.id,
      targetLabel: agent.selector ?? agent.defaultSelector ?? agent.name,
      ...(projectPath ? { projectPath } : {}),
    }),
  });
  const chatId =
    result.chatId?.trim()
    ?? result.conversationId?.trim()
    ?? result.cId?.trim()
    ?? result.id?.trim();
  if (!chatId) {
    throw new Error("Chat was created, but no chat id was returned.");
  }
  return chatId;
}
