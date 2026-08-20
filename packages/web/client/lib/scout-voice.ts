import {
  DEFAULT_VOICE_FX,
  VOICE_FX_PRESETS,
  decodeAudioFromBase64,
  playWithVoiceFx,
  type VoiceFxParams,
} from "@voxd/client/fx";

export type ScoutVoiceConnectionState = "unknown" | "probing" | "connected" | "unavailable";
export type ScoutVoiceSessionState = "starting" | "recording" | "processing" | "done" | "cancelled" | "error";

export type ScoutVoiceLiveFinal = {
  sessionId: string;
  text: string;
  durationMs: number;
};

export type ScoutVoiceLiveHandle = {
  readonly sessionId: string | null;
  result: Promise<ScoutVoiceLiveFinal>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
};

export type ScoutVoiceLiveCallbacks = {
  onState?: (state: ScoutVoiceSessionState) => void;
  onPartial?: (text: string) => void;
  onFinal?: (final: ScoutVoiceLiveFinal) => void;
  /**
   * Optional live mic energy 0–1 while recording. Only available when the
   * capture path exposes a MediaStream (browser). Used to drive speech-
   * representative waveforms instead of decorative loops.
   */
  onLevel?: (level: number) => void;
};

export type ScoutVoiceLiveOptions = {
  surface?: string;
};

export type ScoutSpeechResult = {
  contentType: string;
  audioBase64: string;
  modelId: string;
  voiceId: string;
  audioBytes: number;
  metrics?: Record<string, unknown>;
  traceId?: string;
  speechTiming?: ScoutSpeechTimingResult;
};

export type ScoutSpeechHandle = {
  promise: Promise<ScoutSpeechResult>;
  stop: () => void;
};

export type ScoutSpeechOptions = {
  signal?: AbortSignal;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  instructions?: string;
  originAppId?: string;
  utteranceId?: string;
  speechTiming?: ScoutSpeechTimingRequest;
};

export type ScoutSpeechCatalogModel = {
  id: string;
  name: string;
  provider: string;
  available: boolean;
};

export type ScoutSpeechCatalogVoice = {
  id: string;
  name: string;
  language?: string;
  provider: string;
  modelId: string;
  available: boolean;
  isDefault: boolean;
};

export type ScoutSpeechCatalog = {
  defaultModelId: string;
  defaultVoiceId?: string;
  models: ScoutSpeechCatalogModel[];
  voices: ScoutSpeechCatalogVoice[];
  source: "vox" | "fallback";
};

export type ScoutSpeechTimingCueRequest = {
  id: string;
  textStart?: number;
  textEnd?: number;
  text?: string;
};

export type ScoutSpeechTimingRequest = {
  enabled: true;
  modelId?: string;
  strict?: boolean;
  cues?: ScoutSpeechTimingCueRequest[];
};

export type ScoutSpeechTimingWord = {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  sourceTextStart?: number;
  sourceTextEnd?: number;
};

export type ScoutSpeechTimingCueResult = {
  id: string;
  startMs: number;
  endMs?: number;
  confidence?: number;
  source?: string;
};

export type ScoutSpeechTimingResult = {
  source?: string;
  modelId?: string;
  elapsedMs?: number;
  words?: ScoutSpeechTimingWord[];
  cues?: ScoutSpeechTimingCueResult[];
};

export type ScoutVoiceLaunchOptions = {
  source?: string;
  returnTo?: string;
  context?: ScoutVoiceLaunchContext;
};

export type ScoutVoiceLaunchContext = {
  requesterName?: string;
  productName?: string;
  headline?: string;
  body?: string;
  actionLabel?: string;
  logo?: {
    url?: string;
    path?: string;
    symbolName?: string;
  };
};

export type ScoutVoiceCaptureMode = "native" | "browser";

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

/**
 * ## Scout voice dictation API (web client)
 *
 * Mic engagement uses the Scout voice host (Scout Menu). The browser never captures audio.
 *
 * | Call | Route | Purpose |
 * | --- | --- | --- |
 * | `engageScoutVoiceDictation()` | `POST /api/voice/engage` | **Mic tap entry point.** Checks host, mic, input device; optionally requests permissions. |
 * | `ScoutVoiceClient.startLive()` | `POST /api/voice/session` | Starts native dictation after engage succeeds. |
 * | `requestScoutVoicePermissions()` | `POST /api/voice/permissions/request` | Ask Scout Menu to show the macOS permission dialog. |
 * | `openScoutVoicePrivacySettings()` | `POST /api/voice/permissions/open` | Open Privacy & Security → Microphone or Speech Recognition on Scout Menu. |
 * | `fetchScoutVoiceSettings()` | `GET /api/voice/settings` | Read engine, devices, and permission snapshot from the host. |
 */

