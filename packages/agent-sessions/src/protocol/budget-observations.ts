import type { AdapterCostEstimate, AdapterCostUsage } from "./cost.js";

export type AdapterBudgetObservationInput = {
  id: string;
  harness?: string;
  transport?: string;
  adapterType?: string;
  model?: string;
  sessionId?: string;
  projectRoot?: string;
  cwd?: string;
  providerMeta?: unknown;
  lastSeenAt?: number;
};

export type AdapterBudgetUsageObservation = {
  source: "provider_session_snapshot";
  provider?: string;
  model?: string;
  sessionId?: string;
  projectRoot?: string;
  occurredAt: number;
  usage: AdapterCostUsage;
  estimate: AdapterCostEstimate;
  metadata: Record<string, unknown>;
};

export type AdapterBudgetQuotaWindowObservation = {
  source: "provider_reported";
  provider?: string;
  model?: string;
  sessionId?: string;
  userId?: string;
  accountId?: string;
  planType?: string;
  label: string;
  windowKind?: string;
  usedPercent?: number;
  percentRemaining?: number;
  used?: number;
  limit?: number;
  resetAt?: number;
  windowMs?: number;
  capturedAt: number;
  metadata: Record<string, unknown>;
};

export type AdapterBudgetObservations = {
  usage: AdapterBudgetUsageObservation[];
  quotaWindows: AdapterBudgetQuotaWindowObservation[];
};
