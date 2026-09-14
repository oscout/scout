export type ScoutVoiceSessionEventName =
  | "session.started"
  | "session.state"
  | "session.partial"
  | "session.final"
  | "session.error"
  | "session.cancelled"
  | "speech.started"
  | "speech.result"
  | "speech.error";

export type ScoutVoiceSessionEvent = {
  event: ScoutVoiceSessionEventName;
  sessionId: string;
  data: Record<string, unknown>;
  ts: number;
};

export type ScoutVoicePreference = "auto" | "parakeet" | "apple";

export type ScoutVoiceInputDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type ScoutVoicePermissionStatus = {
  kind: "microphone" | "speechRecognition";
  status: string;
  granted: boolean;
  canRequest: boolean;
};

export type ScoutVoiceSettings = {
  preference: ScoutVoicePreference;
  inputDeviceId: string | null;
  inputDeviceName: string | null;
  modelReady?: boolean;
  modelInstalled?: boolean;
  permissions?: ScoutVoicePermissionStatus[];
};

export type ScoutVoiceSpeechTimingCueRequest = {
  id: string;
  textStart?: number;
  textEnd?: number;
  text?: string;
};

export type ScoutVoiceSpeechTimingRequest = {
  enabled: true;
  modelId?: string;
  strict?: boolean;
  cues?: ScoutVoiceSpeechTimingCueRequest[];
};

/** Where the requesting surface wants a `speech.synthesize` heard. */
export type ScoutVoiceSpeechPlayback = "browser" | "host";

export type ScoutVoiceHostCommand =
  | {
    type: "session.start";
    sessionId: string;
    clientId: string;
    surface: string;
    language?: string;
    inputDeviceId?: string | null;
    inputDeviceName?: string | null;
  }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string }
  | {
    type: "speech.synthesize";
    sessionId: string;
    text: string;
    /**
     * Omitted only for host playback, where Scout Menu's own Settings › Voice
     * choice is the default. Browser playback always names the model.
     */
    modelId?: string;
    voiceId?: string;
    speed?: number;
    instructions?: string;
    originAppId?: string;
    utteranceId?: string;
    speechTiming?: ScoutVoiceSpeechTimingRequest;
    /** Defaults to `browser` for hosts that predate the field. */
    playback?: ScoutVoiceSpeechPlayback;
  }
  | { type: "speech.cancel"; sessionId: string }
  | {
    type: "settings.apply";
    preference?: ScoutVoicePreference;
    inputDeviceId?: string | null;
  }
  | { type: "permissions.open"; kind: "microphone" | "speechRecognition" }
  | { type: "permissions.request"; kind: "microphone" | "speechRecognition" };

export type ScoutVoiceCaptureMode = "native" | "browser";

export type ScoutVoiceHealthSnapshot = {
  ok: boolean;
  service: "scout-voice";
  adapter: "hudson-dictation";
  capture: ScoutVoiceCaptureMode;
  detail: string | null;
  microphoneGranted?: boolean;
  microphoneCanRequest?: boolean;
  inputDevice: { id: string; name: string } | null;
  host?: {
    hostId: string;
    platform: string;
    lastSeenAt: number;
  } | null;
};

type SessionStatus = "pending" | "active" | "processing" | "done" | "cancelled" | "error";

type VoiceSession = {
  id: string;
  kind: "dictation" | "speech";
  clientId: string;
  surface: string;
  language: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  assignedHostId: string | null;
  events: ScoutVoiceSessionEvent[];
  error: string | null;
};

type VoiceHost = {
  hostId: string;
  instanceId: string | null;
  platform: string;
  bundle: string | null;
  registeredAt: number;
  lastSeenAt: number;
  activePollId: number | null;
  pendingCommands: ScoutVoiceHostCommand[];
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
};

type SessionSubscriber = (event: ScoutVoiceSessionEvent) => void;

type VoiceHostCommandWaiter = {
  pollId: number;
  instanceId: string | null;
  finish: (command: ScoutVoiceHostCommand | null) => void;
};

const HOST_STALE_MS = 45_000;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_EVENTS_PER_SESSION = 200;
const SPEECH_TIMEOUT_MS = 90_000;
/**
 * Host playback resolves when the Mac finishes speaking, so the budget grows
 * with the text instead of assuming a render-and-return round trip.
 */
const HOST_PLAYBACK_MS_PER_CHARACTER = 100;

