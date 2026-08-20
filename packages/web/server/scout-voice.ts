import { createVoxdClient } from "@voxd/client";

import {
  getScoutVoiceHealthSnapshot,
  type ScoutVoiceHealthSnapshot,
} from "./scout-voice-session.ts";
import {
  ensureOpenScoutVoxOrigins,
  listVoxSpeechModels,
  listVoxSpeechVoices,
  resolveVoxSpeechDefaults,
  synthesizeVoxSpeech,
  type VoxSpeechDefaults,
  type VoxSpeechModel,
  type VoxSpeechResult,
  type VoxSpeechTimingRequest,
  type VoxSpeechVoice,
} from "./vox.ts";

export type ScoutVoiceHealth = ScoutVoiceHealthSnapshot;

export type ScoutVoiceTranscriptionResult = {
  text: string;
  durationMs: number;
  words?: Array<{ word: string; start: number; end: number }>;
  metrics?: Record<string, unknown>;
};

export type ScoutSpeechResult = VoxSpeechResult;
export type ScoutSpeechDefaults = VoxSpeechDefaults;
export type ScoutSpeechTimingRequest = VoxSpeechTimingRequest;
export type ScoutSpeechModel = VoxSpeechModel;
export type ScoutSpeechVoice = VoxSpeechVoice;

export type ScoutSpeechCatalog = {
  defaultModelId: string;
  defaultVoiceId?: string;
  models: ScoutSpeechModel[];
  voices: ScoutSpeechVoice[];
  source: "vox" | "fallback";
};

const SCOUT_VOICE_CLIENT_ID = "openscout-web";
const DEFAULT_SCOUT_VOICE_ASR_URL = "http://127.0.0.1:43115";

export async function getScoutVoiceHealth(): Promise<ScoutVoiceHealth> {
  return getScoutVoiceHealthSnapshot();
}

export async function transcribeScoutVoiceAudio(input: {
  audio: Blob | ArrayBuffer;
  modelId?: string;
  format?: "mp3" | "wav" | "aac" | "opus" | "pcm16";
  language?: string;
  timestamps?: boolean;
}): Promise<ScoutVoiceTranscriptionResult> {
  const client = createScoutVoiceAsrClient();
  const result = await client.transcribe({
    audio: input.audio,
    modelId: input.modelId,
    format: input.format,
    language: input.language,
    timestamps: input.timestamps,
    metadata: {
      surface: SCOUT_VOICE_CLIENT_ID,
      owner: "scout",
    },
  });

  return {
    text: result.text,
    durationMs: result.durationMs,
    ...(result.words ? { words: result.words } : {}),
    ...(result.metrics ? { metrics: result.metrics } : {}),
  };
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
  signal?: AbortSignal;
}): Promise<ScoutSpeechResult> {
  return synthesizeVoxSpeech(input);
}

export function resolveScoutSpeechDefaults(env: NodeJS.ProcessEnv = process.env): ScoutSpeechDefaults {
  return resolveVoxSpeechDefaults({
    ...env,
    OPENSCOUT_VOX_TTS_MODEL_ID: env.OPENSCOUT_VOICE_TTS_MODEL_ID ?? env.OPENSCOUT_VOX_TTS_MODEL_ID,
    OPENSCOUT_VOX_TTS_VOICE_ID: env.OPENSCOUT_VOICE_TTS_VOICE_ID ?? env.OPENSCOUT_VOX_TTS_VOICE_ID,
  });
}

export async function getScoutSpeechCatalog(input: {
  modelId?: string;
  signal?: AbortSignal;
  directOpenAIAvailable?: boolean;
} = {}): Promise<ScoutSpeechCatalog> {
  const defaults = resolveScoutSpeechDefaults();
  const requestedModelId = input.modelId?.trim() || defaults.modelId;
  let models: ScoutSpeechModel[] = [];
  let voices: ScoutSpeechVoice[] = [];
  let source: ScoutSpeechCatalog["source"] = "fallback";
  try {
    [models, voices] = await Promise.all([
      listVoxSpeechModels(input.signal),
      listVoxSpeechVoices(requestedModelId, input.signal),
    ]);
    if (models.length > 0) source = "vox";
  } catch {
    // Vox is optional. The same fallback catalog drives Scout's direct OpenAI
    // route and the in-process native provider path when its daemon is absent.
  }
  const fallback = fallbackScoutSpeechCatalog(requestedModelId, defaults);
  for (const model of fallback.models) {
    if (!models.some((candidate) => candidate.id === model.id)) {
      models.push({ ...model, available: false });
    }
  }
  if (voices.length === 0) {
    voices = fallback.voices.map((voice) => ({ ...voice, available: false }));
  }
  if (input.directOpenAIAvailable) {
    models = models.map((model) => model.provider === "openai" ? { ...model, available: true } : model);
    voices = voices.map((voice) => voice.provider === "openai" ? { ...voice, available: true } : voice);
  }
  return {
    defaultModelId: defaults.modelId,
    ...(defaults.voiceId ? { defaultVoiceId: defaults.voiceId } : {}),
    models,
    voices,
    source,
  };
}

export function fallbackScoutSpeechCatalog(
  modelId: string,
  defaults: ScoutSpeechDefaults = resolveScoutSpeechDefaults(),
): ScoutSpeechCatalog {
  const models: ScoutSpeechModel[] = [
    { id: "gpt-4o-mini-tts", name: "GPT-4o mini TTS", provider: "openai", available: true },
    { id: "eleven_multilingual_v2", name: "Eleven Multilingual v2", provider: "elevenlabs", available: true },
  ];
  const openAIVoices = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"]
    .map((id) => ({
      id,
      name: id[0]?.toUpperCase() + id.slice(1),
      provider: "openai",
      modelId: "gpt-4o-mini-tts",
      available: true,
      isDefault: id === "alloy",
    } satisfies ScoutSpeechVoice));
  const elevenLabsVoices: ScoutSpeechVoice[] = [{
    id: "9BWtsMINqrJLrRacOk9x",
    name: "Aria",
    provider: "elevenlabs",
    modelId: "eleven_multilingual_v2",
    available: true,
    isDefault: true,
  }];
  return {
    defaultModelId: defaults.modelId,
    ...(defaults.voiceId ? { defaultVoiceId: defaults.voiceId } : {}),
    models,
    voices: modelId === "eleven_multilingual_v2" ? elevenLabsVoices : openAIVoices,
    source: "fallback",
  };
}

export function ensureScoutVoiceOrigins(): void {
  ensureOpenScoutVoxOrigins();
}

function createScoutVoiceAsrClient(probeTimeout?: number) {
  return createVoxdClient({
    baseUrl: resolveScoutVoiceAsrUrl(),
    clientId: SCOUT_VOICE_CLIENT_ID,
    ...(probeTimeout ? { probeTimeout } : {}),
  });
}

function resolveScoutVoiceAsrUrl(env: NodeJS.ProcessEnv = process.env): string {
  return firstNonEmptyString(
    env.OPENSCOUT_VOICE_ASR_URL,
    env.OPENSCOUT_VOICE_BRIDGE_URL,
    env.VOX_COMPANION_URL,
  ) ?? DEFAULT_SCOUT_VOICE_ASR_URL;
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed.replace(/\/$/, "");
  }
  return undefined;
}
