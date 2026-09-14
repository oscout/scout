import { afterEach, describe, expect, test } from "bun:test";

import {
  fallbackScoutSpeechCatalog,
  getScoutSpeechCatalog,
  resolveScoutSpeechDefaults,
  synthesizeScoutSpeech,
  transcribeScoutVoiceAudio,
} from "./scout-voice.ts";
import {
  awaitScoutVoiceHostCommand,
  pushScoutVoiceHostEvent,
  registerScoutVoiceHost,
  resetScoutVoiceSessionStateForTests,
} from "./scout-voice-session.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetScoutVoiceSessionStateForTests();
});

describe("resolveScoutSpeechDefaults", () => {
  test("allows Scout-owned TTS env overrides", () => {
    expect(resolveScoutSpeechDefaults({
      OPENSCOUT_VOICE_TTS_MODEL_ID: "hudson:model",
      OPENSCOUT_VOICE_TTS_VOICE_ID: "hudson_voice",
    })).toEqual({
      modelId: "hudson:model",
      voiceId: "hudson_voice",
    });
  });

  test("uses the embedded system engine by default", () => {
    expect(resolveScoutSpeechDefaults({})).toEqual({ modelId: "system" });
  });
});

describe("fallbackScoutSpeechCatalog", () => {
  test("describes the Scout Menu embedded speech providers", () => {
    const openAI = fallbackScoutSpeechCatalog("gpt-4o-mini-tts", {
      modelId: "gpt-4o-mini-tts",
      voiceId: "alloy",
    });
    expect(openAI.models.map((model) => [model.provider, model.id])).toEqual([
      ["system", "system"],
      ["openai", "gpt-4o-mini-tts"],
      ["elevenlabs", "eleven_multilingual_v2"],
      ["nvidia", "magpie-tts-multilingual"],
    ]);
    expect(openAI.source).toBe("fallback");
    expect(openAI.voices.some((voice) => voice.id === "alloy" && voice.isDefault)).toBe(true);
    expect(openAI.models.find((model) => model.provider === "openai")?.available).toBeNull();
    expect(openAI.voices.find((voice) => voice.id === "alloy")?.available).toBeNull();

    const elevenLabs = fallbackScoutSpeechCatalog("eleven_multilingual_v2", {
      modelId: "gpt-4o-mini-tts",
      voiceId: "alloy",
    });
    expect(elevenLabs.voices).toEqual([expect.objectContaining({
      id: "9BWtsMINqrJLrRacOk9x",
      name: "Aria",
      provider: "elevenlabs",
      modelId: "eleven_multilingual_v2",
      isDefault: true,
    })]);

    const nvidia = fallbackScoutSpeechCatalog("magpie-tts-multilingual", {
      modelId: "gpt-4o-mini-tts",
      voiceId: "alloy",
    });
    expect(nvidia.voices).toEqual([expect.objectContaining({
      id: "Magpie-Multilingual.EN-US.Aria",
      name: "Aria",
      language: "en-US",
      provider: "nvidia",
      modelId: "magpie-tts-multilingual",
      isDefault: true,
    })]);
  });

  test("uses the hosted NVIDIA roster and falls back deterministically when discovery is unavailable", async () => {
    globalThis.fetch = async () => Response.json({
      "en-US,ja-JP": {
        voices: [
          "Magpie-Multilingual.JA-JP.Siwei",
          "Magpie-Multilingual.EN-US.Jason",
        ],
      },
    });
    const discovered = await getScoutSpeechCatalog({
      modelId: "magpie-tts-multilingual",
      directNvidiaApiKey: "synthetic-test-key",
    });
    expect(discovered.voices.map((voice) => voice.id)).toEqual([
      "Magpie-Multilingual.EN-US.Jason",
      "Magpie-Multilingual.JA-JP.Siwei",
    ]);
    expect(discovered.source).toBe("nvidia-developer-inference");

    globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
    const fallback = await getScoutSpeechCatalog({
      modelId: "magpie-tts-multilingual",
      directNvidiaApiKey: "synthetic-test-key",
    });
    expect(fallback.voices).toEqual([expect.objectContaining({
      id: "Magpie-Multilingual.EN-US.Aria",
      isDefault: true,
      available: true,
    })]);
    expect(fallback.source).toBe("fallback");
  });
});

