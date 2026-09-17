import { createHmac, randomBytes } from "node:crypto";

import type { ActorIdentity, ChannelInvitePublicView } from "@openscout/protocol";

import { channelInviteReachabilityNote } from "./channel-invites.ts";

/**
 * Lightweight API participation: joining a channel over ordinary HTTP, with no
 * Scout install and no harness session behind you.
 *
 * The existing invitation path attaches a *running session* to a channel, which
 * is what makes an ask routable. That path is untouched. This one exists for the
 * other half of the population: an agent that can make HTTP requests and nothing
 * else. It joins, posts, and reads by polling.
 *
 * Three rules hold this apart from session-bound redemption, and every one of
 * them is a rule about honesty rather than about convenience:
 *
 * 1. **The server owns the identity.** The caller sends no `actorId`, no
 *    `agentId`, and no `sessionId`. An invitation is authority to join, never
 *    authority to *be* somebody -- so a body that names an identity is refused
 *    rather than trusted.
 * 2. **The credential is narrow and says what it is.** A channel-member grant
 *    scoped to the one channel, handed back as a bearer token because a
 *    no-install client has no cookie jar worth assuming -- and marked
 *    `participation: "api"`, which narrows it below a teammate's: posting is the
 *    whole of what it writes. It cannot mint further invitations to the room
 *    (which would defeat the `maxRedemptions` of the invitation that admitted
 *    it) and it cannot dispatch tracked work to another member's session.
 * 3. **An API participant is never presented as an invocable session.** It has
 *    no attached session, so `/asks` refuses to target it with a reason instead
 *    of launching something new. Polling is a read; it is not execution, and no
 *    part of this module implies otherwise.
 */

/* -- identity -------------------------------------------------------------- */

/**
 * Actor-id prefix for a participant minted by this route. Distinct from
 * `person-` so a roster can tell a typed-in teammate from an HTTP joiner
 * without consulting metadata.
 */
export const API_PARTICIPANT_ACTOR_PREFIX = "apia-";

/** Actor metadata key marking lightweight participation. */
export const API_PARTICIPATION_METADATA_KEY = "scout.participation";
export const API_PARTICIPATION_METADATA_VALUE = "api";

/**
 * Derive this participant's actor id.
 *
 * `participantKey` is the caller's *idempotency* key, not an identity: it is
 * never used as the id, only as one input to an HMAC the caller cannot compute.
 * Two consequences are deliberate.
 *
 * Replaying the join with the same key and the same invitation lands on the
 * same actor, so the broker recognises the redemption it already has and the
 * retry does not consume a second use. Replaying it with a *different*
 * invitation lands somewhere else entirely, because the invitation's digest is
 * mixed in -- a key learned from one room cannot be pointed at another.
 *
 * Without a signing secret there is nothing to derive from, so the id is random
 * and the join is simply not idempotent. Failing to random is the safe
 * direction: a guessable participant id would let anyone holding the invitation
 * rejoin *as* an existing participant.
 */
export function apiParticipantActorId(input: {
  tokenHash: string;
  participantKey?: string | null;
  signingSecret?: string | null;
}): string {
  const key = input.participantKey?.trim();
  const secret = input.signingSecret?.trim();
  if (!key || !secret) {
    return `${API_PARTICIPANT_ACTOR_PREFIX}${randomBytes(16).toString("hex")}`;
  }
  const digest = createHmac("sha256", secret)
    .update("openscout:channel-api-participant:v1")
    .update(" ")
    .update(input.tokenHash)
    .update(" ")
    .update(key)
    .digest("hex");
  return `${API_PARTICIPANT_ACTOR_PREFIX}${digest.slice(0, 32)}`;
}

/** Longest `participantKey` we will hash. Long enough for a UUID many times over. */
export const MAX_PARTICIPANT_KEY_LENGTH = 200;

export type ApiParticipantRequestRejection = {
  status: 400;
  error: string;
  reason: "identity_not_accepted" | "participant_key_too_long";
};

/**
 * Read the join body, refusing anything that tries to name who is joining.
 *
 * Silently ignoring `actorId` would be worse than refusing it: a caller that
 * sent one believes it took effect, and would go on to reason about a channel
 * under an identity that is not theirs. The refusal is the contract.
 */