const sessions = new Map<string, VoiceSession>();
const hosts = new Map<string, VoiceHost>();
const sessionSubscribers = new Map<string, Set<SessionSubscriber>>();
const hostCommandWaiters = new Map<string, VoiceHostCommandWaiter>();
let nextHostPollId = 1;

const DEFAULT_VOICE_SETTINGS: ScoutVoiceSettings = {
  preference: "auto",
  inputDeviceId: null,
  inputDeviceName: null,
};

export function resetScoutVoiceSessionStateForTests(): void {
  for (const waiter of [...hostCommandWaiters.values()]) {
    waiter.finish(null);
  }
  hostCommandWaiters.clear();
  sessions.clear();
  hosts.clear();
  sessionSubscribers.clear();
  nextHostPollId = 1;
}

export function registerScoutVoiceHost(input: {
  hostId: string;
  instanceId?: string;
  platform: string;
  bundle?: string;
  settings?: Partial<ScoutVoiceSettings>;
  devices?: ScoutVoiceInputDevice[];
}): { ok: true; hostId: string; pollMs: number } {
  const hostId = input.hostId.trim();
  if (!hostId) {
    throw new ScoutVoiceSessionError("host_id_required", "hostId is required.", 400);
  }

  const now = Date.now();
  const previous = hosts.get(hostId);
  const instanceId = input.instanceId?.trim() || null;
  if (previous && previous.instanceId !== instanceId) {
    finishScoutVoiceHostCommandWaiter(hostId, null);
  }
  const settings = mergeVoiceSettings(previous?.settings ?? DEFAULT_VOICE_SETTINGS, input.settings);
  hosts.set(hostId, {
    hostId,
    instanceId,
    platform: input.platform.trim() || "unknown",
    bundle: input.bundle?.trim() || null,
    registeredAt: previous?.registeredAt ?? now,
    lastSeenAt: now,
    activePollId: previous?.instanceId === instanceId ? (previous?.activePollId ?? null) : null,
    pendingCommands: previous?.pendingCommands ?? [],
    settings,
    devices: input.devices?.length ? input.devices : (previous?.devices ?? []),
  });

  return { ok: true, hostId, pollMs: 500 };
}

export function getScoutVoiceSettingsSnapshot(): {
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
} {
  const host = pickLiveVoiceHostById("scout-menu");
  return {
    settings: host?.settings ?? DEFAULT_VOICE_SETTINGS,
    devices: host?.devices ?? [],
  };
}

export function openScoutVoicePrivacySettings(
  kind: "microphone" | "speechRecognition" = "microphone",
): { ok: true } {
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }
  queueHostCommand(host.hostId, { type: "permissions.open", kind });
  return { ok: true };
}

export function requestScoutVoicePermissions(
  kind: "microphone" | "speechRecognition" = "microphone",
): { ok: true } {
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }
  queueHostCommand(host.hostId, { type: "permissions.request", kind });
  return { ok: true };
}

export function updateScoutVoiceSettings(input: {
  preference?: ScoutVoicePreference;
  inputDeviceId?: string | null;
}): {
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
} {
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }

  const nextSettings = mergeVoiceSettings(host.settings, {
    ...(input.preference ? { preference: input.preference } : {}),
    ...(input.inputDeviceId !== undefined ? { inputDeviceId: input.inputDeviceId } : {}),
  });
  if (input.inputDeviceId !== undefined) {
    const device = host.devices.find((entry) => entry.id === input.inputDeviceId);
    nextSettings.inputDeviceName = device?.name ?? (input.inputDeviceId ? nextSettings.inputDeviceName : null);
  }
  host.settings = nextSettings;
  queueHostCommand(host.hostId, {
    type: "settings.apply",
    preference: nextSettings.preference,
    inputDeviceId: nextSettings.inputDeviceId,
  });
  return {
    settings: nextSettings,
    devices: host.devices,
  };
}

export function touchScoutVoiceHost(hostId: string): void {
  const host = hosts.get(hostId.trim());
  if (!host) return;
  host.lastSeenAt = Date.now();
}

