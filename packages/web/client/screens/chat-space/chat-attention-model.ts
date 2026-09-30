import { readChatAttentionPreferences, type ChatReadState } from "@openscout/protocol";

/** Notification choices filter attention, never rewrite read history. */
export function attentionMessageCount(state: ChatReadState): number {
  const preferences = readChatAttentionPreferences(state.preferences);
  if (preferences.notificationMode === "muted") return 0;
  return state.lanes.reduce((count, lane) => count + (preferences.notificationMode === "all"
    || (lane.rootMessageId !== null && preferences.followedThreadIds.includes(lane.rootMessageId))
    ? lane.unreadMessageIds.length : lane.mentionMessageIds.length), 0);
}

/**
 * Thread lanes the viewer has effectively seen by looking at the channel: the
 * root is on screen and only its reply count moved. A lane holding a mention
 * of the viewer stays unread — that is a notification, not ambient traffic —
 * and so does `excludeRootId` (the open thread reads itself as it scrolls).
 */
export function viewedThreadReads(state: ChatReadState | undefined, visibleRootIds: readonly string[], excludeRootId: string | null = null): { rootMessageId: string; messageId: string }[] {
  if (!state) return [];
  const visible = new Set(visibleRootIds);
  return state.lanes.flatMap(lane => lane.rootMessageId && lane.rootMessageId !== excludeRootId && visible.has(lane.rootMessageId)
    && lane.latestMessageId && lane.unreadMessageIds.length && !lane.mentionMessageIds.length && lane.lastReadMessageId !== lane.latestMessageId
    ? [{ rootMessageId: lane.rootMessageId, messageId: lane.latestMessageId }] : []);
}
