/**
 * Mobile-shaped agent listing and detail queries.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. These return the
 * `Mobile*` shapes that the iOS app's bridge router consumes; the
 * web-shaped equivalents live in `../agents.ts`.
 */

import { directChannelNaturalKey } from "@openscout/protocol";

import { db } from "../internal/db.ts";
import { compact } from "../internal/paths.ts";
import {
  LATEST_AGENT_ENDPOINT_JOIN,
  activeAgentMetadataPredicate,
  queryAgentFlightPhases,
  sqlTimestampMsExpression,
  summarizeAgentState,
  summarizeAgentStatusLabel,
  type AgentFlightPhase,
} from "../internal/sql-helpers.ts";
import type {
  MobileAgentDetail,
  MobileAgentSummary,
} from "../types/mobile.ts";

/**
 * The conversation the phone should open for an agent. It is an existing broker
 * chat id: the operator DM if it exists, else the most recent conversation the
 * agent posted in. We do not synthesize structural chat ids.
 */
function resolveAgentConversationId(agentId: string): string | null {
  const naturalKey = directChannelNaturalKey(["operator", agentId]);
  const direct = db().prepare(
    `SELECT id FROM conversations
     WHERE json_extract(metadata_json, '$.naturalKey') = ?
     ORDER BY created_at ASC
     LIMIT 1`,
  ).get(naturalKey) as { id: string } | undefined;
  if (direct?.id) return direct.id;

  const recent = db().prepare(
    `SELECT conversation_id FROM messages WHERE actor_id = ?
       GROUP BY conversation_id ORDER BY MAX(created_at) DESC LIMIT 1`,
  ).get(agentId) as { conversation_id: string } | undefined;
  return recent?.conversation_id ?? null;
}