export function awaitScoutVoiceHostCommand(
  hostId: string,
  timeoutMs = 25_000,
  instanceId?: string,
  signal?: AbortSignal,
): Promise<{ command: ScoutVoiceHostCommand | null }> {
  const normalizedHostId = hostId.trim();
  const normalizedInstanceId = instanceId?.trim() || null;
  const host = hosts.get(normalizedHostId);
  if (!host) {
    throw new ScoutVoiceSessionError("host_unknown", "Voice host is not registered.", 404);
  }

  // A terminated helper can leave a long poll alive in the web server until
  // its timeout expires. Once a replacement helper registers, that stale poll
  // must not consume commands intended for the replacement process.
  if (host.instanceId !== normalizedInstanceId) {
    return Promise.resolve({ command: null });
  }

  // URLSession can abandon a long poll while its server-side promise remains
  // alive. The replacement poll from the same helper process supersedes that
  // abandoned request so only the newest connection may dequeue a command.
  // Resolve the old waiter directly instead of waiting for a polling interval
  // to discover that it lost ownership.
  finishScoutVoiceHostCommandWaiter(normalizedHostId, null);
  const pollId = nextHostPollId++;
  host.activePollId = pollId;

  touchScoutVoiceHost(normalizedHostId);
  pruneExpiredSessions();

  if (host.pendingCommands.length > 0) {
    const command = host.pendingCommands.shift() ?? null;
    host.activePollId = null;
    return Promise.resolve({ command });
  }

  if (signal?.aborted) {
    host.activePollId = null;
    return Promise.resolve({ command: null });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (command: ScoutVoiceHostCommand | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      const waiter = hostCommandWaiters.get(normalizedHostId);
      if (waiter?.pollId === pollId) hostCommandWaiters.delete(normalizedHostId);
      const current = hosts.get(normalizedHostId);
      if (current?.activePollId === pollId) current.activePollId = null;
      resolve({ command });
    };
    const abort = () => finish(null);

    hostCommandWaiters.set(normalizedHostId, {
      pollId,
      instanceId: normalizedInstanceId,
      finish,
    });
    timeout = setTimeout(() => {
      const current = hosts.get(normalizedHostId);
      if (
        current
        && current.instanceId === normalizedInstanceId
        && current.activePollId === pollId
      ) {
        // A completed long poll is itself a host heartbeat. Preserve the old
        // liveness semantics without waking the event loop every 100ms.
        current.lastSeenAt = Date.now();
      }
      finish(null);
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    // Close the narrow race where cancellation lands after the preflight
    // check but before the listener is attached. AbortSignal does not replay
    // an already-dispatched event to a late subscriber.
    if (signal?.aborted) abort();
  });
}

export function pushScoutVoiceHostEvent(input: {
  hostId: string;
  instanceId?: string;
  sessionId: string;
  event: ScoutVoiceSessionEventName;
  data?: Record<string, unknown>;
}): ScoutVoiceSessionEvent {
  const host = hosts.get(input.hostId.trim());
  if (!host) {
    throw new ScoutVoiceSessionError("host_unknown", "Voice host is not registered.", 404);
  }
  const instanceId = input.instanceId?.trim() || null;
  if (host.instanceId !== instanceId) {
    throw new ScoutVoiceSessionError("host_instance_mismatch", "Voice host process is no longer active.", 409);
  }
  touchScoutVoiceHost(host.hostId);

  const session = sessions.get(input.sessionId);
  if (!session) {
    throw new ScoutVoiceSessionError("session_unknown", "Voice session was not found.", 404);
  }

  if (session.assignedHostId && session.assignedHostId !== host.hostId) {
    throw new ScoutVoiceSessionError("session_host_mismatch", "Voice session belongs to another host.", 409);
  }

  if (session.kind === "speech" && isTerminalSessionStatus(session.status)) {
    throw new ScoutVoiceSessionError(
      "session_terminal",
      "Voice session has already finished.",
      409,
    );
  }

  session.assignedHostId = host.hostId;
  return appendSessionEvent(session, input.event, input.data ?? {});
}

export function createScoutVoiceSession(input: {
  clientId?: string;
  surface?: string;
  language?: string;
  sessionId?: string;
}): { sessionId: string; capture: ScoutVoiceCaptureMode } {
  pruneExpiredSessions();
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }

  const sessionId = input.sessionId?.trim() || createSessionId();
  cancelStaleHostSessions(host.hostId, sessionId);
  const now = Date.now();
  const session: VoiceSession = {
    id: sessionId,
    kind: "dictation",
    clientId: input.clientId?.trim() || "openscout-web",
    surface: input.surface?.trim() || "web",
    language: input.language?.trim() || "en",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    assignedHostId: host.hostId,
    events: [],
    error: null,
  };
  sessions.set(sessionId, session);

  const inputDevice = resolveSessionInputDevice(host);
  queueHostCommand(host.hostId, {
    type: "session.start",
    sessionId,
    clientId: session.clientId,
    surface: session.surface,
    language: session.language,
    inputDeviceId: inputDevice?.id ?? null,
    inputDeviceName: inputDevice?.name ?? null,
  });

  appendSessionEvent(session, "session.started", { state: "starting" });
  return { sessionId, capture: "native" };
}

