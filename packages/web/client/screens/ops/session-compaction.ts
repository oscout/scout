import { deriveContextBudgetGauge } from "../../lib/context-budget.ts";
import type { ObserveUsageMeta, TailEvent } from "../../lib/types.ts";

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return metadataRecord(metadataRecord(value)?.[key]);
}

function rawRecordType(event: TailEvent): string | undefined {
  const raw = metadataRecord(event.raw);
  const type = raw?.type;
  return typeof type === "string" ? type : undefined;
}

function payloadType(event: TailEvent): string | undefined {
  const payload = nestedRecord(event.raw, "payload");
  const type = payload?.type;
  return typeof type === "string" ? type : undefined;
}

export type LaneCompactionState = {
  eligible: boolean;
  reason: "high_context" | "over_limit" | "post_compaction_point" | null;
  lastCompactedAt: number | null;
  lastCompactedSummary: string | null;
};

const COMPACTION_SUMMARY_RE = /context\s+compacted|compacted\s+·/iu;

function compactionSummaryFromEvent(event: TailEvent): string | null {
  const summary = event.summary.trim();
  if (!summary) return null;

  if (event.source === "codex") {
    const payload = nestedRecord(metadataRecord(event.raw), "payload");
    const payloadKind = payloadType(event);
    if (payloadKind === "context_compacted" || rawRecordType(event) === "compacted") {
      return summary;
    }
  }

  return COMPACTION_SUMMARY_RE.test(summary) ? summary : null;
}

export function laneCompactionStateFromTail(
  events: TailEvent[],
  usage: ObserveUsageMeta | null | undefined,
  options?: { model?: string | null; adapterType?: string | null },
): LaneCompactionState {
  let lastCompactedAt: number | null = null;
  let lastCompactedSummary: string | null = null;
  for (const event of events) {
    const summary = compactionSummaryFromEvent(event);
    if (!summary) continue;
    if (lastCompactedAt === null || event.ts >= lastCompactedAt) {
      lastCompactedAt = event.ts;
      lastCompactedSummary = summary;
    }
  }

  const gauge = deriveContextBudgetGauge(usage, options);
  let reason: LaneCompactionState["reason"] = null;
  if (gauge?.overLimit) {
    reason = "over_limit";
  } else if (gauge && gauge.pct >= 80) {
    reason = "high_context";
  } else if (lastCompactedAt !== null) {
    reason = "post_compaction_point";
  }

  const eligible = Boolean(
    gauge
    && (gauge.overLimit || gauge.pct >= 75 || lastCompactedAt !== null),
  );

  return {
    eligible,
    reason,
    lastCompactedAt,
    lastCompactedSummary,
  };
}

export function compactionHarnessCommand(harness: string | null | undefined): string | null {
  const normalized = harness?.trim().toLowerCase() ?? "";
  if (normalized === "claude" || normalized === "claude-code") {
    return "/compact";
  }
  return null;
}

export function supportsRemoteCompaction(harness: string | null | undefined): boolean {
  const normalized = harness?.trim().toLowerCase() ?? "";
  return normalized === "codex"
    || normalized === "claude"
    || normalized === "claude-code";
}