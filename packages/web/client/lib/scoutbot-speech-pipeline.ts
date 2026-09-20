import { beginScoutSpeech, endScoutSpeech } from "./scout-audio-owners.ts";
import {
  playPreparedScoutSpeech,
  prepareScoutSpeech,
  type ScoutSpeechOptions,
  type ScoutSpeechResult,
} from "./scout-voice.ts";

/**
 * Sentence-pipelined playback for a streamed Scoutbot reply.
 *
 * Sentences arrive one by one (SSE from /api/scoutbot/chat). Each is run
 * through `toSpoken` and enqueued; TTS preparation of the next sentence
 * overlaps playback of the current one, so the first sentence starts speaking
 * while the rest of the reply is still generating. `promise` resolves when
 * the queue drains after `finish()`, rejects with an AbortError on `stop()`,
 * and rejects with the speech error if preparation or playback fails.
 *
 * Host playback (`playback: "host"`) must not use this: the speak call spans
 * the host-side playback, so preparing ahead would double-speak on the Mac.
 */

export type ScoutbotSpeechPipelineEvents = {
  /** Fires once, when the first sentence starts TTS preparation. */
  onPrepareStart?: () => void;
  /** Fires once, when the first sentence's audio actually starts moving. */
  onPlaybackStart?: (text: string) => void;
};

export type ScoutbotSpeechPipeline = {
  promise: Promise<void>;
  push: (sentence: string) => void;
  finish: () => void;
  stop: () => void;
};

export function startScoutbotSpeechPipeline(
  options: Pick<ScoutSpeechOptions, "speed" | "modelId" | "voiceId" | "instructions" | "playback"> & {
    toSpoken?: (text: string) => string;
    prepare?: (text: string, options: ScoutSpeechOptions) => Promise<ScoutSpeechResult>;
    play?: (
      result: ScoutSpeechResult,
      options: { signal?: AbortSignal; onPlaybackStart?: () => void },
    ) => Promise<ScoutSpeechResult>;
  } = {},
  events: ScoutbotSpeechPipelineEvents = {},
): ScoutbotSpeechPipeline {
  const prepare = options.prepare ?? prepareScoutSpeech;
  const play = options.play ?? playPreparedScoutSpeech;
  const toSpoken = options.toSpoken ?? ((text: string) => text);
  const controller = new AbortController();
  const items: { text: string; prepared: Promise<ScoutSpeechResult> | null }[] = [];
  let finished = false;
  let stopped = false;
  let settled = false;
  let ownsAudio = false;
  let prepareAnnounced = false;
  let playbackAnnounced = false;
  let wake: (() => void) | null = null;

  const speechOptions = (): ScoutSpeechOptions => ({
    ...(options.speed !== undefined ? { speed: options.speed } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(options.voiceId ? { voiceId: options.voiceId } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.playback ? { playback: options.playback } : {}),
    signal: controller.signal,
  });

  const ensurePrepared = (index: number) => {
    const item = items[index];
    if (!item || item.prepared || stopped) return;
    if (!prepareAnnounced) {
      prepareAnnounced = true;
      events.onPrepareStart?.();
    }
    const prepared = prepare(item.text, speechOptions());
    // The player only awaits head items; a rejected tail item would otherwise
    // surface as an unhandled rejection when an earlier failure ends the run.
    prepared.catch(() => undefined);
    item.prepared = prepared;
  };

  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const notify = () => {
    const pending = wake;
    wake = null;
    pending?.();
  };

  const run = async (): Promise<void> => {
    let cursor = 0;
    for (;;) {
      if (stopped) throw stoppedPipelineError();
      if (cursor >= items.length) {
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      ensurePrepared(cursor);
      ensurePrepared(cursor + 1);
      const item = items[cursor]!;
      const prepared = await item.prepared!;
      if (stopped) throw stoppedPipelineError();
      await play(prepared, {
        signal: controller.signal,
        onPlaybackStart: playbackAnnounced ? undefined : () => {
          playbackAnnounced = true;
          events.onPlaybackStart?.(item.text);
        },
      });
      cursor += 1;
    }
  };

  // One ownership claim spans preparation, playback and gaps between streamed
  // sentences. Every terminal path fences pushes and aborts speculative TTS.
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    finished = true;
    stopped = Boolean(error);
    controller.abort();
    notify();
    if (ownsAudio) {
      ownsAudio = false;
      endScoutSpeech();
    }
    if (error) rejectPromise(error);
    else resolvePromise();
  };

  void run().then(() => settle(), (error: unknown) => {
    settle(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    promise,
    push: (sentence) => {
      if (stopped || finished) return;
      let text: string;
      try { text = toSpoken(sentence); }
      catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!text) return;
      if (!ownsAudio) {
        beginScoutSpeech();
        ownsAudio = true;
      }
      items.push({ text, prepared: null });
      notify();
    },
    finish: () => {
      if (stopped || finished) return;
      finished = true;
      notify();
    },
    stop: () => {
      settle(stoppedPipelineError());
    },
  };
}

function stoppedPipelineError(): Error {
  const error = new Error("Speech stopped.");
  error.name = "AbortError";
  return error;
}