export type ScoutVoiceIssueCode =
  | "host_offline"
  | "microphone_not_requested"
  | "microphone_denied"
  | "speech_not_requested"
  | "speech_denied"
  | "no_input_device"
  | "ready";

export type ScoutVoiceIssueAction =
  | "launch_host"
  | "request_microphone"
  | "open_microphone_settings"
  | "request_speech"
  | "open_speech_settings"
  | "open_voice_settings"
  | "none";

export type ScoutVoiceIssue = {
  code: ScoutVoiceIssueCode;
  title: string;
  message: string;
  hint: string | null;
  action: ScoutVoiceIssueAction;
};

export type ScoutVoiceEngageResult = {
  ready: boolean;
  issue: ScoutVoiceIssue | null;
  warnings: ScoutVoiceIssue[];
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
  inputDevice: { id: string; name: string } | null;
  hostOnline: boolean;
};

export type ScoutVoiceEngageOptions = {
  surface?: string;
  /** Ask Scout Menu to show the macOS permission dialog when allowed. */
  requestPermissions?: boolean;
};

export function formatScoutVoiceIssue(issue: ScoutVoiceIssue | null | undefined): string {
  if (!issue) return "Scout voice is unavailable.";
  return issue.hint ? `${issue.message} ${issue.hint}` : issue.message;
}

export async function executeScoutVoiceIssueAction(action: ScoutVoiceIssueAction): Promise<void> {
  switch (action) {
    case "request_microphone":
      await requestScoutVoicePermissions("microphone");
      return;
    case "request_speech":
      await requestScoutVoicePermissions("speechRecognition");
      return;
    case "open_microphone_settings":
      await openScoutVoicePrivacySettings("microphone");
      return;
    case "open_speech_settings":
      await openScoutVoicePrivacySettings("speechRecognition");
      return;
    case "launch_host":
      await getSharedScoutVoiceClient().launch({ source: "openscout" });
      return;
    case "open_voice_settings":
    case "none":
      return;
  }
}

/** Primary mic-engagement call. Run before `startLive()`. */
export async function engageScoutVoiceDictation(
  options: ScoutVoiceEngageOptions = {},
): Promise<ScoutVoiceEngageResult> {
  const response = await fetch("/api/voice/engage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (response.status === 404) {
    return engageScoutVoiceDictationFallback(options);
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(parseScoutVoiceError(raw, response.status));
  }
  return await response.json() as ScoutVoiceEngageResult;
}

/** Client-side engage when the web server has not picked up `/api/voice/engage` yet. */
async function engageScoutVoiceDictationFallback(
  options: ScoutVoiceEngageOptions = {},
): Promise<ScoutVoiceEngageResult> {
  const snapshot = await fetchScoutVoiceSettings();
  const settings = snapshot.settings;
  const devices = snapshot.devices;
  const hostOnline = devices.length > 0 || (settings.permissions?.length ?? 0) > 0;
  const mic = settings.permissions?.find((entry) => entry.kind === "microphone") ?? null;
  const speech = settings.permissions?.find((entry) => entry.kind === "speechRecognition") ?? null;
  const inputDevice = resolveScoutVoiceInputDevice(settings, devices);

  if (options.requestPermissions) {
    if (mic && !mic.granted && mic.status !== "restricted") {
      await requestScoutVoicePermissions("microphone").catch(() => undefined);
    } else if ((mic?.granted ?? false) && speech && !speech.granted && speech.status !== "restricted") {
      await requestScoutVoicePermissions("speechRecognition").catch(() => undefined);
    }
  }

  if (!hostOnline) {
    return {
      ready: false,
      issue: {
        code: "host_offline",
        title: "Scout Menu is not running",
        message: "Launch Scout Menu on this Mac to dictate in web chat.",
        hint: "Restart the web server if you just updated Scout — `scout server restart` or restart `bun run server/index.ts`.",
        action: "launch_host",
      },
      warnings: [],
      settings,
      devices,
      inputDevice: null,
      hostOnline: false,
    };
  }

  const micIssue = scoutVoiceMicrophoneIssue(mic);
  if (micIssue) {
    return {
      ready: false,
      issue: micIssue,
      warnings: [],
      settings,
      devices,
      inputDevice,
      hostOnline,
    };
  }

  if (!inputDevice) {
    return {
      ready: false,
      issue: {
        code: "no_input_device",
        title: "No microphone detected",
        message: "Scout Menu did not report any audio input devices.",
        hint: "Plug in a microphone, check Sound settings, then refresh Settings → Voice.",
        action: "open_voice_settings",
      },
      warnings: [],
      settings,
      devices,
      inputDevice: null,
      hostOnline,
    };
  }

  const speechIssue = scoutVoiceSpeechIssue(speech);
  return {
    ready: true,
    issue: null,
    warnings: speechIssue ? [speechIssue] : [],
    settings,
    devices,
    inputDevice,
    hostOnline,
  };
}

