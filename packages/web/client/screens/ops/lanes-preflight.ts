/**
 * Pre-flight deck model for the Agent Lanes loading state.
 *
 * Opening /ops/lanes costs two requests — a transcript scan and a tail replay —
 * and the old loading state was a centred console card that said the same thing
 * at 80ms as it did at 2.4s. The replacement draws the deck first: one cell per
 * session we expect a lane for, at the deck's real size, from the first frame.
 *
 * The point of this module is that the cells are *not* decoration. Identity
 * arrives with discovery, an order of magnitude before replay finishes, so a
 * cell can carry its real runtime, session, project and age at ~230ms and only
 * its body has to wait for lines. Two states, in order:
 *
 *   blind      — discovery still in flight; nothing predicts the count, so we
 *                draw a small fixed number of anonymous cells.
 *   identified — discovery landed; both the count and the identities come from
 *                the transcripts that were active inside the current horizon.
 *
 * Sizing by anything looser would over-promise badly. `totals.transcripts`
 * counts every transcript on disk (hundreds), and `processes` can list several
 * entries per session; either would leave the hand-off revealing far fewer
 * lanes than the skeleton advertised.
 *
 * This is a prediction, not a promise, and the residual is worth naming.
 * `buildAgentLanes` admits a lane on the newest *substantive* tail event
 * (`isLaneAdmissionTailEvent`), and those events do not exist yet while
 * discovery is the only thing that has returned — so the best evidence
 * available here is when the transcript was last written. The two disagree
 * when a transcript is touched inside the horizon but yields nothing
 * admissible: records the parser discards, rotation, or a replay budget that
 * returned no lines for that session. The error is therefore bounded and
 * one-directional — a cell or two more than the deck ends up with — which is
 * why `max` exists and why the correction lands under a retracting sheet
 * rather than as a visible collapse.
 */
import type { TailDiscoverySnapshot, TailDiscoveredTranscript } from "../../lib/types.ts";
import type { TailFeedLoadPhase } from "../../lib/use-tail-feed.ts";

/**
 * Cells drawn before discovery returns anything to count. Deliberately few:
 * this number is a placeholder, not a prediction, and the correction to the
 * real count should read as the deck filling in rather than emptying out.
 */
export const PREFLIGHT_BLIND_CELLS = 3;
/** Upper bound on pre-flight cells, so a busy machine can't carpet the deck. */
export const PREFLIGHT_MAX_CELLS = 12;

export type LanePreflightCell = {
  /** Stable key for the cell. */
  key: string;
  /** Runtime that owns the session ("claude", "codex", …). */
  source: string;
  /** Abbreviated session id, when the transcript names one. */
  sessionLabel: string | null;
  project: string;
  cwd: string | null;
  /** Latest known activity — drives the age readout. */
  lastActiveAt: number;
};

export type LanePreflightDeck = {
  /** Identified cells. Empty while discovery is still in flight. */
  cells: LanePreflightCell[];
  /** Anonymous cells to draw instead — non-zero only before discovery lands. */
  blindCells: number;
  /** True once discovery has resolved, whether or not it found anything. */
  identified: boolean;
};

/**
 * Abbreviated session id. Long enough to survive UUIDv7: sessions started in
 * the same millisecond share their first 8 characters, so a shorter slice
 * renders two different cells under the same name.
 */
export function preflightSessionLabel(sessionId: string | null | undefined): string | null {
  const trimmed = sessionId?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 13);
}

function transcriptActivityAt(transcript: TailDiscoveredTranscript): number {
  const lastEvent = transcript.lastEventAt;
  if (typeof lastEvent === "number" && Number.isFinite(lastEvent) && lastEvent > 0) {
    return lastEvent;
  }
  return transcript.mtimeMs;
}

function transcriptKey(transcript: TailDiscoveredTranscript): string {
  return transcript.sessionId?.trim() || transcript.transcriptPath;
}

export function buildLanePreflightDeck(input: {
  discovery: TailDiscoverySnapshot | null;
  discoveryPhase: TailFeedLoadPhase;
  /** Current horizon window — the same one the lane deck filters by. */
  windowMs: number;
  now: number;
  max?: number;
  blindCells?: number;
  /**
   * Embed scoping, when the surface is filtered. An embed that shows one
   * project's lanes must not pre-draw cells for every other project, so the
   * caller passes the same predicate the deck filters lanes with rather than
   * this module re-deriving it and drifting from it.
   */
  matchTranscript?: (transcript: TailDiscoveredTranscript) => boolean;
}): LanePreflightDeck {
  const max = input.max ?? PREFLIGHT_MAX_CELLS;

  if (input.discoveryPhase === "loading") {
    return {
      cells: [],
      blindCells: Math.min(input.blindCells ?? PREFLIGHT_BLIND_CELLS, max),
      identified: false,
    };
  }

  const transcripts = input.discovery?.transcripts ?? [];
  const seen = new Set<string>();
  const cells: LanePreflightCell[] = [];

  for (const transcript of transcripts
    .filter((transcript) => {
      if (input.matchTranscript && !input.matchTranscript(transcript)) return false;
      const age = input.now - transcriptActivityAt(transcript);
      // A transcript that has been quiet longer than the horizon will not
      // produce a lane, so promising a cell for it would be a lie.
      return age >= 0 ? age <= input.windowMs : true;
    })
    .sort((left, right) => transcriptActivityAt(right) - transcriptActivityAt(left))) {
    const key = transcriptKey(transcript);
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({
      key,
      source: transcript.source,
      sessionLabel: preflightSessionLabel(transcript.sessionId),
      project: transcript.project,
      cwd: transcript.cwd,
      lastActiveAt: transcriptActivityAt(transcript),
    });
    if (cells.length >= max) break;
  }

  return { cells, blindCells: 0, identified: true };
}

/** Short display name for a pre-flight cell. */
export function preflightCellTitle(cell: LanePreflightCell): string {
  return cell.sessionLabel ? `${cell.source}:${cell.sessionLabel}` : cell.source;
}
