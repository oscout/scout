/**
 * Activity-feed and heartrate (smoothed activity counts) queries.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C.
 */

import { db } from "./internal/db.ts";
import { compact } from "./internal/paths.ts";
import {
  isDuplicateActivityFeedItem,
  sqlTimestampMsExpression,
  staleFlightActivityPredicate,
} from "./internal/sql-helpers.ts";
import type { HeartrateBucket } from "./types/common.ts";
import type { WebActivityItem } from "./types/web.ts";

export function queryActivity(limit = 60): WebActivityItem[] {
  const activityTsExpression = sqlTimestampMsExpression("ai.ts");
  const rows = db()
    .prepare(
      `SELECT
         ai.id,
         ai.kind,
         ${activityTsExpression} AS ts,
         ac.display_name AS actor_name,
         ai.title,
         ai.summary,
         ai.conversation_id,
         ai.workspace_root,
         ai.agent_id,
         agent_actor.display_name AS agent_name,
         ai.flight_id,
         ai.invocation_id,
         ai.session_id,
         ai.message_id,
         ai.record_id,
         c.kind AS conversation_kind
       FROM activity_items ai
       LEFT JOIN actors ac ON ac.id = ai.actor_id
       LEFT JOIN actors agent_actor ON agent_actor.id = ai.agent_id
       LEFT JOIN conversations c ON c.id = ai.conversation_id
       WHERE ai.kind NOT IN (
         'ask_replied',
         'ask_failed',
         'flight_updated',
         'flight.completed',
         'flight.updated'
       )
         AND ${staleFlightActivityPredicate("ai")}
       ORDER BY ${activityTsExpression} DESC
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
    agent_id: string | null;
    agent_name: string | null;
    flight_id: string | null;
    invocation_id: string | null;
    session_id: string | null;
    message_id: string | null;
    record_id: string | null;
    conversation_kind: string | null;
  }>;

  const items = rows.map((r) => ({
    id: r.id,
    kind: normalizeActivityKind(r.kind, {
      conversationKind: r.conversation_kind,
      messageId: r.message_id,
      invocationId: r.invocation_id,
      flightId: r.flight_id,
    }),
    ts: r.ts,
    actorName: r.actor_name,
    title: r.title,
    summary: r.summary,
    conversationId: r.conversation_id,
    workspaceRoot: compact(r.workspace_root),
    agentId: r.agent_id,
    agentName: r.agent_name,
    flightId: r.flight_id,
    invocationId: r.invocation_id,
    sessionId: r.session_id,
    messageId: r.message_id,
    recordId: r.record_id,
  }));

  return items.filter((item, index) => !isDuplicateActivityFeedItem(items[index - 1] ?? null, item));
}

function normalizeActivityKind(
  kind: string,
  input: {
    conversationKind: string | null;
    messageId: string | null;
    invocationId: string | null;
    flightId: string | null;
  },
): string {
  if (
    kind === "ask_opened"
    && input.messageId
    && !input.invocationId
    && !input.flightId
    && input.conversationKind !== "direct"
  ) {
    return "message_posted";
  }
  return kind;
}

/* ── Heartrate: smoothed activity over a trailing 7-day window ── */

type HeartrateResult = { windowLabel: string; bucketLabel: string; buckets: HeartrateBucket[] };

const HEARTRATE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_HEARTRATE_BUCKETS = 56;

function smoothHeartrateCounts(counts: number[]): number[] {
  const energy = counts.map((count) => Math.sqrt(count));
  const weights = [0.56, 0.28, 0.11, 0.05];

  return energy.map((_, index) => {
    let total = 0;
    let weightTotal = 0;
    for (let offset = -3; offset <= 3; offset++) {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= energy.length) continue;
      const weight = weights[Math.abs(offset)] ?? 0;
      total += energy[nextIndex] * weight;
      weightTotal += weight;
    }
    return weightTotal > 0 ? total / weightTotal : 0;
  });
}

function formatHeartrateBucketLabel(bucketMs: number): string {
  const minutes = Math.round(bucketMs / 60_000);
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d buckets`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h buckets`;
  }
  return `${minutes}m buckets`;
}

export function queryHeartrate(
  numBuckets = DEFAULT_HEARTRATE_BUCKETS,
  nowMs = Date.now(),
): HeartrateResult {
  const bucketMs = HEARTRATE_WINDOW_MS / numBuckets;
  const currentBucketStart = Math.floor(nowMs / bucketMs) * bucketMs;
  const alignedStart = currentBucketStart - (numBuckets - 1) * bucketMs;
  const activityTsExpression = sqlTimestampMsExpression("ts");

  const rows = db()
    .prepare(
      `SELECT ${activityTsExpression} AS ts
       FROM activity_items
       WHERE ${activityTsExpression} >= ?1
       ORDER BY ${activityTsExpression} ASC`,
    )
    .all(alignedStart) as Array<{ ts: number }>;

  const counts = new Array<number>(numBuckets).fill(0);
  for (const row of rows) {
    const ms = row.ts;
    if (ms < alignedStart || ms > nowMs) continue;
    const idx = Math.min(numBuckets - 1, Math.floor((ms - alignedStart) / bucketMs));
    if (idx >= 0) counts[idx]++;
  }

  const smoothed = smoothHeartrateCounts(counts);
  const peak = Math.max(1, ...smoothed);
  return {
    windowLabel: "trailing 7d",
    bucketLabel: formatHeartrateBucketLabel(bucketMs),
    buckets: counts.map((count, i) => ({
      ts: Math.round(alignedStart + i * bucketMs),
      count,
      value: smoothed[i] / peak,
    })),
  };
}