function resolveScoutVoiceInputDevice(
  settings: ScoutVoiceSettings,
  devices: ScoutVoiceInputDevice[],
): { id: string; name: string } | null {
  if (devices.length === 0) return null;
  const selected = settings.inputDeviceId
    ? devices.find((device) => device.id === settings.inputDeviceId)
    : null;
  const fallback = devices.find((device) => device.isDefault) ?? devices[0] ?? null;
  const device = selected ?? fallback;
  return device ? { id: device.id, name: device.name } : null;
}

function scoutVoiceMicrophoneIssue(
  permission: ScoutVoicePermissionStatus | null,
): ScoutVoiceIssue | null {
  if (!permission || permission.granted) return null;
  if (permission.canRequest) {
    return {
      code: "microphone_not_requested",
      title: "Microphone access needed",
      message: "Scout Menu needs microphone access before dictation can start.",
      hint: "Request access or tap the mic again to show the macOS prompt.",
      action: "request_microphone",
    };
  }
  return {
    code: "microphone_denied",
    title: "Microphone blocked",
    message: "Scout Menu cannot record because microphone access is off.",
    hint: "Scout is opening macOS Microphone settings and will detect the change automatically.",
    action: "open_microphone_settings",
  };
}

function scoutVoiceSpeechIssue(
  permission: ScoutVoicePermissionStatus | null,
): ScoutVoiceIssue | null {
  if (!permission || permission.granted) return null;
  if (permission.canRequest) {
    return {
      code: "speech_not_requested",
      title: "Speech recognition needed",
      message: "Scout Menu needs speech recognition for live partials.",
      hint: "Request access to show the macOS prompt.",
      action: "request_speech",
    };
  }
  return {
    code: "speech_denied",
    title: "Speech recognition blocked",
    message: "Speech recognition is off for Scout Menu.",
    hint: "Choose Retry access to reopen macOS Speech Recognition settings.",
    action: "open_speech_settings",
  };
}

function friendlySessionError(message: string, code: string | null): string {
  switch (code) {
    case "microphone_permission":
      return "Microphone access is off for Scout Menu. Tap the mic to retry; Scout will open macOS Microphone settings.";
    case "empty_transcript":
      return "No speech was detected. Check your microphone input in Settings → Voice.";
    default:
      return message;
  }
}

const SCOUT_VOICE_RESULT_TIMEOUT_MS = 60_000;
const SCOUT_VOICE_PROBE_TIMEOUT_MS = 3_000;
const SCOUT_VOICE_PROBE_OK_CACHE_MS = 20_000;
const SCOUT_VOICE_PROBE_FAIL_CACHE_MS = 8_000;
const SCOUT_VOICE_PROBE_STALE_MS = 45_000;

type ScoutVoiceHealthBody = {
  ok?: boolean;
  detail?: string;
  error?: string;
  capture?: ScoutVoiceCaptureMode;
  microphoneGranted?: boolean;
  microphoneCanRequest?: boolean;
  host?: { hostId?: string } | null;
};

export type ScoutVoiceProbeSnapshot = {
  ok: boolean;
  reason: string | null;
  captureMode: ScoutVoiceCaptureMode | null;
  hostReachable: boolean;
  microphoneGranted: boolean | null;
  microphoneCanRequest: boolean | null;
  probedAt: number;
};

let sharedVoiceClient: ScoutVoiceClient | null = null;
let inflightVoiceProbe: Promise<boolean> | null = null;
let lastVoiceProbe: ScoutVoiceProbeSnapshot | null = null;
let autoVoiceProbeInstalled = false;
const voiceProbeListeners = new Set<(snapshot: ScoutVoiceProbeSnapshot) => void>();

export function shouldAutoProbeScoutVoice(): boolean {
  if (typeof window === "undefined") return false;
  return typeof fetch === "function";
}

export function getSharedScoutVoiceClient(): ScoutVoiceClient {
  if (!sharedVoiceClient) {
    sharedVoiceClient = new ScoutVoiceClient();
  }
  return sharedVoiceClient;
}

export function subscribeScoutVoiceProbe(
  listener: (snapshot: ScoutVoiceProbeSnapshot) => void,
): () => void {
  voiceProbeListeners.add(listener);
  if (lastVoiceProbe) listener(lastVoiceProbe);
  return () => {
    voiceProbeListeners.delete(listener);
  };
}

