/**
 * Web-shaped message reads from the control-plane conversations log.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. Conversation-ID
 * aliasing is delegated to `internal/conversation-ids.ts`.
 */

import { db } from "./internal/db.ts";
import { conversationIdAliases } from "./internal/conversation-ids.ts";
import { isOpaqueChannelId } from "@openscout/protocol";
import {
  sqlJoinClauses,
  sqlPlaceholders,
  sqlTimestampMsExpression,
  transientBrokerWorkingStatusPredicate,
} from "./internal/sql-helpers.ts";
import {
  MessageCursorError,
  clampMessagePageLimit,
  parseMessageHistoryCursor,
  type MessageOrderKey,
} from "../../shared/message-pagination.ts";
import type { WebMessage } from "./types/web.ts";

type ThreadSummary = NonNullable<WebMessage["threadSummary"]>;

export function queryRecentMessages(
  limit = 80,
  opts?: { conversationId?: string; beforeMessageId?: string },
): WebMessage[] {
  if (opts?.conversationId && !isOpaqueChannelId(opts.conversationId)) {
    return [];
  }
  const conversationIds = opts?.conversationId ? conversationIdAliases(opts.conversationId) : [];
  const messageCreatedAtExpression = sqlTimestampMsExpression("m.created_at");
  const pageLimit = clampMessagePageLimit(limit);
  const beforeMessage = resolveBeforeMessage(
    opts?.beforeMessageId,
    conversationIds,
    messageCreatedAtExpression,
  );
  const where = sqlJoinClauses([
    transientBrokerWorkingStatusPredicate("m"),
    conversationIds.length > 0
      ? `m.conversation_id IN (${sqlPlaceholders(conversationIds.length)})`
      : "m.conversation_id LIKE 'c.%' AND length(m.conversation_id) > 2",
    beforeMessage
      ? `(
          ${messageCreatedAtExpression} < ?
          OR (${messageCreatedAtExpression} = ? AND m.id < ?)
        )`
      : null,
  ]);
  const beforeParams = beforeMessage
    ? [beforeMessage.createdAt, beforeMessage.createdAt, beforeMessage.id]
    : [];

  const rows = db()
    .prepare(
      `SELECT
         m.id,
         m.conversation_id,
         m.actor_id,
         ac.display_name AS actor_name,
         m.body,
         ${messageCreatedAtExpression} AS created_at,
         m.class,
         m.metadata_json,
         m.reply_to_message_id,
         m.thread_conversation_id
       FROM messages m
       JOIN actors ac ON ac.id = m.actor_id
       WHERE ${where}
       ORDER BY ${messageCreatedAtExpression} DESC, m.id DESC
       LIMIT ?`,
    )
    .all(...conversationIds, ...beforeParams, pageLimit) as Array<{
    id: string;
    conversation_id: string;
    actor_id: string;
    actor_name: string;
    body: string;
    created_at: number;
    class: string;
    metadata_json: string | null;
    reply_to_message_id: string | null;
    thread_conversation_id: string | null;
  }>;

  const messages = rows.map((r) => {
    let metadata: Record<string, unknown> | null = null;
    if (r.metadata_json) {
      try { metadata = JSON.parse(r.metadata_json); } catch { metadata = null; }
    }
    return {
      id: r.id,
      conversationId: r.conversation_id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      body: r.body,
      createdAt: r.created_at,
      class: r.class,
      metadata,
      replyToMessageId: r.reply_to_message_id,
      threadConversationId: r.thread_conversation_id,
    };
  });
  return attachThreadSummaries(messages);
}

