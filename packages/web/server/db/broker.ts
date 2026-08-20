/**
 * Broker diagnostics — surfaces routing successes/failures, delivery
 * attempts, and recent dialogue for the operator console.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. Helper predicates
 * for metadata shape (`metadataTarget`, `metadataRoute`,
 * `isBrokerRoutedMessage`, `shortBrokerBody`) are kept private to this
 * module — they are only used by `queryBrokerDiagnostics`.
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { db } from "./internal/db.ts";
import { sqlTimestampMsExpression } from "./internal/sql-helpers.ts";
import { normalizeTimestampMs, parseJson } from "./internal/parse.ts";
import type {
  WebBrokerDialogueItem,
  WebBrokerDiagnostics,
  WebBrokerHistoryKey,
  WebBrokerRouteAttempt,
} from "./types/web.ts";

type BrokerCursor = {
  ts: number;
  id: string;
};

type MessageRow = {
  id: string;
  sort_id: string;
  ts: number;
  conversation_id: string;
  actor_id: string;
  actor_name: string | null;
  body: string;
  class: string;
  metadata_json: string | null;
  created_at: number;
};

type DispatchRow = {
  id: string;
  sort_id: string;
  ts: number;
  kind: string;
  asked_label: string;
  detail: string;
  invocation_id: string | null;
  conversation_id: string | null;
  requester_id: string | null;
  actor_name: string | null;
  dispatched_at: number;
  invocation_execution_json: string | null;
  invocation_execution_resolution_json: string | null;
};

type DeliveryRow = {
  id: string;
  sort_id: string;
  ts: number;
  message_id: string | null;
  message_actor_id: string | null;
  message_actor_name: string | null;
  message_body: string | null;
  message_metadata_json: string | null;
  invocation_id: string | null;
  target_id: string;
  transport: string;
  reason: string;
  status: string;
  created_at: number;
  conversation_id: string | null;
  actor_name: string | null;
  metadata_json: string | null;
  invocation_execution_json: string | null;
  invocation_execution_resolution_json: string | null;
};

type DeliveryAttemptRow = {
  id: string;
  sort_id: string;
  ts: number;
  delivery_id: string;
  attempt: number;
  status: string;
  error: string | null;
  created_at: number;
  target_id: string;
  transport: string;
  message_id: string | null;
  invocation_id: string | null;
  conversation_id: string | null;
  actor_name: string | null;
  invocation_execution_json: string | null;
  invocation_execution_resolution_json: string | null;
};

const DEFAULT_BROKER_WINDOW_MS = 24 * 60 * 60_000;
const ROUTED_MESSAGE_BATCH_SIZE = 500;
const FAILED_DELIVERY_STATUSES = ["failed", "cancelled"] as const;

function metadataTarget(metadata: Record<string, unknown> | null): string | null {
  if (isScoutbotThreadDispatchMetadata(metadata)) {
    return "scoutbot";
  }
  const relayTarget = metadata?.relayTarget;
  if (typeof relayTarget === "string" && relayTarget.trim()) {
    return relayTarget.trim();
  }
  const targets = metadata?.relayTargetIds;
  if (Array.isArray(targets)) {
    const rendered = targets
      .map((target) => typeof target === "string" ? target.trim() : "")
      .filter(Boolean);
    return rendered.length > 0 ? rendered.join(", ") : null;
  }
  return null;
}

function metadataRoute(metadata: Record<string, unknown> | null): string | null {
  if (isScoutbotThreadDispatchMetadata(metadata)) {
    return "dm";
  }
  const relayChannel = metadata?.relayChannel;
  return typeof relayChannel === "string" && relayChannel.trim()
    ? relayChannel.trim()
    : null;
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isBrokerRoutedMessage(metadata: Record<string, unknown> | null): boolean {
  return metadata?.source === "scout-cli"
    || typeof metadata?.relayTarget === "string"
    || Array.isArray(metadata?.relayTargetIds)
    || typeof metadata?.relayChannel === "string"
    || isScoutbotThreadDispatchMetadata(metadata);
}

function isScoutbotThreadDispatchMetadata(metadata: Record<string, unknown> | null): boolean {
  return metadata?.destinationKind === "scoutbot_thread"
    && metadata?.source !== "scoutbot"
    && metadata?.generatedBy !== "scoutbot";
}

function shortBrokerBody(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function decodeBrokerCursor(value: string | null | undefined): BrokerCursor | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const ts = Number(trimmed.slice(0, separator));
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const rawId = trimmed.slice(separator + 1);
  try {
    const id = decodeURIComponent(rawId);
    return id ? { ts, id } : null;
  } catch {
    return rawId ? { ts, id: rawId } : null;
  }
}

function encodeBrokerCursor(item: { ts: number; id: string } | undefined): string | null {
  return item ? `${item.ts}:${encodeURIComponent(item.id)}` : null;
}

function cursorPredicate(
  cursor: BrokerCursor | null,
  tsExpression: string,
  idExpression: string,
): { sql: string; params: SQLQueryBindings[] } {
  if (!cursor) return { sql: "", params: [] };
  return {
    sql: `(${tsExpression} < ? OR (${tsExpression} = ? AND ${idExpression} > ?))`,
    params: [cursor.ts, cursor.ts, cursor.id],
  };
}

function whereClause(parts: string[]): string {
  return parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
}

function countSql(sql: string, ...params: SQLQueryBindings[]): number {
  const row = db().prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function queryMessageProjectionWatermark(): { count: number; latestAt: number | null } {
  const createdAtExpression = sqlTimestampMsExpression("m.created_at");
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS count, MAX(${createdAtExpression}) AS latest_at
       FROM messages m`,
    )
    .get() as { count: number; latest_at: number | null } | undefined;
  return {
    count: row?.count ?? 0,
    latestAt: normalizeTimestampMs(row?.latest_at) ?? null,
  };
}

function compareHistoryRows(left: { ts: number; id: string }, right: { ts: number; id: string }): number {
  return right.ts - left.ts || left.id.localeCompare(right.id);
}

function paginateHistory<T extends { ts: number; id: string }>(
  rows: T[],
  limit: number,
): { rows: T[]; cursor: string | null; hasMore: boolean } {
  const visible = rows.slice(0, limit);
  return {
    rows: visible,
    cursor: encodeBrokerCursor(visible.at(-1)),
    hasMore: rows.length > limit,
  };
}

function queryMessageRows(options: {
  limit: number;
  cursor?: BrokerCursor | null;
  since?: number | null;
  sortIdExpression: string;
  likelyBrokerRoutedOnly?: boolean;
}): MessageRow[] {
  const tsExpression = sqlTimestampMsExpression("m.created_at");
  const predicates: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (typeof options.since === "number") {
    predicates.push(`${tsExpression} >= ?`);
    params.push(options.since);
  }
  if (options.likelyBrokerRoutedOnly) {
    predicates.push(`(
      m.metadata_json LIKE '%scout-cli%'
      OR m.metadata_json LIKE '%relayTarget%'
      OR m.metadata_json LIKE '%relayTargetIds%'
      OR m.metadata_json LIKE '%relayChannel%'
      OR m.metadata_json LIKE '%scoutbot_thread%'
    )`);
  }
  const cursorFilter = cursorPredicate(options.cursor ?? null, tsExpression, options.sortIdExpression);
  if (cursorFilter.sql) {
    predicates.push(cursorFilter.sql);
    params.push(...cursorFilter.params);
  }
  params.push(options.limit);

  return db()
    .prepare(
      `SELECT
         m.id,
         ${options.sortIdExpression} AS sort_id,
         ${tsExpression} AS ts,
         m.conversation_id,
         m.actor_id,
         ac.display_name AS actor_name,
         m.body,
         m.class,
         m.metadata_json,
         m.created_at
       FROM messages m
       LEFT JOIN actors ac ON ac.id = m.actor_id
       ${whereClause(predicates)}
       ORDER BY ts DESC, sort_id ASC
       LIMIT ?`,
    )
    .all(...params) as MessageRow[];
}

function dialogueItemFromRow(row: MessageRow): WebBrokerDialogueItem {
  return {
    id: row.id,
    ts: normalizeTimestampMs(row.ts) ?? row.ts,
    actorName: row.actor_name ?? row.actor_id,
    conversationId: row.conversation_id,
    body: row.body,
    class: row.class,
  };
}

function routedMessageAttemptFromRow(row: MessageRow): WebBrokerRouteAttempt | null {
  const metadata = parseJson<Record<string, unknown> | null>(row.metadata_json, null);
  if (!isBrokerRoutedMessage(metadata)) {
    return null;
  }
  const ts = normalizeTimestampMs(row.ts) ?? row.ts;
  return {
    id: `message:${row.id}`,
    kind: "success",
    status: "sent",
    ts,
    actorName: row.actor_name ?? row.actor_id,
    target: metadataTarget(metadata),
    route: metadataRoute(metadata) ?? "unknown",
    detail: shortBrokerBody(row.body),
    conversationId: row.conversation_id,
    messageId: row.id,
    deliveryId: null,
    invocationId: null,
    metadata: {
      source: "messages",
      actorId: row.actor_id,
      class: row.class,
      raw: metadata,
    },
  };
}

function queryRoutedMessageAttempts(limit: number, cursor: BrokerCursor | null, since?: number): WebBrokerRouteAttempt[] {
  const targetCount = limit + 1;
  const rows: WebBrokerRouteAttempt[] = [];
  let scanCursor = cursor;

  while (rows.length < targetCount) {
    const batch = queryMessageRows({
      limit: ROUTED_MESSAGE_BATCH_SIZE,
      cursor: scanCursor,
      since,
      sortIdExpression: "'message:' || m.id",
      likelyBrokerRoutedOnly: true,
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      const attempt = routedMessageAttemptFromRow(row);
      if (attempt) rows.push(attempt);
      if (rows.length >= targetCount) break;
    }
    const last = batch.at(-1);
    if (!last || batch.length < ROUTED_MESSAGE_BATCH_SIZE) break;
    scanCursor = { ts: last.ts, id: last.sort_id };
  }

  return rows;
}

function countRoutedMessagesSince(since: number): number {
  let count = 0;
  let cursor: BrokerCursor | null = null;
  while (true) {
    const batch = queryMessageRows({
      limit: ROUTED_MESSAGE_BATCH_SIZE,
      cursor,
      since,
      sortIdExpression: "'message:' || m.id",
      likelyBrokerRoutedOnly: true,
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      if (routedMessageAttemptFromRow(row)) count += 1;
    }
    const last = batch.at(-1);
    if (!last || batch.length < ROUTED_MESSAGE_BATCH_SIZE) break;
    cursor = { ts: last.ts, id: last.sort_id };
  }
  return count;
}

function queryDispatchRows(limit: number, cursor: BrokerCursor | null, since?: number): DispatchRow[] {
  const tsExpression = sqlTimestampMsExpression("sd.dispatched_at");
  const sortIdExpression = "'dispatch:' || sd.id";
  const predicates: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (typeof since === "number") {
    predicates.push(`${tsExpression} >= ?`);
    params.push(since);
  }
  const cursorFilter = cursorPredicate(cursor, tsExpression, sortIdExpression);
  if (cursorFilter.sql) {
    predicates.push(cursorFilter.sql);
    params.push(...cursorFilter.params);
  }
  params.push(limit);

  return db()
    .prepare(
      `SELECT
         sd.id,
         ${sortIdExpression} AS sort_id,
         ${tsExpression} AS ts,
         sd.kind,
         sd.asked_label,
         sd.detail,
         sd.invocation_id,
         sd.conversation_id,
         sd.requester_id,
         ac.display_name AS actor_name,
         sd.dispatched_at,
         inv.execution_json AS invocation_execution_json,
         inv.execution_resolution_json AS invocation_execution_resolution_json
       FROM scout_dispatches sd
       LEFT JOIN actors ac ON ac.id = sd.requester_id
       LEFT JOIN invocations inv ON inv.id = sd.invocation_id
       ${whereClause(predicates)}
       ORDER BY ts DESC, sort_id ASC
       LIMIT ?`,
    )
    .all(...params) as DispatchRow[];
}

function failedQueryFromRow(row: DispatchRow): WebBrokerRouteAttempt {
  return {
    id: `dispatch:${row.id}`,
    kind: "failed_query",
    // `kind` describes why target resolution failed (unknown, ambiguous,
    // unparseable). It is not the lifecycle status. Keeping those concepts
    // separate prevents operator surfaces from rendering terminal failures as
    // an "unknown" state while preserving the useful resolution diagnosis in
    // metadata.
    status: "failed",
    ts: normalizeTimestampMs(row.ts) ?? row.ts,
    actorName: row.actor_name ?? row.requester_id,
    target: row.asked_label,
    route: null,
    detail: row.detail,
    conversationId: row.conversation_id,
    messageId: null,
    deliveryId: null,
    invocationId: row.invocation_id,
    metadata: {
      source: "scout_dispatches",
      dispatchId: row.id,
      dispatchKind: row.kind,
      requestedLabel: row.asked_label,
      requesterId: row.requester_id,
      execution: parseJson<Record<string, unknown> | null>(row.invocation_execution_json, null),
      executionResolution: parseJson<Record<string, unknown> | null>(
        row.invocation_execution_resolution_json,
        null,
      ),
    },
  };
}

function queryFailedDeliveryRows(limit: number, cursor: BrokerCursor | null, since?: number): DeliveryRow[] {
  const tsExpression = sqlTimestampMsExpression("d.created_at");
  const sortIdExpression = "'delivery:' || d.id";
  const predicates: string[] = [`d.status IN (${FAILED_DELIVERY_STATUSES.map(() => "?").join(", ")})`];
  const params: SQLQueryBindings[] = [...FAILED_DELIVERY_STATUSES];
  if (typeof since === "number") {
    predicates.push(`${tsExpression} >= ?`);
    params.push(since);
  }
  const cursorFilter = cursorPredicate(cursor, tsExpression, sortIdExpression);
  if (cursorFilter.sql) {
    predicates.push(cursorFilter.sql);
    params.push(...cursorFilter.params);
  }
  params.push(limit);

  return db()
    .prepare(
      `SELECT
         d.id,
         ${sortIdExpression} AS sort_id,
         ${tsExpression} AS ts,
         d.message_id,
         m.actor_id AS message_actor_id,
         sender.display_name AS message_actor_name,
         m.body AS message_body,
         m.metadata_json AS message_metadata_json,
         d.invocation_id,
         d.target_id,
         d.transport,
         d.reason,
         d.status,
         d.created_at,
         d.metadata_json,
         inv.execution_json AS invocation_execution_json,
         inv.execution_resolution_json AS invocation_execution_resolution_json,
         m.conversation_id,
         ac.display_name AS actor_name
       FROM deliveries d
       LEFT JOIN messages m ON m.id = d.message_id
       LEFT JOIN actors sender ON sender.id = m.actor_id
       LEFT JOIN actors ac ON ac.id = d.target_id
       LEFT JOIN invocations inv ON inv.id = d.invocation_id
       ${whereClause(predicates)}
       ORDER BY ts DESC, sort_id ASC
       LIMIT ?`,
    )
    .all(...params) as DeliveryRow[];
}

function failedDeliveryFromRow(row: DeliveryRow): WebBrokerRouteAttempt {
  const deliveryMetadata = parseJson<Record<string, unknown> | null>(row.metadata_json, null);
  const messageMetadata = parseJson<Record<string, unknown> | null>(row.message_metadata_json, null);
  const failureReason = metadataString(deliveryMetadata, "failureReason");
  const failureDetail = metadataString(deliveryMetadata, "failureDetail");
  const reconciledReason = metadataString(deliveryMetadata, "reconciledReason");

  return {
    id: `delivery:${row.id}`,
    kind: "failed_delivery",
    status: row.status,
    ts: normalizeTimestampMs(row.ts) ?? row.ts,
    actorName: row.message_actor_name ?? row.message_actor_id ?? row.actor_name,
    target: row.target_id,
    route: metadataRoute(messageMetadata) ?? row.transport,
    detail: row.message_body ? shortBrokerBody(row.message_body) : row.reason,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    deliveryId: row.id,
    invocationId: row.invocation_id,
    metadata: {
      source: "deliveries",
      deliveryId: row.id,
      messageId: row.message_id,
      conversationId: row.conversation_id,
      invocationId: row.invocation_id,
      targetId: row.target_id,
      transport: row.transport,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      actorName: row.actor_name,
      execution: parseJson<Record<string, unknown> | null>(row.invocation_execution_json, null),
      executionResolution: parseJson<Record<string, unknown> | null>(
        row.invocation_execution_resolution_json,
        null,
      ),
      ...(failureReason ? { failureReason } : {}),
      ...(failureDetail ? { failureDetail } : {}),
      ...(reconciledReason ? { reconciledReason } : {}),
      raw: {
        message: messageMetadata,
        delivery: {
          id: row.id,
          messageId: row.message_id,
          invocationId: row.invocation_id,
          targetId: row.target_id,
          transport: row.transport,
          reason: row.reason,
          status: row.status,
          createdAt: row.created_at,
          conversationId: row.conversation_id,
          actorName: row.actor_name,
          metadata: deliveryMetadata,
        },
      },
    },
  };
}

function queryDeliveryAttemptRows(limit: number, cursor: BrokerCursor | null, since?: number): DeliveryAttemptRow[] {
  const tsExpression = sqlTimestampMsExpression("da.created_at");
  const sortIdExpression = "'attempt:' || da.id";
  const predicates: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (typeof since === "number") {
    predicates.push(`${tsExpression} >= ?`);
    params.push(since);
  }
  const cursorFilter = cursorPredicate(cursor, tsExpression, sortIdExpression);
  if (cursorFilter.sql) {
    predicates.push(cursorFilter.sql);
    params.push(...cursorFilter.params);
  }
  params.push(limit);

  return db()
    .prepare(
      `SELECT
         da.id,
         ${sortIdExpression} AS sort_id,
         ${tsExpression} AS ts,
         da.delivery_id,
         da.attempt,
         da.status,
         da.error,
         da.created_at,
         d.target_id,
         d.transport,
         d.message_id,
         d.invocation_id,
         inv.execution_json AS invocation_execution_json,
         inv.execution_resolution_json AS invocation_execution_resolution_json,
         m.conversation_id,
         ac.display_name AS actor_name
       FROM delivery_attempts da
       JOIN deliveries d ON d.id = da.delivery_id
       LEFT JOIN messages m ON m.id = d.message_id
       LEFT JOIN actors ac ON ac.id = d.target_id
       LEFT JOIN invocations inv ON inv.id = d.invocation_id
       ${whereClause(predicates)}
       ORDER BY ts DESC, sort_id ASC
       LIMIT ?`,
    )
    .all(...params) as DeliveryAttemptRow[];
}

function deliveryAttemptFromRow(row: DeliveryAttemptRow): WebBrokerRouteAttempt {
  return {
    id: `attempt:${row.id}`,
    kind: "delivery_attempt",
    status: row.status,
    ts: normalizeTimestampMs(row.ts) ?? row.ts,
    actorName: row.actor_name,
    target: row.target_id,
    route: row.transport,
    detail: row.error ?? `attempt ${row.attempt}`,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    deliveryId: row.delivery_id,
    invocationId: row.invocation_id,
    metadata: {
      source: "delivery_attempts",
      attemptId: row.id,
      attempt: row.attempt,
      targetId: row.target_id,
      transport: row.transport,
      error: row.error,
      execution: parseJson<Record<string, unknown> | null>(row.invocation_execution_json, null),
      executionResolution: parseJson<Record<string, unknown> | null>(
        row.invocation_execution_resolution_json,
        null,
      ),
    },
  };
}

export function queryBrokerDiagnostics(opts?: {
  limit?: number;
  windowMs?: number;
  cursor?: string | null;
  scopeRowsToWindow?: boolean;
}): WebBrokerDiagnostics {
  const limit = opts?.limit ?? 120;
  const windowMs = opts?.windowMs ?? DEFAULT_BROKER_WINDOW_MS;
  const cursor = decodeBrokerCursor(opts?.cursor);
  const now = Date.now();
  const since = now - windowMs;
  const rowSince = opts?.scopeRowsToWindow ? since : undefined;
  const messageCreatedAtExpression = sqlTimestampMsExpression("m.created_at");
  const dispatchAtExpression = sqlTimestampMsExpression("sd.dispatched_at");
  const deliveryCreatedAtExpression = sqlTimestampMsExpression("d.created_at");
  const attemptCreatedAtExpression = sqlTimestampMsExpression("da.created_at");
  const projectionMessages = queryMessageProjectionWatermark();

  const dialoguePage = paginateHistory(
    queryMessageRows({
      limit: limit + 1,
      cursor,
      since: rowSince,
      sortIdExpression: "m.id",
    }).map(dialogueItemFromRow),
    limit,
  );

  const successfulDispatches = queryRoutedMessageAttempts(limit, cursor, rowSince);
  const failedQueries = queryDispatchRows(limit + 1, cursor, rowSince).map(failedQueryFromRow);
  const failedQueriesPage = paginateHistory(
    failedQueries,
    limit,
  );
  const failedDeliveries = queryFailedDeliveryRows(limit + 1, cursor, rowSince).map(failedDeliveryFromRow);
  const failedDeliveriesPage = paginateHistory(
    failedDeliveries,
    limit,
  );
  const deliveryAttempts = queryDeliveryAttemptRows(limit + 1, cursor, rowSince).map(deliveryAttemptFromRow);

  const attempts = [
    ...successfulDispatches,
    ...failedQueries,
    ...failedDeliveries,
    ...deliveryAttempts,
  ]
    .sort(compareHistoryRows);
  const attemptsPage = paginateHistory(attempts, limit);

  const cursors: Record<WebBrokerHistoryKey, string | null> = {
    attempts: attemptsPage.cursor,
    failedQueries: failedQueriesPage.cursor,
    failedDeliveries: failedDeliveriesPage.cursor,
    dialogue: dialoguePage.cursor,
  };
  const hasMore: Record<WebBrokerHistoryKey, boolean> = {
    attempts: attemptsPage.hasMore,
    failedQueries: failedQueriesPage.hasMore,
    failedDeliveries: failedDeliveriesPage.hasMore,
    dialogue: dialoguePage.hasMore,
  };

  const successfulDispatchCount = countRoutedMessagesSince(since);
  const failedQueriesCount = countSql(
    `SELECT COUNT(*) AS count FROM scout_dispatches sd WHERE ${dispatchAtExpression} >= ?`,
    since,
  );
  const failedDeliveriesCount = countSql(
    `SELECT COUNT(*) AS count
     FROM deliveries d
     WHERE ${deliveryCreatedAtExpression} >= ?
       AND d.status IN (${FAILED_DELIVERY_STATUSES.map(() => "?").join(", ")})`,
    since,
    ...FAILED_DELIVERY_STATUSES,
  );
  const deliveryAttemptsCount = countSql(
    `SELECT COUNT(*) AS count FROM delivery_attempts da WHERE ${attemptCreatedAtExpression} >= ?`,
    since,
  );
  const failedDeliveryAttempts = countSql(
    `SELECT COUNT(*) AS count
     FROM delivery_attempts da
     WHERE ${attemptCreatedAtExpression} >= ?
       AND da.status = 'failed'`,
    since,
  );
  const dialogueCount = countSql(
    `SELECT COUNT(*) AS count FROM messages m WHERE ${messageCreatedAtExpression} >= ?`,
    since,
  );
  const hours = Math.max(windowMs / 3_600_000, 1);
  const failureCount = failedQueriesCount + failedDeliveriesCount + failedDeliveryAttempts;
  const attemptCount = successfulDispatchCount + failureCount;

  return {
    generatedAt: now,
    windowMs,
    source: {
      mode: "sqlite_projection",
      status: "unknown",
      latestMessageAt: projectionMessages.latestAt,
      projectionLatestMessageAt: projectionMessages.latestAt,
      liveMessageCount: null,
      projectionMessageCount: projectionMessages.count,
      detail: null,
    },
    ledger: {
      mode: "latest",
      limit,
      cursor: opts?.cursor ?? null,
      cursors,
      hasMore,
    },
    totals: {
      successfulDispatches: successfulDispatchCount,
      failedQueries: failedQueriesCount,
      failedDeliveries: failedDeliveriesCount,
      deliveryAttempts: deliveryAttemptsCount,
      failedDeliveryAttempts,
      dialogueMessages: dialogueCount,
    },
    rates: {
      messagesPerHour: Number((dialogueCount / hours).toFixed(1)),
      failedQueriesPerHour: Number((failedQueriesCount / hours).toFixed(1)),
      failedDeliveriesPerHour: Number(((failedDeliveriesCount + failedDeliveryAttempts) / hours).toFixed(1)),
      failureRate: attemptCount > 0 ? Number((failureCount / attemptCount).toFixed(3)) : 0,
    },
    attempts: attemptsPage.rows,
    failedQueries: failedQueriesPage.rows,
    failedDeliveries: failedDeliveriesPage.rows,
    dialogue: dialoguePage.rows,
  };
}
