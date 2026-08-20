/**
 * Work-item queries — current state, child-work fan-out, timeline.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. `queryWorkItemById`
 * composes its detail page from the shallow record, the per-record flight
 * list (`queryFlights` from `./runs.ts`), and a synthesized timeline of
 * collaboration events plus flight start/complete markers. The shallow
 * helper `queryWorkItemShallow` is kept private — it is only used to flesh
 * out child-work entries.
 *
 * `projectWorkItemRow` + its phase/attention helpers live here (moved out of
 * `./internal/sql-helpers.ts` per codex review: domain logic belongs with
 * the domain, not in shared SQL plumbing).
 *
 * There is a small import cycle work.ts ↔ runs.ts (work needs
 * `queryFlights`, runs needs `queryWorkItemById`). It is safe because
 * neither reference is evaluated at module-init time; both are called
 * from function bodies that run after both modules have finished loading.
 */

import { db } from "./internal/db.ts";
import { configuredOperatorActorIds, conversationIdAliases } from "./internal/conversation-ids.ts";
import { coerceNumber, metadataString, parseJson } from "./internal/parse.ts";
import { resolveHarnessSessionId } from "./internal/paths.ts";
import {
  ACTIVE_WORK_STATES_SQL,
  sqlJoinClauses,
  sqlPlaceholders,
  sqlWhereClause,
} from "./internal/sql-helpers.ts";
import { queryFlights } from "./runs.ts";
import type { WorkAttention } from "./types/common.ts";
import type {
  WebFlight,
  WebWorkDetail,
  WebWorkInvocation,
  WebWorkItem,
  WebWorkTimelineItem,
} from "./types/web.ts";

/* ── Work-item phase + attention helpers ── */

