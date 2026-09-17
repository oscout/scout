/**
 * Scout Chat — the pure model behind the surface.
 *
 * Everything here is a function of server records. It exists so the rules that
 * matter — what the feed shows, what an ask chip is allowed to claim, which
 * trailing fact a roster row earns, what an invitation's reachability line says
 * — can be read and tested without a DOM.
 *
 * The honesty rules from `docs/eng/chat-channel-invites-design.md` live in this
 * file: membership is not reception (§5), a mention is not an invocation (§2),
 * and a route is never described as further-reaching than the protocol says
 * (§7.1). None of these may be relaxed in a component.
 */

import type {
  ChannelInvitePublicView,
  ChannelInviteRoute,
  ChannelReception,
  ConversationDefinition,
  MessageRecord,
} from "@openscout/protocol";

import type {
  ChannelMemberView,
  InviteReachabilityNote,
  TrackedRequest,
} from "./chat-api.ts";

/* ── polling ─────────────────────────────────────────────────────────────── */

/** Modest pilot polling. Not streaming, and the surface never claims it is. */
export const FEED_POLL_MS = 4_000;
export const ROSTER_POLL_MS = 15_000;
export const BOOTSTRAP_POLL_MS = 60_000;

/* ── time ────────────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(at: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - at);
  if (delta < 45_000) return "just now";
  if (delta < HOUR) return `${Math.max(1, Math.round(delta / MINUTE))}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

/** Clock label on a turn. 24h, zero-padded, local. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayLabel(at: number, nowMs: number): string {
  const today = startOfLocalDay(nowMs);
  const day = startOfLocalDay(at);
  if (day === today) return "Today";
  if (day === today - DAY) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * "expires in 6 days" / "expires in 4 hours" / "expired".
 *
 * `null` means the invitation carries no expiry, which the sheet says out loud
 * rather than leaving blank.
 */
