/**
 * Mesh Ops queries — an attention-ordered list of work items across hosts,
 * with a latest-flight rollup and host attribution derived from the owner
 * agent's node id.
 *
 * The row unit is the work item (`collaboration_records` kind = 'work_item');
 * flights are its latest run (read from the invocation shadow columns, the
 * same pattern `queryWorkItems` uses). Active states are always included;
 * done/cancelled items stay listed for a recency window (mirroring fleet's
 * recentCompleted idea).
 *
 * The phase/attention helpers (`workPhaseFromFlightState`,
 * `workPhaseFromState`, `workAttention`) are shared with `./work.ts` so the
 * two surfaces never disagree about what needs attention.
 */

import type {
  CollaborationPriority,
  CollaborationProgress,
  CollaborationRelation,
  CollaborationWaitingOn,
  WorkItemRecord,
  WorkItemState,
} from "@openscout/protocol";

import { db } from "./internal/db.ts";
import { configuredOperatorActorIds } from "./internal/conversation-ids.ts";
import { coerceNumber, parseJson } from "./internal/parse.ts";
import {
  ACTIVE_WORK_STATES_SQL,
  sqlJoinClauses,
  sqlPlaceholders,
  sqlStringList,
  sqlTimestampMsCoalesceExpression,
  sqlWhereClause,
} from "./internal/sql-helpers.ts";
import { workAttention, workPhaseFromFlightState, workPhaseFromState } from "./work.ts";
import type { WebMeshOpsHost, WebMeshOpsItem } from "./types/web.ts";

/** Done/cancelled items stay listed while updated within this window; the
 * client buckets them into "done" (≤24h) or "archive" (older). */
export const MESH_OPS_DONE_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL_WORK_STATES_SQL = sqlStringList(["done", "cancelled"]);

type MeshOpsRow = {
  id: string;
  title: string;
  summary: string | null;
  state: string;
  acceptance_state: string;
  priority: string | null;
  labels_json: string | null;
  owner_id: string | null;
  owner_name: string | null;
  next_move_owner_id: string | null;
  created_at: number;
  updated_at: number;
  host_node_id: string | null;
  host_label: string | null;
  project_root: string | null;
  waiting_on_kind: string | null;
  waiting_on_label: string | null;
  progress_summary: string | null;
  active_flight_count: number;
  active_flight_state: string | null;
  active_flight_summary: string | null;
  latest_flight_id: string | null;
  latest_flight_state: string | null;
  latest_flight_summary: string | null;
  latest_flight_started_at: number | string | null;
  latest_flight_completed_at: number | string | null;
  latest_flight_at: number | string | null;
  latest_dismissed_at: number | string | null;
  latest_event_summary: string | null;
  latest_event_at: number | string | null;
  sort_ts: number;
};

function parseMeshOpsLabels(value: string | null): string[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((label): label is string => typeof label === "string");
}

const ATTENTION_RANK: Record<string, number> = {
  interrupt: 0,
  badge: 1,
  silent: 2,
};

