/**
 * Live step ledger for the working turn.
 *
 * The thread's in-progress card used to carry four strings (`latest`,
 * `activity`, `elapsed`, `last`) projected from broker activity rows — a
 * coordination ledger that records "a flight changed state", never what the
 * agent is actually doing. The harness detail (thinking blocks, tool calls,
 * their outcomes) already flows through the Tail firehose the inspector rail
 * subscribes to; this module scopes that firehose down to the turn's own
 * session and shapes it into ordered steps.
 *
 * Scope is deliberately session-id only. `buildTailPreviewContext` also matches
 * on cwd/project, which is right for an "everything in this workspace" rail and
 * wrong here: on a shared repo it would splice other agents' steps into this
 * turn. With no session id yet we render the launch phase instead of guessing.
 */
import {
  collapseTailDisplayRows,
  filterTailEventsForDisplay,
  observeKindFromTailEvent,
  observeTextFromTailEvent,
  observeToolFieldsFromTailEvent,
} from "../../lib/tail-display.ts";
import { normalizeTimestampMs } from "../../lib/time.ts";
import type { Agent, Flight, ObserveEvent, SessionEntry, TailEvent } from "../../lib/types.ts";

/** Ceiling on retained steps per turn; the card shows a window of these. */
export const TURN_STEP_LIMIT = 60;

export type TurnStepKind = ObserveEvent["kind"];

export type TurnStep = {
  id: string;
  ts: number;
  kind: TurnStepKind;
  /** Rendered line: tool call, thinking text, assistant line, system note. */
  text: string;
  tool?: string;
  arg?: string;
  outcome?: string;
  /** Consecutive identical lines collapse into one row with a count. */
  repeatCount: number;
};

export type TurnLaunchPhase = {
  label: string;
  detail: string;
};

function pushUnique(into: string[], seen: Set<string>, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  into.push(trimmed);
}

/**
 * Session ids that identify this turn's execution. Flight traces come first:
 * they name the session that was live when the turn started, which is the only
 * correct answer once an agent has been reused across turns.
 */
export function buildTurnStepScope(input: {
  flight: Flight | null;
  agent: Agent | null;
  sessionMeta: SessionEntry | null;
  /**
   * The observe poll resolves the *harness* session id (the transcript uuid
   * Tail keys on). Flight traces and session records carry the Scout session
   * id, which frequently does not appear in tail at all — so when observe has
   * resolved one it is the highest-value key we hold.
   */
  observeSessionId?: string | null;
}): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  pushUnique(ids, seen, input.observeSessionId);
  for (const trace of input.flight?.sessions ?? []) {
    pushUnique(ids, seen, trace.sessionId);
  }
  pushUnique(ids, seen, input.agent?.harnessSessionId);
  pushUnique(ids, seen, input.sessionMeta?.harnessSessionId);
  return ids;
}

/**
 * Tail carries the harness session id; flight traces and session records carry
 * the Scout session id, and one is frequently a prefix/suffix of the other, so
 * match both directions rather than requiring equality.
 */
export function tailEventMatchesTurn(event: TailEvent, sessionIds: string[]): boolean {
  const candidate = event.sessionId?.trim().toLowerCase();
  if (!candidate) return false;
  return sessionIds.some((id) => {
    const scoped = id.trim().toLowerCase();
    if (!scoped) return false;
    return candidate.includes(scoped) || scoped.includes(candidate);
  });
}

function compareStepsAscending(left: TailEvent, right: TailEvent): number {
  if (left.ts !== right.ts) return left.ts - right.ts;
  return left.id.localeCompare(right.id);
}

/** Merge live arrivals into the retained window, oldest first, deduped by id. */
export function mergeTurnStepEvents(previous: TailEvent[], incoming: TailEvent[]): TailEvent[] {
  const byId = new Map<string, TailEvent>();
  for (const event of [...previous, ...incoming]) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort(compareStepsAscending).slice(-TURN_STEP_LIMIT);
}

/**
 * Shape tail lines into steps: drop harness noise, collapse repeats, and lift
 * tool name/argument/outcome out of the summary so a row can read as
 * "Bash · bun test" rather than a raw log line.
 */
export function toTurnSteps(events: TailEvent[]): TurnStep[] {
  const ordered = filterTailEventsForDisplay(events, "work").sort(compareStepsAscending);
  const rows = collapseTailDisplayRows(
    ordered.map((event) => ({ event, meta: observeToolFieldsFromTailEvent(event) })),
  );

  const steps: TurnStep[] = [];
  for (const row of rows) {
    // Attachments and other framing lines are transport, not work.
    if (row.event.kind === "other") continue;

    // A result belongs to the call above it. Folding it in as an outcome keeps
    // the ledger one-row-per-action instead of alternating call/dump — and a
    // result whose call has scrolled away carries nothing on its own.
    if (row.event.kind === "tool-result") {
      const previous = steps.at(-1);
      if (previous?.kind === "tool") {
        previous.outcome = row.meta.result?.outcome ?? previous.outcome ?? "done";
        previous.ts = row.event.ts;
      }
      continue;
    }

    const kind = tailStepKind(row.event);
    const text = stepText(row.event, observeTextFromTailEvent(row.event, row.meta), kind);
    if (!text && kind !== "think") continue;

    const step: TurnStep = {
      id: row.event.id,
      ts: row.event.ts,
      kind,
      text,
      repeatCount: row.repeatCount,
    };
    if (row.meta.tool) step.tool = row.meta.tool;
    if (row.meta.arg) step.arg = truncateStepText(row.meta.arg);
    if (row.meta.result?.outcome) step.outcome = row.meta.result.outcome;
    steps.push(step);
  }
  return steps;
}

