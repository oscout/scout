import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fallbackScoutSpeechCatalog, resolveScoutSpeechDefaults } from "./scout-voice.ts";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function makeVoiceHome(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-scout-voice-home-"));
  tempPaths.add(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("resolveScoutSpeechDefaults", () => {
  test("allows Scout-owned TTS env overrides", () => {
    const voxHome = makeVoiceHome();

    expect(resolveScoutSpeechDefaults({
      VOX_HOME: voxHome,
      OPENSCOUT_VOICE_TTS_MODEL_ID: "hudson:model",
      OPENSCOUT_VOICE_TTS_VOICE_ID: "hudson_voice",
    })).toEqual({
      modelId: "hudson:model",
      voiceId: "hudson_voice",
    });
  });

  test("still reads the existing local provider preferences behind the Scout boundary", () => {
    const voxHome = makeVoiceHome();
    writeJson(join(voxHome, "preferences.json"), {
      speech: {
        preferredSynthesisVoiceId: "af_heart",
      },
    });
    writeJson(join(voxHome, "providers.json"), {
      providers: [
        {
          id: "mlx-audio",
          kind: "tts",
          builtin: true,
          models: ["mlx-community/Kokoro-82M-bf16"],
          env: {
            VOX_MLX_AUDIO_TTS_DEFAULT_VOICE: "af_heart",
          },
        },
      ],
    });

    expect(resolveScoutSpeechDefaults({ VOX_HOME: voxHome })).toEqual({
      modelId: "mlx-community/Kokoro-82M-bf16",
      voiceId: "af_heart",
    });
  });
});

describe("fallbackScoutSpeechCatalog", () => {
  test("offers the cloud providers Scout can route without pretending they are configured", () => {
    const openAI = fallbackScoutSpeechCatalog("gpt-4o-mini-tts", {
      modelId: "gpt-4o-mini-tts",
      voiceId: "alloy",
    });
    expect(openAI.models.map((model) => [model.provider, model.id])).toEqual([
      ["openai", "gpt-4o-mini-tts"],
      ["elevenlabs", "eleven_multilingual_v2"],
    ]);
    expect(openAI.voices.some((voice) => voice.id === "alloy" && voice.isDefault)).toBe(true);

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
  });
});
