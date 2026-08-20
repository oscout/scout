/**
 * Session-cluster reads (all `ConversationDefinition` kinds reshaped for the
 * mobile/iOS surface, plus the canonical `ConversationDefinition` row
 * projection).
 *
 * Extracted from `db-queries.ts` as SCO-031 Phase C's last extraction. The
 * queries here intentionally stay on direct SQL through `db()` — they do
 * **not** route through `Conversations` yet. SCO-030 will fold the
 * `queryConversationDefinitionById` path into `repo.findById` once opaque ids
 * land; the picker helpers below are display-ordering logic that may stay
 * here regardless.
 */
import { db } from "./internal/db.ts";
import {
  channelNaturalKeyFromMetadata,
  isOpaqueChannelId,
} from "@openscout/protocol";
import {
  configuredOperatorActorIds,
  isLikelyLocalSessionAgentId,
} from "./internal/conversation-ids.ts";
import { compact, resolveHarnessLogPath, resolveHarnessSessionId } from "./internal/paths.ts";
import {
  LATEST_AGENT_ENDPOINT_JOIN,
  sqlTimestampMsExpression,
  transientBrokerWorkingStatusPredicate,
} from "./internal/sql-helpers.ts";
import type { MobileSessionSummary } from "./types/mobile.ts";

export { isLikelyLocalSessionAgentId };

export function pickDirectConversationAgentId(
  participants: string[],
  candidateAgentIds: string[],
): string | null {
  const uniqueAgentIds = Array.from(new Set(candidateAgentIds.filter(Boolean)));
  if (uniqueAgentIds.length === 0) {
    return null;
  }
  if (uniqueAgentIds.length === 1) {
    return uniqueAgentIds[0] ?? null;
  }

  const operatorActorIds = new Set(configuredOperatorActorIds());
  const nonOperatorAgentIds = uniqueAgentIds.filter((agentId) => !operatorActorIds.has(agentId));

  if (nonOperatorAgentIds.length === 1) {
    return nonOperatorAgentIds[0] ?? null;
  }

  const localSessionCandidate = nonOperatorAgentIds.find(isLikelyLocalSessionAgentId)
    ?? uniqueAgentIds.find(isLikelyLocalSessionAgentId);
  if (localSessionCandidate) {
    return localSessionCandidate;
  }

  if (participants.length === 2) {
    const orderedAgentIds = participants.filter((participantId) => uniqueAgentIds.includes(participantId));
    if (orderedAgentIds.length > 0) {
      return orderedAgentIds[0] ?? null;
    }
  }

  return nonOperatorAgentIds[0] ?? uniqueAgentIds[0] ?? null;
}

export function shouldPreferSessionSummary(
  candidate: MobileSessionSummary,
  existing: MobileSessionSummary,
  _agentId: string,
): boolean {
  const candidateLastAt = candidate.lastMessageAt ?? 0;
  const existingLastAt = existing.lastMessageAt ?? 0;
  if (candidateLastAt !== existingLastAt) {
    return candidateLastAt > existingLastAt;
  }

  if (candidate.messageCount !== existing.messageCount) {
    return candidate.messageCount > existing.messageCount;
  }

  return candidate.id < existing.id;
}

export function queryConversationDefinitionById(
  conversationId: string,
): {
  id: string;
  kind: string;
  title: string;
  visibility: string;
  shareMode: string;
  authorityNodeId: string;
  topic: string | null;
  parentConversationId: string | null;
  messageId: string | null;
  metadata: Record<string, unknown>;
  participantIds: string[];
} | null {
  if (!isOpaqueChannelId(conversationId)) return null;
  const row = db().prepare(
    `SELECT id, kind, title, visibility, share_mode, authority_node_id,
            topic, parent_conversation_id, message_id, metadata_json
     FROM conversations WHERE id = ?`,
  ).get(conversationId) as {
    id: string;
    kind: string;
    title: string;
    visibility: string;
    share_mode: string;
    authority_node_id: string;
    topic: string | null;
    parent_conversation_id: string | null;
    message_id: string | null;
    metadata_json: string | null;
  } | null;
  if (!row) return null;
  const participants = (db().prepare(
    `SELECT actor_id FROM conversation_members WHERE conversation_id = ?`,
  ).all(conversationId) as Array<{ actor_id: string }>).map((m) => m.actor_id);
  let metadata: Record<string, unknown> = {};
  if (row.metadata_json) {
    try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch {}
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    visibility: row.visibility,
    shareMode: row.share_mode,
    authorityNodeId: row.authority_node_id,
    topic: row.topic,
    parentConversationId: row.parent_conversation_id,
    messageId: row.message_id,
    metadata,
    participantIds: participants,
  };
}