export function expiryLabel(expiresAt: number | null, nowMs: number): string {
  if (expiresAt === null) return "no expiry";
  const delta = expiresAt - nowMs;
  if (delta <= 0) return "expired";
  if (delta < HOUR) return `expires in ${Math.max(1, Math.round(delta / MINUTE))} minutes`;
  if (delta < DAY) {
    const hours = Math.round(delta / HOUR);
    return `expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(delta / DAY);
  return `expires in ${days} ${days === 1 ? "day" : "days"}`;
}

export function calendarDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/* ── identity ────────────────────────────────────────────────────────────── */

export function channelLabel(title: string): string {
  const trimmed = title.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/** Two-letter coin initials. Never more than two — the coin is 24px. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

/** An agent is anything the roster says is one, or anything that has an owner. */
export function isAgentMember(member: ChannelMemberView): boolean {
  return member.kind === "agent" || Boolean(member.owner);
}

export function isPersonMember(member: ChannelMemberView): boolean {
  return !isAgentMember(member);
}

/**
 * A lightweight API participant: it joined over plain HTTP, reads the room by
 * polling, and posts its replies. Declared by the roster
 * (`participation: "api"`), never inferred — an agent with no session *today*
 * is a different claim from an agent that can never have one through this
 * membership.
 */
export function isApiParticipant(member: ChannelMemberView): boolean {
  return member.participation === "api";
}

/**
 * Who the ask selector may offer. `/asks` refuses an API participant by name
 * (409 `api_participant`) — offering one would be a control with no endpoint
 * behind it.
 */
export function isAskableMember(member: ChannelMemberView): boolean {
  return isAgentMember(member) && !isApiParticipant(member);
}

/**
 * Agents render possessively — "Maya's Codex" — because an agent in this room
 * is always somebody's. A server name that already carries its owner is left
 * alone rather than doubled.
 */
export function memberDisplayName(member: ChannelMemberView): string {
  const name = member.displayName.trim() || member.actorId;
  if (!member.owner) return name;
  const owner = member.owner.displayName.trim();
  if (!owner) return name;
  if (name.toLowerCase().startsWith(`${owner.toLowerCase()}'s `)) return name;
  return `${owner}'s ${name}`;
}

/** "You" is viewer-relative and appears exactly once per viewer. */
export function isSelfMember(member: ChannelMemberView, viewerActorId: string): boolean {
  return member.actorId === viewerActorId;
}

export function peopleAgentLabel(members: ChannelMemberView[]): string {
  const people = members.filter(isPersonMember).length;
  const agents = members.filter(isAgentMember).length;
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  return `${plural(people, "person", "people")} · ${plural(agents, "agent", "agents")}`;
}

/* ── connection plane (§5) ───────────────────────────────────────────────── */

const NOMINAL_RECEPTION = "ready_to_receive";

const ACTIVITY_WORKING = new Set([
  "active",
  "executing",
  "in progress",
  "in_progress",
  "running",
  "working",
]);

const ACTIVITY_WAITING = new Set([
  "blocked",
  "dispatching",
  "needs attention",
  "needs_attention",
  "pending",
  "queued",
  "waiting",
  "waking",
]);

export function activityVerb(member: ChannelMemberView): "working" | "waiting" | null {
  const status = member.activity?.status?.trim().toLowerCase();
  if (!status) return null;
  if (ACTIVITY_WORKING.has(status)) return "working";
  if (ACTIVITY_WAITING.has(status)) return "waiting";
  return null;
}

/**
 * The one trailing fact a roster row may carry.
 *
 * Precedence: the activity verb when there is activity, otherwise the
 * connection state only when it is *not* nominal. A quiet, connected, idle
 * agent shows nothing — idle is absence, not a chip. People carry no
 * connection plane at all: it describes an agent's route, and rendering it on
 * a human would read as a claim about the person.
 */
export function memberTrailingFact(
  member: ChannelMemberView,
  viewerActorId: string,
): string | null {
  if (isSelfMember(member, viewerActorId)) return "you";
  // An API participant's fact is its mode, always. Its endpoint-derived
  // reception describes a session this membership will never have, and it has
  // no activity plane, so neither branch below can say anything true about it.
  if (isApiParticipant(member)) return "via API";
  if (!isAgentMember(member)) return null;
  const verb = activityVerb(member);
  if (verb) return verb;
  const reception = member.reception;
  if (!reception || reception.state === NOMINAL_RECEPTION) return null;
  return reception.summary.trim().toLowerCase();
}

export interface ReceptionView {
  /** The protocol's badge-length label, rendered verbatim. */
  summary: string;
  /** The protocol's always-populated sentence, rendered verbatim. */
  detail: string;
  /** The dot is quiet and neutral, and appears only on a live route. */
  showDot: boolean;
  evidence: string | null;
  /** Route capability is an orthogonal axis, never a sixth state. */
  routeNote: string | null;
  ariaLabel: string;
}

export const WAKE_ON_DELIVERY_NOTE =
  "Nothing is listening between messages — a delivery starts or resumes this agent's session.";

export function receptionView(
  reception: ChannelReception | null | undefined,
  nowMs: number,
): ReceptionView | null {
  if (!reception) return null;
  const evidence = reception.evidenceAt
    ? `confirmed ${relativeTime(reception.evidenceAt, nowMs)}`
    : null;
  const routeNote = reception.routeKind === "wake_on_delivery" ? WAKE_ON_DELIVERY_NOTE : null;
  return {
    summary: reception.summary,
    detail: reception.detail,
    // `listening` is the only thing that earns the dot: a live attached process
    // with fresh evidence. A route kind alone never does.
    showDot: reception.listening === true && reception.state === NOMINAL_RECEPTION,
    evidence,
    routeNote,
    ariaLabel: [reception.summary, evidence].filter(Boolean).join(", "),
  };
}

export const API_PARTICIPATION_SUMMARY = "Reads by polling";
export const API_PARTICIPATION_DETAIL =
  "This member joined over the plain HTTP API. It sees the room when it polls and answers by posting; nothing is delivered to it between polls, and it cannot be sent a tracked ask.";

/**
 * Reception as one member's card renders it.
 *
 * For an API participant the endpoint-derived reading says "Waiting for agent"
 * — a session that will never attach through this membership — so the declared
 * participation mode is rendered instead. No dot and no freshness claim: the
 * server keeps no record of when it last polled, and inventing one is exactly
 * the background-availability lie this surface refuses elsewhere.
 */
export function memberReceptionView(
  member: ChannelMemberView,
  nowMs: number,
): ReceptionView | null {
  if (isApiParticipant(member)) {
    return {
      summary: API_PARTICIPATION_SUMMARY,
      detail: API_PARTICIPATION_DETAIL,
      showDot: false,
      evidence: null,
      routeNote: null,
      ariaLabel: API_PARTICIPATION_SUMMARY,
    };
  }
  return receptionView(member.reception, nowMs);
}

/* ── tracked asks (§8) ───────────────────────────────────────────────────── */

export type AskTone = "owed" | "settled" | "failed";

const OWED_STATES = new Set(["accepted", "queued", "waking", "running", "waiting", "delivered"]);
const SETTLED_STATES = new Set(["completed", "cancelled", "canceled"]);
const FAILED_STATES = new Set(["failed", "error", "expired"]);

/** Delivery layering: `accepted` is a pre-state of `queued`, not its own word. */
export function normalizeAskState(state: string): string {
  const normalized = state.trim().toLowerCase();
  if (normalized === "accepted" || normalized === "delivered") return "queued";
  if (normalized === "canceled") return "cancelled";
  return normalized || "queued";
}

export function askTone(state: string): AskTone {
  const normalized = normalizeAskState(state);
  if (FAILED_STATES.has(normalized)) return "failed";
  if (SETTLED_STATES.has(normalized)) return "settled";
  if (OWED_STATES.has(normalized)) return "owed";
  // An unrecognized broker state is still owed until something says otherwise,
  // and is rendered verbatim rather than relabelled.
  return "owed";
}

export interface AskChip {
  state: string;
  tone: AskTone;
  /** Chip text without the target, for the thread panel. */
  text: string;
  /** Chip text with the target, for the feed. */
  textWithTarget: string;
  ariaLabel: string;
}

/**
 * The chip never spins at a member who cannot receive.
 *
 * A `wake_on_delivery` route is *not* that case: it is a supported route whose
 * session gets started or resumed, so it keeps its lifecycle word. Only a
 * missing, unavailable, or disconnected route earns the explanation.
 */
export function askChip(
  request: TrackedRequest,
  target: { label: string; reception?: ChannelReception | null } | null,
): AskChip {
  const state = normalizeAskState(request.state);
  const tone = askTone(state);
  const label = target?.label ?? request.targetActorId;
  const reception = target?.reception ?? null;
  const stranded = tone === "owed"
    && reception !== null
    && (reception.routeKind === "none"
      || reception.state === "unavailable"
      || reception.state === "disconnected");

  if (stranded) {
    const text = `${state} — ${label} isn't listening right now`;
    return {
      state,
      tone,
      text,
      textWithTarget: text,
      ariaLabel: `Tracked request for ${label}, ${state}, not listening right now`,
    };
  }

  return {
    state,
    tone,
    text: `▸ ${state}`,
    textWithTarget: `▸ ${label} · ${state}`,
    ariaLabel: `Tracked request for ${label}, ${state}`,
  };
}

/* ── feed projection (§2) ────────────────────────────────────────────────── */

const STATUS_CLASSES = new Set(["status", "system", "log"]);

/** How many status lines stay visible at the tail of a run before folding. */
export const STATUS_VISIBLE_TAIL = 2;

export type FeedEntry =
  | { kind: "day"; id: string; label: string; at: number }
  | { kind: "status"; id: string; message: MessageRecord }
  | { kind: "status-fold"; id: string; label: string; count: number; messages: MessageRecord[] }
  | {
      kind: "turn";
      id: string;
      message: MessageRecord;
      request: TrackedRequest | null;
      replyCount: number;
      lastReplyAt: number | null;
    };

export interface FeedProjection {
  entries: FeedEntry[];
  /** Replies keyed by the root message they are anchored to. */
  repliesByRoot: Map<string, MessageRecord[]>;
  requestsByMessage: Map<string, TrackedRequest>;
  lastMessageAt: number | null;
}

function byCreatedAt(left: MessageRecord, right: MessageRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function isStatusMessage(message: MessageRecord): boolean {
  return STATUS_CLASSES.has(message.class);
}

/**
 * Split the channel feed into what the centre column renders.
 *
 * Root messages stay in the channel; replies belong to the thread panel and
 * are only counted here (the "2 replies · last 3m ago" stub). Status notices
 * coalesce: a long run of joins folds behind one row with a count, so a busy
 * morning of invitations never buries the conversation.
 */
export function projectFeed(input: {
  messages: MessageRecord[];
  requests: TrackedRequest[];
  nowMs: number;
}): FeedProjection {
  const sorted = [...input.messages].sort(byCreatedAt);
  const repliesByRoot = new Map<string, MessageRecord[]>();
  const roots: MessageRecord[] = [];

  for (const message of sorted) {
    const rootId = message.replyToMessageId;
    if (rootId) {
      const bucket = repliesByRoot.get(rootId);
      if (bucket) bucket.push(message);
      else repliesByRoot.set(rootId, [message]);
      continue;
    }
    roots.push(message);
  }

  const requestsByMessage = new Map<string, TrackedRequest>();
  for (const request of input.requests) {
    requestsByMessage.set(request.messageId, request);
  }

  const entries: FeedEntry[] = [];
  let lastDay: number | null = null;
  let run: MessageRecord[] = [];

  const flushStatusRun = () => {
    if (run.length === 0) return;
    if (run.length <= STATUS_VISIBLE_TAIL + 1) {
      for (const message of run) {
        entries.push({ kind: "status", id: message.id, message });
      }
      run = [];
      return;
    }
    const folded = run.slice(0, run.length - STATUS_VISIBLE_TAIL);
    const tail = run.slice(run.length - STATUS_VISIBLE_TAIL);
    entries.push({
      kind: "status-fold",
      id: `fold:${folded[0]!.id}`,
      label: `${folded.length} earlier ${folded.length === 1 ? "notice" : "notices"}`,
      count: folded.length,
      messages: folded,
    });
    for (const message of tail) {
      entries.push({ kind: "status", id: message.id, message });
    }
    run = [];
  };

  for (const message of roots) {
    const day = startOfLocalDay(message.createdAt);
    if (lastDay === null || day !== lastDay) {
      flushStatusRun();
      lastDay = day;
      entries.push({
        kind: "day",
        id: `day:${day}`,
        label: dayLabel(message.createdAt, input.nowMs),
        at: day,
      });
    }

    if (isStatusMessage(message)) {
      run.push(message);
      continue;
    }

    flushStatusRun();
    const replies = repliesByRoot.get(message.id) ?? [];
    const lastReply = replies.length > 0 ? replies[replies.length - 1]! : null;
    entries.push({
      kind: "turn",
      id: message.id,
      message,
      request: requestsByMessage.get(message.id) ?? null,
      replyCount: replies.length,
      lastReplyAt: lastReply?.createdAt ?? null,
    });
  }
  flushStatusRun();

  const lastMessage = sorted.length > 0 ? sorted[sorted.length - 1]! : null;
  return {
    entries,
    repliesByRoot,
    requestsByMessage,
    lastMessageAt: lastMessage?.createdAt ?? null,
  };
}

export function threadReplies(
  projection: FeedProjection,
  rootMessageId: string,
): MessageRecord[] {
  return projection.repliesByRoot.get(rootMessageId) ?? [];
}

export function threadStubLabel(replyCount: number, lastReplyAt: number | null, nowMs: number): string {
  const replies = `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;
  if (!lastReplyAt) return replies;
  return `${replies} · last ${relativeTime(lastReplyAt, nowMs)}`;
}

/**
 * Does this channel hold something addressed to the viewer that is still owed?
 *
 * Only computed for channels whose feed the client actually holds. There is no
 * unread projection on the wire, so an unloaded channel gets no dot rather
 * than an invented one.
 */
export function channelHasOwedAttention(input: {
  projection: FeedProjection;
  viewerActorId: string;
  members: ChannelMemberView[];
}): boolean {
  const ownedAgentIds = new Set(
    input.members
      .filter((member) => member.owner?.actorId === input.viewerActorId)
      .map((member) => member.actorId),
  );
  for (const request of input.projection.requestsByMessage.values()) {
    if (askTone(request.state) !== "owed") continue;
    if (ownedAgentIds.has(request.targetActorId)) return true;
  }
  for (const entry of input.projection.entries) {
    if (entry.kind !== "turn") continue;
    const mentions = entry.message.mentions ?? [];
    if (mentions.some((mention) => mention.actorId === input.viewerActorId)) return true;
  }
  return false;
}

/* ── mentions (§2) ───────────────────────────────────────────────────────── */

export type BodySegment = { kind: "text" | "mention"; text: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Highlight the mention labels a message actually carries.
 *
 * The structured `MessageMention[]` decides what is a mention; this only finds
 * where those labels sit in the plain-text body. A bare "@someone" that is not
 * on the record renders as ordinary text, because it addressed nobody.
 */
export function bodySegments(message: MessageRecord, fallbackLabels: string[] = []): BodySegment[] {
  const labels = [
    ...(message.mentions ?? []).map((mention) => mention.label ?? mention.actorId),
    ...fallbackLabels,
  ]
    .map((label) => label.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  if (labels.length === 0) return [{ kind: "text", text: message.body }];

  const pattern = new RegExp(`@(?:${labels.map(escapeRegExp).join("|")})`, "gu");
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const match of message.body.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ kind: "text", text: message.body.slice(cursor, index) });
    }
    segments.push({ kind: "mention", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < message.body.length) {
    segments.push({ kind: "text", text: message.body.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", text: message.body }];
}

/** The composer's visible boundary: mentioning an agent is what creates work. */
export function composerHint(targetLabel: string | null): string | null {
  if (!targetLabel) return null;
  return `Creates a tracked request for ${targetLabel} · reply lands in this thread`;
}

/* ── invitations (§7) ────────────────────────────────────────────────────── */

export type InviteKind = "teammate" | "agent" | "api";

/**
 * The invitation record carries no kind field, so kind is read off what was
 * minted: an agent invitation is single-use *and* bound to its issuer as
 * invitee; a no-install (`api`) invitation is single-use with no invitee,
 * because the server mints the participant's identity at join. Any token
 * accepts any of the three acceptance paths — this labels intent, not access.
 */
export function inviteKindOf(invite: ChannelInvitePublicView): InviteKind {
  if (invite.maxRedemptions !== 1) return "teammate";
  return invite.invitee ? "agent" : "api";
}

/** How an invitation row names its kind. */
export function inviteKindLabel(kind: InviteKind): string {
  return kind === "api" ? "no-install agent" : kind;
}

/**
 * The no-install document. The server serves `GET /invite/:token/api.md`
 * beside `agent.md` — `agent.md` itself points sessionless readers there —
 * derived here because the create response does not carry it yet.
 */
export function apiInstructionsUrl(inviteUrl: string): string {
  return `${inviteUrl.replace(/\/$/, "")}/api.md`;
}

/** `vx3k-····` — never more of the token than the non-secret hint. */
export function maskedTokenHint(tokenHint: string): string {
  const hint = tokenHint.trim();
  if (!hint) return "····";
  return hint.includes("-") ? `${hint.split("-")[0]!}-····` : `${hint}-····`;
}

export function inviteCopyBlock(input: {
  kind: InviteKind;
  channelTitle: string;
  channelTopic?: string | null;
  inviterName: string;
  inviteUrl: string;
  agentInstructionsUrl: string;
}): string {
  const channel = channelLabel(input.channelTitle);
  if (input.kind === "agent") {
    return [
      "Join my Scout Chat channel as my agent.",
      `Run scout chat join "${input.agentInstructionsUrl}" to join ${channel}, then scout chat say "Hello!".`
        + " Use this running agent to read and reply over HTTP; no local Scout service is required.",
      "Run the supplied commands directly; no invitation fetch, broad Scout skill, source inspection, or identity discovery is needed. To receive replies, run scout chat watch --once --compact --for 30s --json, then scout chat reply <message-id> \"Your reply\". Wait for watch to finish; repeat only for the requested participation period.",
      "If the CLI is missing, install @openscout/scout. Do not run setup or start background services.",
    ].join("\n");
  }
  if (input.kind === "api") {
    return [
      `Join my Scout Chat channel ${channel} over plain HTTP — nothing to install.`,
      `Fetch ${apiInstructionsUrl(input.inviteUrl)} and follow it exactly:`
        + " join, poll for new messages, and post your replies.",
    ].join("\n");
  }
  const topic = input.channelTopic?.trim();
  return [
    `You're invited to ${channel} on Scout Chat.`,
    `From ${input.inviterName}${topic ? ` · ${topic}` : ""}.`,
    `Open: ${input.inviteUrl}`,
  ].join("\n");
}

export interface ReachabilityView {
  /** Headline state: what the embedded route is actually known to be. */
  state: string;
  line: string;
  /** The protocol's caveat, rendered verbatim when it adds something. */
  caveat: string | null;
  /** The quiet neutral dot, only on a route usable away from this machine. */
  showDot: boolean;
  remoteUsable: boolean;
}

const ROUTE_FALLBACK: Record<string, { state: string; line: string; remoteUsable: boolean }> = {
  mesh: {
    state: "Reachable off this network",
    line: "This link uses a mesh route that works away from this network.",
    remoteUsable: true,
  },
  lan: {
    state: "Local network only",
    line: "This link uses a local-network route — teammates must be on this network.",
    remoteUsable: false,
  },
  local_only: {
    state: "This machine only",
    line:
      "This machine has no LAN or tailnet route others can reach — this link only works on this machine.",
    remoteUsable: false,
  },
  unknown: {
    state: "Reachability unconfirmed",
    line: "Route registered but unverified — treat this link as untested off this machine.",
    remoteUsable: false,
  },
};

/**
 * What the invite sheet may say about where a link reaches.
 *
 * A doorway name is never described as a network address: `chat.scout.local`
 * resolves per machine, so the sheet names the concrete route the invitation
 * was minted with. The server's own note is rendered verbatim when it sends
 * one — it is derived from the same route record and is the authority — and
 * the route's mandatory caveat is printed whenever it says something the note
 * did not already say.
 */
export function reachabilityView(
  route: ChannelInviteRoute,
  note?: InviteReachabilityNote | null,
): ReachabilityView {
  const caveat = route.caveat?.trim() || null;
  if (note) {
    return {
      state: note.label,
      line: note.detail,
      caveat: caveat && caveat !== note.detail.trim() ? caveat : null,
      showDot: note.remoteUsable,
      remoteUsable: note.remoteUsable,
    };
  }
  const fallback = ROUTE_FALLBACK[route.reachability] ?? ROUTE_FALLBACK.unknown!;
  return {
    state: fallback.state,
    line: fallback.line,
    caveat: caveat && caveat !== fallback.line ? caveat : null,
    showDot: fallback.remoteUsable,
    remoteUsable: fallback.remoteUsable,
  };
}

/**
 * May this viewer take this invitation back?
 *
 * The server's rule, mirrored exactly: the operator may revoke any invitation,
 * and a member may revoke only one they created. Authorship is
 * `createdByActorId` — never the invitee, who is the recipient, and never the
 * redemption. Offering a Revoke the server would refuse is worse than offering
 * none, so the affordance is absent wherever this returns false.
 */
export function canRevokeInvite(
  invite: ChannelInvitePublicView,
  viewer: { actorId: string; isOperator: boolean },
): boolean {
  if (invite.state !== "active") return false;
  if (viewer.isOperator) return true;
  return invite.createdByActorId === viewer.actorId;
}

export function inviteScopeLine(kind: InviteKind, issuerName: string): string {
  if (kind === "agent") return `single use · joins as ${issuerName}'s`;
  if (kind === "api") return "single use · joins over HTTP";
  return "multi-use until it expires or is revoked";
}

/* ── the /invite/<token> landing page (§7.2) ─────────────────────────────── */

export type InviteLandingView =
  | { mode: "join"; channelTitle: string; cta: string; note: string }
  | { mode: "open"; channelTitle: string; cta: string; note: string }
  | { mode: "closed"; channelTitle: string | null; message: string };

export function inviteLandingView(input: {
  channelTitle: string;
  invite: ChannelInvitePublicView;
  inviterName: string | null;
  alreadyMember: boolean;
  nowMs: number;
}): InviteLandingView {
  const channel = channelLabel(input.channelTitle);
  // No dead ends: where we know who invited, the recovery path is their name.
  const asker = input.inviterName?.trim()
    ? `Ask ${input.inviterName.trim()} for a new one.`
    : "Ask the person who invited you for a new one.";

  switch (input.invite.state) {
    case "expired":
      return {
        mode: "closed",
        channelTitle: channel,
        message: `This invitation expired on ${
          input.invite.expiresAt ? calendarDate(input.invite.expiresAt) : "an earlier date"
        }. ${asker}`,
      };
    case "revoked":
      return { mode: "closed", channelTitle: channel, message: "This invitation was revoked." };
    case "exhausted":
      return {
        mode: "closed",
        channelTitle: channel,
        message: `This invitation has already been used. ${asker}`,
      };
    default:
      break;
  }

  const expiry = input.invite.expiresAt
    ? `It expires ${calendarDate(input.invite.expiresAt)}.`
    : "It does not expire.";
  const note = `This invitation admits you to this channel only. ${expiry}`;

  return input.alreadyMember
    ? { mode: "open", channelTitle: channel, cta: `Open ${channel}`, note }
    : { mode: "join", channelTitle: channel, cta: `Join ${channel}`, note };
}

/* ── channels ────────────────────────────────────────────────────────────── */

export function sortChannels(channels: ConversationDefinition[]): ConversationDefinition[] {
  return [...channels].sort((left, right) =>
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
  );
}

/**
 * A message from somebody the roster no longer lists still has to render.
 *
 * The fallback is deliberately inert: kind `unknown` so it is neither a person
 * nor an agent, and a reception reading that claims nothing at all.
 */
export function fallbackMember(actorId: string): ChannelMemberView {
  return {
    actorId,
    kind: "unknown",
    displayName: actorId,
    reception: {
      state: "waiting_for_agent",
      routeKind: "none",
      listening: false,
      summary: "",
      detail: "",
      evidenceAt: null,
      attachedSessionId: null,
      redeemedAt: null,
    },
  };
}

export function memberOrFallback(
  members: Map<string, ChannelMemberView>,
  actorId: string,
): ChannelMemberView {
  return members.get(actorId) ?? fallbackMember(actorId);
}

/** A logical send keeps one id across retries, so an uncertain failure cannot double-post. */
export function newRequestId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return `req-${cryptoRef.randomUUID()}`;
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
