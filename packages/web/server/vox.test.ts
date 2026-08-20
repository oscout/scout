import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveVoxSpeechDefaults } from "./vox.ts";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function makeVoxHome(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-vox-home-"));
  tempPaths.add(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("resolveVoxSpeechDefaults", () => {
  test("uses Vox's configured local TTS voice instead of Apple speech defaults", () => {
    const voxHome = makeVoxHome();
    writeJson(join(voxHome, "preferences.json"), {
      speech: {
        preferredSynthesisVoiceId: "af_heart",
      },
    });
    writeJson(join(voxHome, "providers.json"), {
      providers: [
        {
          id: "parakeet",
          kind: "asr",
          builtin: true,
          models: ["parakeet:v3"],
        },
        {
          id: "mlx-audio",
          kind: "tts",
          builtin: true,
          models: ["mlx-community/Kokoro-82M-bf16"],
          env: {
            VOX_MLX_AUDIO_TTS_DEFAULT_VOICE: "af_heart",
          },
        },
        {
          id: "avspeech",
          kind: "tts",
          builtin: true,
          models: ["avspeech:system"],
        },
      ],
    });

    expect(resolveVoxSpeechDefaults({ VOX_HOME: voxHome })).toEqual({
      modelId: "mlx-community/Kokoro-82M-bf16",
      voiceId: "af_heart",
    });
  });

  test("falls back to Apple speech when no local TTS provider is configured", () => {
    const voxHome = makeVoxHome();
    writeJson(join(voxHome, "providers.json"), {
      providers: [
        {
          id: "avspeech",
          kind: "tts",
          builtin: true,
          models: ["avspeech:system"],
        },
      ],
    });

    expect(resolveVoxSpeechDefaults({ VOX_HOME: voxHome })).toEqual({
      modelId: "avspeech:system",
    });
  });

  test("allows OpenScout-specific model and voice overrides", () => {
    const voxHome = makeVoxHome();

    expect(resolveVoxSpeechDefaults({
      VOX_HOME: voxHome,
      OPENSCOUT_VOX_TTS_MODEL_ID: "custom:model",
      OPENSCOUT_VOX_TTS_VOICE_ID: "custom_voice",
    })).toEqual({
      modelId: "custom:model",
      voiceId: "custom_voice",
    });
  });
});
