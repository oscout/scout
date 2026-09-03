const NVIDIA_MAGPIE_SPEECH_URL =
  "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize";
const NVIDIA_MAGPIE_VOICES_URL =
  "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/list_voices";
export const NVIDIA_MAGPIE_MODEL = "magpie-tts-multilingual";
export const NVIDIA_MAGPIE_DEFAULT_VOICE = "Magpie-Multilingual.EN-US.Aria";
const NVIDIA_MAGPIE_TIMEOUT_MS = 60_000;
const NVIDIA_MAGPIE_MAX_CHARACTERS = 2_000;

export type NvidiaMagpieSpeechResult = {
  contentType: string;
  audioBase64: string;
  modelId: string;
  voiceId: string;
  audioBytes: number;
};

export type NvidiaMagpieVoice = {
  id: string;
  name: string;
  language: string;
  isDefault: boolean;
};

export function resolveNvidiaApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return firstNonEmptyString(env.NV_API_KEY, env.NVIDIA_API_KEY);
}

export function isNvidiaMagpieSpeechModel(modelId: string | undefined): boolean {
  return modelId?.trim() === NVIDIA_MAGPIE_MODEL;
}

export async function listNvidiaMagpieVoices(input: {
  apiKey: string;
  signal?: AbortSignal;
  endpoint?: string;
}): Promise<NvidiaMagpieVoice[]> {
  const timeout = AbortSignal.timeout(NVIDIA_MAGPIE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await fetch(input.endpoint ?? NVIDIA_MAGPIE_VOICES_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${input.apiKey}` },
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `NVIDIA Magpie voice discovery failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const voices = parseNvidiaMagpieVoices(await response.json());
  if (voices.length === 0) {
    throw new Error("NVIDIA Magpie voice discovery returned no voices.");
  }
  return voices;
}

export async function synthesizeNvidiaMagpieSpeech(input: {
  text: string;
  apiKey: string;
  voiceId?: string;
  signal?: AbortSignal;
  endpoint?: string;
}): Promise<NvidiaMagpieSpeechResult> {
  const text = Array.from(input.text).slice(0, NVIDIA_MAGPIE_MAX_CHARACTERS).join("");
  const voiceId = input.voiceId?.trim() || NVIDIA_MAGPIE_DEFAULT_VOICE;
  const language = magpieLanguageForVoice(voiceId);
  const form = new FormData();
  form.set("text", text);
  form.set("language", language);
  form.set("voice", voiceId);
  form.set("encoding", "LINEAR_PCM");
  form.set("sample_rate_hz", "44100");

  const timeout = AbortSignal.timeout(NVIDIA_MAGPIE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await fetch(input.endpoint ?? NVIDIA_MAGPIE_SPEECH_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `NVIDIA Magpie speech failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) {
    throw new Error("NVIDIA Magpie returned no audio.");
  }

  const responseContentType = response.headers.get("content-type")?.split(";")[0];
  return {
    contentType: responseContentType?.startsWith("audio/") ? responseContentType : "audio/wav",
    audioBase64: Buffer.from(audio).toString("base64"),
    modelId: NVIDIA_MAGPIE_MODEL,
    voiceId,
    audioBytes: audio.byteLength,
  };
}

function magpieLanguageForVoice(voiceId: string): string {
  const locale = magpieLocaleSegment(voiceId);
  if (!locale) return "en-US";
  const [language, region] = locale.split("-");
  return `${language!.toLowerCase()}-${region!.toUpperCase()}`;
}

export function parseNvidiaMagpieVoices(value: unknown): NvidiaMagpieVoice[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const group of Object.values(value)) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const voices = (group as { voices?: unknown }).voices;
    if (!Array.isArray(voices)) continue;
    for (const voice of voices) {
      if (typeof voice !== "string") continue;
      const id = voice.trim();
      if (id) ids.add(id);
    }
  }
  return Array.from(ids, voiceDetails).sort((left, right) =>
    left.language.localeCompare(right.language)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
  );
}

function voiceDetails(id: string): NvidiaMagpieVoice {
  const parts = id.split(".");
  const language = magpieLanguageForVoice(id);
  const localeIndex = parts.findIndex(isLocaleSegment);
  const nameParts = localeIndex >= 0 ? parts.slice(localeIndex + 1) : [];
  const name = nameParts.length > 0 ? nameParts.join(" · ") : parts.at(-1) || id;
  return {
    id,
    name,
    language,
    isDefault: id === NVIDIA_MAGPIE_DEFAULT_VOICE,
  };
}

function magpieLocaleSegment(voiceId: string): string | undefined {
  return voiceId.split(".").find(isLocaleSegment);
}

function isLocaleSegment(value: string): boolean {
  return /^[a-z]{2,3}-[a-z]{2}$/i.test(value);
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
