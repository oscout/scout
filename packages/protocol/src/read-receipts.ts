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

/** A viewer's retained unread projection. Root messages and each thread keep
 * separate cursors so opening a channel never reads unopened thread replies.
 */
export interface ChatReadLane {
  rootMessageId: ScoutId | null;
  lastReadMessageId: ScoutId | null;
  latestMessageId: ScoutId | null;
  unreadMessageIds: ScoutId[];
  mentionMessageIds: ScoutId[];
  /** The retained page cannot establish the entire unread history. */
  incomplete: boolean;
}

export interface ChatReadState {
  channelId: ScoutId;
  actorId: ScoutId;
  lanes: ChatReadLane[];
  preferences?: ChatAttentionPreferences;
  pins?: import("./chat-pins.js").ChatPin[];
}

/** Personal attention settings. Changing them never acknowledges messages. */
export interface ChatAttentionPreferences {
  notificationMode: "all" | "mentions" | "muted";
  followedThreadIds: ScoutId[];
  /** Private bookmarks; absent on older stored preferences. */
  savedMessageIds?: ScoutId[];
}

/** Set operations avoid overwriting another device's unrelated thread choice. */
export type ChatAttentionPreferenceChange =
  | { notificationMode: ChatAttentionPreferences["notificationMode"] }
  | { threadId: ScoutId; following: boolean }
  | { messageId: ScoutId; saved: boolean };

export function readChatAttentionPreferences(value: unknown): ChatAttentionPreferences {
  const record = value && typeof value === "object" ? value as Partial<ChatAttentionPreferences> : {};
  return {
    ...(Array.isArray(record.savedMessageIds) ? { savedMessageIds: [...new Set(record.savedMessageIds.filter((id): id is string => typeof id === "string" && id.length > 0))] } : {}),
    notificationMode: record.notificationMode === "mentions" || record.notificationMode === "muted" ? record.notificationMode : "all",
    followedThreadIds: Array.isArray(record.followedThreadIds)
      ? [...new Set(record.followedThreadIds.filter((id): id is string => typeof id === "string" && id.length > 0))] : [],
  };
}

export function applyChatAttentionPreferenceChange(current: unknown, change: unknown): ChatAttentionPreferences {
  const next = readChatAttentionPreferences(current);
  if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("Invalid attention preference change.");
  const input = change as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === "notificationMode"
    && (input.notificationMode === "all" || input.notificationMode === "mentions" || input.notificationMode === "muted")) {
    return { ...next, notificationMode: input.notificationMode };
  }
  if (keys.length === 2 && typeof input.threadId === "string" && input.threadId.trim() === input.threadId
    && input.threadId.length > 0 && input.threadId.length <= 256 && typeof input.following === "boolean") {
    const ids = new Set(next.followedThreadIds);
    if (input.following) ids.add(input.threadId); else ids.delete(input.threadId);
    if (ids.size > 500) throw new Error("Followed thread limit reached. Unfollow a thread before adding another.");
    return { ...next, followedThreadIds: [...ids] };
  }
  if (keys.length === 2 && typeof input.messageId === "string" && input.messageId.trim() === input.messageId
    && input.messageId.length > 0 && input.messageId.length <= 256 && typeof input.saved === "boolean") {
    const ids = new Set(next.savedMessageIds ?? []);
    if (input.saved) ids.add(input.messageId); else ids.delete(input.messageId);
    if (ids.size > 500) throw new Error("Saved message limit reached. Remove a saved message before adding another.");
    return { ...next, savedMessageIds: [...ids] };
  }
  throw new Error("Invalid attention preference change.");
}
