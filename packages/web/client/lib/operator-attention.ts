import { api } from "./api.ts";
import type { FleetAsk, FleetAttentionItem, Route } from "./types.ts";

function directResolutionRoute({
  conversationId,
  workId,
  agentId,
}: {
  conversationId?: string | null;
  workId?: string | null;
  agentId?: string | null;
}): Route {
  if (conversationId) return { view: "conversation", conversationId };
  if (workId) {
    return {
      view: "follow",
      workId,
      preferredView: "chat",
      ...(agentId ? { targetAgentId: agentId } : {}),
    };
  }
  if (agentId) return { view: "agents-v2", agentId, tab: "message" };
  return { view: "inbox" };
}

export function routeForOperatorAttention(item: FleetAttentionItem): Route {
  return directResolutionRoute({
    conversationId: item.conversationId,
    workId: item.kind === "work_item" ? item.recordId : null,
    agentId: item.agentId,
  });
}

export function routeForFleetAsk(ask: FleetAsk): Route {
  return directResolutionRoute({
    conversationId: ask.conversationId,
    workId: ask.collaborationRecordId,
    agentId: ask.agentId,
  });
}

export type OperatorAttentionDismissTarget =
  | {
      recordKind: "work_item" | "question";
      recordId: string;
      itemUpdatedAt: number;
    }
  | {
      flightId: string;
      itemUpdatedAt: number;
    };

export async function dismissOperatorAttention(target: OperatorAttentionDismissTarget): Promise<void> {
  await api("/api/operator-attention/dismiss", {
    method: "POST",
    body: JSON.stringify(target),
  });
}