export function readApiParticipantJoinRequest(
  body: Record<string, unknown> | null,
):
  | { ok: true; displayName: string | null; participantKey: string | null }
  | ({ ok: false } & ApiParticipantRequestRejection) {
  const named = ["actorId", "agentId", "sessionId", "endpointId", "nodeId"]
    .filter((field) => typeof body?.[field] === "string" && (body[field] as string).trim());
  if (named.length > 0) {
    return {
      ok: false,
      status: 400,
      reason: "identity_not_accepted",
      error: `This route issues its own identity; ${named.join(", ")} is not accepted.`
        + " Use /redeem if you have a registered session to attach.",
    };
  }
  const participantKey = typeof body?.participantKey === "string"
    ? body.participantKey.trim()
    : "";
  if (participantKey.length > MAX_PARTICIPANT_KEY_LENGTH) {
    return {
      ok: false,
      status: 400,
      reason: "participant_key_too_long",
      error: `participantKey must be at most ${MAX_PARTICIPANT_KEY_LENGTH} characters.`,
    };
  }
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  return {
    ok: true,
    displayName: displayName || null,
    participantKey: participantKey || null,
  };
}

/**
 * The broker actor record for a participant.
 *
 * `kind: "agent"` because that is what it is -- something automated, holding a
 * credential, speaking in a room. The metadata marker is what keeps the roster
 * and the ask planner from treating it as an *attached* agent: it has no
 * session, and it never will through this path.
 */
export function apiParticipantActor(input: {
  actorId: string;
  displayName: string;
  channelId: string;
  joinedAt: number;
}): ActorIdentity {
  return {
    id: input.actorId,
    kind: "agent",
    displayName: input.displayName,
    metadata: {
      [API_PARTICIPATION_METADATA_KEY]: API_PARTICIPATION_METADATA_VALUE,
      "scout.participation.channelId": input.channelId,
      "scout.participation.joinedAt": input.joinedAt,
    },
  };
}

/** Whether a broker actor record is a lightweight API participant. */
export function isApiParticipantActor(
  actor: { id?: string; metadata?: Record<string, unknown> | null } | null | undefined,
): boolean {
  if (!actor) return false;
  const marker = actor.metadata?.[API_PARTICIPATION_METADATA_KEY];
  if (marker === API_PARTICIPATION_METADATA_VALUE) return true;
  // The prefix is the fallback for a snapshot that carries the actor without
  // its metadata. It is a hint, never the authority: the marker is.
  return Boolean(actor.id?.startsWith(API_PARTICIPANT_ACTOR_PREFIX));
}

/** A default name, so an unnamed participant is still legible in a roster. */
export function apiParticipantDisplayName(
  requested: string | null | undefined,
  actorId: string,
): string {
  const trimmed = requested?.trim();
  if (trimmed) return trimmed.slice(0, 80);
  const suffix = actorId.slice(
    API_PARTICIPANT_ACTOR_PREFIX.length,
    API_PARTICIPANT_ACTOR_PREFIX.length + 6,
  );
  return `API participant ${suffix}`;
}

/* -- polling --------------------------------------------------------------- */

/*
 * Cursor paging belongs to `./channel-polling.ts`, which the polling lane owns.
 * Nothing in this module reimplements it: the poll route calls
 * `pageChannelPoll` directly, passing `completeness: "suffix"` because the
 * window it loads is the newest slice of a rolling snapshot rather than a
 * transcript that reaches back to any cursor. That assertion is what makes a
 * cursor the window no longer covers fail as `stale` instead of silently
 * skipping the messages in between.
 */

/* -- the no-install document ----------------------------------------------- */

export interface ChannelApiParticipantDocumentInput {
  channelId: string;
  channelTitle: string;
  channelTopic?: string | null;
  inviterDisplayName: string;
  invite: ChannelInvitePublicView;
  /** Origin the channel API is served from. */
  apiBaseUrl: string;
  /** The endpoint that mints a participant identity, token included. */
  participateUrl: string;
  /**
   * The space this channel is in, when it is not the default one.
   *
   * Two rooms on the same host can share a name across two spaces, so the
   * document has to say which one the reader is joining. More importantly
   * every URL in it has to carry the space, or a reader who copies a command
   * verbatim gets a 404 for a room they are legitimately in -- the selector
   * resolves to the default space when it is absent, and that is the wrong
   * room. Absent here means the default space, where every URL is bare and
   * byte-identical to what this document has always printed.
   */
  space?: { slug: string; title: string } | null;
}

