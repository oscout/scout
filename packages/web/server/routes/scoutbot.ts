import type { Hono } from "hono";
import {
  getTailDiscovery,
  readRecentTranscriptEvents,
  refreshTailDiscovery,
  snapshotRecentEvents,
} from "@openscout/runtime/tail";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import {
  interruptCodexAppServerLocalAgent,
  invokeCodexAppServerLocalAgent,
  normalizeCodexAppServerLaunchArgs,
} from "@openscout/agent-sessions/local";
import { relayAgentLogsDirectory, relayAgentRuntimeDirectory } from "@openscout/runtime/support-paths";

import {
  askScoutQuestion,
  loadScoutRelayConfig,
} from "../core/broker/service.ts";
import { emitBroadcast } from "../core/broadcast/service.ts";
import { loadMeshStatus } from "../core/mesh/service.ts";
import {
  queryActivity,
  queryAgents,
  queryBrokerDiagnostics,
  queryFleet,
  queryFlights,
  queryHeartrate,
  queryRecentMessages,
  queryRuns,
  querySessions,
  queryWorkItems,
} from "../db-queries.ts";
import {
  deleteBriefing,
  getBriefing,
  listBriefings,
  saveBriefing,
  type BriefingKind,
} from "../db/briefings.ts";
import {
  createScoutbotAssistantService,
  ScoutbotAssistantError,
  type ScoutbotBrief,
  type ScoutbotBriefCapture,
  type ScoutbotBriefObservation,
  type ScoutbotBriefReference,
  type ScoutbotCodexAssistantInvoker,
} from "../scoutbot-assistant.ts";
import {
  createScoutbotReminderStore,
  ScoutbotReminderError,
} from "../scoutbot-reminders.ts";
import { createScoutbotCredentialStore } from "../scoutbot-credentials.ts";
import {
  startScoutbotRunner,
  type ScoutbotRunnerHandle,
} from "../scoutbot/runner.ts";
import { SCOUTBOT_REASONING_EFFORT } from "../scoutbot/role.ts";

export type WebTailRuntime = {
  getTailDiscovery: typeof getTailDiscovery;
  refreshTailDiscovery: typeof refreshTailDiscovery;
  readRecentTranscriptEvents: typeof readRecentTranscriptEvents;
  snapshotRecentEvents: typeof snapshotRecentEvents;
};

export type ScoutbotOperatorAttentionState = {
  generatedAt: number;
  totals: Record<string, number>;
  items: unknown[];
};

export type ScoutbotLoadOperatorAttention = (
  currentDirectory: string,
) => Promise<ScoutbotOperatorAttentionState | null>;

export type ScoutbotBuildInfo = {
  version: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  mode: "dev" | "production";
};

export type ScoutbotLoadBuildInfo = (currentDirectory: string) => ScoutbotBuildInfo;

export type ScoutbotServicesOptions = {
  currentDirectory: string;
  tailRuntime: WebTailRuntime;
  loadOperatorAttention: ScoutbotLoadOperatorAttention;
  loadBuildInfo: ScoutbotLoadBuildInfo;
  invokeCodex?: ScoutbotCodexAssistantInvoker;
  scoutbot?: {
    enabled?: boolean;
    brokerBaseUrl?: string;
  };
};

export type ScoutbotWebServices = {
  assistant: ReturnType<typeof createScoutbotAssistantService>;
  reminders: ReturnType<typeof createScoutbotReminderStore>;
  credentials: ReturnType<typeof createScoutbotCredentialStore>;
  resolveOpenAIApiKey: () => Promise<string | undefined>;
  runner: ScoutbotRunnerHandle | null;
  waitForRunner: () => Promise<ScoutbotRunnerHandle | null>;
  loadFleetHomeBrief: () => Promise<FleetHomeBrief>;
  stopRunner: () => Promise<void>;
};

type FleetHomeBrief = {
  id: string;
  statement: string;
  summary: string;
  observations: FleetHomeBriefObservation[];
  preparedAt: number;
  expiresAt: number;
  ttlMs: number;
  sourceBriefId: string;
};

type FleetHomeBriefReference = {
  id: string;
  kind: string;
  label: string;
  route?: Record<string, unknown>;
  detail?: string;
};

type FleetHomeBriefObservation = {
  id: string;
  text: string;
  tone?: string;
  references: FleetHomeBriefReference[];
};

const FLEET_HOME_BRIEF_TTL_MS = 30 * 60_000;

