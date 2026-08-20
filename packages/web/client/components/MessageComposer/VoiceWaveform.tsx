/**
 * Speech-representative waveform for MessageComposer.
 *
 * Prefers a rolling history of real mic RMS samples (or speech-proxy energy
 * derived from partial transcript growth). Falls back to a quiet floor when
 * no samples are available. Not a decorative CSS loop — bar heights are the
 * data (Codex-style left→right time series, newest on the right).
 */

import { VOICE_WAVE_BARS } from "../../lib/voice-levels.ts";

export function VoiceWaveform({
  samples,
  active,
  processing = false,
  className,
}: {
  /** Oldest → newest energy samples in 0–1. Length may vary; we resample. */
  samples?: number[] | null;
  /** True while recording. */
  active: boolean;
  /** Calmer phase while the final transcript is resolving. */
  processing?: boolean;
  className?: string;
}) {
  const bars = resample(samples, VOICE_WAVE_BARS, processing ? 0.06 : 0.04);

  const rootClass = [
    "s-msg-compose-wave",
    active ? "s-msg-compose-wave--live" : "",
    processing ? "s-msg-compose-wave--processing" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClass}
      aria-hidden="true"
      data-wave-source={samples && samples.length > 0 ? "levels" : "floor"}
    >
      {bars.map((height, index) => (
        <span
          key={index}
          className="s-msg-compose-wave-bar"
          style={{
            // Direct height from sample — no CSS keyframe loop.
            transform: `scaleY(${Math.max(0.08, height)})`,
            opacity: processing
              ? 0.28 + height * 0.35
              : active
                ? 0.4 + height * 0.55
                : 0.25,
          }}
        />
      ))}
    </div>
  );
}

function resample(
  samples: number[] | null | undefined,
  count: number,
  floor: number,
): number[] {
  if (!samples || samples.length === 0) {
    return Array.from({ length: count }, () => floor);
  }
  if (samples.length === count) {
    return samples.map((s) => Math.max(floor, Math.min(1, s)));
  }
  // Stretch / compress to fixed bar count (nearest neighbor is fine).
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    const src = Math.min(
      samples.length - 1,
      Math.round((i / Math.max(1, count - 1)) * (samples.length - 1)),
    );
    out[i] = Math.max(floor, Math.min(1, samples[src] ?? floor));
  }
  return out;
}
