/**
 * Direct SQLite reads for the web UI.
 *
 * All queries hit the control-plane database in readonly mode — no shell
 * commands, no tmux, no snapshot rebuilds.  Bun's native SQLite driver is
 * synchronous and fast (< 1 ms for the queries below on a typical machine).
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { EPOCH_MILLISECONDS_FLOOR } from "@openscout/protocol";

/* ── Types (match what the client expects) ── */

export type WebAgent = {
  id: string;
  name: string;
  handle: string | null;
  agentClass: string;
  harness: string | null;
  state: string | null;
  projectRoot: string | null;
  cwd: string | null;
  updatedAt: number | null;
  transport: string | null;
  selector: string | null;
  wakePolicy: string | null;
  capabilities: string[];
  project: string | null;
  branch: string | null;
  role: string | null;
  model: string | null;
};

export type WebActivityItem = {
  id: string;
  kind: string;
  ts: number;
  actorName: string | null;
  title: string | null;
  summary: string | null;
  conversationId: string | null;
  workspaceRoot: string | null;
};

export type WebMessage = {
  id: string;
  conversationId: string;
  actorName: string;
  body: string;
  createdAt: number;
  class: string;
};

type WorkAttention = "silent" | "badge" | "interrupt";
type SqlClause = string | null | undefined | false;

export type WebWorkItem = {
  id: string;
  title: string;
  summary: string | null;
  ownerId: string | null;
  ownerName: string | null;
  nextMoveOwnerId: string | null;
  nextMoveOwnerName: string | null;
  conversationId: string | null;
  state: string;
  acceptanceState: string;
  priority: string | null;
  currentPhase: string;
  attention: WorkAttention;
  activeChildWorkCount: number;
  activeFlightCount: number;
  lastMeaningfulAt: number;
  lastMeaningfulSummary: string | null;
};

/* ── DB path ── */

function resolveDbPath(): string {
  const controlHome =
    process.env.OPENSCOUT_CONTROL_HOME ??
    join(homedir(), ".openscout", "control-plane");
  return join(controlHome, "control-plane.sqlite");
}

/* ── Singleton readonly connection ── */

let _db: Database | null = null;

function db(): Database {
  if (!_db) {
    _db = new Database(resolveDbPath(), { readonly: true });
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec("PRAGMA journal_mode = WAL");
  }
  return _db;
}

/** Call on server shutdown. */
export function closeDb(): void {
  _db?.close();
  _db = null;
}

/* ── Compact home paths (~/...) ── */

const HOME = homedir();

function compact(p: string | null): string | null {
  if (!p) return null;
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

function coerceNumber(value: number | string | null): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sqlJoinClauses(clauses: SqlClause[], operator: "AND" | "OR" = "AND"): string {
  return clauses.filter((clause): clause is string => Boolean(clause)).join(` ${operator} `);
}

function sqlWhereClause(clauses: SqlClause[], operator: "AND" | "OR" = "AND"): string {
  const joined = sqlJoinClauses(clauses, operator);
  return joined ? `WHERE ${joined}` : "";
}

function sqlQuoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlStringList(values: readonly string[]): string {
  return `(${values.map(sqlQuoteLiteral).join(",")})`;
}

function sqlTimestampMsExpression(valueExpression: string): string {
  return `CASE
    WHEN ${valueExpression} IS NULL THEN NULL
    WHEN CAST(${valueExpression} AS REAL) < ${EPOCH_MILLISECONDS_FLOOR}
      THEN CAST(CAST(${valueExpression} AS REAL) * 1000 AS INTEGER)
    ELSE CAST(${valueExpression} AS INTEGER)
  END`;
}

function isExecutingFlightState(state: string | null): boolean {
  return state === "running";
}

const LATEST_AGENT_ENDPOINT_JOIN = `LEFT JOIN agent_endpoints ep ON ep.id = (
  SELECT ep2.id
  FROM agent_endpoints ep2
  WHERE ep2.agent_id = a.id
  ORDER BY ep2.updated_at DESC
  LIMIT 1
)`;

function queryExecutingAgentIds(): Set<string> {
  return new Set(
    (db().prepare(
      `SELECT DISTINCT target_agent_id FROM flights
       WHERE state = 'running'`,
    ).all() as Array<{ target_agent_id: string }>).map((row) => row.target_agent_id),
  );
}

function summarizeAgentState(rawState: string | null, isWorking: boolean): "offline" | "available" | "working" {
  if (isWorking) {
    return "working";
  }
  return rawState && rawState !== "offline" ? "available" : "offline";
}

function summarizeAgentStatusLabel(rawState: string | null, isWorking: boolean): string {
  switch (summarizeAgentState(rawState, isWorking)) {
    case "working":
      return "Working";
    case "available":
      return "Available";
    default:
      return "Offline";
  }
}

function isDuplicateActivityFeedItem(previous: WebActivityItem | null, next: WebActivityItem): boolean {
  if (!previous) {
    return false;
  }
  return previous.kind === next.kind
    && previous.title === next.title
    && previous.summary === next.summary
    && previous.conversationId === next.conversationId
    && Math.abs(previous.ts - next.ts) <= 5_000;
}

const ACTIVE_FLIGHT_STATES_SQL = sqlStringList(["running", "waking", "waiting", "queued"]);
const ACTIVE_FLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WORK_STATES_SQL = sqlStringList(["open", "working", "waiting", "review"]);

function staleFlightActivityPredicate(alias: string): string {
  return `NOT (
    ${alias}.kind = 'flight_updated'
    AND COALESCE(${alias}.summary, '') LIKE 'Stale running flight reconciled:%'
  )`;
}

function workPhaseFromFlightState(state: string | null): string | null {
  switch (state) {
    case "queued":
      return "Queued";
    case "waking":
      return "Waking";
    case "waiting":
      return "Waiting";
    case "running":
      return "Working";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return null;
  }
}

function workPhaseFromState(state: string): string {
  switch (state) {
    case "open":
      return "Open";
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "review":
      return "In review";
    case "done":
      return "Done";
    case "cancelled":
      return "Cancelled";
    default:
      return state.replace(/_/g, " ");
  }
}

function workAttention(row: {
  state: string;
  acceptance_state: string;
  latest_flight_state: string | null;
}): WorkAttention {
  if (row.latest_flight_state === "failed") {
    return "interrupt";
  }
  if (row.state === "waiting" || row.state === "review" || row.acceptance_state === "pending") {
    return "badge";
  }
  return "silent";
}

function projectWorkItemRow(row: {
  id: string;
  title: string;
  summary: string | null;
  owner_id: string | null;
  owner_name: string | null;
  next_move_owner_id: string | null;
  next_move_owner_name: string | null;
  conversation_id: string | null;
  state: string;
  acceptance_state: string;
  priority: string | null;
  updated_at: number;
  active_child_work_count: number;
  active_flight_count: number;
  active_flight_state: string | null;
  active_flight_summary: string | null;
  latest_flight_state: string | null;
  latest_flight_at: number | string | null;
  latest_event_summary: string | null;
  latest_event_at: number | string | null;
  progress_summary: string | null;
}): WebWorkItem {
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
    title: row.title,
    summary: row.summary,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    nextMoveOwnerId: row.next_move_owner_id,
    nextMoveOwnerName: row.next_move_owner_name,
    conversationId: row.conversation_id,
    state: row.state,
    acceptanceState: row.acceptance_state,
    priority: row.priority,
    currentPhase,
    attention,
    activeChildWorkCount: row.active_child_work_count ?? 0,
    activeFlightCount: row.active_flight_count ?? 0,
    lastMeaningfulAt: latest.at,
    lastMeaningfulSummary: latest.summary,
  };
}

