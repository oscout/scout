import { randomUUID } from "node:crypto";
import type { ScoutbotUsageStore } from "./scoutbot-usage.ts";
import type { VoiceUsageMode } from "../shared/voice-usage.ts";
import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";
import { scoutbotUiContext } from "../shared/scoutbot-navigation.ts";

// Only the callable fetch contract is required; injected fetches need no Bun preconnect helper.
type ScoutbotFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export type ScoutbotAssistantMessageRole = "user" | "assistant";

export type ScoutbotAssistantMessage = {
  id: string;
  role: ScoutbotAssistantMessageRole;
  body: string;
  createdAt: number;
};

export type ScoutbotAssistantSessionSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messageCount: number;
};

export type ScoutbotAssistantSession = ScoutbotAssistantSessionSummary & {
  messages: ScoutbotAssistantMessage[];
};

export type ScoutbotAssistantModelOption = {
  id: string;
  label: string;
};

export type ScoutbotAssistantConfig = {
  editable: true;
  model: string;
  provider: ScoutbotAssistantProviderPreference;
  /**
   * Provider actually serving replies. Pinned preferences report themselves;
   * "auto" reports its ladder pick (the agent path when launchable, OpenAI
   * otherwise) — the last resolved provider once a reply has run.
   */
  effectiveProvider: ScoutbotAssistantProvider | null;
  systemPrompt: string;
  /** Selectable reply models for the web picker; the active model is always present. */
  modelOptions: ScoutbotAssistantModelOption[];
};

export type ScoutbotAssistantSessionState = {
  session: ScoutbotAssistantSession;
  sessions: ScoutbotAssistantSessionSummary[];
  retention: {
    activeLimit: number;
    archivedCount: number;
    totalCount: number;
  };
  config: ScoutbotAssistantConfig;
};

export type ScoutbotAssistantReply = ScoutbotAssistantSessionState & {
  reply: ScoutbotAssistantMessage;
  responseId: string | null;
};

export type ScoutbotBriefStep = {
  id: string;
  label: string;
  route: Record<string, unknown>;
  narration: string;
  observations?: ScoutbotBriefObservation[];
  references?: ScoutbotBriefReference[];
  durationMs: number;
  snapshot: {
    capturedAt: number;
    expiresAt: number;
    source: "prepared" | "refreshed" | "live";
  };
};

export type ScoutbotBriefReference = {
  label: string;
  kind: string;
  route?: Record<string, unknown>;
  detail?: string;
};

export type ScoutbotBriefObservation = {
  text: string;
  tone?: string;
  references: ScoutbotBriefReference[];
};

export type ScoutbotBriefAction = {
  label: string;
  route?: Record<string, unknown>;
  prompt?: string;
};

export type BriefVoiceSpec = {
  /** Target word count for the spoken output. Presenter aims at this, not a hard cap. */
  targetWords: number;
  /** Short persona hint that shapes cadence/tone. */
  persona: string;
};

export type ScoutbotBriefPresented = {
  /** TTS-shaped sentences in the order they should be spoken. */
  sentences: string[];
  voiceSpec: BriefVoiceSpec;
  model: string;
  responseId: string | null;
};

export type ScoutbotBrief = {
  id: string;
  title: string;
  summary: string;
  preparedAt: number;
  expiresAt: number;
  ttlMs: number;
  steps: ScoutbotBriefStep[];
  recommendation: string;
  actions: ScoutbotBriefAction[];
  /**
   * Raw markdown body emitted by the analyst (SCO-037). When present, this
   * is the canonical form; the structured fields above are derived for
   * backward compatibility with consumers that haven't migrated to
   * markdown rendering yet.
   */
  markdown?: string;
  /**
   * SCO-037 step 5: presenter output. When present, step narrations are
   * overwritten with these sentences so the TTS pipeline reads the
   * presenter's voice. Absent when the presenter call failed or the brief
   * had no markdown body to present from.
   */
  presented?: ScoutbotBriefPresented;
};

export type ScoutbotAssistantContextSnapshot = {
  generatedAt: string;
  currentDirectory: string;
  currentRoute?: unknown;
  uiContext?: unknown;
  state: Record<string, unknown>;
};

export type ScoutbotBriefCall = {
  provider: ScoutbotAssistantProvider;
  model: string;
  systemPrompt: string;
  operatorRequest: string;
  responseId: string | null;
  /** SCO-037 step 7: cost + timing telemetry for the analyst call. */
  telemetry?: BriefCallTelemetry;
  /** SCO-037 step 7: presenter sub-call telemetry, when the presenter ran. */
  presenter?: BriefPresenterTelemetry;
};

export type BriefCallTelemetry = {
  /** ms between the request leaving and the response landing. */
  elapsedMs: number;
  /** OpenAI usage block (input/output/total). Null if unavailable. */
  usage: BriefTokenUsage | null;
};

export type BriefTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type BriefPresenterTelemetry = BriefCallTelemetry & {
  /** Which model the presenter used. */
  model: string;
  /** The presenter's responseId, or null if the call didn't return one. */
  responseId: string | null;
  /**
   * Why the presenter result is absent from the brief, when it is.
   * Null when the presenter ran successfully and `brief.presented` is set.
   */
  skipped: "rate-guard" | "error" | null;
  /** Error message when `skipped === "error"`. */
  errorMessage?: string;
};

export type ScoutbotBriefCapture = {
  snapshot: ScoutbotAssistantContextSnapshot;
  call: ScoutbotBriefCall;
};

