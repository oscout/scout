/**
 * Voice level metering for MessageComposer waveforms.
 *
 * Two sources:
 *   1. Real mic — Web Audio AnalyserNode on a MediaStream (browser capture,
 *      or a parallel meter when native dictation is active).
 *   2. Speech proxy — when no stream levels are available (native-only path),
 *      approximate energy from partial transcript growth so the bars still
 *      track "what is being said" instead of a looping decoration.
 *
 * Codex-style: a rolling history of samples rendered left→right (newest right).
 */

export const VOICE_WAVE_BARS = 48;

export type LevelHistory = {
  /** Push a 0–1 sample (newest). */
  push: (level: number) => void;
  /** Current ring as a dense array (oldest → newest). */
  snapshot: () => number[];
  /** Decay all samples toward floor (processing / silence). */
  decay: (factor?: number) => void;
  clear: () => void;
};

export function createLevelHistory(size = VOICE_WAVE_BARS, floor = 0.04): LevelHistory {
  const samples = Array.from({ length: size }, () => floor);
  return {
    push(level: number) {
      const next = clamp01(level);
      samples.shift();
      samples.push(Math.max(floor, next));
    },
    snapshot() {
      return samples.slice();
    },
    decay(factor = 0.88) {
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = Math.max(floor, samples[i]! * factor);
      }
    },
    clear() {
      for (let i = 0; i < samples.length; i += 1) samples[i] = floor;
    },
  };
}

export type StreamLevelMeter = {
  stop: () => void;
};

/**
 * Real-time RMS meter from a MediaStream (time-domain, not pretty FFT).
 * Fires ~30fps with a smoothed 0–1 level.
 */
export function startStreamLevelMeter(
  stream: MediaStream,
  onLevel: (level: number) => void,
): StreamLevelMeter {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return { stop: () => undefined };
  }

  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);

  const timeDomain = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let stopped = false;
  let smoothed = 0;

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(timeDomain);
    // RMS of centered samples (128 = silence in byte domain).
    let sum = 0;
    for (let i = 0; i < timeDomain.length; i += 1) {
      const v = (timeDomain[i]! - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / timeDomain.length);
    // Speech is often quiet — expand the useful range.
    const expanded = Math.min(1, rms * 3.6);
    smoothed = smoothed * 0.55 + expanded * 0.45;
    onLevel(smoothed);
    raf = window.requestAnimationFrame(tick);
  };

  void ctx.resume().then(() => {
    if (!stopped) raf = window.requestAnimationFrame(tick);
  });

  return {
    stop() {
      stopped = true;
      if (raf) window.cancelAnimationFrame(raf);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // already torn down
      }
      void ctx.close().catch(() => undefined);
    },
  };
}

/**
 * Try to open a mic-only meter (no recording). Used alongside native dictation
 * when the browser is allowed to share the same permission.
 */
export async function tryStartMicLevelMeter(
  onLevel: (level: number) => void,
): Promise<StreamLevelMeter | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const meter = startStreamLevelMeter(stream, onLevel);
    return {
      stop() {
        meter.stop();
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch {
    return null;
  }
}

/**
 * Speech-proxy energy from partial transcript updates.
 * Grows when new text arrives (talking), decays when partials stall (pause).
 * Vowel-heavy chunks read louder; punctuation / spaces quieter.
 */
export function energyFromPartialDelta(
  previous: string,
  next: string,
  idleMs: number,
): number {
  const prev = previous.trimEnd();
  const curr = next.trimEnd();
  if (!curr) return idleMs > 280 ? 0.05 : 0.12;

  if (curr.length < prev.length) {
    // Rare shrink — soft pulse.
    return 0.2;
  }

  const added = curr.slice(prev.length);
  if (!added) {
    // No new text: exponential silence decay.
    const silence = Math.min(1, idleMs / 900);
    return Math.max(0.04, 0.18 * (1 - silence));
  }

  let score = 0;
  for (const ch of added) {
    if (/[aeiouyæøåáéíóúäöü]/i.test(ch)) score += 1.15;
    else if (/[a-z]/i.test(ch)) score += 0.7;
    else if (/\d/.test(ch)) score += 0.55;
    else if (/\s/.test(ch)) score += 0.15;
    else score += 0.35; // punctuation
  }
  const density = score / Math.max(1, added.length);
  const burst = Math.min(1, 0.25 + density * 0.55 + Math.min(added.length, 8) * 0.05);
  return burst;
}

/**
 * Seed a whole-phrase energy profile for studio demos: given the full
 * utterance and a progress 0–1 through it, return a 0–1 sample that
 * roughly tracks syllable stress rather than a flat loop.
 */
export function energyAlongUtterance(text: string, progress: number): number {
  if (!text) return 0.06;
  const t = clamp01(progress);
  const index = Math.min(text.length - 1, Math.floor(t * text.length));
  const window = text.slice(Math.max(0, index - 2), index + 3);
  let score = 0.15;
  for (const ch of window) {
    if (/[aeiouy]/i.test(ch)) score += 0.22;
    else if (/[a-z]/i.test(ch)) score += 0.1;
    else if (/\s/.test(ch)) score *= 0.35;
    else if (/[,.;:!?—-]/.test(ch)) score *= 0.45;
  }
  // Phrase envelope: ramp in, slight mid lift, soft out.
  const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0.05, t))) ** 0.7;
  // Micro-jitter so adjacent frames aren't identical.
  const jitter = 0.92 + 0.08 * Math.sin(index * 1.7 + t * 12);
  return clamp01(score * envelope * jitter);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