/** Longest step body we render; the row ellipsises, but the model shouldn't carry a log dump. */
const STEP_TEXT_LIMIT = 160;

function truncateStepText(value: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > STEP_TEXT_LIMIT
    ? `${collapsed.slice(0, STEP_TEXT_LIMIT - 1)}…`
    : collapsed;
}

const BARE_THINKING = /^\[thinking\]\s*$/iu;

/**
 * Harnesses that redact reasoning still emit the marker with no body. That is
 * a thinking step, not an assistant message — the row says so with its label
 * and carries no text rather than printing the marker.
 */
function tailStepKind(event: TailEvent): TurnStepKind {
  if (BARE_THINKING.test(event.summary.trim())) return "think";
  return observeKindFromTailEvent(event);
}

function stepText(event: TailEvent, resolved: string, kind: TurnStepKind): string {
  if (kind === "think" && BARE_THINKING.test(event.summary.trim())) return "";
  return truncateStepText(resolved);
}

const OBSERVE_STEP_START_SLACK_MS = 15_000;

function observeResultOutcome(result: ObserveEvent["result"]): string | undefined {
  const outcome = result?.outcome;
  return typeof outcome === "string" && outcome.trim() ? outcome.trim() : undefined;
}

/**
 * Same ledger shape from the polled observe payload, for when the Tail stream
 * is out of reach (remote node, no transcript on this host). Tool name,
 * argument, and outcome survive the projection so the rows read the same
 * from either source.
 */
export function observeTurnSteps(input: {
  observe: { data: { events: ObserveEvent[]; live?: boolean }; sessionId?: string | null } | null;
  flight: Flight | null;
}): TurnStep[] {
  const { observe, flight } = input;
  if (!observe || !flight) return [];
  const events = observe.data.events.filter(
    (event) => event.kind !== "boot" && event.kind !== "system",
  );
  if (events.length === 0) return [];

  const startedAt = normalizeTimestampMs(flight.startedAt);
  const withinTurn = startedAt !== null
    ? events.filter(
        (event) =>
          typeof event.at === "number" && event.at >= startedAt - OBSERVE_STEP_START_SLACK_MS,
      )
    : [];
  // Scoping by flight start is the precise answer, but it silently yields
  // nothing when the trace carries no wall-clock stamps (synthetic fidelity) or
  // when a control-event flight arrived without `startedAt`. Showing the live
  // session's most recent steps is the honest read in both cases — the session
  // is verifiably live, and these are the steps it is taking right now.
  const scoped = withinTurn.length > 0
    ? withinTurn
    : observe.data.live
      ? events
      : [];

  return scoped.slice(-TURN_STEP_LIMIT).map((event) => {
    const step: TurnStep = {
      id: `observe:${observe.sessionId ?? "session"}:${event.id}`,
      ts: event.at ?? event.t,
      kind: event.kind,
      text: truncateStepText(event.text || event.tool || "step"),
      repeatCount: 1,
    };
    if (event.tool) step.tool = event.tool;
    if (event.arg) step.arg = truncateStepText(event.arg);
    const outcome = observeResultOutcome(event.result);
    if (outcome) step.outcome = outcome;
    if (event.diff) {
      step.outcome = `+${event.diff.add} −${event.diff.del}`;
    }
    return step;
  });
}

/**
 * One line for the card's "Latest" slot, taken from the newest step. The
 * broker's own summary for a live turn is "<name> is still working."; the
 * step says what it is working on.
 */
export function latestStepSummary(steps: TurnStep[]): string | null {
  const last = steps.at(-1);
  if (!last) return null;
  if (last.tool) return last.arg ? `${last.tool} · ${last.arg}` : last.tool;
  if (last.kind === "think") return last.text || "Thinking";
  return last.text || null;
}

/** "3 tools · 2 thinking" — counted over the whole turn, not the visible window. */
export function summarizeTurnSteps(steps: TurnStep[]): string | null {
  if (steps.length === 0) return null;
  const tools = steps.filter((step) => step.kind === "tool").length;
  const thinking = steps.filter((step) => step.kind === "think").length;
  const parts: string[] = [];
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (thinking > 0) parts.push(`${thinking} thinking`);
  if (parts.length === 0) return `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return parts.join(" · ");
}

/**
 * What to say before the first trace line lands. Every branch is backed by a
 * flight state we actually hold — the point is to replace a bare spinner with
 * the real stage, not to narrate a pipeline we can't observe.
 */
export function describeTurnLaunchPhase(input: {
  flight: Flight | null;
  hasSessionScope: boolean;
  awaitingResponse: boolean;
}): TurnLaunchPhase | null {
  const state = input.flight?.state;
  if (state === "queued") {
    return { label: "Queued", detail: "waiting for the session to come online" };
  }
  if (state === "waking") {
    return { label: "Waking", detail: "starting the session" };
  }
  if (state === "running" || state === "waiting") {
    return input.hasSessionScope
      ? { label: "Session live", detail: "waiting for the first trace line" }
      : { label: "Session live", detail: "no trace stream for this session yet" };
  }
  if (input.awaitingResponse) {
    return { label: "Sent", detail: "waiting for the agent to pick this up" };
  }
  return null;
}