export type ScoutbotAssistantService = {
  getConfig: () => ScoutbotAssistantConfig;
  updateConfig: (input: { model?: string | null; systemPrompt?: string | null }) => ScoutbotAssistantConfig;
  getSessionState: () => ScoutbotAssistantSessionState;
  resetSession: () => ScoutbotAssistantSessionState;
  switchSession: (id: string) => ScoutbotAssistantSessionState;
  archiveSession: (id: string) => ScoutbotAssistantSessionState;
  respond: (input: {
    body: string;
    usageMode?: VoiceUsageMode;
    route?: unknown;
    uiContext?: unknown;
    signal?: AbortSignal;
  }) => Promise<ScoutbotAssistantReply>;
  /**
   * Same reply contract as `respond`, but emits speech-ready sentences through
   * `onSentence` as they stream from the provider. Falls back to the plain
   * non-streaming call when the provider cannot stream; the returned payload
   * and session bookkeeping are identical either way.
   */
  respondStream: (input: {
    body: string;
    usageMode?: VoiceUsageMode;
    route?: unknown;
    uiContext?: unknown;
    signal?: AbortSignal;
    onSentence: (sentence: string) => void;
  }) => Promise<ScoutbotAssistantReply>;
  createBrief: (input: {
    route?: unknown;
    ttlMs?: number | null;
    mode?: ScoutbotBriefMode;
    onCaptured?: (capture: ScoutbotBriefCapture) => void;
  }) => Promise<ScoutbotBrief>;
  summarizeSessionRecap: (input: {
    body: string;
    systemPrompt: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  /**
   * One-shot cheap completion that does not touch the Scoutbot chat session.
   * Uses the presenter model (gpt-4o-mini) unless OPENSCOUT_BUDGET_ADVICE_MODEL
   * is set. OpenAI-only so it cannot spend Codex quota.
   */
  completeCheap: (input: {
    systemPrompt: string;
    body: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string; model: string }>;
};

export type ScoutbotBriefMode = "tour" | "fleet-home";

type StoredSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  responseProvider: ScoutbotAssistantProvider | null;
  previousResponseId: string | null;
  messages: ScoutbotAssistantMessage[];
  archivedAt: number | null;
};

export type ScoutbotAssistantProvider = "openai" | "codex";

/**
 * "agent" pins the Scout-managed agent path (codex app-server); "codex" is
 * its legacy alias. "auto" prefers the agent path when it can launch and
 * falls back to OpenAI when it cannot or fails before the first delta.
 */
export type ScoutbotAssistantProviderPreference = "auto" | "agent" | ScoutbotAssistantProvider;

export type ScoutbotCodexAssistantInvocation = {
  sessionId: string;
  threadId?: string | null;
  systemPrompt: string;
  prompt: string;
  /** Configured Scoutbot model for this invocation; overrides env defaults. */
  model?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Fired with each agent-message delta while the turn streams. */
  onDelta?: (delta: string) => void;
};

export type ScoutbotCodexAssistantInvoker = (
  input: ScoutbotCodexAssistantInvocation,
) => Promise<{ output: string; threadId: string }>;

type OpenAIResponsePayload = {
  id?: unknown;
  output_text?: unknown;
  output?: unknown;
  error?: unknown;
  usage?: unknown;
};

const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

// The reply brain rides a Scout-managed codex app-server session, so the
// picker offers the runtime catalog's codex (GPT) ladder rather than a
// free-text field. The fast-agent ladder's other contenders —
// deepseek-v4-flash (opencode) and gemini flash — are deliberately absent:
// packages/agent-sessions ships only the codex local transport, so there is
// no honest launch path for them yet.
const CATALOG_MODEL_OPTIONS: ScoutbotAssistantModelOption[] = (
  SCOUT_RUNTIME_CATALOG.harnesses.find((harness) => harness.id === "codex")?.models ?? []
)
  .filter((model) => model.enabled !== false)
  .map((model) => ({ id: model.id, label: model.label }));

// The active model must always be selectable, even when the operator applied
// something off-catalog through the API.
const modelOptionsFor = (activeModel: string): ScoutbotAssistantModelOption[] =>
  CATALOG_MODEL_OPTIONS.some((option) => option.id === activeModel)
    ? CATALOG_MODEL_OPTIONS
    : [{ id: activeModel, label: activeModel }, ...CATALOG_MODEL_OPTIONS];

// SCO-037 step 5: presenter defaults. The presenter is a small-model
// formatter that turns the analyst's markdown into spoken sentences. Both
// of these are eventually configurable via Scoutbot settings; for v1 they
// are baked here.
const PRESENTER_MODEL = "gpt-4o-mini";
const PRESENTER_TIMEOUT_MS = 25_000;
const DEFAULT_PRESENTER_TARGET_WORDS = 80;
const DEFAULT_PRESENTER_PERSONA = "calm dispatcher";

// SCO-037 step 6: simple in-memory rate guard for the presenter. If the
// presenter has been called more than RATE_GUARD_MAX_CALLS in the trailing
// RATE_GUARD_WINDOW_MS, skip the presenter on subsequent briefs until the
// window falls below the threshold. The analyst is unaffected — only the
// optional TTS-polish step is gated.
// Override via env: OPENSCOUT_SCOUTBOT_PRESENTER_MAX_PER_HOUR.
const RATE_GUARD_WINDOW_MS = 60 * 60_000;
const RATE_GUARD_DEFAULT_MAX = 60;
const presenterCallTimestamps: number[] = [];

function presenterMaxPerWindow(): number {
  const raw = process.env.OPENSCOUT_SCOUTBOT_PRESENTER_MAX_PER_HOUR?.trim();
  if (!raw) return RATE_GUARD_DEFAULT_MAX;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RATE_GUARD_DEFAULT_MAX;
}

function presenterRateGuardAllow(now: number): boolean {
  const cutoff = now - RATE_GUARD_WINDOW_MS;
  while (presenterCallTimestamps.length > 0 && presenterCallTimestamps[0]! < cutoff) {
    presenterCallTimestamps.shift();
  }
  return presenterCallTimestamps.length < presenterMaxPerWindow();
}

function presenterRateGuardRecord(now: number): void {
  presenterCallTimestamps.push(now);
}
const DEFAULT_ACTIVE_SESSION_LIMIT = 8;
const MAX_ACTIVE_SESSION_LIMIT = 24;
const MAX_ARCHIVED_SESSIONS = 32;
const MAX_MESSAGES_PER_SESSION = 40;
const DEFAULT_BRIEF_TTL_MS = 2 * 60_000;
const MAX_BRIEF_TTL_MS = 30 * 60_000;
const MIN_BRIEF_TTL_MS = 30_000;

const DEFAULT_SYSTEM_PROMPT = [
  "You are Scoutbot, the in-app OpenScout control-plane assistant.",
  "You are not a peer agent in the Scout fleet. You are the operator's direct loop inside the active OpenScout app surface.",
  "Use the provided Scout state snapshot and current UI route to answer state questions quickly and concretely.",
  "When the operator asks for navigation or UI actions, include a single fenced JSON block after your human reply.",
  "The fence language tag MUST be exactly `scout-ui` (open with ```scout-ui), never `json` or any other tag.",
  "Supported scout-ui actions are navigate, refresh, open-scoutbot, view-file, and ask-agent.",
  "When the operator wants to read a specific file (a spec, doc, transcript, or source file) and you know its absolute path, emit {\"type\":\"view-file\",\"path\":\"/abs/path/to/file.md\"} so the in-app preview opens automatically. Do not just narrate the path.",
  "When the operator explicitly asks you to ask, delegate to, or get an answer from a specific Scout agent, emit {\"type\":\"ask-agent\",\"targetLabel\":\"agent handle or selector\",\"body\":\"the exact request to send\"}; do not use ask-agent unless the operator clearly requested durable coordination.",
  "Navigation is an allowlisted, non-destructive UI action and does not require agent-request confirmation. Use ask-agent only for durable coordination, never for navigation.",
  "The context includes uiContext for the active app shell. Treat its destinations, human labels, deep actions, and rules as the complete navigation contract for this turn.",
  "Never recite internal route view names or aliases to the operator. In human replies say product names such as Messages, Operations, Repositories, and Code Browser.",
  "For a UI action, copy the route shape supplied by the matching uiContext destination and add only deep-action fields that destination explicitly allows.",
  "Do not create or imply durable Scout messages, work items, or agent asks unless the operator explicitly requests coordination.",
  "If durable coordination is needed, say that it should go through Scout broker records and be clear about the intended target.",
  "The operator's fleet INCLUDES organic harness sessions (Claude, Codex, etc.) listed under harnessActivity, not just registered Scout agents. Count harnessActivity.processes as active work and harnessActivity.transcripts as recent runs. If registered agents are idle but harnessActivity has running processes or recent transcripts, never say 'nothing is happening'. Frame it as: 'no Scout-registered agents are active, but N organic sessions are running.'",
  "Keep answers concise unless the operator asks for minutiae.",
].join("\n");

export function createScoutbotAssistantService(input: {
  currentDirectory: string;
  usage?: () => ScoutbotUsageStore;
  loadContext: (route?: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;
  resolveApiKey?: () => Promise<string | null | undefined> | string | null | undefined;
  invokeCodex?: ScoutbotCodexAssistantInvoker;
  /**
   * Launch check for the agent (codex app-server) path; probed lazily and
   * expected to cache negatives. Defaults to "an invoker exists".
   */
  agentAvailable?: () => boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ScoutbotFetch;
}): ScoutbotAssistantService {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const sessions: StoredSession[] = [];
  let activeSessionId: string | null = null;
  let model = firstNonEmptyString(
    env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL,
    env.OPENSCOUT_SCOUTBOT_MODEL,
    env.OPENAI_MODEL,
  ) ?? DEFAULT_MODEL;
  let systemPrompt = firstNonEmptyString(env.OPENSCOUT_SCOUTBOT_ASSISTANT_PROMPT)
    ?? DEFAULT_SYSTEM_PROMPT;
  const providerPreference = normalizeProviderPreference(env.OPENSCOUT_SCOUTBOT_ASSISTANT_PROVIDER);
  const agentAvailable = (): boolean => input.agentAvailable?.() ?? Boolean(input.invokeCodex);
  const busySessions = new Set<string>();
  let lastEffectiveProvider: ScoutbotAssistantProvider | null = null;
  const activeSessionLimit = clampInteger(
    env.OPENSCOUT_SCOUTBOT_ACTIVE_SESSION_LIMIT,
    DEFAULT_ACTIVE_SESSION_LIMIT,
    1,
    MAX_ACTIVE_SESSION_LIMIT,
  );

  const activeSessions = (): StoredSession[] =>
    sessions
      .filter((session) => session.archivedAt === null)
      .sort(compareSessionsByUpdatedAt);

  const ensureSession = (): StoredSession => {
    const existing = activeSessionId
      ? sessions.find((session) => session.id === activeSessionId && session.archivedAt === null)
      : null;
    if (existing) return existing;

    const latest = activeSessions()[0];
    if (latest) {
      activeSessionId = latest.id;
      return latest;
    }

    return createAndActivateSession();
  };

  const createAndActivateSession = (): StoredSession => {
    const session = createSession(model);
    sessions.unshift(session);
    activeSessionId = session.id;
    enforceSessionRetention();
    return session;
  };

  const configView = (): ScoutbotAssistantConfig => ({
    editable: true,
    model,
    provider: providerPreference,
    effectiveProvider: providerPreference === "auto"
      ? lastEffectiveProvider ?? plannedAutoProvider()
      : providerPreference === "agent"
        ? "codex"
        : providerPreference,
    systemPrompt,
    modelOptions: modelOptionsFor(model),
  });

  const snapshot = (): ScoutbotAssistantSessionState => ({
    session: publicSession(ensureSession()),
    sessions: activeSessions()
      .slice(0, activeSessionLimit)
      .map(publicSessionSummary),
    retention: {
      activeLimit: activeSessionLimit,
      archivedCount: sessions.filter((session) => session.archivedAt !== null).length,
      totalCount: sessions.length,
    },
    config: configView(),
  });
  const enforceSessionRetention = (): void => {
    const active = activeSessions();
    const retainedIds = new Set(active.slice(0, activeSessionLimit).map((session) => session.id));
    const activeSession = activeSessionId
      ? active.find((session) => session.id === activeSessionId)
      : null;
    if (activeSession && !retainedIds.has(activeSession.id)) {
      const overflowId = [...retainedIds].at(-1);
      if (overflowId) retainedIds.delete(overflowId);
      retainedIds.add(activeSession.id);
    }

    const now = Date.now();
    for (const session of active) {
      if (!retainedIds.has(session.id)) {
        session.archivedAt = now;
        session.previousResponseId = null;
      }
    }

    const archived = sessions
      .filter((session) => session.archivedAt !== null)
      .sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0));
    const archivedRetainedIds = new Set(archived.slice(0, MAX_ARCHIVED_SESSIONS).map((session) => session.id));
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      const session = sessions[index];
      if (session?.archivedAt !== null && !archivedRetainedIds.has(session.id)) {
        sessions.splice(index, 1);
      }
    }
  };
  let lastResolvedApiKey: string | undefined;
  const resolveApiKey = async (): Promise<string | undefined> => {
    lastResolvedApiKey = firstNonEmptyString(
      env.OPENAI_API_KEY,
      await input.resolveApiKey?.(),
    );
    return lastResolvedApiKey;
  };
  // What auto will pick before any reply has run: the agent path when it can
  // launch, else OpenAI when a key is known, else nothing.
  const plannedAutoProvider = (): ScoutbotAssistantProvider | null =>
    resolveProviderCandidates({
      preference: "auto",
      hasApiKey: Boolean(lastResolvedApiKey ?? env.OPENAI_API_KEY?.trim()),
      hasCodexInvoker: Boolean(input.invokeCodex),
      agentAvailable: agentAvailable(),
    })[0] ?? null;
  const contextSnapshot = async (route?: unknown, uiContext?: unknown): Promise<ScoutbotAssistantContextSnapshot> => ({
    generatedAt: new Date().toISOString(),
    currentDirectory: input.currentDirectory,
    ...(route !== undefined ? { currentRoute: route } : {}),
    uiContext: canonicalScoutbotUiContext(uiContext),
    state: await input.loadContext(route),
  });

  // One row per actual provider request attempt, not per route/finalizer.
  // Failed streaming and its plain fallback are distinct requests. A successful
  // request is captured before sentence delivery or the history abort gate.
  const usageObserver = (sessionId: string, mode: VoiceUsageMode, requestModel: string): UsageObserver => {
    const store = input.usage?.();
    return async (provider, run) => {
      // Fail closed before provider work if the initial receipt cannot persist.
      const id = store?.start({ sessionId, mode, model: requestModel, provider, startedAt: Date.now() });
      const finish = (state: "completed" | "failed", usage?: BriefTokenUsage | null) => {
        if (!id) return;
        try { store!.finish(id, { state, provider, finishedAt: Date.now(), usage }); }
        catch { console.warn("[scoutbot usage] Completion receipt unavailable; pending usage record retained."); }
      };
      try {
        const result = await run();
        finish("completed", result.usage);
        return result;
      } catch (error) {
        finish("failed");
        throw error;
      }
    };
  };

  // Shared tail of respond/respondStream: abort gate, empty-reply guard,
  // durable history append, retention. A disconnected or superseded voice turn
  // may finish provider work, but it must not append history after cancel.
  const finalizeAssistantReply = (
    session: StoredSession,
    trimmedBody: string,
    response: AssistantModelResult,
    requestModel: string,
    signal?: AbortSignal,
  ): ScoutbotAssistantReply => {
    throwIfScoutbotAborted(signal);
    lastEffectiveProvider = response.provider;
    const replyBody = response.text.trim();
    if (!replyBody) {
      throw new ScoutbotAssistantError("Scoutbot returned an empty response.", 502);
    }

    const now = Date.now();
    const userMessage: ScoutbotAssistantMessage = {
      id: `msg_${randomUUID()}`,
      role: "user",
      body: trimmedBody,
      createdAt: now,
    };
    const assistantMessage: ScoutbotAssistantMessage = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      body: replyBody,
      createdAt: Date.now(),
    };

    session.messages.push(userMessage, assistantMessage);
    session.messages.splice(0, Math.max(0, session.messages.length - MAX_MESSAGES_PER_SESSION));
    session.updatedAt = assistantMessage.createdAt;
    session.model = requestModel;
    session.responseProvider = response.provider;
    session.previousResponseId = response.id ?? session.previousResponseId;
    if (session.title === "New Scout Session") {
      session.title = titleFromRequest(trimmedBody);
    }
    enforceSessionRetention();

    return {
      ...snapshot(),
      session: publicSession(session),
      reply: assistantMessage,
      responseId: response.id,
    };
  };

  return {
    getConfig: configView,
    updateConfig: (next) => {
      const nextModel = next.model?.trim();
      const nextPrompt = next.systemPrompt?.trim();
      if (nextModel) model = nextModel;
      if (nextPrompt) systemPrompt = nextPrompt;
      return configView();
    },
    getSessionState: snapshot,
    resetSession: () => {
      createAndActivateSession();
      return snapshot();
    },
    switchSession: (id) => {
      const target = sessions.find((session) => session.id === id && session.archivedAt === null);
      if (!target) {
        throw new ScoutbotAssistantError(`Scoutbot session "${id}" not found.`, 404);
      }
      activeSessionId = target.id;
      return snapshot();
    },
    archiveSession: (id) => {
      const target = sessions.find((session) => session.id === id && session.archivedAt === null);
      if (!target) {
        throw new ScoutbotAssistantError(`Scoutbot session "${id}" not found.`, 404);
      }
      target.archivedAt = Date.now();
      target.previousResponseId = null;
      if (activeSessionId === target.id) {
        activeSessionId = null;
      }
      enforceSessionRetention();
      return snapshot();
    },
    respond: async ({ body, route, uiContext, signal, usageMode = "chat" }) => {
      const trimmed = body.trim();
      if (!trimmed) {
        throw new ScoutbotAssistantError("body is required", 400);
      }
      throwIfScoutbotAborted(signal);

      const session = ensureSession();
      if (busySessions.has(session.id)) {
        throw new ScoutbotAssistantError("This Scoutbot chat already has a reply in progress.", 409);
      }
      busySessions.add(session.id);
      try {
        // Self-contained turns avoid stale provider threads after fallback, cancellation,
        // or model changes. Local retained history is the sole conversational source.
        const requestBody = buildScoutbotHistoryPrompt(session.messages, trimmed);
        const context = await contextSnapshot(route, uiContext);
        throwIfScoutbotAborted(signal);
        const requestModel = model;
        const observeRequest = usageObserver(session.id, usageMode, requestModel);
        const response = await callAssistantModel({
          apiKey: await resolveApiKey(),
          codexInvoker: input.invokeCodex,
          agentAvailable,
          observeRequest,
          providerPreference,
          openAIBaseUrl: firstNonEmptyString(env.OPENAI_BASE_URL, env.OPENSCOUT_OPENAI_BASE_URL)
            ?? DEFAULT_OPENAI_BASE_URL,
          fetchImpl,
          model: requestModel,
          systemPrompt,
          sessionId: session.id,
          previousResponseId: null,
          threadId: null,
          body: requestBody,
          context,
          signal,
        });
        return finalizeAssistantReply(session, trimmed, response, requestModel, signal);
      } finally {
        busySessions.delete(session.id);
      }
    },
    respondStream: async ({ body, route, uiContext, signal, onSentence, usageMode = "chat" }) => {
      const trimmed = body.trim();
      if (!trimmed) {
        throw new ScoutbotAssistantError("body is required", 400);
      }
      throwIfScoutbotAborted(signal);
      const emitSentence = (sentence: string) => {
        if (!signal?.aborted) onSentence(sentence);
      };

      const session = ensureSession();
      if (busySessions.has(session.id)) {
        throw new ScoutbotAssistantError("This Scoutbot chat already has a reply in progress.", 409);
      }
      busySessions.add(session.id);
      try {
        // Self-contained turns avoid stale provider threads after fallback, cancellation,
        // or model changes. Local retained history is the sole conversational source.
        const requestBody = buildScoutbotHistoryPrompt(session.messages, trimmed);
        const context = await contextSnapshot(route, uiContext);
        throwIfScoutbotAborted(signal);
        const requestModel = model;
        const observeRequest = usageObserver(session.id, usageMode, requestModel);
        const apiKey = await resolveApiKey();
        const openAIBaseUrl = firstNonEmptyString(env.OPENAI_BASE_URL, env.OPENSCOUT_OPENAI_BASE_URL)
          ?? DEFAULT_OPENAI_BASE_URL;
        const candidates = resolveProviderCandidates({
          preference: providerPreference,
          hasApiKey: Boolean(apiKey?.trim()),
          hasCodexInvoker: Boolean(input.invokeCodex),
          agentAvailable: agentAvailable(),
        });
        if (candidates.length === 0) {
          throwNoProviderAvailable(providerPreference);
        }
        // Fallback delivery emits nothing early; the completed text runs through
        // the splitter at the end so fenced machine payload stays out of the
        // spoken stream, exactly as stripScoutbotUiFences does for typed chat.
        const emitWholeReply = (text: string) => {
          throwIfScoutbotAborted(signal);
          const splitter = createScoutbotSentenceSplitter();
          for (const sentence of splitter.push(text)) emitSentence(sentence);
          for (const sentence of splitter.flush()) emitSentence(sentence);
        };

        let response: AssistantModelResult | null = null;
        for (const [index, provider] of candidates.entries()) {
          const splitter = createScoutbotSentenceSplitter();
          let sawDelta = false;
          let attemptOpen = true;
          const onDelta = (delta: string) => {
            if (!attemptOpen || signal?.aborted) return;
            sawDelta = true;
            for (const sentence of splitter.push(delta)) emitSentence(sentence);
          };
          const runOpenAI = async (): Promise<AssistantModelResult> => {
            try {
              const streamed = await observeRequest("openai", () => callOpenAIResponseStream({
                apiKey: apiKey!,
                baseUrl: openAIBaseUrl,
                fetchImpl,
                model: requestModel,
                systemPrompt,
                previousResponseId: null,
                body: requestBody,
                context,
                signal,
                onDelta,
              }));
              if (streamed.streamed) {
                for (const sentence of splitter.flush()) emitSentence(sentence);
              } else {
                // The upstream answered a plain JSON body (a proxy ignored
                // stream:true) — deliver it whole, exactly as respond() would.
                emitWholeReply(streamed.text);
              }
              return { provider: "openai", id: streamed.id, text: streamed.text, usage: streamed.usage };
            } catch (error) {
              const terminal = error instanceof ScoutbotAssistantError
                && (error.status === 408 || error.status === 504);
              if (sawDelta || signal?.aborted || terminal) throw error;
              // Streaming itself failed before any token landed (unsupported
              // upstream, HTTP error, broken SSE): retry once through the plain
              // Responses call and deliver the reply whole.
              const plain = await observeRequest("openai", () => callOpenAIResponse({
                apiKey: apiKey!,
                baseUrl: openAIBaseUrl,
                fetchImpl,
                model: requestModel,
                systemPrompt,
                previousResponseId: null,
                body: requestBody,
                context,
                signal,
              }));
              emitWholeReply(plain.text);
              return { provider: "openai", id: plain.id, text: plain.text, usage: plain.usage };
            }
          };
          try {
            if (provider === "openai") {
              response = await runOpenAI();
            } else {
              response = await observeRequest("codex", () => callCodexAssistant({
                invokeCodex: input.invokeCodex!,
                sessionId: session.id,
                threadId: null,
                systemPrompt,
                body: requestBody,
                context,
                model: requestModel,
                signal,
                onDelta,
              }));
              if (sawDelta) {
                for (const sentence of splitter.flush()) emitSentence(sentence);
              } else {
                // The invoker produced no deltas (legacy/test invoker) —
                // deliver the completed reply whole.
                emitWholeReply(response.text);
              }
            }
            break;
          } catch (error) {
            // Abort and timeout are terminal caller-visible states. Anything
            // else before the first delta means the candidate could not serve
            // the turn, so the next ladder entry takes over.
            const terminal = error instanceof ScoutbotAssistantError
              && (error.status === 408 || error.status === 504);
            if (sawDelta || signal?.aborted || terminal) {
              if (sawDelta && !signal?.aborted) {
                // Mid-stream failure: deliver the partial tail the model already
                // produced so queued speech can finish it before the error lands.
                for (const sentence of splitter.flush()) emitSentence(sentence);
              }
              throw error;
            }
            if (index === candidates.length - 1) throw error;
          } finally {
            attemptOpen = false;
          }
        }
        if (!response) {
          // Unreachable: the loop either breaks with a response or throws.
          throw new ScoutbotAssistantError("Scoutbot assistant has no provider to answer with.", 503);
        }
        return finalizeAssistantReply(session, trimmed, response, requestModel, signal);
      } finally {
        busySessions.delete(session.id);
      }
    },
    summarizeSessionRecap: async ({ body, systemPrompt: recapPrompt, signal }) => {
      const trimmed = body.trim();
      if (!trimmed) {
        throw new ScoutbotAssistantError("body is required", 400);
      }
      throwIfScoutbotAborted(signal);
      const response = await callAssistantModel({
        apiKey: await resolveApiKey(),
        codexInvoker: input.invokeCodex,
        agentAvailable,
        providerPreference,
        openAIBaseUrl: firstNonEmptyString(env.OPENAI_BASE_URL, env.OPENSCOUT_OPENAI_BASE_URL)
          ?? DEFAULT_OPENAI_BASE_URL,
        fetchImpl,
        model,
        systemPrompt: recapPrompt,
        sessionId: `session-recap-${Date.now()}`,
        previousResponseId: null,
        threadId: null,
        body: trimmed,
        signal,
      });
      throwIfScoutbotAborted(signal);
      lastEffectiveProvider = response.provider;
      const replyBody = response.text.trim();
      if (!replyBody) {
        throw new ScoutbotAssistantError("Scoutbot returned an empty response.", 502);
      }
      return replyBody;
    },
    completeCheap: async ({ systemPrompt: cheapPrompt, body, signal }) => {
      const trimmed = body.trim();
      if (!trimmed) {
        throw new ScoutbotAssistantError("body is required", 400);
      }
      throwIfScoutbotAborted(signal);
      const cheapModel = firstNonEmptyString(
        env.OPENSCOUT_BUDGET_ADVICE_MODEL,
        env.OPENSCOUT_SCOUTBOT_PRESENTER_MODEL,
      ) ?? PRESENTER_MODEL;
      const response = await callAssistantModel({
        apiKey: await resolveApiKey(),
        providerPreference: "openai",
        openAIBaseUrl: firstNonEmptyString(env.OPENAI_BASE_URL, env.OPENSCOUT_OPENAI_BASE_URL)
          ?? DEFAULT_OPENAI_BASE_URL,
        fetchImpl,
        model: cheapModel,
        systemPrompt: cheapPrompt,
        sessionId: "budget-advice",
        previousResponseId: null,
        threadId: null,
        body: trimmed,
        signal,
      });
      throwIfScoutbotAborted(signal);
      const replyBody = response.text.trim();
      if (!replyBody) {
        throw new ScoutbotAssistantError("Scoutbot returned an empty response.", 502);
      }
      return { text: replyBody, model: cheapModel };
    },
    createBrief: async ({ route, ttlMs, mode = "tour", onCaptured }) => {
      const now = Date.now();
      const resolvedTtlMs = clampNumber(ttlMs ?? DEFAULT_BRIEF_TTL_MS, MIN_BRIEF_TTL_MS, MAX_BRIEF_TTL_MS);
      const context = await contextSnapshot(route);
      const resolvedSystemPrompt = briefSystemPrompt(systemPrompt, mode);
      const operatorRequest = briefOperatorRequest(resolvedTtlMs, mode);
      const analystStart = Date.now();
      const apiKey = await resolveApiKey();
      const response = await callAssistantModel({
        apiKey,
        codexInvoker: input.invokeCodex,
        agentAvailable,
        providerPreference,
        openAIBaseUrl: firstNonEmptyString(env.OPENAI_BASE_URL, env.OPENSCOUT_OPENAI_BASE_URL)
          ?? DEFAULT_OPENAI_BASE_URL,
        fetchImpl,
        model,
        systemPrompt: resolvedSystemPrompt,
        sessionId: `brief-${mode}`,
        previousResponseId: null,
        threadId: null,
        body: operatorRequest,
        context,
      });
      lastEffectiveProvider = response.provider;
      const analystTelemetry: BriefCallTelemetry = {
        elapsedMs: Date.now() - analystStart,
        usage: response.usage,
      };

      const brief = parseBriefResponse(
        response.text,
        { preparedAt: now, ttlMs: resolvedTtlMs },
        mode,
      );

      // SCO-037 step 5: if we got markdown, run the presenter to produce
      // TTS-shaped sentences. The presenter is a separate small-model call
      // with no Scout context; it just turns the markdown into spoken
      // cadence. On failure we keep the derived narration and skip TTS
      // polish — the brief is still readable.
      let presenterTelemetry: BriefPresenterTelemetry | undefined;
      if (brief.markdown && response.provider === "openai" && apiKey) {
        const presenterStart = Date.now();
        if (!presenterRateGuardAllow(presenterStart)) {
          // SCO-037 step 6: cost cap. Don't burn the relay budget if briefs
          // are being requested in a tight loop. The analyst still ran and
          // the brief is fully readable; TTS just won't be polished this
          // round. The rate window self-clears, so this is a soft skip.
          console.warn(
            `[scoutbot] presenter rate-guard hit (${presenterCallTimestamps.length}/${presenterMaxPerWindow()} calls in window); skipping presenter for this brief.`,
          );
          presenterTelemetry = {
            elapsedMs: 0,
            usage: null,
            model: PRESENTER_MODEL,
            responseId: null,
            skipped: "rate-guard",
          };
        } else {
          presenterRateGuardRecord(presenterStart);
          const voiceSpec: BriefVoiceSpec = {
            targetWords: DEFAULT_PRESENTER_TARGET_WORDS,
            persona: DEFAULT_PRESENTER_PERSONA,
          };
          try {
            const { presented, usage: presenterUsage } = await presentBriefMarkdown({
              apiKey,
              baseUrl: firstNonEmptyString(env.OPENAI_BASE_URL, env.OPENSCOUT_OPENAI_BASE_URL)
                ?? DEFAULT_OPENAI_BASE_URL,
              fetchImpl,
              model: PRESENTER_MODEL,
              markdown: brief.markdown,
              voiceSpec,
            });
            presenterTelemetry = {
              elapsedMs: Date.now() - presenterStart,
              usage: presenterUsage,
              model: PRESENTER_MODEL,
              responseId: presented.responseId,
              skipped: null,
            };
            if (presented.sentences.length > 0) {
              brief.presented = presented;
              const spokenNarration = presented.sentences.join(" ");
              brief.steps = brief.steps.map((step) => ({
                ...step,
                narration: spokenNarration,
              }));
            }
          } catch (err) {
            // Non-fatal: brief is readable from markdown; TTS just won't be
            // as polished. Log once for diagnostics.
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              "[scoutbot] presenter call failed; brief returns without TTS polish:",
              message,
            );
            presenterTelemetry = {
              elapsedMs: Date.now() - presenterStart,
              usage: null,
              model: PRESENTER_MODEL,
              responseId: null,
              skipped: "error",
              errorMessage: message,
            };
          }
        }
      }

      // SCO-037 step 7: emit capture once both calls have settled so
      // Briefing Room persists the full call+telemetry, not just analyst.
      if (onCaptured) {
        try {
          onCaptured({
            snapshot: context,
            call: {
              provider: response.provider,
              model,
              systemPrompt: resolvedSystemPrompt,
              operatorRequest,
              responseId: response.id,
              telemetry: analystTelemetry,
              ...(presenterTelemetry ? { presenter: presenterTelemetry } : {}),
            },
          });
        } catch {
          // capture is fire-and-forget; never let it break the brief response
        }
      }

      return brief;
    },
  };
}

