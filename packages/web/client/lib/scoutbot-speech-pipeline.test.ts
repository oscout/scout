import { describe, expect, test } from "bun:test";
import { beginScoutSpeech, endScoutSpeech, scoutLiveAudioBlockReason } from "./scout-audio-owners.ts";

import { startScoutbotSpeechPipeline } from "./scoutbot-speech-pipeline.ts";
import { isScoutSpeechStopped, type ScoutSpeechResult } from "./scout-voice.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeResult(text: string): ScoutSpeechResult {
  return {
    contentType: "audio/mp3",
    audioBase64: "AAAA",
    modelId: "test-model",
    voiceId: text,
    audioBytes: 3,
  };
}

function abortError(): Error {
  const error = new Error("Speech stopped.");
  error.name = "AbortError";
  return error;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("startScoutbotSpeechPipeline", () => {
  test("prepares the next sentence while the current one plays", async () => {
    const log: string[] = [];
    const prepares = new Map<string, Deferred<ScoutSpeechResult>>();
    const plays = new Map<string, Deferred<ScoutSpeechResult>>();
    let prepareStarts = 0;
    const playbackStarts: string[] = [];

    const pipeline = startScoutbotSpeechPipeline({
      prepare: (text) => {
        log.push(`prepare:${text}`);
        const next = deferred<ScoutSpeechResult>();
        prepares.set(text, next);
        return next.promise;
      },
      play: (result, options) => {
        log.push(`play:${result.voiceId}`);
        options?.onPlaybackStart?.();
        const next = deferred<ScoutSpeechResult>();
        plays.set(result.voiceId, next);
        return next.promise;
      },
    }, {
      onPrepareStart: () => {
        prepareStarts += 1;
      },
      onPlaybackStart: (text) => {
        playbackStarts.push(text);
      },
    });

    pipeline.push("One.");
    pipeline.push("Two.");
    await tick();
    expect(log).toEqual(["prepare:One.", "prepare:Two."]);

    prepares.get("One.")!.resolve(fakeResult("One."));
    await tick();
    expect(log).toEqual(["prepare:One.", "prepare:Two.", "play:One."]);

    // The third sentence does not prepare until the first finishes playing.
    pipeline.push("Three.");
    await tick();
    expect(log).not.toContain("prepare:Three.");

    prepares.get("Two.")!.resolve(fakeResult("Two."));
    await tick();
    expect(log).not.toContain("play:Two.");

    plays.get("One.")!.resolve(fakeResult("One."));
    await tick();
    expect(log).toEqual([
      "prepare:One.",
      "prepare:Two.",
      "play:One.",
      "prepare:Three.",
      "play:Two.",
    ]);

    pipeline.finish();
    plays.get("Two.")!.resolve(fakeResult("Two."));
    prepares.get("Three.")!.resolve(fakeResult("Three."));
    await tick();
    plays.get("Three.")!.resolve(fakeResult("Three."));
    await pipeline.promise;

    expect(log).toEqual([
      "prepare:One.",
      "prepare:Two.",
      "play:One.",
      "prepare:Three.",
      "play:Two.",
      "play:Three.",
    ]);
    expect(prepareStarts).toBe(1);
    expect(playbackStarts).toEqual(["One."]);
  });

  test("resolves immediately when finished with an empty queue", async () => {
    const pipeline = startScoutbotSpeechPipeline();
    pipeline.finish();
    await pipeline.promise;
  });

  test("stop aborts in-flight playback and rejects with a speech-stopped error", async () => {
    const pipeline = startScoutbotSpeechPipeline({
      prepare: async (text) => fakeResult(text),
      play: (_result, options) => new Promise<ScoutSpeechResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    });
    pipeline.push("One.");
    await tick();
    const settled = pipeline.promise.catch((error: unknown) => error);
    pipeline.stop();
    const error = await settled as Error;
    expect(error.name).toBe("AbortError");
    expect(isScoutSpeechStopped(error)).toBe(true);
  });

  test("stop before any sentence still settles the promise", async () => {
    const pipeline = startScoutbotSpeechPipeline();
    const settled = pipeline.promise.catch((error: unknown) => error);
    pipeline.stop();
    const error = await settled as Error;
    expect(isScoutSpeechStopped(error)).toBe(true);
  });

  test("a preparation failure rejects the promise and skips the rest of the queue", async () => {
    const played: string[] = [];
    const pipeline = startScoutbotSpeechPipeline({
      prepare: async (text) => {
        if (text === "Two.") throw new Error("tts melted");
        return fakeResult(text);
      },
      play: async (result) => {
        played.push(result.voiceId);
        return result;
      },
    });
    pipeline.push("One.");
    pipeline.push("Two.");
    pipeline.push("Three.");
    pipeline.finish();
    await expect(pipeline.promise).rejects.toThrow("tts melted");
    expect(played).toEqual(["One."]);
  });

  test("applies the spoken transform and skips sentences it empties", async () => {
    const prepared: string[] = [];
    const pipeline = startScoutbotSpeechPipeline({
      toSpoken: (text) => text.replace(/```[\s\S]*?```/g, "").toUpperCase().trim(),
      prepare: async (text) => {
        prepared.push(text);
        return fakeResult(text);
      },
      play: async (result) => result,
    });
    pipeline.push("hello.");
    pipeline.push("```json {}```");
    pipeline.finish();
    await pipeline.promise;
    expect(prepared).toEqual(["HELLO."]);
  });

  test("ignores pushes after finish", async () => {
    const prepared: string[] = [];
    const pipeline = startScoutbotSpeechPipeline({
      prepare: async (text) => {
        prepared.push(text);
        return fakeResult(text);
      },
      play: async (result) => result,
    });
    pipeline.push("One.");
    pipeline.finish();
    pipeline.push("Two.");
    await pipeline.promise;
    expect(prepared).toEqual(["One."]);
  });
});


describe("streamed speech shared ownership", () => {
  test("holds ownership while preparing, playing and waiting between sentences", async () => {
    const preparation = deferred<ScoutSpeechResult>();
    const playback = deferred<ScoutSpeechResult>();
    const pipeline = startScoutbotSpeechPipeline({ prepare: () => preparation.promise, play: () => playback.promise });
    expect(scoutLiveAudioBlockReason()).toBeNull();
    pipeline.push("One.");
    expect(scoutLiveAudioBlockReason()).toBe("Another Scout playback is active.");
    await tick();
    expect(scoutLiveAudioBlockReason()).not.toBeNull();
    preparation.resolve(fakeResult("One.")); await tick();
    expect(scoutLiveAudioBlockReason()).not.toBeNull();
    playback.resolve(fakeResult("One.")); await tick();
    expect(scoutLiveAudioBlockReason()).not.toBeNull();
    pipeline.finish(); await pipeline.promise;
    expect(scoutLiveAudioBlockReason()).toBeNull();
    pipeline.stop(); pipeline.finish(); pipeline.push("Late.");
    expect(scoutLiveAudioBlockReason()).toBeNull();
  });

  test("empty completion and stop preserve another owner's claim", async () => {
    beginScoutSpeech();
    try {
      const empty = startScoutbotSpeechPipeline(); empty.finish(); await empty.promise; empty.stop();
      expect(scoutLiveAudioBlockReason()).not.toBeNull();
      const pipeline = startScoutbotSpeechPipeline({ prepare: () => new Promise(() => {}) });
      const done = pipeline.promise.catch((error) => error);
      pipeline.push("Pending preparation."); await tick();
      pipeline.stop(); pipeline.stop();
      expect(isScoutSpeechStopped(await done)).toBe(true);
      expect(scoutLiveAudioBlockReason()).not.toBeNull();
    } finally { endScoutSpeech(); }
    expect(scoutLiveAudioBlockReason()).toBeNull();
  });

  for (const phase of ["preparation", "playback"] as const) {
    test(`${phase} failure aborts speculative tail, releases ownership and fences pushes`, async () => {
      let tailSignal: AbortSignal | undefined;
      const head = deferred<ScoutSpeechResult>();
      const prepared: string[] = [];
      const pipeline = startScoutbotSpeechPipeline({
        prepare: (text, options) => {
          prepared.push(text);
          if (text === "Head.") return phase === "preparation" ? head.promise : Promise.resolve(fakeResult(text));
          tailSignal = options.signal;
          return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(abortError()), { once: true }));
        },
        play: () => Promise.reject(new Error("head failed")),
      });
      const done = pipeline.promise.catch((error) => error);
      pipeline.push("Head."); pipeline.push("Tail.");
      await tick();
      if (phase === "preparation") head.reject(new Error("head failed"));
      expect((await done).message).toBe("head failed");
      expect(tailSignal?.aborted).toBe(true);
      expect(scoutLiveAudioBlockReason()).toBeNull();
      pipeline.push("Must not start."); pipeline.stop(); pipeline.finish(); await tick();
      expect(prepared).toEqual(["Head.", "Tail."]);
      expect(scoutLiveAudioBlockReason()).toBeNull();
    });
  }

  test("stopping one of two pipelines releases only its own ownership", async () => {
    const options = { prepare: () => new Promise<ScoutSpeechResult>(() => {}) };
    const first = startScoutbotSpeechPipeline(options), second = startScoutbotSpeechPipeline(options);
    const a = first.promise.catch(() => {}), b = second.promise.catch(() => {});
    first.push("One."); second.push("Two.");
    first.stop(); await a; first.stop();
    expect(scoutLiveAudioBlockReason()).not.toBeNull();
    second.stop(); await b;
    expect(scoutLiveAudioBlockReason()).toBeNull();
  });
});