export function ensureScoutVoiceAutoProbe(): void {
  if (autoVoiceProbeInstalled || !shouldAutoProbeScoutVoice()) return;
  autoVoiceProbeInstalled = true;

  const client = getSharedScoutVoiceClient();
  void client.probe();

  const maybeRefresh = () => {
    void client.probeIfStale();
  };
  window.addEventListener("focus", maybeRefresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybeRefresh();
  });
}

function notifyVoiceProbeListeners(snapshot: ScoutVoiceProbeSnapshot): void {
  for (const listener of voiceProbeListeners) listener(snapshot);
}

function voiceProbeCacheFresh(snapshot: ScoutVoiceProbeSnapshot, now = Date.now()): boolean {
  const ttl = snapshot.ok ? SCOUT_VOICE_PROBE_OK_CACHE_MS : SCOUT_VOICE_PROBE_FAIL_CACHE_MS;
  return now - snapshot.probedAt < ttl;
}

export class ScoutVoiceClient {
  private state: ScoutVoiceConnectionState = "unknown";
  private unavailableReason: string | null = null;
  private captureMode: ScoutVoiceCaptureMode | null = null;
  private hostReachable = false;
  private microphoneGranted: boolean | null = null;
  private microphoneCanRequest: boolean | null = null;

  get connectionState(): ScoutVoiceConnectionState {
    return this.state;
  }

  get lastUnavailableReason(): string | null {
    return this.unavailableReason;
  }

  get preferredCaptureMode(): ScoutVoiceCaptureMode | null {
    return this.captureMode;
  }

  get isVoiceHostReachable(): boolean {
    return this.hostReachable;
  }

  get isMicrophoneGranted(): boolean | null {
    return this.microphoneGranted;
  }

  get canRequestMicrophone(): boolean {
    return this.hostReachable
      && this.microphoneGranted === false
      && this.microphoneCanRequest === true;
  }

  /** Mic was explicitly denied — fix in Privacy & Security → Microphone. */
  get isMicrophoneHardDenied(): boolean {
    return this.hostReachable
      && this.microphoneGranted === false
      && this.microphoneCanRequest === false;
  }

  /** @deprecated Use isMicrophoneHardDenied or canRequestMicrophone. */
  get isMicrophoneDenied(): boolean {
    return this.isMicrophoneHardDenied;
  }

  async probeIfStale(): Promise<boolean> {
    const now = Date.now();
    if (lastVoiceProbe && voiceProbeCacheFresh(lastVoiceProbe, now)) {
      this.applyProbeSnapshot(lastVoiceProbe);
      return lastVoiceProbe.ok;
    }
    if (lastVoiceProbe && lastVoiceProbe.ok && now - lastVoiceProbe.probedAt < SCOUT_VOICE_PROBE_STALE_MS) {
      this.applyProbeSnapshot(lastVoiceProbe);
      return true;
    }
    if (lastVoiceProbe && !lastVoiceProbe.ok) {
      return this.probe({ force: true });
    }
    return this.probe();
  }

  async probe(options: { force?: boolean; timeoutMs?: number } | number = {}): Promise<boolean> {
    const normalized = typeof options === "number"
      ? { timeoutMs: options }
      : options;
    const force = normalized.force ?? false;
    const timeoutMs = normalized.timeoutMs ?? SCOUT_VOICE_PROBE_TIMEOUT_MS;
    const now = Date.now();

    if (!force && lastVoiceProbe && voiceProbeCacheFresh(lastVoiceProbe, now)) {
      this.applyProbeSnapshot(lastVoiceProbe);
      return lastVoiceProbe.ok;
    }

    if (inflightVoiceProbe) {
      return inflightVoiceProbe;
    }

    this.state = "probing";
    inflightVoiceProbe = this.fetchProbe(timeoutMs)
      .finally(() => {
        inflightVoiceProbe = null;
      });

    return inflightVoiceProbe;
  }

