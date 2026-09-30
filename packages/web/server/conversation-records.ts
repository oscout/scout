import type { ConversationDefinition } from "@openscout/protocol";
import { queryConversationDefinitionById } from "./db-queries.ts";
import type { ScoutBrokerContext } from "./core/broker/service.ts";

export function conversationDefinitionFromDb(
  row: NonNullable<ReturnType<typeof queryConversationDefinitionById>>,
): ConversationDefinition {
  return {
    id: row.id,
    kind: row.kind as ConversationDefinition["kind"],
    title: row.title,
    visibility: row.visibility as ConversationDefinition["visibility"],
    shareMode: row.shareMode as ConversationDefinition["shareMode"],
    authorityNodeId: row.authorityNodeId,
    participantIds: [...row.participantIds],
    ...(row.topic ? { topic: row.topic } : {}),
    ...(row.parentConversationId ? { parentConversationId: row.parentConversationId } : {}),
    ...(row.messageId ? { messageId: row.messageId } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}

export function requireAnchorMessageInConversation(
  broker: ScoutBrokerContext,
  parentConversationId: string,
  anchorMessageId: string,
): void {
  const anchor = broker.snapshot.messages[anchorMessageId];
  if (!anchor) {
    throw new Error(`Message ${anchorMessageId} is not available.`);
  }
  if (anchor.conversationId !== parentConversationId) {
    throw new Error(`Message ${anchorMessageId} is not in conversation ${parentConversationId}.`);
  }
}
