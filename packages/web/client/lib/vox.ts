// Legacy browser-side Vox adapter. Product UI should use `scout-voice.ts`
// and `/api/voice/*` so Scout owns the web voice contract.
import {
  createVoxdClient,
  VoxDError,
  type LiveSession,
  type SessionFinalEvent,
  type SessionState,
} from "@voxd/client";
import {
  DEFAULT_VOICE_FX,
  VOICE_FX_PRESETS,
  decodeAudioFromBase64,
  playWithVoiceFx,
  type VoiceFxParams,
} from "@voxd/client/fx";

export type VoxConnectionState = "unknown" | "probing" | "connected" | "unavailable";

export type VoxSessionState = SessionState;

export type VoxLiveFinal = {
  sessionId: string;
  text: string;
  durationMs: number;
};

export type VoxLiveHandle = {
  readonly sessionId: string | null;
  result: Promise<VoxLiveFinal>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
};

export type VoxLiveCallbacks = {
  onState?: (state: VoxSessionState) => void;
  onPartial?: (text: string) => void;
  onFinal?: (final: VoxLiveFinal) => void;
};

export type VoxSpeakResult = {
  contentType: string;
  audioBase64: string;
  modelId: string;
  voiceId: string;
  audioBytes: number;
  metrics?: Record<string, unknown>;
  traceId?: string;
  speechTiming?: VoxSpeechTimingResult;
};

export type VoxSpeakHandle = {
  promise: Promise<VoxSpeakResult>;
  stop: () => void;
};

export type VoxSpeakOptions = {
  signal?: AbortSignal;
  speed?: number;
  instructions?: string;
  originAppId?: string;
  utteranceId?: string;
  speechTiming?: VoxSpeechTimingRequest;
};

export type VoxSpeechTimingCueRequest = {
  id: string;
  textStart?: number;
  textEnd?: number;
  text?: string;
};

export type VoxSpeechTimingRequest = {
  enabled: true;
  modelId?: string;
  strict?: boolean;
  cues?: VoxSpeechTimingCueRequest[];
};

export type VoxSpeechTimingWord = {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  sourceTextStart?: number;
  sourceTextEnd?: number;
};

export type VoxSpeechTimingCueResult = {
  id: string;
  startMs: number;
  endMs?: number;
  confidence?: number;
  source?: string;
};

export type VoxSpeechTimingResult = {
  source?: string;
  modelId?: string;
  elapsedMs?: number;
  words?: VoxSpeechTimingWord[];
  cues?: VoxSpeechTimingCueResult[];
};

export type VoxLaunchOptions = {
  source?: string;
  returnTo?: string;
  context?: VoxLaunchContext;
};

export type VoxLaunchContext = {
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

const DEFAULT_VOX_BRIDGE = "http://127.0.0.1:43115";
const VOX_CLIENT_ID = "openscout-web";

export function shouldAutoProbeVoxBridge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  // The browser-side Vox bridge is local HTTP. Probing it automatically from an
  // HTTPS Scout page downgrades Chrome's page security state even though the
  // Scout document and assets are served securely.
  return window.location.protocol !== "https:";
}

export class VoxBrowserClient {
  private state: VoxConnectionState = "unknown";
  private unavailableReason: string | null = null;
  private client: ReturnType<typeof createVoxdClient>;

  constructor(private readonly baseUrl = DEFAULT_VOX_BRIDGE) {
    this.client = this.createClient();
  }

  get connectionState(): VoxConnectionState {
    return this.state;
  }

  get lastUnavailableReason(): string | null {
    return this.unavailableReason;
  }

  async probe(timeoutMs = 1200): Promise<boolean> {
    this.state = "probing";
    this.unavailableReason = null;
    this.client = this.createClient(timeoutMs);

    try {
      const healthy = await this.client.probe();
      if (!healthy) {
        this.state = "unavailable";
        return false;
      }

      await this.client.capabilities();
      this.state = "connected";
      return true;
    } catch (error) {
      this.state = "unavailable";
      this.unavailableReason = humanVoxError(error);
      return false;
    }
  }

  launch(options: VoxLaunchOptions = {}): void {
    window.location.href = buildVoxUrl("launch", {
      source: options.source,
      returnTo: options.returnTo ?? currentBrowserOrigin(),
      context: encodeLaunchContext(options.context),
    });
  }

  openSettings(options: VoxLaunchOptions = {}): void {
    window.location.href = buildVoxUrl("settings", {
      source: options.source,
      returnTo: options.returnTo ?? currentBrowserOrigin(),
      context: encodeLaunchContext(options.context),
    });
  }

  async startLive(callbacks: VoxLiveCallbacks = {}): Promise<VoxLiveHandle> {
    const session = this.client.createLiveSession();
    let final: VoxLiveFinal | null = null;
    bindLiveCallbacks(session, callbacks, (next) => {
      final = next;
    });
    const result = session.start({ modelId: "parakeet:v3" })
      .then((event) => {
        final ??= normalizeFinal(event);
        return final;
      })
      .catch((error) => {
        throw new Error(humanVoxError(error));
      });

    return {
      get sessionId() {
        return session.id;
      },
      result,
      stop: async () => {
        await session.stop();
      },
      cancel: async () => {
        await session.cancel().catch(() => undefined);
      },
    };
  }

  private createClient(probeTimeout = 1200) {
    return createVoxdClient({
      baseUrl: this.baseUrl,
      clientId: VOX_CLIENT_ID,
      probeTimeout,
    });
  }
}

function stoppedSpeechError(): Error {
  const error = new Error("Speech stopped.");
  error.name = "AbortError";
  return error;
}

