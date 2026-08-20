import type { Agent, Route } from "./types.ts";

export type CaptureRouteContext = {
  agentId: string | null;
  conversationId: string | null;
  label: string;
  canUseExistingChat: boolean;
};

function agentById(agents: Agent[], agentId: string | null | undefined): Agent | null {
  const id = agentId?.trim();
  if (!id) return null;
  return agents.find((agent) => agent.id === id) ?? null;
}

export function resolveCaptureRouteContext(
  route: Route,
  agents: Agent[],
): CaptureRouteContext {
  if (route.view === "conversation" && route.conversationId) {
    return {
      agentId: null,
      conversationId: route.conversationId,
      label: "Current chat",
      canUseExistingChat: true,
    };
  }

  if (route.view === "messages" && route.conversationId) {
    return {
      agentId: null,
      conversationId: route.conversationId,
      label: "Current chat",
      canUseExistingChat: true,
    };
  }

  if (route.view === "agents-v2" && route.agentId) {
    const agent = agentById(agents, route.agentId);
    const conversationId = route.conversationId ?? agent?.conversationId ?? null;
    return {
      agentId: route.agentId,
      conversationId,
      label: agent?.name ?? route.agentId,
      canUseExistingChat: Boolean(conversationId),
    };
  }

  return {
    agentId: null,
    conversationId: null,
    label: "Pick a project",
    canUseExistingChat: false,
  };
}