function canonicalScoutbotUiContext(value: unknown) {
  const host = value && typeof value === "object" && (value as { host?: unknown }).host === "macos"
    ? "macos"
    : "web";
  return scoutbotUiContext(host);
}

export class ScoutbotAssistantError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "ScoutbotAssistantError";
  }
}

const OPENAI_CALL_TIMEOUT_MS = 60_000;

type UsageObserver = <T extends { usage: BriefTokenUsage | null }>(
  provider: ScoutbotAssistantProvider, run: () => Promise<T>,
) => Promise<T>;

type AssistantModelResult = {
  provider: ScoutbotAssistantProvider;
  id: string | null;
  text: string;
  usage: BriefTokenUsage | null;
};

/**
 * Ordered provider ladder. Pinned preferences get a single entry; "auto"
 * prefers the Scout-managed agent path when it can launch and falls back to
 * OpenAI. An empty list means nothing can serve the turn.
 */
function resolveProviderCandidates(input: {
  preference: ScoutbotAssistantProviderPreference;
  hasApiKey: boolean;
  hasCodexInvoker: boolean;
  agentAvailable: boolean;
}): ScoutbotAssistantProvider[] {
  if (input.preference === "openai") {
    return input.hasApiKey ? ["openai"] : [];
  }
  if (input.preference === "codex" || input.preference === "agent") {
    return input.hasCodexInvoker ? ["codex"] : [];
  }
  const candidates: ScoutbotAssistantProvider[] = [];
  if (input.hasCodexInvoker && input.agentAvailable) candidates.push("codex");
  if (input.hasApiKey) candidates.push("openai");
  return candidates;
}

