/**
 * The desktop companion's card model: one pinned work item, reduced to what a
 * 328pt card can say truthfully.
 *
 * Two lanes, never mixed:
 *   reported — what the agent said through work_update (collaboration events).
 *              Only reported lines set a card's state and headline.
 *   observed — what Scout saw: flight start/finish rows and the session tail.
 *              They show that something is moving; they never change state.
 *
 * No percentages, no bars. "Done" needs a reported completion. A session that
 * ends without one says so. Silence past QUIET_AFTER_MS reads "Quiet Nm",
 * never "stuck". Pure functions only, so the mapping is testable without a DOM.
 */

import type { AgentObservePayload, TailEvent, WorkDetail, WorkItem } from "../../lib/types.ts";

export const QUIET_AFTER_MS = 8 * 60_000;
export const MAX_VISIBLE_CARDS = 3;
export const REPORTED_LIMIT = 4;
export const OBSERVED_LIMIT = 7;
const NOW_WINDOW_MS = 60_000;
const OPERATOR_IDS = new Set(["operator"]);

export type CompanionCardState =
  | "working"
  | "quiet"
  | "waiting"
  | "question"
  | "blocked"
  | "done"
  | "cancelled"
  | "ended";

export type CompanionLine = { at: number; text: string };

export type CompanionCallout = {
  tone: "question" | "blocker" | "output";
  label: string;
  text: string;
};

export type CompanionCard = {
  workId: string;
  title: string;
  /** "project · agent · harness", whichever parts are known. */
  who: string;
  /** Project initials for the identity tile; Scout has no project icon set. */
  initials: string;
  state: CompanionCardState;
  /** Bold lead-in ("Asks you", "Blocked", "Quiet 9m"); empty while working. */
  status: string;
  statusTone: "plain" | "error" | "muted";
  /** The reported text after the lead-in. */
  headline: string;
  callout: CompanionCallout | null;
  /** Latest observed line, shown collapsed while working or quiet. */
  observedLine: string | null;
  sessionTail: CompanionLine[];
  reported: CompanionLine[];
  observed: CompanionLine[];
  /** Whether the observed lane includes session-tail lines, not only flights. */
  tailMatched: boolean;
  /** Most recent reported or observed activity. */
  lastActivityAt: number;
  /** When the reported headline was written. */
  reportedAt: number;
  ageLabel: string;
  conversationId: string | null;
};

export type CompanionCardContext = {
  /** Reference time: now while live, the last sync while disconnected. */
  now: number;
  /** False while the broker stream is down; ages never read "now" then. */
  live: boolean;
  /** Tail events already filtered to this work's harness session. */
  tail?: readonly TailEvent[];
  tailMatched?: boolean;
  history?: readonly CompanionLine[];
  project?: string | null;
  harness?: string | null;
};