function projectMeshOpsRow(row: MeshOpsRow): WebMeshOpsItem {
  const updatedAt = coerceNumber(row.updated_at) ?? 0;
  const latestFlightAt = coerceNumber(row.latest_flight_at);
  const latestEventAt = coerceNumber(row.latest_event_at);
  const currentPhase = workPhaseFromFlightState(row.active_flight_state)
    ?? (row.latest_flight_state === "failed" ? "Failed" : workPhaseFromState(row.state));
  const attention = workAttention(row);

  const candidates = [
    {
      at: latestEventAt,
      summary: row.latest_event_summary,
    },
    {
      at: latestFlightAt,
      summary: row.active_flight_summary ?? workPhaseFromFlightState(row.latest_flight_state),
    },
    {
      at: updatedAt,
      summary: row.progress_summary ?? row.summary ?? row.title,
    },
  ].filter((candidate): candidate is { at: number; summary: string | null } => typeof candidate.at === "number");

  candidates.sort((left, right) => right.at - left.at);
  const latest = candidates[0] ?? { at: updatedAt, summary: row.summary ?? row.title };

  return {
    id: row.id,
    kind: "work",
    title: row.title,
    summary: row.summary,
    state: row.state,
    acceptanceState: row.acceptance_state,
    priority: row.priority,
    labels: parseMeshOpsLabels(row.labels_json),
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    nextMoveOwnerId: row.next_move_owner_id,
    updatedAt,
    createdAt: coerceNumber(row.created_at) ?? updatedAt,
    hostNodeId: row.host_node_id,
    hostLabel: row.host_label,
    projectRoot: row.project_root,
    latestFlight: row.latest_flight_id
      ? {
          id: row.latest_flight_id,
          state: row.latest_flight_state ?? "unknown",
          summary: row.latest_flight_summary,
          startedAt: coerceNumber(row.latest_flight_started_at),
          completedAt: coerceNumber(row.latest_flight_completed_at),
        }
      : null,
    activeFlightCount: row.active_flight_count ?? 0,
    currentPhase,
    lastMeaningfulAt: latest.at,
    lastMeaningfulSummary: latest.summary,
    attention,
    waitingOn: row.waiting_on_label
      ? {
          ...(row.waiting_on_kind ? { kind: row.waiting_on_kind } : {}),
          label: row.waiting_on_label,
        }
      : null,
  };
}

export function queryMeshOpsItems(opts?: {
  machineId?: string;
  limit?: number;
}): WebMeshOpsItem[] {
  const operatorIds = configuredOperatorActorIds();
  const operatorClause = sqlPlaceholders(operatorIds.length);
  const doneRecencyCutoff = Date.now() - MESH_OPS_DONE_RECENCY_MS;

  const where = sqlJoinClauses([
    "cr.kind = 'work_item'",
    `(
      cr.state IN ${ACTIVE_WORK_STATES_SQL}
      OR (cr.state IN ${TERMINAL_WORK_STATES_SQL} AND cr.updated_at >= ?)
    )`,
    opts?.machineId
      ? "COALESCE(owner_agent.authority_node_id, owner_agent.home_node_id) = ?"
      : null,
  ]);

  const sql = `SELECT
    cr.id,
    cr.title,
    cr.summary,
    cr.state,
    cr.acceptance_state,
    cr.priority,
    cr.labels_json,
    cr.owner_id,
    owner.display_name AS owner_name,
    cr.next_move_owner_id,
    cr.created_at,
    cr.updated_at,
    COALESCE(owner_agent.authority_node_id, owner_agent.home_node_id) AS host_node_id,
    host_node.name AS host_label,
    (
      SELECT ep.project_root
      FROM agent_endpoints ep
      WHERE ep.agent_id = cr.owner_id
      ORDER BY ${sqlTimestampMsCoalesceExpression("ep.updated_at")} DESC
      LIMIT 1
    ) AS project_root,
    json_extract(cr.detail_json, '$.waitingOn.kind') AS waiting_on_kind,
    json_extract(cr.detail_json, '$.waitingOn.label') AS waiting_on_label,
    json_extract(cr.detail_json, '$.progress.summary') AS progress_summary,
    (
      SELECT COUNT(*)
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
        AND inv.state NOT IN ('completed','failed','cancelled')
    ) AS active_flight_count,
    (
      SELECT inv.state
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
        AND inv.state NOT IN ('completed','failed','cancelled')
      ORDER BY COALESCE(inv.started_at, inv.completed_at, 0) DESC
      LIMIT 1
    ) AS active_flight_state,
    (
      SELECT inv.summary
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
        AND inv.state NOT IN ('completed','failed','cancelled')
      ORDER BY COALESCE(inv.started_at, inv.completed_at, 0) DESC
      LIMIT 1
    ) AS active_flight_summary,
    (
      SELECT inv.flight_id
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_id,
    (
      SELECT inv.state
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_state,
    (
      SELECT inv.summary
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_summary,
    (
      SELECT inv.started_at
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_started_at,
    (
      SELECT inv.completed_at
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_completed_at,
    (
      SELECT COALESCE(inv.completed_at, inv.started_at)
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_at,
    (
      SELECT e.created_at
      FROM collaboration_events e
      WHERE e.record_id = cr.id
        AND e.kind = 'dismissed'
        AND e.actor_id IN (${operatorClause})
      ORDER BY e.created_at DESC
      LIMIT 1
    ) AS latest_dismissed_at,
    (
      SELECT e.summary
      FROM collaboration_events e
      WHERE e.record_id = cr.id
      ORDER BY e.created_at DESC
      LIMIT 1
    ) AS latest_event_summary,
    (
      SELECT e.created_at
      FROM collaboration_events e
      WHERE e.record_id = cr.id
      ORDER BY e.created_at DESC
      LIMIT 1
    ) AS latest_event_at,
    MAX(
      cr.updated_at,
      COALESCE((
        SELECT e.created_at
        FROM collaboration_events e
        WHERE e.record_id = cr.id
        ORDER BY e.created_at DESC
        LIMIT 1
      ), 0),
      COALESCE((
        SELECT COALESCE(inv.completed_at, inv.started_at)
        FROM invocations inv
        WHERE inv.collaboration_record_id = cr.id
          AND inv.flight_id IS NOT NULL
        ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
        LIMIT 1
      ), 0)
    ) AS sort_ts
  FROM collaboration_records cr
  LEFT JOIN actors owner ON owner.id = cr.owner_id
  LEFT JOIN agents owner_agent ON owner_agent.id = cr.owner_id
  LEFT JOIN nodes host_node
    ON host_node.id = COALESCE(owner_agent.authority_node_id, owner_agent.home_node_id)
  ${sqlWhereClause([where])}
  ORDER BY sort_ts DESC, cr.updated_at DESC
  LIMIT ?`;

  const limit = opts?.limit ?? 50;
  // Attention is computed in JS (dismissal comparisons), so over-fetch
  // ordered by recency, then rank by attention and slice to the limit.
  const candidateLimit = Math.max(limit * 4, 200);
  const params: Array<string | number> = [...operatorIds, doneRecencyCutoff];
  if (opts?.machineId) {
    params.push(opts.machineId);
  }
  params.push(candidateLimit);

  const rows = db().prepare(sql).all(...params) as MeshOpsRow[];
  const items = rows.map(projectMeshOpsRow);
  items.sort((left, right) => {
    const rankDelta = (ATTENTION_RANK[left.attention] ?? 3) - (ATTENTION_RANK[right.attention] ?? 3);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return (right.lastMeaningfulAt ?? right.updatedAt) - (left.lastMeaningfulAt ?? left.updatedAt);
  });
  return items.slice(0, limit);
}

