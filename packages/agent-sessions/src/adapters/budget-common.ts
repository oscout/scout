import { estimateAdapterCost, type AdapterCostUsage } from "../protocol/cost.js";
import { epochMs } from "../protocol/time.js";
import type {
  AdapterBudgetObservationInput,
  AdapterBudgetObservations,
  AdapterBudgetQuotaWindowObservation,
  AdapterBudgetUsageObservation,
} from "../protocol/budget-observations.js";

export type ObservedProviderBudgetOptions = {
  provider: string;
  includeQuotaWindows?: boolean;
  usageMetadataSource: string;
  quotaMetadataSource?: string;
};

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

function numberOrNullish(value: unknown): number | null | undefined {
  const n = numberValue(value);
  return n === undefined ? undefined : n;
}

function timestampValue(value: unknown): number | undefined {
  const parsedEpoch = epochMs(value);
  if (parsedEpoch !== undefined) {
    return parsedEpoch;
  }

  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasUsage(usage: AdapterCostUsage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
    usage.totalTokens,
    usage.webSearchRequests,
    usage.webFetchRequests,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function observedProvider(
  input: AdapterBudgetObservationInput,
  providerMeta: Record<string, unknown> | undefined,
  fallbackProvider: string,
): string {
  const runtime = metadataRecord(providerMeta?.observeRuntime);
  return stringValue(providerMeta?.provider)
    ?? stringValue(runtime?.modelProvider)
    ?? fallbackProvider
    ?? input.harness
    ?? "unknown";
}

function observedModel(
  input: AdapterBudgetObservationInput,
  providerMeta: Record<string, unknown> | undefined,
): string | undefined {
  const runtime = metadataRecord(providerMeta?.observeRuntime);
  return stringValue(input.model)
    ?? stringValue(runtime?.model)
    ?? stringValue(providerMeta?.model);
}

function observedSessionId(
  input: AdapterBudgetObservationInput,
  providerMeta: Record<string, unknown> | undefined,
): string | undefined {
  return stringValue(input.sessionId)
    ?? stringValue(providerMeta?.externalSessionId)
    ?? stringValue(providerMeta?.threadId);
}

function observedAt(
  input: AdapterBudgetObservationInput,
  providerMeta: Record<string, unknown> | undefined,
  now: number,
): number {
  return timestampValue(input.lastSeenAt)
    ?? timestampValue(providerMeta?.lastSeenAt)
    ?? now;
}

function buildUsageObservation(
  input: AdapterBudgetObservationInput,
  options: ObservedProviderBudgetOptions,
  now: number,
): AdapterBudgetUsageObservation | null {
  const providerMeta = metadataRecord(input.providerMeta);
  const observeUsage = metadataRecord(providerMeta?.observeUsage);
  if (!observeUsage) {
    return null;
  }

  const usage: AdapterCostUsage = {
    inputTokens: numberOrNullish(observeUsage.inputTokens),
    outputTokens: numberOrNullish(observeUsage.outputTokens),
    reasoningOutputTokens: numberOrNullish(observeUsage.reasoningOutputTokens),
    cacheReadInputTokens: numberOrNullish(observeUsage.cacheReadInputTokens),
    cacheCreationInputTokens: numberOrNullish(observeUsage.cacheCreationInputTokens),
    totalTokens: numberOrNullish(observeUsage.totalTokens),
    webSearchRequests: numberOrNullish(observeUsage.webSearchRequests),
    webFetchRequests: numberOrNullish(observeUsage.webFetchRequests),
    planType: stringValue(observeUsage.planType),
  };

  if (!hasUsage(usage)) {
    return null;
  }

  const provider = observedProvider(input, providerMeta, options.provider);
  const model = observedModel(input, providerMeta);
  const sessionId = observedSessionId(input, providerMeta);
  const occurredAt = observedAt(input, providerMeta, now);
  const estimate = estimateAdapterCost({
    provider,
    adapterType: input.transport ?? input.adapterType,
    model,
    usage,
    capturedAt: occurredAt,
  });

  return {
    source: "provider_session_snapshot",
    provider,
    model,
    sessionId,
    projectRoot: input.projectRoot ?? input.cwd,
    occurredAt,
    usage,
    estimate,
    metadata: {
      billingMode: estimate.billingMode,
      rateCardSource: estimate.rateCardSource,
      source: options.usageMetadataSource,
      ...(usage.planType ? { planType: usage.planType } : {}),
    },
  };
}

function quotaWindowLabel(window: Record<string, unknown>, index: number): string {
  return stringValue(window.label)
    ?? (stringValue(window.windowKind) === "secondary" ? "weekly" : undefined)
    ?? (index === 0 ? "5h" : "weekly");
}

function buildQuotaWindowObservations(
  input: AdapterBudgetObservationInput,
  options: ObservedProviderBudgetOptions,
  now: number,
): AdapterBudgetQuotaWindowObservation[] {
  if (!options.includeQuotaWindows) {
    return [];
  }

  const providerMeta = metadataRecord(input.providerMeta);
  const observeQuota = metadataRecord(providerMeta?.observeQuota);
  const rawWindows = Array.isArray(observeQuota?.windows) ? observeQuota.windows : [];
  if (rawWindows.length === 0) {
    return [];
  }

  const provider = observedProvider(input, providerMeta, options.provider);
  const model = observedModel(input, providerMeta);
  const sessionId = observedSessionId(input, providerMeta);
  const capturedAt = timestampValue(observeQuota?.capturedAt)
    ?? observedAt(input, providerMeta, now);
  const planType = stringValue(observeQuota?.planType);
  const userId = stringValue(observeQuota?.userId);
  const accountId = stringValue(observeQuota?.accountId);

  return rawWindows.flatMap((value, index) => {
    const window = metadataRecord(value);
    if (!window) {
      return [];
    }

    const usedPercent = numberValue(window.usedPercent);
    const percentRemaining = numberValue(window.percentRemaining)
      ?? (usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent));

    return [{
      source: "provider_reported",
      provider,
      model,
      sessionId,
      userId,
      accountId,
      planType,
      label: quotaWindowLabel(window, index),
      windowKind: stringValue(window.windowKind),
      usedPercent,
      percentRemaining,
      used: numberValue(window.used),
      limit: numberValue(window.limit),
      resetAt: timestampValue(window.resetAt),
      windowMs: numberValue(window.windowMs),
      capturedAt,
      metadata: {
        source: options.quotaMetadataSource ?? options.usageMetadataSource,
      },
    }];
  });
}

export function readObservedProviderBudgetObservations(
  input: AdapterBudgetObservationInput,
  options: ObservedProviderBudgetOptions,
  now = Date.now(),
): AdapterBudgetObservations {
  const usage = buildUsageObservation(input, options, now);
  return {
    usage: usage ? [usage] : [],
    quotaWindows: buildQuotaWindowObservations(input, options, now),
  };
}