/* ── Queries ── */

export function queryAgents(limit = 50): WebAgent[] {
  const executingAgentIds = queryExecutingAgentIds();
  const rows = db()
    .prepare(
      `SELECT
         a.id,
         ac.display_name AS name,
         ac.handle,
         a.agent_class,
         a.default_selector,
         a.wake_policy,
         a.capabilities_json,
         a.metadata_json,
         ep.harness,
         ep.transport,
         ep.state,
         ep.project_root,
         ep.cwd,
         ep.metadata_json AS endpoint_metadata_json,
         ep.updated_at
       FROM agents a
       JOIN actors ac ON ac.id = a.id
       ${LATEST_AGENT_ENDPOINT_JOIN}
       WHERE COALESCE(json_extract(a.metadata_json, '$.retiredFromFleet'), 0) != 1
       ORDER BY COALESCE(ep.updated_at, 0) DESC, ac.display_name ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    name: string;
    handle: string | null;
    agent_class: string;
    default_selector: string | null;
    wake_policy: string | null;
    capabilities_json: string | null;
    metadata_json: string | null;
    harness: string | null;
    transport: string | null;
    state: string | null;
    project_root: string | null;
    cwd: string | null;
    endpoint_metadata_json: string | null;
    updated_at: number | null;
  }>;

  return rows.map((r) => {
    let capabilities: string[] = [];
    try { capabilities = r.capabilities_json ? JSON.parse(r.capabilities_json) : []; } catch {}

    let meta: Record<string, unknown> = {};
    try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch {}

    let endpointMeta: Record<string, unknown> = {};
    try { endpointMeta = r.endpoint_metadata_json ? JSON.parse(r.endpoint_metadata_json) : {}; } catch {}

    return {
      id: r.id,
      name: r.name,
      handle: r.handle,
      agentClass: r.agent_class,
      harness: r.harness,
      state: summarizeAgentState(r.state, executingAgentIds.has(r.id)),
      projectRoot: compact(r.project_root),
      cwd: compact(r.cwd),
      updatedAt: r.updated_at,
      transport: r.transport,
      selector: r.default_selector,
      wakePolicy: r.wake_policy,
      capabilities,
      project: (meta.project as string) ?? null,
      branch: (meta.branch as string) ?? null,
      role: (meta.role as string) ?? null,
      model: (meta.model as string) ?? (endpointMeta.model as string) ?? null,
    };
  });
}

export function queryActivity(limit = 60): WebActivityItem[] {
  const rows = db()
    .prepare(
      `SELECT
         ai.id,
         ai.kind,
         ai.ts,
         ac.display_name AS actor_name,
         ai.title,
         ai.summary,
         ai.conversation_id,
         ai.workspace_root
       FROM activity_items ai
       LEFT JOIN actors ac ON ac.id = ai.actor_id
       WHERE ai.kind != 'ask_replied'
         AND ${staleFlightActivityPredicate("ai")}
       ORDER BY ai.ts DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    kind: string;
    ts: number;
    actor_name: string | null;
    title: string | null;
    summary: string | null;
    conversation_id: string | null;
    workspace_root: string | null;
  }>;

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    ts: r.ts,
    actorName: r.actor_name,
    title: r.title,
    summary: r.summary,
    conversationId: r.conversation_id,
    workspaceRoot: compact(r.workspace_root),
  }));

  return items.filter((item, index) => !isDuplicateActivityFeedItem(items[index - 1] ?? null, item));
}