/** Agent replies carry an `[ask:<id>]` routing tag that means nothing on a card. */
export function cleanReportText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/^\s*\[ask:[^\]]*\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function ageLabel(at: number, ref: number): string {
  const seconds = Math.max(0, Math.round((ref - at) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function clockLabel(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function projectInitials(project: string | null | undefined, fallback: string): string {
  const source = (project?.trim() || fallback.trim() || "?").replace(/[^A-Za-z0-9]+/g, " ").trim();
  const words = source.split(" ").filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function reportedEvents(detail: WorkDetail) {
  return detail.timeline
    .filter((item) => item.kind === "collaboration_event")
    .map((item) => ({ at: item.at, kind: item.detailKind ?? "", text: cleanReportText(item.summary) }))
    .sort((a, b) => a.at - b.at);
}

function latestReport(
  events: ReturnType<typeof reportedEvents>,
  kinds?: readonly string[],
): { at: number; kind: string; text: string } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!event.text) continue;
    if (kinds && !kinds.includes(event.kind)) continue;
    return event;
  }
  return null;
}

function observedLines(detail: WorkDetail, tail: readonly CompanionLine[]): CompanionLine[] {
  const flights: CompanionLine[] = detail.timeline
    .filter((item) => item.kind === "flight_started" || item.kind === "flight_completed")
    .map((item) => ({
      at: item.at,
      text: item.kind === "flight_started"
        ? `Flight started${item.actorName ? ` · ${item.actorName}` : ""}`
        : `Flight ${item.detailKind && item.detailKind !== "completed" ? item.detailKind : "completed"}${item.actorName ? ` · ${item.actorName}` : ""}`,
    }));
  return [...flights, ...tail].sort((a, b) => a.at - b.at).slice(-OBSERVED_LIMIT);
}

/** Keep real wall-clock times; synthetic transcript offsets must not look live. */
export function sessionHistory(payload: AgentObservePayload): CompanionLine[] {
  return payload.data.events
    .filter((event) => (event.kind === "tool" || event.kind === "message" || event.kind === "note") && event.at && Number.isFinite(event.at))
    .map((event) => ({ at: event.at!, text: (event.text || (event.tool ? `${event.tool}${event.arg ? ` · ${event.arg}` : ""}` : "")).replace(/\s+/g, " ").trim().slice(0, 500) }))
    .filter((line) => line.text && !/^\[[a-z _-]+\]$/i.test(line.text))
    .sort((a, b) => a.at - b.at).slice(-OBSERVED_LIMIT);
}

function sessionTailLines(tail: readonly TailEvent[], history: readonly CompanionLine[]): CompanionLine[] {
  const lines = [...history, ...tail
    .filter((event) => event.kind !== "user" && event.summary.trim() && !/^\[[a-z _-]+\]$/i.test(event.summary.trim()))
    .map((event) => ({ at: event.ts, text: event.summary.replace(/\s+/g, " ").trim() }))];
  return [...new Map(lines.map((line) => [`${line.at}:${line.text}`, line])).values()]
    .sort((a, b) => a.at - b.at).slice(-OBSERVED_LIMIT);
}

function isOperatorOwned(detail: WorkDetail): boolean {
  const next = detail.nextMoveOwnerId?.trim();
  return Boolean(next && OPERATOR_IDS.has(next));
}

/**
 * The turn behind this work finished, nothing is running now, and the agent
 * never reported waiting, review, done or cancelled. The honest reading is
 * "the session ended without a completion report", not "done".
 */
function sessionEndedWithoutReport(detail: WorkDetail): boolean {
  if (detail.activeFlights.length > 0 || detail.activeFlightCount > 0) return false;
  if (detail.allFlights.length === 0) return false;
  return detail.allFlights.every((flight) => !["queued", "waking", "running", "waiting"].includes(flight.state));
}

export function buildCompanionCard(detail: WorkDetail, context: CompanionCardContext): CompanionCard {
  const events = reportedEvents(detail);
  const tail = context.tail ?? [];
  const sessionTail = sessionTailLines(tail, context.history ?? []);
  const observed = observedLines(detail, sessionTail);
  const latest = latestReport(events);
  const reportedText = latest?.text || cleanReportText(detail.lastMeaningfulSummary) || "";
  const reportedAt = latest?.at ?? detail.lastMeaningfulAt ?? detail.updatedAt;
  const lastObservedAt = observed.at(-1)?.at ?? 0;
  const lastActivityAt = Math.max(detail.updatedAt, detail.lastMeaningfulAt ?? 0, reportedAt, lastObservedAt);

  let state: CompanionCardState;
  let status = "";
  let statusTone: CompanionCard["statusTone"] = "plain";
  let headline = reportedText || "No report yet";
  let callout: CompanionCallout | null = null;

  if (detail.state === "done") {
    state = "done";
    status = "Done";
    const done = latestReport(events, ["done"]);
    const output = done?.text || reportedText;
    headline = "";
    if (output) callout = { tone: "output", label: "Output · reported", text: output };
  } else if (detail.state === "cancelled") {
    state = "cancelled";
    status = "Cancelled";
    statusTone = "muted";
    headline = latestReport(events, ["cancelled"])?.text ?? "";
  } else if (detail.attention === "interrupt") {
    state = "blocked";
    status = "Blocked";
    statusTone = "error";
    headline = "";
    callout = {
      tone: "blocker",
      label: "Blocker · reported",
      text: latestReport(events, ["waiting"])?.text || reportedText || "The agent reported a blocker without detail.",
    };
  } else if ((detail.state === "waiting" || detail.state === "review") && isOperatorOwned(detail)) {
    state = "question";
    const review = detail.state === "review";
    const ask = latestReport(events, review ? ["review_requested"] : ["waiting"]) ?? latest;
    status = review ? "Ready for review" : "Asks you";
    headline = "";
    callout = {
      tone: "question",
      label: `${review ? "Review" : "Question"} · reported ${ageLabel(ask?.at ?? reportedAt, context.now)} ago`,
      text: ask?.text || reportedText || "Open the thread for the request.",
    };
  } else if (detail.state === "waiting" || detail.state === "review") {
    state = "waiting";
    status = `Waiting on ${detail.nextMoveOwnerName ?? detail.nextMoveOwnerId ?? "someone"}`;
    statusTone = "muted";
  } else if (sessionEndedWithoutReport(detail)) {
    state = "ended";
    status = "Session ended";
    statusTone = "muted";
    headline = "no completion reported";
  } else if (context.now - lastActivityAt > QUIET_AFTER_MS) {
    state = "quiet";
    status = `Quiet ${ageLabel(lastActivityAt, context.now)}`;
    statusTone = "muted";
    headline = reportedText ? `last reported: ${reportedText}` : "nothing reported yet";
  } else {
    state = "working";
  }

  const owner = detail.primaryInvocation?.targetAgentName ?? detail.ownerName ?? detail.ownerId;
  const harness = context.harness
    ?? detail.primaryInvocation?.observedHarness
    ?? detail.primaryInvocation?.resolvedHarness
    ?? detail.primaryInvocation?.requestedHarness
    ?? null;
  const who = [context.project, owner, harness].filter((part): part is string => Boolean(part?.trim())).join(" · ");
  const fresh = context.live && state === "working" && context.now - lastActivityAt < NOW_WINDOW_MS;

  return {
    workId: detail.id,
    title: detail.title,
    who,
    initials: projectInitials(context.project, detail.title),
    state,
    status,
    statusTone,
    headline,
    callout,
    observedLine: state === "working" || state === "quiet" ? observed.at(-1)?.text ?? null : null,
    reported: events.filter((event) => event.text).slice(-REPORTED_LIMIT).map(({ at, text }) => ({ at, text })),
    observed,
    sessionTail,
    tailMatched: Boolean(context.tailMatched),
    lastActivityAt,
    reportedAt,
    ageLabel: fresh ? "now" : ageLabel(lastActivityAt, context.now),
    conversationId: detail.conversationId ?? detail.primaryInvocation?.conversationId ?? null,
  };
}

/** States that hold their slot: a bring-in never evicts a card that needs the operator. */
export function cardHoldsSlot(state: CompanionCardState | undefined): boolean {
  return state === "question" || state === "blocked";
}

/**
 * Swap one hidden pin into the visible slot the operator touched least
 * recently, skipping cards that ask a question or are blocked while another
 * slot will do. Nothing else moves. Returns the new pin order.
 */
export function bringIntoView(
  order: readonly string[],
  workId: string,
  states: ReadonlyMap<string, CompanionCardState>,
  touchedAt: ReadonlyMap<string, number>,
  visibleCount = MAX_VISIBLE_CARDS,
): string[] {
  const next = [...order];
  const incoming = next.indexOf(workId);
  if (incoming < 0 || incoming < visibleCount) return next;
  const visible = next.slice(0, visibleCount);
  const candidates = visible
    .map((id, index) => ({ id, index, touched: touchedAt.get(id) ?? 0 }))
    .sort((a, b) => a.touched - b.touched || a.index - b.index);
  const out = candidates.find((candidate) => !cardHoldsSlot(states.get(candidate.id))) ?? candidates.at(-1);
  if (!out) return next;
  next[out.index] = workId;
  next[incoming] = out.id;
  return next;
}

/** "2 ask you · 1 blocked" for the overflow row, so nothing urgent hides. */
export function overflowSummary(states: readonly (CompanionCardState | undefined)[]): string {
  const questions = states.filter((state) => state === "question").length;
  const blocked = states.filter((state) => state === "blocked").length;
  const parts: string[] = [];
  if (questions) parts.push(`${questions} ${questions === 1 ? "asks" : "ask"} you`);
  if (blocked) parts.push(`${blocked} blocked`);
  return parts.join(" · ");
}

/** Broker events that can change a pinned card. Presence heartbeats never do. */
export function isCompanionRelevantEvent(event: { kind: string; payload?: unknown }): boolean {
  if (event.kind === "unknown") return true; // reconcile after a (re)connect
  return event.kind === "collaboration.upserted"
    || event.kind === "collaboration.event.appended"
    || event.kind === "flight.updated"
    || event.kind === "message.posted";
}

// ── Many pins, bounded reads ──────────────────────────────────────────────
// Only the visible cards read full work detail (timeline, flights, tail).
// Every other pin, and every surfaced item, is classified from the light
// work-list row that one bounded `/api/work?ids=` read returns.

/** Session ended and quiet need the timeline and tail; a list row cannot tell. */
export function summaryState(item: WorkItem, now: number): CompanionCardState {
  if (item.state === "done") return "done";
  if (item.state === "cancelled") return "cancelled";
  if (item.attention === "interrupt") return "blocked";
  const operatorNext = Boolean(item.nextMoveOwnerId && OPERATOR_IDS.has(item.nextMoveOwnerId.trim()));
  if ((item.state === "waiting" || item.state === "review") && operatorNext) return "question";
  if (item.state === "waiting" || item.state === "review") return "waiting";
  const last = Math.max(item.updatedAt, item.lastMeaningfulAt ?? 0);
  return now - last > QUIET_AFTER_MS ? "quiet" : "working";
}

export type CompanionGroupKey = CompanionCardState | "unknown";

/** Most urgent first; the overflow list reads top-down in this order. */
export const GROUP_ORDER: readonly CompanionGroupKey[] = [
  "question", "blocked", "working", "quiet", "waiting", "ended", "done", "cancelled", "unknown",
];

const GROUP_LABELS: Record<CompanionGroupKey, string> = {
  question: "Asks you",
  blocked: "Blocked",
  working: "Working",
  quiet: "Quiet",
  waiting: "Waiting",
  ended: "Session ended",
  done: "Done",
  cancelled: "Cancelled",
  unknown: "Not loaded",
};

export function groupLabel(key: CompanionGroupKey): string {
  return GROUP_LABELS[key];
}

/**
 * Group ids by state, keeping each group in the given (operator) order.
 * Empty groups are left out.
 */
export function groupByState<T extends string>(
  ids: readonly T[],
  states: ReadonlyMap<string, CompanionCardState>,
): { key: CompanionGroupKey; ids: T[] }[] {
  const buckets = new Map<CompanionGroupKey, T[]>();
  for (const id of ids) {
    const key: CompanionGroupKey = states.get(id) ?? "unknown";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(id);
    else buckets.set(key, [id]);
  }
  return GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({ key, ids: buckets.get(key)! }));
}

// ── Opt-in surfacing ──────────────────────────────────────────────────────
// The operator grants a work item, an agent or a project permission to appear
// here. A grant is permission to appear, never to interrupt: surfaced items
// sit in a quiet list with a badge, and nothing opens, focuses or answers.

export type CompanionScopeRef = { kind: "work" | "agent" | "project"; id: string; label: string | null };

export type SurfacedItem = {
  workId: string;
  title: string;
  state: CompanionCardState;
  /** Question, review for the operator, or blocker: earns the badge. */
  needsOperator: boolean;
  /** Why it is here: the grant that let it in, in words. */
  origin: string;
  owner: string | null;
  /** The owning agent's id, so the edge can draw its character. */
  ownerId: string | null;
  lastActivityAt: number;
  conversationId: string | null;
};

/** Progress older than this does not surface; attention lasts longer. */
export const SURFACE_PROGRESS_WINDOW_MS = 2 * 60 * 60_000;
/** Same bound as the web fleet's attention retirement. */
export const SURFACE_ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAX_SURFACED = 24;
/** Agent reads per refresh, across agent and project grants. */
export const MAX_SURFACE_AGENT_READS = 16;
/** Rows read per agent. */
export const SURFACE_ROWS_PER_AGENT = 12;

type SurfaceAgent = { id: string; name?: string | null; projectRoot?: string | null; project?: string | null };

function projectName(root: string): string {
  return root.replace(/\/+$/, "").split("/").pop() || root;
}

/**
 * Which agents to read for the agent and project grants, bounded. Agent grants
 * come first (they are the narrowest), then project members in roster order.
 */
export function surfaceAgentIds(scopes: readonly CompanionScopeRef[], agents: readonly SurfaceAgent[]): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (ids.length < MAX_SURFACE_AGENT_READS && !ids.includes(id)) ids.push(id);
  };
  for (const scope of scopes) if (scope.kind === "agent") add(scope.id);
  for (const scope of scopes) {
    if (scope.kind !== "project") continue;
    for (const agent of agents) if (agent.projectRoot === scope.id) add(agent.id);
  }
  return ids;
}

