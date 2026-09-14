import {
  getScoutVoiceHealthSnapshot,
  ScoutVoiceSessionError,
  synthesizeScoutVoiceSpeech,
  type ScoutVoiceHealthSnapshot,
  type ScoutVoiceSpeechResult,
  type ScoutVoiceSpeechTimingCueRequest,
  type ScoutVoiceSpeechTimingRequest,
} from "./scout-voice-session.ts";
import {
  NVIDIA_MAGPIE_DEFAULT_VOICE,
  NVIDIA_MAGPIE_MODEL,
  listNvidiaMagpieVoices,
} from "./nvidia-speech.ts";
import type { ScoutVoicePlayback } from "../shared/voice-playback.ts";

export type ScoutVoiceHealth = ScoutVoiceHealthSnapshot;

export type ScoutVoiceTranscriptionResult = {
  text: string;
  durationMs: number;
  words?: Array<{ word: string; start: number; end: number }>;
  metrics?: Record<string, unknown>;
};

export type ScoutSpeechDefaults = {
  modelId: string;
  voiceId?: string;
};

export type ScoutSpeechTimingCueRequest = ScoutVoiceSpeechTimingCueRequest;
export type ScoutSpeechTimingRequest = ScoutVoiceSpeechTimingRequest;

export type ScoutSpeechModel = {
  id: string;
  name: string;
  provider: string;
  /** `null` means the native host has not been queried for credentials yet. */
  available: boolean | null;
};

export type ScoutSpeechVoice = {
  id: string;
  name: string;
  language?: string;
  provider: string;
  modelId: string;
  /** `null` means the native host has not been queried for credentials yet. */
  available: boolean | null;
  isDefault: boolean;
};

export type ScoutSpeechResult = ScoutVoiceSpeechResult;

export type ScoutSpeechCatalog = {
  defaultModelId: string;
  defaultVoiceId?: string;
  models: ScoutSpeechModel[];
  voices: ScoutSpeechVoice[];
  source: "scout-menu" | "nvidia-developer-inference" | "fallback";
};

const DEFAULT_SCOUT_SPEECH_MODEL_ID = "system";

export async function getScoutVoiceHealth(): Promise<ScoutVoiceHealth> {
  return getScoutVoiceHealthSnapshot();
}

export async function transcribeScoutVoiceAudio(_input: {
  audio: Blob | ArrayBuffer;
  modelId?: string;
  format?: "mp3" | "wav" | "aac" | "opus" | "pcm16";
  language?: string;
  timestamps?: boolean;
}): Promise<ScoutVoiceTranscriptionResult> {
  throw new ScoutVoiceSessionError(
    "uploaded_transcription_unsupported",
    "Uploaded-audio transcription is not supported by the Scout Menu voice host. Use a native voice session.",
    501,
  );
}

export async function synthesizeScoutSpeech(input: {
  text: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  instructions?: string;
  originAppId?: string;
  utteranceId?: string;
  speechTiming?: ScoutSpeechTimingRequest;
  playback?: ScoutVoicePlayback;
  signal?: AbortSignal;
}, env: NodeJS.ProcessEnv = process.env): Promise<ScoutSpeechResult> {
  if (input.speechTiming?.strict) {
    throw new ScoutVoiceSessionError(
      "speech_timing_unsupported",
      "Strict speech timing is not supported by the Scout Menu synthesis host.",
      501,
    );
  }
  const playback = input.playback ?? "browser";
  const resolved = resolveScoutSpeechRequest(input, env);
  // Spoken on host: the web's environment defaults do not apply. An explicit
  // model or voice from the request is honored; otherwise Scout Menu speaks
  // in the voice chosen in its own Settings › Voice (Kokoro included).
  const explicitModelId = input.modelId?.trim() || undefined;
  const explicitVoiceId = input.voiceId?.trim() || undefined;
  return await synthesizeScoutVoiceSpeech({
    text: input.text,
    modelId: playback === "host" ? explicitModelId : resolved.modelId,
    voiceId: playback === "host" ? explicitVoiceId : resolved.voiceId,
    speed: input.speed,
    instructions: input.instructions,
    originAppId: resolved.originAppId,
    utteranceId: resolved.utteranceId,
    speechTiming: input.speechTiming,
    playback,
    signal: input.signal,
  });
}

export function resolveScoutSpeechRequest(input: {
  modelId?: string;
  voiceId?: string;
  originAppId?: string;
  utteranceId?: string;
}, env: NodeJS.ProcessEnv = process.env): {
  modelId: string;
  voiceId?: string;
  originAppId?: string;
  utteranceId?: string;
} {
  const defaults = resolveScoutSpeechDefaults(env);
  const modelId = input.modelId?.trim() || defaults.modelId;
  const voiceId = input.voiceId?.trim()
    || (modelId === defaults.modelId ? defaults.voiceId : undefined);
  const originAppId = input.originAppId?.trim();
  const utteranceId = input.utteranceId?.trim();
  return {
    modelId,
    ...(voiceId ? { voiceId } : {}),
    ...(originAppId ? { originAppId } : {}),
    ...(utteranceId ? { utteranceId } : {}),
  };
}