export type ScoutVoiceSpeechResult = {
  /** Empty when the utterance was spoken on the host instead of rendered. */
  contentType: string;
  audioBase64: string;
  modelId: string;
  voiceId: string;
  audioBytes: number;
  route: "scout-menu";
  /**
   * Scout Menu spoke the text live on the Mac; no audio travels back and the
   * result resolves when playback ends. `interrupted` marks an operator cut
   * (hold-to-talk, a newer utterance) rather than a failure.
   */
  playedOnHost?: boolean;
  interrupted?: boolean;
  metrics?: Record<string, unknown>;
  originAppId?: string;
  utteranceId?: string;
};

export async function synthesizeScoutVoiceSpeech(input: {
  text: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  instructions?: string;
  originAppId?: string;
  utteranceId?: string;
  speechTiming?: ScoutVoiceSpeechTimingRequest;
  playback?: ScoutVoiceSpeechPlayback;
  signal?: AbortSignal;
  /** Narrow test seam; production callers use the bounded host timeout. */
  timeoutMs?: number;
}): Promise<ScoutVoiceSpeechResult> {
  pruneExpiredSessions();
  const host = pickLiveVoiceHostById("scout-menu");
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout Menu voice host is not running.",
      503,
    );
  }

  const sessionId = `scout-speech:${crypto.randomUUID()}`;
  const now = Date.now();
  const session: VoiceSession = {
    id: sessionId,
    kind: "speech",
    clientId: "openscout-web",
    surface: "speech",
    language: "en",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    assignedHostId: host.hostId,
    events: [],
    error: null,
  };
  sessions.set(sessionId, session);
  const playback: ScoutVoiceSpeechPlayback = input.playback ?? "browser";
  if (playback === "browser" && !input.modelId) {
    throw new ScoutVoiceSessionError(
      "speech_model_required",
      "Browser playback needs a resolved speech model.",
      500,
    );
  }
  queueHostCommand(host.hostId, {
    type: "speech.synthesize",
    sessionId,
    text: input.text,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.voiceId ? { voiceId: input.voiceId } : {}),
    ...(playback === "host" ? { playback } : {}),
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.originAppId ? { originAppId: input.originAppId } : {}),
    ...(input.utteranceId ? { utteranceId: input.utteranceId } : {}),
    ...(input.speechTiming ? { speechTiming: input.speechTiming } : {}),
  });
  appendSessionEvent(session, "speech.started", {});

  return await new Promise<ScoutVoiceSpeechResult>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: unknown, result?: ScoutVoiceSpeechResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () => {
      if (!settled && session.status !== "done" && session.status !== "error") {
        try {
          dispatchSessionCommand(session, { type: "speech.cancel", sessionId });
        } catch {
          // The host may disappear while the request is being cancelled.
        }
        appendSessionEvent(session, "session.cancelled", { reason: "client" });
      }
      const error = new Error("Scout speech synthesis was stopped.");
      error.name = "AbortError";
      finish(error);
    };
    const timeout = setTimeout(() => {
      if (session.status !== "done" && session.status !== "error") {
        try {
          dispatchSessionCommand(session, { type: "speech.cancel", sessionId });
        } catch {
          // The timeout remains authoritative if the host disappeared.
        }
      }
      const error = new ScoutVoiceSessionError(
        "speech_timeout",
        "Scout Menu speech synthesis timed out.",
        504,
      );
      finish(error);
      if (session.status !== "done" && session.status !== "error") {
        appendSessionEvent(session, "speech.error", { message: error.message });
      }
    }, input.timeoutMs ?? (
      playback === "host"
        ? SPEECH_TIMEOUT_MS + input.text.length * HOST_PLAYBACK_MS_PER_CHARACTER
        : SPEECH_TIMEOUT_MS
    ));

    unsubscribe = subscribeScoutVoiceSession(sessionId, (event) => {
      if (event.event === "speech.error") {
        finish(new ScoutVoiceSessionError(
          "speech_failed",
          typeof event.data.message === "string" ? event.data.message : "Scout Menu speech synthesis failed.",
          503,
        ));
        return;
      }
      if (event.event !== "speech.result") return;
      const audioBase64 = typeof event.data.audioBase64 === "string" ? event.data.audioBase64 : "";
      const contentType = typeof event.data.contentType === "string" ? event.data.contentType : "";
      const modelId = typeof event.data.modelId === "string" ? event.data.modelId : "";
      const voiceId = typeof event.data.voiceId === "string" ? event.data.voiceId : "";
      const audioBytes = typeof event.data.audioBytes === "number" ? event.data.audioBytes : 0;
      const originAppId = typeof event.data.originAppId === "string" ? event.data.originAppId : input.originAppId;
      const utteranceId = typeof event.data.utteranceId === "string" ? event.data.utteranceId : input.utteranceId;
      const metrics = event.data.metrics && typeof event.data.metrics === "object"
        ? { metrics: event.data.metrics as Record<string, unknown> }
        : {};
      const correlation = {
        ...(originAppId ? { originAppId } : {}),
        ...(utteranceId ? { utteranceId } : {}),
      };
      if (event.data.playedOnHost === true) {
        // Spoken live on the Mac: the host reports what it actually said,
        // never bytes. A host that ignores `playback` still answers with
        // audio below, so older menus degrade to browser playback.
        if (!modelId || !voiceId) {
          finish(new ScoutVoiceSessionError("speech_result_invalid", "Scout Menu returned an invalid host playback receipt.", 502));
          return;
        }
        finish(undefined, {
          audioBase64: "",
          contentType: "",
          modelId,
          voiceId,
          audioBytes: 0,
          route: "scout-menu",
          playedOnHost: true,
          ...(event.data.interrupted === true ? { interrupted: true } : {}),
          ...metrics,
          ...correlation,
        });
        return;
      }
      if (!audioBase64 || !contentType || !modelId || !voiceId || audioBytes <= 0) {
        finish(new ScoutVoiceSessionError("speech_result_invalid", "Scout Menu returned invalid speech audio.", 502));
        return;
      }
      finish(undefined, {
        audioBase64,
        contentType,
        modelId,
        voiceId,
        audioBytes,
        route: "scout-menu",
        ...metrics,
        ...correlation,
      });
    });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
  });
}

