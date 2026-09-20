import { Fragment, type CSSProperties } from "react";

import {
  turnStrip,
  type VoiceTone,
  type VoiceTurn,
} from "../../lib/voice-turn-ledger.ts";

/*
 * Voice Paths VII, ported to /voice: the path strip grown into the turn's
 * live score, and the hero — the spoken sentence as the biggest element.
 *
 * The stage track carries per-stop state from the real turn ledger: done
 * (duration under the label), active (lit breathing dot + running tenths +
 * an indeterminate travelling glint on the inbound connector, because the
 * active stage's duration is unknowable), pending (dim). GPT Live is a
 * continuous call: the circuit is open end to end, sky stays on the hops
 * that leave this machine, and the active stop follows the floor.
 */

export type StageStopState = "done" | "active" | "pending";

export type StageStop = {
  key: string;
  label: string;
  sky?: boolean;
  state: StageStopState;
  sec?: number;
};

const fmtTenths = (sec: number) => `${sec.toFixed(1)}s`;

/* Local Live: lane you → stop 1, lane host → stt, lane scoutbot → reply
   model (tool ticks on lane scout count toward it), lane voice tone prep →
   voice, lane voice tone speak → speaker. A stop is done when all its spans
   have ended (duration = last end − first start), active while one is open
   (tenths = now − start), pending when it has no spans yet. */
export function localStageStops(
  turn: VoiceTurn | undefined,
  now: number | undefined,
  voiceName: string | null,
): StageStop[] {
  const groups: { key: string; label: string; match: (s: VoiceTurn["spans"][number]) => boolean; ticks?: boolean }[] = [
    { key: "you", label: "you", match: (s) => s.lane === "you" },
    { key: "stt", label: "stt", match: (s) => s.lane === "host" },
    { key: "reply", label: "reply model", match: (s) => s.lane === "scoutbot", ticks: true },
    { key: "voice", label: voiceName ?? "voice", match: (s) => s.lane === "voice" && s.tone === "prep" },
    { key: "speaker", label: "speaker", match: (s) => s.lane === "voice" && s.tone === "speak" },
  ];
  return groups.map((group) => {
    const spans = turn ? turn.spans.filter(group.match) : [];
    if (spans.length === 0) return { key: group.key, label: group.label, state: "pending" };
    const openSpan = spans.find((s) => s.end === null);
    if (openSpan && now !== undefined) {
      return { key: group.key, label: group.label, state: "active", sec: Math.max(0, now - openSpan.start) };
    }
    const first = Math.min(...spans.map((s) => s.start));
    const last = Math.max(
      ...spans.map((s) => s.end ?? now ?? s.start),
      ...(group.ticks && turn ? turn.ticks.map((t) => t.at) : [0]),
    );
    return { key: group.key, label: group.label, state: "done", sec: Math.max(0, last - first) };
  });
}

/* GPT Live: you → webrtc → openai realtime → voice → speaker; the two cloud
   hops (into realtime, into the voice) keep the sky tint. Connecting lights
   the stops sequentially via CSS staggers. Live fills the whole circuit and
   only marks an observed floor holder active. Closed transcript intervals
   do not prove current speech; an open/unknown floor lights no stop. Clocks stay
   blank in the continuous mode — the eyebrow carries the turn seconds. */
export function gptStageStops({
  state,
  floorWho,
  speakOpen = false,
  voiceName,
}: {
  state: string;
  floorWho: string;
  speakOpen?: boolean;
  voiceName: string | null;
}): StageStop[] {
  const stops: StageStop[] = [
    { key: "you", label: "you", state: "pending" },
    { key: "webrtc", label: "webrtc", state: "pending" },
    { key: "reply", label: "openai realtime", sky: true, state: "pending" },
    { key: "voice", label: voiceName ?? "voice", sky: true, state: "pending" },
    { key: "speaker", label: "speaker", state: "pending" },
  ];
  if (state !== "live") return stops;
  const activeIdx = floorWho === "you"
    ? 0
    : floorWho === "Scoutbot"
      ? 2
      : floorWho === "Scout"
        ? speakOpen ? 4 : 2
        : -1;
  return stops.map((stop, i) => ({ ...stop, state: i === activeIdx ? "active" : "done" }));
}

