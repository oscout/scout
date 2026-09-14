import { describe, expect, test } from "bun:test";

import {
  playPreparedScoutSpeech,
  playPreparedScoutSpeechWithEffects,
  type ScoutSpeechResult,
} from "./scout-voice.ts";

const hostReceipt: ScoutSpeechResult = {
  contentType: "",
  audioBase64: "",
  modelId: "system",
  voiceId: "app.openscout.kokorovoice.extension.com.kokorovoice.af_heart",
  audioBytes: 0,
  playedOnHost: true,
};

describe("spoken on host", () => {
  test("a host playback receipt is not played again by the page", async () => {
    // No `Audio` or AudioContext exists here; constructing one would throw.
    let started = 0;
    const result = await playPreparedScoutSpeech(hostReceipt, { onPlaybackStart: () => { started += 1; } });
    expect(result).toBe(hostReceipt);
    expect(started).toBe(1);

    const withEffects = await playPreparedScoutSpeechWithEffects(hostReceipt, {
      presetId: "radio",
      onPlaybackStart: () => { started += 1; },
    });
    expect(withEffects).toBe(hostReceipt);
    expect(started).toBe(2);
  });

  test("a stopped request still rejects before consulting the receipt", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(playPreparedScoutSpeech(hostReceipt, { signal: controller.signal })).rejects.toThrow();
  });
});
