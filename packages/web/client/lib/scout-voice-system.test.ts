import { afterEach, describe, expect, test } from "bun:test";

import { startScoutSystemSpeech } from "./scout-voice.ts";

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
