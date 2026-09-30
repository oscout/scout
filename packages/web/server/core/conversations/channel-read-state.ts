import { readChatAttentionPreferences, readChatPins } from "@openscout/protocol";
import type { ChatReadState, ConversationDefinition, ConversationReadCursor } from "@openscout/protocol";
import { projectChatReadLane, type ChatReadMessage } from "../../../shared/chat-read-state.ts";

export const CHAT_ATTENTION_PAGE_LIMIT = 500;
export class ChatReadPositionError extends Error {}

export interface ChannelReadDependencies {
  loadMessages(conversationId: string, limit: number): Promise<ChatReadMessage[]>;
  loadCursors(conversationId: string): Promise<ConversationReadCursor[]>;
  markRead(conversationId: string, actorId: string, messageId: string): Promise<unknown>;
}

export function chatReadConversations(channelId: string, conversations: ConversationDefinition[]) {
  return [
    { id: channelId, rootMessageId: null as string | null },
    ...conversations.filter((item) => item.kind === "thread" && item.parentConversationId === channelId && item.messageId)
      .map((item) => ({ id: item.id, rootMessageId: item.messageId! })),
  ];
}

export async function readChatChannelState(input: {
  channelId: string;
  actorId: string;
  conversations: ConversationDefinition[];
  dependencies: ChannelReadDependencies;
}): Promise<ChatReadState> {
  const rootCursors = input.dependencies.loadCursors(input.channelId);
  const lanes = await Promise.all(chatReadConversations(input.channelId, input.conversations).map(async (conversation) => {
    const [messages, cursors] = await Promise.all([
      input.dependencies.loadMessages(conversation.id, CHAT_ATTENTION_PAGE_LIMIT),
      conversation.id === input.channelId ? rootCursors : input.dependencies.loadCursors(conversation.id),
    ]);
    return projectChatReadLane({
      actorId: input.actorId,
      rootMessageId: conversation.rootMessageId,
      messages,
      cursor: cursors.find((cursor) => cursor.actorId === input.actorId),
      pageLimit: CHAT_ATTENTION_PAGE_LIMIT,
    });
  }));
  const cursors = await rootCursors;
  const preferences = readChatAttentionPreferences(cursors.find(cursor => cursor.actorId === input.actorId)?.metadata?.chatAttention);
  return { channelId: input.channelId, actorId: input.actorId, lanes, preferences, pins: readChatPins(input.conversations.find(item => item.id === input.channelId)?.metadata?.chatPins) };
}

/** The route supplies authenticated actor identity and a freshly authorized
 * room. No actor, timestamp, conversation or sequence is accepted from clients.
 */
export async function markChatChannelRead(input: {
  channelId: string;
  actorId: string;
  rootMessageId: string | null;
  messageId: string;
  conversations: ConversationDefinition[];
  dependencies: ChannelReadDependencies;
}) {
  const conversation = chatReadConversations(input.channelId, input.conversations)
    .find((item) => item.rootMessageId === input.rootMessageId);
  if (!conversation) throw new ChatReadPositionError("Thread does not belong to this channel.");
  const messages = await input.dependencies.loadMessages(conversation.id, CHAT_ATTENTION_PAGE_LIMIT);
  if (!messages.some((message) => message.id === input.messageId)) {
    throw new ChatReadPositionError("Read position is not in this conversation's current message page.");
  }
  await input.dependencies.markRead(conversation.id, input.actorId, input.messageId);
}