export function queryRecentMessages(limit = 80): WebMessage[] {
  const rows = db()
    .prepare(
      `SELECT
         m.id,
         m.conversation_id,
         ac.display_name AS actor_name,
         m.body,
         m.created_at,
         m.class
       FROM messages m
       JOIN actors ac ON ac.id = m.actor_id
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    conversation_id: string;
    actor_name: string;
    body: string;
    created_at: number;
    class: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    actorName: r.actor_name,
    body: r.body,
    createdAt: r.created_at,
    class: r.class,
  }));
}

/* ── Flights (tasks) ── */

export type WebFlight = {
  id: string;
  invocationId: string;
  agentId: string;
  agentName: string | null;
  conversationId: string | null;
  collaborationRecordId: string | null;
  state: string;
  summary: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type WebFleetObservableKind = "agent" | "session" | "actor";

export type WebFleetActivity = WebActivityItem & {
  actorId: string | null;
  agentId: string | null;
  flightId: string | null;
  invocationId: string | null;
  messageId: string | null;
  recordId: string | null;
  sessionId: string | null;
};

export type WebFleetObservable = {
  id: string;
  kind: WebFleetObservableKind;
  actorId: string | null;
  agentId: string | null;
  name: string;
  handle: string | null;
  agentClass: string | null;
  role: string | null;
  harness: string | null;
  transport: string | null;
  state: string | null;
  attention: WorkAttention;
  conversationId: string | null;
  sessionId: string | null;
  projectRoot: string | null;
  cwd: string | null;
  project: string | null;
  branch: string | null;
  selector: string | null;
  wakePolicy: string | null;
  capabilities: string[];
  messageCount: number;
  activeFlightCount: number;
  activeWorkCount: number;
  lastActiveAt: number | null;
  lastActivity: WebFleetActivity | null;
  activeFlights: WebFlight[];
  recentActivity: WebFleetActivity[];
};

export type WebFleetState = {
  generatedAt: number;
  totals: {
    observables: number;
    activity: number;
    activeFlights: number;
    activeWork: number;
    messages: number;
    silent: number;
    badge: number;
    interrupt: number;
  };
  observables: WebFleetObservable[];
  activity: WebFleetActivity[];
};

type FleetAgentRow = {
  id: string;
  name: string;
  handle: string | null;
  agent_class: string;
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
};

type FleetActivityRow = {
  id: string;
  kind: string;
  ts: number;
  actor_name: string | null;
  title: string | null;
  summary: string | null;
  conversation_id: string | null;
  workspace_root: string | null;
  actor_id: string | null;
  agent_id: string | null;
  message_id: string | null;
  invocation_id: string | null;
  flight_id: string | null;
  record_id: string | null;
  session_id: string | null;
};

type FleetFlightRow = {
  id: string;
  invocation_id: string;
  target_agent_id: string;
  agent_name: string | null;
  conversation_id: string | null;
  collaboration_record_id: string | null;
  state: string;
  summary: string | null;
  started_at: number | null;
  completed_at: number | null;
};

type FleetWorkStatsRow = {
  active_work_count: number;
  attention_work_count: number;
  last_work_at: number | null;
};

type FleetMessageStatsRow = {
  message_count: number;
  last_message_at: number | null;
};

export type WebWorkTimelineKind =
  | "collaboration_event"
  | "flight_started"
  | "flight_completed"
  | "message";

export type WebWorkTimelineItem = {
  id: string;
  kind: WebWorkTimelineKind;
  at: number;
  actorId: string | null;
  actorName: string | null;
  title: string | null;
  summary: string | null;
  detailKind: string | null;
  flightId: string | null;
  messageId: string | null;
  conversationId: string | null;
};

export type WebWorkDetail = WebWorkItem & {
  createdAt: number;
  updatedAt: number;
  parentId: string | null;
  parentTitle: string | null;
  childWork: WebWorkItem[];
  activeFlights: WebFlight[];
  timeline: WebWorkTimelineItem[];
};

function parseFleetCapabilities(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseFleetMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function fleetAttentionRank(attention: WorkAttention): number {
  switch (attention) {
    case "interrupt":
      return 2;
    case "badge":
      return 1;
    default:
      return 0;
  }
}

function projectFleetActivity(row: FleetActivityRow): WebFleetActivity {
  return {
    id: row.id,
    kind: row.kind,
    ts: row.ts,
    actorName: row.actor_name,
    title: row.title,
    summary: row.summary,
    conversationId: row.conversation_id,
    workspaceRoot: compact(row.workspace_root),
    actorId: row.actor_id,
    agentId: row.agent_id,
    flightId: row.flight_id,
    invocationId: row.invocation_id,
    messageId: row.message_id,
    recordId: row.record_id,
    sessionId: row.session_id,
  };
}

function queryFleetActivity(opts?: {
  limit?: number;
  agentId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
}): WebFleetActivity[] {
  const filters: string[] = [];
  const params: Array<string | number> = [];

  if (opts?.agentId) {
    filters.push(`(
      ai.agent_id = ?
      OR ai.actor_id = ?
      OR ai.record_id IN (
        SELECT cr.id
        FROM collaboration_records cr
        WHERE cr.owner_id = ?
          OR cr.next_move_owner_id = ?
      )
    )`);
    params.push(opts.agentId, opts.agentId, opts.agentId, opts.agentId);
  }
  if (opts?.sessionId) {
    filters.push("ai.session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts?.conversationId) {
    filters.push("ai.conversation_id = ?");
    params.push(opts.conversationId);
  }

  const scopedFilters = sqlJoinClauses(filters, "OR");
  const sql = `SELECT
    ai.id,
    ai.kind,
    ai.ts,
    ac.display_name AS actor_name,
    ai.title,
    ai.summary,
    ai.conversation_id,
    ai.workspace_root,
    ai.actor_id,
    ai.agent_id,
    ai.message_id,
    ai.invocation_id,
    ai.flight_id,
    ai.record_id,
    ai.session_id
  FROM activity_items ai
  LEFT JOIN actors ac ON ac.id = ai.actor_id
  ${sqlWhereClause([
    staleFlightActivityPredicate("ai"),
    scopedFilters ? `(${scopedFilters})` : null,
  ])}
  ORDER BY ai.ts DESC
  LIMIT ?`;

  const rows = db().prepare(sql).all(...params, opts?.limit ?? 80) as Array<FleetActivityRow>;
  return rows.map(projectFleetActivity);
}

function queryFleetFlightRows(agentId: string): FleetFlightRow[] {
  return db().prepare(
    `SELECT
       f.id,
       f.invocation_id,
       f.target_agent_id,
       ac.display_name AS agent_name,
       inv.conversation_id,
       inv.collaboration_record_id,
       f.state,
       f.summary,
       f.started_at,
       f.completed_at
     FROM flights f
     JOIN invocations inv ON inv.id = f.invocation_id
     LEFT JOIN actors ac ON ac.id = f.target_agent_id
     WHERE f.target_agent_id = ?
       AND NOT (
         COALESCE(f.state, '') = 'failed'
         AND COALESCE(f.error, '') LIKE 'Stale running flight reconciled:%'
       )
     ORDER BY COALESCE(f.completed_at, f.started_at, 0) DESC
     LIMIT 100`,
  ).all(agentId) as Array<FleetFlightRow>;
}

function queryFleetObservable(agentRow: FleetAgentRow): WebFleetObservable {
  const metadata = parseFleetMetadata(agentRow.metadata_json);
  const capabilities = parseFleetCapabilities(agentRow.capabilities_json);
  const conversationId = conversationIdForAgent(agentRow.id);

  const activeFlights = queryFlights({
    agentId: agentRow.id,
    activeOnly: true,
  });
  const flightRows = queryFleetFlightRows(agentRow.id);
  const latestFlight = flightRows[0] ?? null;
  const isWorking = activeFlights.some((flight) => isExecutingFlightState(flight.state));

  const workStats = db().prepare(
    `SELECT
       COUNT(*) AS active_work_count,
       MAX(CASE WHEN state IN ('waiting','review') OR acceptance_state = 'pending' THEN 1 ELSE 0 END) AS attention_work_count,
       MAX(updated_at) AS last_work_at
     FROM collaboration_records
     WHERE kind = 'work_item'
       AND (owner_id = ? OR next_move_owner_id = ?)
       AND state IN ('open','working','waiting','review')`,
  ).get(agentRow.id, agentRow.id) as FleetWorkStatsRow | null;

  const messageStats = db().prepare(
    `SELECT COUNT(*) AS message_count, MAX(created_at) AS last_message_at
     FROM messages m
     WHERE m.actor_id = ?
        OR m.conversation_id IN (
          SELECT cm.conversation_id
          FROM conversation_members cm
          WHERE cm.actor_id = ?
        )`,
  ).get(agentRow.id, agentRow.id) as FleetMessageStatsRow | null;

  const recentActivity = queryFleetActivity({
    agentId: agentRow.id,
    sessionId: agentRow.session_id,
    conversationId,
    limit: 5,
  });

  const activityTimestamps = [
    recentActivity[0]?.ts ?? null,
    latestFlight ? coerceNumber(latestFlight.completed_at ?? latestFlight.started_at) : null,
    coerceNumber(workStats?.last_work_at ?? null),
    coerceNumber(messageStats?.last_message_at ?? null),
    coerceNumber(agentRow.updated_at),
  ].filter((value): value is number => typeof value === "number");

  const lastActiveAt = activityTimestamps.length > 0
    ? Math.max(...activityTimestamps)
    : null;

  const attention: WorkAttention = latestFlight?.state === "failed"
    ? "interrupt"
    : (Number(workStats?.attention_work_count ?? 0) > 0 ? "badge" : "silent");

  const lastActivity = recentActivity[0] ?? null;
  const project = (metadata.project as string) ?? null;
  const branch = (metadata.branch as string) ?? null;
  const role = (metadata.role as string) ?? null;
  const selector = (metadata.selector as string) ?? agentRow.default_selector;

  return {
    id: agentRow.id,
    kind: "agent",
    actorId: agentRow.id,
    agentId: agentRow.id,
    name: agentRow.name,
    handle: agentRow.handle,
    agentClass: agentRow.agent_class,
    role,
    harness: agentRow.harness,
    transport: agentRow.transport,
    state: summarizeAgentState(agentRow.state, isWorking),
    attention,
    conversationId,
    sessionId: agentRow.session_id,
    projectRoot: compact(agentRow.project_root),
    cwd: compact(agentRow.cwd),
    project,
    branch,
    selector,
    wakePolicy: agentRow.wake_policy,
    capabilities,
    messageCount: messageStats?.message_count ?? 0,
    activeFlightCount: activeFlights.length,
    activeWorkCount: workStats?.active_work_count ?? 0,
    lastActiveAt,
    lastActivity,
    activeFlights,
    recentActivity,
  };
}

export function queryFleet(opts?: {
  limit?: number;
  activityLimit?: number;
}): WebFleetState {
  const limit = opts?.limit ?? 100;
  const activityLimit = opts?.activityLimit ?? 80;

  const rows = db().prepare(
    `SELECT
       a.id,
       ac.display_name AS name,
       ac.handle,
       a.agent_class,
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
       ep.updated_at
     FROM agents a
     JOIN actors ac ON ac.id = a.id
     LEFT JOIN agent_endpoints ep ON ep.id = (
       SELECT ep2.id
       FROM agent_endpoints ep2
       WHERE ep2.agent_id = a.id
       ORDER BY ep2.updated_at DESC
       LIMIT 1
     )
     WHERE COALESCE(json_extract(a.metadata_json, '$.retiredFromFleet'), 0) != 1
     ORDER BY COALESCE(ep.updated_at, 0) DESC, ac.display_name ASC
     LIMIT ?`,
  ).all(limit) as Array<FleetAgentRow>;

  const observables = rows.map(queryFleetObservable).sort((left, right) => {
    const attentionDelta = fleetAttentionRank(right.attention) - fleetAttentionRank(left.attention);
    if (attentionDelta !== 0) return attentionDelta;

    const leftAt = left.lastActiveAt ?? 0;
    const rightAt = right.lastActiveAt ?? 0;
    if (rightAt !== leftAt) return rightAt - leftAt;

    return left.name.localeCompare(right.name);
  });

  const activity = queryFleetActivity({ limit: activityLimit });

  const totals = observables.reduce<WebFleetState["totals"]>((acc, observable) => {
    acc.observables += 1;
    acc.activeFlights += observable.activeFlightCount;
    acc.activeWork += observable.activeWorkCount;
    acc.messages += observable.messageCount;
    switch (observable.attention) {
      case "interrupt":
        acc.interrupt += 1;
        break;
      case "badge":
        acc.badge += 1;
        break;
      default:
        acc.silent += 1;
        break;
    }
    return acc;
  }, {
    observables: 0,
    activity: activity.length,
    activeFlights: 0,
    activeWork: 0,
    messages: 0,
    silent: 0,
    badge: 0,
    interrupt: 0,
  });

  return {
    generatedAt: Date.now(),
    totals,
    observables,
    activity,
  };
}

export function queryFlights(opts?: {
  agentId?: string;
  conversationId?: string;
  collaborationRecordId?: string;
  activeOnly?: boolean;
}): WebFlight[] {
  const where = sqlJoinClauses([
    opts?.activeOnly ? `f.state IN ${ACTIVE_FLIGHT_STATES_SQL}` : null,
    opts?.activeOnly ? `(COALESCE(f.started_at, inv.created_at, 0) < ${EPOCH_MILLISECONDS_FLOOR} OR COALESCE(f.started_at, inv.created_at, 0) >= ?)` : null,
    opts?.agentId ? `f.target_agent_id = ?` : null,
    opts?.conversationId ? `inv.conversation_id = ?` : null,
    opts?.collaborationRecordId ? `inv.collaboration_record_id = ?` : null,
  ]);

  const sql = `SELECT
    f.id,
    f.invocation_id,
    f.target_agent_id,
    ac.display_name AS agent_name,
    inv.conversation_id,
    inv.collaboration_record_id,
    f.state,
    f.summary,
    f.started_at,
    f.completed_at
  FROM flights f
  JOIN invocations inv ON inv.id = f.invocation_id
  LEFT JOIN actors ac ON ac.id = f.target_agent_id
  ${sqlWhereClause([where])}
  ORDER BY f.started_at DESC NULLS LAST
  LIMIT 100`;

  const params: string[] = [];
  if (opts?.activeOnly) params.push(String(Date.now() - ACTIVE_FLIGHT_MAX_AGE_MS));
  if (opts?.agentId) params.push(opts.agentId);
  if (opts?.conversationId) params.push(opts.conversationId);
  if (opts?.collaborationRecordId) params.push(opts.collaborationRecordId);

  const rows = db().prepare(sql).all(...params) as Array<{
    id: string;
    invocation_id: string;
    target_agent_id: string;
    agent_name: string | null;
    conversation_id: string | null;
    collaboration_record_id: string | null;
    state: string;
    summary: string | null;
    started_at: number | null;
    completed_at: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    invocationId: r.invocation_id,
    agentId: r.target_agent_id,
    agentName: r.agent_name,
    conversationId: r.conversation_id,
    collaborationRecordId: r.collaboration_record_id,
    state: r.state,
    summary: r.summary,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  }));
}

export function queryWorkItems(opts?: {
  agentId?: string;
  activeOnly?: boolean;
  limit?: number;
}): WebWorkItem[] {
  const where = sqlJoinClauses([
    "cr.kind = 'work_item'",
    opts?.activeOnly !== false ? `cr.state IN ${ACTIVE_WORK_STATES_SQL}` : null,
    opts?.agentId ? "(cr.owner_id = ? OR cr.next_move_owner_id = ?)" : null,
  ]);

  const sql = `SELECT
    cr.id,
    cr.title,
    cr.summary,
    cr.owner_id,
    owner.display_name AS owner_name,
    cr.next_move_owner_id,
    next.display_name AS next_move_owner_name,
    cr.conversation_id,
    cr.state,
    cr.acceptance_state,
    cr.priority,
    cr.updated_at,
    json_extract(cr.detail_json, '$.progress.summary') AS progress_summary,
    (
      SELECT COUNT(*)
      FROM collaboration_records child
      WHERE child.parent_id = cr.id
        AND child.kind = 'work_item'
        AND child.state IN ${ACTIVE_WORK_STATES_SQL}
    ) AS active_child_work_count,
    (
      SELECT COUNT(*)
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
        AND f.state NOT IN ('completed','failed','cancelled')
    ) AS active_flight_count,
    (
      SELECT f.state
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
        AND f.state NOT IN ('completed','failed','cancelled')
      ORDER BY COALESCE(f.started_at, f.completed_at, 0) DESC
      LIMIT 1
    ) AS active_flight_state,
    (
      SELECT f.summary
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
        AND f.state NOT IN ('completed','failed','cancelled')
      ORDER BY COALESCE(f.started_at, f.completed_at, 0) DESC
      LIMIT 1
    ) AS active_flight_summary,
    (
      SELECT f.state
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
      ORDER BY COALESCE(f.completed_at, f.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_state,
    (
      SELECT COALESCE(f.completed_at, f.started_at)
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
      ORDER BY COALESCE(f.completed_at, f.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_at,
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
        SELECT COALESCE(f.completed_at, f.started_at)
        FROM flights f
        JOIN invocations inv ON inv.id = f.invocation_id
        WHERE inv.collaboration_record_id = cr.id
        ORDER BY COALESCE(f.completed_at, f.started_at, 0) DESC
        LIMIT 1
      ), 0)
    ) AS sort_ts
  FROM collaboration_records cr
  LEFT JOIN actors owner ON owner.id = cr.owner_id
  LEFT JOIN actors next ON next.id = cr.next_move_owner_id
  ${sqlWhereClause([where])}
  ORDER BY sort_ts DESC, cr.updated_at DESC
  LIMIT ?`;

  const limit = opts?.limit ?? 50;
  const params: Array<string | number> = [];
  if (opts?.agentId) {
    params.push(opts.agentId, opts.agentId);
  }
  params.push(limit);

  const rows = db().prepare(sql).all(...params) as Array<{
    id: string;
    title: string;
    summary: string | null;
    owner_id: string | null;
    owner_name: string | null;
    next_move_owner_id: string | null;
    next_move_owner_name: string | null;
    conversation_id: string | null;
    state: string;
    acceptance_state: string;
    priority: string | null;
    updated_at: number;
    progress_summary: string | null;
    active_child_work_count: number;
    active_flight_count: number;
    active_flight_state: string | null;
    active_flight_summary: string | null;
    latest_flight_state: string | null;
    latest_flight_at: number | string | null;
    latest_event_summary: string | null;
    latest_event_at: number | string | null;
    sort_ts: number;
  }>;

  return rows.map(projectWorkItemRow);
}

export function queryWorkItemById(id: string): WebWorkDetail | null {
  const sql = `SELECT
    cr.id,
    cr.title,
    cr.summary,
    cr.owner_id,
    owner.display_name AS owner_name,
    cr.next_move_owner_id,
    next.display_name AS next_move_owner_name,
    cr.conversation_id,
    cr.state,
    cr.acceptance_state,
    cr.priority,
    cr.created_at,
    cr.updated_at,
    cr.parent_id,
    parent.title AS parent_title,
    json_extract(cr.detail_json, '$.progress.summary') AS progress_summary,
    (
      SELECT COUNT(*)
      FROM collaboration_records child
      WHERE child.parent_id = cr.id
        AND child.kind = 'work_item'
        AND child.state IN ${ACTIVE_WORK_STATES_SQL}
    ) AS active_child_work_count,
    (
      SELECT COUNT(*)
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
        AND f.state NOT IN ('completed','failed','cancelled')
    ) AS active_flight_count,
    (
      SELECT f.state
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
        AND f.state NOT IN ('completed','failed','cancelled')
      ORDER BY COALESCE(f.started_at, f.completed_at, 0) DESC
      LIMIT 1
    ) AS active_flight_state,
    (
      SELECT f.summary
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
        AND f.state NOT IN ('completed','failed','cancelled')
      ORDER BY COALESCE(f.started_at, f.completed_at, 0) DESC
      LIMIT 1
    ) AS active_flight_summary,
    (
      SELECT f.state
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
      ORDER BY COALESCE(f.completed_at, f.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_state,
    (
      SELECT COALESCE(f.completed_at, f.started_at)
      FROM flights f
      JOIN invocations inv ON inv.id = f.invocation_id
      WHERE inv.collaboration_record_id = cr.id
      ORDER BY COALESCE(f.completed_at, f.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_at,
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
    ) AS latest_event_at
  FROM collaboration_records cr
  LEFT JOIN actors owner ON owner.id = cr.owner_id
  LEFT JOIN actors next ON next.id = cr.next_move_owner_id
  LEFT JOIN collaboration_records parent ON parent.id = cr.parent_id
  WHERE cr.kind = 'work_item' AND cr.id = ?
  LIMIT 1`;

  const row = db().prepare(sql).get(id) as ({
    id: string;
    title: string;
    summary: string | null;
    owner_id: string | null;
    owner_name: string | null;
    next_move_owner_id: string | null;
    next_move_owner_name: string | null;
    conversation_id: string | null;
    state: string;
    acceptance_state: string;
    priority: string | null;
    created_at: number;
    updated_at: number;
    parent_id: string | null;
    parent_title: string | null;
    progress_summary: string | null;
    active_child_work_count: number;
    active_flight_count: number;
    active_flight_state: string | null;
    active_flight_summary: string | null;
    latest_flight_state: string | null;
    latest_flight_at: number | string | null;
    latest_event_summary: string | null;
    latest_event_at: number | string | null;
  }) | null;

  if (!row) return null;

  const base = projectWorkItemRow(row);

  const childWorkRows = db().prepare(
    `SELECT cr.id FROM collaboration_records cr
     WHERE cr.parent_id = ? AND cr.kind = 'work_item'
     ORDER BY cr.updated_at DESC
     LIMIT 50`,
  ).all(row.id) as Array<{ id: string }>;

  const childWork: WebWorkItem[] = childWorkRows
    .map((child) => queryWorkItemShallow(child.id))
    .filter((item): item is WebWorkItem => item !== null);

  const activeFlights = queryFlights({
    collaborationRecordId: row.id,
    activeOnly: true,
  });

  const timeline = queryWorkTimeline(row.id);

  return {
    ...base,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parentId: row.parent_id,
    parentTitle: row.parent_title,
    childWork,
    activeFlights,
    timeline,
  };
}

function queryWorkItemShallow(id: string): WebWorkItem | null {
  const sql = `SELECT
    cr.id,
    cr.title,
    cr.summary,
    cr.owner_id,
    owner.display_name AS owner_name,
    cr.next_move_owner_id,
    next.display_name AS next_move_owner_name,
    cr.conversation_id,
    cr.state,
    cr.acceptance_state,
    cr.priority,
    cr.updated_at,
    json_extract(cr.detail_json, '$.progress.summary') AS progress_summary,
    0 AS active_child_work_count,
    0 AS active_flight_count,
    NULL AS active_flight_state,
    NULL AS active_flight_summary,
    NULL AS latest_flight_state,
    NULL AS latest_flight_at,
    NULL AS latest_event_summary,
    NULL AS latest_event_at
  FROM collaboration_records cr
  LEFT JOIN actors owner ON owner.id = cr.owner_id
  LEFT JOIN actors next ON next.id = cr.next_move_owner_id
  WHERE cr.kind = 'work_item' AND cr.id = ?
  LIMIT 1`;
  const row = db().prepare(sql).get(id) as Parameters<typeof projectWorkItemRow>[0] | null;
  return row ? projectWorkItemRow(row) : null;
}

function queryWorkTimeline(workId: string): WebWorkTimelineItem[] {
  const items: WebWorkTimelineItem[] = [];

  const events = db().prepare(
    `SELECT e.id, e.kind, e.summary, e.created_at, e.actor_id,
            ac.display_name AS actor_name
     FROM collaboration_events e
     LEFT JOIN actors ac ON ac.id = e.actor_id
     WHERE e.record_id = ?
     ORDER BY e.created_at DESC
     LIMIT 50`,
  ).all(workId) as Array<{
    id: string;
    kind: string;
    summary: string | null;
    created_at: number;
    actor_id: string | null;
    actor_name: string | null;
  }>;
  for (const event of events) {
    items.push({
      id: `event:${event.id}`,
      kind: "collaboration_event",
      at: event.created_at,
      actorId: event.actor_id,
      actorName: event.actor_name,
      title: event.kind.replace(/[._]/g, " "),
      summary: event.summary,
      detailKind: event.kind,
      flightId: null,
      messageId: null,
      conversationId: null,
    });
  }

  const flights = db().prepare(
    `SELECT f.id, f.state, f.summary, f.started_at, f.completed_at,
            f.target_agent_id,
            ac.display_name AS agent_name
     FROM flights f
     JOIN invocations inv ON inv.id = f.invocation_id
     LEFT JOIN actors ac ON ac.id = f.target_agent_id
     WHERE inv.collaboration_record_id = ?
     ORDER BY COALESCE(f.completed_at, f.started_at, 0) DESC
     LIMIT 50`,
  ).all(workId) as Array<{
    id: string;
    state: string;
    summary: string | null;
    started_at: number | null;
    completed_at: number | null;
    target_agent_id: string;
    agent_name: string | null;
  }>;
  for (const flight of flights) {
    if (typeof flight.started_at === "number") {
      items.push({
        id: `flight:${flight.id}:started`,
        kind: "flight_started",
        at: flight.started_at,
        actorId: flight.target_agent_id,
        actorName: flight.agent_name,
        title: "flight started",
        summary: flight.summary,
        detailKind: flight.state,
        flightId: flight.id,
        messageId: null,
        conversationId: null,
      });
    }
    if (typeof flight.completed_at === "number") {
      items.push({
        id: `flight:${flight.id}:completed`,
        kind: "flight_completed",
        at: flight.completed_at,
        actorId: flight.target_agent_id,
        actorName: flight.agent_name,
        title: `flight ${flight.state}`,
        summary: flight.summary,
        detailKind: flight.state,
        flightId: flight.id,
        messageId: null,
        conversationId: null,
      });
    }
  }

  items.sort((left, right) => right.at - left.at);
  return items.slice(0, 80);
}

/* ── ID derivation (no DB needed) ── */

/**
 * Derive the conversation ID for an operator↔agent direct message.
 * Convention: `dm.operator.{agentId}`
 */
export function conversationIdForAgent(agentId: string): string {
  return `dm.operator.${agentId}`;
}

/* ── Mobile-compatible queries ── */
/* Return the same shapes the iOS app expects so the bridge router
   can serve reads from SQLite instead of expensive broker snapshots. */

export type MobileAgentSummary = {
  id: string;
  title: string;
  selector: string | null;
  defaultSelector: string | null;
  nodeId: string | null;
  nodeName: string | null;
  workspaceRoot: string | null;
  harness: string | null;
  transport: string | null;
  state: "offline" | "available" | "working";
  statusLabel: string;
  sessionId: string | null;
  lastActiveAt: number | null;
};

export function queryMobileAgents(limit = 50): MobileAgentSummary[] {
  const executingAgentIds = queryExecutingAgentIds();

  // Latest message timestamp per actor (for lastActiveAt)
  const lastMessageAt = new Map(
    (db().prepare(
      `SELECT actor_id, MAX(created_at) AS last_at FROM messages GROUP BY actor_id`,
    ).all() as Array<{ actor_id: string; last_at: number }>).map((r) => [r.actor_id, r.last_at]),
  );

  const rows = db().prepare(
    `SELECT
       a.id,
       ac.display_name,
       a.default_selector,
       a.metadata_json,
       ep.harness,
       ep.transport,
       ep.state,
       ep.project_root,
       ep.session_id,
       ep.updated_at,
       COALESCE(ep.node_id, a.authority_node_id, a.home_node_id) AS node_id,
       n.name AS node_name
     FROM agents a
     JOIN actors ac ON ac.id = a.id
     ${LATEST_AGENT_ENDPOINT_JOIN}
     LEFT JOIN nodes n ON n.id = COALESCE(ep.node_id, a.authority_node_id, a.home_node_id)
     ORDER BY COALESCE(ep.updated_at, 0) DESC, ac.display_name ASC
     LIMIT ?`,
  ).all(limit) as Array<{
    id: string;
    display_name: string;
    default_selector: string | null;
    metadata_json: string | null;
    harness: string | null;
    transport: string | null;
    state: string | null;
    project_root: string | null;
    session_id: string | null;
    updated_at: number | null;
    node_id: string | null;
    node_name: string | null;
  }>;

  return rows.map((r) => {
    let meta: Record<string, unknown> = {};
    try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch {}

    const isWorking = executingAgentIds.has(r.id);
    const state = summarizeAgentState(r.state, isWorking);
    const statusLabel = summarizeAgentStatusLabel(r.state, isWorking);

    return {
      id: r.id,
      title: r.display_name,
      selector: (meta.selector as string) ?? null,
      defaultSelector: r.default_selector,
      nodeId: compact(r.node_id),
      nodeName: compact(r.node_name),
      workspaceRoot: compact(r.project_root),
      harness: r.harness,
      transport: r.transport,
      state,
      statusLabel,
      sessionId: conversationIdForAgent(r.id),
      lastActiveAt: lastMessageAt.get(r.id) ?? null,
    };
  });
}

export type MobileSessionSummary = {
  id: string;
  kind: string;
  title: string;
  participantIds: string[];
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  currentBranch: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  workspaceRoot: string | null;
};

export function queryMobileSessions(limit = 50): MobileSessionSummary[] {
  const conversationCreatedAtExpression = sqlTimestampMsExpression("c.created_at");
  const messageCreatedAtExpression = sqlTimestampMsExpression("created_at");
  const previewMessageCreatedAtExpression = sqlTimestampMsExpression("created_at");
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
    `SELECT body FROM messages WHERE conversation_id = ? AND actor_id != 'operator'
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
    let branch: string | null = null;
    let workspaceRoot: string | null = null;

    if (agentId) {
      const agentRow = db().prepare(
        `SELECT ac.display_name, ep.harness, ep.project_root, a.metadata_json
         FROM agents a
         JOIN actors ac ON ac.id = a.id
         LEFT JOIN agent_endpoints ep ON ep.agent_id = a.id
         WHERE a.id = ?`,
      ).get(agentId) as {
        display_name: string;
        harness: string | null;
        project_root: string | null;
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
      currentBranch: branch,
      preview: preview ? preview.slice(0, 200) : null,
      messageCount: stats?.cnt ?? 0,
      lastMessageAt: stats?.last_at ?? null,
      workspaceRoot,
    };
  });
}

export type MobileWorkspaceSummary = {
  id: string;
  title: string;
  projectName: string;
  root: string;
  sourceRoot: string;
  relativePath: string;
  registrationKind: string;
  defaultHarness: string;
  harnesses: Array<{
    harness: string;
    source: "manifest" | "marker" | "default" | "endpoint";
    detail: string;
    readinessState: "ready" | "configured" | "installed" | "missing" | null;
    readinessDetail: string | null;
  }>;
};

/** Derive workspaces from agents in the DB — no filesystem scan needed. */
export function queryMobileWorkspaces(limit = 50): MobileWorkspaceSummary[] {
  const rows = db().prepare(
    `SELECT DISTINCT
       ep.project_root,
       ac.display_name,
       a.metadata_json,
       ep.harness
     FROM agents a
     JOIN actors ac ON ac.id = a.id
     LEFT JOIN agent_endpoints ep ON ep.agent_id = a.id
     WHERE ep.project_root IS NOT NULL
     ORDER BY ep.updated_at DESC NULLS LAST
     LIMIT ?`,
  ).all(limit) as Array<{
    project_root: string;
    display_name: string;
    metadata_json: string | null;
    harness: string | null;
  }>;

  const seen = new Set<string>();
  const results: MobileWorkspaceSummary[] = [];

  for (const r of rows) {
    if (seen.has(r.project_root)) continue;
    seen.add(r.project_root);

    let meta: Record<string, unknown> = {};
    try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch {}

    const projectName = (meta.project as string) ?? r.project_root.split("/").pop() ?? "unknown";
    const relativePath = r.project_root.replace(HOME + "/", "");

    results.push({
      id: r.project_root,
      title: projectName,
      projectName,
      root: r.project_root,
      sourceRoot: r.project_root,
      relativePath,
      registrationKind: "agent",
      defaultHarness: r.harness ?? "claude",
      harnesses: r.harness
        ? [{
            harness: r.harness,
            source: "default",
            detail: "Current endpoint",
            readinessState: "ready",
            readinessDetail: null,
          }]
        : [],
    });
  }

  return results;
}

/* ── Agent detail (single agent, richer data) ── */

export type MobileAgentDetail = MobileAgentSummary & {
  cwd: string | null;
  wakePolicy: string | null;
  capabilities: string[];
  branch: string | null;
  role: string | null;
  model: string | null;
  activeFlights: Array<{
    id: string;
    state: string;
    summary: string | null;
    startedAt: number | null;
  }>;
  recentActivity: Array<{
    id: string;
    kind: string;
    ts: number;
    title: string | null;
    summary: string | null;
  }>;
  messageCount: number;
};

export function queryMobileAgentDetail(agentId: string): MobileAgentDetail | null {
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
       ep.updated_at,
       COALESCE(ep.node_id, a.authority_node_id, a.home_node_id) AS node_id,
       n.name AS node_name
     FROM agents a
     JOIN actors ac ON ac.id = a.id
     ${LATEST_AGENT_ENDPOINT_JOIN}
     LEFT JOIN nodes n ON n.id = COALESCE(ep.node_id, a.authority_node_id, a.home_node_id)
     WHERE a.id = ?`,
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
    node_id: string | null;
    node_name: string | null;
  } | null;

  if (!row) return null;

  let meta: Record<string, unknown> = {};
  try { meta = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}

  let capabilities: string[] = [];
  try { capabilities = row.capabilities_json ? JSON.parse(row.capabilities_json) : []; } catch {}

  const executingAgentIds = queryExecutingAgentIds();

  const activeFlights = (db().prepare(
    `SELECT id, state, summary, started_at
     FROM flights
     WHERE target_agent_id = ? AND state NOT IN ('completed','failed','cancelled')
     ORDER BY started_at DESC`,
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

  // Recent activity
  const recentActivity = (db().prepare(
    `SELECT ai.id, ai.kind, ai.ts, ai.title, ai.summary
     FROM activity_items ai
     WHERE ai.actor_id = ?
     ORDER BY ai.ts DESC
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

  // Message count
  const msgRow = db().prepare(
    `SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?`,
  ).get(conversationIdForAgent(agentId)) as { cnt: number } | null;
  const messageCount = msgRow?.cnt ?? 0;

  // Last message timestamp
  const lastMessageAt = (db().prepare(
    `SELECT MAX(created_at) AS last_at FROM messages WHERE actor_id = ?`,
  ).get(agentId) as { last_at: number | null } | null)?.last_at ?? null;

  const isWorking = executingAgentIds.has(row.id);
  const state = summarizeAgentState(row.state, isWorking);
  const statusLabel = summarizeAgentStatusLabel(row.state, isWorking);

  return {
    id: row.id,
    title: row.display_name,
    selector: (meta.selector as string) ?? null,
    defaultSelector: row.default_selector,
    nodeId: compact(row.node_id),
    nodeName: compact(row.node_name),
    workspaceRoot: compact(row.project_root),
    harness: row.harness,
    transport: row.transport,
    state,
    statusLabel,
    sessionId: conversationIdForAgent(row.id),
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