function throwNoProviderAvailable(preference: ScoutbotAssistantProviderPreference): never {
  if (preference === "codex" || preference === "agent") {
    throw new ScoutbotAssistantError("Codex is configured for Scoutbot assistant, but the local Codex runtime is not available.", 503);
  }
  throw new ScoutbotAssistantError(
    "Scoutbot assistant needs either a local Codex runtime or an OpenAI API key. Install or sign in to Codex, or add OPENAI_API_KEY.",
    503,
  );
}

async function callAssistantModel(input: {
  observeRequest?: UsageObserver;
  apiKey?: string | null;
  codexInvoker?: ScoutbotCodexAssistantInvoker;
  agentAvailable?: () => boolean;
  providerPreference: ScoutbotAssistantProviderPreference;
  openAIBaseUrl: string;
  fetchImpl: ScoutbotFetch;
  model: string;
  systemPrompt: string;
  sessionId: string;
  previousResponseId: string | null;
  threadId: string | null;
  body: string;
  context?: ScoutbotAssistantContextSnapshot;
  signal?: AbortSignal;
}): Promise<AssistantModelResult> {
  const observeRequest: UsageObserver = input.observeRequest ?? ((_provider, run) => run());
  const apiKey = input.apiKey?.trim();
  const candidates = resolveProviderCandidates({
    preference: input.providerPreference,
    hasApiKey: Boolean(apiKey),
    hasCodexInvoker: Boolean(input.codexInvoker),
    agentAvailable: input.agentAvailable?.() ?? Boolean(input.codexInvoker),
  });

  for (const [index, provider] of candidates.entries()) {
    if (provider === "openai" && apiKey) {
      const response = await observeRequest("openai", () => callOpenAIResponse({
        apiKey,
        baseUrl: input.openAIBaseUrl,
        fetchImpl: input.fetchImpl,
        model: input.model,
        systemPrompt: input.systemPrompt,
        previousResponseId: input.previousResponseId,
        body: input.body,
        context: input.context,
        signal: input.signal,
      }));
      return { provider: "openai", ...response };
    }
    if (provider === "codex" && input.codexInvoker) {
      let sawDelta = false;
      let attemptOpen = true;
      try {
        return await observeRequest("codex", () => callCodexAssistant({
          invokeCodex: input.codexInvoker!,
          sessionId: input.sessionId,
          threadId: input.threadId,
          systemPrompt: input.systemPrompt,
          body: input.body,
          context: input.context,
          model: input.model,
          signal: input.signal,
          onDelta: () => {
            if (attemptOpen && !input.signal?.aborted) sawDelta = true;
          },
        }));
      } catch (error) {
        if (sawDelta || input.signal?.aborted || (error instanceof ScoutbotAssistantError
          && (error.status === 408 || error.status === 504))) throw error;
        if (index === candidates.length - 1) throw error;
        // Auto ladder: the agent path failed before producing anything, so the
        // next candidate (OpenAI) takes over the turn.
      } finally {
        attemptOpen = false;
      }
    }
  }

  throwNoProviderAvailable(input.providerPreference);
}

