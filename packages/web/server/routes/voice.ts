import { finalizeLiveSession } from "../live-finalization.ts";
import type { Hono } from "hono";

import {
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
  readScoutRealtimeOffer,
  resolveScoutRealtimeVoiceSettings,
} from "../realtime-voice.ts";
import {
  SCOUT_REALTIME_VOICE_CALL_PATH,
  SCOUT_REALTIME_VOICE_LEASE_HEADER,
  SCOUT_REALTIME_VOICE_LEASE_PATH,
  SCOUT_REALTIME_VOICE_SETTINGS_PATH,
  type ScoutRealtimeVoiceSettings,
} from "../../shared/realtime-voice.ts";
import {
  SCOUT_VOICE_PLAYBACK_DEFAULT,
  SCOUT_VOICE_PLAYBACK_ENV,
  SCOUT_VOICE_PLAYBACK_SETTINGS_PATH,
  parseScoutVoicePlayback,
  type ScoutVoicePlayback,
  type ScoutVoicePlaybackSettings,
} from "../../shared/voice-playback.ts";
import { resolveScoutVoicePlaybackSettings } from "../voice-playback.ts";
import {
  isNvidiaMagpieSpeechModel,
  resolveNvidiaApiKey,
  synthesizeNvidiaMagpieSpeech,
} from "../nvidia-speech.ts";
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
  parseScoutVoiceSettingsPatch,
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
  /** Legacy/test override. Production uses the persisted preference callbacks. */
  realtimeVoiceEnabled?: () => boolean;
  readRealtimeVoiceEnabled?: () => Promise<boolean>;
  writeRealtimeVoiceEnabled?: (enabled: boolean) => Promise<boolean>;
  realtimeVoiceEnvironment?: NodeJS.ProcessEnv;
  realtimeVoiceAdmission?: ScoutRealtimeVoiceAdmission;
  createRealtimeVoiceCall?: typeof createScoutRealtimeVoiceCall;
  finalizeLiveSession?: typeof finalizeLiveSession;
  /** Persisted "spoken on host" preference; a request may still override it. */
  readVoicePlayback?: () => Promise<ScoutVoicePlayback>;
  writeVoicePlayback?: (playback: ScoutVoicePlayback) => Promise<ScoutVoicePlayback>;
  voiceEnvironment?: NodeJS.ProcessEnv;
};