export function resolveScoutSpeechDefaults(env: NodeJS.ProcessEnv = process.env): ScoutSpeechDefaults {
  const modelId = env.OPENSCOUT_VOICE_TTS_MODEL_ID?.trim() || DEFAULT_SCOUT_SPEECH_MODEL_ID;
  const voiceId = env.OPENSCOUT_VOICE_TTS_VOICE_ID?.trim();
  return {
    modelId,
    ...(voiceId ? { voiceId } : {}),
  };
}

export async function getScoutSpeechCatalog(input: {
  modelId?: string;
  signal?: AbortSignal;
  directNvidiaApiKey?: string;
} = {}): Promise<ScoutSpeechCatalog> {
  const defaults = resolveScoutSpeechDefaults();
  const requestedModelId = input.modelId?.trim() || defaults.modelId;
  const directNvidiaApiKey = input.directNvidiaApiKey?.trim() || undefined;
  const fallback = fallbackScoutSpeechCatalog(requestedModelId, defaults, {
    directNvidiaAvailable: Boolean(directNvidiaApiKey),
  });
  if (!directNvidiaApiKey || requestedModelId !== NVIDIA_MAGPIE_MODEL) return fallback;
  try {
    // Hosted Magpie is the one direct cloud route the web server keeps: it
    // adds no local process. Every other model is synthesized by Scout Menu.
    const discovered = await listNvidiaMagpieVoices({
      apiKey: directNvidiaApiKey,
      signal: input.signal,
    });
    return {
      ...fallback,
      voices: discovered.map((voice) => ({
        ...voice,
        provider: "nvidia",
        modelId: NVIDIA_MAGPIE_MODEL,
        available: true,
      })),
      source: "nvidia-developer-inference",
    };
  } catch {
    // The deterministic Aria entry remains as the explicit fallback when
    // hosted NVIDIA Developer Inference discovery is unavailable.
    return fallback;
  }
}

export function fallbackScoutSpeechCatalog(
  modelId: string,
  defaults: ScoutSpeechDefaults = resolveScoutSpeechDefaults(),
  options: { directNvidiaAvailable?: boolean } = {},
): ScoutSpeechCatalog {
  // Cloud models are `null` until Scout Menu answers for its Keychain. Hosted
  // Magpie is the exception when the web server itself lends `NV_API_KEY`.
  const nvidiaAvailable: boolean | null = options.directNvidiaAvailable ? true : null;
  const models: ScoutSpeechModel[] = [
    { id: "system", name: "System voice", provider: "system", available: true },
    { id: "gpt-4o-mini-tts", name: "GPT-4o mini TTS", provider: "openai", available: null },
    { id: "eleven_multilingual_v2", name: "Eleven Multilingual v2", provider: "elevenlabs", available: null },
    { id: NVIDIA_MAGPIE_MODEL, name: "Magpie TTS Multilingual", provider: "nvidia", available: nvidiaAvailable },
  ];
  const systemVoices: ScoutSpeechVoice[] = [{
    id: "system",
    name: "System default",
    provider: "system",
    modelId: "system",
    available: true,
    isDefault: true,
  }];
  const openAIVoices = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"]
    .map((id) => ({
      id,
      name: id[0]?.toUpperCase() + id.slice(1),
      provider: "openai",
      modelId: "gpt-4o-mini-tts",
      available: null,
      isDefault: id === "alloy",
    } satisfies ScoutSpeechVoice));
  const elevenLabsVoices: ScoutSpeechVoice[] = [{
    id: "9BWtsMINqrJLrRacOk9x",
    name: "Aria",
    provider: "elevenlabs",
    modelId: "eleven_multilingual_v2",
    available: null,
    isDefault: true,
  }];
  const nvidiaVoices: ScoutSpeechVoice[] = [{
    id: NVIDIA_MAGPIE_DEFAULT_VOICE,
    name: "Aria",
    language: "en-US",
    provider: "nvidia",
    modelId: NVIDIA_MAGPIE_MODEL,
    available: nvidiaAvailable,
    isDefault: true,
  }];
  const voices = modelId === "eleven_multilingual_v2"
    ? elevenLabsVoices
    : modelId === "gpt-4o-mini-tts"
      ? openAIVoices
      : modelId === NVIDIA_MAGPIE_MODEL
        ? nvidiaVoices
        : systemVoices;
  return {
    defaultModelId: defaults.modelId,
    ...(defaults.voiceId ? { defaultVoiceId: defaults.voiceId } : {}),
    models,
    voices,
    source: "fallback",
  };
}