/// Turn a `beforeMessageId` query value into the transcript position to page
/// back from. A composite cursor carries that position, so a page still lands
/// correctly after its anchor message is deleted; only the legacy bare-id form
/// needs a lookup, and a lookup that misses is reported rather than silently
/// answered with an empty page.
function resolveBeforeMessage(
  beforeMessageId: string | undefined,
  conversationIds: string[],
  messageCreatedAtExpression: string,
): MessageOrderKey | null {
  const cursor = parseMessageHistoryCursor(beforeMessageId);
  if (!cursor) return null;
  if (cursor.kind === "position") {
    return { createdAt: cursor.createdAt, id: cursor.id };
  }

  const conversationClause = conversationIds.length > 0
    ? ` AND m.conversation_id IN (${sqlPlaceholders(conversationIds.length)})`
    : "";
  const anchor = db()
    .prepare(
      `SELECT
         m.id,
         ${messageCreatedAtExpression} AS created_at
       FROM messages m
       WHERE m.id = ?${conversationClause}
       LIMIT 1`,
    )
    .get(cursor.id, ...conversationIds) as {
      id: string;
      created_at: number | null;
    } | null;
  if (!anchor) {
    throw new MessageCursorError("unknown", cursor.id);
  }
  return { createdAt: anchor.created_at ?? 0, id: anchor.id };
}

function attachThreadSummaries(messages: WebMessage[]): WebMessage[] {
  if (messages.length === 0) return messages;

  // Exact (parentConversationId, anchorMessageId) pairs only — avoid the
  // cross-product of parent IDs × message IDs that can attach the wrong stub.
  const anchors = Array.from(
    new Map(
      messages.map((message) => [
        `${message.conversationId}\u0000${message.id}`,
        { parentConversationId: message.conversationId, messageId: message.id },
      ] as const),
    ).values(),
  );
  if (anchors.length === 0) return messages;

  const pairClause = anchors
    .map(() => "(c.parent_conversation_id = ? AND c.message_id = ?)")
    .join(" OR ");
  const pairParams = anchors.flatMap((anchor) => [
    anchor.parentConversationId,
    anchor.messageId,
  ]);
  const messageCreatedAtExpression = sqlTimestampMsExpression("m.created_at");
  const conversationCreatedAtExpression = sqlTimestampMsExpression("c.created_at");
  const summaryRows = db().prepare(
    `SELECT
       c.parent_conversation_id,
       c.message_id,
       COUNT(m.id) AS message_count,
       MAX(COALESCE(${messageCreatedAtExpression}, ${conversationCreatedAtExpression})) AS last_active_at
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE ${pairClause}
     GROUP BY c.parent_conversation_id, c.message_id`,
  ).all(...pairParams) as Array<{
    parent_conversation_id: string;
    message_id: string;
    message_count: number;
    last_active_at: number | null;
  }>;

  if (summaryRows.length === 0) return messages;

  const participantRows = db().prepare(
    `SELECT DISTINCT
       c.parent_conversation_id,
       c.message_id,
       COALESCE(NULLIF(a.handle, ''), NULLIF(a.display_name, ''), cm.actor_id) AS label
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     LEFT JOIN actors a ON a.id = cm.actor_id
     WHERE ${pairClause}
     ORDER BY label COLLATE NOCASE ASC`,
  ).all(...pairParams) as Array<{
    parent_conversation_id: string;
    message_id: string;
    label: string | null;
  }>;

  const participantsByAnchor = new Map<string, string[]>();
  for (const row of participantRows) {
    const label = row.label?.trim();
    if (!label) continue;
    const key = `${row.parent_conversation_id}\u0000${row.message_id}`;
    const current = participantsByAnchor.get(key) ?? [];
    if (!current.some((value) => value.localeCompare(label, undefined, { sensitivity: "accent" }) === 0)) {
      current.push(label);
    }
    participantsByAnchor.set(key, current);
  }

  const summaryByAnchor = new Map<string, ThreadSummary>();
  for (const row of summaryRows) {
    const key = `${row.parent_conversation_id}\u0000${row.message_id}`;
    summaryByAnchor.set(key, {
      count: row.message_count,
      participants: participantsByAnchor.get(key) ?? [],
      lastActiveAt: row.last_active_at ?? Date.now(),
    });
  }

  return messages.map((message) => {
    const summary = summaryByAnchor.get(`${message.conversationId}\u0000${message.id}`);
    return summary ? { ...message, threadSummary: summary } : message;
  });
}
