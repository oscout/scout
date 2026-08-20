/**
 * Mobile-shaped session listing for direct conversations.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. Note that this is
 * a different surface from `querySessions` (which stays in db-queries.ts
 * with the broader session/identity cluster) — this one is iOS-specific,
 * filters to direct conversations, and uses a simpler operator-as-string
 * heuristic rather than the configurable operator-actor cluster.
 */

import { db } from "../internal/db.ts";
import { compact, resolveHarnessLogPath, resolveHarnessSessionId } from "../internal/paths.ts";
import {
  LATEST_AGENT_ENDPOINT_JOIN,
  sqlTimestampMsExpression,
  transientBrokerWorkingStatusPredicate,
} from "../internal/sql-helpers.ts";
import type { MobileSessionSummary } from "../types/mobile.ts";

export function queryMobileSessions(limit = 50): MobileSessionSummary[] {
  const conversationCreatedAtExpression = sqlTimestampMsExpression("c.created_at");
  const messageCreatedAtExpression = sqlTimestampMsExpression("created_at");
  const previewMessageCreatedAtExpression = sqlTimestampMsExpression("m.created_at");
  const rows = db().prepare(
    `SELECT
       c.id,
       c.kind,
       c.title,
       c.metadata_json
     FROM conversations c
     WHERE c.kind = 'direct'
     ORDER BY ${conversationCreatedAtExpression} DESC
     LIMIT ?`,
  ).all(limit) as Array<{
    id: string;
    kind: string;
    title: string;
    metadata_json: string | null;
  }>;

  // Batch-load participants, message stats, and latest preview
  const memberStmt = db().prepare(
    `SELECT actor_id FROM conversation_members WHERE conversation_id = ?`,
  );
  const statsStmt = db().prepare(
    `SELECT COUNT(*) AS cnt, MAX(${messageCreatedAtExpression}) AS last_at FROM messages WHERE conversation_id = ?`,
  );
  const previewStmt = db().prepare(
    `SELECT body
     FROM messages m
     WHERE conversation_id = ?
       AND actor_id != 'operator'
       AND ${transientBrokerWorkingStatusPredicate("m")}
     ORDER BY ${previewMessageCreatedAtExpression} DESC LIMIT 1`,
  );

  return rows.map((r) => {
    const participants = (memberStmt.all(r.id) as Array<{ actor_id: string }>)
      .map((m) => m.actor_id);
    const agentId = participants.find((p) => p !== "operator") ?? null;
    const stats = statsStmt.get(r.id) as { cnt: number; last_at: number | null } | null;

    // Get agent details if available
    let agentName: string | null = null;
    let harness: string | null = null;
    let harnessSessionId: string | null = null;
    let harnessLogPath: string | null = null;
    let branch: string | null = null;
    let workspaceRoot: string | null = null;

    if (agentId) {
      const agentRow = db().prepare(
        `SELECT
           ac.display_name,
           ep.harness,
           ep.transport,
           ep.project_root,
           ep.session_id,
           ep.metadata_json AS endpoint_metadata_json,
           a.metadata_json
         FROM agents a
         JOIN actors ac ON ac.id = a.id
         ${LATEST_AGENT_ENDPOINT_JOIN}
         WHERE a.id = ?`,
      ).get(agentId) as {
        display_name: string;
        harness: string | null;
        transport: string | null;
        project_root: string | null;
        session_id: string | null;
        endpoint_metadata_json: string | null;
        metadata_json: string | null;
      } | null;

      if (agentRow) {
        agentName = agentRow.display_name;
        harness = agentRow.harness;
        workspaceRoot = compact(agentRow.project_root);
        try {
          const meta = agentRow.metadata_json ? JSON.parse(agentRow.metadata_json) : {};
          branch = (meta.branch as string) ?? (meta.workspaceQualifier as string) ?? null;
        } catch {}
        try {
          const endpointMeta = agentRow.endpoint_metadata_json
            ? JSON.parse(agentRow.endpoint_metadata_json)
            : {};
          harnessSessionId = resolveHarnessSessionId(
            agentRow.transport,
            agentRow.session_id,
            endpointMeta,
          );
          harnessLogPath = resolveHarnessLogPath(
            agentId,
            agentRow.transport,
            agentRow.session_id,
            endpointMeta,
          );
        } catch {
          harnessSessionId = resolveHarnessSessionId(
            agentRow.transport,
            agentRow.session_id,
            undefined,
          );
          harnessLogPath = resolveHarnessLogPath(
            agentId,
            agentRow.transport,
            agentRow.session_id,
            undefined,
          );
        }
      }
    }

    const preview = (previewStmt.get(r.id) as { body: string } | null)?.body ?? null;

    return {
      id: r.id,
      kind: r.kind,
      title: agentName ?? r.title,
      participantIds: participants,
      agentId,
      agentName,
      harness,
      harnessSessionId,
      harnessLogPath,
      currentBranch: branch,
      preview: preview ? preview.slice(0, 200) : null,
      messageCount: stats?.cnt ?? 0,
      lastMessageAt: stats?.last_at ?? null,
      workspaceRoot,
    };
  });
}
