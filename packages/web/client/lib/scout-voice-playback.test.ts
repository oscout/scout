import { scoutLiveAudioBlockReason } from "./scout-audio-owners.ts";
import { afterEach, describe, expect, test } from "bun:test";

import {
  isScoutSpeechStopped,
  playPreparedScoutSpeech,
  playPreparedScoutSpeechWithEffects,
  primeScoutSpeechPlayback,
  speakWithEffects,
  speakWithScoutVoice,
  startScoutSpeech,
  startScoutSpeechWithEffects,
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

describe("primeScoutSpeechPlayback", () => {
  test("is a no-op when AudioContext is missing", () => {
    expect(() => primeScoutSpeechPlayback()).not.toThrow();
  });
});

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

describe("speech wrappers thread playback start", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const stubPrepare = () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(hostReceipt), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  };

  test("speakWithScoutVoice reports when host speech finishes preparing", async () => {
    stubPrepare();
    let started = 0;
    const result = await speakWithScoutVoice("hello", { onPlaybackStart: () => { started += 1; } });
    expect(result).toEqual(hostReceipt);
    expect(started).toBe(1);
  });

  test("speakWithEffects reports when host speech finishes preparing", async () => {
    stubPrepare();
    let started = 0;
    const result = await speakWithEffects("hello", { onPlaybackStart: () => { started += 1; } });
    expect(result).toEqual(hostReceipt);
    expect(started).toBe(1);
  });
});

describe("stop during speech preparation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const hangPrepare = () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as typeof fetch;
  };

  test("stopping a live speech handle aborts the in-flight TTS request", async () => {
    hangPrepare();
    let started = 0;
    const speech = startScoutSpeech("hello", { onPlaybackStart: () => { started += 1; } });
    expect(scoutLiveAudioBlockReason()).toBe("Another Scout playback is active.");
    const rejection = speech.promise.catch((error: unknown) => error);
    speech.stop();
    const error = await rejection as Error;
    expect(scoutLiveAudioBlockReason()).toBeNull();
    expect(error.name).toBe("AbortError");
    expect(isScoutSpeechStopped(error)).toBe(true);
    expect(started).toBe(0);
  });

  test("stopping an effects speech handle aborts the in-flight TTS request", async () => {
    hangPrepare();
    let started = 0;
    const speech = startScoutSpeechWithEffects("hello", { onPlaybackStart: () => { started += 1; } });
    expect(scoutLiveAudioBlockReason()).toBe("Another Scout playback is active.");
    const rejection = speech.promise.catch((error: unknown) => error);
    speech.stop();
    const error = await rejection as Error;
    expect(scoutLiveAudioBlockReason()).toBeNull();
    expect(error.name).toBe("AbortError");
    expect(isScoutSpeechStopped(error)).toBe(true);
    expect(started).toBe(0);
  });
});

