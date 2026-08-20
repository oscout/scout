import type { Hono } from "hono";

import {
  ensureScoutVoiceOrigins,
  getScoutSpeechCatalog,
  getScoutVoiceHealth,
  resolveScoutSpeechDefaults,
  synthesizeScoutSpeech,
  transcribeScoutVoiceAudio,
  type ScoutSpeechTimingRequest,
} from "../scout-voice.ts";
import {
  ScoutRealtimeVoiceAdmission,
  ScoutRealtimeVoiceAdmissionError,
  ScoutRealtimeVoiceError,
  createScoutRealtimeVoiceAdmission,
  createScoutRealtimeVoiceCall,
  isScoutRealtimeVoiceEnabled,
  readScoutRealtimeOffer,
} from "../realtime-voice.ts";
import {
  SCOUT_REALTIME_VOICE_CALL_PATH,
  SCOUT_REALTIME_VOICE_LEASE_HEADER,
  SCOUT_REALTIME_VOICE_LEASE_PATH,
} from "../../shared/realtime-voice.ts";
import { synthesizeOpenAISpeech } from "../openai-speech.ts";
import { engageScoutVoiceDictation } from "../scout-voice-engage.ts";
import {
  ScoutVoiceSessionError,
  awaitScoutVoiceHostCommand,
  cancelScoutVoiceSession,
  createScoutVoiceSession,
  formatScoutVoiceSessionSse,
  getScoutVoiceSettingsSnapshot,
  isTerminalScoutVoiceSessionEvent,
  listScoutVoiceSessionHistory,
  openScoutVoicePrivacySettings,
  pushScoutVoiceHostEvent,
  registerScoutVoiceHost,
  requestScoutVoicePermissions,
  stopScoutVoiceSession,
  subscribeScoutVoiceSession,
  updateScoutVoiceSettings,
  type ScoutVoiceSessionEventName,
} from "../scout-voice-session.ts";

