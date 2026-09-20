import type { ScoutVoicePlayback } from "../../../shared/voice-playback.ts";

export const SCOUTBOT_SPEECH_MODEL_ID = "gpt-4o-mini-tts";

export type ScoutbotSpeechProfileId =
  | "us-woman"
  | "us-man"
  | "british-woman"
  | "british-man";

export type ScoutbotSpeechSelectionId = ScoutbotSpeechProfileId | "custom" | "device";

export type ScoutbotSpeechVoice = {
  modelId: string;
  voiceId: string;
  instructions: string;
  /**
   * Overrides the operator's persisted playback setting for this utterance.
   * Only the device selection sets it: Kokoro is an audio-unit extension that
   * cannot render to bytes, so it is reachable only by speaking on the Mac.
   */
  playback?: ScoutVoicePlayback;
};

export type ScoutbotSpeechProfile = {
  id: ScoutbotSpeechProfileId;
  label: string;
  locale: string;
  presentation: string;
  voiceName: string;
  description: string;
  /** Provider id, matching the ids `/api/voice/catalog` reports. */
  provider: ScoutbotSpeechProviderId;
  /**
   * True when the locale is carried by the `instructions` prompt rather than by
   * a distinct voice. Both British profiles are US voices asked to read British,
   * so the settings panel must not imply a separate voice is installed.
   */
  accentFromPrompt: boolean;
  speech: ScoutbotSpeechVoice;
};

export type ScoutbotSpeechProviderId = "openai" | "elevenlabs" | "nvidia" | "system";

export const SCOUTBOT_SPEECH_PROVIDER_LABELS: Record<ScoutbotSpeechProviderId, string> = {
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  nvidia: "NVIDIA",
  system: "System",
};

export const DEFAULT_SCOUTBOT_SPEECH_PROFILE_ID: ScoutbotSpeechProfileId = "us-woman";

export const SCOUTBOT_SPEECH_PROFILES: readonly ScoutbotSpeechProfile[] = [
  {
    id: "us-woman",
    label: "US Woman",
    locale: "US English",
    presentation: "Woman",
    voiceName: "Marin",
    description: "Warm, clear, and conversational.",
    provider: "openai",
    accentFromPrompt: false,
    speech: {
      modelId: SCOUTBOT_SPEECH_MODEL_ID,
      voiceId: "marin",
      instructions: "Speak in clear, natural American English with a warm, grounded feminine presentation. Keep the delivery conversational and responsive.",
    },
  },
  {
    id: "us-man",
    label: "US Man",
    locale: "US English",
    presentation: "Man",
    voiceName: "Cedar",
    description: "Grounded, calm, and direct.",
    provider: "openai",
    accentFromPrompt: false,
    speech: {
      modelId: SCOUTBOT_SPEECH_MODEL_ID,
      voiceId: "cedar",
      instructions: "Speak in clear, natural American English with a warm, grounded masculine presentation. Keep the delivery conversational and responsive.",
    },
  },
  {
    id: "british-woman",
    label: "British Woman",
    locale: "British English",
    presentation: "Woman",
    voiceName: "Marin",
    description: "Warm with a subtle British cadence.",
    provider: "openai",
    accentFromPrompt: true,
    speech: {
      modelId: SCOUTBOT_SPEECH_MODEL_ID,
      voiceId: "marin",
      instructions: "Speak in natural British English with a subtle contemporary British accent and a warm, grounded feminine presentation. Avoid theatrical or exaggerated delivery.",
    },
  },
  {
    id: "british-man",
    label: "British Man",
    locale: "British English",
    presentation: "Man",
    voiceName: "Cedar",
    description: "Calm with a subtle British cadence.",
    provider: "openai",
    accentFromPrompt: true,
    speech: {
      modelId: SCOUTBOT_SPEECH_MODEL_ID,
      voiceId: "cedar",
      instructions: "Speak in natural British English with a subtle contemporary British accent and a calm, grounded masculine presentation. Avoid theatrical or exaggerated delivery.",
    },
  },
] as const;

