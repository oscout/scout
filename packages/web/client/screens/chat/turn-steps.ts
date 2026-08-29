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

export type TurnExecutionPhase =
  | "planning"
  | "inspection"
  | "mutation"
  | "execution"
  | "verification"
  | "coordination";

export type TurnStepStatus = "working" | "success" | "warning" | "error";

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
  /** Classified execution phase */
  phase: TurnExecutionPhase;
  /** Execution status for telemetry */
  status: TurnStepStatus;
  /** Execution duration in ms (if calculable) */
  durationMs?: number;
};

export type TurnLaunchPhase = {
  label: string;
  detail: string;
};

export const TURN_PHASE_LABELS: Record<TurnExecutionPhase, string> = {
  planning: "Planning",
  inspection: "Inspection",
  mutation: "Mutations",
  execution: "Execution",
  verification: "Verification",
  coordination: "Coordination",
};

export type PhaseSummary = {
  phase: TurnExecutionPhase;
  label: string;
  count: number;
  active: boolean;
};

export function classifyTurnStepPhase(input: {
  kind: TurnStepKind;
  tool?: string;
  arg?: string;
  text?: string;
  outcome?: string;
}): TurnExecutionPhase {
  if (input.kind === "think") return "planning";

  const toolLower = input.tool?.toLowerCase() ?? "";
  const argLower = input.arg?.toLowerCase() ?? "";
  const textLower = input.text?.toLowerCase() ?? "";
  const outcomeLower = input.outcome?.toLowerCase() ?? "";

  // Verification (tests, typecheck, lint, check)
  if (
    toolLower.includes("test") ||
    toolLower.includes("check") ||
    toolLower.includes("lint") ||
    toolLower.includes("typecheck") ||
    toolLower.includes("verify") ||
    /\b(?:bun|npm|pnpm|yarn|cargo|pytest|go|vitest|jest|playwright|cypress)\s+(?:test|run\s+(?:check|test|lint)|check|typecheck)/i.test(argLower) ||
    /\b(?:\d+\s+pass|all tests passed|test passed|lint clean|tsc clean)\b/i.test(outcomeLower)
  ) {
    return "verification";
  }

  // File mutations (edits, writes, deletions, patches)
  if (
    toolLower === "write" ||
    toolLower === "edit" ||
    toolLower === "strreplace" ||
    toolLower === "str_replace" ||
    toolLower === "delete" ||
    toolLower === "write_file" ||
    toolLower === "edit_file" ||
    toolLower === "patch" ||
    toolLower === "apply_patch" ||
    toolLower === "todowrite" ||
    toolLower === "todo_write" ||
    /\b(?:git\s+apply|git\s+commit|git\s+add|rm\s+|mkdir\s+|touch\s+|sed\s+|awk\s+)/i.test(argLower) ||
    /^\+\d+\s+[−-]\d+/u.test(outcomeLower)
  ) {
    return "mutation";
  }

  // Inspection / Search / Read
  if (
    toolLower === "read" ||
    toolLower === "glob" ||
    toolLower === "grep" ||
    toolLower === "filesearch" ||
    toolLower === "file_search" ||
    toolLower === "list_dir" ||
    toolLower === "list_directory" ||
    toolLower === "view" ||
    toolLower === "fetch" ||
    toolLower === "webfetch" ||
    toolLower === "websearch" ||
    toolLower === "scout_search" ||
    toolLower === "search" ||
    /\b(?:grep|find|rg|cat|head|tail|ls|git\s+status|git\s+diff|git\s+log|git\s+branch)/i.test(argLower)
  ) {
    return "inspection";
  }

  // Planning / Reasoning in text
  if (
    input.kind === "note" ||
    /\b(?:planning|plan|evaluating|analyzing|reasoning|strategy)\b/i.test(textLower)
  ) {
    return "planning";
  }

  // Tool / Subprocess Execution
  if (
    input.kind === "tool" ||
    toolLower === "bash" ||
    toolLower === "shell" ||
    toolLower === "terminal" ||
    toolLower === "exec" ||
    toolLower === "run" ||
    toolLower === "command" ||
    toolLower === "task"
  ) {
    return "execution";
  }

  return "coordination";
}

