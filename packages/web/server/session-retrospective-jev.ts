import {
  buildJevRequestBody,
  buildSessionRetrospectiveProfile,
  JEV_LABEL_IDS,
  JEV_MODEL,
  normalizeJevLabels,
  retrospectiveLabelEvidence,
  type JevLabelEvidence,
  type JevLabelId,
  type SessionRetrospectiveProfile,
} from "../shared/session-retrospective.ts";
import type { ObserveData, SessionRefObservePayload } from "./core/observe/service.ts";

/** TypeSafe AI's hosted Jev (System One) classifier. Override with OPENSCOUT_JEV_ENDPOINT. */
export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 8_000;
const JEV_CONFIDENCE_FLOOR = 0.72;

export class SessionRetrospectiveJevError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503 | 502 | 504) {
    super(message);
    this.name = "SessionRetrospectiveJevError";
  }
}

export type JevRetrospectiveResponse = {
  status: "ready";
  model: string;
  labels: JevLabelEvidence[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  cost: null;
};

/**
 * The configured Jev endpoint, or null when it is not an acceptable URL.
 * https is required unless the host is loopback (for a local stand-in).
 */
export function resolveJevEndpoint(raw: string | undefined | null): string | null {
  const value = raw?.trim() || DEFAULT_JEV_ENDPOINT;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return url.toString();
}

export type JevRetrospectiveStatus = {
  /** True only when the operator configured TYPESAFE_API_KEY and a valid endpoint. */
  available: boolean;
  /** Where a confirmed request would go; shown in the preview. */
  endpoint: string | null;
};

export function jevRetrospectiveStatus(env: Record<string, string | undefined> = process.env): JevRetrospectiveStatus {
  const endpoint = resolveJevEndpoint(env.OPENSCOUT_JEV_ENDPOINT);
  return { available: Boolean(env.TYPESAFE_API_KEY?.trim()) && endpoint !== null, endpoint };
}

function parseQualifiedSessionRef(value: string): { refId: string; harness: string } | null {
  const match = /^session:([^:]+):(.+)$/i.exec(value.trim());
  return match ? { harness: normalizeHarness(match[1]!), refId: normalizeSessionRef(match[2]!) } : null;
}

function normalizeSessionRef(value: string): string {
  const trimmed = value.trim();
  const leaf = trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed;
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function normalizeHarness(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-") ?? "";
  if (normalized === "claude-code" || normalized === "claude-stream-json") return "claude";
  if (normalized === "codex-app-server" || normalized === "codex-exec") return "codex";
  if (normalized === "pi-rpc") return "pi";
  return normalized;
}

function observedHarness(payload: SessionRefObservePayload): string {
  const session = payload.data.metadata?.session;
  return normalizeHarness(session?.adapterType) || normalizeHarness(session?.source) || normalizeHarness(session?.originator);
}

function validateCompletedSession(payload: SessionRefObservePayload | null, sessionRef: string, harness: string): ObserveData {
  if (!payload) throw new SessionRetrospectiveJevError("This session is no longer available.", 404);
  const harnessFromRecord = observedHarness(payload);
  if (!harnessFromRecord || normalizeHarness(harness) !== harnessFromRecord) {
    throw new SessionRetrospectiveJevError("The session source could not be verified.", 409);
  }
  if (payload.source === "live" || payload.data.live === true) {
    throw new SessionRetrospectiveJevError("Jev labels are available for completed sessions only.", 409);
  }
  const payloadRef = normalizeSessionRef(payload.sessionId || payload.refId);
  const requestedRef = normalizeSessionRef(parseQualifiedSessionRef(sessionRef)?.refId ?? sessionRef);
  if (payloadRef && requestedRef && payloadRef.toLowerCase() !== requestedRef.toLowerCase()) {
    throw new SessionRetrospectiveJevError("The observed session changed. Review the preview again.", 409);
  }
  return payload.data;
}

function parseProviderResponse(value: unknown): {
  model: string;
  answers: Partial<Record<JevLabelId, number>>;
  inputTokens: number | null;
  outputTokens: number | null;
} {
  if (!value || typeof value !== "object") throw new SessionRetrospectiveJevError("Jev returned an invalid response.", 502);
  const record = value as Record<string, unknown>;
  const answerMap = record.answers && typeof record.answers === "object"
    ? record.answers as Record<string, unknown>
    : {};
  const answers: Partial<Record<JevLabelId, number>> = {};
  for (const id of JEV_LABEL_IDS) {
    const answer = answerMap[id];
    if (answer && typeof answer === "object") {
      const answerRecord = answer as Record<string, unknown>;
      const probability = answerRecord.noul;
      if (answerRecord.type === "noul" && typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1) {
        answers[id] = probability;
      }
    }
  }
  if (Object.keys(answers).length !== JEV_LABEL_IDS.length) {
    throw new SessionRetrospectiveJevError("Jev returned incomplete label results.", 502);
  }
  const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : {};
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const validUsage = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  return {
    model: typeof record.model === "string" ? record.model.slice(0, 80) : JEV_MODEL,
    answers,
    inputTokens: validUsage(input) ? input : null,
    outputTokens: validUsage(output) ? output : null,
  };
}

export async function generateSessionRetrospectiveLabels(input: {
  sessionRef: unknown;
  harness: unknown;
  confirmed: unknown;
  preview: unknown;
  loadObserve: (ref: string) => Promise<SessionRefObservePayload | null>;
  apiKey?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<JevRetrospectiveResponse> {
  const sessionRef = typeof input.sessionRef === "string" ? input.sessionRef.trim() : "";
  const harness = typeof input.harness === "string" ? input.harness.trim() : "";
  if (!sessionRef || !harness) throw new SessionRetrospectiveJevError("A session and harness are required.", 400);
  if (input.confirmed !== true) throw new SessionRetrospectiveJevError("Review the data preview and confirm before sending it to Jev.", 400);
  const apiKey = input.apiKey ?? process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new SessionRetrospectiveJevError("Jev is not configured. Set TYPESAFE_API_KEY on the local web server.", 503);
  const endpoint = resolveJevEndpoint(input.endpoint ?? process.env.OPENSCOUT_JEV_ENDPOINT);
  if (!endpoint) throw new SessionRetrospectiveJevError("OPENSCOUT_JEV_ENDPOINT must be an https URL (http is allowed only for loopback).", 503);

  const ref = parseQualifiedSessionRef(sessionRef);
  const requestedHarness = ref?.harness ?? normalizeHarness(harness);
  const lookupRef = ref ? sessionRef : `session:${harness}:${sessionRef}`;
  const data = validateCompletedSession(await input.loadObserve(lookupRef), sessionRef, requestedHarness);
  const profile = buildSessionRetrospectiveProfile(data);
  if (JSON.stringify(profile) !== JSON.stringify(input.preview)) {
    throw new SessionRetrospectiveJevError("The session activity changed after the preview. Review the updated preview before generating labels.", 409);
  }
  if (!retrospectiveLabelEvidence(profile).some((item) => item.hasEvidence)) {
    return { status: "ready", model: JEV_MODEL, labels: [], usage: { inputTokens: null, outputTokens: null }, cost: null };
  }

  // One request per explicit operator action. No retries: failures surface to
  // the operator, who decides whether to send again.
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildJevRequestBody(profile)),
      redirect: "error",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(JEV_TIMEOUT_MS)])
        : AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SessionRetrospectiveJevError("Jev did not respond in time. Try again.", 504);
    }
    throw new SessionRetrospectiveJevError("Could not reach Jev. Try again later.", 502);
  }
  if (!response.ok) {
    if (response.status === 401) throw new SessionRetrospectiveJevError("The configured Jev API key was not accepted.", 503);
    if (response.status === 429 || response.status === 529) throw new SessionRetrospectiveJevError("Jev is busy. Try again shortly.", 503);
    throw new SessionRetrospectiveJevError("Jev could not classify this session.", 502);
  }
  const parsed = parseProviderResponse(await response.json().catch(() => null));
  return {
    status: "ready",
    model: parsed.model,
    labels: normalizeJevLabels(profile, parsed.answers, JEV_CONFIDENCE_FLOOR),
    usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
    cost: null,
  };
}
