import type { LiveFinalization } from "./live-finalization.ts";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { type ScoutRealtimeVoiceSettings } from "../shared/realtime-voice.ts";
import { resolveDbPath } from "./db/internal/db.ts";

const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const DEFAULT_REALTIME_MODEL = "gpt-live-1";
const DEFAULT_REALTIME_VOICE = "marin";
const MAX_SDP_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_CALLS = 1;
const DEFAULT_STARTS_PER_MINUTE = 4;
const DEFAULT_LEASE_TTL_MS = 90_000;
const RATE_WINDOW_MS = 60_000;
const ADMISSION_DB_BUSY_TIMEOUT_MS = 2_000;

// Live splits the prompt in two: these frontend instructions govern the spoken
// conversation and when to hand work off, while everything Scout actually knows
// stays behind the delegation handler. Business rules do not belong here.
const SCOUT_LIVE_INSTRUCTIONS = [
  "You are Scoutbot Voice, the spoken front end for OpenScout's in-app control-plane assistant.",
  "Keep turns concise, practical, conversational, and suitable for audio.",
  "Delegate to the application for any question about the operator's fleet, agents, projects, workspace, current work, coordination, navigation, or what to do next.",
  "You never hold live Scout state yourself. Never invent fleet state, and never claim a Scout action completed unless the delegated result says so.",
  "While a delegation is in flight you may stay in the conversation, but do not guess at the answer before the result arrives.",
  "Speak the delegated result in your own words. Do not read JSON, fence markup, or implementation details aloud.",
  "You may handle a simple greeting or a conversational aside directly; delegate whenever the operator asks for work or live context.",
].join(" ");

export type ScoutRealtimeVoiceConfig = {
  model: string;
  voice: string;
  instructions: string;
};

export type ScoutRealtimeVoiceAdmissionConfig = {
  maxConcurrentCalls: number;
  startsPerMinute: number;
  leaseTtlMs: number;
};

export type ScoutRealtimeVoiceLease = {
  id: string;
  expiresAt: number;
};

export class ScoutRealtimeVoiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly diagnostic?: Record<string, string | number>,
    readonly providerSessionId?: string,
  ) {
    super(message);
    this.name = "ScoutRealtimeVoiceError";
  }
}

export class ScoutRealtimeVoiceAdmissionError extends ScoutRealtimeVoiceError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message, 429, { retryAfterSeconds });
    this.name = "ScoutRealtimeVoiceAdmissionError";
  }
}

/**
 * SQLite-backed admission keeps the pilot limit coherent across overlapping
 * local web processes (for example during a restart). It is intentionally a
 * host-local guard, not distributed quota or billing infrastructure.
 */