  private async fetchProbe(timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("/api/voice/health?quiet=1", { signal: controller.signal });
      const body = await response.json().catch(() => ({})) as ScoutVoiceHealthBody;
      const hostReachable = Boolean(body.host?.hostId);
      const microphoneGranted = typeof body.microphoneGranted === "boolean"
        ? body.microphoneGranted
        : null;
      const microphoneCanRequest = typeof body.microphoneCanRequest === "boolean"
        ? body.microphoneCanRequest
        : null;
      const captureMode = body.capture === "browser" ? "browser" : "native";
      const ok = response.ok && body.ok === true;
      const reason = ok
        ? null
        : body.detail ?? body.error ?? (hostReachable
          ? "Scout voice is not ready."
          : "Scout voice service is unavailable.");

      const snapshot: ScoutVoiceProbeSnapshot = {
        ok,
        reason,
        captureMode: ok ? captureMode : null,
        hostReachable,
        microphoneGranted,
        microphoneCanRequest,
        probedAt: Date.now(),
      };
      lastVoiceProbe = snapshot;
      this.applyProbeSnapshot(snapshot);
      notifyVoiceProbeListeners(snapshot);
      return ok;
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? "Scout voice service did not respond."
        : "Scout voice service is unavailable.";
      const snapshot: ScoutVoiceProbeSnapshot = {
        ok: false,
        reason,
        captureMode: null,
        hostReachable: false,
        microphoneGranted: null,
        microphoneCanRequest: null,
        probedAt: Date.now(),
      };
      lastVoiceProbe = snapshot;
      this.applyProbeSnapshot(snapshot);
      notifyVoiceProbeListeners(snapshot);
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private applyProbeSnapshot(snapshot: ScoutVoiceProbeSnapshot): void {
    this.hostReachable = snapshot.hostReachable;
    this.microphoneGranted = snapshot.microphoneGranted;
    this.microphoneCanRequest = snapshot.microphoneCanRequest;
    if (snapshot.ok) {
      this.unavailableReason = null;
      this.captureMode = snapshot.captureMode;
      this.state = "connected";
      return;
    }
    this.unavailableReason = snapshot.reason;
    this.captureMode = null;
    this.state = "unavailable";
  }

  async launch(_options: ScoutVoiceLaunchOptions = {}): Promise<void> {
    try {
      const response = await fetch("/api/scout-services/restart-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "all" }),
      });
      const body = await response.json().catch(() => ({})) as { url?: string };
      if (body.url?.startsWith("scout://services/restart/")) {
        window.location.href = body.url;
        return;
      }
    } catch {
      // Fall through to the HUD URL. The retry button still gives feedback.
    }
    window.location.href = "scout://hud/show";
  }

  async startLive(
    callbacks: ScoutVoiceLiveCallbacks = {},
    options: ScoutVoiceLiveOptions = {},
  ): Promise<ScoutVoiceLiveHandle> {
    if (this.captureMode !== "browser") {
      return await startNativeScoutVoiceLive(callbacks, options);
    }
    return await startBrowserScoutVoiceLive(callbacks);
  }
}

async function startNativeScoutVoiceLive(
  callbacks: ScoutVoiceLiveCallbacks = {},
  options: ScoutVoiceLiveOptions = {},
): Promise<ScoutVoiceLiveHandle> {
  callbacks.onState?.("starting");

  const startResponse = await fetch("/api/voice/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "openscout-web",
      surface: options.surface?.trim() || "chat-composer",
    }),
  });
  if (!startResponse.ok) {
    const raw = await startResponse.text().catch(() => "");
    throw new Error(parseScoutVoiceError(raw, startResponse.status));
  }

  const started = await startResponse.json() as { sessionId?: string };
  const sessionId = started.sessionId?.trim();
  if (!sessionId) {
    throw new Error("Scout voice did not return a session id.");
  }

  let finalized = false;
  let resolveResult!: (final: ScoutVoiceLiveFinal) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<ScoutVoiceLiveFinal>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let resultTimeout: ReturnType<typeof setTimeout> | null = null;
  const armResultTimeout = () => {
    if (resultTimeout) window.clearTimeout(resultTimeout);
    resultTimeout = window.setTimeout(() => {
      settleError(new Error("Scout voice transcription timed out. Try again or check voice settings."));
    }, SCOUT_VOICE_RESULT_TIMEOUT_MS);
  };
  const clearResultTimeout = () => {
    if (!resultTimeout) return;
    window.clearTimeout(resultTimeout);
    resultTimeout = null;
  };

  const settleError = (error: Error, state: ScoutVoiceSessionState = "error") => {
    if (finalized) return;
    finalized = true;
    clearResultTimeout();
    eventSource.close();
    callbacks.onState?.(state);
    rejectResult(error);
  };

  const settleFinal = (final: ScoutVoiceLiveFinal) => {
    if (finalized) return;
    finalized = true;
    clearResultTimeout();
    eventSource.close();
    callbacks.onFinal?.(final);
    callbacks.onState?.("done");
    resolveResult(final);
  };

  const eventSource = new EventSource(`/api/voice/session/${encodeURIComponent(sessionId)}/events`);
  const onNamedEvent = (eventName: ScoutVoiceSessionState | "session.partial" | "session.final" | "session.error" | "session.cancelled") => {
    return (event: MessageEvent<string>) => {
      if (finalized) return;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      if (eventName === "session.partial") {
        const text = typeof payload.text === "string" ? payload.text : "";
        callbacks.onPartial?.(text);
        return;
      }

      if (eventName === "session.state") {
        const state = normalizeScoutVoiceSessionState(payload.state);
        if (state) {
          callbacks.onState?.(state);
          if (state === "processing") armResultTimeout();
        }
        return;
      }

      if (eventName === "session.final") {
        settleFinal({
          sessionId,
          text: typeof payload.text === "string" ? payload.text.trim() : "",
          durationMs: Number(payload.durationMs ?? 0),
        });
        return;
      }

      if (eventName === "session.cancelled") {
        settleError(cancelledVoiceError(), "cancelled");
        return;
      }

      if (eventName === "session.error") {
        const message = typeof payload.message === "string"
          ? payload.message
          : "Scout voice session failed.";
        const code = typeof payload.code === "string" ? payload.code : null;
        settleError(new Error(friendlySessionError(message, code)));
      }
    };
  };

  eventSource.addEventListener("session.started", () => {
    callbacks.onState?.("starting");
  });
  eventSource.addEventListener("session.state", onNamedEvent("session.state"));
  eventSource.addEventListener("session.partial", onNamedEvent("session.partial"));
  eventSource.addEventListener("session.final", onNamedEvent("session.final"));
  eventSource.addEventListener("session.cancelled", onNamedEvent("session.cancelled"));
  eventSource.addEventListener("session.error", onNamedEvent("session.error"));
  eventSource.onerror = () => {
    if (finalized) return;
    settleError(new Error("Scout voice event stream disconnected."));
  };

  return {
    get sessionId() {
      return sessionId;
    },
    result,
    stop: async () => {
      callbacks.onState?.("processing");
      armResultTimeout();
      const response = await fetch(`/api/voice/session/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new Error(parseScoutVoiceError(raw, response.status));
      }
    },
    cancel: async () => {
      finalized = true;
      clearResultTimeout();
      eventSource.close();
      const response = await fetch(`/api/voice/session/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new Error(parseScoutVoiceError(raw, response.status));
      }
      callbacks.onState?.("cancelled");
      rejectResult(cancelledVoiceError());
    },
  };
}