export const DEFAULT_SCOUTBOT_CUSTOM_SPEECH: ScoutbotSpeechVoice = {
  modelId: SCOUTBOT_SPEECH_MODEL_ID,
  voiceId: "marin",
  instructions: "Speak naturally, clearly, and conversationally.",
};

export const SCOUTBOT_DEVICE_SPEECH: ScoutbotSpeechVoice = {
  modelId: "",
  voiceId: "",
  instructions: "",
  playback: "host",
};

export function isScoutbotSpeechSelectionId(value: string): value is ScoutbotSpeechSelectionId {
  return value === "custom"
    || value === "device"
    || SCOUTBOT_SPEECH_PROFILES.some((profile) => profile.id === value);
}

export function resolveScoutbotSpeechVoice(
  selectionId: string,
  custom: Partial<ScoutbotSpeechVoice> = {},
): ScoutbotSpeechVoice {
  if (selectionId === "device") return SCOUTBOT_DEVICE_SPEECH;

  if (selectionId === "custom") {
    return {
      modelId: custom.modelId?.trim() || DEFAULT_SCOUTBOT_CUSTOM_SPEECH.modelId,
      voiceId: custom.voiceId?.trim() || DEFAULT_SCOUTBOT_CUSTOM_SPEECH.voiceId,
      instructions: custom.instructions?.trim() || DEFAULT_SCOUTBOT_CUSTOM_SPEECH.instructions,
    };
  }

  return SCOUTBOT_SPEECH_PROFILES.find((profile) => profile.id === selectionId)?.speech
    ?? SCOUTBOT_SPEECH_PROFILES.find((profile) => profile.id === DEFAULT_SCOUTBOT_SPEECH_PROFILE_ID)!.speech;
}

/**
 * Who actually speaks a reply, resolved for display. The voice page surfaces
 * this so the operator can tell "which voice is that?" — and which meter is
 * running — without opening Settings.
 */
export type ScoutbotSpeechIdentity = {
  selectionId: ScoutbotSpeechSelectionId;
  /** Human voice name, e.g. "Marin". "This Mac" for the device selection. */
  voiceLabel: string;
  provider: ScoutbotSpeechProviderId;
  providerLabel: string;
  /** Empty for the device selection — the model pick lives in Scout Menu. */
  modelId: string;
  voiceId: string;
  /** True when each spoken reply is a paid API request. */
  metered: boolean;
};

export function resolveScoutbotSpeechIdentity(
  selectionId: ScoutbotSpeechSelectionId,
  custom: Partial<ScoutbotSpeechVoice> = {},
): ScoutbotSpeechIdentity {
  if (selectionId === "device") {
    return {
      selectionId,
      voiceLabel: "This Mac",
      provider: "system",
      providerLabel: SCOUTBOT_SPEECH_PROVIDER_LABELS.system,
      modelId: "",
      voiceId: "",
      metered: false,
    };
  }
  const profile = SCOUTBOT_SPEECH_PROFILES.find((entry) => entry.id === selectionId);
  if (profile) {
    return {
      selectionId,
      voiceLabel: profile.voiceName,
      provider: profile.provider,
      providerLabel: SCOUTBOT_SPEECH_PROVIDER_LABELS[profile.provider],
      modelId: profile.speech.modelId,
      voiceId: profile.speech.voiceId,
      metered: profile.provider !== "system",
    };
  }
  const voice = resolveScoutbotSpeechVoice("custom", custom);
  return {
    selectionId: "custom",
    voiceLabel: voice.voiceId || "Custom",
    provider: "openai",
    providerLabel: SCOUTBOT_SPEECH_PROVIDER_LABELS.openai,
    modelId: voice.modelId,
    voiceId: voice.voiceId,
    metered: true,
  };
}