/** The grant that admits this row, narrowest first, or null. */
export function admittingScope(
  item: Pick<WorkItem, "id" | "ownerId" | "nextMoveOwnerId">,
  scopes: readonly CompanionScopeRef[],
  agents: readonly SurfaceAgent[],
): CompanionScopeRef | null {
  const byKind = (kind: CompanionScopeRef["kind"]) => scopes.filter((scope) => scope.kind === kind);
  const work = byKind("work").find((scope) => scope.id === item.id);
  if (work) return work;
  const actorIds = [item.ownerId, item.nextMoveOwnerId].filter((id): id is string => Boolean(id));
  const agent = byKind("agent").find((scope) => actorIds.includes(scope.id));
  if (agent) return agent;
  const roots = new Set(agents.filter((a) => actorIds.includes(a.id)).map((a) => a.projectRoot).filter(Boolean));
  return byKind("project").find((scope) => roots.has(scope.id)) ?? null;
}

function originLabel(scope: CompanionScopeRef): string {
  if (scope.kind === "work") return "allowed work";
  if (scope.kind === "agent") return `via ${scope.label ?? scope.id}`;
  return `via ${scope.label ?? projectName(scope.id)}`;
}

/**
 * Rows from the bounded reads → the Surfaced list. Pinned work stays a card
 * and is left out here. A row surfaces when it needs the operator (within the
 * attention window) or moved recently (within the progress window); finished
 * work drops out once it is no longer recent. Most urgent first, then newest.
 */