export function VoiceTurnStageTrack({
  mode,
  stops,
  connecting = false,
  error = false,
  continuous = false,
}: {
  mode: "gpt-live" | "local-live";
  stops: StageStop[];
  connecting?: boolean;
  error?: boolean;
  continuous?: boolean;
}) {
  const cls = [
    "vp7-track",
    connecting ? "vp7-track--connecting" : "",
    error ? "vp7-track--error" : "",
  ].filter(Boolean).join(" ");
  const stateCopy = connecting
    ? "; connecting station by station"
    : continuous
      ? `; circuit open end to end${stops.some((stop) => stop.state === "active") ? "" : "; current speaker not observed"}`
      : error
        ? "; in error"
        : "";
  // Expose the same state and timing as the visual track, without an aria-live
  // region that would announce every clock tick. Continuous "done" means the
  // circuit is connected, not that a speech stage has completed.
  const stageSummary = stops.map((stop) => {
    const state = continuous && stop.state === "done" ? "connected" : stop.state;
    const duration = !continuous && stop.sec !== undefined ? `, ${fmtTenths(stop.sec)}` : "";
    return `${stop.label}: ${state}${duration}`;
  }).join("; ");
  return (
    <div
      className={cls}
      role="img"
      aria-label={`${mode === "gpt-live" ? "GPT Live" : "Local Live"} path: ${stageSummary}${stateCopy}.`}
    >
      {stops.map((stop, i) => (
        <Fragment key={stop.key}>
          {i > 0 && (
            <span
              className={`vp7-link${stop.sky ? " vp7-link--sky" : ""}${continuous || stop.state !== "pending" ? " vp7-link--filled" : ""}${!continuous && stop.state === "active" ? " vp7-link--filling" : ""}`}
              style={{ "--i": i } as CSSProperties}
              aria-hidden="true"
            >
              {stop.state === "active" && <i />}
            </span>
          )}
          <span
            className={`vp7-stop vp7-stop--${stop.state}${stop.sky ? " vp7-stop--sky" : ""}`}
            style={{ "--i": i } as CSSProperties}
          >
            <span className="vp7-dot" aria-hidden="true" />
            <span className="vp7-stop-label">{stop.label}</span>
            <span className="vp7-stop-time">
              {continuous || stop.sec === undefined ? "" : fmtTenths(stop.sec)}
            </span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/* The share strip tones: the study's stage families mapped onto the ledger's
   span tones. Sky stays reserved for audio that leaves this machine. */
const SHARE_TONE: Record<VoiceTone, string> = {
  you: "you",
  live: "sky",
  host: "transcribe",
  snap: "transcribe",
  model: "reply",
  scout: "reply",
  prep: "transcribe",
  speak: "speak",
  quiet: "quiet",
};

export type HeroWhoTone = "open" | "wait" | "sky" | "dim";

/** The legacy ledger can seed a quote from an assistant-first greeting and
 * then append user text to that same turn. Only a user-first turn has safe
 * operator attribution; leave assistant-first/mixed/unknown quotes untagged.
 * Do not rewrite stored quotes or infer provenance from the current floor.
 */
export function voiceTurnQuoteWho(turn: VoiceTurn | undefined): "you" | undefined {
  return turn?.spans[0]?.lane === "you" ? "you" : undefined;
}

export function VoiceTurnHero({
  who,
  whoTone = "dim",
  clock,
  story,
  quote,
  quoteWho,
  placeholder,
  turn,
  now,
  live = false,
  lanesOpen = false,
  onToggleLanes,
}: {
  who: string;
  whoTone?: HeroWhoTone;
  clock?: string;
  story?: string;
  quote?: string;
  quoteWho?: string;
  placeholder?: string;
  turn?: VoiceTurn;
  now?: number;
  live?: boolean;
  lanesOpen?: boolean;
  onToggleLanes?: () => void;
}) {
  const strip = turn ? turnStrip(turn, now) : null;
  const share = strip && strip.length > 0 ? (
    <>
      {strip.map((seg, i) => (
        <span
          key={i}
          className={`vp7-share-seg vp7-share-seg--${SHARE_TONE[seg.tone]}${live && i === strip.length - 1 && seg.tone !== "quiet" ? " vp7-share-seg--live" : ""}`}
          style={{ flexGrow: Math.max(seg.to - seg.from, 0.08) }}
        />
      ))}
    </>
  ) : null;
  return (
    <div className="vp7-hero">
      <p className="vp7-hero-eyebrow">
        <b className={`vp7-who vp7-who--${whoTone}`}>{who}</b>
        {clock ? <span className="vp7-hero-clock">{clock}</span> : null}
        {story ? <span className="vp7-hero-story">{story}</span> : null}
      </p>
      {quote ? (
        <p className="vp7-hero-quote">
          <span className="vp7-quote-mark">“</span>{quote}<span className="vp7-quote-mark">”</span>
          {quoteWho && <span className="vp7-quote-who"> — {quoteWho}</span>}
        </p>
      ) : (
        <p className="vp7-hero-quote vp7-hero-quote--rest">{placeholder ?? "…"}</p>
      )}
      {share ? (
        onToggleLanes ? (
          <button
            type="button"
            className="vp7-share"
            onClick={onToggleLanes}
            aria-pressed={lanesOpen}
            aria-label="Share of the turn — toggle the lanes timeline"
            title="Turn lanes"
          >
            {share}
          </button>
        ) : (
          <div className="vp7-share" role="img" aria-label="Share of the turn">
            {share}
          </div>
        )
      ) : null}
    </div>
  );
}