export class ScoutRealtimeVoiceAdmission {
  readonly config: ScoutRealtimeVoiceAdmissionConfig;
  private readonly database: Database;
  private readonly ownsDatabase: boolean;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(options: {
    config?: Partial<ScoutRealtimeVoiceAdmissionConfig>;
    database?: Database;
    databasePath?: string;
    now?: () => number;
    randomId?: () => string;
  } = {}) {
    this.config = {
      maxConcurrentCalls: options.config?.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
      startsPerMinute: options.config?.startsPerMinute ?? DEFAULT_STARTS_PER_MINUTE,
      leaseTtlMs: options.config?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    };
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    if (options.database) {
      this.database = options.database;
      this.ownsDatabase = false;
    } else {
      const path = options.databasePath ?? defaultRealtimeVoiceAdmissionPath();
      mkdirSync(dirname(path), { recursive: true });
      this.database = new Database(path, { create: true });
      this.ownsDatabase = true;
    }
    this.database.exec(`PRAGMA busy_timeout = ${ADMISSION_DB_BUSY_TIMEOUT_MS};`);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA synchronous = NORMAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS realtime_voice_leases (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS realtime_voice_leases_expires_at
        ON realtime_voice_leases(expires_at);
      CREATE TABLE IF NOT EXISTS live_provider_sessions (
        lease_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL,
        reason TEXT, usage_seconds REAL, client_state TEXT, client_reason TEXT, client_usage_seconds REAL, updated_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS realtime_voice_starts (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS realtime_voice_starts_started_at
        ON realtime_voice_starts(started_at);
    `);
  }

  admit(): ScoutRealtimeVoiceLease {
    const now = this.now();
    const leaseId = this.randomId();
    const expiresAt = now + this.config.leaseTtlMs;
    const decide = this.database.transaction(() => {
      this.database.query("DELETE FROM realtime_voice_leases WHERE expires_at <= ?1").run(now);
      this.database.query("DELETE FROM realtime_voice_starts WHERE started_at < ?1").run(now - RATE_WINDOW_MS);

      const active = this.database.query(
        "SELECT COUNT(*) AS count, MIN(expires_at) AS next_expiry FROM realtime_voice_leases WHERE expires_at > ?1",
      ).get(now) as { count: number; next_expiry: number | null };
      if (active.count >= this.config.maxConcurrentCalls) {
        return {
          kind: "concurrency" as const,
          retryAfterSeconds: secondsUntil(active.next_expiry ?? expiresAt, now),
        };
      }

      const recent = this.database.query(
        "SELECT COUNT(*) AS count, MIN(started_at) AS oldest FROM realtime_voice_starts WHERE started_at >= ?1",
      ).get(now - RATE_WINDOW_MS) as { count: number; oldest: number | null };
      if (recent.count >= this.config.startsPerMinute) {
        return {
          kind: "rate" as const,
          retryAfterSeconds: secondsUntil((recent.oldest ?? now) + RATE_WINDOW_MS, now),
        };
      }

      this.database.query(
        "INSERT INTO realtime_voice_leases (id, created_at, expires_at) VALUES (?1, ?2, ?3)",
      ).run(leaseId, now, expiresAt);
      this.database.query(
        "INSERT INTO realtime_voice_starts (id, started_at) VALUES (?1, ?2)",
      ).run(leaseId, now);
      return { kind: "admitted" as const };
    });
    const decision = decide();
    if (decision.kind === "concurrency") {
      throw new ScoutRealtimeVoiceAdmissionError(
        "Realtime voice is still active on this Scout host. Stop it from the footer, or wait a moment for it to finish closing.",
        decision.retryAfterSeconds,
      );
    }
    if (decision.kind === "rate") {
      throw new ScoutRealtimeVoiceAdmissionError(
        "Realtime voice has started too many times in the last minute. Wait briefly, then try again.",
        decision.retryAfterSeconds,
      );
    }
    return { id: leaseId, expiresAt };
  }

  heartbeat(leaseId: string): ScoutRealtimeVoiceLease | null {
    const now = this.now();
    const expiresAt = now + this.config.leaseTtlMs;
    const result = this.database.query(
      "UPDATE realtime_voice_leases SET expires_at = ?1 WHERE id = ?2 AND expires_at > ?3",
    ).run(expiresAt, leaseId, now);
    return result.changes > 0 ? { id: leaseId, expiresAt } : null;
  }

  release(leaseId: string): void {
    this.database.query("DELETE FROM realtime_voice_leases WHERE id = ?1").run(leaseId);
  }

  releaseAll(): number {
    const result = this.database.query("DELETE FROM realtime_voice_leases").run();
    return result.changes;
  }

  activeLeaseCount(): number {
    const now = this.now();
    const row = this.database.query(
      "SELECT COUNT(*) AS count FROM realtime_voice_leases WHERE expires_at > ?1",
    ).get(now) as { count: number };
    return row.count;
  }

  bindSession(leaseId: string, sessionId: string): void {
    this.database.query("INSERT INTO live_provider_sessions (lease_id, session_id, state, updated_at) VALUES (?1, ?2, 'active', ?3)").run(leaseId, sessionId, this.now());
  }

  sessionForLease(leaseId: string): { sessionId: string; state: string } | null {
    return this.database.query("SELECT session_id AS sessionId, state FROM live_provider_sessions WHERE lease_id = ?1").get(leaseId) as { sessionId: string; state: string } | null;
  }

  sessionsNeedingCleanup(): Array<{ leaseId: string; sessionId: string }> {
    return this.database.query(`SELECT p.lease_id AS leaseId, p.session_id AS sessionId FROM live_provider_sessions p
      LEFT JOIN realtime_voice_leases l ON l.id = p.lease_id
      WHERE p.state != 'confirmed' AND p.attempts < 3 AND (l.id IS NULL OR l.expires_at <= ?1)
      AND (p.attempts = 0 OR p.updated_at <= ?2)`).all(this.now(), this.now() - 30000) as Array<{ leaseId: string; sessionId: string }>;
  }

  hasPendingFinalization(): boolean {
    const row = this.database.query("SELECT COUNT(*) AS count FROM live_provider_sessions WHERE state != 'confirmed' AND attempts < 3").get() as {count:number};
    return row.count > 0;
  }

  recordClientFinalization(leaseId: string, result: LiveFinalization): void {
    this.database.query(`UPDATE live_provider_sessions SET client_state = ?1,
      client_reason = ?2, client_usage_seconds = ?3 WHERE lease_id = ?4`)
      .run(result.state, result.reason ?? null, result.seconds ?? null, leaseId);
  }

  reserveFinalization(leaseId: string): { sessionId: string; attempt: number } | null {
    // One UPDATE makes the shared SQLite retry budget authoritative across
    // overlapping web workers, DELETE retries and the watchdog.
    return this.database.query(`UPDATE live_provider_sessions
      SET state = 'closing', attempts = attempts + 1, updated_at = ?1
      WHERE lease_id = ?2 AND state != 'confirmed' AND attempts < 3
      AND (attempts = 0 OR updated_at <= ?3)
      RETURNING session_id AS sessionId, attempts AS attempt`)
      .get(this.now(), leaseId, this.now() - 30000) as {sessionId:string;attempt:number} | null;
  }

  recordFinalization(leaseId: string, result: LiveFinalization, attempt: number): void {
    this.database.query(`UPDATE live_provider_sessions SET state = ?1, reason = ?2,
      usage_seconds = ?3, updated_at = ?4 WHERE lease_id = ?5 AND attempts = ?6 AND state != 'confirmed'`)
      .run(result.state, result.reason ?? null, result.seconds ?? null, this.now(), leaseId, attempt);
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}

export function resolveScoutRealtimeVoiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScoutRealtimeVoiceConfig {
  return {
    model: firstNonEmptyString(env.OPENSCOUT_REALTIME_MODEL) ?? DEFAULT_REALTIME_MODEL,
    voice: firstNonEmptyString(env.OPENSCOUT_REALTIME_VOICE) ?? DEFAULT_REALTIME_VOICE,
    instructions: firstNonEmptyString(env.OPENSCOUT_REALTIME_INSTRUCTIONS) ?? SCOUT_LIVE_INSTRUCTIONS,
  };
}

export function isScoutRealtimeVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.OPENSCOUT_REALTIME_VOICE_ENABLED?.trim() ?? "");
}

export function scoutRealtimeVoiceEnvironmentOverride(
  env: NodeJS.ProcessEnv = process.env,
): boolean | null {
  const value = env.OPENSCOUT_REALTIME_VOICE_ENABLED?.trim();
  if (!value) return null;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  return null;
}

/**
 * The persisted operator preference is the everyday control. An explicit env
 * value remains a deployment override for managed or recovery environments.
 */
export function resolveScoutRealtimeVoiceSettings(
  configuredEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ScoutRealtimeVoiceSettings {
  const environmentOverride = scoutRealtimeVoiceEnvironmentOverride(env);
  if (environmentOverride !== null) {
    return {
      enabled: environmentOverride,
      configuredEnabled,
      source: "environment",
      locked: true,
    };
  }
  return {
    enabled: configuredEnabled,
    configuredEnabled,
    source: "settings",
    locked: false,
  };
}

export function resolveScoutRealtimeVoiceAdmissionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScoutRealtimeVoiceAdmissionConfig {
  return {
    maxConcurrentCalls: positiveInteger(env.OPENSCOUT_REALTIME_VOICE_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_CALLS),
    startsPerMinute: positiveInteger(env.OPENSCOUT_REALTIME_VOICE_STARTS_PER_MINUTE, DEFAULT_STARTS_PER_MINUTE),
    leaseTtlMs: positiveInteger(env.OPENSCOUT_REALTIME_VOICE_LEASE_TTL_MS, DEFAULT_LEASE_TTL_MS),
  };
}

export function createScoutRealtimeVoiceAdmission(
  env: NodeJS.ProcessEnv = process.env,
): ScoutRealtimeVoiceAdmission {
  return new ScoutRealtimeVoiceAdmission({ config: resolveScoutRealtimeVoiceAdmissionConfig(env) });
}

export function validateScoutRealtimeOffer(sdp: string): string {
  const candidate = sdp.trim();
  if (!candidate) {
    throw new ScoutRealtimeVoiceError("WebRTC offer SDP is required.", 400);
  }
  if (new TextEncoder().encode(sdp).byteLength > MAX_SDP_BYTES) {
    throw new ScoutRealtimeVoiceError("WebRTC offer SDP is too large.", 413);
  }
  if (!candidate.startsWith("v=0")) {
    throw new ScoutRealtimeVoiceError("WebRTC offer SDP is invalid.", 400);
  }
  // SDP uses CRLF line endings. In particular, the final CRLF is significant to
  // the Live SDP parser, so validate a trimmed view but proxy the browser's
  // exact payload rather than normalizing it.
  return sdp;
}

export async function readScoutRealtimeOffer(request: Request): Promise<string> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SDP_BYTES) {
    throw new ScoutRealtimeVoiceError("WebRTC offer SDP is too large.", 413);
  }
  if (!request.body) return validateScoutRealtimeOffer("");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_SDP_BYTES) {
        await reader.cancel("SDP offer exceeds the server limit").catch(() => {});
        throw new ScoutRealtimeVoiceError("WebRTC offer SDP is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return validateScoutRealtimeOffer(new TextDecoder().decode(bytes));
}

export type ScoutLiveVoiceCall = {
  /** SDP answer to apply as the peer's remote description. */
  answerSdp: string;
  /** Opaque Live session id, preserved verbatim for sideband and recordings. */
  sessionId: string;
};

export async function createScoutRealtimeVoiceCall(input: {
  offerSdp: string;
  apiKey: string;
  config?: ScoutRealtimeVoiceConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ScoutLiveVoiceCall> {
  const config = input.config ?? resolveScoutRealtimeVoiceConfig();
  // Live is full-duplex: it owns turn-taking and interruption itself, so there
  // is no input VAD or noise-reduction profile to send. Voice and instructions
  // are immutable once the session starts.
  const body = JSON.stringify({
    session: {
      model: config.model,
      audio: { output: { voice: config.voice } },
      instructions: config.instructions,
      // Scout's fleet state is host-local, so the application answers delegated
      // work. A Responses backend would have no way to read it.
      delegation: { type: "client" },
    },
    transport: { type: "webrtc", sdp: input.offerSdp },
  });

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(OPENAI_LIVE_SESSIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new ScoutRealtimeVoiceError("Could not reach OpenAI Live.", 502);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new ScoutRealtimeVoiceError(
      `OpenAI Live could not start the call (${response.status}).`,
      502,
      {
        upstreamStatus: response.status,
        model: config.model,
        ...parseOpenAIErrorDiagnostic(raw),
      },
    );
  }
  return readScoutLiveVoiceCall(raw);
}

/**
 * Live answers with JSON rather than a bare SDP body, so a truncated or
 * reshaped payload has to fail loudly here instead of reaching the browser as
 * an unparseable remote description.
 */
function readScoutLiveVoiceCall(raw: string): ScoutLiveVoiceCall {
  if (!raw.trim()) {
    throw new ScoutRealtimeVoiceError("OpenAI Live returned an empty call answer.", 502);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScoutRealtimeVoiceError("OpenAI Live returned a malformed call answer.", 502);
  }
  if (!parsed || typeof parsed !== "object") throw new ScoutRealtimeVoiceError("OpenAI Live returned a malformed call answer.", 502);
  const payload = parsed as {
    session?: { id?: unknown };
    transport?: { sdp?: unknown; type?: unknown };
  };
  const answerSdp = typeof payload.transport?.sdp === "string" ? payload.transport.sdp : "";
  const sessionId = typeof payload.session?.id === "string" ? payload.session.id : "";
  if (payload.transport?.type !== "webrtc" || !answerSdp.trim() || !sessionId.trim()) {
    throw new ScoutRealtimeVoiceError("OpenAI Live returned a call answer without a WebRTC session.", 502, undefined, sessionId.trim() ? sessionId : undefined);
  }
  return { answerSdp, sessionId };
}

function defaultRealtimeVoiceAdmissionPath(): string {
  return join(dirname(resolveDbPath()), "realtime-voice-admission.sqlite");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function secondsUntil(timestamp: number, now: number): number {
  return Math.max(1, Math.ceil((timestamp - now) / 1_000));
}

function firstNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseOpenAIErrorDiagnostic(body: string): Record<string, string> {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown; type?: unknown };
    };
    const error = parsed.error;
    if (!error || typeof error !== "object") return {};
    return {
      ...(typeof error.type === "string" ? { upstreamType: error.type } : {}),
      ...(typeof error.code === "string" ? { upstreamCode: error.code } : {}),
      ...(typeof error.message === "string" ? { upstreamMessage: error.message } : {}),
    };
  } catch {
    return {};
  }
}