async function startBrowserScoutVoiceLive(
  callbacks: ScoutVoiceLiveCallbacks = {},
): Promise<ScoutVoiceLiveHandle> {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Scout voice capture is unavailable in this browser.");
  }

  // Lazy import keeps the voice client light for non-composer call sites.
  const { startStreamLevelMeter } = await import("./voice-levels.ts");

  const sessionId = createSessionId();
  const chunks: Blob[] = [];
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let levelMeter: { stop: () => void } | null = null;
  let cancelled = false;
  let finalized = false;

  let resolveResult!: (final: ScoutVoiceLiveFinal) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<ScoutVoiceLiveFinal>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const stopTracks = () => {
    levelMeter?.stop();
    levelMeter = null;
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    stream = null;
  };

  const settleError = (error: Error, state: ScoutVoiceSessionState = "error") => {
    if (finalized) return;
    finalized = true;
    stopTracks();
    callbacks.onState?.(state);
    rejectResult(error);
  };

  const finalizeRecording = async () => {
    if (finalized) return;
    stopTracks();
    if (cancelled) {
      settleError(cancelledVoiceError(), "cancelled");
      return;
    }
    callbacks.onState?.("processing");
    const mimeType = recorder?.mimeType || preferredRecordingMimeType() || "application/octet-stream";
    const audio = new Blob(chunks, { type: mimeType });
    if (audio.size === 0) {
      settleError(new Error("No voice audio was captured."));
      return;
    }
    try {
      const final = await transcribeScoutVoiceAudio(audio, { sessionId });
      if (finalized) return;
      finalized = true;
      callbacks.onFinal?.(final);
      callbacks.onState?.("done");
      resolveResult(final);
    } catch (error) {
      settleError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  try {
    callbacks.onState?.("starting");
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (callbacks.onLevel) {
      levelMeter = startStreamLevelMeter(stream, callbacks.onLevel);
    }
    const mimeType = preferredRecordingMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      settleError(new Error("Scout voice recorder failed."));
    });
    recorder.addEventListener("stop", () => {
      void finalizeRecording();
    }, { once: true });
    recorder.start();
    callbacks.onPartial?.("");
    callbacks.onState?.("recording");
  } catch (error) {
    const startError = error instanceof Error ? error : new Error(String(error));
    settleError(startError);
    void result.catch(() => undefined);
    throw startError;
  }

  return {
    get sessionId() {
      return sessionId;
    },
    result,
    stop: async () => {
      if (!recorder || recorder.state === "inactive") return;
      recorder.stop();
    },
    cancel: async () => {
      cancelled = true;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
        return;
      }
      settleError(cancelledVoiceError(), "cancelled");
    },
  };
}

