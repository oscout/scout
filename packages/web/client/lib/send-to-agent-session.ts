import { api } from "./api.ts";
import { ensureAgentChat } from "./agent-chat.ts";
import type { Agent } from "./types.ts";
/** Native sessions are continued by session id: they have no conversation to
 *  open, so callers offering a way back must route to the session instead. */
export function isNativeSessionAgent(agent: Agent) { return agent.agentClass === "native-session" || agent.id.startsWith("native:"); }
function nativeSessionInstructionsPayload(agent: Agent, instructions: string) {
  const sessionId = agent.harnessSessionId?.trim();
  if (!sessionId) {
    throw new Error("This native session has no session id to continue.");
  }
  const projectPath = agent.projectRoot?.trim() || agent.cwd?.trim();
  if (!projectPath) {
    throw new Error("This native session has no project path to route from.");
  }
  const harness = agent.harness?.trim();
  return {
    target: { projectPath },
    execution: {
      session: "existing",
      targetSessionId: sessionId,
      ...(harness ? { harness } : {}),
    },
    agent: {
      persistence: "one_time",
      ...(agent.handle?.trim() ? { handle: agent.handle.trim() } : {}),
    },
    seed: { instructions },
  };
}

/**
 * Where a sent message landed, so the caller can offer a way back to it.
 * `conversationId` is null for native sessions, which are continued by session
 * id and have no conversation to open.
 */
export type AgentSendDestination = { conversationId: string | null; sentAt: number };

export async function sendToFocusedAgentSession(
  agent: Agent,
  body: string,
): Promise<AgentSendDestination> {
  if (isNativeSessionAgent(agent)) {
    const sentAt = Date.now();
    await api<unknown>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(nativeSessionInstructionsPayload(agent, body)),
    });
    return { conversationId: null, sentAt };
  }

  const conversationId = await ensureAgentChat(agent);
  // Capture before dispatch: the reply can arrive before the POST resolves.
  const sentAt = Date.now();
  // The card's harness and model describe the agent; they are not a runtime
  // the user chose for this message. Sent as `execution`, the broker reads an
  // ordinary follow-up as an exact-runtime request and refuses the agent's
  // live session for lacking observed evidence of that runtime.
  await api<unknown>("/api/send", {
    method: "POST",
    body: JSON.stringify({
      body,
      chatId: conversationId,
    }),
  });
  return { conversationId, sentAt };
}
