import type { AgentHarness } from "./actors.js";
import type { DeliveryTransport, MetadataMap, ScoutId } from "./common.js";

export const BUDGET_USAGE_SCOPES = [
  "protocol_overhead",
  "harness_execution",
] as const;

export type BudgetUsageScope = typeof BUDGET_USAGE_SCOPES[number];

export const BUDGET_USAGE_SOURCES = [
  "provider_exact",
  "provider_reported",
  "provider_session_snapshot",
  "observed_transcript",
  "tokenizer_estimate",
  "char_heuristic",
  "manual_estimate",
] as const;

export type BudgetUsageSource = typeof BUDGET_USAGE_SOURCES[number];

export interface BudgetUsageRecord {
  id: ScoutId;
  scope: BudgetUsageScope;
  source: BudgetUsageSource;
  provider?: string;
  harness?: AgentHarness | string;
  transport?: DeliveryTransport | string;
  model?: string;
  agentId?: ScoutId;
  endpointId?: ScoutId;
  sessionId?: ScoutId;
  projectRoot?: string;
  conversationId?: ScoutId;
  messageId?: ScoutId;
  invocationId?: ScoutId;
  flightId?: ScoutId;
  workId?: ScoutId;
  occurredAt: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
  billedUsd?: number;
  currency?: string;
  dedupKey?: string;
  metadata?: MetadataMap;
  createdAt?: number;
}

export const BUDGET_QUOTA_WINDOW_SOURCES = [
  "provider_reported",
  "observed",
  "estimated",
  "manual",
] as const;

export type BudgetQuotaWindowSource = typeof BUDGET_QUOTA_WINDOW_SOURCES[number];

export interface BudgetQuotaWindowSnapshot {
  id: ScoutId;
  source: BudgetQuotaWindowSource;
  provider?: string;
  harness?: AgentHarness | string;
  transport?: DeliveryTransport | string;
  model?: string;
  agentId?: ScoutId;
  endpointId?: ScoutId;
  sessionId?: ScoutId;
  userId?: string;
  accountId?: string;
  planType?: string;
  label: "5h" | "weekly" | string;
  windowKind?: "primary" | "secondary" | "five_hour" | "weekly" | string;
  usedPercent?: number;
  percentRemaining?: number;
  used?: number;
  limit?: number;
  resetAt?: number;
  windowMs?: number;
  capturedAt: number;
  metadata?: MetadataMap;
  createdAt?: number;
}
