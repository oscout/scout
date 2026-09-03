import { afterEach, describe, expect, test } from "bun:test";

import {
  NVIDIA_MAGPIE_DEFAULT_VOICE,
  listNvidiaMagpieVoices,
  resolveNvidiaApiKey,
  synthesizeNvidiaMagpieSpeech,
} from "./nvidia-speech.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NVIDIA Magpie speech", () => {
  test("prefers NV_API_KEY while accepting NVIDIA_API_KEY", () => {
    expect(resolveNvidiaApiKey({ NV_API_KEY: " nv-primary ", NVIDIA_API_KEY: "documented" })).toBe("nv-primary");
    expect(resolveNvidiaApiKey({ NVIDIA_API_KEY: " documented " })).toBe("documented");
  });

  test("uses NVIDIA developer inference multipart contract", async () => {
    let captured: Request | undefined;
    globalThis.fetch = async (input, init) => {
      captured = new Request(input, init);
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        headers: { "content-type": "audio/wav" },
      });
    };

    const result = await synthesizeNvidiaMagpieSpeech({
      text: "Scout here.",
      apiKey: "synthetic-test-key",
    });
    const request = captured!;
    const form = await request.formData();

    expect(request.url).toContain("invocation.api.nvcf.nvidia.com/v1/audio/synthesize");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-test-key");
    expect(form.get("text")).toBe("Scout here.");
    expect(form.get("language")).toBe("en-US");
    expect(form.get("voice")).toBe(NVIDIA_MAGPIE_DEFAULT_VOICE);
    expect(form.get("encoding")).toBe("LINEAR_PCM");
    expect(form.get("sample_rate_hz")).toBe("44100");
    expect(result).toMatchObject({
      contentType: "audio/wav",
      voiceId: NVIDIA_MAGPIE_DEFAULT_VOICE,
      audioBytes: 4,
    });

    const emotionVoice = "Magpie-Multilingual.ES-US.Isabela.Angry";
    await synthesizeNvidiaMagpieSpeech({
      text: "Hola Scout.",
      apiKey: "synthetic-test-key",
      voiceId: emotionVoice,
    });
    const emotionForm = await captured!.formData();
    expect(emotionForm.get("language")).toBe("es-US");
    expect(emotionForm.get("voice")).toBe(emotionVoice);
  });

  test("discovers the hosted NVIDIA Developer Inference voice roster", async () => {
    let captured: Request | undefined;
    globalThis.fetch = async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        "en-US,ja-JP": {
          voices: [
            "Magpie-Multilingual.JA-JP.Siwei",
            "Magpie-Multilingual.ES-US.Isabela.Angry",
            "Magpie-Multilingual.EN-US.Jason",
            NVIDIA_MAGPIE_DEFAULT_VOICE,
          ],
        },
      });
    };

    const voices = await listNvidiaMagpieVoices({ apiKey: "synthetic-test-key" });

    expect(captured?.url).toContain("invocation.api.nvcf.nvidia.com/v1/audio/list_voices");
    expect(captured?.method).toBe("GET");
    expect(captured?.headers.get("authorization")).toBe("Bearer synthetic-test-key");
    expect(voices).toEqual([
      { id: NVIDIA_MAGPIE_DEFAULT_VOICE, name: "Aria", language: "en-US", isDefault: true },
      { id: "Magpie-Multilingual.EN-US.Jason", name: "Jason", language: "en-US", isDefault: false },
      { id: "Magpie-Multilingual.ES-US.Isabela.Angry", name: "Isabela · Angry", language: "es-US", isDefault: false },
      { id: "Magpie-Multilingual.JA-JP.Siwei", name: "Siwei", language: "ja-JP", isDefault: false },
    ]);
  });
});