export function workPhaseFromFlightState(state: string | null): string | null {
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

export function workPhaseFromState(state: string): string {
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

export function workAttention(row: {
  updated_at: number;
  state: string;
  acceptance_state: string;
  latest_flight_state: string | null;
  latest_flight_at: number | string | null;
  latest_dismissed_at: number | string | null;
}): WorkAttention {
  const dismissedAt = coerceNumber(row.latest_dismissed_at);
  const updatedAt = coerceNumber(row.updated_at) ?? 0;
  const latestFlightAt = coerceNumber(row.latest_flight_at);
  const failedFlightDismissed = Boolean(
    dismissedAt !== null
    && dismissedAt >= (latestFlightAt ?? updatedAt),
  );
  const recordAttentionDismissed = Boolean(
    dismissedAt !== null
    && dismissedAt >= updatedAt,
  );

  if (row.latest_flight_state === "failed" && !failedFlightDismissed) {
    return "interrupt";
  }
  if (
    !recordAttentionDismissed
    && (row.state === "waiting" || row.state === "review" || row.acceptance_state === "pending")
  ) {
    return "badge";
  }
  return "silent";
}

export function projectWorkItemRow(row: {
  id: string;
  title: string;
  summary: string | null;
  owner_id: string | null;
  owner_name: string | null;
  next_move_owner_id: string | null;
  next_move_owner_name: string | null;
  conversation_id: string | null;
  created_at?: number;
  state: string;
  acceptance_state: string;
  priority: string | null;
  updated_at: number;
  parent_id?: string | null;
  parent_title?: string | null;
  active_child_work_count: number;
  active_flight_count: number;
  active_flight_state: string | null;
  active_flight_summary: string | null;
  latest_flight_state: string | null;
  latest_flight_at: number | string | null;
  latest_dismissed_at: number | string | null;
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
    createdAt: coerceNumber(row.created_at ?? row.updated_at) ?? updatedAt,
    updatedAt,
    parentId: row.parent_id ?? null,
    parentTitle: row.parent_title ?? null,
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

export function queryWorkItemById(id: string): WebWorkDetail | null {
  const operatorIds = configuredOperatorActorIds();
  const operatorClause = sqlPlaceholders(operatorIds.length);
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
      SELECT inv.state
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_state,
    (
      SELECT COALESCE(inv.completed_at, inv.started_at)
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
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
    (
      SELECT e.created_at
      FROM collaboration_events e
      WHERE e.record_id = cr.id
        AND e.kind = 'dismissed'
        AND e.actor_id IN (${operatorClause})
      ORDER BY e.created_at DESC
      LIMIT 1
    ) AS latest_dismissed_at
  FROM collaboration_records cr
  LEFT JOIN actors owner ON owner.id = cr.owner_id
  LEFT JOIN actors next ON next.id = cr.next_move_owner_id
  LEFT JOIN collaboration_records parent ON parent.id = cr.parent_id
  WHERE cr.kind = 'work_item' AND cr.id = ?
  LIMIT 1`;

  const row = db().prepare(sql).get(...operatorIds, id) as ({
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
    latest_dismissed_at: number | string | null;
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
    .map((c) => queryWorkItemShallow(c.id))
    .filter((item): item is WebWorkItem => item !== null);

  const activeFlights = queryFlights({
    collaborationRecordId: row.id,
    activeOnly: true,
  });
  const allFlights = queryFlights({
    collaborationRecordId: row.id,
    activeOnly: false,
  });
  const primaryInvocation = queryPrimaryWorkInvocation(row.id, allFlights);

  const timeline = queryWorkTimeline(row.id, {
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    nextMoveOwnerId: row.next_move_owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    ...base,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parentId: row.parent_id,
    parentTitle: row.parent_title,
    childWork,
    activeFlights,
    timeline,
    primaryInvocation,
    allFlights,
  };
}


function queryPrimaryWorkInvocation(workId: string, flights: WebFlight[]): WebWorkInvocation | null {
  const latestFlightByInvocation = new Map<string, WebFlight>();
  for (const flight of flights) {
    const existing = latestFlightByInvocation.get(flight.invocationId);
    const existingTs = Math.max(existing?.completedAt ?? 0, existing?.startedAt ?? 0);
    const nextTs = Math.max(flight.completedAt ?? 0, flight.startedAt ?? 0);
    if (!existing || nextTs >= existingTs) {
      latestFlightByInvocation.set(flight.invocationId, flight);
    }
  }

  const row = db().prepare(
    `SELECT
       inv.id AS invocation_id,
       inv.action,
       inv.task,
       inv.conversation_id,
       inv.collaboration_record_id,
       inv.requester_id,
       requester.display_name AS requester_name,
       inv.target_agent_id,
       target.display_name AS target_agent_name,
       inv.execution_json,
       inv.execution_resolution_json,
       inv.metadata_json,
       inv.created_at,
       ep.harness AS endpoint_harness,
       ep.transport AS endpoint_transport,
       ep.session_id AS endpoint_session_id,
       ep.metadata_json AS endpoint_metadata_json
     FROM invocations inv
     LEFT JOIN actors requester ON requester.id = inv.requester_id
     LEFT JOIN actors target ON target.id = inv.target_agent_id
     LEFT JOIN agent_endpoints ep ON ep.id = (
       SELECT ep2.id
       FROM agent_endpoints ep2
       WHERE ep2.agent_id = inv.target_agent_id
       ORDER BY ep2.updated_at DESC
       LIMIT 1
     )
     WHERE inv.collaboration_record_id = ?
     ORDER BY inv.created_at ASC
     LIMIT 1`,
  ).get(workId) as {
    invocation_id: string;
    action: string;
    task: string;
    conversation_id: string | null;
    collaboration_record_id: string | null;
    requester_id: string | null;
    requester_name: string | null;
    target_agent_id: string | null;
    target_agent_name: string | null;
    execution_json: string | null;
    execution_resolution_json: string | null;
    metadata_json: string | null;
    created_at: number;
    endpoint_harness: string | null;
    endpoint_transport: string | null;
    endpoint_session_id: string | null;
    endpoint_metadata_json: string | null;
  } | null;

  if (!row) {
    return null;
  }

  const execution = parseJson<Record<string, unknown>>(row.execution_json, {});
  const executionResolution = parseJson<Record<string, unknown>>(row.execution_resolution_json, {});
  const resolutionDimension = (key: string): Record<string, unknown> => {
    const value = executionResolution[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  };
  const harnessResolution = resolutionDimension("harness");
  const modelResolution = resolutionDimension("model");
  const effortResolution = resolutionDimension("reasoningEffort");
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  const endpointMetadata = parseJson<Record<string, unknown>>(row.endpoint_metadata_json, {});
  const flight = latestFlightByInvocation.get(row.invocation_id) ?? null;
  const targetSessionId = metadataString(execution, "targetSessionId")
    ?? metadataString(metadata, "targetSessionId");
  const resolvedSessionId = targetSessionId
    ?? resolveHarnessSessionId(row.endpoint_transport, row.endpoint_session_id, endpointMetadata);

  return {
    invocationId: row.invocation_id,
    flightId: flight?.id ?? null,
    action: row.action,
    task: row.task,
    source: metadataString(metadata, "source"),
    requestedHarness: metadataString(harnessResolution, "requested") ?? metadataString(execution, "harness"),
    requestedModel: metadataString(modelResolution, "requested") ?? metadataString(execution, "model"),
    requestedReasoningEffort: metadataString(effortResolution, "requested")
      ?? metadataString(execution, "reasoningEffort"),
    requestedPermissionProfile: metadataString(execution, "permissionProfile"),
    targetSessionId,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    targetAgentId: row.target_agent_id,
    targetAgentName: row.target_agent_name,
    resolvedHarness: metadataString(harnessResolution, "resolved") ?? row.endpoint_harness,
    resolvedModel: metadataString(modelResolution, "resolved"),
    resolvedReasoningEffort: metadataString(effortResolution, "resolved"),
    observedHarness: metadataString(harnessResolution, "observed"),
    observedModel: metadataString(modelResolution, "observed"),
    observedReasoningEffort: metadataString(effortResolution, "observed"),
    resolvedTransport: row.endpoint_transport,
    resolvedSessionId,
    conversationId: row.conversation_id,
    workId: row.collaboration_record_id,
    state: flight?.state ?? null,
    summary: flight?.summary ?? null,
    createdAt: row.created_at,
    startedAt: flight?.startedAt ?? null,
    completedAt: flight?.completedAt ?? null,
  };
}

export function queryWorkItemShallow(id: string): WebWorkItem | null {
  const operatorIds = configuredOperatorActorIds();
  const operatorClause = sqlPlaceholders(operatorIds.length);
  const sql = `SELECT
    cr.id,
    cr.title,
    cr.summary,
    cr.owner_id,
    owner.display_name AS owner_name,
    cr.next_move_owner_id,
    next.display_name AS next_move_owner_name,
    cr.conversation_id,
    cr.created_at,
    cr.state,
    cr.acceptance_state,
    cr.priority,
    cr.updated_at,
    cr.parent_id,
    parent.title AS parent_title,
    json_extract(cr.detail_json, '$.progress.summary') AS progress_summary,
    0 AS active_child_work_count,
    0 AS active_flight_count,
    NULL AS active_flight_state,
    NULL AS active_flight_summary,
    NULL AS latest_flight_state,
    NULL AS latest_flight_at,
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
    ) AS latest_event_at
  FROM collaboration_records cr
  LEFT JOIN actors owner ON owner.id = cr.owner_id
  LEFT JOIN actors next ON next.id = cr.next_move_owner_id
  LEFT JOIN collaboration_records parent ON parent.id = cr.parent_id
  WHERE cr.kind = 'work_item' AND cr.id = ?
  LIMIT 1`;

  const row = db().prepare(sql).get(...operatorIds, id) as Parameters<typeof projectWorkItemRow>[0] | null;
  return row ? projectWorkItemRow(row) : null;
}

export function queryWorkTimeline(
  workId: string,
  context?: {
    conversationId?: string | null;
    ownerId?: string | null;
    nextMoveOwnerId?: string | null;
    createdAt?: number | null;
    updatedAt?: number | null;
  },
): WebWorkTimelineItem[] {
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
  for (const e of events) {
    items.push({
      id: `event:${e.id}`,
      kind: "collaboration_event",
      at: e.created_at,
      actorId: e.actor_id,
      actorName: e.actor_name,
      title: e.kind.replace(/[._]/g, " "),
      summary: e.summary,
      detailKind: e.kind,
      flightId: null,
      messageId: null,
      conversationId: null,
    });
  }

  const explicitFlightIds = new Set<string>();
  const flights = db().prepare(
    `SELECT inv.flight_id AS id, inv.state, inv.summary, inv.started_at, inv.completed_at,
            inv.target_agent_id,
            ac.display_name AS agent_name
     FROM invocations inv
     LEFT JOIN actors ac ON ac.id = inv.target_agent_id
     WHERE inv.collaboration_record_id = ?
       AND inv.flight_id IS NOT NULL
     ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
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
  for (const f of flights) {
    explicitFlightIds.add(f.id);
    if (typeof f.started_at === "number") {
      items.push({
        id: `flight:${f.id}:started`,
        kind: "flight_started",
        at: f.started_at,
        actorId: f.target_agent_id,
        actorName: f.agent_name,
        title: "flight started",
        summary: f.summary,
        detailKind: f.state,
        flightId: f.id,
        messageId: null,
        conversationId: null,
      });
    }
    if (typeof f.completed_at === "number") {
      items.push({
        id: `flight:${f.id}:completed`,
        kind: "flight_completed",
        at: f.completed_at,
        actorId: f.target_agent_id,
        actorName: f.agent_name,
        title: `flight ${f.state}`,
        summary: f.summary,
        detailKind: f.state,
        flightId: f.id,
        messageId: null,
        conversationId: null,
      });
    }
  }

  if (flights.length === 0 && context?.conversationId) {
    const inferredFlights = queryInferredWorkTimelineFlights(context, explicitFlightIds);
    for (const f of inferredFlights) {
      if (typeof f.started_at === "number") {
        items.push({
          id: `inferred-flight:${f.id}:started`,
          kind: "flight_started",
          at: f.started_at,
          actorId: f.target_agent_id,
          actorName: f.agent_name,
          title: "related flight started",
          summary: f.summary,
          detailKind: `${f.state}:inferred`,
          flightId: f.id,
          messageId: f.message_id,
          conversationId: f.conversation_id,
        });
      }
      if (typeof f.completed_at === "number") {
        items.push({
          id: `inferred-flight:${f.id}:completed`,
          kind: "flight_completed",
          at: f.completed_at,
          actorId: f.target_agent_id,
          actorName: f.agent_name,
          title: `related flight ${f.state}`,
          summary: f.summary,
          detailKind: `${f.state}:inferred`,
          flightId: f.id,
          messageId: f.message_id,
          conversationId: f.conversation_id,
        });
      }
    }
  }


  if (context?.conversationId) {
    const conversationIds = conversationIdAliases(context.conversationId);
    if (conversationIds.length > 0) {
      const messages = db().prepare(
        `SELECT m.id, m.body, m.class, m.actor_id, m.conversation_id, m.created_at,
                ac.display_name AS actor_name,
                json_extract(m.metadata_json, '$.workId') AS metadata_work_id,
                json_extract(m.metadata_json, '$.collaborationRecordId') AS metadata_collaboration_record_id
         FROM messages m
         LEFT JOIN actors ac ON ac.id = m.actor_id
         WHERE m.conversation_id IN (${sqlPlaceholders(conversationIds.length)})
           AND m.created_at >= ?
           AND (
             json_extract(m.metadata_json, '$.workId') = ?
             OR json_extract(m.metadata_json, '$.collaborationRecordId') = ?
             OR m.created_at > ?
           )
         ORDER BY m.created_at DESC
         LIMIT 40`,
      ).all(
        ...conversationIds,
        Math.max(0, (context.createdAt ?? 0) - 30_000),
        workId,
        workId,
        context.createdAt ?? 0,
      ) as Array<{
        id: string;
        body: string;
        class: string;
        actor_id: string | null;
        actor_name: string | null;
        conversation_id: string | null;
        created_at: number;
        metadata_work_id: string | null;
        metadata_collaboration_record_id: string | null;
      }>;
      for (const m of messages) {
        const explicitlyAttached = m.metadata_work_id === workId || m.metadata_collaboration_record_id === workId;
        items.push({
          id: `message:${m.id}`,
          kind: "message",
          at: m.created_at,
          actorId: m.actor_id,
          actorName: m.actor_name,
          title: explicitlyAttached ? "Added requirement to work" : "Thread update",
          summary: m.body,
          detailKind: m.class,
          flightId: null,
          messageId: m.id,
          conversationId: m.conversation_id,
        });
      }
    }
  }
  items.sort((left, right) => right.at - left.at);
  return items.slice(0, 80);
}

export function queryInferredWorkTimelineFlights(
  context: {
    conversationId?: string | null;
    ownerId?: string | null;
    nextMoveOwnerId?: string | null;
    createdAt?: number | null;
    updatedAt?: number | null;
  },
  explicitFlightIds: Set<string>,
): Array<{
  id: string;
  state: string;
  summary: string | null;
  started_at: number | null;
  completed_at: number | null;
  target_agent_id: string;
  agent_name: string | null;
  conversation_id: string | null;
  message_id: string | null;
}> {
  if (!context.conversationId) {
    return [];
  }
  const conversationIds = conversationIdAliases(context.conversationId);
  if (conversationIds.length === 0) {
    return [];
  }

  const createdAt = typeof context.createdAt === "number" ? context.createdAt : 0;
  const lowerBound = Math.max(0, createdAt - 30_000);
  const upperBound = Math.max(
    typeof context.updatedAt === "number" ? context.updatedAt : createdAt,
    createdAt + 6 * 60 * 60 * 1000,
  );
  const ownerIds = Array.from(new Set([
    context.ownerId?.trim(),
    context.nextMoveOwnerId?.trim(),
  ].filter((value): value is string => Boolean(value))));
  const ownerClause = ownerIds.length > 0
    ? `inv.target_agent_id IN (${sqlPlaceholders(ownerIds.length)})`
    : null;

  const rows = db().prepare(
    `SELECT inv.flight_id AS id, inv.state, inv.summary, inv.started_at, inv.completed_at,
            inv.target_agent_id,
            inv.conversation_id,
            inv.message_id,
            ac.display_name AS agent_name
     FROM invocations inv
     LEFT JOIN actors ac ON ac.id = inv.target_agent_id
     WHERE inv.collaboration_record_id IS NULL
       AND inv.flight_id IS NOT NULL
       AND inv.conversation_id IN (${sqlPlaceholders(conversationIds.length)})
       AND inv.created_at BETWEEN ? AND ?
       ${ownerClause ? `AND ${ownerClause}` : ""}
     ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
     LIMIT 20`,
  ).all(
    ...conversationIds,
    lowerBound,
    upperBound,
    ...(ownerClause ? ownerIds : []),
  ) as Array<{
    id: string;
    state: string;
    summary: string | null;
    started_at: number | null;
    completed_at: number | null;
    target_agent_id: string;
    agent_name: string | null;
    conversation_id: string | null;
    message_id: string | null;
  }>;

  return rows.filter((row) => !explicitFlightIds.has(row.id));
}

export function queryWorkItems(opts?: {
  agentId?: string;
  conversationId?: string;
  activeOnly?: boolean;
  limit?: number;
}): WebWorkItem[] {
  const operatorIds = configuredOperatorActorIds();
  const operatorClause = sqlPlaceholders(operatorIds.length);
  const conversationIds = opts?.conversationId ? conversationIdAliases(opts.conversationId) : [];
  const where = sqlJoinClauses([
    "cr.kind = 'work_item'",
    opts?.activeOnly !== false ? `cr.state IN ${ACTIVE_WORK_STATES_SQL}` : null,
    conversationIds.length > 0
      ? `cr.conversation_id IN (${sqlPlaceholders(conversationIds.length)})`
      : null,
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
    cr.created_at,
    cr.state,
    cr.acceptance_state,
    cr.priority,
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
      SELECT inv.state
      FROM invocations inv
      WHERE inv.collaboration_record_id = cr.id
        AND inv.flight_id IS NOT NULL
      ORDER BY COALESCE(inv.completed_at, inv.started_at, 0) DESC
      LIMIT 1
    ) AS latest_flight_state,
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
  LEFT JOIN actors next ON next.id = cr.next_move_owner_id
  LEFT JOIN collaboration_records parent ON parent.id = cr.parent_id
  ${sqlWhereClause([where])}
  ORDER BY sort_ts DESC, cr.updated_at DESC
  LIMIT ?`;

  const limit = opts?.limit ?? 50;
  const params: Array<string | number> = [...operatorIds];
  if (conversationIds.length > 0) {
    params.push(...conversationIds);
  }
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
    created_at: number;
    state: string;
    acceptance_state: string;
    priority: string | null;
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
    latest_dismissed_at: number | string | null;
    latest_event_summary: string | null;
    latest_event_at: number | string | null;
    sort_ts: number;
  }>;

  return rows.map(projectWorkItemRow);
}
