import type { ChatReadLane, ChatReadState, ConversationReadCursor, MessageMention } from "@openscout/protocol";

export interface ChatReadMessage {
  id: string;
  actorId: string;
  createdAt: number;
  class?: string;
  mentions?: MessageMention[];
}

/** The broker writes this boundary from the resolved message, never from a
 * caller's claimed timestamp. It remains useful when the anchor leaves a page.
 */
export function chatReadBoundary(cursor: ConversationReadCursor | undefined, messages: ChatReadMessage[]) {
  if (!cursor?.lastReadMessageId) return null;
  const anchor = messages.find((message) => message.id === cursor.lastReadMessageId);
  if (anchor) return { id: anchor.id, createdAt: anchor.createdAt };
  const value = cursor.metadata?.scoutReadBoundary as { id?: unknown; createdAt?: unknown } | undefined;
  return value?.id === cursor.lastReadMessageId && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    ? { id: value.id as string, createdAt: value.createdAt }
    : null;
}

export function projectChatReadLane(input: {
  actorId: string;
  rootMessageId: string | null;
  messages: ChatReadMessage[];
  cursor?: ConversationReadCursor;
  pageLimit: number;
}): ChatReadLane {
  const messages = [...input.messages].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const boundary = chatReadBoundary(input.cursor, messages);
  // A legacy cursor whose anchor is outside this page has an unknown boundary.
  // Never use acknowledgement time as message time: messages may arrive between
  // the displayed message and the acknowledgement. State the incomplete read.
  const unknownBoundary = Boolean(input.cursor?.lastReadMessageId && !boundary);
  const unread = unknownBoundary ? [] : messages.filter((message) =>
    message.actorId !== input.actorId && message.class !== "status" && message.class !== "log"
    && (!boundary || message.createdAt > boundary.createdAt || (message.createdAt === boundary.createdAt && message.id > boundary.id)));
  const oldest = messages[0];
  const boundaryBeforePage = !boundary || (oldest && (boundary.createdAt < oldest.createdAt
    || (boundary.createdAt === oldest.createdAt && boundary.id < oldest.id)));
  return {
    rootMessageId: input.rootMessageId,
    lastReadMessageId: input.cursor?.lastReadMessageId ?? null,
    latestMessageId: messages.at(-1)?.id ?? null,
    unreadMessageIds: unread.map((message) => message.id),
    mentionMessageIds: unread.filter((message) => message.mentions?.some((mention) => mention.actorId === input.actorId)).map((message) => message.id),
    incomplete: unknownBoundary || Boolean(messages.length >= input.pageLimit && boundaryBeforePage),
  };
}

export function summarizeChatReadState(state: ChatReadState) {
  return {
    unread: state.lanes.reduce((count, lane) => count + lane.unreadMessageIds.length, 0),
    mentions: state.lanes.reduce((count, lane) => count + lane.mentionMessageIds.length, 0),
    replies: state.lanes.filter((lane) => lane.rootMessageId !== null).reduce((count, lane) => count + lane.unreadMessageIds.length, 0),
    incomplete: state.lanes.some((lane) => lane.incomplete),
  };
}
