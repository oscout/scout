import { routeForFollowTarget } from "../../lib/follow-route.ts";
import type { Route, WorkDetail } from "../../lib/types.ts";

/** Keep typed Scout handles so the tail can resolve the native harness session. */
export function workTailRoute(detail: WorkDetail): Route {
  const ask = detail.primaryInvocation;
  return routeForFollowTarget({
    workId: detail.id,
    flightId: ask?.flightId ?? null,
    invocationId: ask?.invocationId ?? null,
    conversationId: ask?.conversationId ?? detail.conversationId,
    sessionId: ask?.resolvedSessionId ?? ask?.targetSessionId ?? null,
    targetAgentId: ask?.targetAgentId ?? detail.ownerId,
  }, "tail");
}

export function initialWorkBriefSummary(detail: WorkDetail): string | null {
  const prompt = detail.primaryInvocation?.task?.trim();
  if (prompt) return prompt;
  const oldestFirst = [...detail.timeline].sort((a, b) => a.at - b.at);
  const openingMessage = oldestFirst.find((item) => item.kind === "message" && item.summary);
  const createdEvent = oldestFirst.find((item) =>
    item.kind === "collaboration_event" && item.detailKind === "created" && item.summary
  );
  return openingMessage?.summary ?? createdEvent?.summary ?? null;
}

/** Images use the bounded raw-material endpoint rather than the text reader. */
export function workMaterialImageUrl(workId: string, material: { id: string; path: string } | null | undefined): string | null {
  if (!material || !/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(material.path)) return null;
  return `/api/work/${encodeURIComponent(workId)}/material/raw?materialId=${encodeURIComponent(material.id)}`;
}