function persistBriefing(
  kind: BriefingKind,
  brief: ScoutbotBrief,
  capture: ScoutbotBriefCapture,
): void {
  try {
    const observations = brief.steps.flatMap((step) => step.observations ?? []);
    saveBriefing({
      id: brief.id,
      kind,
      title: brief.title,
      summary: brief.summary,
      recommendation: brief.recommendation || null,
      preparedAt: brief.preparedAt,
      ttlMs: brief.ttlMs,
      brief,
      observations,
      snapshot: capture.snapshot,
      call: capture.call,
      markdown: brief.markdown ?? null,
    });
  } catch (err) {
    console.warn(
      "[briefings] auto-save failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

function buildFleetHomeBrief(brief: ScoutbotBrief): FleetHomeBrief {
  const fleetStep = brief.steps.find((step) =>
    step.route?.view === "inbox"
    || step.route?.view === "fleet"
    || step.id === "fleet"
    || step.id === "fleet-home"
  );
  const statement = (fleetStep?.narration ?? brief.steps[0]?.narration ?? brief.summary).trim();
  const observations = buildFleetHomeBriefObservations(statement || brief.summary, fleetStep?.observations ?? []);
  return {
    id: `fleet-home:${brief.id}`,
    statement: statement || brief.summary,
    summary: brief.summary,
    observations,
    preparedAt: brief.preparedAt,
    expiresAt: brief.expiresAt,
    ttlMs: brief.ttlMs,
    sourceBriefId: brief.id,
  };
}

function buildFleetHomeBriefObservations(
  statement: string,
  modelObservations: ScoutbotBriefObservation[],
): FleetHomeBriefObservation[] {
  const modelItems = modelObservations
    .map((item, index) => ({
      id: `obs-${index + 1}`,
      text: item.text.trim(),
      ...(item.tone ? { tone: item.tone } : {}),
      references: dedupeFleetBriefReferences(
        item.references
          .map(normalizeFleetBriefReference)
          .filter((ref): ref is FleetHomeBriefReference => ref !== null),
      ),
    }))
    .filter((item) => item.text);

  const baseItems = modelItems.length > 0
    ? modelItems
    : splitFleetBriefSentences(statement).map((text, index) => ({
      id: `obs-${index + 1}`,
      text,
      references: [] as FleetHomeBriefReference[],
    }));

  return baseItems.map((item, index) => ({
    ...item,
    id: item.id || `obs-${index + 1}`,
    references: dedupeFleetBriefReferences([
      ...item.references,
      ...inferFleetBriefReferences(item.text),
    ]).slice(0, 4),
  }));
}

function splitFleetBriefSentences(value: string): string[] {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return [];
  const parts = compact.match(/[^.!?]+[.!?]?/g)
    ?.map((part) => part.trim())
    .filter(Boolean) ?? [compact];
  return parts.slice(0, 4).map((part) => /[.!?]$/.test(part) ? part : `${part}.`);
}

function normalizeFleetBriefReference(ref: ScoutbotBriefReference): FleetHomeBriefReference | null {
  const label = ref.label.trim();
  if (!label) return null;
  const id = `${ref.kind}:${label}:${JSON.stringify(ref.route ?? {})}`;
  return {
    id,
    kind: ref.kind,
    label,
    ...(ref.route ? { route: ref.route } : {}),
    ...(ref.detail ? { detail: ref.detail } : {}),
  };
}

function inferFleetBriefReferences(text: string): FleetHomeBriefReference[] {
  const refs: FleetHomeBriefReference[] = [];
  const lower = text.toLowerCase();
  const agents = queryAgents(200).filter((agent) => !isScoutbotLikeAgentRecord(agent));
  for (const agent of agents) {
    const names = [agent.name, agent.handle ? `@${agent.handle}` : "", agent.handle ?? ""]
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.some((name) => lower.includes(name.toLowerCase()))) {
      refs.push({
        id: `agent:${agent.id}`,
        kind: "agent",
        label: agent.name,
        route: { view: "agents-v2", agentId: agent.id, tab: "observe" },
        ...(agent.handle ? { detail: `@${agent.handle}` } : {}),
      });
    }
  }

  const fleet = queryFleet({ limit: 12, activityLimit: 40 });
  const attentionTerms = /\b(attention|badge|pending|review|reviews|blocked|blocking|stalled|waiting|open work|work items?|next moves?|operator)\b/i;
  if (attentionTerms.test(text)) {
    for (const item of fleet.needsAttention.slice(0, 3)) {
      refs.push({
        id: `${item.kind}:${item.recordId}`,
        kind: item.kind === "work_item" ? "work" : "question",
        label: item.title,
        route: item.conversationId
          ? { view: "conversation", conversationId: item.conversationId }
          : item.kind === "work_item" && item.recordId
            ? {
                view: "follow",
                workId: item.recordId,
                preferredView: "chat",
                ...(item.agentId ? { targetAgentId: item.agentId } : {}),
              }
            : item.agentId
              ? { view: "agents-v2", agentId: item.agentId, tab: "message" }
              : { view: "inbox" },
        detail: item.agentName ?? item.state,
      });
    }
    for (const ask of fleet.recentCompleted.filter((item) => item.status === "failed" || item.attention !== "silent").slice(0, 2)) {
      refs.push({
        id: `ask:${ask.invocationId}`,
        kind: ask.status === "failed" ? "failure" : "ask",
        label: ask.agentName ?? ask.task,
        route: ask.conversationId
          ? { view: "conversation", conversationId: ask.conversationId }
          : { view: "agents-v2", agentId: ask.agentId, tab: "observe" },
        detail: ask.statusLabel,
      });
    }
  }

  const sessionTerms = /\b(session|transcript|assets?|artifact|render|copy|font|files?)\b/i;
  if (sessionTerms.test(text)) {
    const sessions = querySessions(80);
    for (const session of sessions.slice(0, 2)) {
      const label = session.title || session.agentName || session.id;
      if (
        lower.includes(label.toLowerCase())
        || (session.agentName && lower.includes(session.agentName.toLowerCase()))
        || (session.preview && hasSharedWord(lower, session.preview.toLowerCase()))
      ) {
        refs.push({
          id: `session:${session.id}`,
          kind: "session",
          label,
          route: { view: "sessions", sessionId: session.id },
          ...(session.agentName ? { detail: session.agentName } : {}),
        });
      }
    }
  }

  const conversationTerms = /\b(conversation|thread|message|handoff|approval|approved|ship|shipped|completed)\b/i;
  if (conversationTerms.test(text)) {
    for (const activity of queryActivity(80).slice(0, 4)) {
      const haystack = `${activity.actorName ?? ""} ${activity.agentName ?? ""} ${activity.title ?? ""} ${activity.summary ?? ""}`.toLowerCase();
      if (!activity.conversationId || !hasSharedWord(lower, haystack)) continue;
      refs.push({
        id: `conversation:${activity.conversationId}`,
        kind: "conversation",
        label: activity.title ?? activity.actorName ?? "Open thread",
        route: { view: "conversation", conversationId: activity.conversationId },
        detail: activity.actorName ?? undefined,
      });
      break;
    }
  }

  return refs;
}

function hasSharedWord(left: string, right: string): boolean {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "work", "item", "items"]);
  const words = left
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length >= 5 && !stop.has(word));
  return words.some((word) => right.includes(word));
}

