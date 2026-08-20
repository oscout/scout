// Direct OpenAI speech synthesis — the path Scout uses when Vox is not
// answering.
//
// Vox stays the preferred route: it holds the operator's provider config, so
// a voice picked there (OpenAI, ElevenLabs, MiniMax) is honoured. But Vox is a
// separate app with its own daemon, and when that daemon is down every speak
// request fails and the caller drops to the on-device system voice. Silently
// swapping a chosen voice for the robot one is a worse outcome than reaching
// OpenAI ourselves with the key Scout already holds for Scoutbot.

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_SPEECH_VOICE = "alloy";
const OPENAI_SPEECH_TIMEOUT_MS = 30_000;

/** Models this path can drive. Anything else belongs to a Vox provider. */
const OPENAI_SPEECH_MODELS = new Set(["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);

export type OpenAISpeechResult = {
  contentType: string;
  audioBase64: string;
  modelId: string;
  voiceId: string;
  audioBytes: number;
};

export function isOpenAISpeechModel(modelId: string | undefined): boolean {
  return Boolean(modelId && OPENAI_SPEECH_MODELS.has(modelId));
}

/**
 * A model id Vox resolved but cannot serve right now. `avspeech:system` is
 * macOS's own voice, which the caller can reach without a network round trip —
 * anything else falls back to OpenAI's default model rather than pretending
 * the operator's ElevenLabs voice is available.
 */
export function openAISpeechModelFor(modelId: string | undefined): string {
  return isOpenAISpeechModel(modelId) ? modelId! : DEFAULT_OPENAI_SPEECH_MODEL;
}

export async function synthesizeOpenAISpeech(input: {
  text: string;
  apiKey: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  instructions?: string;
  signal?: AbortSignal;
}): Promise<OpenAISpeechResult> {
  const modelId = openAISpeechModelFor(input.modelId);
  const voiceId = input.voiceId?.trim() || DEFAULT_OPENAI_SPEECH_VOICE;

  const timeout = AbortSignal.timeout(OPENAI_SPEECH_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;

  const response = await fetch(OPENAI_SPEECH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      voice: voiceId,
      input: input.text,
      response_format: "wav",
      ...(input.speed ? { speed: input.speed } : {}),
      // Only the tts models that accept steering take instructions.
      ...(input.instructions && modelId === "gpt-4o-mini-tts"
        ? { instructions: input.instructions }
        : {}),
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI speech failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) {
    throw new Error("OpenAI speech returned no audio.");
  }

  return {
    contentType: "audio/wav",
    audioBase64: Buffer.from(audio).toString("base64"),
    modelId,
    voiceId,
    audioBytes: audio.byteLength,
  };
}
