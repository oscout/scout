import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { SCOUT_REALTIME_VOICE_FAR_FIELD_INPUT } from "../shared/realtime-voice.ts";
import { resolveDbPath } from "./db/internal/db.ts";

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
const DEFAULT_REALTIME_VOICE = "marin";
const MAX_SDP_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_CALLS = 1;
const DEFAULT_STARTS_PER_MINUTE = 4;
const DEFAULT_LEASE_TTL_MS = 90_000;
const RATE_WINDOW_MS = 60_000;
const ADMISSION_DB_BUSY_TIMEOUT_MS = 2_000;

const SCOUT_REALTIME_INSTRUCTIONS = [
  "You are Scoutbot Voice, the spoken front end for OpenScout's in-app control-plane assistant.",
  "Keep turns concise, practical, conversational, and suitable for audio.",
  "For any question about the operator's fleet, agents, projects, workspace, current work, coordination, navigation, or what to do next, call ask_scoutbot with the operator's full request before answering.",
  "Treat the ask_scoutbot result as the source of truth for live Scout state. Never invent fleet state or claim a Scout action completed unless the result says so.",
  "The result can include an OpenScout UI action that the app applies locally. When the operator explicitly asks Scoutbot to coordinate with an agent, Scoutbot sends that request automatically and reports whether delivery succeeded. Never claim the requested work itself is complete unless the result says so.",
  "Do not read JSON, fence markup, or implementation details aloud.",
  "You may handle a simple greeting directly, but use ask_scoutbot whenever the operator asks for work or live context.",
].join(" ");

const SCOUTBOT_REALTIME_TOOL = {
  type: "function",
  name: "ask_scoutbot",
  description: "Ask the live Scoutbot control-plane assistant about the current OpenScout fleet, agents, workspace, coordination, navigation, or next action. Use this for any request that needs live Scout context or should affect the OpenScout UI.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "The operator's complete request, preserving relevant agent names, project names, and requested action.",
      },
    },
    required: ["request"],
    additionalProperties: false,
  },
};

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

  activeLeaseCount(): number {
    const now = this.now();
    const row = this.database.query(
      "SELECT COUNT(*) AS count FROM realtime_voice_leases WHERE expires_at > ?1",
    ).get(now) as { count: number };
    return row.count;
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
    instructions: firstNonEmptyString(env.OPENSCOUT_REALTIME_INSTRUCTIONS) ?? SCOUT_REALTIME_INSTRUCTIONS,
  };
}

export function isScoutRealtimeVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.OPENSCOUT_REALTIME_VOICE_ENABLED?.trim() ?? "");
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
  // the Realtime SDP parser, so validate a trimmed view but proxy the browser's
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

export async function createScoutRealtimeVoiceCall(input: {
  offerSdp: string;
  apiKey: string;
  config?: ScoutRealtimeVoiceConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const config = input.config ?? resolveScoutRealtimeVoiceConfig();
  const session = JSON.stringify({
    type: "realtime",
    model: config.model,
    audio: {
      input: SCOUT_REALTIME_VOICE_FAR_FIELD_INPUT,
      output: { voice: config.voice },
    },
    instructions: config.instructions,
    tools: [SCOUTBOT_REALTIME_TOOL],
    tool_choice: "auto",
  });
  const form = new FormData();
  form.set("sdp", input.offerSdp);
  form.set("session", session);

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(OPENAI_REALTIME_CALLS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new ScoutRealtimeVoiceError("Could not reach OpenAI Realtime.", 502);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new ScoutRealtimeVoiceError(
      `OpenAI Realtime could not start the call (${response.status}).`,
      502,
      {
        upstreamStatus: response.status,
        model: config.model,
        ...parseOpenAIErrorDiagnostic(body),
      },
    );
  }
  if (!body.trim()) {
    throw new ScoutRealtimeVoiceError("OpenAI Realtime returned an empty call answer.", 502);
  }
  return body;
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