describe("Scout Menu speech dispatch", () => {
  test("resolves the system model before queuing an omitted model", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const resultPromise = synthesizeScoutSpeech({ text: "Use the server default." }, {});
    const { command } = await awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");
    expect(command).toMatchObject({
      type: "speech.synthesize",
      text: "Use the server default.",
      modelId: "system",
    });
    expect(command).not.toHaveProperty("voiceId");
    const sessionId = command && "sessionId" in command ? command.sessionId : "";
    expect(sessionId).toMatch(/^scout-speech:/);

    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      instanceId: "menu-process",
      sessionId,
      event: "speech.result",
      data: {
        contentType: "audio/wav",
        audioBase64: "UklGRg==",
        modelId: "system",
        voiceId: "system-default",
        audioBytes: 4,
      },
    });
    await expect(resultPromise).resolves.toMatchObject({ modelId: "system" });
  });

  test("carries environment defaults and request correlation through the host command", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const resultPromise = synthesizeScoutSpeech({
      text: "Keep this request correlated.",
      originAppId: "openscout-deck",
      utteranceId: "deck-42",
      speechTiming: { enabled: true, cues: [{ id: "cue-1", text: "Keep" }] },
    }, {
      OPENSCOUT_VOICE_TTS_MODEL_ID: "gpt-4o-mini-tts",
      OPENSCOUT_VOICE_TTS_VOICE_ID: "coral",
    });
    const { command } = await awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");
    expect(command).toMatchObject({
      type: "speech.synthesize",
      modelId: "gpt-4o-mini-tts",
      voiceId: "coral",
      originAppId: "openscout-deck",
      utteranceId: "deck-42",
      speechTiming: { enabled: true, cues: [{ id: "cue-1", text: "Keep" }] },
    });
    const sessionId = command && "sessionId" in command ? command.sessionId : "";
    expect(sessionId).toMatch(/^scout-speech:/);

    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      instanceId: "menu-process",
      sessionId,
      event: "speech.result",
      data: {
        contentType: "audio/mpeg",
        audioBase64: "SUQz",
        modelId: "gpt-4o-mini-tts",
        voiceId: "coral",
        audioBytes: 3,
        originAppId: "openscout-deck",
        utteranceId: "deck-42",
      },
    });
    await expect(resultPromise).resolves.toMatchObject({
      modelId: "gpt-4o-mini-tts",
      voiceId: "coral",
      originAppId: "openscout-deck",
      utteranceId: "deck-42",
    });
  });

  test("spoken on host: leaves the voice to the Mac and resolves on the playback receipt", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const resultPromise = synthesizeScoutSpeech({
      text: "Read this aloud over here.",
      playback: "host",
      originAppId: "openscout-home",
    }, {
      OPENSCOUT_VOICE_TTS_MODEL_ID: "gpt-4o-mini-tts",
      OPENSCOUT_VOICE_TTS_VOICE_ID: "coral",
    });
    const { command } = await awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");
    // The web's environment defaults stay out of it: Scout Menu speaks in the
    // voice chosen in its own Settings › Voice unless the request names one.
    expect(command).toMatchObject({
      type: "speech.synthesize",
      text: "Read this aloud over here.",
      playback: "host",
      originAppId: "openscout-home",
    });
    expect(command).not.toHaveProperty("modelId");
    expect(command).not.toHaveProperty("voiceId");
    const sessionId = command && "sessionId" in command ? command.sessionId : "";

    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      instanceId: "menu-process",
      sessionId,
      event: "speech.result",
      data: {
        playedOnHost: true,
        modelId: "system",
        voiceId: "app.openscout.kokorovoice.extension.com.kokorovoice.af_heart",
        metrics: { provider: "system", host: "scout-menu" },
      },
    });
    await expect(resultPromise).resolves.toEqual({
      audioBase64: "",
      contentType: "",
      modelId: "system",
      voiceId: "app.openscout.kokorovoice.extension.com.kokorovoice.af_heart",
      audioBytes: 0,
      route: "scout-menu",
      playedOnHost: true,
      metrics: { provider: "system", host: "scout-menu" },
      originAppId: "openscout-home",
    });
  });

  test("spoken on host: an explicit request voice still wins, and an older host may answer with audio", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const resultPromise = synthesizeScoutSpeech({
      text: "Use the voice I picked.",
      modelId: "system",
      voiceId: "com.apple.voice.compact.en-US.Samantha",
      playback: "host",
    }, {});
    const { command } = await awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");
    expect(command).toMatchObject({
      modelId: "system",
      voiceId: "com.apple.voice.compact.en-US.Samantha",
      playback: "host",
    });
    const sessionId = command && "sessionId" in command ? command.sessionId : "";

    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      instanceId: "menu-process",
      sessionId,
      event: "speech.result",
      data: {
        contentType: "audio/wav",
        audioBase64: "UklGRg==",
        modelId: "system",
        voiceId: "com.apple.voice.compact.en-US.Samantha",
        audioBytes: 4,
      },
    });
    const result = await resultPromise;
    expect(result.playedOnHost).toBeUndefined();
    expect(result.audioBytes).toBe(4);
  });

  test("spoken on host: a receipt without a voice is rejected", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const resultPromise = synthesizeScoutSpeech({ text: "Nothing to hear.", playback: "host" }, {});
    const { command } = await awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");
    const sessionId = command && "sessionId" in command ? command.sessionId : "";
    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      instanceId: "menu-process",
      sessionId,
      event: "speech.result",
      data: { playedOnHost: true, modelId: "system" },
    });
    await expect(resultPromise).rejects.toMatchObject({ code: "speech_result_invalid" });
  });

  test("rejects strict timing and uploaded transcription as unsupported capabilities", async () => {
    await expect(synthesizeScoutSpeech({
      text: "Align every word.",
      speechTiming: { enabled: true, strict: true },
    }, {})).rejects.toMatchObject({ code: "speech_timing_unsupported", status: 501 });

    await expect(transcribeScoutVoiceAudio({
      audio: new Blob(["audio"]),
    })).rejects.toMatchObject({ code: "uploaded_transcription_unsupported", status: 501 });
  });
});