export function queryMobileAgents(
  limit = 50,
  filters: { query?: string | null } = {},
): MobileAgentSummary[] {
  const flightPhases = queryAgentFlightPhases();
  const messageCreatedAtExpression = sqlTimestampMsExpression("created_at");
  const endpointUpdatedAtExpression = sqlTimestampMsExpression("ep.updated_at");
  const query = filters.query?.trim().toLowerCase();
  const whereClauses = [activeAgentMetadataPredicate("a")];
  const params: Array<string | number> = [];
  if (query) {
    whereClauses.push(`(
      lower(ac.display_name) LIKE ?
      OR lower(a.id) LIKE ?
      OR lower(COALESCE(a.default_selector, '')) LIKE ?
      OR lower(COALESCE(a.selector, '')) LIKE ?
      OR lower(COALESCE(ep.project_root, '')) LIKE ?
    )`);
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  params.push(limit);

  // Latest message timestamp per actor (for lastActiveAt)
  const lastMessageAt = new Map(
    (db().prepare(
      `SELECT actor_id, MAX(${messageCreatedAtExpression}) AS last_at FROM messages GROUP BY actor_id`,
    ).all() as Array<{ actor_id: string; last_at: number }>).map((r) => [r.actor_id, r.last_at]),
  );

  // Conversation each agent should open (see `resolveAgentConversationId`).
  // Resolved in batch — existing direct chats by natural key + the most-recent
  // conversation each actor has posted in — so the per-agent lookup below is a
  // map hit instead of two queries per row.
  const directByNaturalKey = new Map(
    (db().prepare(
      `SELECT id, json_extract(metadata_json, '$.naturalKey') AS natural_key
       FROM conversations
       WHERE json_extract(metadata_json, '$.naturalKey') LIKE 'direct:%'`,
    ).all() as Array<{ id: string; natural_key: string | null }>)
      .flatMap((row) => row.natural_key ? [[row.natural_key, row.id] as const] : []),
  );
  const recentConvByActor = new Map<string, string>();
  for (const r of db().prepare(
    `SELECT m.actor_id AS actor_id, m.conversation_id AS conversation_id
       FROM messages m
       JOIN (SELECT actor_id, MAX(created_at) AS mc FROM messages GROUP BY actor_id) t
         ON t.actor_id = m.actor_id AND t.mc = m.created_at`,
  ).all() as Array<{ actor_id: string; conversation_id: string }>) {
    if (!recentConvByActor.has(r.actor_id)) recentConvByActor.set(r.actor_id, r.conversation_id);
  }
  const resolveConversationId = (agentId: string): string | null => {
    const naturalKey = directChannelNaturalKey(["operator", agentId]);
    return directByNaturalKey.get(naturalKey) ?? recentConvByActor.get(agentId) ?? null;
  };

  const rows = db().prepare(
    `SELECT
       a.id,
       ac.display_name,
       a.default_selector,
       a.metadata_json,
       a.wake_policy,
       ep.harness,
       ep.transport,
       ep.state,
       ep.project_root,
       ep.session_id,
       ${endpointUpdatedAtExpression} AS updated_at
     FROM agents a
     JOIN actors ac ON ac.id = a.id
     ${LATEST_AGENT_ENDPOINT_JOIN}
     WHERE ${whereClauses.join(" AND ")}
     ORDER BY COALESCE(${endpointUpdatedAtExpression}, 0) DESC, ac.display_name ASC
     LIMIT ?`,
  ).all(...params) as Array<{
    id: string;
    display_name: string;
    default_selector: string | null;
    metadata_json: string | null;
    wake_policy: string | null;
    harness: string | null;
    transport: string | null;
    state: string | null;
    project_root: string | null;
    session_id: string | null;
    updated_at: number | null;
  }>;

  return rows.map((r) => {
    let meta: Record<string, unknown> = {};
    try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch {}

    const flightPhase = flightPhases.get(r.id) ?? null;
    const state = summarizeAgentState(r.state, flightPhase);
    const statusLabel = summarizeAgentStatusLabel(r.state, flightPhase);

    return {
      id: r.id,
      title: r.display_name,
      selector: (meta.selector as string) ?? null,
      defaultSelector: r.default_selector,
      workspaceRoot: compact(r.project_root),
      harness: r.harness,
      transport: r.transport,
      state,
      statusLabel,
      sessionId: null,
      conversationId: resolveConversationId(r.id),
      lastActiveAt: lastMessageAt.get(r.id) ?? null,
    };
  });
}

/* ── Agent detail (single agent, richer data) ── */

export function queryMobileAgentDetail(agentId: string): MobileAgentDetail | null {
  const endpointUpdatedAtExpression = sqlTimestampMsExpression("ep.updated_at");
  const row = db().prepare(
    `SELECT
       a.id,
       ac.display_name,
       a.default_selector,
       a.wake_policy,
       a.capabilities_json,
       a.metadata_json,
       ep.harness,
       ep.transport,
       ep.state,
       ep.project_root,
       ep.cwd,
       ep.session_id,
       ${endpointUpdatedAtExpression} AS updated_at
     FROM agents a
     JOIN actors ac ON ac.id = a.id
     ${LATEST_AGENT_ENDPOINT_JOIN}
     WHERE a.id = ?
       AND ${activeAgentMetadataPredicate("a")}`,
  ).get(agentId) as {
    id: string;
    display_name: string;
    default_selector: string | null;
    wake_policy: string | null;
    capabilities_json: string | null;
    metadata_json: string | null;
    harness: string | null;
    transport: string | null;
    state: string | null;
    project_root: string | null;
    cwd: string | null;
    session_id: string | null;
    updated_at: number | null;
  } | null;

  if (!row) return null;

  let meta: Record<string, unknown> = {};
  try { meta = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}

  let capabilities: string[] = [];
  try { capabilities = row.capabilities_json ? JSON.parse(row.capabilities_json) : []; } catch {}

  const flightPhases = queryAgentFlightPhases();
  const flightStartedAtExpression = sqlTimestampMsExpression("started_at");

  const activeFlights = (db().prepare(
    `SELECT flight_id AS id, state, summary, ${flightStartedAtExpression} AS started_at
     FROM invocations
     WHERE target_agent_id = ? AND flight_id IS NOT NULL AND state NOT IN ('completed','failed','cancelled')
     ORDER BY ${flightStartedAtExpression} DESC`,
  ).all(agentId) as Array<{
    id: string;
    state: string;
    summary: string | null;
    started_at: number | null;
  }>).map((f) => ({
    id: f.id,
    state: f.state,
    summary: f.summary,
    startedAt: f.started_at,
  }));

  const activityTsExpression = sqlTimestampMsExpression("ai.ts");
  const recentActivity = (db().prepare(
    `SELECT ai.id, ai.kind, ${activityTsExpression} AS ts, ai.title, ai.summary
     FROM activity_items ai
     WHERE ai.actor_id = ?
     ORDER BY ${activityTsExpression} DESC
     LIMIT 20`,
  ).all(agentId) as Array<{
    id: string;
    kind: string;
    ts: number;
    title: string | null;
    summary: string | null;
  }>).map((a) => ({
    id: a.id,
    kind: a.kind,
    ts: a.ts,
    title: a.title,
    summary: a.summary,
  }));

  const conversationId = resolveAgentConversationId(agentId);
  const msgRow = conversationId
    ? db().prepare(
      `SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?`,
    ).get(conversationId) as { cnt: number } | null
    : null;
  const messageCount = msgRow?.cnt ?? 0;

  const lastMessageAt = (db().prepare(
    `SELECT MAX(${sqlTimestampMsExpression("created_at")}) AS last_at FROM messages WHERE actor_id = ?`,
  ).get(agentId) as { last_at: number | null } | null)?.last_at ?? null;

  const flightPhase = flightPhases.get(row.id) ?? null;
  const state = summarizeAgentState(row.state, flightPhase);
  const statusLabel = summarizeAgentStatusLabel(row.state, flightPhase);

  return {
    id: row.id,
    title: row.display_name,
    selector: (meta.selector as string) ?? null,
    defaultSelector: row.default_selector,
    workspaceRoot: compact(row.project_root),
    harness: row.harness,
    transport: row.transport,
    state,
    statusLabel,
    sessionId: null,
    conversationId,
    lastActiveAt: lastMessageAt,
    cwd: compact(row.cwd),
    wakePolicy: row.wake_policy,
    capabilities,
    branch: (meta.branch as string) ?? null,
    role: (meta.role as string) ?? null,
    model: (meta.model as string) ?? null,
    activeFlights,
    recentActivity,
    messageCount,
  };
}