/** Active (non-terminal) flight count for one work item. */
export function queryMeshOpsActiveFlightCount(recordId: string): number {
  const row = db().prepare(
    `SELECT COUNT(*) AS count
     FROM invocations inv
     WHERE inv.collaboration_record_id = ?
       AND inv.flight_id IS NOT NULL
       AND inv.state NOT IN ('completed','failed','cancelled')`,
  ).get(recordId) as { count: number };
  return row.count;
}

type MeshOpsRecordRow = {
  id: string;
  state: string;
  acceptance_state: string;
  title: string;
  summary: string | null;
  created_by_id: string;
  owner_id: string | null;
  next_move_owner_id: string | null;
  conversation_id: string | null;
  parent_id: string | null;
  priority: string | null;
  labels_json: string | null;
  relations_json: string | null;
  detail_json: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * Reconstruct the full WorkItemRecord the broker upsert expects — same
 * detail_json layout as SQLiteControlPlaneStore.buildCollaborationRecord.
 * Actuations mutate a copy of this so every unlisted field is preserved.
 */
export function queryMeshOpsWorkRecord(id: string): WorkItemRecord | null {
  const row = db().prepare(
    `SELECT
       id, state, acceptance_state, title, summary, created_by_id, owner_id,
       next_move_owner_id, conversation_id, parent_id, priority, labels_json,
       relations_json, detail_json, created_at, updated_at
     FROM collaboration_records
     WHERE kind = 'work_item' AND id = ?
     LIMIT 1`,
  ).get(id) as MeshOpsRecordRow | null;

  if (!row) {
    return null;
  }

  const detail = parseJson<Record<string, unknown>>(row.detail_json, {});
  return {
    id: row.id,
    kind: "work_item",
    title: row.title,
    summary: row.summary ?? undefined,
    createdById: row.created_by_id,
    ownerId: row.owner_id ?? undefined,
    nextMoveOwnerId: row.next_move_owner_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    priority: (row.priority ?? undefined) as CollaborationPriority | undefined,
    labels: parseJson<string[] | undefined>(row.labels_json, undefined),
    relations: parseJson<CollaborationRelation[] | undefined>(row.relations_json, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: detail.metadata as Record<string, unknown> | undefined,
    state: row.state as WorkItemState,
    acceptanceState: row.acceptance_state as WorkItemRecord["acceptanceState"],
    requestedById: detail.requestedById as string | undefined,
    waitingOn: detail.waitingOn as CollaborationWaitingOn | undefined,
    progress: detail.progress as CollaborationProgress | undefined,
    startedAt: detail.startedAt as number | undefined,
    reviewRequestedAt: detail.reviewRequestedAt as number | undefined,
    completedAt: detail.completedAt as number | undefined,
  };
}

/* ── Session rows (24h lookback) ──
 * Observed runtime sessions as scan rows: live sessions read as "moving",
 * recently-ended ones as "moved". They never claim attention above silent —
 * the focus bucket stays reserved for broker-flagged work. */

/** Sessions seen within this window are listed; the client buckets them by
 * activity, with anything past 24h landing in "archive". */
export const MESH_OPS_SESSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** A session counts as live only while seen within this window. ended_at
 * stays null for zombies the broker stopped hearing from without an end
 * marker, so "not ended" alone overclaims liveness. */
export const MESH_OPS_SESSION_LIVE_WINDOW_MS = 10 * 60 * 1000;

type MeshOpsSessionRow = {
  id: string;
  agent_id: string;
  node_qualifier: string | null;
  harness: string;
  state: string;
  primary_alias: string;
  cwd: string | null;
  project_root: string | null;
  started_at: number | null;
  last_seen_at: number;
  ended_at: number | null;
  node_id: string | null;
  node_name: string | null;
  node_host_name: string | null;
};

/** "scope.main.arts-mac-mini-local" → "scope.main" when the qualifier is known. */
function sessionAgentLabel(agentId: string, nodeQualifier: string | null): string {
  if (nodeQualifier && agentId.endsWith(`.${nodeQualifier}`)) {
    return agentId.slice(0, -(nodeQualifier.length + 1));
  }
  return agentId;
}

/** runtime_sessions.started_at is epoch *seconds*; the rest are ms. */
function coerceTimestampMs(value: number | string | null): number | null {
  const num = coerceNumber(value);
  if (num === null) return null;
  return num < 1_000_000_000_000 ? num * 1000 : num;
}

function projectMeshOpsSessionRow(row: MeshOpsSessionRow): WebMeshOpsItem {
  const lastSeenAt = coerceTimestampMs(row.last_seen_at) ?? 0;
  const startedAt = coerceTimestampMs(row.started_at);
  const endedAt = coerceTimestampMs(row.ended_at);
  const ended = endedAt !== null;
  const live = !ended && Date.now() - lastSeenAt <= MESH_OPS_SESSION_LIVE_WINDOW_MS;
  const agentLabel = sessionAgentLabel(row.agent_id, row.node_qualifier);
  const hostLabel = row.node_host_name?.split(".")[0] ?? row.node_name ?? null;
  // Ephemeral `session-*` agents are broker delivery machinery, not named
  // agents an operator would recognize; the client demotes them by default.
  const relay = row.agent_id.startsWith("session-");

  return {
    id: `session:${row.id}`,
    kind: "session",
    title: agentLabel,
    summary: null,
    state: ended ? "ended" : row.state,
    acceptanceState: "none",
    priority: null,
    labels: [],
    ownerId: row.agent_id,
    ownerName: agentLabel,
    nextMoveOwnerId: null,
    updatedAt: lastSeenAt,
    createdAt: startedAt ?? lastSeenAt,
    hostNodeId: row.node_id,
    hostLabel,
    // Sessions often lack project_root; cwd is the family axis fallback.
    projectRoot: row.project_root ?? row.cwd,
    latestFlight: null,
    activeFlightCount: 0,
    currentPhase: `${row.harness} · ${ended ? "ended" : row.state}`,
    lastMeaningfulAt: lastSeenAt,
    lastMeaningfulSummary: null,
    attention: "silent",
    session: {
      harness: row.harness,
      state: row.state,
      live,
      alias: row.primary_alias || null,
      agentLabel,
      cwd: row.cwd,
      startedAt,
      lastSeenAt,
      endedAt,
      relay,
    },
  };
}

export function queryMeshOpsSessions(opts?: {
  machineId?: string;
  limit?: number;
}): WebMeshOpsItem[] {
  const cutoff = Date.now() - MESH_OPS_SESSION_LOOKBACK_MS;
  const where = sqlJoinClauses([
    "rs.last_seen_at >= ?",
    opts?.machineId ? "rs.node_id = ?" : null,
  ]);
  const sql = `SELECT
    rs.id,
    rs.agent_id,
    ag.node_qualifier,
    rs.harness,
    rs.state,
    rs.primary_alias,
    rs.cwd,
    rs.project_root,
    rs.started_at,
    rs.last_seen_at,
    rs.ended_at,
    rs.node_id,
    n.name AS node_name,
    n.host_name AS node_host_name
  FROM runtime_sessions rs
  LEFT JOIN agents ag ON ag.id = rs.agent_id
  LEFT JOIN nodes n ON n.id = rs.node_id
  ${sqlWhereClause([where])}
  ORDER BY (rs.ended_at IS NULL) DESC, rs.last_seen_at DESC
  LIMIT ?`;

  const params: Array<string | number> = [cutoff];
  if (opts?.machineId) {
    params.push(opts.machineId);
  }
  params.push(opts?.limit ?? 120);

  const rows = db().prepare(sql).all(...params) as MeshOpsSessionRow[];
  return rows.map(projectMeshOpsSessionRow);
}

/* ── Host rows (every known node, with a session rollup) ──
 * The board's host strip needs machines even when they have no current work,
 * so this reads `nodes` directly rather than deriving hosts from items. */

type MeshOpsHostRow = {
  id: string;
  name: string | null;
  host_name: string | null;
  broker_url: string | null;
  tailnet_name: string | null;
  last_seen_at: number | null;
  registered_at: number | null;
  session_count: number | null;
  live_count: number | null;
  last_activity_at: number | null;
};

export function queryMeshOpsHosts(): WebMeshOpsHost[] {
  const cutoff = Date.now() - MESH_OPS_SESSION_LOOKBACK_MS;
  const liveCutoff = Date.now() - MESH_OPS_SESSION_LIVE_WINDOW_MS;
  const sql = `SELECT
    n.id,
    n.name,
    n.host_name,
    n.broker_url,
    n.tailnet_name,
    n.last_seen_at,
    n.registered_at,
    COUNT(rs.id) AS session_count,
    SUM(CASE WHEN rs.ended_at IS NULL AND rs.last_seen_at >= ? THEN 1 ELSE 0 END) AS live_count,
    MAX(rs.last_seen_at) AS last_activity_at
  FROM nodes n
  LEFT JOIN runtime_sessions rs
    ON rs.node_id = n.id AND rs.last_seen_at >= ?
  GROUP BY n.id
  ORDER BY (last_activity_at IS NULL), last_activity_at DESC, n.name`;

  const rows = db().prepare(sql).all(liveCutoff, cutoff) as MeshOpsHostRow[];
  return rows.map((row) => ({
    nodeId: row.id,
    label: row.host_name?.split(".")[0] ?? row.name ?? row.id,
    hostName: row.host_name,
    brokerUrl: row.broker_url,
    tailnetName: row.tailnet_name,
    lastSeenAt: coerceTimestampMs(row.last_seen_at),
    registeredAt: coerceTimestampMs(row.registered_at),
    sessionCount: coerceNumber(row.session_count) ?? 0,
    liveSessionCount: coerceNumber(row.live_count) ?? 0,
    lastActivityAt: coerceTimestampMs(row.last_activity_at),
  }));
}