function normalizeScoutVoiceSessionState(value: unknown): ScoutVoiceSessionState | null {
  if (value === "starting" || value === "recording" || value === "processing" || value === "done" || value === "cancelled" || value === "error") {
    return value;
  }
  return null;
}

function parseScoutVoiceError(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    return parsed.error ?? `Scout voice returned HTTP ${status}`;
  } catch {
    return raw || `Scout voice returned HTTP ${status}`;
  }
}

export function isScoutSpeechStopped(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function prepareScoutSpeech(
  text: string,
  options: ScoutSpeechOptions = {},
): Promise<ScoutSpeechResult> {
  const body: Record<string, unknown> = {
    text,
    speed: normalizeSpeechSpeed(options.speed),
  };
  if (options.modelId) body.modelId = options.modelId;
  if (options.voiceId) body.voiceId = options.voiceId;
  if (options.originAppId) body.originAppId = options.originAppId;
  if (options.utteranceId) body.utteranceId = options.utteranceId;
  if (options.instructions) body.instructions = options.instructions;
  if (options.speechTiming?.enabled) body.speechTiming = options.speechTiming;

  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      throw new Error(parsed.error ?? `Scout voice returned HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(raw || `Scout voice returned HTTP ${response.status}`);
      }
      throw error;
    }
  }
  return await response.json() as ScoutSpeechResult;
}

export async function fetchScoutSpeechCatalog(modelId?: string): Promise<ScoutSpeechCatalog> {
  const query = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
  const response = await fetch(`/api/voice/catalog${query}`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Scout voice catalog returned HTTP ${response.status}`);
  }
  return await response.json() as ScoutSpeechCatalog;
}

export async function playPreparedScoutSpeech(
  result: ScoutSpeechResult,
  options: { signal?: AbortSignal; onPlaybackStart?: () => void } = {},
): Promise<ScoutSpeechResult> {
  if (options.signal?.aborted) throw stoppedSpeechError();
  const audio = new Audio(`data:${result.contentType};base64,${result.audioBase64}`);
  const stopPlayback = () => {
    audio.pause();
    audio.currentTime = 0;
  };
  options.signal?.addEventListener("abort", stopPlayback, { once: true });
  await audio.play();
  options.onPlaybackStart?.();
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Scout voice playback failed."));
      };
      const onAbort = () => {
        cleanup();
        reject(stoppedSpeechError());
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      audio.addEventListener("ended", onEnded, { once: true });
      audio.addEventListener("error", onError, { once: true });
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return result;
  } finally {
    options.signal?.removeEventListener("abort", stopPlayback);
  }
}

export async function speakWithScoutVoice(
  text: string,
  options: ScoutSpeechOptions = {},
): Promise<ScoutSpeechResult> {
  const result = await prepareScoutSpeech(text, options);
  return await playPreparedScoutSpeech(result, { signal: options.signal });
}

export function startScoutSpeech(text: string, options: Omit<ScoutSpeechOptions, "signal"> = {}): ScoutSpeechHandle {
  const controller = new AbortController();
  return {
    promise: speakWithScoutVoice(text, { ...options, signal: controller.signal }),
    stop: () => controller.abort(),
  };
}

export type ScoutSpeakWithEffectsOptions = ScoutSpeechOptions & {
  presetId?: string;
  params?: Partial<VoiceFxParams>;
};

export async function speakWithEffects(
  text: string,
  options: ScoutSpeakWithEffectsOptions = {},
): Promise<ScoutSpeechResult> {
  const result = await prepareScoutSpeech(text, options);
  if (options.signal?.aborted) throw stoppedSpeechError();
  const buffer = await decodeAudioFromBase64(result.audioBase64, result.contentType);
  const params = resolveVoiceFxParams(options.presetId, options.params);
  const handle = playWithVoiceFx(buffer, { params, signal: options.signal });
  await handle.promise;
  return result;
}

export async function playPreparedScoutSpeechWithEffects(
  result: ScoutSpeechResult,
  options: { signal?: AbortSignal; presetId?: string; params?: Partial<VoiceFxParams>; onPlaybackStart?: () => void } = {},
): Promise<ScoutSpeechResult> {
  if (options.signal?.aborted) throw stoppedSpeechError();
  const buffer = await decodeAudioFromBase64(result.audioBase64, result.contentType);
  const params = resolveVoiceFxParams(options.presetId, options.params);
  const handle = playWithVoiceFx(buffer, { params, signal: options.signal });
  options.onPlaybackStart?.();
  await handle.promise;
  return result;
}

