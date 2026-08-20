import { routeForFollowTarget } from "../../lib/follow-route.ts";
import type {
  BrokerRouteAttempt,
  Flight,
  FollowTarget,
  Message,
  Route,
} from "../../lib/types.ts";

/**
 * A Dispatch row records that a message left the broker. On its own that
 * answers "was it sent?" and nothing else — the operator still has to guess
 * where the work went and whether anything came back. This module derives the
 * aftermath (the replies that followed, the flight that ran, and the routes
 * that lead to them) from data the surface can already reach.
 */

const REPLY_LIMIT = 3;

/** How far back the transcript page has to reach to contain the dispatch. */
export const AFTERMATH_MESSAGE_PAGE = 80;

export type DispatchReply = {
  id: string;
  actorName: string;
  body: string;
  createdAt: number;
  /** ms between the dispatch and this reply. */
  afterMs: number;
  /** True when this message is a direct answer to the dispatched message. */
  answersDispatch: boolean;
};

export type DispatchAftermath =
  | { status: "no-conversation" }
  /** The transcript could not be read — distinct from reading it and finding nothing. */
  | { status: "unavailable" }
  /** The transcript page loaded, but the dispatch predates it. */
  | { status: "beyond-page" }
  | { status: "no-reply" }
  | { status: "replies"; replies: DispatchReply[]; more: number };

function readMessageTimestamp(message: Message): number {
  return Number(message.createdAt) || 0;
}

/**
 * Locate the dispatched message in a transcript page and collect what came
 * after it. Anchoring on the message id is exact; falling back to the
 * timestamp keeps synthesized feed rows (which merge a send with its delivery
 * failure and can carry a different id) from losing their aftermath.
 */
export function resolveDispatchAftermath(
  attempt: BrokerRouteAttempt,
  messages: Message[],
): DispatchAftermath {
  if (!attempt.conversationId) return { status: "no-conversation" };

  const ordered = messages
    .slice()
    .sort((left, right) => readMessageTimestamp(left) - readMessageTimestamp(right));

  const anchor = attempt.messageId
    ? ordered.find((message) => message.id === attempt.messageId) ?? null
    : null;

  let after: Message[];
  if (anchor) {
    // Position is not a safe boundary. `/api/messages` answers from two sources
    // with opposite orders — the broker projection ascending, the SQLite
    // fallback `created_at DESC, id DESC` — and sorting on timestamp alone
    // leaves same-millisecond ties in whatever order the source produced. A
    // positional slice would therefore drop a reply posted in the same
    // millisecond as the dispatch on the descending source, and on the
    // ascending one whenever the tie broke by id the wrong way. Cut on the
    // anchor's own timestamp and remove the anchor by id instead, which holds
    // for either source.
    const anchorTs = readMessageTimestamp(anchor);
    after = ordered.filter((message) =>
      message.id !== anchor.id && readMessageTimestamp(message) >= anchorTs);
  } else {
    // No anchor: either the dispatch is older than this page, or its id is not
    // a transcript id. Only the first case is worth reporting as a gap — if
    // the page starts after the dispatch there is nothing more to load here.
    const oldest = ordered[0];
    if (oldest && readMessageTimestamp(oldest) > attempt.ts) return { status: "beyond-page" };
    // Being on this path *means* nothing here carries the dispatch's id, so
    // there is no row to exclude and the boundary stays strict. Residual, and
    // not fixable from here: a synthesized feed row whose transcript copy has a
    // different id and a later stamp than the route attempt can still list
    // itself as its own first reply.
    after = ordered.filter((message) => readMessageTimestamp(message) > attempt.ts);
  }

  if (after.length === 0) return { status: "no-reply" };

  // Measure the gap from the message when we have it. The route attempt and
  // the message row are stamped by different clocks.
  const baseline = anchor ? readMessageTimestamp(anchor) : attempt.ts;
  const replies = after.slice(0, REPLY_LIMIT).map((message) => ({
    id: message.id,
    actorName: message.actorName || "Unknown",
    body: message.body ?? "",
    createdAt: readMessageTimestamp(message),
    afterMs: Math.max(0, readMessageTimestamp(message) - baseline),
    answersDispatch: Boolean(
      attempt.messageId && message.replyToMessageId === attempt.messageId,
    ),
  }));

  return { status: "replies", replies, more: Math.max(0, after.length - replies.length) };
}