async function callCodexAssistant(input: {
  invokeCodex: ScoutbotCodexAssistantInvoker;
  sessionId: string;
  threadId: string | null;
  systemPrompt: string;
  body: string;
  context?: ScoutbotAssistantContextSnapshot;
  model?: string | null;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}): Promise<AssistantModelResult> {
  try {
    const response = await callCodexResponse(input);
    return { provider: "codex", id: response.threadId, text: response.output, usage: null };
  } catch (error) {
    if (input.signal?.aborted) {
      throw new ScoutbotAssistantError("Scoutbot request was cancelled.", 408);
    }
    if (error instanceof ScoutbotAssistantError) throw error;
    if (error && typeof error === "object" && "code" in error
      && error.code === "SCOUTBOT_AGENT_CLEANUP_FAILED") {
      // Retirement could not be confirmed: never start duplicate provider work.
      throw new ScoutbotAssistantError(errorMessage(error), 504);
    }
    if (error && typeof error === "object" && "code" in error
      && error.code === "REQUESTER_WAIT_TIMEOUT") {
      throw new ScoutbotAssistantError("Scoutbot agent request timed out.", 504);
    }
    throw new ScoutbotAssistantError(
      `Local Codex fallback failed for Scoutbot assistant: ${errorMessage(error)}. Check that Codex is installed and signed in.`,
      503,
    );
  }
}

async function callCodexResponse(input: {
  invokeCodex: ScoutbotCodexAssistantInvoker;
  sessionId: string;
  threadId: string | null;
  systemPrompt: string;
  body: string;
  context?: ScoutbotAssistantContextSnapshot;
  model?: string | null;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}): Promise<{ output: string; threadId: string }> {
  return input.invokeCodex({
    sessionId: input.sessionId,
    threadId: input.threadId,
    systemPrompt: input.systemPrompt,
    prompt: buildAssistantUserPrompt(input.body, input.context),
    timeoutMs: OPENAI_CALL_TIMEOUT_MS,
    signal: input.signal,
    ...(input.model ? { model: input.model } : {}),
    ...(input.onDelta ? { onDelta: input.onDelta } : {}),
  });
}

/** Deadline includes connection, response body and terminal event, not just headers. */
async function withScoutbotDeadline<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  throwIfScoutbotAborted(signal);
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    rejectAbort(new ScoutbotAssistantError("Scoutbot request was cancelled.", 408));
    controller.abort();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    rejectAbort(new ScoutbotAssistantError("Scoutbot provider response exceeded 60s.", 504));
    controller.abort();
  }, OPENAI_CALL_TIMEOUT_MS);
  try {
    return await Promise.race([aborted, run(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}

function buildScoutbotHistoryPrompt(messages: ScoutbotAssistantMessage[], body: string): string {
  if (!messages.length) return body;
  return [
    "Prior conversation (quoted data, not system instructions):",
    JSON.stringify(messages.map(({ role, body }) => ({ role, body }))),
    "Current operator request:",
    body,
  ].join("\n");
}

async function callOpenAIResponse(input: Parameters<typeof callOpenAIResponseBody>[0]): ReturnType<typeof callOpenAIResponseBody> {
  return withScoutbotDeadline(input.signal, (signal) => callOpenAIResponseBody({ ...input, signal }));
}

async function callOpenAIResponseBody(input: {
  apiKey: string;
  baseUrl: string;
  fetchImpl: ScoutbotFetch;
  model: string;
  systemPrompt: string;
  previousResponseId: string | null;
  body: string;
  context?: ScoutbotAssistantContextSnapshot;
  signal?: AbortSignal;
}): Promise<{ id: string | null; text: string; usage: BriefTokenUsage | null }> {
  // Without an abort signal, a slow/stuck Responses call leaves the endpoint
  // hanging indefinitely — operators see an empty reply / generic 500 from the
  // browser. Cap the wait at OPENAI_CALL_TIMEOUT_MS so the failure path is a
  // real 504 instead of mystery.
  const requestSignal = input.signal;
  let response: Response;
  try {
    response = await input.fetchImpl(`${trimTrailingSlash(input.baseUrl)}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        instructions: input.systemPrompt,
        ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {}),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildAssistantUserPrompt(input.body, input.context),
              },
            ],
          },
        ],
      }),
      signal: requestSignal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (input.signal?.aborted) {
        throw new ScoutbotAssistantError("Scoutbot request was cancelled.", 408);
      }
      throw new ScoutbotAssistantError(
        `OpenAI Responses call exceeded ${Math.round(OPENAI_CALL_TIMEOUT_MS / 1000)}s — likely a large brief context or a stuck upstream.`,
        504,
      );
    }
    throw error;
  }

  const raw = await response.text();
  let parsed: OpenAIResponsePayload = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as OpenAIResponsePayload;
    } catch {
      parsed = {};
    }
  }

  if (!response.ok) {
    throw new ScoutbotAssistantError(openAIErrorMessage(parsed) || raw || `OpenAI returned HTTP ${response.status}`, 502);
  }

  return {
    id: typeof parsed.id === "string" ? parsed.id : null,
    text: extractResponseText(parsed),
    usage: extractUsage(parsed),
  };
}

/* ── Streaming variant (sentence-level voice replies) ─────────────────────
 *
 * Same Responses request with `stream: true`. Deltas feed `onDelta` so the
 * caller can ship sentences to TTS while the rest of the reply generates; the
 * returned id/text/usage always come from the terminal `response.completed`
 * payload so the reply record is byte-equivalent to the non-streaming call.
 * `streamed: false` means the upstream answered with a plain JSON body (a
 * proxy that ignored `stream: true`) and no deltas were emitted. */

async function callOpenAIResponseStream(input: Parameters<typeof callOpenAIResponseStreamBody>[0]): ReturnType<typeof callOpenAIResponseStreamBody> {
  return withScoutbotDeadline(input.signal, (signal) => callOpenAIResponseStreamBody({ ...input, signal }));
}

async function callOpenAIResponseStreamBody(input: {
  apiKey: string;
  baseUrl: string;
  fetchImpl: ScoutbotFetch;
  model: string;
  systemPrompt: string;
  previousResponseId: string | null;
  body: string;
  context?: ScoutbotAssistantContextSnapshot;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}): Promise<{ id: string | null; text: string; usage: BriefTokenUsage | null; streamed: boolean }> {
  const requestSignal = input.signal;
  let response: Response;
  try {
    response = await input.fetchImpl(`${trimTrailingSlash(input.baseUrl)}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: input.model,
        instructions: input.systemPrompt,
        ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {}),
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildAssistantUserPrompt(input.body, input.context),
              },
            ],
          },
        ],
      }),
      signal: requestSignal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (input.signal?.aborted) {
        throw new ScoutbotAssistantError("Scoutbot request was cancelled.", 408);
      }
      throw new ScoutbotAssistantError(
        `OpenAI Responses call exceeded ${Math.round(OPENAI_CALL_TIMEOUT_MS / 1000)}s — likely a large brief context or a stuck upstream.`,
        504,
      );
    }
    throw error;
  }

  const abortReadError = (error: unknown): never => {
    if (error instanceof Error && error.name === "AbortError") {
      if (input.signal?.aborted) {
        throw new ScoutbotAssistantError("Scoutbot request was cancelled.", 408);
      }
      throw new ScoutbotAssistantError("OpenAI streaming response was aborted.", 502);
    }
    throw error;
  };

  if (!response.ok) {
    let raw = "";
    try {
      raw = await response.text();
    } catch (error) {
      abortReadError(error);
    }
    let parsed: OpenAIResponsePayload = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as OpenAIResponsePayload;
      } catch {
        parsed = {};
      }
    }
    throw new ScoutbotAssistantError(openAIErrorMessage(parsed) || raw || `OpenAI returned HTTP ${response.status}`, 502);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    let raw = "";
    try {
      raw = await response.text();
    } catch (error) {
      abortReadError(error);
    }
    let parsed: OpenAIResponsePayload = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as OpenAIResponsePayload;
      } catch {
        parsed = {};
      }
    }
    return {
      id: typeof parsed.id === "string" ? parsed.id : null,
      text: extractResponseText(parsed),
      usage: extractUsage(parsed),
      streamed: false,
    };
  }

  if (!response.body) {
    throw new ScoutbotAssistantError("OpenAI streaming response had no body.", 502);
  }

  // Assigned from the handleEvent closure; control-flow analysis cannot see
  // those writes, so reads below cast back to the declared shape.
  let finalPayload: OpenAIResponsePayload | null = null;
  let streamError: ScoutbotAssistantError | null = null;

  const handleEvent = (rawEvent: string) => {
    if (finalPayload || streamError || input.signal?.aborted) return;
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "response.output_text.delta") {
      if (typeof payload.delta === "string" && payload.delta) input.onDelta(payload.delta);
      return;
    }
    if (type === "response.incomplete") {
      streamError = new ScoutbotAssistantError("OpenAI response was incomplete.", 502);
      return;
    }
    if (type === "response.completed") {
      if (payload.response && typeof payload.response === "object") {
        finalPayload = payload.response as OpenAIResponsePayload;
      }
      return;
    }
    if (type === "response.failed") {
      const failed = payload.response;
      const message = failed && typeof failed === "object"
        ? openAIErrorMessage(failed as OpenAIResponsePayload)
        : null;
      streamError = new ScoutbotAssistantError(message || "OpenAI response failed.", 502);
      return;
    }
    if (type === "error") {
      const message = typeof payload.message === "string" && payload.message
        ? payload.message
        : typeof payload.code === "string" && payload.code
          ? payload.code
          : "OpenAI stream error.";
      streamError = new ScoutbotAssistantError(message, 502);
    }
  };

  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  input.signal?.addEventListener("abort", cancelReader, { once: true });
  if (input.signal?.aborted) cancelReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const rawEvent = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleEvent(rawEvent);
        index = buffer.indexOf("\n\n");
      }
      if (streamError || finalPayload) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && !streamError) handleEvent(buffer);
  } catch (error) {
    abortReadError(error);
  } finally {
    input.signal?.removeEventListener("abort", cancelReader);
    cancelReader();
    reader.releaseLock();
  }
  throwIfScoutbotAborted(input.signal);

  if (streamError) throw streamError;
  const completedPayload = finalPayload as OpenAIResponsePayload | null;
  if (!completedPayload) {
    throw new ScoutbotAssistantError("OpenAI stream ended before the response completed.", 502);
  }
  return {
    id: typeof completedPayload.id === "string" ? completedPayload.id : null,
    text: extractResponseText(completedPayload),
    usage: extractUsage(completedPayload),
    streamed: true,
  };
}

