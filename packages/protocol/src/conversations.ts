import type {
  MetadataMap,
  ScoutId,
  ShareMode,
  VisibilityScope,
} from "./common.js";

export type ConversationKind =
  | "channel"
  | "direct"
  | "group_direct"
  | "thread"
  | "system";

export interface ConversationDefinition {
  id: ScoutId;
  kind: ConversationKind;
  title: string;
  visibility: VisibilityScope;
  shareMode: ShareMode;
  authorityNodeId: ScoutId;
  participantIds: ScoutId[];
  topic?: string;
  parentConversationId?: ScoutId;
  messageId?: ScoutId;
  metadata?: MetadataMap;
}

export interface ConversationBinding {
  id: ScoutId;
  conversationId: ScoutId;
  platform: string;
  mode: "inbound" | "outbound" | "bidirectional";
  externalChannelId: string;
  externalThreadId?: string;
  metadata?: MetadataMap;
}