describe("primed browser playback", () => {
  const originalWindow = globalThis.window;
  const originalAudio = globalThis.Audio;
  const originalFetch = globalThis.fetch;
  const contexts: FakeContext[] = [];
  let htmlPlays = 0;
  const bytes: ScoutSpeechResult = { ...hostReceipt, playedOnHost: false, audioBase64: "dGVzdA==", contentType: "audio/wav" };
  class FakeSource {
    buffer: AudioBuffer | null = null;
    onended: (() => void) | null = null;
    disconnected = false;
    starts = 0;
    stops = 0;
    failStart = false;
    connect() {}
    disconnect() { this.disconnected = true; }
    stop() { this.stops += 1; }
    start() {
      if (this.failStart) throw new Error("source start failed");
      this.starts += 1;
      setTimeout(() => this.onended?.(), 0);
    }
  }
  class FakeContext {
    state: AudioContextState = "running";
    sampleRate = 48000;
    destination = {};
    sources: FakeSource[] = [];
    decoded: ArrayBuffer[] = [];
    resume = async () => {};
    decodeAudioData = async (input: ArrayBuffer) => {
      this.decoded.push(input);
      return {} as AudioBuffer;
    };
    failPlaybackStart = false;
    constructor() { contexts.push(this); }
    createBuffer() { return {} as AudioBuffer; }
    createBufferSource() {
      const source = new FakeSource();
      source.failStart = this.failPlaybackStart && this.sources.length > 0;
      this.sources.push(source);
      return source;
    }
  }
  class FakeAudio extends EventTarget {
    currentTime = 0;
    pause() {}
    async play() {
      htmlPlays += 1;
      setTimeout(() => this.dispatchEvent(new Event("ended")), 5);
    }
  }
  function prime() {
    globalThis.window = { AudioContext: FakeContext } as unknown as Window & typeof globalThis;
    globalThis.Audio = FakeAudio as unknown as typeof Audio;
    primeScoutSpeechPlayback();
    return contexts.at(-1)!;
  }
  afterEach(() => {
    for (const ctx of contexts) ctx.state = "closed";
    contexts.length = 0;
    htmlPlays = 0;
    globalThis.window = originalWindow;
    globalThis.Audio = originalAudio;
    globalThis.fetch = originalFetch;
  });

  test("decodes and plays on the one primed context, then disconnects", async () => {
    const ctx = prime();
    let started = 0;
    await playPreparedScoutSpeech(bytes, { onPlaybackStart: () => started++ });
    expect(contexts).toHaveLength(1);
    expect(new TextDecoder().decode(ctx.decoded[0])).toBe("test");
    expect(ctx.sources[1]?.starts).toBe(1);
    expect(ctx.sources[1]?.disconnected).toBe(true);
    expect(started).toBe(1);
    expect(htmlPlays).toBe(0);
  });

  test("stopping pending resume releases speech ownership with no late playback", async () => {
    const ctx = prime();
    ctx.state = "suspended";
    let release!: () => void;
    ctx.resume = () => new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async () => Response.json(bytes)) as unknown as typeof fetch;
    const speech = startScoutSpeech("hello");
    const rejected = speech.promise.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scoutLiveAudioBlockReason()).toBe("Another Scout playback is active.");
    speech.stop();
    expect(isScoutSpeechStopped(await rejected)).toBe(true);
    expect(scoutLiveAudioBlockReason()).toBeNull();
    ctx.state = "running";
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.sources).toHaveLength(1);
    expect(htmlPlays).toBe(0);
  });

  test("aborting pending decoding settles without waiting or playing its late result", async () => {
    const ctx = prime();
    let release!: (buffer: AudioBuffer) => void;
    ctx.decodeAudioData = () => new Promise<AudioBuffer>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const rejected = playPreparedScoutSpeech(bytes, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    expect(isScoutSpeechStopped(await rejected)).toBe(true);
    release({} as AudioBuffer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.sources).toHaveLength(1);
    expect(htmlPlays).toBe(0);
  });

  test("a pending context resume falls back after a bounded wait", async () => {
    const ctx = prime();
    ctx.state = "suspended";
    ctx.resume = () => new Promise<void>(() => {});
    await playPreparedScoutSpeech(bytes);
    expect(htmlPlays).toBe(1);
    expect(ctx.sources).toHaveLength(1);
  });

  test("a rejected best-effort prime is consumed and playback can fall back", async () => {
    const ctx = prime();
    ctx.state = "suspended";
    ctx.resume = () => Promise.reject(new Error("permission denied"));
    primeScoutSpeechPlayback();
    await playPreparedScoutSpeech(bytes);
    expect(htmlPlays).toBe(1);
  });

  test("source-start failure disconnects before HTML Audio fallback", async () => {
    const ctx = prime();
    ctx.failPlaybackStart = true;
    await playPreparedScoutSpeech(bytes);
    expect(ctx.sources[1]?.disconnected).toBe(true);
    expect(htmlPlays).toBe(1);
  });

  test("playback abort stops and disconnects the source", async () => {
    const ctx = prime();
    const controller = new AbortController();
    const rejected = playPreparedScoutSpeech(bytes, {
      signal: controller.signal,
      onPlaybackStart: () => controller.abort(),
    }).catch((error: unknown) => error);
    expect(isScoutSpeechStopped(await rejected)).toBe(true);
    expect(ctx.sources[1]?.stops).toBe(1);
    expect(ctx.sources[1]?.disconnected).toBe(true);
    expect(htmlPlays).toBe(0);
  });
});
