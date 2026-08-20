import type { MetadataMap, ScoutId } from "./common.js";

export interface ConversationReadCursor {
  conversationId: ScoutId;
  actorId: ScoutId;
  readerNodeId?: ScoutId;
  lastReadMessageId?: ScoutId;
  lastReadSeq?: number;
  lastReadAt: number;
  updatedAt: number;
  metadata?: MetadataMap;
}