export function isVoxSpeechStopped(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function prepareVoxSpeech(
  text: string,
  options: VoxSpeakOptions = {},
): Promise<VoxSpeakResult> {
  const body: Record<string, unknown> = {
    text,
    speed: normalizeSpeechSpeed(options.speed),
  };
  if (options.originAppId) {
    body.originAppId = options.originAppId;
  }
  if (options.utteranceId) {
    body.utteranceId = options.utteranceId;
  }
  if (options.instructions) {
    body.instructions = options.instructions;
  }
  if (options.speechTiming?.enabled) {
    body.speechTiming = options.speechTiming;
  }
  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(body) as { error?: string };
      throw new Error(parsed.error ?? `Voice returned HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(body || `Voice returned HTTP ${response.status}`);
      }
      throw error;
    }
  }
  return await response.json() as VoxSpeakResult;
}

export async function playPreparedVoxSpeech(
  result: VoxSpeakResult,
  options: { signal?: AbortSignal; onPlaybackStart?: () => void } = {},
): Promise<VoxSpeakResult> {
  if (options.signal?.aborted) {
    throw stoppedSpeechError();
  }
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
        reject(new Error("Vox audio playback failed."));
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

export async function speakWithVox(
  text: string,
  options: VoxSpeakOptions = {},
): Promise<VoxSpeakResult> {
  const result = await prepareVoxSpeech(text, options);
  return await playPreparedVoxSpeech(result, { signal: options.signal });
}

export function startVoxSpeech(text: string, options: Omit<VoxSpeakOptions, "signal"> = {}): VoxSpeakHandle {
  const controller = new AbortController();
  return {
    promise: speakWithVox(text, { ...options, signal: controller.signal }),
    stop: () => controller.abort(),
  };
}

// ─── FX-aware speak path ──────────────────────────────────────────────
// Same shape as speakWithVox / startVoxSpeech, but pipes the synthesized
// audio through @voxd/client/fx before playback. Pick a preset by id
// (one of VOICE_FX_PRESETS), or pass `params` to override individual
// knobs (merged on top of the preset / DEFAULT_VOICE_FX).
//
// Synthesis still flows through /api/voice/speak — Vox is unaware of
// any FX; the engine is pure post-decode mastering in the browser.

export type VoxSpeakWithEffectsOptions = VoxSpeakOptions & {
  presetId?: string;
  params?: Partial<VoiceFxParams>;
};

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

export async function speakWithEffects(
  text: string,
  options: VoxSpeakWithEffectsOptions = {},
): Promise<VoxSpeakResult> {
  const result = await prepareVoxSpeech(text, options);
  if (options.signal?.aborted) throw stoppedSpeechError();
  const buffer = await decodeAudioFromBase64(result.audioBase64, result.contentType);
  const params = resolveVoiceFxParams(options.presetId, options.params);
  const handle = playWithVoiceFx(buffer, { params, signal: options.signal });
  await handle.promise;
  return result;
}

// FX-aware companion to playPreparedVoxSpeech, for the brief pre-render→play
// flow. Takes the already-synthesized audio result and pipes it through the
// effects chain instead of `new Audio(...)`.
export async function playPreparedVoxSpeechWithEffects(
  result: VoxSpeakResult,
  options: { signal?: AbortSignal; presetId?: string; params?: Partial<VoiceFxParams>; onPlaybackStart?: () => void } = {},
): Promise<VoxSpeakResult> {
  if (options.signal?.aborted) throw stoppedSpeechError();
  const buffer = await decodeAudioFromBase64(result.audioBase64, result.contentType);
  const params = resolveVoiceFxParams(options.presetId, options.params);
  const handle = playWithVoiceFx(buffer, { params, signal: options.signal });
  options.onPlaybackStart?.();
  await handle.promise;
  return result;
}

export function startVoxSpeechWithEffects(
  text: string,
  options: Omit<VoxSpeakWithEffectsOptions, "signal"> = {},
): VoxSpeakHandle {
  const controller = new AbortController();
  return {
    promise: speakWithEffects(text, { ...options, signal: controller.signal }),
    stop: () => controller.abort(),
  };
}

function normalizeSpeechSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined || !Number.isFinite(speed)) return undefined;
  return Math.min(2, Math.max(0.5, Number(speed.toFixed(2))));
}

function bindLiveCallbacks(
  session: LiveSession,
  callbacks: VoxLiveCallbacks,
  updateFinal: (final: VoxLiveFinal) => void,
): void {
  session.onState((event) => callbacks.onState?.(event.state));
  session.onPartial((event) => callbacks.onPartial?.(event.text));
  session.onFinal((event) => {
    const final = normalizeFinal(event);
    updateFinal(final);
    callbacks.onFinal?.(final);
  });
}

function normalizeFinal(raw: SessionFinalEvent): VoxLiveFinal {
  return {
    sessionId: raw.sessionId,
    text: raw.text.trim(),
    durationMs: raw.durationMs,
  };
}

function buildVoxUrl(host: "launch" | "settings", params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `vox://${host}?${query}` : `vox://${host}`;
}

function encodeLaunchContext(context: VoxLaunchContext | undefined): string | undefined {
  if (!context) return undefined;
  return JSON.stringify(context);
}

function currentBrowserOrigin(): string | undefined {
  try {
    return window.location.origin;
  } catch {
    return undefined;
  }
}

function humanVoxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof VoxDError && error.code === "http_error" && /origin not allowed/i.test(message)) {
    return "Vox blocked this OpenScout URL. Restart OpenScout so it can register its Vox browser origin, then try again.";
  }
  if (/origin not allowed/i.test(message)) {
    return "Vox blocked this OpenScout URL. Restart OpenScout so it can register its Vox browser origin, then try again.";
  }
  return message || "Vox request failed.";
}