export function deriveStepStatus(input: {
  outcome?: string;
  isLatest?: boolean;
  isActive?: boolean;
}): TurnStepStatus {
  const outcomeLower = input.outcome?.toLowerCase() ?? "";
  if (
    outcomeLower.includes("error") ||
    outcomeLower.includes("fail") ||
    outcomeLower.includes("exit 1") ||
    outcomeLower.includes("rejected") ||
    outcomeLower.includes("timed out")
  ) {
    return "error";
  }
  if (outcomeLower.includes("warn") || outcomeLower.includes("skipped")) {
    return "warning";
  }
  if (input.outcome || !input.isLatest) {
    return "success";
  }
  return input.isActive ? "working" : "success";
}

export function formatStepDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const secs = durationMs / 1000;
  if (secs < 60) return `${secs.toFixed(1).replace(/\.0$/, "")}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${mins}m ${remSecs}s`;
}

export function summarizeTurnPhases(steps: TurnStep[]): PhaseSummary[] {
  if (steps.length === 0) return [];
  const counts = new Map<TurnExecutionPhase, number>();
  for (const step of steps) {
    counts.set(step.phase, (counts.get(step.phase) ?? 0) + (step.repeatCount || 1));
  }
  const lastStep = steps.at(-1);
  const activePhase = lastStep?.phase ?? "planning";

  const phases: TurnExecutionPhase[] = [
    "planning",
    "inspection",
    "mutation",
    "execution",
    "verification",
    "coordination",
  ];

  return phases
    .filter((phase) => (counts.get(phase) ?? 0) > 0)
    .map((phase) => ({
      phase,
      label: TURN_PHASE_LABELS[phase],
      count: counts.get(phase) ?? 0,
      active: phase === activePhase,
    }));
}

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
        previous.status = deriveStepStatus({ outcome: previous.outcome });
        // Recalculate phase if outcome clarifies mutation/verification
        previous.phase = classifyTurnStepPhase({
          kind: previous.kind,
          tool: previous.tool,
          arg: previous.arg,
          text: previous.text,
          outcome: previous.outcome,
        });
      }
      continue;
    }

    const kind = tailStepKind(row.event);
    const text = stepText(row.event, observeTextFromTailEvent(row.event, row.meta), kind);
    if (!text && kind !== "think") continue;

    const tool = row.meta.tool;
    const arg = row.meta.arg ? truncateStepText(row.meta.arg) : undefined;
    const outcome = row.meta.result?.outcome;
    const phase = classifyTurnStepPhase({ kind, tool, arg, text, outcome });
    const status = deriveStepStatus({ outcome });

    const step: TurnStep = {
      id: row.event.id,
      ts: row.event.ts,
      kind,
      text,
      repeatCount: row.repeatCount,
      phase,
      status,
    };
    if (tool) step.tool = tool;
    if (arg) step.arg = arg;
    if (outcome) step.outcome = outcome;
    steps.push(step);
  }

  // Calculate duration between steps
  for (let i = 0; i < steps.length - 1; i++) {
    const current = steps[i];
    const next = steps[i + 1];
    if (current && next && next.ts >= current.ts) {
      current.durationMs = next.ts - current.ts;
    }
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

  const steps = scoped.slice(-TURN_STEP_LIMIT).map((event) => {
    const outcome = observeResultOutcome(event.result);
    const diffOutcome = event.diff ? `+${event.diff.add} −${event.diff.del}` : undefined;
    const finalOutcome = diffOutcome || outcome;
    const phase = classifyTurnStepPhase({
      kind: event.kind,
      tool: event.tool,
      arg: event.arg,
      text: event.text,
      outcome: finalOutcome,
    });
    const status = deriveStepStatus({ outcome: finalOutcome });

    const step: TurnStep = {
      id: `observe:${observe.sessionId ?? "session"}:${event.id}`,
      ts: event.at ?? event.t,
      kind: event.kind,
      text: truncateStepText(event.text || event.tool || "step"),
      repeatCount: 1,
      phase,
      status,
    };
    if (event.tool) step.tool = event.tool;
    if (event.arg) step.arg = truncateStepText(event.arg);
    if (finalOutcome) step.outcome = finalOutcome;
    return step;
  });

  for (let i = 0; i < steps.length - 1; i++) {
    const current = steps[i];
    const next = steps[i + 1];
    if (current && next && next.ts >= current.ts) {
      current.durationMs = next.ts - current.ts;
    }
  }

  return steps;
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
