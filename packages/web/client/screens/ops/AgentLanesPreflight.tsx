/**
 * Agent Lanes loading state: pre-flight deck + docked status sheet.
 *
 * Replaces the centred console card. Two pieces, and the split is the whole
 * idea —
 *
 *  · `AgentLanesPreflightDeck` draws the destination at its real size from the
 *    first frame, in whichever layout the deck itself will use. Cells take
 *    their real identity as soon as discovery lands (~230ms) rather than
 *    staying anonymous until replay finishes (which on a cold start is 2.4s
 *    later), so the region is informative almost immediately.
 *
 *  · `AgentLanesLoadingSheet` rides the bottom edge as an ops checklist: one
 *    box per load phase, filled as that phase resolves, with the phase timings
 *    measured client-side. It rises on arrival and retracts straight down on
 *    hand-off. It never collapses in place, because it is not becoming the
 *    deck — the deck is already there, underneath, finished.
 *
 * Nothing here invents progress. Both phases are single requests that resolve
 * atomically, so there is no percentage to fill: the checklist reports phases,
 * the counters report counts the client already holds, and "assemble lanes" has
 * no server signal at all — it completes by the deck existing.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { timeAgo } from "../../lib/time.ts";
import type { TailDiscoveredTranscript, TailDiscoverySnapshot } from "../../lib/types.ts";
import type { TailFeedLoadPhase, TailFeedLoadState } from "../../lib/use-tail-feed.ts";
import type { AgentLanesGridColumns } from "./agent-lanes-layout.ts";
import {
  buildLanePreflightDeck,
  preflightCellTitle,
  type LanePreflightCell,
} from "./lanes-preflight.ts";

/** Retract duration. Must match the `s-lane-boot-retract` keyframe in agent-lanes.css. */
export const LANE_BOOT_EXIT_MS = 260;
/** Elapsed readout cadence. Whole milliseconds at frame rate would be noise. */
const ELAPSED_TICK_MS = 100;

/* ── Hand-off ─────────────────────────────────────────────────────────── */

/**
 * Keeps the sheet mounted for its retract after loading ends, so the exit can
 * play over the finished deck instead of the sheet vanishing on unmount.
 */
export function useLaneBootVisibility(active: boolean, exitMs: number): {
  visible: boolean;
  exiting: boolean;
} {
  const [visible, setVisible] = useState(active);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (active) {
      setVisible(true);
      setExiting(false);
      return;
    }
    if (!visible) return;
    if (exitMs <= 0) {
      setVisible(false);
      setExiting(false);
      return;
    }
    setExiting(true);
    const timer = setTimeout(() => {
      setVisible(false);
      setExiting(false);
    }, exitMs);
    return () => clearTimeout(timer);
  }, [active, exitMs, visible]);

  return { visible, exiting };
}

/* ── Measured timings ─────────────────────────────────────────────────── */

type LaneBootTimings = {
  discoveryMs: number | null;
  recentMs: number | null;
  deckMs: number | null;
  elapsedMs: number;
};

/**
 * Phase timings, measured client-side from when the load started. The server
 * reports none of this; it is the wall time the operator actually waited.
 */
