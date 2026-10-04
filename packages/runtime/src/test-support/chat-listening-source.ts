// Legacy in-memory source fixture for accumulator persistence tests. NOT a production adapter.
import type { MessageRecord } from "@openscout/protocol";
export type ChatListeningFeed = {
  checkpoint(roomId: string): { epoch: string; seq: number };
  page(roomId: string, after: number, limit: number): { seq: number; message: MessageRecord; update: boolean }[];
  message(id: string): MessageRecord | undefined;
};
import type { ConversationDefinition } from "@openscout/protocol";
import { ChatListeningError, type ChatListeningSource, type ListeningMembership, type ListeningMessage } from "../broker-chat-listening.js";

export type ListeningGrant = { actorId: string; channelId: string; space: string; nodeId: string; expiresAt: number };

/** Resolve the actual root, not the immediate parent (projectFeed semantics).
 * Missing parents/cycles stay unknown rather than fabricating a reply handle. */
export function listeningThreadRoot(message: MessageRecord, messages: Map<string, MessageRecord>): string | null {
  let current = message;
  const visited = new Set<string>();
  while (current.replyToMessageId) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const parent = messages.get(current.replyToMessageId);
    if (!parent) return null;
    current = parent;
  }
  return current.id;
}

/** Incremental indexed change feed. Only at most 100 new rows and bounded
 * ancestry point-lookups; never enumerates history or the registry messages. */
export function createLocalChatListeningSource(options: {
  conversation: (id: string) => ConversationDefinition | undefined; nodeId: string;
  verify: (membership: ListeningMembership) => Promise<ListeningGrant>;
  feed: () => ChatListeningFeed;
}): ChatListeningSource {
  return { async read(membership, cursor, agentId) {
    const grant = await options.verify(membership);
    const validate = (value: ListeningGrant) => {
      if (value.nodeId !== options.nodeId || value.actorId !== membership.actorId || value.channelId !== membership.channelId
        || value.space !== membership.space || value.expiresAt <= Date.now()) throw new ChatListeningError("membership_denied");
    };
    validate(grant);
    const room = options.conversation(membership.channelId);
    if (!room || room.kind !== "channel" || room.authorityNodeId !== options.nodeId || !room.participantIds.includes(membership.actorId)) throw new ChatListeningError("membership_denied");
    const feed = options.feed(), high = feed.checkpoint(room.id);
    let after = high.seq;
    if (cursor !== null) {
      const decoded = JSON.parse(cursor);
      if (decoded.v === 1) throw new ChatListeningError("source_cursor_upgrade_required");
      if (decoded.v !== 2 || decoded.channel !== room.id || !Number.isSafeInteger(decoded.seq) || decoded.seq < 0) throw new ChatListeningError("source_cursor_invalid");
      if (decoded.epoch !== high.epoch || decoded.seq > high.seq) throw new ChatListeningError("source_history_changed");
      after = decoded.seq;
    }
    // Empty pass makes no page/body/ancestry queries, and no attention write.
    const rows = after === high.seq ? [] : feed.page(room.id, after, 100);
    const identities = new Set([membership.actorId, agentId]);
    const messages: ListeningMessage[] = [];
    const cache = new Map<string, MessageRecord | undefined>();
    let lookups = 0;
    const visible = (m: MessageRecord) => !m.audience?.visibleTo || m.audience.visibleTo.includes(membership.actorId) || m.actorId === membership.actorId;
    const parent = (id: string) => {
      if (!cache.has(id)) {
        if (++lookups > 256) return undefined;
        const found = feed.message(id);
        const conversation = found && options.conversation(found.conversationId);
        cache.set(id, found && visible(found) && (found.conversationId === room.id || conversation?.parentConversationId === room.id) ? found : undefined);
      }
      return cache.get(id);
    };
    for (const row of rows) {
      const m = row.message;
      if (!visible(m)) continue;
      const conversation = options.conversation(m.conversationId);
      const replyToMessageId = m.replyToMessageId ?? (conversation?.kind === "thread" ? conversation.messageId : undefined);
      const direct = replyToMessageId ? parent(replyToMessageId) : undefined;
      let current = { ...m, replyToMessageId }, root: string | null = m.id;
      const visited = new Set<string>();
      while (current.replyToMessageId) {
        if (visited.has(current.id) || visited.size >= 32) { root = null; break; }
        visited.add(current.id);
        const next = parent(current.replyToMessageId);
        if (!next) { root = null; break; }
        current = { ...next, replyToMessageId: next.replyToMessageId ?? options.conversation(next.conversationId)?.messageId };
        root = current.id;
      }
      messages.push({ id: m.id, actorId: m.actorId, body: m.body, createdAt: m.createdAt, replyToMessageId,
        threadRootId: root, update: row.update,
        relevance: identities.has(m.actorId) ? null : m.mentions?.some(mention => identities.has(mention.actorId)) ? "mention"
          : direct && identities.has(direct.actorId) ? "direct-reply" : null });
    }
    if (rows.length) validate(await options.verify(membership));
    return { cursor: JSON.stringify({ v: 2, channel: room.id, epoch: high.epoch, seq: rows.at(-1)?.seq ?? after }), messages, expiresAt: grant.expiresAt };
  } };
}
