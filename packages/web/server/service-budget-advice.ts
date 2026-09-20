/**
 * Cheap, cached Scoutbot advice for the native Budgets panel.
 *
 * Cadence is two hours. The cache lives on disk so popup opens, polls,
 * provider changes, and app restarts do not spend another model call.
 * Concurrent readers share one in-flight refresh.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import type { ServiceBudgetsResponse, ServiceGauge, ServiceQuotaWindowGauge } from "./service-budgets.ts";

export const BUDGET_ADVICE_TTL_MS = 2 * 60 * 60 * 1000;

export type ServiceBudgetAdvice = {
  recommendation: string;
  reason: string;
  providerId?: string;
  generatedAt: number;
  model?: string;
  stale?: boolean;
  unavailable?: boolean;
  detail?: string;
};

export type BudgetAdviceComplete = (input: {
  systemPrompt: string;
  body: string;
}) => Promise<{ text: string; model: string }>;

type StoredAdvice = ServiceBudgetAdvice & {
  fingerprint: string;
  /** Last completion attempt, success or billable failure. Independent of advice age. */
  lastAttemptAt: number;
};

const ADVICE_SYSTEM_PROMPT = [
  "You are Scoutbot. Recommend which provider to use next from the supplied quota snapshot.",
  "Return ONLY JSON: {\"providerId\":\"id or null\",\"recommendation\":\"one short clause\",\"reason\":\"one short sentence\"}.",
  "Ground the reason in remaining quota, reset timing, and consumption pace when those facts exist.",
  "History is same-reset-cycle only when paceUnknown is false. If paceUnknown is true, pace is unknown. Do not invent history or quota numbers.",
  "Advice is informational. Do not switch providers or spend quota. Prefer a currently open window over a near-ceiling one.",
].join(" ");

let inflight: Promise<ServiceBudgetAdvice> | null = null;
let memoryCache: StoredAdvice | null = null;

export function resetBudgetAdviceCache(): void {
  inflight = null;
  memoryCache = null;
}

export function budgetAdviceCachePath(directory?: string): string {
  const root = directory
    ?? join(resolveOpenScoutSupportPaths().controlHome);
  return join(root, "service-budget-advice.json");
}

export function compactBudgetAdviceSnapshot(budgets: ServiceBudgetsResponse): {
  generatedAt: number;
  gauges: Array<Record<string, unknown>>;
} {
  return {
    generatedAt: budgets.generatedAt,
    gauges: budgets.gauges.map(compactGauge),
  };
}

export async function attachBudgetAdvice(
  budgets: ServiceBudgetsResponse,
  options: {
    completeCheap: BudgetAdviceComplete;
    persistDir?: string;
    now?: () => number;
    ttlMs?: number;
    wait?: boolean;
  },
): Promise<ServiceBudgetAdvice> {
  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? BUDGET_ADVICE_TTL_MS;
  const path = budgetAdviceCachePath(options.persistDir);
  const cached = readStoredAdvice(path);
  if (cached && now - cached.generatedAt < ttlMs) {
    return publicAdvice(cached);
  }
  if (cached && !refreshAttemptIsDue(cached, now, ttlMs)) {
    return staleAdvice(cached);
  }

  if (budgets.gauges.length === 0) {
    const empty: ServiceBudgetAdvice = {
      recommendation: "",
      reason: "No provider usage to assess.",
      generatedAt: now,
      unavailable: true,
      detail: "Budgets are empty.",
    };
    writeStoredAdvice(path, { ...empty, fingerprint: "empty", lastAttemptAt: now });
    return empty;
  }

  const pending = scheduleRefresh(budgets, options, path, now);
  if (options.wait) {
    return pending;
  }
  if (cached) {
    return { ...publicAdvice(cached), stale: true };
  }
  return {
    recommendation: "",
    reason: "Quota advice is not ready yet.",
    generatedAt: 0,
    unavailable: true,
    detail: "Waiting for Scoutbot.",
  };
}

