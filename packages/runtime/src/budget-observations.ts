import { createHash } from "node:crypto";

import { readAdapterBudgetObservations } from "@openscout/agent-sessions";
import type {
  AgentEndpoint,
  BudgetQuotaWindowSnapshot,
  BudgetUsageRecord,
} from "@openscout/protocol";
import type { AdapterBudgetQuotaWindowObservation } from "@openscout/agent-sessions";

type BudgetEndpointObservations = {
  usage: BudgetUsageRecord[];
  quotaWindows: BudgetQuotaWindowSnapshot[];
};

const QUOTA_HISTORY_BUCKET_MS = 60 * 60 * 1000;

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function quotaWindowDedupKey(
  endpoint: AgentEndpoint,
  observation: AdapterBudgetQuotaWindowObservation,
): string {
  return [
    "endpoint",
    endpoint.id,
    "session",
    observation.sessionId ?? "",
    "quota",
    observation.windowKind ?? observation.label,
  ].join(":");
}

function quotaWindowSnapshotFromObservation(input: {
  endpoint: AgentEndpoint;
  observation: AdapterBudgetQuotaWindowObservation;
  id: string;
  metadata?: Record<string, unknown>;
}): BudgetQuotaWindowSnapshot {
  const { endpoint, observation } = input;
  return {
    id: input.id,
    source: observation.source,
    provider: observation.provider,
    harness: endpoint.harness,
    transport: endpoint.transport,
    model: observation.model,
    agentId: endpoint.agentId,
    endpointId: endpoint.id,
    sessionId: observation.sessionId,
    userId: observation.userId,
    accountId: observation.accountId,
    planType: observation.planType,
    label: observation.label,
    windowKind: observation.windowKind,
    usedPercent: observation.usedPercent,
    percentRemaining: observation.percentRemaining,
    used: observation.used,
    limit: observation.limit,
    resetAt: observation.resetAt,
    windowMs: observation.windowMs,
    capturedAt: observation.capturedAt,
    metadata: input.metadata ?? observation.metadata,
  };
}

export function budgetObservationsFromEndpoint(
  endpoint: AgentEndpoint,
  now = Date.now(),
): BudgetEndpointObservations {
  const metadata = metadataRecord(endpoint.metadata);
  const adapterObservations = readAdapterBudgetObservations({
    id: endpoint.id,
    harness: endpoint.harness,
    transport: endpoint.transport,
    adapterType: endpoint.transport,
    model: stringValue(metadata?.model),
    sessionId: endpoint.sessionId,
    projectRoot: endpoint.projectRoot,
    cwd: endpoint.cwd,
    providerMeta: metadata?.providerMeta,
    lastSeenAt: numberValue(metadata?.lastSeenAt),
  }, now);

  return {
    usage: adapterObservations.usage.map((observation) => {
      const dedupKey = [
        "endpoint",
        endpoint.id,
        "session",
        observation.sessionId ?? "",
        observation.source,
      ].join(":");

      return {
        id: `budget:usage:${stableHash(dedupKey)}`,
        scope: "harness_execution",
        source: observation.source,
        provider: observation.provider,
        harness: endpoint.harness,
        transport: endpoint.transport,
        model: observation.model,
        agentId: endpoint.agentId,
        endpointId: endpoint.id,
        sessionId: observation.sessionId,
        projectRoot: observation.projectRoot,
        occurredAt: observation.occurredAt,
        inputTokens: observation.usage.inputTokens ?? undefined,
        outputTokens: observation.usage.outputTokens ?? undefined,
        reasoningOutputTokens: observation.usage.reasoningOutputTokens ?? undefined,
        cacheCreationInputTokens: observation.usage.cacheCreationInputTokens ?? undefined,
        cacheReadInputTokens: observation.usage.cacheReadInputTokens ?? undefined,
        totalTokens: observation.usage.totalTokens ?? undefined,
        estimatedUsd: observation.estimate.totalUsd ?? undefined,
        billedUsd: observation.estimate.billedTotalUsd ?? undefined,
        currency: "USD",
        dedupKey,
        metadata: observation.metadata,
      };
    }),
    quotaWindows: adapterObservations.quotaWindows.flatMap((observation) => {
      const dedupKey = quotaWindowDedupKey(endpoint, observation);
      const historyBucket = Math.floor(observation.capturedAt / QUOTA_HISTORY_BUCKET_MS);
      const current = quotaWindowSnapshotFromObservation({
        endpoint,
        observation,
        id: `budget:quota:${stableHash(dedupKey)}`,
      });
      const history = quotaWindowSnapshotFromObservation({
        endpoint,
        observation,
        id: `budget:quota:history:${stableHash(`${dedupKey}:history:${historyBucket}`)}`,
        metadata: {
          ...observation.metadata,
          historyBucketMs: QUOTA_HISTORY_BUCKET_MS,
          historyBucketStartAt: historyBucket * QUOTA_HISTORY_BUCKET_MS,
        },
      });

      return [current, history];
    }),
  };
}
