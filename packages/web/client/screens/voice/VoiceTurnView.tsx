import type { CSSProperties } from "react";

import {
  formatVoiceQuote,
  isQuietVoiceTurn,
  turnFloor,
  turnStrip,
  turnTotal,
  turnWindow,
  type VoiceLane,
  type VoiceTurn,
} from "../../lib/voice-turn-ledger.ts";
import "./voice-turn.css";

const GPT_LANES: VoiceLane[] = ["you", "live", "scoutbot", "scout"];
const LOCAL_LANES: VoiceLane[] = ["you", "host", "scoutbot", "scout", "voice"];

const LANE_NAME: Record<VoiceLane, string> = {
  you: "you",
  live: "Scout",
  host: "transcribe",
  scoutbot: "Scoutbot",
  scout: "tools",
  voice: "speak",
};

const pct = (t: number, win: number) => `${(t / win) * 100}%`;

function axisStep(window: number): number {
  if (window <= 16) return 2;
  if (window <= 40) return 5;
  return 10;
}

function Axis({ window }: { window: number }) {
  const step = axisStep(window);
  const marks = Array.from({ length: Math.floor(window / step) + 1 }, (_, i) => i * step);
  return (
    <div className="vtl-axis" aria-hidden="true">
      {marks.map((s) => (
        <span key={s} style={{ left: pct(s, window) }}>{s === 0 ? "0s" : s}</span>
      ))}
    </div>
  );
}

function Grid({ window }: { window: number }) {
  const step = axisStep(window);
  const marks = Array.from({ length: Math.floor(window / step) }, (_, i) => (i + 1) * step);
  return (
    <>
      {marks.map((s) => (
        <span key={s} className="vtl-grid" style={{ left: pct(s, window) }} aria-hidden="true" />
      ))}
    </>
  );
}

function lanesFor(turn: VoiceTurn, mode: "gpt-live" | "local-live"): VoiceLane[] {
  if (mode === "local-live") return LOCAL_LANES;
  const used = new Set(turn.spans.map((s) => s.lane));
  return GPT_LANES.filter((lane) => lane === "you" || lane === "live" || lane === "scoutbot" || lane === "scout" || used.has(lane));
}

function quoteText(turn: VoiceTurn): string | undefined {
  return formatVoiceQuote(turn.quote) || undefined;
}

export function VoiceTurnView({
  turn,
  now,
  mode,
}: {
  turn: VoiceTurn;
  now?: number;
  mode: "gpt-live" | "local-live";
}) {
  const elapsed = now ?? turnTotal(turn);
  const open = now !== undefined;
  const win = turnWindow(turn, now);
  const lanes = lanesFor(turn, mode);
  const floor = open ? turnFloor(turn, elapsed) : null;

  return (
    <div className="vtl vtl--lanes">
      {floor && (
        <p className="vtl-lanes-kicker">
          <b>{floor.who}</b>
          <span> {floor.since.toFixed(1)}s</span>
          {floor.beneath ? <span className="vtl-beneath"> · {floor.beneath}</span> : null}
        </p>
      )}
      <div className="vtl-lanes">
        <div className="vtl-labels">
          {lanes.map((lane) => <span key={lane}>{LANE_NAME[lane]}</span>)}
        </div>
        <div className="vtl-track">
          <Grid window={win} />
          {lanes.map((lane) => (
            <div key={lane} className="vtl-lane">
              {turn.spans.filter((s) => s.lane === lane).map((s) => {
                const end = s.end ?? now ?? s.start;
                const isOpen = s.end === null && open;
                return (
                  <span key={s.id}>
                    {s.label && (
                      <span
                        className={`vtl-label${s.quote ? " is-quote" : ""}`}
                        style={{ left: pct(s.start, win), "--l": pct(s.start, win) } as CSSProperties}
                      >
                        {s.label}
                      </span>
                    )}
                    <span
                      className={`vtl-span vtl-t-${s.tone}${isOpen ? " is-open" : ""}`}
                      style={{ left: pct(s.start, win), width: pct(Math.max(end - s.start, 0.08), win) }}
                    />
                  </span>
                );
              })}
              {turn.ticks.filter((t) => t.lane === lane).map((t) => (
                <span key={t.id}>
                  <span className="vtl-tick" style={{ left: pct(t.at, win) }} />
                  <span className="vtl-tick-label" style={{ left: `calc(${pct(t.at, win)} + 4px)` }}>{t.label}</span>
                </span>
              ))}
            </div>
          ))}
          {open && <span className="vtl-now" style={{ left: pct(elapsed, win) }} aria-hidden="true" />}
          <Axis window={win} />
        </div>
      </div>
    </div>
  );
}

export function VoiceTurnSettle({
  turns,
  selectedId,
  onSelect,
  mode,
  liveId,
  now,
}: {
  turns: VoiceTurn[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  mode: "gpt-live" | "local-live";
  /** The still-open turn pins to the top with a pulsing dot and a ticking total. */
  liveId?: string | null;
  now?: number;
}) {
  const visible = turns.filter((turn) => !isQuietVoiceTurn(turn) || turn.id === liveId);
  if (visible.length === 0) {
    return <VoiceTurnEmpty mode={mode} />;
  }
  return (
    <ol className="vtl-settle">
      {[...visible].reverse().map((turn) => {
        const quote = quoteText(turn);
        const selected = turn.id === selectedId;
        const live = turn.id === liveId;
        const strip = turnStrip(turn, live ? now : undefined);
        const total = turnTotal(turn, live ? now : undefined);
        return (
          <li key={turn.id} className={`${selected ? "is-selected" : ""}${live ? " is-live" : ""}`.trim() || undefined}>
            <button
              type="button"
              className="vtl-settle-hit"
              onClick={() => onSelect?.(turn.id)}
              aria-pressed={selected}
            >
              <div>
                <span className="vtl-settle-quote">
                  {live && <span className="vtl-live-dot" aria-hidden="true" />}
                  {quote ? `“${quote}”` : "turn"}
                </span>
                <span className="vtl-settle-meta">
                  <span className="vtl-mini-strip" aria-hidden="true">
                    {strip.map((seg, i) => (
                      <i
                        key={i}
                        className={`vtl-t-${seg.tone}${live && i === strip.length - 1 && seg.tone !== "quiet" ? " is-live" : ""}`}
                        style={{ flexGrow: Math.max(seg.to - seg.from, 0.08) }}
                      />
                    ))}
                  </span>
                  <span className="vtl-settle-total">{total.toFixed(1)}s</span>
                </span>
              </div>
              <time dateTime={new Date(turn.origin).toISOString()}>
                {new Date(turn.origin).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
              </time>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function VoiceTurnEmpty({ mode }: { mode: "gpt-live" | "local-live" }) {
  return (
    <p className="vtl-empty-line">
      {mode === "gpt-live"
        ? "Start a call. Seconds and tools land here after the first turn."
        : "Tap to talk. Seconds and tools land here after the first turn."}
    </p>
  );
}