function parseOptionalPositiveInt(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordInput(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseScoutSpeechTimingRequest(value: unknown): ScoutSpeechTimingRequest | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = recordInput(value);
  if (!record) {
    return null;
  }
  if (record.enabled !== true) {
    return undefined;
  }
  const rawCues = record.cues;
  if (rawCues !== undefined && !Array.isArray(rawCues)) {
    return null;
  }
  const cues = rawCues?.map((rawCue) => {
    const cue = recordInput(rawCue);
    if (!cue) {
      return null;
    }
    const id = optionalString(cue.id)?.trim();
    if (!id) {
      return null;
    }
    const text = optionalString(cue.text);
    if (text !== undefined) {
      return { id, text };
    }
    const textStart = optionalFiniteNumber(cue.textStart);
    const textEnd = optionalFiniteNumber(cue.textEnd);
    if (textStart === undefined || textEnd === undefined || textEnd < textStart) {
      return null;
    }
    return { id, textStart, textEnd };
  });
  if (cues?.some((cue) => cue === null)) {
    return null;
  }
  const modelId = optionalString(record.modelId)?.trim();
  return {
    enabled: true,
    ...(modelId ? { modelId } : {}),
    ...(typeof record.strict === "boolean" ? { strict: record.strict } : {}),
    ...(cues ? { cues: cues as NonNullable<ScoutSpeechTimingRequest["cues"]> } : {}),
  };
}

function jsonScoutVoiceSessionError(error: unknown): Response {
  if (error instanceof ScoutVoiceSessionError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Scout voice session failed";
  return Response.json({ error: message }, { status: 500 });
}

function parseScoutVoiceAudioFormat(value: string | undefined): "mp3" | "wav" | "aac" | "opus" | "pcm16" | null | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  switch (normalized) {
    case "mp3":
    case "wav":
    case "aac":
    case "opus":
    case "pcm16":
      return normalized;
    default:
      return null;
  }
}

export type ScoutVoiceRouteDeps = {
  resolveOpenAIApiKey?: () => Promise<string | undefined>;
  realtimeVoiceEnabled?: () => boolean;
  realtimeVoiceAdmission?: ScoutRealtimeVoiceAdmission;
  createRealtimeVoiceCall?: typeof createScoutRealtimeVoiceCall;
};

export function mountScoutVoiceRoutes(app: Hono, deps: ScoutVoiceRouteDeps = {}): void {
  let defaultRealtimeVoiceAdmission: ScoutRealtimeVoiceAdmission | null = null;
  const realtimeVoiceEnabled = deps.realtimeVoiceEnabled ?? (() => isScoutRealtimeVoiceEnabled());
  const realtimeVoiceAdmission = () => deps.realtimeVoiceAdmission
    ?? (defaultRealtimeVoiceAdmission ??= createScoutRealtimeVoiceAdmission());
  ensureScoutVoiceOrigins();

  app.get("/api/voice/health", async (c) => {
    const health = await getScoutVoiceHealth();
    const quietProbe = c.req.query("quiet") === "1";
    return c.json(health, health.ok || quietProbe ? 200 : 503);
  });

  app.get("/api/voice/settings", (c) => {
    return c.json(getScoutVoiceSettingsSnapshot());
  });

  app.get("/api/voice/catalog", async (c) => {
    const directOpenAIAvailable = Boolean(
      await deps.resolveOpenAIApiKey?.().catch(() => undefined)
        ?? process.env.OPENAI_API_KEY?.trim(),
    );
    return c.json(await getScoutSpeechCatalog({
      modelId: c.req.query("modelId"),
      signal: c.req.raw.signal,
      directOpenAIAvailable,
    }));
  });

  app.post("/api/voice/engage", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      surface?: string;
      requestPermissions?: boolean;
    };
    try {
      return c.json(engageScoutVoiceDictation(body));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.get("/api/voice/history", (c) => {
    const limit = parseOptionalPositiveInt(c.req.query("limit"), 20) ?? 20;
    return c.json({ sessions: listScoutVoiceSessionHistory(limit) });
  });

  app.put("/api/voice/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      preference?: "auto" | "parakeet" | "apple";
      inputDeviceId?: string | null;
    };
    try {
      return c.json(updateScoutVoiceSettings(body));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/permissions/open", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: "microphone" | "speechRecognition";
    };
    try {
      return c.json(openScoutVoicePrivacySettings(body.kind ?? "microphone"));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/permissions/request", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: "microphone" | "speechRecognition";
    };
    try {
      return c.json(requestScoutVoicePermissions(body.kind ?? "microphone"));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/host/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      hostId?: string;
      instanceId?: string;
      platform?: string;
      bundle?: string;
      settings?: {
        preference?: "auto" | "parakeet" | "apple";
        inputDeviceId?: string | null;
        inputDeviceName?: string | null;
        modelReady?: boolean;
        modelInstalled?: boolean;
        permissions?: Array<{
          kind?: "microphone" | "speechRecognition";
          status?: string;
          granted?: boolean;
          canRequest?: boolean;
        }>;
      };
      devices?: Array<{ id?: string; name?: string; isDefault?: boolean }>;
    };
    try {
      return c.json(registerScoutVoiceHost({
        hostId: body.hostId ?? "",
        instanceId: body.instanceId,
        platform: body.platform ?? "unknown",
        bundle: body.bundle,
        settings: body.settings,
        devices: (body.devices ?? [])
          .map((device) => ({
            id: device.id?.trim() ?? "",
            name: device.name?.trim() ?? "Microphone",
            isDefault: Boolean(device.isDefault),
          }))
          .filter((device) => device.id.length > 0),
      }));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.get("/api/voice/host/commands", async (c) => {
    const hostId = c.req.query("hostId")?.trim();
    if (!hostId) {
      return c.json({ error: "hostId is required" }, 400);
    }
    const timeoutMs = parseOptionalPositiveInt(c.req.query("timeoutMs"), 25_000) ?? 25_000;
    const instanceId = c.req.query("instanceId")?.trim();
    try {
      return c.json(await awaitScoutVoiceHostCommand(hostId, timeoutMs, instanceId, c.req.raw.signal));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/host/events", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      hostId?: string;
      instanceId?: string;
      sessionId?: string;
      event?: string;
      data?: Record<string, unknown>;
    };
    const hostId = body.hostId?.trim();
    const sessionId = body.sessionId?.trim();
    const event = body.event?.trim() as ScoutVoiceSessionEventName | undefined;
    if (!hostId || !sessionId || !event) {
      return c.json({ error: "hostId, sessionId, and event are required" }, 400);
    }
    try {
      return c.json(pushScoutVoiceHostEvent({
        hostId,
        instanceId: body.instanceId,
        sessionId,
        event,
        data: body.data,
      }));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      clientId?: string;
      surface?: string;
      language?: string;
      sessionId?: string;
    };
    try {
      return c.json(createScoutVoiceSession(body));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.get("/api/voice/session/:sessionId/events", (c) => {
    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;

    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          const safeEnqueue = (chunk: Uint8Array) => {
            if (closed) return;
            try {
              controller.enqueue(chunk);
            } catch {
              closed = true;
            }
          };

          let heartbeat: ReturnType<typeof setInterval> | null = null;
          let unsubscribe = () => undefined;

          const close = () => {
            if (closed) return;
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            unsubscribe();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };

          heartbeat = setInterval(() => {
            safeEnqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
          }, 15_000);

          unsubscribe = subscribeScoutVoiceSession(sessionId, (event) => {
            safeEnqueue(encoder.encode(formatScoutVoiceSessionSse(event)));
            if (isTerminalScoutVoiceSessionEvent(event)) {
              close();
            }
          });

          signal.addEventListener("abort", close, { once: true });
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/session/:sessionId/stop", (c) => {
    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    try {
      stopScoutVoiceSession(sessionId);
      return c.json({ ok: true, sessionId });
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/session/:sessionId/cancel", (c) => {
    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    try {
      cancelScoutVoiceSession(sessionId);
      return c.json({ ok: true, sessionId });
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post("/api/voice/transcribe", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const audio = form?.get("audio");
    if (!(audio instanceof Blob)) {
      return c.json({ error: "audio file is required" }, 400);
    }
    const format = parseScoutVoiceAudioFormat(optionalString(form?.get("format")));
    if (format === null) {
      return c.json({ error: "audio format is invalid" }, 400);
    }

    try {
      return c.json(await transcribeScoutVoiceAudio({
        audio,
        ...(format ? { format } : {}),
        language: optionalString(form?.get("language")),
        modelId: optionalString(form?.get("modelId")),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scout voice transcription failed";
      return c.json({ error: message }, 503);
    }
  });

  app.post("/api/voice/speak", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      modelId?: string;
      voiceId?: string;
      speed?: number;
      instructions?: string;
      originAppId?: string;
      utteranceId?: string;
      speechTiming?: unknown;
    };
    const text = body.text?.trim();
    if (!text) {
      return c.json({ error: "text is required" }, 400);
    }
    const speechTiming = parseScoutSpeechTimingRequest(body.speechTiming);
    if (speechTiming === null) {
      return c.json({ error: "speechTiming is invalid" }, 400);
    }

    try {
      return c.json(await synthesizeScoutSpeech({
        text,
        modelId: body.modelId,
        voiceId: body.voiceId,
        speed: body.speed,
        instructions: optionalString(body.instructions),
        originAppId: optionalString(body.originAppId),
        utteranceId: optionalString(body.utteranceId),
        speechTiming,
        signal: c.req.raw.signal,
      }));
    } catch (error) {
      // Vox is a separate app; when its daemon is down every request here
      // fails and callers drop to the on-device system voice. Reach OpenAI
      // with the key Scout already holds instead — a chosen voice shouldn't
      // silently become the robot one because another process isn't running.
      const apiKey = await deps.resolveOpenAIApiKey?.().catch(() => undefined)
        ?? process.env.OPENAI_API_KEY?.trim();
      if (apiKey && !c.req.raw.signal.aborted) {
        const defaults = resolveScoutSpeechDefaults();
        try {
          return c.json({
            ...await synthesizeOpenAISpeech({
              text,
              apiKey,
              modelId: body.modelId ?? defaults.modelId,
              voiceId: body.voiceId ?? defaults.voiceId,
              speed: body.speed,
              instructions: optionalString(body.instructions),
              signal: c.req.raw.signal,
            }),
            // Named so a caller can tell a direct call from a Vox one and
            // report it honestly rather than claiming the configured route.
            route: "openai-direct",
          });
        } catch (fallbackError) {
          console.warn("[voice-speak] openai_fallback_failed", {
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
      const message = error instanceof Error ? error.message : "Voice speech failed";
      return c.json({ error: message }, 503);
    }
  });

  app.post(SCOUT_REALTIME_VOICE_CALL_PATH, async (c) => {
    c.header("cache-control", "no-store");
    // The browser flag controls discoverability only. The billable server path
    // is independently closed unless the operator enables it on this host.
    if (!realtimeVoiceEnabled()) {
      return c.json({
        error: "Realtime voice is disabled on this Scout host. Set OPENSCOUT_REALTIME_VOICE_ENABLED=1 and restart the web server to enable it.",
      }, 404);
    }
    let leaseId: string | null = null;
    try {
      const offerSdp = await readScoutRealtimeOffer(c.req.raw);
      const apiKey = await deps.resolveOpenAIApiKey?.() ?? process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        return c.json({ error: "OpenAI API key is required to start a realtime voice call." }, 503);
      }
      const lease = realtimeVoiceAdmission().admit();
      leaseId = lease.id;
      const answerSdp = await (deps.createRealtimeVoiceCall ?? createScoutRealtimeVoiceCall)({
        offerSdp,
        apiKey,
        signal: c.req.raw.signal,
      });
      return new Response(answerSdp, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/sdp",
          [SCOUT_REALTIME_VOICE_LEASE_HEADER]: lease.id,
        },
      });
    } catch (error) {
      if (leaseId) realtimeVoiceAdmission().release(leaseId);
      const status = error instanceof ScoutRealtimeVoiceError ? error.status : 502;
      const message = error instanceof ScoutRealtimeVoiceError
        ? error.message
        : "Realtime voice admission is temporarily unavailable. Try again shortly.";
      if (error instanceof ScoutRealtimeVoiceAdmissionError) {
        c.header("retry-after", String(error.retryAfterSeconds));
      } else if (status >= 500 && !c.req.raw.signal.aborted) {
        console.warn("[voice-realtime] call_failed", {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof ScoutRealtimeVoiceError && error.diagnostic ? error.diagnostic : {}),
        });
      }
      return c.json({ error: message }, status as 400 | 413 | 429 | 502);
    }
  });

  app.put(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/:leaseId`, (c) => {
    c.header("cache-control", "no-store");
    if (!realtimeVoiceEnabled()) {
      return c.json({ error: "Realtime voice is disabled on this Scout host." }, 404);
    }
    const leaseId = validRealtimeVoiceLeaseId(c.req.param("leaseId"));
    if (!leaseId) return c.json({ error: "Realtime voice lease id is invalid." }, 400);
    const lease = realtimeVoiceAdmission().heartbeat(leaseId);
    if (!lease) {
      return c.json({ error: "Realtime voice lease expired. End the call and reconnect." }, 404);
    }
    return c.json({ expiresAt: lease.expiresAt });
  });

  app.delete(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/:leaseId`, (c) => {
    c.header("cache-control", "no-store");
    if (!realtimeVoiceEnabled()) {
      return c.json({ error: "Realtime voice is disabled on this Scout host." }, 404);
    }
    const leaseId = validRealtimeVoiceLeaseId(c.req.param("leaseId"));
    if (!leaseId) return c.json({ error: "Realtime voice lease id is invalid." }, 400);
    realtimeVoiceAdmission().release(leaseId);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });

  app.get("/api/voice/defaults", (c) => {
    return c.json(resolveScoutSpeechDefaults());
  });

}

function validRealtimeVoiceLeaseId(value: string): string | null {
  const candidate = value.trim();
  return /^[a-zA-Z0-9_-]{8,128}$/.test(candidate) ? candidate : null;
}