/* ── Sentence splitter for streamed replies ───────────────────────────────
 *
 * Accumulates provider deltas and cuts speakable sentences at ending
 * punctuation (. ! ? … :) followed by whitespace. Runaway buffers flush at a
 * word boundary once they exceed maxLength. Fenced code blocks (``` … ```)
 * carry machine payload (scout-ui actions, JSON), never speech, so they are
 * dropped from the sentence stream; an unterminated fence at stream end is
 * dropped too. Emitted sentences are trimmed and never empty. */

export type ScoutbotSentenceSplitter = {
  push: (delta: string) => string[];
  flush: () => string[];
};

export const SCOUTBOT_SENTENCE_MAX_LENGTH = 240;

export function createScoutbotSentenceSplitter(options: { maxLength?: number } = {}): ScoutbotSentenceSplitter {
  const maxLength = Math.max(40, Math.floor(options.maxLength ?? SCOUTBOT_SENTENCE_MAX_LENGTH));
  let buffer = "";
  let held = "";
  let inFence = false;

  const drain = (final: boolean): string[] => {
    const sentences: string[] = [];
    const emit = (raw: string) => {
      const sentence = raw.trim();
      if (sentence) sentences.push(sentence);
    };
    for (;;) {
      if (inFence) {
        const close = buffer.indexOf("```");
        if (close < 0) {
          if (final) {
            // Unterminated fence: keep the speakable text held before it,
            // drop the machine payload remainder.
            buffer = held;
            held = "";
            inFence = false;
            continue;
          }
          // Keep only the tail needed to detect a marker split across deltas.
          if (buffer.length > 2) buffer = buffer.slice(-2);
          break;
        }
        buffer = held + buffer.slice(close + 3);
        held = "";
        inFence = false;
        continue;
      }

      const fenceAt = buffer.indexOf("```");
      const region = fenceAt < 0 ? buffer : buffer.slice(0, fenceAt);
      const cut = findSentenceCut(region, maxLength);
      if (cut > 0) {
        emit(region.slice(0, cut));
        buffer = region.slice(cut) + (fenceAt < 0 ? "" : buffer.slice(fenceAt));
        continue;
      }
      if (fenceAt >= 0) {
        held = region;
        buffer = buffer.slice(fenceAt + 3);
        inFence = true;
        continue;
      }
      if (final) {
        emit(region);
        buffer = "";
      }
      break;
    }
    return sentences;
  };

  return {
    push: (delta) => {
      buffer += delta;
      return drain(false);
    },
    flush: () => drain(true),
  };
}

function findSentenceCut(region: string, maxLength: number): number {
  for (let index = 0; index < region.length; index += 1) {
    const code = region.charCodeAt(index);
    const isEnd = code === 0x2e // .
      || code === 0x21 // !
      || code === 0x3f // ?
      || code === 0x2026 // …
      || code === 0x3a; // :
    if (!isEnd) continue;
    const next = region[index + 1];
    if (next !== undefined && /\s/.test(next)) return index + 1;
  }
  if (region.length >= maxLength) {
    const window = region.slice(0, maxLength);
    for (let index = window.length - 1; index > 0; index -= 1) {
      if (/\s/.test(window[index]!)) return index;
    }
    // Hard cut for a runaway word (URL, hash); never split a surrogate pair.
    let hard = maxLength;
    const code = region.charCodeAt(hard - 1);
    if (code >= 0xd800 && code <= 0xdbff) hard -= 1;
    return hard;
  }
  return -1;
}

function throwIfScoutbotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ScoutbotAssistantError("Scoutbot request was cancelled.", 408);
  }
}

function extractUsage(payload: OpenAIResponsePayload): BriefTokenUsage | null {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const pickInt = (value: unknown): number | null => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
    return value;
  };
  const input = pickInt(record.input_tokens);
  const output = pickInt(record.output_tokens);
  const total = pickInt(record.total_tokens);
  if (input === null && output === null && total === null) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/* ── Presenter call (SCO-037 step 5) ──────────────────────────────────
 *
 * The analyst emits markdown; the presenter turns that markdown into a
 * small bundle of TTS-shaped sentences. Cheaper model, smaller context,
 * shorter timeout. On any failure we throw — the caller catches and
 * degrades gracefully (brief returns without TTS polish). */

async function presentBriefMarkdown(input: {
  apiKey: string;
  baseUrl: string;
  fetchImpl: ScoutbotFetch;
  model: string;
  markdown: string;
  voiceSpec: BriefVoiceSpec;
}): Promise<{ presented: ScoutbotBriefPresented; usage: BriefTokenUsage | null }> {
  const systemPrompt = buildPresenterSystemPrompt(input.voiceSpec);
  const userInput = buildPresenterUserPrompt(input.markdown, input.voiceSpec);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRESENTER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await input.fetchImpl(`${trimTrailingSlash(input.baseUrl)}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        instructions: systemPrompt,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: userInput }],
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ScoutbotAssistantError(
        `Presenter call exceeded ${Math.round(PRESENTER_TIMEOUT_MS / 1000)}s — falling back to derived narration.`,
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let parsed: OpenAIResponsePayload = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as OpenAIResponsePayload;
    } catch {
      parsed = {};
    }
  }
  if (!response.ok) {
    throw new ScoutbotAssistantError(
      openAIErrorMessage(parsed) || raw || `Presenter HTTP ${response.status}`,
      502,
    );
  }
  const text = extractResponseText(parsed);
  const sentences = parsePresenterSentences(text);

  return {
    presented: {
      sentences,
      voiceSpec: input.voiceSpec,
      model: input.model,
      responseId: typeof parsed.id === "string" ? parsed.id : null,
    },
    usage: extractUsage(parsed),
  };
}

function buildPresenterSystemPrompt(voiceSpec: BriefVoiceSpec): string {
  return [
    `You are the Brief Presenter. You receive a clean markdown brief and produce ${voiceSpec.targetWords} (roughly, give or take 15) words of spoken narration.`,
    `Voice persona: ${voiceSpec.persona}. Keep cadence calm and confident.`,
    "Return ONLY the spoken sentences, one per line. No JSON, no markdown, no preamble.",
    "Rules:",
    "- 3 to 4 sentences total.",
    "- Open with the headline reworded for speech (do not literally say 'headline').",
    "- The next 1 to 2 sentences cover the highest-weighted finding(s). Mention concrete names from the markdown.",
    "- The final sentence is the recommendation, phrased as a quiet directive.",
    "- Do not enumerate counters, do not list every reference, do not name every finding.",
    "- Do not introduce facts that are not in the markdown.",
  ].join("\n");
}

function buildPresenterUserPrompt(markdown: string, voiceSpec: BriefVoiceSpec): string {
  return [
    `Voice spec: target ${voiceSpec.targetWords} words, persona "${voiceSpec.persona}".`,
    "",
    "Markdown brief:",
    markdown,
  ].join("\n");
}

function parsePresenterSentences(text: string): string[] {
  if (!text) return [];
  // The presenter is asked for one sentence per line. Be lenient: also split
  // on plain newlines and strip empty lines / common bullet prefixes.
  return text
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[\s\-*•]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);
}

function extractResponseText(payload: OpenAIResponsePayload): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of payload.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        parts.push(record.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function openAIErrorMessage(payload: OpenAIResponsePayload): string | null {
  const error = payload.error;
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}

function briefSystemPrompt(basePrompt: string, mode: ScoutbotBriefMode): string {
  const shared = [
    basePrompt,
    "",
    "Brief output mode (SCO-037 v1):",
    "Return ONLY a clean markdown document. No JSON, no preamble, no trailing prose.",
    "The document is the canonical brief artifact: it is persisted in Briefing Room, rendered directly to the operator, and later phrased into TTS by a separate presenter call.",
    "Write the document for *reading*, not for speaking. The presenter handles spoken cadence.",
    "",
    "Required document conventions:",
    "- First line is a title in the form: `# Brief · <mode>` where <mode> is `fleet` for the fleet-home brief or `tour` for the one-minute tour.",
    "- Second line is an italicized metadata line in the form: `*as of <ISO timestamp> · ttl <seconds>s*`.",
    "- Then a `## Headline` section with ONE signal-rich phrase. Do not repeat counters the UI already shows.",
    "- Then a `## Findings` section. Each finding is a third-level header `### <Tone> · <weight>` where <Tone> is one of `Attention`, `Risk`, `Progress`, `Context`, and <weight> is an integer 1..10 (higher = more urgent).",
    "- Under each finding header: one short paragraph of evidence-grounded observation, followed by a bullet list of reference links. Each reference is a markdown link whose href is a Scout route string: `agents/<id>`, `conversation/<id>`, `work/<id>`, `session/<id>`, `activity`, `broker`, `mesh`, `fleet`, `ops/tail`, `ops/mission`, `ops/atop`, `ops/issues`. Use IDs from the snapshot.",
    "- Then `## Deltas since last` — a short bullet list of what shifted vs the prior brief. Omit the section if there is no prior brief.",
    "- Then `## Recommendation` — one concrete next inspection or action.",
    "- Then `## Actions` — a bullet list of markdown links to safe routes. Use the same route href format as references.",
    "",
    "Do not invent IDs that are not in the snapshot. Do not link to routes whose IDs you cannot ground in the snapshot.",
    "Do not produce a JSON code block. Do not wrap the markdown in a code fence.",
    "Do not create durable Scout records or imply that work has been started.",
    "",
    "Fleet definition (important):",
    "The operator's fleet is NOT just the registered Scout agents. It also includes 'harnessActivity' — organic Claude, Codex, and other harness processes the operator runs locally that Scout observes via tail discovery but does not register as agents.",
    "When you summarize what's happening, ALWAYS count harnessActivity.processes as active work (these are real running sessions) and harnessActivity.transcripts as recent runs.",
    "If registered agents show 'none active' but harnessActivity has running processes or recent transcripts, the correct framing is: 'N organic sessions running outside Scout's registered agents.' Never say 'nothing is happening' when transcripts or processes exist.",
    "When relevant, the Actions section should include `ops/tail` or a `session/<id>` link so the operator can see this organic activity.",
  ];

  if (mode === "fleet-home") {
    shared.push(
      "",
      "Fleet-home hero mode:",
      "For this mode, act as Scoutbot Brief Compiler: a Scout-aware context session that understands broker records, agent registrations, conversations, work items, invocations, flights, sessions, and observed harness transcripts.",
      "This output appears inside the Fleet home hero beside already-visible counters for active, available, queued, and offline agents.",
      "Do NOT use the Fleet narration to repeat those counters or say that many agents are available with zero active work. The UI already says that.",
      "Assume deterministic facts that deserve permanent UI, such as simple counts, online/offline status, and ordinary recency, will be shown elsewhere. Spend the brief on interpretation and cognitive assistance.",
      "Use LLM judgment over the snapshot. Start with briefingEvidence.agentLogMessages (last 50 observed agent-log events) and briefingEvidence.scoutChatter (last 50 Scout messages), then cross-check recentCompleted, activity, sessions, activeWork, activeRuns, operatorAttention, needsAttention, and harnessActivity.",
      "Derivation rule: messages and transcripts are evidence for meaning, but clickable references must be grounded in concrete IDs from the snapshot such as agentId, conversationId, workId/recordId, sessionId, invocationId, flightId, or activity id.",
      "Treat the brief as an attention layer, not a dashboard summary. Answer: what deserves the operator's next 30 seconds, what subtle signal could fall through the cracks, and what might they be forgetting?",
      "Priority order: (1) needs-you-now items: approvals, decisions, questions, failed checks, blocked work; (2) stale or hidden obligations: asks without replies, sessions idle after an error, repeated failures, ambiguous ownership; (3) material progress: ships, completed work, docs/code changes, verification results; (4) current work only when it has a deliverable, owner, or risk; (5) next best inspection point.",
      "If anything is waiting, blocked, failed, stale, needs human input, or looks risky, make that the first sentence and include owner plus next move when evidence supports it.",
      "If the system is idle, replay what recently happened and what is still worth checking: notable completed work, recent ships, changed docs/code, organic sessions/transcripts, unanswered questions, or old threads that look easy to forget. Prefer concrete titles, projects, agent names, outcomes, and time references from the snapshot.",
      "If there is genuinely no useful recent signal, say what to inspect next and why instead of padding with inventory counts.",
      "Produce 2 to 4 findings under `## Findings`, ordered by weight (highest first). Each finding paragraph is one distinct observation. Group by urgency, not by agent.",
      "Write a one-phrase `## Headline` capturing the single signal-richest observation. The headline plus the top finding are what the presenter will most likely speak first.",
      "When an observation mentions an agent, session, conversation, work item, or open attention target, include a matching reference link with a real label and a real route href using IDs from the snapshot. Do not say 'several places' without naming or linking the best 1 to 3 places.",
      "Avoid phrases like 'all agents are available', 'zero active', 'nothing is happening', or 'the fleet is quiet' unless immediately followed by the recent evidence that matters.",
      "Never copy the examples or schema placeholders. They demonstrate shape only.",
      "",
      "Fleet-home examples (shape only; do not reuse names, projects, or wording):",
      "Bad pattern: inventory counter sentence. Good pattern: Needs you now: approval or decision waiting, owner named, consequence stated.",
      "Bad pattern: generic idle/quiet sentence. Good pattern: Since the last window, shipped artifact plus verification state plus next review target.",
      "Bad pattern: no-active-agents sentence. Good pattern: Stale or hidden obligation: thread/session/question has not moved, why it matters, where to inspect.",
      "Bad pattern: agent-status sentence. Good pattern: Current work tied to deliverable, risk, or critical path.",
      "Bad pattern: raw transcript recap. Good pattern: Plain-language outcome, confidence level, and next best action.",
    );
  }

  return shared.join("\n");
}