export function stopScoutVoiceSession(sessionId: string): void {
  const session = requireSession(sessionId);
  if (session.status === "done" || session.status === "cancelled" || session.status === "error") {
    return;
  }
  session.status = "processing";
  session.updatedAt = Date.now();
  appendSessionEvent(session, "session.state", { state: "processing" });
  dispatchSessionCommand(session, { type: "session.stop", sessionId: session.id });
}

export function cancelScoutVoiceSession(sessionId: string): void {
  const session = requireSession(sessionId);
  if (session.status === "done" || session.status === "cancelled" || session.status === "error") {
    return;
  }
  session.status = "cancelled";
  session.updatedAt = Date.now();
  dispatchSessionCommand(session, { type: "session.cancel", sessionId: session.id });
  appendSessionEvent(session, "session.cancelled", { reason: "client" });
}

export function subscribeScoutVoiceSession(
  sessionId: string,
  handler: SessionSubscriber,
): () => void {
  const session = requireSession(sessionId);
  const subscribers = sessionSubscribers.get(session.id) ?? new Set<SessionSubscriber>();
  subscribers.add(handler);
  sessionSubscribers.set(session.id, subscribers);

  for (const event of session.events) {
    handler(event);
  }

  return () => {
    const current = sessionSubscribers.get(session.id);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) sessionSubscribers.delete(session.id);
  };
}

