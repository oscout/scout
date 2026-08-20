/**
 * `Conversations` — the single, service-shaped entry point for conversation
 * identity operations across runtime and web (SCO-031 §5). Despite the
 * "repo" framing in the design doc, this is not a pure repository — methods
 * like `ensureByNaturalKey` carry domain logic, so it is named for what it is:
 * the conversations API on the store.
 *
 * Read methods reuse the host `SQLiteControlPlaneStore`'s connection handles
 * so we never open a third SQLite connection to the same database file.
 * Writes funnel through `store.upsertConversation` so transaction/WAL
 * coordination stays in one place.
 *
 * Chat/conversation identity is opaque. Semantic shapes such as direct-message
 * participants or channel names live in metadata `naturalKey`, never in `id`.
 */

import { randomUUID } from "node:crypto";

import type {
  ConversationDefinition,
  ConversationKind,
  MetadataMap,
  ScoutId,
  ShareMode,
  VisibilityScope,
} from "@openscout/protocol";
import {
  conversationNaturalKey,
  preferredConversationWithNaturalKey,
  directChannelNaturalKey,
  mintChannelId,
  stableChannelId,
} from "@openscout/protocol";

import type { SQLiteControlPlaneStore } from "../sqlite-store.js";
import type { ControlPlaneSqliteDatabase } from "../sqlite-adapter.js";

export interface EnsureConversationInput {
  naturalKey: string;
  kind: ConversationKind;
  title: string;
  visibility: VisibilityScope;
  shareMode: ShareMode;
  authorityNodeId: ScoutId;
  participantIds: ScoutId[];
  parentConversationId?: ScoutId;
  topic?: string;
  metadata?: MetadataMap;
}

export interface ConversationsApi {
  findById(id: ScoutId): ConversationDefinition | null;
  findByNaturalKey(key: string): ConversationDefinition | null;
  findByAgent(agentId: ScoutId): ConversationDefinition | null;
  findByParent(parentId: ScoutId): ConversationDefinition[];
  findByParticipants(participants: ScoutId[]): ConversationDefinition | null;
  ensureByNaturalKey(input: EnsureConversationInput): ConversationDefinition;
  upsert(c: ConversationDefinition): void;
  delete(id: ScoutId): void;
}

interface ConversationRow {
  id: string;
}

export class Conversations implements ConversationsApi {
  constructor(private readonly store: SQLiteControlPlaneStore) {}

  private get readDb(): ControlPlaneSqliteDatabase {
    return this.store.readerDb;
  }

  private get writeDb(): ControlPlaneSqliteDatabase {
    return this.store.writerDb;
  }

  findById(id: ScoutId): ConversationDefinition | null {
    return this.store.getConversation(id);
  }

  findByNaturalKey(key: string): ConversationDefinition | null {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return null;
    }
    const rows = this.readDb.query(
      "SELECT id FROM conversations ORDER BY created_at ASC",
    ).all() as ConversationRow[];
    const matches: ConversationDefinition[] = [];
    for (const row of rows) {
      const conversation = this.findById(row.id);
      if (
        conversation &&
        conversationNaturalKey(conversation) === normalizedKey
      ) {
        matches.push(conversation);
      }
    }
    return preferredConversationWithNaturalKey(matches, normalizedKey) ?? null;
  }

  findByAgent(agentId: ScoutId): ConversationDefinition | null {
    return this.findByNaturalKey(directChannelNaturalKey(["operator", agentId]));
  }

  findByParent(parentId: ScoutId): ConversationDefinition[] {
    const rows = this.readDb.query(
      "SELECT id FROM conversations WHERE parent_conversation_id = ?1 ORDER BY created_at ASC",
    ).all(parentId) as ConversationRow[];

    const conversations: ConversationDefinition[] = [];
    for (const row of rows) {
      const conversation = this.findById(row.id);
      if (conversation) {
        conversations.push(conversation);
      }
    }
    return conversations;
  }

  /**
   * Returns a conversation whose `conversation_members` set exactly matches
   * the given participant set, or `null` when no such row exists.
   *
   * In SCO-031 this only matches when the membership multiset is identical —
   * the dedup logic from `pickDirectConversationAgentId` / `shouldPreferSessionSummary`
   * stays in the session pickers because it is concerned with display
   * ordering rather than identity.
   */
  findByParticipants(participants: ScoutId[]): ConversationDefinition | null {
    const uniqueParticipants = Array.from(new Set(participants.filter(Boolean)));
    if (uniqueParticipants.length === 0) {
      return null;
    }

    const placeholders = uniqueParticipants.map(() => "?").join(", ");
    const rows = this.readDb.query(
      `SELECT cm.conversation_id AS id
       FROM conversation_members cm
       WHERE cm.actor_id IN (${placeholders})
       GROUP BY cm.conversation_id
       HAVING COUNT(DISTINCT cm.actor_id) = ?
          AND (
            SELECT COUNT(*) FROM conversation_members cm2
            WHERE cm2.conversation_id = cm.conversation_id
          ) = ?`,
    ).all(...uniqueParticipants, uniqueParticipants.length, uniqueParticipants.length) as ConversationRow[];

    if (rows.length === 0) {
      return null;
    }

    // Stable selection: oldest matching conversation by created_at.
    const orderedRows = this.readDb.query(
      `SELECT id FROM conversations
       WHERE id IN (${rows.map(() => "?").join(", ")})
       ORDER BY created_at ASC
       LIMIT 1`,
    ).all(...rows.map((r) => r.id)) as ConversationRow[];

    const winner = orderedRows[0] ?? rows[0];
    return winner ? this.findById(winner.id) : null;
  }

  ensureByNaturalKey(input: EnsureConversationInput): ConversationDefinition {
    const existing = this.findByNaturalKey(input.naturalKey);
    const stableId = input.naturalKey.startsWith("channel:")
      || input.naturalKey.startsWith("system:")
      ? stableChannelId(input.naturalKey)
      : null;
    if (existing && (!stableId || existing.id === stableId)) {
      return existing;
    }

    const conversation: ConversationDefinition = {
      id: stableId ?? mintChannelId(randomUUID),
      kind: input.kind,
      title: input.title,
      visibility: input.visibility,
      shareMode: input.shareMode,
      authorityNodeId: input.authorityNodeId,
      participantIds: [...new Set([
        ...(existing?.participantIds ?? []),
        ...input.participantIds,
      ])].sort(),
      parentConversationId: input.parentConversationId,
      topic: input.topic,
      metadata: {
        ...(input.metadata ?? {}),
        naturalKey: input.naturalKey,
      },
    };
    this.upsert(conversation);
    return conversation;
  }

  upsert(c: ConversationDefinition): void {
    this.store.upsertConversation(c);
  }

  delete(id: ScoutId): void {
    // Schema's `ON DELETE CASCADE` on conversation_members and `ON DELETE SET NULL`
    // on the other FK references handle cleanup (schema.ts:75, 96, 143, 262, 296, 332).
    this.writeDb.query("DELETE FROM conversations WHERE id = ?1").run(id);
  }

}
