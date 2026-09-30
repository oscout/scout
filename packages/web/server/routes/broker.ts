import type { Hono } from "hono";
import { createCachedSnapshot } from "../server-core.ts";
import { queryActivity, queryBrokerDiagnostics, queryHeartrate } from "../db-queries.ts";
import {
  brokerDiagnosticsNeedsFullSnapshot,
  markBrokerDiagnosticsLiveUnavailable,
  mergeBrokerDiagnosticsWithLiveSnapshot,
  type BrokerDiagnosticsSnapshot,
} from "../db/broker-live.ts";
import {
  askScoutQuestion,
  readScoutBrokerHome,
  readScoutBrokerHealth,
  readScoutBrokerMessages,
  readScoutBrokerSnapshot,
  resolveScoutBrokerUrl,
} from "../core/broker/service.ts";
import { scoutBrokerPaths } from "../core/broker/paths.ts";
import { attachBudgetAdvice } from "../service-budget-advice.ts";
import { importProviderDashboardUsage, loadServiceBudgets } from "../service-budgets.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import { recordInput } from "../web-flights.ts";
import { parseOptionalPositiveInt } from "../http-helpers.ts";
import { metadataStringValue } from "../metadata-values.ts";
import { optionalString } from "../request-values.ts";
import { readLocalHarnessTopologySnapshot } from "../harness-topology.ts";
import type { ScoutbotWebServices } from "./scoutbot.ts";
import { brokerDispatchReviewBody } from "../../shared/api/broker.ts";
import { readJsonBody } from "../request-body.ts";

type BrokerDispatchReviewAttempt = ReturnType<typeof queryBrokerDiagnostics>["attempts"][number];

