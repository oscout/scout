import { afterEach, describe, expect, test } from "bun:test";

import {
  executeScoutVoiceIssueAction,
  reconcileScoutSpeechSelection,
  startScoutSystemSpeech,
  type ScoutSpeechCatalog,
} from "./scout-voice.ts";

const originalWindow = globalThis.window;
const originalSpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;

class FakeSpeechSynthesisUtterance {
  readonly text: string;
  rate = 1;
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

class FakeSpeechSynthesis {
  cancelCalls = 0;
  utterance: FakeSpeechSynthesisUtterance | null = null;

  cancel(): void {
    this.cancelCalls += 1;
  }

  speak(utterance: FakeSpeechSynthesisUtterance): void {
    this.utterance = utterance;
  }
}

function installSystemSpeech(): FakeSpeechSynthesis {
  const synthesis = new FakeSpeechSynthesis();
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeSpeechSynthesisUtterance,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { speechSynthesis: synthesis },
  });
  return synthesis;
}

afterEach(() => {
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: originalSpeechSynthesisUtterance,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("Scout system speech", () => {
  test("speaks through the browser system voice at the requested speed", async () => {
    const synthesis = installSystemSpeech();

    const speech = startScoutSystemSpeech("Local voice is ready.", { speed: 1.5 });

    expect(synthesis.cancelCalls).toBe(1);
    expect(synthesis.utterance?.text).toBe("Local voice is ready.");
    expect(synthesis.utterance?.rate).toBe(1.5);
    synthesis.utterance?.onend?.(new Event("end"));
    await expect(speech.promise).resolves.toBeUndefined();
  });

  test("stops active system speech exactly once", async () => {
    const synthesis = installSystemSpeech();
    const speech = startScoutSystemSpeech("This reply can be interrupted.");

    speech.stop();
    speech.stop();

    await expect(speech.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(synthesis.cancelCalls).toBe(2);
  });
});

describe("Scout speech catalog selection", () => {
  const catalog: ScoutSpeechCatalog = {
    defaultModelId: "system",
    source: "fallback",
    models: [
      { id: "system", name: "System voice", provider: "system", available: true },
      { id: "gpt-4o-mini-tts", name: "GPT-4o mini TTS", provider: "openai", available: null },
      { id: "eleven_multilingual_v2", name: "Eleven Multilingual v2", provider: "elevenlabs", available: null },
    ],
    voices: [
      { id: "coral", name: "Coral", provider: "openai", modelId: "gpt-4o-mini-tts", available: null, isDefault: false },
      { id: "alloy", name: "Alloy", provider: "openai", modelId: "gpt-4o-mini-tts", available: null, isDefault: true },
      { id: "aria", name: "Aria", provider: "elevenlabs", modelId: "eleven_multilingual_v2", available: null, isDefault: true },
    ],
  };

  test("preserves a Deck model and voice whose native availability is unqueried", () => {
    expect(reconcileScoutSpeechSelection(catalog, "gpt-4o-mini-tts", "coral")).toEqual({
      modelId: "gpt-4o-mini-tts",
      voiceId: "coral",
    });
  });

  test("changes only the voice when the operator selects a different model", () => {
    expect(reconcileScoutSpeechSelection(catalog, "eleven_multilingual_v2", "coral")).toEqual({
      modelId: "eleven_multilingual_v2",
      voiceId: "aria",
    });
  });
});


test("launch-host action opens Scout without requesting any service restart", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const location = { href: "" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
  globalThis.fetch = (async () => { requests += 1; throw new Error("Unexpected network action"); }) as unknown as typeof fetch;
  try {
    await executeScoutVoiceIssueAction("launch_host");
    expect(location.href).toBe("scout://hud/show");
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
