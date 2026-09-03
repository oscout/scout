import type { ConversationKind } from "./conversations.js";
import type { ObservedActivity } from "./observed-status.js";

export const CONVERSATION_PROJECTION_VERSION = 1;

export type ConversationProjectionEntityKind =
  | "scout_conversation"
  | "observed_session";

export type ConversationProjectionVisibility = "visible" | "hidden";

export type ConversationProjectionItem = {
  feedId: string;
  entityKind: ConversationProjectionEntityKind;
  kind: ConversationKind | "observed_session";
  conversationId: string | null;
  runtimeSessionId: string | null;
  source: string | null;
  sourceSessionId: string | null;
  title: string | null;
  alias: string | null;
  naturalKey: string | null;
  projectRoot: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  agentId: string | null;
  agentName: string | null;
  currentBranch: string | null;
  authorityNodeId: string | null;
  authorityNodeName: string | null;
  parentConversationId: string | null;
  anchorMessageId: string | null;
  activityState: ObservedActivity;
  lastMessageId: string | null;
  lastMessageAt: number | null;
  lastActivityAt: number;
  messageCount: number;
  unreadCount: number;
  participantCount: number;
  preview: string | null;
  lastEngagedAt: number | null;
  sourceFreshAt: number | null;
  visibilityState: ConversationProjectionVisibility;
  updatedSeq: number;
  updatedAt: number;
};

export type ConversationProjectionIdentityRedirect = {
  fromFeedId: string;
  toFeedId: string;
};

export type ConversationProjectionDelta = {
  upserted: ConversationProjectionItem[];
  notVisible: string[];
  hardDeleted: string[];
  identityRedirects: ConversationProjectionIdentityRedirect[];
};

export type ConversationProjectionEvent = {
  projectionId: string;
  seq: number;
  ts: number;
  delta: ConversationProjectionDelta;
};

export type ConversationProjectionCursor = {
  projectionId: string;
  seq: number;
};

export type ConversationProjectionSnapshot = {
  projectionId: string;
  projectionVersion: number;
  sequence: number;
  generatedAt: number;
  sourceFreshAt: number | null;
  items: ConversationProjectionItem[];
  total: number;
  hasMore: boolean;
  engagedFeedId: string | null;
  identityRedirects: ConversationProjectionIdentityRedirect[];
};

export type ConversationThreadLaunchSnapshot = {
  projectionId: string;
  projectionVersion: number;
  /**
   * Material projection sequence used only to order complete native artifact
   * replacements. Paging uses the independent opaque `cursor` below.
   */
  sequence: number;
  feedId: string;
  entityKind: "scout_conversation";
  conversationId: string;
  cursor: string | null;
  hasEarlier: boolean;
  generatedAt: number;
  messages: Array<{
    id: string;
    actorId: string;
    actorName: string | null;
    body: string;
    class: string;
    createdAt: number;
  }>;
};

export function scoutConversationFeedId(conversationId: string): string {
  return `conv:${conversationId}`;
}

export function observedSessionFeedId(source: string, sourceSessionId: string): string {
  return `obs:${source}:${sourceSessionId}`;
}

export function compareConversationProjectionItems(
  left: Pick<ConversationProjectionItem, "feedId" | "lastActivityAt">,
  right: Pick<ConversationProjectionItem, "feedId" | "lastActivityAt">,
): number {
  return right.lastActivityAt - left.lastActivityAt
    || left.feedId.localeCompare(right.feedId);
}
