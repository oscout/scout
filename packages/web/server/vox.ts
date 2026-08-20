// Local runtime adapter used by `scout-voice.ts`. Route handlers should expose
// Scout voice semantics and keep Vox-specific details behind that boundary.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const VOX_CLIENT_ID = "openscout-web";
const DEFAULT_VOX_RPC_PORT = 42137;
const DEFAULT_VOX_RPC_HOST = "127.0.0.1";
const VOX_RPC_TIMEOUT_MS = 300_000;
const DEFAULT_VOX_SYNTHESIS_MODEL_ID = "avspeech:system";
const DEFAULT_VOX_SPEECH_TIMING_MODEL_ID = "parakeet:v3";
const OPENSCOUT_VOX_ORIGINS = [
  "http://127.0.0.1:*",
  "http://localhost:*",
  "http://[::1]:*",
  "https://127.0.0.1:*",
  "https://localhost:*",
  "https://[::1]:*",
];

export type VoxSpeechResult = {
  contentType: string;
  audioBase64: string;
  modelId: string;
  voiceId: string;
  audioBytes: number;
  metrics?: Record<string, unknown>;
  traceId?: string;
  speechTiming?: VoxSpeechTimingResult;
};

export type VoxSpeechDefaults = {
  modelId: string;
  voiceId?: string;
};

export type VoxSpeechModel = {
  id: string;
  name: string;
  provider: string;
  available: boolean;
};