export function formatScoutVoiceSessionSse(event: ScoutVoiceSessionEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify({
    sessionId: event.sessionId,
    ...event.data,
    ts: event.ts,
  })}\n\n`;
}

export function isScoutVoiceHostAvailable(now = Date.now()): boolean {
  pruneExpiredSessions(now);
  return pickLiveVoiceHost(now) !== null;
}

export type ScoutVoiceSessionHistoryEntry = {
  sessionId: string;
  status: SessionStatus;
  surface: string;
  clientId: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  eventCount: number;
  lastEvent: ScoutVoiceSessionEventName | null;
  lastTranscript: string | null;
};

export function listScoutVoiceSessionHistory(limit = 20, now = Date.now()): ScoutVoiceSessionHistoryEntry[] {
  pruneExpiredSessions(now);
  const capped = Math.max(1, Math.min(limit, 50));
  return [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, capped)
    .map((session) => ({
      sessionId: session.id,
      status: session.status,
      surface: session.surface,
      clientId: session.clientId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      error: session.error,
      eventCount: session.events.length,
      lastEvent: session.events.at(-1)?.event ?? null,
      lastTranscript: findLastTranscript(session.events),
    }));
}

export function getScoutVoiceHealthSnapshot(now = Date.now()): ScoutVoiceHealthSnapshot {
  pruneExpiredSessions(now);
  const host = pickLiveVoiceHost(now);
  if (!host) {
    return {
      ok: false,
      service: "scout-voice",
      adapter: "hudson-dictation",
      capture: "native",
      detail: "Scout voice host is not running. Launch Scout Menu and try again.",
      inputDevice: null,
      host: null,
    };
  }

  const inputDevice = resolveSessionInputDevice(host);
  const micPermission = host.settings.permissions?.find((entry) => entry.kind === "microphone");
  const microphoneGranted = micPermission?.granted ?? false;
  const microphoneCanRequest = micPermission?.canRequest ?? false;
  if (!microphoneGranted) {
    const detail = micPermission?.status === "denied"
      ? "Microphone access is off for Scout Menu. Choose Retry access to reopen the macOS permission pane."
      : microphoneCanRequest
        ? "Microphone has not been requested yet. Tap the mic or choose Request access to show the macOS prompt."
        : "Scout Menu needs microphone access before dictation can start.";
    return {
      ok: false,
      service: "scout-voice",
      adapter: "hudson-dictation",
      capture: "native",
      detail,
      microphoneGranted: false,
      inputDevice,
      microphoneCanRequest,
      host: {
        hostId: host.hostId,
        platform: host.platform,
        lastSeenAt: host.lastSeenAt,
      },
    };
  }

  return {
    ok: true,
    service: "scout-voice",
    adapter: "hudson-dictation",
    capture: "native",
    detail: null,
    microphoneGranted: true,
    microphoneCanRequest: false,
    inputDevice,
    host: {
      hostId: host.hostId,
      platform: host.platform,
      lastSeenAt: host.lastSeenAt,
    },
  };
}

export function isTerminalScoutVoiceSessionEvent(event: ScoutVoiceSessionEvent): boolean {
  if (
    event.event === "session.final"
    || event.event === "session.error"
    || event.event === "session.cancelled"
    || event.event === "speech.result"
    || event.event === "speech.error"
  ) {
    return true;
  }
  if (event.event !== "session.state") return false;
  const state = event.data.state;
  return state === "done" || state === "error" || state === "cancelled";
}

export class ScoutVoiceSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ScoutVoiceSessionError";
    this.code = code;
    this.status = status;
  }
}

function requireSession(sessionId: string): VoiceSession {
  const session = sessions.get(sessionId.trim());
  if (!session) {
    throw new ScoutVoiceSessionError("session_unknown", "Voice session was not found.", 404);
  }
  return session;
}

function pickLiveVoiceHost(now = Date.now()): VoiceHost | null {
  let selected: VoiceHost | null = null;
  for (const host of hosts.values()) {
    if (now - host.lastSeenAt > HOST_STALE_MS) continue;
    if (!selected || host.lastSeenAt > selected.lastSeenAt) {
      selected = host;
    }
  }
  return selected;
}

function pickLiveVoiceHostById(hostId: string, now = Date.now()): VoiceHost | null {
  const host = hosts.get(hostId);
  return host && now - host.lastSeenAt <= HOST_STALE_MS ? host : null;
}

function queueHostCommand(hostId: string, command: ScoutVoiceHostCommand): void {
  const host = hosts.get(hostId);
  if (!host) {
    throw new ScoutVoiceSessionError("host_unknown", "Voice host is not registered.", 404);
  }
  host.pendingCommands.push(command);
  deliverPendingScoutVoiceHostCommand(host);
}

function finishScoutVoiceHostCommandWaiter(
  hostId: string,
  command: ScoutVoiceHostCommand | null,
): void {
  hostCommandWaiters.get(hostId)?.finish(command);
}

function deliverPendingScoutVoiceHostCommand(host: VoiceHost): void {
  const waiter = hostCommandWaiters.get(host.hostId);
  if (!waiter) return;
  if (waiter.instanceId !== host.instanceId || waiter.pollId !== host.activePollId) {
    waiter.finish(null);
    return;
  }
  const command = host.pendingCommands.shift();
  if (command) waiter.finish(command);
}

function dispatchSessionCommand(session: VoiceSession, command: ScoutVoiceHostCommand): void {
  const hostId = session.assignedHostId ?? pickLiveVoiceHost()?.hostId;
  if (!hostId) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }
  session.assignedHostId = hostId;
  queueHostCommand(hostId, command);
}

function appendSessionEvent(
  session: VoiceSession,
  event: ScoutVoiceSessionEventName,
  data: Record<string, unknown>,
): ScoutVoiceSessionEvent {
  const transientPayload: ScoutVoiceSessionEvent = {
    event,
    sessionId: session.id,
    data,
    ts: Date.now(),
  };
  const storedPayload = event === "speech.result"
    ? withoutTransientSpeechAudio(transientPayload)
    : transientPayload;
  session.events.push(storedPayload);
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
  }
  session.updatedAt = storedPayload.ts;

  if (event === "session.state") {
    const state = data.state;
    if (state === "recording" || state === "starting") session.status = "active";
    if (state === "processing") session.status = "processing";
    if (state === "done") session.status = "done";
    if (state === "cancelled") session.status = "cancelled";
    if (state === "error") session.status = "error";
  }
  if (event === "session.final") session.status = "done";
  if (event === "speech.result") session.status = "done";
  if (event === "session.error") {
    session.status = "error";
    session.error = typeof data.message === "string" ? data.message : "Scout voice session failed.";
  }
  if (event === "speech.error") {
    session.status = "error";
    session.error = typeof data.message === "string" ? data.message : "Scout speech synthesis failed.";
  }
  if (event === "session.cancelled") session.status = "cancelled";

  const subscribers = sessionSubscribers.get(session.id);
  if (subscribers) {
    for (const handler of subscribers) handler(transientPayload);
  }
  return storedPayload;
}

function withoutTransientSpeechAudio(event: ScoutVoiceSessionEvent): ScoutVoiceSessionEvent {
  const { audioBase64, ...metadata } = event.data;
  return {
    ...event,
    data: {
      ...metadata,
      audioTransferred: typeof audioBase64 === "string" && audioBase64.length > 0,
    },
  };
}

function isTerminalSessionStatus(status: SessionStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.updatedAt <= SESSION_TTL_MS) continue;
    sessions.delete(sessionId);
    sessionSubscribers.delete(sessionId);
  }
}

function cancelStaleHostSessions(hostId: string, nextSessionId: string): void {
  for (const session of sessions.values()) {
    if (session.kind !== "dictation") continue;
    if (session.id === nextSessionId) continue;
    if (session.assignedHostId !== hostId) continue;
    if (session.status === "done" || session.status === "cancelled" || session.status === "error") continue;
    session.status = "cancelled";
    session.updatedAt = Date.now();
    appendSessionEvent(session, "session.cancelled", { reason: "superseded" });
  }
}

function createSessionId(): string {
  return `scout-voice:${crypto.randomUUID()}`;
}

function resolveSessionInputDevice(host: VoiceHost): { id: string; name: string } | null {
  const devices = host.devices;
  if (!devices.length) return null;
  const selected = host.settings.inputDeviceId
    ? devices.find((device) => device.id === host.settings.inputDeviceId)
    : null;
  const fallback = devices.find((device) => device.isDefault) ?? devices[0] ?? null;
  const device = selected ?? fallback;
  return device ? { id: device.id, name: device.name } : null;
}

function findLastTranscript(events: ScoutVoiceSessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event !== "session.final") continue;
    const text = event.data.text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  return null;
}

function mergeVoiceSettings(
  current: ScoutVoiceSettings,
  patch?: Partial<ScoutVoiceSettings>,
): ScoutVoiceSettings {
  if (!patch) return current;
  return {
    ...current,
    ...patch,
  };
}
