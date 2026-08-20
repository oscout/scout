/**
 * Conversation IDs are opaque. This module only keeps actor helpers used by
 * query code that needs to understand operator-vs-agent membership.
 */

import { resolveOperatorHandle, resolveOperatorName } from "../user-config.js";

export function configuredOperatorActorIds(): string[] {
  const operatorName = resolveOperatorName().trim() || "operator";
  const operatorHandle = resolveOperatorHandle().trim() || operatorName;
  return Array.from(new Set(["operator", operatorName, operatorHandle]));
}

export function isLikelyLocalSessionAgentId(actorId: string): boolean {
  return actorId.startsWith("local-session-agent-");
}

export function conversationIdAliases(conversationId: string): string[] {
  return [conversationId];
}