export function startScoutSpeechWithEffects(
  text: string,
  options: Omit<ScoutSpeakWithEffectsOptions, "signal"> = {},
): ScoutSpeechHandle {
  const controller = new AbortController();
  return {
    promise: speakWithEffects(text, { ...options, signal: controller.signal }),
    stop: () => controller.abort(),
  };
}

async function transcribeScoutVoiceAudio(
  audio: Blob,
  input: { sessionId: string },
): Promise<ScoutVoiceLiveFinal> {
  const form = new FormData();
  const format = audioFormatForMimeType(audio.type);
  form.append("audio", audio, `audio.${extensionForMimeType(audio.type)}`);
  form.append("sessionId", input.sessionId);
  if (format) form.append("format", format);

  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      throw new Error(parsed.error ?? `Scout voice returned HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(raw || `Scout voice returned HTTP ${response.status}`);
      }
      throw error;
    }
  }
  const result = await response.json() as { text?: string; durationMs?: number };
  return {
    sessionId: input.sessionId,
    text: result.text?.trim() ?? "",
    durationMs: Number(result.durationMs ?? 0),
  };
}

function stoppedSpeechError(): Error {
  const error = new Error("Speech stopped.");
  error.name = "AbortError";
  return error;
}

function cancelledVoiceError(): Error {
  const error = new Error("Voice recording was cancelled.");
  error.name = "AbortError";
  return error;
}

function preferredRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4",
    "audio/webm",
    "audio/wav",
  ];
  return candidates.find((candidate) => {
    try {
      return MediaRecorder.isTypeSupported(candidate);
    } catch {
      return false;
    }
  });
}

function audioFormatForMimeType(mimeType: string): string | undefined {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mp3") || normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("aac") || normalized.includes("mp4")) return "aac";
  if (normalized.includes("opus") || normalized.includes("ogg") || normalized.includes("webm")) return "opus";
  return undefined;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("ogg") || normalized.includes("opus")) return "opus";
  if (normalized.includes("mp4") || normalized.includes("aac")) return "m4a";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mp3") || normalized.includes("mpeg")) return "mp3";
  return "audio";
}

function resolveVoiceFxParams(
  presetId: string | undefined,
  override: Partial<VoiceFxParams> | undefined,
): VoiceFxParams {
  const presetParams = presetId
    ? VOICE_FX_PRESETS.find((p) => p.id === presetId)?.params
    : undefined;
  return {
    ...DEFAULT_VOICE_FX,
    ...(presetParams ?? {}),
    ...(override ?? {}),
  };
}

function normalizeSpeechSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined || !Number.isFinite(speed)) return undefined;
  return Math.min(2, Math.max(0.5, Number(speed.toFixed(2))));
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `scout-voice:${crypto.randomUUID()}`;
  }
  return `scout-voice:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export async function fetchScoutVoiceSettings(): Promise<{
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
}> {
  const response = await fetch("/api/voice/settings");
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(parseScoutVoiceError(raw, response.status));
  }
  return await response.json() as {
    settings: ScoutVoiceSettings;
    devices: ScoutVoiceInputDevice[];
  };
}

export async function openScoutVoicePrivacySettings(
  kind: "microphone" | "speechRecognition" = "microphone",
): Promise<void> {
  const response = await fetch("/api/voice/permissions/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(parseScoutVoiceError(raw, response.status));
  }
}

export async function requestScoutVoicePermissions(
  kind: "microphone" | "speechRecognition" = "microphone",
): Promise<void> {
  const response = await fetch("/api/voice/permissions/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(parseScoutVoiceError(raw, response.status));
  }
}

export type ScoutVoiceSessionHistoryEntry = {
  sessionId: string;
  status: string;
  surface: string;
  clientId: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  eventCount: number;
  lastEvent: string | null;
  lastTranscript: string | null;
};

export async function fetchScoutVoiceHistory(limit = 12): Promise<ScoutVoiceSessionHistoryEntry[]> {
  const response = await fetch(`/api/voice/history?limit=${limit}`);
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(parseScoutVoiceError(raw, response.status));
  }
  const body = await response.json() as { sessions?: ScoutVoiceSessionHistoryEntry[] };
  return body.sessions ?? [];
}

export async function saveScoutVoiceSettings(
  patch: Partial<Pick<ScoutVoiceSettings, "preference" | "inputDeviceId">>,
): Promise<{
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
}> {
  const response = await fetch("/api/voice/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(parseScoutVoiceError(raw, response.status));
  }
  return await response.json() as {
    settings: ScoutVoiceSettings;
    devices: ScoutVoiceInputDevice[];
  };
}
