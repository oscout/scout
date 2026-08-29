export const SCOUTBOT_SPEECH_MODEL_ID = "gpt-4o-mini-tts";

export type ScoutbotSpeechProfileId =
  | "us-woman"
  | "us-man"
  | "british-woman"
  | "british-man";

export type ScoutbotSpeechSelectionId = ScoutbotSpeechProfileId | "custom";

export type ScoutbotSpeechVoice = {
  modelId: string;
  voiceId: string;
  instructions: string;
};

export type ScoutbotSpeechProfile = {
  id: ScoutbotSpeechProfileId;
  label: string;
  locale: string;
  presentation: string;
  voiceName: string;
  description: string;
  speech: ScoutbotSpeechVoice;
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

export function isScoutbotSpeechSelectionId(value: string): value is ScoutbotSpeechSelectionId {
  return value === "custom" || SCOUTBOT_SPEECH_PROFILES.some((profile) => profile.id === value);
}

export function resolveScoutbotSpeechVoice(
  selectionId: string,
  custom: Partial<ScoutbotSpeechVoice> = {},
): ScoutbotSpeechVoice {
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