export function selectSurfaced(
  rows: readonly WorkItem[],
  options: {
    scopes: readonly CompanionScopeRef[];
    agents: readonly SurfaceAgent[];
    pinnedIds: ReadonlySet<string>;
    now: number;
  },
): SurfacedItem[] {
  if (options.scopes.length === 0) return [];
  const seen = new Set<string>();
  const out: SurfacedItem[] = [];
  for (const row of rows) {
    if (seen.has(row.id) || options.pinnedIds.has(row.id)) continue;
    seen.add(row.id);
    const scope = admittingScope(row, options.scopes, options.agents);
    if (!scope) continue;
    const state = summaryState(row, options.now);
    const needsOperator = state === "question" || state === "blocked";
    const last = Math.max(row.updatedAt, row.lastMeaningfulAt ?? 0);
    const age = options.now - last;
    if (needsOperator ? age > SURFACE_ATTENTION_WINDOW_MS : age > SURFACE_PROGRESS_WINDOW_MS) continue;
    out.push({
      workId: row.id,
      title: row.title,
      state,
      needsOperator,
      origin: originLabel(scope),
      owner: row.ownerName ?? row.ownerId,
      ownerId: row.ownerId ?? null,
      lastActivityAt: last,
      conversationId: row.conversationId,
    });
  }
  return out
    .sort((a, b) => Number(b.needsOperator) - Number(a.needsOperator) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_SURFACED);
}