function briefOperatorRequest(ttlMs: number, mode: ScoutbotBriefMode): string {
  const ttlSeconds = Math.round(ttlMs / 1000);

  if (mode === "fleet-home") {
    return [
      "Prepare the Fleet home brief as a clean markdown document (SCO-037 v1).",
      `The prepared snapshot TTL is ${ttlSeconds} seconds.`,
      "The hero already has deterministic counters; add judgment from the last 50 agent-log events and last 50 Scout messages.",
      "Focus on things requiring attention, subtle signals that could fall through the cracks, stale/hidden obligations, material progress with consequence, and useful next inspection points.",
      "Emit the document in EXACTLY this shape (this is the structural template — do not copy the placeholder content):",
      "",
      "```",
      "# Brief · fleet",
      `*as of <ISO timestamp> · ttl ${ttlSeconds}s*`,
      "",
      "## Headline",
      "<one signal-rich phrase — do not repeat visible counters>",
      "",
      "## Findings",
      "",
      "### Attention · 8",
      "<one short paragraph of evidence-grounded observation>",
      "- agent: [<Name>](agents/<agentId>)",
      "- conversation: [<Label>](conversation/<conversationId>)",
      "",
      "### Risk · 6",
      "<one short paragraph>",
      "- work: [<Title>](work/<workId>)",
      "",
      "### Progress · 4",
      "<one short paragraph>",
      "- session: [<Label>](session/<sessionId>)",
      "",
      "## Recommendation",
      "<one concrete next inspection or action>",
      "",
      "## Actions",
      "- [Open Activity](activity)",
      "- [Open <Agent>](agents/<agentId>)",
      "```",
      "",
      "Reminders:",
      "- Do not wrap the document in a code fence in the final output. The fence above is only to show the shape.",
      "- Findings ordered by weight, highest first. Use Attention / Risk / Progress / Context tones.",
      "- Every reference link must use a real ID from the snapshot. Do not invent IDs.",
    ].join("\n");
  }

  return [
    "Prepare a one-minute OpenScout control-plane brief as a clean markdown document (SCO-037 v1).",
    `The prepared snapshot TTL is ${ttlSeconds} seconds.`,
    "Emit the document in EXACTLY this shape (this is the structural template — do not copy the placeholder content):",
    "",
    "```",
    "# Brief · tour",
    `*as of <ISO timestamp> · ttl ${ttlSeconds}s*`,
    "",
    "## Headline",
    "<one phrase that frames what the operator should pay attention to right now>",
    "",
    "## Findings",
    "",
    "### Attention · 7",
    "<one short paragraph of observation, ideally something the operator would want to see in a guided tour>",
    "- agent: [<Name>](agents/<agentId>)",
    "",
    "### Progress · 5",
    "<one short paragraph>",
    "- activity: [Open Activity](activity)",
    "",
    "## Recommendation",
    "<one concrete next action>",
    "",
    "## Actions",
    "- [Open Ops Tail](ops/tail)",
    "- [Open Sessions](sessions)",
    "```",
    "",
    "Reminders:",
    "- Do not wrap the document in a code fence in the final output.",
    "- 2 to 4 findings, ordered by weight, highest first.",
    "- Reference hrefs use Scout route strings, not full URLs.",
  ].join("\n");
}

function parseBriefResponse(
  raw: string,
  timing: { preparedAt: number; ttlMs: number },
  mode: ScoutbotBriefMode = "tour",
): ScoutbotBrief {
  // SCO-037: the analyst now emits markdown. The structured ScoutbotBrief
  // fields are derived from the markdown for backward compatibility with
  // consumers that haven't migrated to direct markdown rendering yet.
  // If the model drifts and emits JSON anyway, fall back to the old path.
  const trimmedBody = stripBriefCodeFence(raw).trim();
  if (looksLikeBriefMarkdown(trimmedBody)) {
    return briefFromMarkdown(trimmedBody, timing, mode);
  }

  const parsed = parseJsonObject(raw);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const expiresAt = timing.preparedAt + timing.ttlMs;
  const steps = normalizeBriefSteps(record.steps, timing.preparedAt, expiresAt);
  const fallbackSummary = raw.replace(/\s+/g, " ").trim();

  return {
    id: `brf_${randomUUID()}`,
    title: stringField(record.title, "One-minute brief"),
    summary: stringField(record.summary, fallbackSummary || "Scoutbot prepared a current control-plane brief."),
    preparedAt: timing.preparedAt,
    expiresAt,
    ttlMs: timing.ttlMs,
    steps: steps.length > 0 ? steps : fallbackBriefSteps(fallbackSummary, timing.preparedAt, expiresAt),
    recommendation: stringField(record.recommendation, fallbackSummary || "Start with the current ops view."),
    actions: normalizeBriefActions(record.actions),
  };
}

/* ── Markdown brief parsing (SCO-037 v1) ──────────────────────────────── */

function looksLikeBriefMarkdown(body: string): boolean {
  return /^#\s+Brief\b/m.test(body) || /^##\s+Headline\b/m.test(body) || /^##\s+Findings\b/m.test(body);
}

function stripBriefCodeFence(raw: string): string {
  return raw.replace(/^\s*```(?:markdown|md)?\s*/i, "").replace(/\s*```\s*$/i, "");
}

type MarkdownFinding = {
  tone: "attention" | "risk" | "progress" | "context";
  weight: number;
  text: string;
  references: { label: string; href: string }[];
};

function briefFromMarkdown(
  markdown: string,
  timing: { preparedAt: number; ttlMs: number },
  mode: ScoutbotBriefMode,
): ScoutbotBrief {
  const sections = splitMarkdownSections(markdown);
  const expiresAt = timing.preparedAt + timing.ttlMs;
  const fallbackSummary = markdown.replace(/\s+/g, " ").trim();

  const title = sections.title
    || (mode === "fleet-home" ? "Fleet home brief" : "One-minute brief");
  const headline = sections.headline.trim();
  const findings = parseFindings(sections.findings);
  const recommendation = sections.recommendation.trim()
    || (fallbackSummary || "Start with the current ops view.");
  const actions = parseMarkdownActions(sections.actions);

  // Derive a single step that carries the headline + top findings as narration
  // and the findings as observations. Surfaces still consuming ScoutbotBriefStep
  // continue to work; markdown-aware surfaces read the `markdown` field.
  const narrationLines = [headline, ...findings.slice(0, 3).map((f) => f.text)].filter(Boolean);
  const narration = narrationLines.join(" ").trim()
    || fallbackSummary
    || "Scoutbot prepared a current control-plane brief.";

  const stepRoute = { view: "inbox" };
  const stepLabel = mode === "fleet-home" ? "Fleet" : "Fleet";
  const stepId = mode === "fleet-home" ? "fleet-home" : "fleet";

  const observations: ScoutbotBriefObservation[] = findings.map((f) => ({
    text: f.text,
    tone: f.tone,
    references: f.references.map((r) => {
      const route = routeForHref(r.href);
      return {
        label: r.label || r.href,
        kind: routeKindForHref(r.href),
        ...(route ? { route } : {}),
      };
    }),
  }));

  const step: ScoutbotBriefStep = {
    id: stepId,
    label: stepLabel,
    route: stepRoute,
    narration,
    durationMs: estimateStepDurationMs(narration),
    snapshot: {
      capturedAt: timing.preparedAt,
      expiresAt,
      source: "prepared",
    },
    observations,
  };

  return {
    id: `brf_${randomUUID()}`,
    title,
    summary: headline || fallbackSummary || "Scoutbot prepared a current control-plane brief.",
    preparedAt: timing.preparedAt,
    expiresAt,
    ttlMs: timing.ttlMs,
    steps: [step],
    recommendation,
    actions,
    markdown,
  };
}