function readMetadataId(
  attempt: BrokerRouteAttempt,
  ...keys: string[]
): string | null {
  const metadata = attempt.metadata ?? {};
  const raw = metadata.raw && typeof metadata.raw === "object" && !Array.isArray(metadata.raw)
    ? metadata.raw as Record<string, unknown>
    : null;
  for (const key of keys) {
    for (const source of [metadata, raw]) {
      const value = source?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/**
 * The ids a Dispatch row can contribute to `/api/follow`. Rows vary a lot: a
 * plain routed message carries only a conversation, while a `scout ask`
 * carries an invocation. Sending whatever is present lets the server resolve
 * the rest rather than making the client guess which shape it has.
 */
export function dispatchFollowQuery(
  attempt: BrokerRouteAttempt,
  targetAgentId: string | null,
): URLSearchParams | null {
  const params = new URLSearchParams();
  const invocationId = attempt.invocationId ?? readMetadataId(attempt, "invocationId");
  const flightId = readMetadataId(attempt, "flightId");
  const workId = readMetadataId(attempt, "collaborationRecordId", "workId", "recordId");

  if (flightId) params.set("flightId", flightId);
  if (invocationId) params.set("invocationId", invocationId);
  if (attempt.conversationId) params.set("conversationId", attempt.conversationId);
  if (workId) params.set("workId", workId);
  if (targetAgentId) params.set("targetAgentId", targetAgentId);

  return [...params.keys()].length > 0 ? params : null;
}

export type DispatchOutcomeLink = {
  key: string;
  label: string;
  hint: string;
  route: Route;
};

export type DispatchLinkHost = {
  /**
   * True when a native host consumes navigation. macOS has no Work section, so
   * `view: "work"` lands back on Dispatch there — an offer that does nothing.
   * Drop the link until that host grows a destination for it.
   */
  nativeHost?: boolean;
};

/**
 * Routes out of a dispatch, ordered by how directly each one answers "what
 * happened". Only links whose id actually resolved are returned — a dead
 * destination is worse than an absent one.
 */
export function dispatchOutcomeLinks(
  target: FollowTarget,
  host: DispatchLinkHost = {},
): DispatchOutcomeLink[] {
  const links: DispatchOutcomeLink[] = [];

  if (target.conversationId) {
    links.push({
      key: "conversation",
      label: "Conversation",
      hint: "The thread this dispatch landed in",
      route: { view: "conversation", conversationId: target.conversationId },
    });
  }
  if (target.flightId || target.sessionId) {
    links.push({
      key: "trace",
      label: "Live trace",
      hint: "The session that ran the work",
      route: {
        view: "sessions",
        ...(target.flightId ? { flightId: target.flightId } : {}),
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.targetAgentId ? { agentId: target.targetAgentId } : {}),
      },
    });
  }
  if (target.workId && !host.nativeHost) {
    links.push({
      key: "work",
      label: "Work item",
      hint: "The collaboration record it belongs to",
      route: { view: "work", workId: target.workId },
    });
  }
  if (target.targetAgentId) {
    links.push({
      key: "agent",
      label: "Recipient",
      hint: "The agent that received it",
      route: { view: "agents-v2", agentId: target.targetAgentId, tab: "observe" },
    });
  }
  if (links.length > 0) {
    links.push({
      key: "tail",
      label: "Tail",
      hint: "Raw events for these ids",
      route: routeForFollowTarget(target, "tail"),
    });
  }

  return links;
}

export type DispatchFlightOutcome = {
  state: string;
  label: string;
  /** Shares the ledger's tone vocabulary so a row and its outcome read alike. */
  tone: "success" | "danger" | "working" | "neutral";
  summary: string | null;
  durationMs: number | null;
  settled: boolean;
};

const FLIGHT_STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  dispatched: "Dispatched",
  running: "Running",
  succeeded: "Completed",
  completed: "Completed",
  failed: "Failed",
  errored: "Failed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  timed_out: "Timed out",
  expired: "Expired",
};

const FLIGHT_DANGER_STATES = new Set(["failed", "errored", "timed_out", "expired"]);
const FLIGHT_ACTIVE_STATES = new Set(["queued", "dispatched", "running"]);
const FLIGHT_OK_STATES = new Set(["succeeded", "completed"]);

export function dispatchFlightOutcome(flight: Flight | null): DispatchFlightOutcome | null {
  if (!flight) return null;
  const state = flight.state?.trim().toLowerCase() || "unknown";
  const tone = FLIGHT_DANGER_STATES.has(state)
    ? "danger"
    : FLIGHT_ACTIVE_STATES.has(state)
      ? "working"
      : FLIGHT_OK_STATES.has(state)
        ? "success"
        : "neutral";
  const durationMs = flight.startedAt && flight.completedAt
    ? Math.max(0, flight.completedAt - flight.startedAt)
    : null;

  return {
    state,
    label: FLIGHT_STATE_LABELS[state] ?? state.replace(/_/g, " "),
    tone,
    summary: flight.summary?.trim() || null,
    durationMs,
    settled: !FLIGHT_ACTIVE_STATES.has(state),
  };
}

export function formatDispatchGap(ms: number): string {
  if (ms < 1000) return "instant";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s later`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m later`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h later`;
  return `${Math.round(hours / 24)}d later`;
}

export function formatDispatchDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