function scheduleRefresh(
  budgets: ServiceBudgetsResponse,
  options: {
    completeCheap: BudgetAdviceComplete;
    persistDir?: string;
    now?: () => number;
    ttlMs?: number;
  },
  path: string,
  now: number,
): Promise<ServiceBudgetAdvice> {
  if (inflight) return inflight;
  inflight = refreshAdvice(budgets, options, path, now).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function refreshAdvice(
  budgets: ServiceBudgetsResponse,
  options: {
    completeCheap: BudgetAdviceComplete;
  },
  path: string,
  now: number,
): Promise<ServiceBudgetAdvice> {
  const snapshot = compactBudgetAdviceSnapshot(budgets);
  const fingerprint = JSON.stringify(snapshot.gauges);
  try {
    const response = await options.completeCheap({
      systemPrompt: ADVICE_SYSTEM_PROMPT,
      body: JSON.stringify({
        assessedAt: now,
        paceNote: "History points are verified same-reset-cycle samples only. If paceUnknown is true, pace is unknown.",
        gauges: snapshot.gauges,
      }),
    });
    const parsed = parseAdviceResponse(response.text);
    const stored: StoredAdvice = {
      recommendation: parsed.recommendation,
      reason: parsed.reason,
      ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
      generatedAt: now,
      model: response.model,
      fingerprint,
      lastAttemptAt: now,
    };
    writeStoredAdvice(path, stored);
    return publicAdvice(stored);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const previous = readStoredAdvice(path);
    if (previous && !previous.unavailable) {
      writeStoredAdvice(path, {
        ...previous,
        lastAttemptAt: now,
        fingerprint: previous.fingerprint || fingerprint,
        detail,
      });
      return { ...publicAdvice(previous), stale: true, detail };
    }
    const failed: StoredAdvice = {
      recommendation: "",
      reason: "Quota advice is unavailable.",
      generatedAt: now,
      unavailable: true,
      detail,
      fingerprint,
      lastAttemptAt: now,
    };
    writeStoredAdvice(path, failed);
    return publicAdvice(failed);
  }
}

function compactGauge(gauge: ServiceGauge): Record<string, unknown> {
  if (gauge.kind === "status") {
    return {
      id: gauge.id,
      kind: "status",
      status: gauge.statusLabel,
      window: gauge.windowLabel ?? null,
      detail: gauge.detailLabel ?? null,
    };
  }
  return {
    id: gauge.id,
    kind: "quota",
    plan: gauge.plan ?? null,
    fill: roundShare(gauge.fill),
    windows: (gauge.windows ?? []).map(compactWindow),
  };
}

function compactWindow(window: ServiceQuotaWindowGauge): Record<string, unknown> {
  const awaitingReset = window.awaitingReset === true;
  const cycleResetAt = window.resetAt;
  const sameCycle = awaitingReset
    ? []
    : (window.history ?? []).filter((point) =>
      typeof point.resetAt === "number"
      && Number.isFinite(point.resetAt)
      && point.resetAt === cycleResetAt
    );
  const history = sameCycle.slice(-4).map((point) => ({
    capturedAt: point.capturedAt,
    fill: roundShare(point.fill),
    resetAt: point.resetAt,
  }));
  return {
    label: window.label,
    fill: awaitingReset ? null : roundShare(window.fill),
    used: window.usedLabel,
    cap: window.capLabel,
    unit: window.unitLabel,
    resetAt: cycleResetAt,
    awaitingReset,
    paceUnknown: awaitingReset || history.length < 2,
    history,
  };
}

function roundShare(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function parseAdviceResponse(text: string): {
  recommendation: string;
  reason: string;
  providerId?: string;
} {
  const json = extractJsonObject(text);
  if (!json) {
    throw new Error("Scoutbot advice was not JSON.");
  }
  const recommendation = stringValue(json.recommendation) ?? stringValue(json.advice);
  const reason = stringValue(json.reason) ?? stringValue(json.detail);
  if (!recommendation || !reason) {
    throw new Error("Scoutbot advice omitted recommendation or reason.");
  }
  const providerId = stringValue(json.providerId) ?? stringValue(json.provider);
  return {
    recommendation: recommendation.slice(0, 160),
    reason: reason.slice(0, 280),
    ...(providerId ? { providerId: providerId.slice(0, 64) } : {}),
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function publicAdvice(stored: StoredAdvice): ServiceBudgetAdvice {
  const { fingerprint: _fingerprint, lastAttemptAt: _lastAttemptAt, ...advice } = stored;
  return advice;
}

function staleAdvice(stored: StoredAdvice): ServiceBudgetAdvice {
  return {
    ...publicAdvice(stored),
    ...(stored.unavailable ? {} : { stale: true }),
  };
}

function refreshAttemptIsDue(cached: StoredAdvice, now: number, ttlMs: number): boolean {
  const lastAttempt = cached.lastAttemptAt ?? cached.generatedAt;
  return now - lastAttempt >= ttlMs;
}

function readStoredAdvice(path: string): StoredAdvice | null {
  if (memoryCache) return memoryCache;
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAdvice>;
    if (typeof parsed.generatedAt !== "number" || typeof parsed.reason !== "string") {
      return null;
    }
    memoryCache = {
      recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : "",
      reason: parsed.reason,
      generatedAt: parsed.generatedAt,
      fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : "",
      lastAttemptAt: typeof parsed.lastAttemptAt === "number" && Number.isFinite(parsed.lastAttemptAt)
        ? parsed.lastAttemptAt
        : parsed.generatedAt,
      ...(typeof parsed.providerId === "string" ? { providerId: parsed.providerId } : {}),
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
      ...(parsed.unavailable === true ? { unavailable: true } : {}),
      ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
    };
    return memoryCache;
  } catch {
    return null;
  }
}

function writeStoredAdvice(path: string, advice: StoredAdvice): void {
  memoryCache = advice;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(advice, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}
