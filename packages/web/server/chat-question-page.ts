import { chatQuestionActions } from "./chat-request-responsibility.ts";
import type { ConversationDefinition, CollaborationRecord } from "@openscout/protocol";

export function decodeChatQuestionCursor(cursor: string | null | undefined, channelId: string, history = false): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.channelId !== channelId || Boolean(value.history) !== history || !Number.isSafeInteger(value.createdAt) || typeof value.id !== "string" || !value.id) throw new Error();
    return value;
  } catch { throw new Error("Invalid question cursor."); }
}

export function chatQuestionPage(records: CollaborationRecord[], channelId: string, threadIds: ReadonlySet<string>, cursor?: string | null, limit = 50, history = false) {
  const after = decodeChatQuestionCursor(cursor, channelId, history);
  const rows = records.filter(record => record.kind === "question" && (history ? record.state === "closed" || record.state === "declined" : record.state === "open" || record.state === "answered")
    && (record.conversationId === channelId || Boolean(record.conversationId && threadIds.has(record.conversationId)))
    && (!after || record.createdAt > after.createdAt || (record.createdAt === after.createdAt && record.id > after.id)))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return { records: selected, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ channelId, ...(history ? { history: true } : {}), createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
}


export function chatQuestionAttentionCounts(records: CollaborationRecord[], conversations: Record<string, ConversationDefinition>, visibleChannelIds: ReadonlySet<string>, actorId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    if (!record.conversationId || !chatQuestionActions(record, actorId).length) continue;
    const conversation = conversations[record.conversationId];
    const channelId = conversation?.kind === "thread" ? conversation.parentConversationId : record.conversationId;
    if (channelId && visibleChannelIds.has(channelId)) counts[channelId] = (counts[channelId] ?? 0) + 1;
  }
  return counts;
}