function useLaneBootTimings(loadState: TailFeedLoadState, handedOff: boolean): LaneBootTimings {
  const startRef = useRef(Date.now());
  const [resolved, setResolved] = useState<{
    discoveryMs: number | null;
    recentMs: number | null;
    deckMs: number | null;
  }>({ discoveryMs: null, recentMs: null, deckMs: null });
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    setResolved((previous) => {
      const discoveryMs = previous.discoveryMs === null && loadState.discovery !== "loading"
        ? Date.now() - startRef.current
        : previous.discoveryMs;
      const recentMs = previous.recentMs === null && loadState.recent !== "loading"
        ? Date.now() - startRef.current
        : previous.recentMs;
      if (discoveryMs === previous.discoveryMs && recentMs === previous.recentMs) return previous;
      return { ...previous, discoveryMs, recentMs };
    });
  }, [loadState.discovery, loadState.recent]);

  useEffect(() => {
    if (!handedOff) return;
    setResolved((previous) => (
      previous.deckMs === null
        ? { ...previous, deckMs: Date.now() - startRef.current }
        : previous
    ));
  }, [handedOff]);

  // Stop the clock at hand-off: after that the number is a result, not a wait.
  useEffect(() => {
    if (resolved.deckMs !== null) return;
    const tick = () => setElapsedMs(Date.now() - startRef.current);
    tick();
    const timer = setInterval(tick, ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [resolved.deckMs]);

  return { ...resolved, elapsedMs };
}

/* ── Pre-flight deck ──────────────────────────────────────────────────── */

function PreflightBars({ seed, rows }: { seed: number; rows: number }) {
  // Varied widths so a wall of cells doesn't read as a printed pattern.
  const widths = useMemo(() => {
    const base = [68, 92, 54, 80, 61, 74];
    return Array.from({ length: rows }, (_, row) => base[(seed + row) % base.length]);
  }, [rows, seed]);
  return (
    <div className="s-lane-pre-bars" aria-hidden="true">
      {widths.map((width, row) => (
        <span
          key={`${row}-${width}`}
          className="s-lane-pre-bar"
          style={{ width: `${width}%`, animationDelay: `${seed * 110 + row * 90}ms` }}
        />
      ))}
    </div>
  );
}

function PreflightCell({
  cell,
  index,
  nowMs,
  style,
}: {
  cell: LanePreflightCell | null;
  index: number;
  nowMs: number;
  style?: React.CSSProperties;
}) {
  if (!cell) {
    return (
      <div className="s-lane-pre s-lane-pre--blind" style={style} aria-hidden="true">
        <div className="s-lane-pre-head">
          <span className="s-lane-pre-ghost s-lane-pre-ghost--dot" />
          <span className="s-lane-pre-ghost s-lane-pre-ghost--name" />
          <span className="s-lane-pre-spacer" />
          <span className="s-lane-pre-ghost s-lane-pre-ghost--meta" />
        </div>
        <PreflightBars seed={index} rows={6} />
      </div>
    );
  }

  const where = [cell.project, cell.cwd].find((value) => Boolean(value)) ?? "—";
  return (
    <div className="s-lane-pre" style={style}>
      <div className="s-lane-pre-head">
        <span className="s-lane-pre-dot" aria-hidden="true" />
        <span className="s-lane-pre-title">{preflightCellTitle(cell)}</span>
        <span className="s-lane-pre-where" title={cell.cwd ?? where}>{where}</span>
        <span className="s-lane-pre-spacer" />
        <span className="s-lane-pre-age">{timeAgo(cell.lastActiveAt, nowMs)}</span>
      </div>
      <PreflightBars seed={index} rows={5} />
    </div>
  );
}

/**
 * Which container to pre-draw. "none" is for the floor layout, which is a
 * different presentation entirely — there is no honest skeleton for it, so the
 * region stays empty and only the sheet reports.
 */
export type LanePreflightLayout = "grid" | "scroll" | "none";

export function AgentLanesPreflightDeck({
  discovery,
  discoveryPhase,
  windowMs,
  nowMs,
  layout,
  gridColumns,
  laneWidthPx,
  matchTranscript,
}: {
  discovery: TailDiscoverySnapshot | null;
  discoveryPhase: TailFeedLoadPhase;
  windowMs: number;
  nowMs: number;
  layout: LanePreflightLayout;
  gridColumns: AgentLanesGridColumns;
  laneWidthPx: number;
  /** Embed scoping, so a filtered surface pre-draws only what it will show. */
  matchTranscript?: (transcript: TailDiscoveredTranscript) => boolean;
}) {
  const gridMode = layout === "grid";
  const deck = useMemo(
    () => buildLanePreflightDeck({ discovery, discoveryPhase, windowMs, now: nowMs, matchTranscript }),
    [discovery, discoveryPhase, matchTranscript, nowMs, windowMs],
  );

  const cells: (LanePreflightCell | null)[] = deck.identified
    ? deck.cells
    : Array.from({ length: deck.blindCells }, () => null);

  // Nothing to pre-draw: either the layout has no skeleton, or discovery landed
  // with nothing active inside the horizon — no lanes are coming, so promising
  // cells for them would be a lie. Either way the region stays empty and the
  // sheet does the reporting.
  if (layout === "none" || cells.length === 0) {
    return <div className="s-agent-lanes-preflight-empty" aria-hidden="true" />;
  }

  const body = cells.map((cell, index) => (
    <PreflightCell
      key={cell?.key ?? `blind-${index}`}
      cell={cell}
      index={index}
      nowMs={nowMs}
      style={gridMode ? undefined : { width: `${laneWidthPx}px`, flex: "none" }}
    />
  ));

  if (gridMode) {
    return (
      <div
        className="s-agent-lanes-grid s-agent-lanes-grid--preflight"
        data-grid-columns={gridColumns}
        aria-label="Lane deck loading"
      >
        {body}
      </div>
    );
  }

  return (
    <div className="s-agent-lanes-body">
      <section className="s-agent-lanes-zone s-agent-lanes-zone--main">
        <div className="s-agent-lanes-scroll" aria-label="Lane deck loading">
          {body}
        </div>
      </section>
    </div>
  );
}

/* ── Status sheet ─────────────────────────────────────────────────────── */

function phaseToken(phase: TailFeedLoadPhase): "RUN" | "OK" | "WARN" {
  if (phase === "ready") return "OK";
  if (phase === "error") return "WARN";
  return "RUN";
}

function stepClassName(state: "pending" | "running" | "done" | "warn"): string {
  return `s-lane-boot-step s-lane-boot-step--${state}`;
}

function countLabel(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function msLabel(value: number | null): string {
  return value === null ? "" : `${Math.round(value)}ms`;
}

export function AgentLanesLoadingSheet({
  loadState,
  sourceCount,
  processCount,
  eventCount,
  laneCount,
  horizonLabel,
  handedOff,
  exiting,
}: {
  loadState: TailFeedLoadState;
  sourceCount: number;
  processCount: number;
  eventCount: number;
  laneCount: number;
  horizonLabel: string;
  handedOff: boolean;
  exiting: boolean;
}) {
  const timings = useLaneBootTimings(loadState, handedOff);
  const settled = loadState.discovery !== "loading" && loadState.recent !== "loading";

  const discoveryDetail = loadState.discovery === "ready"
    ? `${countLabel(sourceCount, "session source")} indexed`
    : loadState.discovery === "error"
      ? "session source scan unavailable"
      : "scanning local transcripts and harness processes";
  const recentDetail = loadState.recent === "ready"
    ? `${countLabel(eventCount, "recent event")} merged`
    : loadState.recent === "error"
      ? "history replay unavailable; live signals remain enabled"
      : `reading turns and tool output for the ${horizonLabel} view`;
  const assembleDetail = laneCount > 0
    ? `${countLabel(laneCount, "lane")} composed`
    : loadState.recent === "error"
      ? `${countLabel(eventCount, "live signal")} in, no history`
      : eventCount > 0
        ? `${countLabel(eventCount, "signal")} in, waiting on replay`
        : "waiting on first signals";

  const discoveryState = loadState.discovery === "ready"
    ? "done"
    : loadState.discovery === "error"
      ? "warn"
      : "running";
  const recentState = loadState.recent === "ready"
    ? "done"
    : loadState.recent === "error"
      ? "warn"
      : loadState.discovery === "loading"
        ? "pending"
        : "running";
  const assembleState = handedOff
    ? "done"
    : loadState.recent === "loading"
      ? "pending"
      : "running";

  // Milliseconds under a second so the readout agrees with the phase timings
  // beside it, tenths past that, and the exact hand-off time once it lands.
  const elapsedLabel = timings.deckMs !== null
    ? msLabel(timings.deckMs)
    : timings.elapsedMs < 1_000
      ? msLabel(timings.elapsedMs)
      : `${(timings.elapsedMs / 1000).toFixed(1)}s`;

  // The live socket often composes lanes before replay returns, so the deck can
  // be readable while a phase is still running. Drop the veil the moment there
  // is something real underneath — the sheet becomes a status strip, not a
  // cover over content the operator can already use.
  const bare = laneCount > 0;

  return (
    <div
      className={[
        "s-lane-boot",
        bare ? "s-lane-boot--bare" : null,
        exiting ? "s-lane-boot--exiting" : null,
      ].filter(Boolean).join(" ")}
      role="status"
      aria-live="polite"
      aria-busy={!settled}
    >
      <div className="s-lane-boot-veil" aria-hidden="true" />
      <div className="s-lane-boot-sheet">
        <div className="s-lane-boot-head">
          <span
            className={`s-lane-boot-dot${settled ? " s-lane-boot-dot--done" : ""}`}
            aria-hidden="true"
          />
          <span className="s-lane-boot-lead">Starting agent tail</span>
          <span className="s-lane-boot-count">{sourceCount.toLocaleString()} sources</span>
          <span className="s-lane-boot-count">{processCount.toLocaleString()} live</span>
          <span className="s-lane-boot-count">{eventCount.toLocaleString()} events</span>
          {laneCount > 0 ? (
            <span className="s-lane-boot-count">{laneCount.toLocaleString()} lanes</span>
          ) : null}
          <span className="s-lane-boot-spacer" />
          <span className="s-lane-boot-meta">lookback {horizonLabel}</span>
          {/* `role="status"` is atomic, so a readout ticking at 100ms would make
            * a screen reader re-read the whole checklist ten times a second.
            * The elapsed time is for the eye; the rows carry the meaning. */}
          <span className="s-lane-boot-elapsed" aria-hidden="true">{elapsedLabel}</span>
        </div>
        <div className="s-lane-boot-log">
          <div className={stepClassName(discoveryState)}>
            <span className="s-lane-boot-state">{phaseToken(loadState.discovery)}</span>
            <strong className="s-lane-boot-name">discover sessions</strong>
            <code className="s-lane-boot-detail">{discoveryDetail}</code>
            <span className="s-lane-boot-timing">{msLabel(timings.discoveryMs)}</span>
          </div>
          <div className={stepClassName(recentState)}>
            <span className="s-lane-boot-state">{phaseToken(loadState.recent)}</span>
            <strong className="s-lane-boot-name">replay recent tail</strong>
            <code className="s-lane-boot-detail">{recentDetail}</code>
            <span className="s-lane-boot-timing">{msLabel(timings.recentMs)}</span>
          </div>
          <div className={stepClassName(assembleState)}>
            <span className="s-lane-boot-state">{handedOff ? "OK" : "LIVE"}</span>
            <strong className="s-lane-boot-name">assemble lanes</strong>
            <code className="s-lane-boot-detail">{assembleDetail}</code>
            <span className="s-lane-boot-timing">{msLabel(timings.deckMs)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