function dedupeFleetBriefReferences(refs: FleetHomeBriefReference[]): FleetHomeBriefReference[] {
  const seen = new Set<string>();
  const result: FleetHomeBriefReference[] = [];
  for (const ref of refs) {
    const key = ref.id || `${ref.kind}:${ref.label}:${JSON.stringify(ref.route ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function compactScoutbotText(value: string | null | undefined, max = 280): string | null {
  const compacted = (value ?? "").replace(/\s+/g, " ").trim();
  if (!compacted) {
    return null;
  }
  return compacted.length > max ? `${compacted.slice(0, max - 1)}...` : compacted;
}
async function buildScoutbotAssistantControlState(
  currentDirectory: string,
  tailRuntime: WebTailRuntime,
  loadOperatorAttention: ScoutbotLoadOperatorAttention,
  loadBuildInfo: ScoutbotLoadBuildInfo,
  route?: unknown,
) {
  const omittedActiveAgentId = isScoutbotAssistantRoute(route) ? "scoutbot" : null;
  const [attention, mesh, tailDiscovery] = await Promise.all([
    valueOrNull(loadOperatorAttention(currentDirectory)),
    valueOrNull(loadMeshStatus()),
    valueOrNull(tailRuntime.getTailDiscovery()),
  ]);
  const broker = queryBrokerDiagnostics({ limit: 80, windowMs: 6 * 60 * 60_000 });
  const fleet = queryFleet({ limit: 16, activityLimit: 40 });
  const transcriptEvents = await valueOrNull(
    tailRuntime.readRecentTranscriptEvents(50, {
      ...(tailDiscovery ? { discovery: tailDiscovery } : {}),
    }),
  );
  const agentLogEvents = transcriptEvents && transcriptEvents.length > 0
    ? transcriptEvents
    : tailRuntime.snapshotRecentEvents(50).slice().reverse();
  const agentLogMessages = agentLogEvents
    .filter((event) => event.kind !== "system")
    .filter((event) => !event.summary.toLowerCase().startsWith("permission-mode"))
    .map(compactScoutbotTailEvent);
  const scoutChatter = queryRecentMessages(50).map(compactScoutbotMessage);
  const activeRuns = queryRuns({ active: true, limit: 24 })
    .filter((run) => run.agentId !== omittedActiveAgentId);
  const activeFlights = queryFlights({ activeOnly: true })
    .filter((flight) => flight.agentId !== omittedActiveAgentId)
    .slice(0, 24);

  return {
    build: loadBuildInfo(currentDirectory),
    agents: queryAgents(40)
      .filter((agent) => !isScoutbotLikeAgentRecord(agent))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        handle: agent.handle,
        state: agent.state,
        harness: agent.harness,
        transport: agent.transport,
        model: agent.model,
        project: agent.project,
        branch: agent.branch,
        cwd: agent.cwd,
        updatedAt: agent.updatedAt,
        conversationId: agent.conversationId,
      })),
    fleet: {
      generatedAt: fleet.generatedAt,
      totals: fleet.totals,
      activeAsks: fleet.activeAsks.slice(0, 12).map(compactScoutbotFleetAsk),
      needsAttention: fleet.needsAttention.slice(0, 12).map(compactScoutbotFleetAttention),
      recentCompleted: fleet.recentCompleted.slice(0, 8).map(compactScoutbotFleetAsk),
      activity: fleet.activity.slice(0, 12).map(compactScoutbotActivity),
    },
    operatorAttention: attention
      ? {
          generatedAt: attention.generatedAt,
          totals: attention.totals,
          items: attention.items.slice(0, 16),
        }
      : null,
    broker: {
      generatedAt: broker.generatedAt,
      windowMs: broker.windowMs,
      totals: broker.totals,
      rates: broker.rates,
      failedQueries: broker.failedQueries.slice(0, 8).map(compactScoutbotRouteAttempt),
      failedDeliveries: broker.failedDeliveries.slice(0, 8).map(compactScoutbotRouteAttempt),
      attempts: broker.attempts.slice(0, 12).map(compactScoutbotRouteAttempt),
      dialogue: broker.dialogue.slice(0, 12).map(compactScoutbotDialogue),
    },
    activeWork: queryWorkItems({ activeOnly: true, limit: 20 }).map(compactScoutbotWorkItem),
    activeRuns,
    activeFlights,
    sessions: querySessions(24),
    recentMessages: scoutChatter.slice(0, 16),
    recentActivity: queryActivity(16).map(compactScoutbotActivity),
    briefingEvidence: {
      agentLogMessages,
      scoutChatter,
    },
    heartrate: queryHeartrate(),
    mesh: mesh
      ? {
          brokerUrl: mesh.brokerUrl,
          identity: mesh.identity,
          meshId: mesh.meshId,
          localNode: mesh.localNode,
          issueCount: mesh.issues.length,
          issues: mesh.issues,
          warnings: mesh.warnings,
          tailscale: {
            available: mesh.tailscale.available,
            running: mesh.tailscale.running,
            backendState: mesh.tailscale.backendState,
            onlineCount: mesh.tailscale.onlineCount,
          },
        }
      : null,
    harnessActivity: tailDiscovery
      ? {
          generatedAt: tailDiscovery.generatedAt,
          totals: tailDiscovery.totals,
          processes: tailDiscovery.processes.slice(0, 24).map((p) => ({
            pid: p.pid,
            source: p.source,
            harness: p.harness,
            command: compactScoutbotText(p.command, 140),
            cwd: p.cwd,
            etime: p.etime,
          })),
          transcripts: tailDiscovery.transcripts.slice(0, 24).map((t) => ({
            source: t.source,
            harness: t.harness,
            sessionId: t.sessionId,
            project: t.project,
            cwd: t.cwd,
            transcriptPath: t.transcriptPath,
            mtimeMs: t.mtimeMs,
            size: t.size,
          })),
        }
      : null,
  };
}

function isScoutbotAssistantRoute(route: unknown): boolean {
  return Boolean(
    route
    && typeof route === "object"
    && (route as { surface?: unknown }).surface === "scoutbot",
  );
}

function compactScoutbotFleetAsk(ask: ReturnType<typeof queryFleet>["activeAsks"][number]) {
  return {
    invocationId: ask.invocationId,
    flightId: ask.flightId,
    agentId: ask.agentId,
    agentName: ask.agentName,
    conversationId: ask.conversationId,
    task: compactScoutbotText(ask.task, 260),
    status: ask.status,
    statusLabel: ask.statusLabel,
    attention: ask.attention,
    summary: compactScoutbotText(ask.summary, 260),
    startedAt: ask.startedAt,
    completedAt: ask.completedAt,
    updatedAt: ask.updatedAt,
  };
}

function compactScoutbotFleetAttention(item: ReturnType<typeof queryFleet>["needsAttention"][number]) {
  return {
    kind: item.kind,
    recordId: item.recordId,
    title: compactScoutbotText(item.title, 180),
    summary: compactScoutbotText(item.summary, 260),
    agentId: item.agentId,
    agentName: item.agentName,
    conversationId: item.conversationId,
    state: item.state,
    acceptanceState: item.acceptanceState,
    updatedAt: item.updatedAt,
  };
}

function compactScoutbotActivity(item: ReturnType<typeof queryActivity>[number]) {
  return {
    id: item.id,
    kind: item.kind,
    ts: item.ts,
    actorName: item.actorName,
    title: compactScoutbotText(item.title, 180),
    summary: compactScoutbotText(item.summary, 260),
    conversationId: item.conversationId,
    workspaceRoot: item.workspaceRoot,
  };
}

function compactScoutbotRouteAttempt(attempt: ReturnType<typeof queryBrokerDiagnostics>["attempts"][number]) {
  return {
    id: attempt.id,
    kind: attempt.kind,
    status: attempt.status,
    ts: attempt.ts,
    actorName: attempt.actorName,
    target: attempt.target,
    route: attempt.route,
    detail: compactScoutbotText(attempt.detail, 320),
    conversationId: attempt.conversationId,
    messageId: attempt.messageId,
    deliveryId: attempt.deliveryId,
    invocationId: attempt.invocationId,
  };
}

function compactScoutbotDialogue(item: ReturnType<typeof queryBrokerDiagnostics>["dialogue"][number]) {
  return {
    id: item.id,
    ts: item.ts,
    actorName: item.actorName,
    conversationId: item.conversationId,
    body: compactScoutbotText(item.body, 320),
    class: item.class,
  };
}

function compactScoutbotWorkItem(item: ReturnType<typeof queryWorkItems>[number]) {
  return {
    id: item.id,
    title: compactScoutbotText(item.title, 180),
    summary: compactScoutbotText(item.summary, 260),
    ownerId: item.ownerId,
    ownerName: item.ownerName,
    nextMoveOwnerId: item.nextMoveOwnerId,
    nextMoveOwnerName: item.nextMoveOwnerName,
    conversationId: item.conversationId,
    state: item.state,
    acceptanceState: item.acceptanceState,
    priority: item.priority,
    currentPhase: item.currentPhase,
    attention: item.attention,
    activeChildWorkCount: item.activeChildWorkCount,
    activeFlightCount: item.activeFlightCount,
    lastMeaningfulAt: item.lastMeaningfulAt,
    lastMeaningfulSummary: compactScoutbotText(item.lastMeaningfulSummary, 260),
  };
}

function compactScoutbotMessage(message: ReturnType<typeof queryRecentMessages>[number]) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    actorName: message.actorName,
    body: compactScoutbotText(message.body, 320),
    createdAt: message.createdAt,
    class: message.class,
  };
}

function compactScoutbotTailEvent(event: ReturnType<typeof snapshotRecentEvents>[number]) {
  return {
    id: event.id,
    ts: event.ts,
    source: event.source,
    sessionId: event.sessionId,
    project: event.project,
    cwd: event.cwd,
    harness: event.harness,
    kind: event.kind,
    summary: compactScoutbotText(event.summary, 360),
  };
}

async function valueOrNull<T>(value: Promise<T> | T): Promise<T | null> {
  try {
    return await value;
  } catch {
    return null;
  }
}

function isScoutbotLikeAgentRecord(agent: { id: string; name: string; handle: string | null; role: string | null }): boolean {
  return [agent.id, agent.name, agent.handle ?? "", agent.role ?? ""]
    .map((value) => value.trim().toLowerCase())
    .some((value) => value === "scoutbot" || value.startsWith("scoutbot.") || value.includes(".scoutbot."));
}

function previewSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 10) {
    return "configured";
  }
  return `${trimmed.slice(0, 5)}...${trimmed.slice(-4)}`;
}

function normalizeVoiceTurn(value: unknown): { turn: number; gen: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.turn !== "number" || typeof record.gen !== "number") return null;
  const turn = record.turn;
  const gen = record.gen;
  if (!Number.isSafeInteger(turn) || turn < 0) return null;
  if (!Number.isSafeInteger(gen) || gen < 0) return null;
  return { turn, gen };
}

async function resolveScoutbotCredentialState(
  scoutbotCredentials: ReturnType<typeof createScoutbotCredentialStore>,
): Promise<{
  openai: {
    configured: boolean;
    source: "env" | "local-config" | "local-store" | "missing";
    preview: string | null;
  };
}> {
  const envKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const config = await loadScoutRelayConfig().catch(
    () => ({}) as Awaited<ReturnType<typeof loadScoutRelayConfig>>,
  );
  const configKey = typeof config.openaiApiKey === "string" ? config.openaiApiKey.trim() : "";
  const storeKey = scoutbotCredentials.getOpenAIKey()?.trim() ?? "";
  const key = envKey || configKey || storeKey;
  return {
    openai: {
      configured: Boolean(key),
      source: envKey ? "env" : configKey ? "local-config" : storeKey ? "local-store" : "missing",
      preview: key ? previewSecret(key) : null,
    },
  };
}

function buildScoutbotCodexProcessEnv(currentDirectory: string): NodeJS.ProcessEnv {
  const cwd = currentDirectory.trim();
  return {
    ...process.env,
    OPENSCOUT_AGENT: "scoutbot-assistant",
    OPENSCOUT_SETUP_CWD: cwd,
    OPENSCOUT_MANAGED_AGENT: "1",
  };
}

function createDefaultScoutbotCodexInvoker(currentDirectory: string): ScoutbotCodexAssistantInvoker {
  return async (input) => {
    const runtimeName = `scoutbot-assistant-${sanitizeSupportPathSegment(input.sessionId)}`;
    const invocation: Parameters<typeof invokeCodexAppServerLocalAgent>[0] = {
      agentName: "scoutbot-assistant",
      sessionId: input.sessionId,
      cwd: currentDirectory,
      systemPrompt: input.systemPrompt,
      runtimeDirectory: relayAgentRuntimeDirectory(runtimeName),
      logsDirectory: relayAgentLogsDirectory(runtimeName),
      launchArgs: buildScoutbotAssistantCodexLaunchArgs(process.env),
      processEnv: buildScoutbotCodexProcessEnv(currentDirectory),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      approvalPolicy: "never",
      sandbox: "read-only",
    };
    if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const interrupt = () => {
      void interruptCodexAppServerLocalAgent(invocation).catch(() => {});
    };
    input.signal?.addEventListener("abort", interrupt, { once: true });
    let result;
    try {
      result = await invokeCodexAppServerLocalAgent(invocation);
      if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
    } finally {
      input.signal?.removeEventListener("abort", interrupt);
    }
    return {
      output: result.output,
      threadId: result.threadId,
    };
  };
}

function buildScoutbotAssistantCodexLaunchArgs(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  const model = env.OPENSCOUT_SCOUTBOT_CODEX_MODEL?.trim();
  const reasoningEffort = env.OPENSCOUT_SCOUTBOT_CODEX_REASONING_EFFORT?.trim()
    || SCOUTBOT_REASONING_EFFORT;
  if (model) args.push("--model", model);
  if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
  return normalizeCodexAppServerLaunchArgs(args);
}

function sanitizeSupportPathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "default";
}


export async function createScoutbotWebServices(
  options: ScoutbotServicesOptions,
): Promise<ScoutbotWebServices> {
  const { currentDirectory, loadOperatorAttention, loadBuildInfo } = options;
  const scoutbotReminders = createScoutbotReminderStore();
  const scoutbotCredentials = createScoutbotCredentialStore();
  const resolveOpenAIApiKey = async (): Promise<string | undefined> => {
    const environmentKey = process.env.OPENAI_API_KEY?.trim();
    if (environmentKey) return environmentKey;
    const config = await loadScoutRelayConfig().catch(() => null);
    const configuredKey = config?.openaiApiKey?.trim();
    return configuredKey || scoutbotCredentials.getOpenAIKey()?.trim() || undefined;
  };
  const tailRuntime: WebTailRuntime = {
    getTailDiscovery,
    refreshTailDiscovery,
    readRecentTranscriptEvents,
    snapshotRecentEvents,
    ...options.tailRuntime,
  };
  const scoutbotAssistant = createScoutbotAssistantService({
    currentDirectory,
    loadContext: async (route) => ({
      ...(await buildScoutbotAssistantControlState(currentDirectory, tailRuntime, loadOperatorAttention, loadBuildInfo, route)),
      reminders: scoutbotReminders.getState(),
    }),
    resolveApiKey: resolveOpenAIApiKey,
    invokeCodex: options.invokeCodex
      ?? createDefaultScoutbotCodexInvoker(currentDirectory),
  });
  let scoutbotRunner: ScoutbotRunnerHandle | null = null;
  let scoutbotRunnerStart: Promise<ScoutbotRunnerHandle | null> | null = null;
  let scoutbotRunnerStopRequested = false;
  const startRunnerIfNeeded = (): Promise<ScoutbotRunnerHandle | null> => {
    if (!options.scoutbot?.enabled || scoutbotRunnerStopRequested) {
      return Promise.resolve(null);
    }
    if (scoutbotRunner) return Promise.resolve(scoutbotRunner);
    if (scoutbotRunnerStart) return scoutbotRunnerStart;

    // Runner discovery and registration can inspect every saved agent and
    // project. Keep it fully lazy so merely starting the HTTP server never
    // schedules that optional scan on the request-serving event loop.
    scoutbotRunnerStart = startScoutbotRunner({
        brokerBaseUrl: options.scoutbot.brokerBaseUrl,
        currentDirectory,
      })
      .then(async (runner) => {
        if (scoutbotRunnerStopRequested) {
          await runner.stop();
          return null;
        }
        scoutbotRunner = runner;
        return runner;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[scoutbot] runner failed to start: ${message}`);
        return null;
      })
      .finally(() => {
        scoutbotRunnerStart = null;
      });
    return scoutbotRunnerStart;
  };
  let fleetHomeBrief: FleetHomeBrief | null = null;
  let fleetHomeBriefInFlight: Promise<FleetHomeBrief> | null = null;
  const loadFleetHomeBrief = async (): Promise<FleetHomeBrief> => {
    const now = Date.now();
    if (fleetHomeBrief && fleetHomeBrief.expiresAt > now) {
      return fleetHomeBrief;
    }
    if (fleetHomeBriefInFlight) {
      return fleetHomeBriefInFlight;
    }
    let captured: ScoutbotBriefCapture | null = null;
    fleetHomeBriefInFlight = scoutbotAssistant.createBrief({
      route: { view: "inbox" },
      ttlMs: FLEET_HOME_BRIEF_TTL_MS,
      mode: "fleet-home",
      onCaptured: (c) => { captured = c; },
    })
      .then((scoutbotBrief) => {
        if (captured) persistBriefing("fleet-home", scoutbotBrief, captured);
        return buildFleetHomeBrief(scoutbotBrief);
      })
      .then((brief) => {
        fleetHomeBrief = brief;
        return brief;
      })
      .finally(() => {
        fleetHomeBriefInFlight = null;
      });
    return fleetHomeBriefInFlight;
  };
  const stopRunner = async () => {
    scoutbotRunnerStopRequested = true;
    if (scoutbotRunnerStart) await scoutbotRunnerStart;
    if (!scoutbotRunner) return;
    const runner = scoutbotRunner;
    scoutbotRunner = null;
    await runner.stop();
  };
  const waitForRunner = async () => {
    return startRunnerIfNeeded();
  };

  return {
    assistant: scoutbotAssistant,
    reminders: scoutbotReminders,
    credentials: scoutbotCredentials,
    resolveOpenAIApiKey,
    get runner() {
      return scoutbotRunner;
    },
    waitForRunner,
    loadFleetHomeBrief,
    stopRunner,
  };
}