type SessionConversationRow = {
  id: string;
  kind: string;
  title: string;
  metadata_json: string | null;
  message_count: number;
  last_message_at: number | null;
};

function parseMetadataJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatChannelAlias(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function conversationAliasForRow(
  row: Pick<SessionConversationRow, "id" | "kind" | "title">,
  metadata: Record<string, unknown>,
): string | null {
  const explicitAlias = metadataString(metadata, "alias");
  if (explicitAlias) return explicitAlias;

  const channel = metadataString(metadata, "channel");
  if (channel && channel !== "system") {
    return formatChannelAlias(channel);
  }

  if (row.kind === "channel") {
    return formatChannelAlias(row.title);
  }

  return null;
}

function conversationIdentityFields(
  row: Pick<SessionConversationRow, "id" | "kind" | "title">,
  metadata: Record<string, unknown>,
): Partial<MobileSessionSummary> {
  const alias = conversationAliasForRow(row, metadata);
  const naturalKey = channelNaturalKeyFromMetadata(metadata);
  return {
    ...(alias ? { alias } : {}),
    ...(naturalKey ? { naturalKey } : {}),
  };
}

function projectSessionConversationRows(
  rows: SessionConversationRow[],
  opts?: {
    dedupeLocalSessionDirects?: boolean;
    limit?: number;
  },
): MobileSessionSummary[] {
  const dedupeLocalSessionDirects = opts?.dedupeLocalSessionDirects ?? false;
  const messageCreatedAtExpression = sqlTimestampMsExpression("created_at");
  const memberStmt = db().prepare(
    `SELECT actor_id FROM conversation_members WHERE conversation_id = ?`,
  );
  const agentMemberStmt = db().prepare(
    `SELECT
       a.id AS agent_id,
       ac.display_name,
       ep.harness,
       ep.transport,
       ep.project_root,
       ep.session_id,
       ep.metadata_json AS endpoint_metadata_json,
       a.metadata_json
     FROM conversation_members cm
     JOIN agents a ON a.id = cm.actor_id
     JOIN actors ac ON ac.id = a.id
     ${LATEST_AGENT_ENDPOINT_JOIN}
     WHERE cm.conversation_id = ?`,
  );
  const previewStmt = db().prepare(
    `SELECT body
     FROM messages m
     WHERE conversation_id = ?
       AND ${transientBrokerWorkingStatusPredicate("m")}
     ORDER BY ${messageCreatedAtExpression} DESC
     LIMIT 1`,
  );

  const summaries = rows.flatMap((r) => {
    const conversationMetadata = parseMetadataJson(r.metadata_json);
    const participants = (memberStmt.all(r.id) as Array<{ actor_id: string }>)
      .map((m) => m.actor_id);
    const agentParticipants = agentMemberStmt.all(r.id) as Array<{
      agent_id: string;
      display_name: string;
      harness: string | null;
      transport: string | null;
      project_root: string | null;
      session_id: string | null;
      endpoint_metadata_json: string | null;
      metadata_json: string | null;
    }>;
    const primaryAgentId = r.kind === "direct"
      ? pickDirectConversationAgentId(participants, agentParticipants.map((entry) => entry.agent_id))
      : (agentParticipants.length === 1 ? agentParticipants[0]?.agent_id ?? null : null);
    const primaryAgent = primaryAgentId
      ? agentParticipants.find((entry) => entry.agent_id === primaryAgentId) ?? null
      : null;
    const agentId = primaryAgent?.agent_id ?? null;

    let agentName: string | null = null;
    let harness: string | null = null;
    let harnessSessionId: string | null = null;
    let harnessLogPath: string | null = null;
    let branch: string | null = null;
    let workspaceRoot: string | null = null;

    if (primaryAgent) {
      agentName = primaryAgent.display_name;
      harness = primaryAgent.harness;
      workspaceRoot = compact(primaryAgent.project_root);
      try {
        const meta = primaryAgent.metadata_json ? JSON.parse(primaryAgent.metadata_json) : {};
        if ((meta.retiredFromFleet as boolean | undefined) === true) {
          return [];
        }
        branch = (meta.branch as string) ?? (meta.workspaceQualifier as string) ?? null;
      } catch {}
      try {
        const endpointMeta = primaryAgent.endpoint_metadata_json
          ? JSON.parse(primaryAgent.endpoint_metadata_json)
          : {};
        harnessSessionId = resolveHarnessSessionId(
          primaryAgent.transport,
          primaryAgent.session_id,
          endpointMeta,
        );
        harnessLogPath = resolveHarnessLogPath(
          primaryAgent.agent_id,
          primaryAgent.transport,
          primaryAgent.session_id,
          endpointMeta,
        );
      } catch {
        harnessSessionId = resolveHarnessSessionId(
          primaryAgent.transport,
          primaryAgent.session_id,
          undefined,
        );
        harnessLogPath = resolveHarnessLogPath(
          primaryAgent.agent_id,
          primaryAgent.transport,
          primaryAgent.session_id,
          undefined,
        );
      }
    }

    const preview = (previewStmt.get(r.id) as { body: string } | null)?.body ?? null;
    const identityFields = conversationIdentityFields(r, conversationMetadata);

    return [{
      id: r.id,
      kind: r.kind,
      title: agentName ?? r.title,
      ...identityFields,
      participantIds: participants,
      agentId,
      agentName,
      harness,
      harnessSessionId,
      harnessLogPath,
      currentBranch: branch,
      preview: preview ? preview.slice(0, 200) : null,
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at,
      workspaceRoot,
    }];
  });

  if (!dedupeLocalSessionDirects) {
    return summaries.sort((left, right) => {
      const leftTs = left.lastMessageAt ?? 0;
      const rightTs = right.lastMessageAt ?? 0;
      if (rightTs !== leftTs) {
        return rightTs - leftTs;
      }
      return right.messageCount - left.messageCount;
    }).slice(0, opts?.limit ?? summaries.length);
  }

  const deduped = new Map<string, MobileSessionSummary>();

  for (const summary of summaries) {
    if (
      summary.kind !== "direct"
      || !summary.agentId
      || !isLikelyLocalSessionAgentId(summary.agentId)
    ) {
      deduped.set(`id:${summary.id}`, summary);
      continue;
    }

    const key = `local-session-direct:${summary.agentId}`;
    const current = deduped.get(key);
    if (!current || shouldPreferSessionSummary(summary, current, summary.agentId)) {
      deduped.set(key, summary);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    const leftTs = left.lastMessageAt ?? 0;
    const rightTs = right.lastMessageAt ?? 0;
    if (rightTs !== leftTs) {
      return rightTs - leftTs;
    }
    return right.messageCount - left.messageCount;
  }).slice(0, opts?.limit ?? deduped.size);
}

export function querySessions(limit = 80): MobileSessionSummary[] {
  const messageCreatedAtExpression = sqlTimestampMsExpression("created_at");
  const conversationCreatedAtExpression = sqlTimestampMsExpression("c.created_at");
  const rows = db().prepare(
    `SELECT
       c.id,
       c.kind,
       c.title,
       c.metadata_json,
       COALESCE(ms.message_count, 0) AS message_count,
       ms.last_message_at
     FROM conversations c
     LEFT JOIN (
       SELECT conversation_id, COUNT(*) AS message_count, MAX(${messageCreatedAtExpression}) AS last_message_at
       FROM messages
       GROUP BY conversation_id
     ) ms ON ms.conversation_id = c.id
     WHERE c.id LIKE 'c.%' AND length(c.id) > 2
     ORDER BY COALESCE(ms.last_message_at, ${conversationCreatedAtExpression}, 0) DESC, ${conversationCreatedAtExpression} DESC, c.id ASC
     LIMIT ?`,
  ).all(limit) as SessionConversationRow[];

  return projectSessionConversationRows(rows, {
    dedupeLocalSessionDirects: true,
    limit,
  });
}

function querySessionFallbackFromMessages(conversationId: string): MobileSessionSummary | null {
  const messageCreatedAtExpression = sqlTimestampMsExpression("created_at");
  const stats = db().prepare(
    `SELECT
       COUNT(*) AS message_count,
       MAX(${messageCreatedAtExpression}) AS last_message_at
     FROM messages
     WHERE conversation_id = ?`,
  ).get(conversationId) as { message_count: number; last_message_at: number | null } | null;
  if (!stats || stats.message_count <= 0) {
    return null;
  }

  const previewRow = db().prepare(
    `SELECT body
     FROM messages m
     WHERE conversation_id = ?
       AND ${transientBrokerWorkingStatusPredicate("m")}
     ORDER BY ${messageCreatedAtExpression} DESC
     LIMIT 1`,
  ).get(conversationId) as { body: string | null } | null;

  const agentRow = db().prepare(
    `SELECT
       m.actor_id AS agent_id,
       ac.display_name,
       ep.harness,
       ep.project_root,
       ep.session_id,
       ep.metadata_json AS endpoint_metadata_json
     FROM messages m
     JOIN agents a ON a.id = m.actor_id
     JOIN actors ac ON ac.id = a.id
     ${LATEST_AGENT_ENDPOINT_JOIN}
     WHERE m.conversation_id = ?
       AND m.actor_id != 'operator'
     ORDER BY ${messageCreatedAtExpression} DESC
     LIMIT 1`,
  ).get(conversationId) as {
    agent_id: string;
    display_name: string;
    harness: string | null;
    project_root: string | null;
    session_id: string | null;
    endpoint_metadata_json: string | null;
  } | null;

  const endpointMetadata = parseMetadataJson(agentRow?.endpoint_metadata_json);
  const title = agentRow?.display_name?.trim() || conversationId;

  return {
    id: conversationId,
    kind: "direct",
    title,
    participantIds: ["operator", ...(agentRow?.agent_id ? [agentRow.agent_id] : [])],
    agentId: agentRow?.agent_id ?? null,
    agentName: agentRow?.display_name ?? null,
    harness: agentRow?.harness ?? null,
    harnessSessionId: resolveHarnessSessionId(agentRow?.session_id, endpointMetadata),
    harnessLogPath: agentRow?.agent_id
      ? resolveHarnessLogPath(agentRow.agent_id, agentRow.harness, agentRow.session_id, endpointMetadata)
      : null,
    currentBranch: metadataString(endpointMetadata, "branch"),
    preview: previewRow?.body?.trim() || null,
    messageCount: stats.message_count,
    lastMessageAt: stats.last_message_at,
    workspaceRoot: agentRow?.project_root ?? null,
  };
}

export function querySessionById(conversationId: string): MobileSessionSummary | null {
  if (!isOpaqueChannelId(conversationId)) {
    return null;
  }
  const messageCreatedAtExpression = sqlTimestampMsExpression("created_at");
  const readRow = (id: string) => db().prepare(
    `SELECT
       c.id,
       c.kind,
       c.title,
       c.metadata_json,
       COALESCE(ms.message_count, 0) AS message_count,
       ms.last_message_at
     FROM conversations c
     LEFT JOIN (
       SELECT conversation_id, COUNT(*) AS message_count, MAX(${messageCreatedAtExpression}) AS last_message_at
       FROM messages
       WHERE conversation_id = ?
       GROUP BY conversation_id
     ) ms ON ms.conversation_id = c.id
     WHERE c.id = ?
     LIMIT 1`,
  ).get(id, id) as SessionConversationRow | null;
  const row = readRow(conversationId);
  const existing = row
    ? projectSessionConversationRows([row], { dedupeLocalSessionDirects: false, limit: 1 })[0] ?? null
    : null;
  if (existing) {
    return existing;
  }

  return querySessionFallbackFromMessages(conversationId);
}