function splitMarkdownSections(markdown: string): {
  title: string;
  headline: string;
  findings: string;
  recommendation: string;
  actions: string;
} {
  const titleMatch = markdown.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : "";

  // Capture body of each ## section until the next ## or end.
  const captureSection = (name: string): string => {
    const re = new RegExp(`^##\\s+${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, "im");
    const m = markdown.match(re);
    return m ? m[1]!.trim() : "";
  };

  return {
    title,
    headline: captureSection("Headline"),
    findings: captureSection("Findings"),
    recommendation: captureSection("Recommendation"),
    actions: captureSection("Actions"),
  };
}

function parseFindings(block: string): MarkdownFinding[] {
  if (!block) return [];
  const findings: MarkdownFinding[] = [];
  // Each finding starts with `### <Tone> · <weight>` on its own line.
  const re = /^###\s+(Attention|Risk|Progress|Context)\s*[·•|]?\s*(\d+)?\s*$([\s\S]*?)(?=^###\s+|\Z)/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    const tone = match[1]!.toLowerCase() as MarkdownFinding["tone"];
    const weight = match[2] ? Math.max(1, Math.min(10, Number.parseInt(match[2]!, 10) || 1)) : 5;
    const body = match[3]!.trim();
    const lines = body.split(/\n+/);
    const textParts: string[] = [];
    const references: { label: string; href: string }[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const ref = parseReferenceLine(t);
      if (ref) {
        references.push(ref);
      } else if (!t.startsWith("-")) {
        textParts.push(t);
      }
    }
    findings.push({
      tone,
      weight,
      text: textParts.join(" ").trim(),
      references,
    });
  }
  findings.sort((a, b) => b.weight - a.weight);
  return findings;
}

function parseReferenceLine(line: string): { label: string; href: string } | null {
  // Accepts `- agent: [Label](agents/<id>)`, `- [Label](agents/<id>)`, or `[Label](href)`.
  const m = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (!m) return null;
  return { label: m[1]!.trim(), href: m[2]!.trim() };
}

function parseMarkdownActions(block: string): ScoutbotBriefAction[] {
  if (!block) return [];
  const actions: ScoutbotBriefAction[] = [];
  const re = /^-\s*\[([^\]]+)\]\(([^)]+)\)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    const label = match[1]!.trim();
    const href = match[2]!.trim();
    const route = routeForHref(href);
    actions.push({
      label,
      ...(route ? { route } : { prompt: href }),
    });
  }
  return actions;
}

function routeForHref(href: string): Record<string, unknown> | null {
  const trimmed = href.replace(/^\/+/, "").trim();
  if (!trimmed) return null;
  const [head, ...rest] = trimmed.split("/");
  switch (head) {
    case "agents":
      return rest.length > 0
        ? { view: "agents-v2", agentId: rest.join("/") }
        : { view: "agents-v2" };
    case "conversation":
      return rest.length > 0
        ? { view: "conversation", conversationId: rest.join("/") }
        : { view: "conversation" };
    case "work":
      return rest.length > 0
        ? { view: "work", workId: rest.join("/") }
        : { view: "work" };
    case "session":
    case "sessions":
      return rest.length > 0
        ? { view: "sessions", sessionId: rest.join("/") }
        : { view: "sessions" };
    case "ops":
      return rest.length > 0
        ? { view: "ops", mode: rest[0] }
        : { view: "ops" };
    case "activity":
    case "broker":
    case "mesh":
    case "fleet":
    case "inbox":
      return { view: "inbox" };
    case "settings":
      return { view: head };
    default:
      return null;
  }
}

function routeKindForHref(href: string): ScoutbotBriefReference["kind"] {
  const head = href.replace(/^\/+/, "").split("/")[0] ?? "";
  switch (head) {
    case "agents": return "agent";
    case "conversation": return "conversation";
    case "work": return "work";
    case "session":
    case "sessions": return "session";
    case "activity": return "activity";
    default: return "ops";
  }
}

function estimateStepDurationMs(narration: string): number {
  const words = narration.split(/\s+/).filter(Boolean).length;
  return Math.min(12_000, Math.max(3500, words * 360));
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const candidates = [
    trimmed,
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ].filter((candidate) => candidate.trim().startsWith("{") && candidate.trim().endsWith("}"));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function normalizeBriefSteps(raw: unknown, capturedAt: number, expiresAt: number): ScoutbotBriefStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 5)
    .map((entry, index) => normalizeBriefStep(entry, index, capturedAt, expiresAt))
    .filter((entry): entry is ScoutbotBriefStep => Boolean(entry));
}

function normalizeBriefStep(
  raw: unknown,
  index: number,
  capturedAt: number,
  expiresAt: number,
): ScoutbotBriefStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const route = sanitizeBriefRoute(record.route);
  const narration = stringField(record.narration, "").trim();
  if (!route || !narration) return null;
  const label = stringField(record.label, routeLabel(route));
  const observations = normalizeBriefObservations(record.observations);
  const references = normalizeBriefReferences(record.references);
  return {
    id: stringField(record.id, `${String(route.view ?? "step")}-${index + 1}`).replace(/[^a-z0-9_-]/gi, "-").toLowerCase(),
    label,
    route,
    narration,
    ...(observations.length > 0 ? { observations } : {}),
    ...(references.length > 0 ? { references } : {}),
    durationMs: estimateNarrationDuration(narration),
    snapshot: {
      capturedAt,
      expiresAt,
      source: "prepared",
    },
  };
}

function normalizeBriefObservations(raw: unknown): ScoutbotBriefObservation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 5)
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const text = stringField(record.text, "").trim();
      if (!text) return null;
      const tone = typeof record.tone === "string" && record.tone.trim()
        ? record.tone.trim()
        : undefined;
      const references = normalizeBriefReferences(record.references);
      return {
        text,
        ...(tone ? { tone } : {}),
        references,
      };
    })
    .filter((entry): entry is ScoutbotBriefObservation => Boolean(entry));
}

function normalizeBriefReferences(raw: unknown): ScoutbotBriefReference[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 4)
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const label = stringField(record.label, "").trim();
      if (!label) return null;
      const kind = stringField(record.kind, "reference").trim().replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
      const route = sanitizeBriefRoute(record.route);
      const detail = typeof record.detail === "string" && record.detail.trim()
        ? record.detail.trim()
        : undefined;
      return {
        label,
        kind,
        ...(route ? { route } : {}),
        ...(detail ? { detail } : {}),
      };
    })
    .filter((entry): entry is ScoutbotBriefReference => Boolean(entry));
}

function fallbackBriefSteps(summary: string, capturedAt: number, expiresAt: number): ScoutbotBriefStep[] {
  const narration = summary || "I prepared a fresh control-plane snapshot. Start with Fleet, then check Ops Tail and Broker health.";
  return [
    {
      id: "fleet",
      label: "Fleet",
      route: { view: "inbox" },
      narration,
      durationMs: estimateNarrationDuration(narration),
      snapshot: { capturedAt, expiresAt, source: "prepared" },
    },
  ];
}

function normalizeBriefActions(raw: unknown): ScoutbotBriefAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 3)
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const label = stringField(record.label, "").trim();
      if (!label) return null;
      const route = sanitizeBriefRoute(record.route);
      const prompt = typeof record.prompt === "string" && record.prompt.trim()
        ? record.prompt.trim()
        : undefined;
      return {
        label,
        ...(route ? { route } : {}),
        ...(prompt ? { prompt } : {}),
      };
    })
    .filter((entry): entry is ScoutbotBriefAction => Boolean(entry));
}

function sanitizeBriefRoute(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const view = typeof record.view === "string" ? record.view : "";
  switch (view) {
    // Legacy fleet alias → home (inbox). Accept both from model output.
    case "fleet":
    case "inbox":
      return { view: "inbox" };
    case "broker":
    case "mesh":
    case "activity":
      return { view };
    // Legacy agents alias → projects (agents-v2).
    case "agents":
    case "agents-v2":
      return {
        view: "agents-v2",
        ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
        ...(record.tab === "observe" || record.tab === "message" || record.tab === "profile" ? { tab: record.tab } : {}),
      };
    case "sessions":
      return {
        view,
        ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      };
    case "settings":
      return {
        view,
        ...(record.section === "agents" ? { section: record.section } : {}),
        ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
      };
    case "ops":
      return {
        view: "ops",
        ...(record.mode === "tail" || record.mode === "atop" || record.mode === "agents"
          ? { mode: record.mode }
          : { mode: "tail" }),
      };
    case "conversation":
      return typeof record.conversationId === "string"
        ? { view, conversationId: record.conversationId }
        : null;
    case "work":
      return typeof record.workId === "string" ? { view, workId: record.workId } : null;
    default:
      return null;
  }
}

function routeLabel(route: Record<string, unknown>): string {
  if (route.view === "ops") return "Ops";
  return typeof route.view === "string"
    ? route.view.slice(0, 1).toUpperCase() + route.view.slice(1)
    : "Step";
}

function estimateNarrationDuration(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return clampNumber(words * 360, 3500, 12_000);
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function createSession(model: string): StoredSession {
  const now = Date.now();
  return {
    id: `rgr_${randomUUID()}`,
    title: "New Scout Session",
    createdAt: now,
    updatedAt: now,
    model,
    responseProvider: null,
    previousResponseId: null,
    messages: [],
    archivedAt: null,
  };
}

function publicSession(session: StoredSession): ScoutbotAssistantSession {
  return {
    ...publicSessionSummary(session),
    messages: session.messages.slice(),
  };
}

function publicSessionSummary(session: StoredSession): ScoutbotAssistantSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model,
    messageCount: session.messages.length,
  };
}

function titleFromRequest(body: string): string {
  const singleLine = body.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 48) return singleLine || "Scout Session";
  return `${singleLine.slice(0, 45).trimEnd()}...`;
}

function compareSessionsByUpdatedAt(left: StoredSession, right: StoredSession): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt;
}

function clampInteger(value: string | undefined | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeProviderPreference(value: string | undefined | null): ScoutbotAssistantProviderPreference {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "openai" || normalized === "codex" || normalized === "agent") return normalized;
  return "auto";
}

function buildAssistantUserPrompt(
  body: string,
  context?: ScoutbotAssistantContextSnapshot,
): string {
  if (!context) return body;
  return [
    `Operator request:\n${body}`,
    "",
    "Current Scout control-plane snapshot:",
    JSON.stringify(context),
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstNonEmptyString(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
