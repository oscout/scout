import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SCOUTBOT_CUSTOM_SPEECH,
  SCOUTBOT_SPEECH_MODEL_ID,
  SCOUTBOT_SPEECH_PROFILES,
  resolveScoutbotSpeechVoice,
} from "./scoutbot-voice-profiles.ts";

describe("Scoutbot Direct Voice profiles", () => {
  test("offers four distinct locale and presentation choices on the request-based TTS model", () => {
    expect(SCOUTBOT_SPEECH_PROFILES.map((profile) => profile.id)).toEqual([
      "us-woman",
      "us-man",
      "british-woman",
      "british-man",
    ]);
    expect(SCOUTBOT_SPEECH_PROFILES.every((profile) => profile.speech.modelId === SCOUTBOT_SPEECH_MODEL_ID)).toBe(true);
    expect(SCOUTBOT_SPEECH_PROFILES.filter((profile) => profile.locale === "US English")).toHaveLength(2);
    expect(SCOUTBOT_SPEECH_PROFILES.filter((profile) => profile.locale === "British English")).toHaveLength(2);
    expect(new Set(SCOUTBOT_SPEECH_PROFILES.map((profile) => `${profile.locale}:${profile.presentation}`)).size).toBe(4);
  });

  test("resolves the selected preset to voice and accent instructions", () => {
    expect(resolveScoutbotSpeechVoice("british-man")).toMatchObject({
      modelId: "gpt-4o-mini-tts",
      voiceId: "cedar",
    });
    expect(resolveScoutbotSpeechVoice("british-man").instructions).toContain("British English");
  });

  test("preserves custom model, voice, and instructions while trimming form input", () => {
    expect(resolveScoutbotSpeechVoice("custom", {
      modelId: " eleven_multilingual_v2 ",
      voiceId: " Aria ",
      instructions: " Speak softly. ",
    })).toEqual({
      modelId: "eleven_multilingual_v2",
      voiceId: "Aria",
      instructions: "Speak softly.",
    });
  });

  test("keeps custom selection usable when a field is blank", () => {
    expect(resolveScoutbotSpeechVoice("custom", {
      modelId: " ",
      voiceId: "",
      instructions: "\n",
    })).toEqual(DEFAULT_SCOUTBOT_CUSTOM_SPEECH);
  });
});