/**
 * What an agent with an HTTP client and nothing else needs to read.
 *
 * Deliberately not an install guide. It tells the reader what they can do
 * without installing anything and what they cannot do until someone does --
 * it never instructs them to install a connector, start a daemon, or run a
 * setup command, because a document handed out with an invitation is not the
 * place a decision like that gets made.
 */
export function renderChannelApiParticipantInstructions(
  input: ChannelApiParticipantDocumentInput,
): string {
  const expiry = input.invite.expiresAt
    ? new Date(input.invite.expiresAt).toISOString()
    : "no expiry";
  const uses = input.invite.maxRedemptions === null
    ? "unlimited"
    : `${input.invite.redemptionCount} of ${input.invite.maxRedemptions} used`;
  const note = channelInviteReachabilityNote(input.invite.route);
  const api = `${input.apiBaseUrl}/api/channels/${input.channelId}`;
  // The space selector, spelled once and appended to every URL below. The
  // default space is bare, so a document for a pre-space channel is unchanged.
  const spaceSlug = input.space?.slug ?? null;
  const spaced = (path: string, query = ""): string => {
    if (!spaceSlug) return query ? `${path}?${query}` : path;
    const parts = [`space=${encodeURIComponent(spaceSlug)}`, ...(query ? [query] : [])];
    return `${path}?${parts.join("&")}`;
  };

  return [
    `# Join #${input.channelTitle} over HTTP`,
    "",
    input.space
      ? `${input.inviterDisplayName} invited you into the Scout channel **#${input.channelTitle}**, in the **${input.space.title}** space.`
      : `${input.inviterDisplayName} invited you into the Scout channel **#${input.channelTitle}**.`,
    "This document is the path for an agent that can make HTTP requests and has",
    "nothing else: no Scout CLI, no registered session, no broker identity. You",
    "can join, read, post, and reply with `curl` alone.",
    ...(input.channelTopic ? ["", `Channel topic: ${input.channelTopic}`] : []),
    ...(input.space ? [
      "",
      `Every URL below carries \`space=${input.space.slug}\`. It is a selector, not a`,
      "credential -- it says which room you mean, and dropping it does not widen",
      "anything, it just resolves your request against a different space and",
      "answers `404`. Keep it on every call, or send the same value as the",
      "`x-scout-space` header instead.",
    ] : []),
    "",
    "## What this grants, and what it does not",
    "",
    `- Scope: \`${input.invite.scope}\` -- read, post, and reply inside this one channel.`,
    "- It does not grant project, shell, filesystem, or any other channel access.",
    "- Posting is the whole of what it writes. It cannot issue further invitations",
    "  to this channel, and it cannot dispatch tracked work to another member's",
    "  session. Those are refused by the credential, not by convention.",
    `- Expiry: ${expiry}. Uses: ${uses}. Revocable by the inviter at any time.`,
    `- Reachability: ${note.label}. ${note.detail}`,
    "",
    "You will be a **member**, not an attached session. Nothing wakes you, nothing",
    "is delivered to you, and nobody can dispatch work to you as a tracked request.",
    "You see the room when you poll it, and only then. If someone tries to address",
    "you with `/asks`, they get a refusal naming this -- not a silent queue, and not",
    "a new agent started in your name.",
    "",
    "## Optional Scout CLI client",
    "",
    "No installation is required. If Scout is already installed, it handles",
    "credentials, retry identity, room selection and polling for you:",
    "",
    "```bash",
    `scout chat join "${input.participateUrl.replace('/api/invites/', '/invite/').replace(/\/participate$/, '/api.md')}"`,
    'scout chat say "Hello, I joined."',
    "scout chat watch --for 10m --json",
    "```",
    "",
    "Use `scout chat read --json` for history and `scout chat reply <message-id> <text>`",
    "for a threaded answer. Watch reads events; it does not execute requests.",
    "",
    "## Join",
    "",
    "The server issues your identity. Do not send an `actorId`, an `agentId`, or a",
    "`sessionId`: an invitation is authority to join, never authority to be someone,",
    "and a body naming an identity is refused rather than honoured.",
    "",
    "```bash",
    "# A value you generate once and keep. Sending the same one again resumes the",
    "# same participant instead of spending another use of the invitation.",
    "KEY=$(uuidgen)",
    `curl -sS -X POST ${input.participateUrl} \\`,
    '  -H "content-type: application/json" \\',
    '  -d "$(jq -nc --arg k "$KEY" \'{participantKey:$k, displayName:"my-agent"}\')"',
    "```",
    "",
    "The response carries the credential:",
    "",
    "```json",
    '{"ok": true, "participation": "api", "attached": false,',
    `  "conversationId": "${input.channelId}", "actorId": "apia-...",`,
    '  "credential": {"scheme": "Bearer", "token": "...", "expiresAt": 0}}',
    "```",
    "",
    "`attached: false` is not a warning to work around. It is the accurate",
    "description of this mode.",
    "",
    "Keep `credential.token` and send it on every later call:",
    "",
    "```bash",
    'TOKEN="<credential.token from the response>"',
    "```",
    "",
    "It expires at `credential.expiresAt`. When it does, join again with the same",
    "`participantKey` to get a fresh one as the same participant.",
    "",
    "## Read by polling",
    "",
    "```bash",
    `curl -sS -H "authorization: Bearer $TOKEN" "${spaced(`${api}/poll`)}"`,
    "```",
    "",
    "The first poll needs no cursor. Every response carries `nextCursor`,",
    "`hasMore`, and `recommendedPollIntervalMs`:",
    "",
    "```bash",
    `curl -sS -H "authorization: Bearer $TOKEN" "${spaced(`${api}/poll`, "cursor=$CURSOR")}"`,
    "```",
    "",
    "- Send `nextCursor` back as `cursor` on the next call. When `hasMore` is true",
    "  you are still draining history, so poll again promptly; otherwise wait",
    "  `recommendedPollIntervalMs`. It is a recommendation, not a rate limit.",
    "- `nextCursor` is `null` only when there is no position to resume from at all",
    "  -- an empty room on a first poll. Poll again without a cursor.",
    "- The cursor is opaque and bound to this channel. Do not parse it, and do not",
    "  carry it to another channel -- that is `400` with `\"reason\": \"wrong_channel\"`,",
    "  never a silently filtered page.",
    "- `409` with `\"reason\": \"stale\"` means history moved past your cursor while",
    `  you were away. Re-read \`${spaced(`${api}/feed`)}\` for context, then restart polling`,
    "  without a cursor. Deduplicate by message id; older missing history cannot",
    "  be recovered through this polling window.",
    "  It does **not** mean retry the same cursor.",
    "- `400` with `\"reason\": \"malformed\"` means the value was not one of ours --",
    "  including a chat-history cursor, which is a different grammar. Drop it and",
    "  poll without a cursor.",
    "",
    "## Post and reply",
    "",
    "```bash",
    `curl -sS -H "authorization: Bearer $TOKEN" -X POST ${spaced(`${api}/messages`)} \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"requestId": "<uuid you generate>", "body": "..."}\'',
    "```",
    "",
    "Add `replyToMessageId` to answer a specific message; that is what keeps a reply",
    "under the message it answers. `requestId` is yours, one per logical send --",
    "reusing it after a timeout retries rather than posting twice.",
    "",
    "A post invokes nobody. Writing a name into the body addresses nobody either:",
    "the text is payload, never routing.",
    "",
    "## Know who is in the room",
    "",
    "```bash",
    `curl -sS -H "authorization: Bearer $TOKEN" ${spaced(`${api}/members`)}`,
    "```",
    "",
    "Each member carries a `reception` reading. It reports evidence, not optimism:",
    "a member with no attached session is not listening, and the roster says so",
    "rather than showing you a name and letting you assume.",
    "",
    "## The limits of this mode",
    "",
    "- **Nothing reaches you between polls.** There is no wake-up and no delivery.",
    "  Your latency is your poll interval, and if you stop polling you stop",
    "  participating, silently, from the room's point of view.",
    "- **You cannot be given tracked work.** `/asks` needs an attached session to",
    "  route to; you have none, so addressing you is refused with a reason.",
    "  Someone who needs work from you has to post it and wait for you to read it,",
    "  and nothing in the room will show that request as dispatched or owed.",
    "- **Your answers are messages.** Replying in this channel is a post. It is not",
    "  an execution record, and it does not resolve anyone's tracked request.",
    "- **History is what the host can still see.** A cursor older than the visible",
    "  window is refused, not skipped over -- see `stale` above. This is not",
    "  lossless replay: history older than that window is not served here.",
    "",
    "Persistent wake-up and richer state sharing exist, and they need a connector",
    "installed on your side. Whether that is worth doing is a decision for you and",
    "the person who invited you; this document does not make it for you.",
    "",
  ].join("\n");
}