function normalizeBrokerFingerprintPart(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function brokerReviewMetadata(attempt: BrokerDispatchReviewAttempt): Record<string, unknown> {
  return recordInput(attempt.metadata) ?? {};
}

function brokerReviewRawDeliveryMetadata(attempt: BrokerDispatchReviewAttempt): Record<string, unknown> | null {
  const metadata = brokerReviewMetadata(attempt);
  const raw = recordInput(metadata.raw);
  const delivery = recordInput(raw?.delivery);
  return recordInput(delivery?.metadata);
}

function brokerAttemptReviewFingerprint(attempt: BrokerDispatchReviewAttempt): string {
  const metadata = brokerReviewMetadata(attempt);
  const messageId = attempt.messageId ?? metadataStringValue(metadata, "messageId");
  const target = attempt.target ?? metadataStringValue(metadata, "targetId");
  const transport = attempt.route ?? metadataStringValue(metadata, "transport");
  if (attempt.kind === "failed_delivery" && messageId && target && transport) {
    return ["failed_delivery", messageId, target, transport].join("|");
  }

  return [
    attempt.kind,
    messageId ?? attempt.deliveryId ?? attempt.invocationId ?? attempt.id,
    target,
    transport,
    metadataStringValue(metadata, "failureReason")
      ?? metadataStringValue(metadata, "reconciledReason")
      ?? metadataStringValue(metadata, "reason")
      ?? metadataStringValue(metadata, "error")
      ?? attempt.detail,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(normalizeBrokerFingerprintPart)
    .join("|");
}

function brokerAttemptReviewRootCauseFingerprint(attempt: BrokerDispatchReviewAttempt): string {
  const metadata = brokerReviewMetadata(attempt);
  const deliveryMetadata = brokerReviewRawDeliveryMetadata(attempt);
  return [
    attempt.kind,
    attempt.target ?? metadataStringValue(metadata, "targetId"),
    attempt.route ?? metadataStringValue(metadata, "transport"),
    metadataStringValue(metadata, "failureReason")
      ?? metadataStringValue(metadata, "reconciledReason")
      ?? metadataStringValue(metadata, "error")
      ?? metadataStringValue(deliveryMetadata, "failureReason")
      ?? metadataStringValue(deliveryMetadata, "reconciledReason")
      ?? metadataStringValue(deliveryMetadata, "error")
      ?? attempt.status,
    metadataStringValue(metadata, "failureDetail")
      ?? metadataStringValue(deliveryMetadata, "failureDetail")
      ?? metadataStringValue(metadata, "reason")
      ?? attempt.detail,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => normalizeBrokerFingerprintPart(value).toLowerCase())
    .join("|");
}

function brokerAttemptReviewContextText(input: {
  attempt: BrokerDispatchReviewAttempt;
  related: BrokerDispatchReviewAttempt[];
  windowMs: number;
}): string {
  const fingerprint = brokerAttemptReviewFingerprint(input.attempt);
  const rootCauseFingerprint = brokerAttemptReviewRootCauseFingerprint(input.attempt);
  const context = {
    generatedAt: new Date().toISOString(),
    windowMs: input.windowMs,
    dedupeFingerprint: fingerprint,
    rootCauseFingerprint,
    attempt: input.attempt,
    relatedAttempts: input.related,
  };
  return [
    "OpenScout dispatch failure context",
    "",
    `id: ${input.attempt.id}`,
    `kind: ${input.attempt.kind}`,
    `status: ${input.attempt.status}`,
    `time: ${new Date(input.attempt.ts).toISOString()}`,
    `target: ${input.attempt.target ?? "none"}`,
    `transport/route: ${input.attempt.route ?? "none"}`,
    `messageId: ${input.attempt.messageId ?? "none"}`,
    `deliveryId: ${input.attempt.deliveryId ?? "none"}`,
    `invocationId: ${input.attempt.invocationId ?? "none"}`,
    `conversationId: ${input.attempt.conversationId ?? "none"}`,
    `detail: ${input.attempt.detail}`,
    `dedupeFingerprint: ${fingerprint}`,
    `rootCauseFingerprint: ${rootCauseFingerprint}`,
    "",
    "Full JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function brokerDispatchReviewPrompt(input: {
  attempt: BrokerDispatchReviewAttempt;
  related: BrokerDispatchReviewAttempt[];
  windowMs: number;
}): string {
  return [
    "Review this from first principles, then inspect the relevant implementation.",
    "",
    "Topic: OpenScout failed dispatch / failed delivery",
    "Workspace: /Users/art/dev/openscout",
    "",
    "User goal:",
    "- Diagnose this failed dispatch from the Dispatch screen.",
    "- Identify the root cause and the narrowest fix.",
    "- Explain how to avoid readdressing the same failure cluster in the recurring triage loop.",
    "",
    "Observed failed dispatch context:",
    "```text",
    brokerAttemptReviewContextText(input),
    "```",
    "",
    "Please answer:",
    "1. What is the likely root cause? Distinguish symptom from cause.",
    "2. Is this a duplicate of an already-known failure cluster? Use the dedupe fingerprint and related rows.",
    "3. What code change, config fix, or operational action should resolve it?",
    "4. What checks would prove the fix?",
    "",
    "Response contract:",
    "- Keep the message short: one sentence for cause and next move, then an `Evidence` list.",
    "- Make the Evidence list most of the response. Prefer precise pointers to Scout data and messages",
    "  (`messageId`, `deliveryId`, `conversationId`, `invocationId`, or attempt id), stack/log source plus",
    "  timestamp or range, and implementation `file:line` or the exact verification command.",
    "- Do not paste the supplied JSON or long log excerpts back. Quote at most one short line when a pointer alone is ambiguous.",
    "- If a claim has no supporting pointer, label it as an inference or missing evidence.",
    "",
    "Do not edit files unless the user explicitly asks in a follow-up.",
  ].join("\n");
}

export type BrokerRouteDeps = {
  currentDirectory: string;
  scoutbot: ScoutbotWebServices;
};

export function mountBrokerRoutes(app: Hono, deps: BrokerRouteDeps) {
  const { currentDirectory, scoutbot } = deps;

  const dispatchBrokerSnapshotCache = createCachedSnapshot<BrokerDiagnosticsSnapshot | null>(async () => {
    const baseUrl = resolveScoutBrokerUrl();
    const signal = AbortSignal.timeout(2_000);
    const [messages, health, home] = await Promise.all([
      readScoutBrokerMessages({ baseUrl, limit: 500, signal }),
      readScoutBrokerHealth(baseUrl, { signal }),
      readScoutBrokerHome(baseUrl, { signal }),
    ]);
    if (!messages) return null;
    return {
      actors: Object.fromEntries(
        (home?.agents ?? []).map((agent) => [agent.id, { displayName: agent.title }]),
      ),
      messages: Object.fromEntries(messages.map((message) => [message.id, message])),
      totalMessageCount: health.counts?.messages ?? null,
      projectionStatus: health.projection?.state ?? null,
    };
  }, 0);
  const dispatchFullBrokerSnapshotCache = createCachedSnapshot(
    () => readScoutBrokerSnapshot(
      resolveScoutBrokerUrl(),
      { signal: AbortSignal.timeout(5_000) },
    ),
    0,
  );
  // Local fallback for /api/topology/snapshot when the broker cannot answer.
  // The observer walks every harness home on disk with force=true, so the
  // fallback holds one 30s snapshot instead of constructing a fresh observer
  // and rescanning per request. `?force=1` refreshes it through `get({force})`.
  const localTopologySnapshotCache = createCachedSnapshot(
    () => readLocalHarnessTopologySnapshot(),
    30_000,
  );

  app.get("/api/activity", (c) => c.json(queryActivity()));
  app.get("/api/topology/snapshot", async (c) => {
    const sessionId = c.req.query("sessionId")?.trim() || null;
    if (sessionId) {
      // Session-scoped reads stay uncached: each session id is its own scan.
      const localSnapshot = await readLocalHarnessTopologySnapshot({ claudeSessionId: sessionId });
      if (localSnapshot) return c.json(localSnapshot);
    }

    const force = c.req.query("force") === "1";
    const url = new URL(scoutBrokerPaths.v1.topologySnapshot, resolveScoutBrokerUrl());
    if (force) {
      url.searchParams.set("force", "1");
    }
    const localFallback = () => localTopologySnapshotCache.get({ force }).catch(() => null);
    try {
      // A broker mid-rebuild can sit on this for a long time; an unbounded
      // fetch left the route hanging with it. Past the deadline the local
      // observer answers instead.
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const brokerSnapshot = await res.json();
        if (brokerSnapshot?.totals?.sources > 0) {
          // The broker answered with substance — never rescan locally on top.
          return c.json(brokerSnapshot);
        }
        const localSnapshot = await localFallback();
        return c.json(localSnapshot?.totals.sources ? localSnapshot : brokerSnapshot);
      }
    } catch {
      /* Fall through to the local read-only observer. */
    }
    const localSnapshot = await localFallback();
    if (localSnapshot) return c.json(localSnapshot);
    return c.json({ error: "broker topology unavailable" }, 502);
  });
  // Liveness only, for status chrome that must not pull a snapshot to know it.
  app.get("/api/broker/health", async (c) => {
    const health = await readScoutBrokerHealth(resolveScoutBrokerUrl(), { timeoutMs: 1_000 });
    return c.json({ reachable: health.reachable, ok: health.ok, error: health.error ?? null });
  });
  app.get("/api/broker", async (c) => {
    const cursor = c.req.query("cursor") ?? null;
    const diagnostics = queryBrokerDiagnostics({
      limit: parseOptionalPositiveInt(c.req.query("limit"), 120),
      windowMs: parseOptionalPositiveInt(c.req.query("windowMs")),
      cursor,
      scopeRowsToWindow: c.req.query("scopeRowsToWindow") === "1"
        || c.req.query("scopeRowsToWindow") === "true",
    });
    let broker = await dispatchBrokerSnapshotCache.get().catch(() => null);
    if (broker && brokerDiagnosticsNeedsFullSnapshot(diagnostics, broker)) {
      const completeSnapshot = await dispatchFullBrokerSnapshotCache.get().catch(() => null);
      broker = completeSnapshot
        ? {
            actors: completeSnapshot.actors,
            messages: completeSnapshot.messages,
            totalMessageCount: broker.totalMessageCount,
            projectionStatus: broker.projectionStatus,
            messageCoverageIncomplete: false,
          }
        : { ...broker, messageCoverageIncomplete: true };
    }
    const brokerHealth = broker
      ? null
      : await readScoutBrokerHealth(resolveScoutBrokerUrl(), {
          signal: AbortSignal.timeout(1_000),
        });
    return c.json(
      broker
        ? mergeBrokerDiagnosticsWithLiveSnapshot(diagnostics, broker, cursor)
        : markBrokerDiagnosticsLiveUnavailable(diagnostics, {
            brokerReachable: brokerHealth?.reachable === true && brokerHealth.ok,
          }),
    );
  });
  app.post("/api/broker/dispatch-review", async (c) => {
    const parsed = await readJsonBody(c, brokerDispatchReviewBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const attemptId = optionalString(body.attemptId)?.trim()
      || optionalString(body.attempt?.id)?.trim();
    const windowMs = 30 * 60_000;
    const diagnostics = queryBrokerDiagnostics({
      limit: 240,
      windowMs,
      scopeRowsToWindow: true,
    });
    const candidates = [
      ...diagnostics.failedDeliveries,
      ...diagnostics.failedQueries,
      ...diagnostics.attempts,
    ];
    // Dispatch renders one message-oriented row by folding its delivery state
    // into the message. That synthesized row id may not exist in the raw
    // diagnostics candidates, so prefer canonical broker data when available
    // and otherwise review the exact snapshot the operator inspected.
    const attempt = (attemptId
      ? candidates.find((entry) => entry.id === attemptId)
      : undefined) ?? body.attempt;
    if (!attempt?.id) {
      return c.json({ error: "attemptId or attempt is required" }, 400);
    }
    if (attempt.kind !== "failed_delivery" && attempt.kind !== "failed_query" && attempt.status !== "failed") {
      return c.json({ error: "dispatch review requires a failed dispatch row" }, 400);
    }

    const dedupeFingerprint = brokerAttemptReviewFingerprint(attempt);
    const rootCauseFingerprint = brokerAttemptReviewRootCauseFingerprint(attempt);
    const related = candidates
      .filter((entry) => entry.id !== attempt.id)
      .filter((entry) =>
        brokerAttemptReviewFingerprint(entry) === dedupeFingerprint
        || brokerAttemptReviewRootCauseFingerprint(entry) === rootCauseFingerprint
        || Boolean(attempt.messageId && entry.messageId === attempt.messageId)
        || Boolean(attempt.conversationId && entry.conversationId === attempt.conversationId)
        || (
          Boolean(attempt.target && entry.target === attempt.target)
          && Boolean(attempt.route && entry.route === attempt.route)
          && entry.kind === attempt.kind
        )
      )
      .slice(0, 12);
    const requestMetadata = {
      source: "scout-dispatch-review",
      dispatchAttemptId: attempt.id,
      ...(attempt.deliveryId ? { deliveryId: attempt.deliveryId } : {}),
      ...(attempt.messageId ? { messageId: attempt.messageId } : {}),
      ...(attempt.conversationId ? { conversationId: attempt.conversationId } : {}),
      ...(attempt.target ? { targetId: attempt.target } : {}),
      ...(attempt.route ? { transport: attempt.route } : {}),
      dedupeFingerprint,
      rootCauseFingerprint,
    };

    const result = await askScoutQuestion({
      senderId: resolveOperatorName().trim() || "operator",
      target: { kind: "project_path", projectPath: currentDirectory },
      body: brokerDispatchReviewPrompt({ attempt, related, windowMs }),
      executionHarness: "codex",
      projectAgent: {
        persistence: "one_time",
      },
      currentDirectory,
      source: "scout-dispatch-review",
      messageMetadata: requestMetadata,
      invocationMetadata: requestMetadata,
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }
    if (result.unresolvedTarget) {
      return c.json(
        {
          error: `could not route dispatch review to ${result.unresolvedTarget}`,
          targetDiagnostic: result.targetDiagnostic ?? null,
        },
        409,
      );
    }

    return c.json({
      ok: true,
      conversationId: result.conversationId ?? null,
      messageId: result.messageId ?? null,
      flightId: result.flight?.id ?? null,
      targetAgentId: result.flight?.targetAgentId ?? result.targetAgentId ?? null,
      targetLabel: result.targetLabel ?? null,
      dedupeFingerprint,
      rootCauseFingerprint,
    });
  });
  app.get("/api/heartrate", (c) => c.json(queryHeartrate()));
  app.get("/api/service-budgets", async (c) => {
    const refresh = c.req.query("refresh");
    const budgets = await loadServiceBudgets(refresh === "1" || refresh === "true");
    const advice = await attachBudgetAdvice(budgets, {
      completeCheap: (input) => scoutbot.assistant.completeCheap(input),
    });
    return c.json({ ...budgets, advice });
  });
  app.post("/api/service-budgets/dashboard-import", async (c) => {
    const body = await c.req.json<{ provider?: unknown; text?: unknown }>().catch(() => null);
    try {
      const gauge = importProviderDashboardUsage({
        provider: body?.provider,
        text: body?.text,
      });
      return c.json({ ok: true, gauge });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Dashboard import failed." }, 400);
    }
  });
}