export function mountScoutVoiceRoutes(app: Hono, deps: ScoutVoiceRouteDeps = {}): () => void {
  let defaultRealtimeVoiceAdmission: ScoutRealtimeVoiceAdmission | null = null;
  const realtimeVoiceAdmission = () => deps.realtimeVoiceAdmission
    ?? (defaultRealtimeVoiceAdmission ??= createScoutRealtimeVoiceAdmission());
  const closing = new Map<string, Promise<void>>();
  const closeLease = (leaseId: string): Promise<void> => {
    const existing = closing.get(leaseId); if (existing) return existing;
    const work = (async () => {
      const admission = realtimeVoiceAdmission();
      admission.release(leaseId);
      const reserved = admission.reserveFinalization(leaseId);
      if (!reserved) return;
      let result: Awaited<ReturnType<typeof finalizeLiveSession>>;
      try {
        let credentialTimer: ReturnType<typeof setTimeout> | undefined;
        let apiKey: string | undefined;
        try {
          apiKey = await Promise.race([
            Promise.resolve().then(() => deps.resolveOpenAIApiKey?.()).then(key => key ?? process.env.OPENAI_API_KEY?.trim()),
            new Promise<never>((_, reject) => { credentialTimer = setTimeout(() => reject(new Error("credential_timeout")), 5000); }),
          ]);
        } finally { clearTimeout(credentialTimer); }
        result = apiKey ? await (deps.finalizeLiveSession ?? finalizeLiveSession)(reserved.sessionId, apiKey)
          : { state: "unconfirmed", reason: "credential_unavailable" };
      } catch {
        // Reserve before credentials/network; exceptions consume the same
        // bounded budget, without persisting credential/provider diagnostics.
        result = { state: "unconfirmed", reason: "cleanup_exception" };
      }
      admission.recordFinalization(leaseId, result, reserved.attempt);

    })().finally(() => closing.delete(leaseId));
    closing.set(leaseId, work); return work;
  };
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const startCleanup = () => {
    if (cleanupTimer) return;
    const cleanup = () => {
      const pending = realtimeVoiceAdmission().sessionsNeedingCleanup();
      for (const session of pending) {
        void closeLease(session.leaseId).catch(() => console.warn("[voice-live] cleanup_unconfirmed", { leaseId: session.leaseId }));
      }
      if (!realtimeVoiceAdmission().hasPendingFinalization() && !closing.size && realtimeVoiceAdmission().activeLeaseCount() === 0 && cleanupTimer) {
        clearInterval(cleanupTimer); cleanupTimer = undefined;
      }
    };
    cleanup(); cleanupTimer = setInterval(cleanup, 10000); cleanupTimer.unref();
  };
  const realtimeVoiceSettings = async (): Promise<ScoutRealtimeVoiceSettings> => {
    if (deps.realtimeVoiceEnabled) {
      const enabled = deps.realtimeVoiceEnabled();
      return {
        enabled,
        configuredEnabled: enabled,
        source: "environment",
        locked: true,
      };
    }
    const configuredEnabled = await deps.readRealtimeVoiceEnabled?.() ?? false;
    return resolveScoutRealtimeVoiceSettings(
      configuredEnabled,
      deps.realtimeVoiceEnvironment ?? process.env,
    );
  };
  const voiceEnvironment = () => deps.voiceEnvironment ?? deps.realtimeVoiceEnvironment ?? process.env;
  const voicePlaybackSettings = async (): Promise<ScoutVoicePlaybackSettings> => {
    const configuredPlayback = await deps.readVoicePlayback?.() ?? SCOUT_VOICE_PLAYBACK_DEFAULT;
    return resolveScoutVoicePlaybackSettings(configuredPlayback, voiceEnvironment());
  };
  app.get("/api/voice/health", async (c) => {
    const health = await getScoutVoiceHealth();
    const quietProbe = c.req.query("quiet") === "1";
    return c.json(health, health.ok || quietProbe ? 200 : 503);
  });

  app.get("/api/voice/settings", (c) => {
    return c.json(getScoutVoiceSettingsSnapshot());
  });

  app.get(SCOUT_REALTIME_VOICE_SETTINGS_PATH, async (c) => {
    c.header("cache-control", "no-store");
    try {
      return c.json(await realtimeVoiceSettings());
    } catch (error) {
      console.warn("[voice-realtime] settings_read_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Live voice settings are temporarily unavailable." }, 503);
    }
  });

  app.put(SCOUT_REALTIME_VOICE_SETTINGS_PATH, async (c) => {
    c.header("cache-control", "no-store");
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    try {
      const current = await realtimeVoiceSettings();
      if (current.locked) {
        return c.json({
          error: "Live voice is controlled by OPENSCOUT_REALTIME_VOICE_ENABLED on this host.",
        }, 409);
      }
      if (!deps.writeRealtimeVoiceEnabled) {
        return c.json({ error: "Live voice settings cannot be changed on this host." }, 503);
      }
      const configuredEnabled = await deps.writeRealtimeVoiceEnabled(body.enabled);
      const next = resolveScoutRealtimeVoiceSettings(
        configuredEnabled,
        deps.realtimeVoiceEnvironment ?? process.env,
      );
      if (!next.enabled) {
        realtimeVoiceAdmission().releaseAll();
        await Promise.all(realtimeVoiceAdmission().sessionsNeedingCleanup().map(session => closeLease(session.leaseId)));
      }
      return c.json(next);
    } catch (error) {
      console.warn("[voice-realtime] settings_write_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Live voice settings could not be saved." }, 500);
    }
  });

  app.get(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH, async (c) => {
    c.header("cache-control", "no-store");
    try {
      return c.json(await voicePlaybackSettings());
    } catch (error) {
      console.warn("[voice-playback] settings_read_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Voice playback settings are temporarily unavailable." }, 503);
    }
  });

  app.put(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH, async (c) => {
    c.header("cache-control", "no-store");
    const body = (await c.req.json().catch(() => null)) as { playback?: unknown } | null;
    const playback = parseScoutVoicePlayback(body?.playback);
    if (!playback) {
      return c.json({ error: "playback must be \"browser\" or \"host\"" }, 400);
    }
    try {
      const current = await voicePlaybackSettings();
      if (current.locked) {
        return c.json({
          error: `Voice playback is controlled by ${SCOUT_VOICE_PLAYBACK_ENV} on this host.`,
        }, 409);
      }
      if (!deps.writeVoicePlayback) {
        return c.json({ error: "Voice playback settings cannot be changed on this host." }, 503);
      }
      const configuredPlayback = await deps.writeVoicePlayback(playback);
      return c.json(resolveScoutVoicePlaybackSettings(configuredPlayback, voiceEnvironment()));
    } catch (error) {
      console.warn("[voice-playback] settings_write_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Voice playback settings could not be saved." }, 500);
    }
  });

  app.get("/api/voice/catalog", async (c) => {
    return c.json(await getScoutSpeechCatalog({
      modelId: c.req.query("modelId"),
      signal: c.req.raw.signal,
      directNvidiaApiKey: resolveNvidiaApiKey(),
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
      settings?: unknown;
      devices?: Array<{ id?: string; name?: string; isDefault?: boolean }>;
    };
    try {
      return c.json(registerScoutVoiceHost({
        hostId: body.hostId ?? "",
        instanceId: body.instanceId,
        platform: body.platform ?? "unknown",
        bundle: body.bundle,
        settings: parseScoutVoiceSettingsPatch(body.settings),
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
          let unsubscribe: () => void = () => undefined;

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
      return jsonScoutVoiceSessionError(error);
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
      playback?: unknown;
    };
    const text = body.text?.trim();
    if (!text) {
      return c.json({ error: "text is required" }, 400);
    }
    const speechTiming = parseScoutSpeechTimingRequest(body.speechTiming);
    if (speechTiming === null) {
      return c.json({ error: "speechTiming is invalid" }, 400);
    }
    // A request may name where it is heard (an agent or surface asking for
    // the Mac's speaker); otherwise the operator's persisted setting decides.
    let playback: ScoutVoicePlayback;
    if (body.playback !== undefined) {
      const requested = parseScoutVoicePlayback(body.playback);
      if (!requested) {
        return c.json({ error: "playback must be \"browser\" or \"host\"" }, 400);
      }
      playback = requested;
    } else {
      try {
        playback = (await voicePlaybackSettings()).playback;
      } catch {
        playback = SCOUT_VOICE_PLAYBACK_DEFAULT;
      }
    }

    const defaults = resolveScoutSpeechDefaults();
    const requestedModelId = body.modelId ?? defaults.modelId;
    // Hosted Magpie is the one direct cloud route the web server keeps, and
    // only when this deployment lends `NV_API_KEY`. It adds no local process.
    // Without that key the request goes to Scout Menu like every other model.
    // Spoken-on-host requests always go to the Mac: bytes are useless there.
    const nvidiaApiKey = playback === "browser" && isNvidiaMagpieSpeechModel(requestedModelId)
      ? resolveNvidiaApiKey()
      : undefined;
    if (nvidiaApiKey) {
      try {
        return c.json({
          ...await synthesizeNvidiaMagpieSpeech({
            text,
            apiKey: nvidiaApiKey,
            voiceId: body.voiceId,
            signal: c.req.raw.signal,
          }),
          route: "nvidia-developer-inference",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "NVIDIA Magpie speech failed";
        return c.json({ error: message }, 503);
      }
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
        playback,
        signal: c.req.raw.signal,
      }));
    } catch (error) {
      return jsonScoutVoiceSessionError(error);
    }
  });

  app.post(SCOUT_REALTIME_VOICE_CALL_PATH, async (c) => {
    c.header("cache-control", "no-store");
    let leaseId: string | null = null;
    try {
      const settings = await realtimeVoiceSettings();
      if (!settings.enabled) {
        return c.json({
          error: "Live voice is off. Turn it on in Settings → Voice before starting a call.",
        }, 409);
      }
      const offerSdp = await readScoutRealtimeOffer(c.req.raw);
      const apiKey = await deps.resolveOpenAIApiKey?.() ?? process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        return c.json({ error: "OpenAI API key is required to start a realtime voice call." }, 503);
      }
      startCleanup();
      const lease = realtimeVoiceAdmission().admit();
      leaseId = lease.id;
      const call = await (deps.createRealtimeVoiceCall ?? createScoutRealtimeVoiceCall)({
        offerSdp,
        apiKey,
        signal: AbortSignal.timeout(15000),
      });
      // Keep ownership even if the browser vanished after provider creation.
      realtimeVoiceAdmission().bindSession(lease.id, call.sessionId);
      if (c.req.raw.signal.aborted || !(await realtimeVoiceSettings()).enabled) {
        await closeLease(lease.id);
        throw new ScoutRealtimeVoiceError("Live call setup was cancelled.", 409);
      }
      return new Response(call.answerSdp, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/sdp",
          [SCOUT_REALTIME_VOICE_LEASE_HEADER]: lease.id,
          "x-openscout-live-session-id": call.sessionId,
        },
      });
    } catch (error) {
      if (leaseId) {
        if (error instanceof ScoutRealtimeVoiceError && error.providerSessionId && !realtimeVoiceAdmission().sessionForLease(leaseId)) {
          realtimeVoiceAdmission().bindSession(leaseId, error.providerSessionId);
        }
        await closeLease(leaseId);
      }
      const status = error instanceof ScoutRealtimeVoiceError ? error.status : 502;
      const message = error instanceof ScoutRealtimeVoiceError
        ? error.message
        : "Live voice setup is temporarily unavailable. Try again shortly.";
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

  app.put(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/:leaseId`, async (c) => {
    c.header("cache-control", "no-store");
    if (!(await realtimeVoiceSettings()).enabled) {
      return c.json({ error: "Live voice is off on this Scout host." }, 404);
    }
    const leaseId = validRealtimeVoiceLeaseId(c.req.param("leaseId"));
    if (!leaseId) return c.json({ error: "Realtime voice lease id is invalid." }, 400);
    const lease = realtimeVoiceAdmission().heartbeat(leaseId);
    if (!lease) {
      return c.json({ error: "Realtime voice lease expired. End the call and reconnect." }, 404);
    }
    return c.json({ expiresAt: lease.expiresAt });
  });

  app.delete(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/:leaseId`, async (c) => {
    c.header("cache-control", "no-store");
    // Disabling new calls must never disable cleanup of an existing one.
    const leaseId = validRealtimeVoiceLeaseId(c.req.param("leaseId"));
    if (!leaseId) return c.json({ error: "Realtime voice lease id is invalid." }, 400);
    const report = await c.req.json().catch(() => null);
    if (report && (report.state === "confirmed" || report.state === "unconfirmed")) {
      realtimeVoiceAdmission().recordClientFinalization(leaseId, {
        state: report.state, reason: typeof report.reason === "string" ? report.reason.slice(0, 100) : undefined,
        seconds: typeof report.seconds === "number" && Number.isFinite(report.seconds) && report.seconds >= 0 ? report.seconds : undefined,
      });
    }
    await closeLease(leaseId);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });

  app.get("/api/voice/defaults", (c) => {
    return c.json(resolveScoutSpeechDefaults());
  });

  return () => { if (cleanupTimer) clearInterval(cleanupTimer); cleanupTimer = undefined; };
}

function validRealtimeVoiceLeaseId(value: string): string | null {
  const candidate = value.trim();
  return /^[a-zA-Z0-9_-]{8,128}$/.test(candidate) ? candidate : null;
}