export function mountScoutbotRoutes(
  app: Hono,
  services: ScoutbotWebServices,
  deps: { currentDirectory: string },
): void {
  const { currentDirectory } = deps;
  const { assistant, reminders, credentials, loadFleetHomeBrief } = services;

  app.get("/api/scoutbot/session", (c) => c.json(assistant.getSessionState()));
  app.post("/api/scoutbot/session/reset", (c) => c.json(assistant.resetSession()));
  app.post("/api/scoutbot/session/switch", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }
    try {
      return c.json(assistant.switchSession(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scoutbot switch failed";
      const status = error instanceof ScoutbotAssistantError ? error.status : 500;
      return c.json({ error: message }, status as 400 | 404 | 500);
    }
  });
  app.post("/api/scoutbot/session/archive", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }
    try {
      return c.json(assistant.archiveSession(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scoutbot archive failed";
      const status = error instanceof ScoutbotAssistantError ? error.status : 500;
      return c.json({ error: message }, status as 400 | 404 | 500);
    }
  });
  app.get("/api/scoutbot/reminders", (c) => c.json(reminders.getState()));
  app.post("/api/scoutbot/reminders", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown;
      body?: unknown;
      source?: unknown;
      dueAt?: unknown;
      delayMs?: unknown;
      delayMinutes?: unknown;
      context?: unknown;
    };

    try {
      return c.json(reminders.create(body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scoutbot reminder failed";
      const status = error instanceof ScoutbotReminderError ? error.status : 500;
      return c.json({ error: message }, status as 400 | 404 | 500);
    }
  });
  app.post("/api/scoutbot/reminders/:id/dismiss", (c) => {
    try {
      return c.json(reminders.dismiss(c.req.param("id")));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scoutbot reminder failed";
      const status = error instanceof ScoutbotReminderError ? error.status : 500;
      return c.json({ error: message }, status as 400 | 404 | 500);
    }
  });
  app.get("/api/scoutbot/config", (c) => c.json(assistant.getConfig()));
  app.post("/api/scoutbot/config", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: string | null;
      systemPrompt?: string | null;
    };
    return c.json({
      config: assistant.updateConfig({
        model: body.model,
        systemPrompt: body.systemPrompt,
      }),
    });
  });
  app.get("/api/scoutbot/credentials", async (c) => {
    return c.json(await resolveScoutbotCredentialState(credentials));
  });
  app.post("/api/scoutbot/credentials/openai", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: unknown };
    try {
      if (typeof body.apiKey !== "string") {
        return c.json({ error: "apiKey is required" }, 400);
      }
      credentials.setOpenAIKey(body.apiKey);
      return c.json(await resolveScoutbotCredentialState(credentials));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save OpenAI API key.";
      return c.json({ error: message }, 400);
    }
  });
  app.delete("/api/scoutbot/credentials/openai", async (c) => {
    credentials.deleteOpenAIKey();
    return c.json(await resolveScoutbotCredentialState(credentials));
  });
  app.post("/api/scoutbot/chat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      body?: string;
      route?: unknown;
      uiContext?: unknown;
      voiceTurn?: unknown;
    };
    const voiceTurn = normalizeVoiceTurn(body.voiceTurn);
    if (body.voiceTurn !== undefined && !voiceTurn) {
      return c.json({ error: "voiceTurn requires non-negative integer turn and gen" }, 400);
    }

    try {
      const reply = await assistant.respond({
        body: body.body ?? "",
        route: body.route,
        uiContext: body.uiContext,
        signal: c.req.raw.signal,
      });
      return c.json({ ...reply, ...(voiceTurn ? { voiceTurn } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scoutbot assistant failed";
      const status = error instanceof ScoutbotAssistantError ? error.status : 500;
      return c.json({ error: message }, status as 400 | 408 | 500 | 502 | 503 | 504);
    }
  });
  app.post("/api/scoutbot/actions/ask", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      targetLabel?: string;
      targetAgentId?: string;
      body?: string;
      channel?: string;
    };
    const targetLabel = body.targetLabel?.trim() || body.targetAgentId?.trim() || "";
    const targetAgentId = body.targetAgentId?.trim();
    const requestBody = body.body?.trim() ?? "";
    const channel = body.channel?.trim();
    if (!targetLabel) {
      return c.json({ error: "targetLabel or targetAgentId is required" }, 400);
    }
    if (!requestBody) {
      return c.json({ error: "body is required" }, 400);
    }

    const result = await askScoutQuestion({
      senderId: resolveOperatorName().trim() || "operator",
      targetLabel,
      ...(targetAgentId ? { targetAgentId } : {}),
      body: requestBody,
      ...(channel ? { channel } : {}),
      currentDirectory,
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }
    if (result.unresolvedTarget) {
      return c.json(
        {
          error: `could not route ask to ${result.unresolvedTarget}`,
          targetDiagnostic: result.targetDiagnostic ?? null,
        },
        409,
      );
    }

    return c.json({
      ok: true,
      targetLabel,
      conversationId: result.conversationId ?? null,
      messageId: result.messageId ?? null,
      flightId: result.flight?.id ?? null,
      targetAgentId: result.flight?.targetAgentId ?? null,
    });
  });
  app.post("/api/scoutbot/brief", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      route?: unknown;
      ttlMs?: number | null;
    };

    try {
      let captured: ScoutbotBriefCapture | null = null;
      const brief = await assistant.createBrief({
        route: body.route,
        ttlMs: body.ttlMs,
        onCaptured: (cap) => { captured = cap; },
      });
      if (captured) persistBriefing("tour", brief, captured);
      emitBroadcast({
        tier: "info",
        text: `Brief · ${brief.title}`,
        ruleId: "scoutbot.brief",
        key: "scoutbot.brief",
        agent: "scoutbot",
      });
      return c.json(brief);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scoutbot brief failed";
      const status = error instanceof ScoutbotAssistantError ? error.status : 500;
      return c.json({ error: message }, status as 400 | 500 | 502 | 503 | 504);
    }
  });
  app.get("/api/briefings", (c) => {
    const limitParam = c.req.query("limit");
    const parsed = limitParam ? Number.parseInt(limitParam, 10) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
    return c.json({ briefings: listBriefings({ limit }) });
  });
  app.get("/api/briefings/:id", (c) => {
    const briefing = getBriefing(c.req.param("id"));
    if (!briefing) return c.json({ error: "not found" }, 404);
    return c.json(briefing);
  });
  app.delete("/api/briefings/:id", (c) => {
    return c.json({ deleted: deleteBriefing(c.req.param("id")) });
  });

  app.get("/api/fleet/brief", async (c) => {
    try {
      return c.json(await loadFleetHomeBrief());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fleet brief failed";
      const status = error instanceof ScoutbotAssistantError ? error.status : 500;
      return c.json({ error: message }, status as 400 | 500 | 502 | 503 | 504);
    }
  });
}