export type VoxSpeechVoice = {
  id: string;
  name: string;
  language?: string;
  provider: string;
  modelId: string;
  available: boolean;
  isDefault: boolean;
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

export async function synthesizeVoxSpeech(input: {
  text: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  instructions?: string;
  originAppId?: string;
  utteranceId?: string;
  speechTiming?: VoxSpeechTimingRequest;
  signal?: AbortSignal;
}): Promise<VoxSpeechResult> {
  const defaults = resolveVoxSpeechDefaults();
  const modelId = input.modelId ?? defaults.modelId;
  const voiceId = input.voiceId ?? (modelId === defaults.modelId ? defaults.voiceId : undefined);
  const params: Record<string, unknown> = {
    clientId: VOX_CLIENT_ID,
    text: input.text,
    modelId,
    voiceId,
    format: "wav",
    speed: input.speed,
  };
  if (input.instructions) {
    params.instructions = input.instructions;
  }
  if (input.originAppId) {
    params.originAppId = input.originAppId;
  }
  if (input.utteranceId) {
    params.utteranceId = input.utteranceId;
  }
  if (input.speechTiming?.enabled) {
    params.speechTiming = {
      enabled: true,
      modelId: input.speechTiming.modelId ?? DEFAULT_VOX_SPEECH_TIMING_MODEL_ID,
      strict: input.speechTiming.strict ?? false,
      ...(input.speechTiming.cues ? { cues: input.speechTiming.cues } : {}),
    };
  }
  const result = await callVoxRpc("synthesize.generate", params, { signal: input.signal });

  const audioBase64 = stringValue(result.audioBase64);
  if (!audioBase64) {
    throw new Error("Vox returned no audio.");
  }

  const metrics = recordValue(result.metrics);
  const traceId = stringValue(metrics?.traceId);
  const speechTiming = recordValue(result.speechTiming) as VoxSpeechTimingResult | undefined;

  return {
    contentType: stringValue(result.contentType) || "audio/wav",
    audioBase64,
    modelId: stringValue(result.modelId) || modelId,
    voiceId: stringValue(result.voiceId) || voiceId || "",
    audioBytes: Number(result.audioBytes ?? 0),
    ...(metrics ? { metrics } : {}),
    ...(traceId ? { traceId } : {}),
    ...(speechTiming ? { speechTiming } : {}),
  };
}

export async function listVoxSpeechModels(signal?: AbortSignal): Promise<VoxSpeechModel[]> {
  const result = await callVoxRpc("synthesize.models", {}, { signal, timeoutMs: 4_000 });
  const models = Array.isArray(result.models) ? result.models : [];
  return models.flatMap((value) => {
    const record = recordValue(value);
    const id = stringValue(record?.id);
    const name = stringValue(record?.name);
    if (!id || !name) return [];
    return [{
      id,
      name,
      provider: stringValue(record?.backend) || providerForSpeechModel(id),
      available: record?.available !== false,
    }];
  });
}

export async function listVoxSpeechVoices(
  modelId: string,
  signal?: AbortSignal,
): Promise<VoxSpeechVoice[]> {
  const result = await callVoxRpc("synthesize.voices", { modelId }, { signal, timeoutMs: 4_000 });
  const voices = Array.isArray(result.voices) ? result.voices : [];
  return voices.flatMap((value) => {
    const record = recordValue(value);
    const id = stringValue(record?.id);
    const name = stringValue(record?.name);
    if (!id || !name) return [];
    const resolvedModelId = stringValue(record?.modelId) || modelId;
    return [{
      id,
      name,
      ...(stringValue(record?.language) ? { language: stringValue(record?.language) } : {}),
      provider: stringValue(record?.backend) || providerForSpeechModel(resolvedModelId),
      modelId: resolvedModelId,
      available: record?.available !== false,
      isDefault: record?.default === true,
    }];
  });
}

export function resolveVoxSpeechDefaults(env: NodeJS.ProcessEnv = process.env): VoxSpeechDefaults {
  const modelOverride = firstNonEmptyString(
    env.OPENSCOUT_VOX_TTS_MODEL_ID,
    env.VOX_TTS_MODEL_ID,
  );
  const voiceOverride = firstNonEmptyString(
    env.OPENSCOUT_VOX_TTS_VOICE_ID,
    env.VOX_TTS_VOICE_ID,
  );
  const voxHome = resolveVoxHome(env);
  const preferences = readJsonRecord(join(voxHome, "preferences.json"));
  const preferredModel = modelOverride
    ?? nestedString(preferences, "speech", "preferredSynthesisModelId");
  const preferredVoice = voiceOverride
    ?? nestedString(preferences, "speech", "preferredSynthesisVoiceId");
  const providers = readVoxTtsProviders(join(voxHome, "providers.json"));
  const modelId = preferredModel
    ?? modelForPreferredVoice(providers, preferredVoice)
    ?? firstConfiguredNonAppleTtsModel(providers)
    ?? DEFAULT_VOX_SYNTHESIS_MODEL_ID;
  const voiceId = preferredVoice
    ?? defaultVoiceForModel(providers, modelId);

  return {
    modelId,
    ...(voiceId ? { voiceId } : {}),
  };
}

export function ensureOpenScoutVoxOrigins(): void {
  const originsPath = resolveOpenScoutVoxOriginsPath();
  const body = `${JSON.stringify({ origins: OPENSCOUT_VOX_ORIGINS }, null, 2)}\n`;

  try {
    if (existsSync(originsPath) && readFileSync(originsPath, "utf8") === body) {
      return;
    }

    mkdirSync(dirname(originsPath), { recursive: true });
    writeFileSync(originsPath, body, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vox] Could not register OpenScout browser origins: ${message}`);
  }
}

function resolveOpenScoutVoxOriginsPath(): string {
  return join(resolveVoxHome(), "origins.d", "openscout.json");
}

function resolveVoxHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.VOX_HOME ?? join(homedir(), ".vox");
}

export function resolveVoxRpcPort(): number {
  const runtimePath = process.env.VOX_RUNTIME_PATH ?? join(resolveVoxHome(), "runtime.json");
  if (!existsSync(runtimePath)) {
    const port = Number(process.env.VOX_PORT);
    return Number.isFinite(port) && port > 0 ? port : DEFAULT_VOX_RPC_PORT;
  }

  try {
    const parsed = JSON.parse(readFileSync(runtimePath, "utf8")) as { port?: unknown };
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : DEFAULT_VOX_RPC_PORT;
  } catch {
    return DEFAULT_VOX_RPC_PORT;
  }
}

async function callVoxRpc(
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? VOX_RPC_TIMEOUT_MS;
  const port = resolveVoxRpcPort();
  const socket = new WebSocket(`ws://${DEFAULT_VOX_RPC_HOST}:${port}`);
  const id = randomUUID();

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    };

    const onAbort = () => {
      cleanup();
      reject(abortError(`Vox ${method} aborted.`));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Vox ${method} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.onopen = () => {
      socket.send(JSON.stringify({ id, method, params }));
    };

    socket.onmessage = (event) => {
      const payload = parseRpcPayload(event.data);
      if (!payload || payload.id !== id) return;
      cleanup();
      if (payload.error) {
        reject(new Error(typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error)));
        return;
      }
      resolve(payload.result && typeof payload.result === "object"
        ? payload.result as Record<string, unknown>
        : {});
    };

    socket.onerror = () => {
      cleanup();
      reject(new Error(`Could not connect to Vox on port ${port}.`));
    };

    socket.onclose = () => {
      cleanup();
      reject(new Error("Vox closed the connection before returning a result."));
    };
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function parseRpcPayload(data: unknown): Record<string, unknown> | null {
  const raw = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function providerForSpeechModel(modelId: string): string {
  const normalized = modelId.toLowerCase();
  if (normalized.startsWith("gpt-") || normalized.startsWith("tts-")) return "openai";
  if (normalized.startsWith("eleven_")) return "elevenlabs";
  if (normalized.startsWith("avspeech:")) return "system";
  return normalized.includes(":") ? normalized.split(":", 1)[0] ?? "vox" : "vox";
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nestedString(
  record: Record<string, unknown> | null,
  section: string,
  key: string,
): string | undefined {
  const parent = record?.[section];
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
    return undefined;
  }
  const value = (parent as Record<string, unknown>)[key];
  return typeof value === "string" ? firstNonEmptyString(value) : undefined;
}

type VoxProviderConfig = {
  kind?: string;
  models: string[];
  env: Record<string, string>;
};

function readVoxTtsProviders(filePath: string): VoxProviderConfig[] {
  const parsed = readJsonRecord(filePath);
  const providers = Array.isArray(parsed?.providers) ? parsed.providers : [];
  const ttsProviders: VoxProviderConfig[] = [];

  for (const provider of providers) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      continue;
    }

    const record = provider as Record<string, unknown>;
    const kind = firstNonEmptyString(String(record.kind ?? ""));
    if ((kind ?? "asr") !== "tts") {
      continue;
    }

    const models = Array.isArray(record.models)
      ? record.models.map((model) => String(model).trim()).filter(Boolean)
      : [];
    const env = record.env && typeof record.env === "object" && !Array.isArray(record.env)
      ? Object.fromEntries(
        Object.entries(record.env as Record<string, unknown>)
          .map(([key, value]) => [key, String(value).trim()])
          .filter(([, value]) => Boolean(value)),
      )
      : {};

    ttsProviders.push({ kind, models, env });
  }

  return ttsProviders;
}

function modelForPreferredVoice(
  providers: VoxProviderConfig[],
  preferredVoice: string | undefined,
): string | undefined {
  if (!preferredVoice) {
    return undefined;
  }

  for (const provider of providers) {
    if (provider.env.VOX_MLX_AUDIO_TTS_DEFAULT_VOICE === preferredVoice && provider.models[0]) {
      return provider.models[0];
    }
  }

  if (/^(af|am)_/.test(preferredVoice)) {
    return providers
      .flatMap((provider) => provider.models)
      .find((model) => model.toLowerCase().includes("kokoro"));
  }

  return undefined;
}

function firstConfiguredNonAppleTtsModel(providers: VoxProviderConfig[]): string | undefined {
  return providers
    .flatMap((provider) => provider.models)
    .find((model) => model !== DEFAULT_VOX_SYNTHESIS_MODEL_ID);
}

function defaultVoiceForModel(
  providers: VoxProviderConfig[],
  modelId: string,
): string | undefined {
  const provider = providers.find((entry) => entry.models.includes(modelId));
  return firstNonEmptyString(provider?.env.VOX_MLX_AUDIO_TTS_DEFAULT_VOICE);
}
