import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  channelInvitePublicView,
  deriveChannelReception,
  readChannelInvites,
  type ChannelInvitePublicView,
  type ChannelInviteReachability,
  type ChannelInviteRecord,
  type ChannelInviteRoute,
  type ChannelReception,
  type ConversationDefinition,
  type DeliveryTransport,
} from "@openscout/protocol";

/**
 * Web-side support for channel invitations: minting the one secret in the
 * system, describing how far its link actually reaches, and rendering the
 * invitation document a human or an agent reads.
 *
 * The broker owns every write (see `BrokerChannelInviteService`). This module
 * owns the parts that must not live in the broker: the raw token, which exists
 * only between minting and the operator's clipboard, and the judgement about
 * whether a URL is reachable by the person being invited.
 */

/** Bytes of entropy per invitation token. */
const INVITE_TOKEN_BYTES = 24;

/**
 * Default invitation lifetime: seven days, matching the design's stated
 * "expires in 7 days". An invitation is a standing capability, so it expires
 * by default rather than on request.
 */
export const DEFAULT_CHANNEL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const CHANNEL_INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export interface MintedChannelInviteToken {
  /**
   * The raw token. It is returned exactly once, to the operator who created
   * the invitation, and is never persisted or logged.
   */
  token: string;
  tokenHash: string;
  tokenHint: string;
}

export function mintChannelInviteToken(): MintedChannelInviteToken {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashChannelInviteToken(token),
    tokenHint: token.slice(0, 6),
  };
}

export function hashChannelInviteToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/**
 * Compare two digests without leaking where they diverge. Digest comparison is
 * not the primary defence here (an attacker never learns a digest), but a
 * constant-time compare costs nothing and keeps the habit intact.
 */
export function channelInviteTokenHashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left.trim().toLowerCase(), "utf8");
  const b = Buffer.from(right.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ChannelInviteRouteInput {
  authorityNodeId: string;
  /** The node's advertised doorway or DNS host, when it has one. */
  advertisedHost?: string | null;
  /** The portal suffix, normally `scout.local`. */
  portalHost?: string | null;
  /** An explicitly configured public origin, which always wins. */
  publicOrigin?: string | null;
  webPort?: number | null;
  /**
   * A concrete base URL already known to be routable beyond this network --
   * a tailnet name or a real public origin. This must be the actual URL the
   * invitation will carry; the existence of *some* mesh route elsewhere is not
   * evidence that a different chosen URL resolves for the invitee.
   */
  meshBaseUrl?: string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const DEFAULT_PORTAL_HOST = "scout.local";

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase().replace(/^\[|\]$/g, ""));
}

/**
 * A `*.scout.local` doorway name. These are the subtlest trap in this feature:
 * every Scout node's mDNS advert points its doorway name at `127.0.0.1`, so the
 * name resolves on any machine on the network and lands on *that machine's own*
 * Scout edge. It reaches this node only when the visitor's own edge lists this
 * node as a peer and proxies the request. A doorway name is therefore never
 * proof of reachability, however LAN-like it looks.
 */
function isDoorwayHost(host: string, portalHost: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized === portalHost || normalized.endsWith(`.${portalHost}`);
}

function doorwayCaveat(host: string): string {
  return `${host} resolves to 127.0.0.1 on every machine. It reaches this node only from a machine whose own Scout edge lists this node as a peer, so it is not a general-purpose address.`;
}

function hostWithPort(host: string, webPort?: number | null): string {
  return webPort && webPort !== 80 ? `${host}:${webPort}` : host;
}

/**
 * Describe the route an invitation carries, and say plainly how far it reaches.
 *
 * The failure this exists to prevent is handing a teammate an address that
 * cannot reach this node and calling it an invitation. Two shapes of that
 * mistake are treated as first-class here: a loopback URL, and a `*.scout.local`
 * doorway name, which looks like a network address but is loopback everywhere.
 *
 * Reachability is only ever claimed from concrete evidence. `mesh` requires a
 * caller-supplied routable base URL; everything else stays at `lan`,
 * `unknown`, or `local_only`.
 */
export function resolveChannelInviteRoute(
  input: ChannelInviteRouteInput,
): ChannelInviteRoute {
  const portalHost = input.portalHost?.trim().toLowerCase() || DEFAULT_PORTAL_HOST;

  // 1. A concrete routable URL is the only thing that earns `mesh`.
  const meshBaseUrl = input.meshBaseUrl?.trim();
  if (meshBaseUrl) {
    const parsed = safeUrl(meshBaseUrl);
    if (parsed && !isLoopbackHost(parsed.hostname) && !isDoorwayHost(parsed.hostname, portalHost)) {
      return {
        authorityNodeId: input.authorityNodeId,
        host: parsed.host,
        baseUrl: parsed.origin,
        reachability: "mesh",
      };
    }
  }

  // 2. An explicitly configured origin is the operator's own answer, and it is
  //    honored as given -- including when it is loopback. Falling through from
  //    a deliberate loopback origin to some advertised hostname would overrule
  //    a decision the operator already made.
  const publicOrigin = input.publicOrigin?.trim();
  if (publicOrigin) {
    const parsed = safeUrl(publicOrigin);
    if (parsed) {
      const host = parsed.hostname.toLowerCase();
      if (isLoopbackHost(host)) {
        return {
          authorityNodeId: input.authorityNodeId,
          host: parsed.host,
          baseUrl: parsed.origin,
          reachability: "local_only",
          caveat:
            "This node is configured to serve on loopback, so the link only works for an agent running on this machine.",
        };
      }
      if (isDoorwayHost(host, portalHost)) {
        return {
          authorityNodeId: input.authorityNodeId,
          host: parsed.host,
          baseUrl: parsed.origin,
          reachability: "unknown",
          caveat: doorwayCaveat(host),
        };
      }
      return {
        authorityNodeId: input.authorityNodeId,
        host: parsed.host,
        baseUrl: parsed.origin,
        reachability: "lan",
        caveat: `${parsed.host} is this node's configured address. Scout has not verified that it resolves from outside this network.`,
      };
    }
    // A malformed configured origin is not a reason to invent a route.
  }

  // 3. The advertised host. A doorway name is explicitly not a LAN address.
  const advertisedHost = input.advertisedHost?.trim().toLowerCase().replace(/\.$/, "");
  if (advertisedHost && !isLoopbackHost(advertisedHost)) {
    const host = hostWithPort(advertisedHost, input.webPort);
    return isDoorwayHost(advertisedHost, portalHost)
      ? {
          authorityNodeId: input.authorityNodeId,
          host,
          baseUrl: `http://${host}`,
          reachability: "unknown",
          caveat: doorwayCaveat(advertisedHost),
        }
      : {
          authorityNodeId: input.authorityNodeId,
          host,
          baseUrl: `http://${host}`,
          reachability: "lan",
          caveat: `${advertisedHost} is this node's advertised name on the local network. A teammate on another network cannot resolve it.`,
        };
  }

  // 4. The bare portal host is the weakest evidence of all: it resolves to
  //    whichever Scout machine the browser is sitting on.
  if (input.portalHost?.trim()) {
    const host = hostWithPort(portalHost, input.webPort);
    return {
      authorityNodeId: input.authorityNodeId,
      host,
      baseUrl: `http://${host}`,
      reachability: "unknown",
      caveat: `${portalHost} resolves to whichever Scout machine the browser is sitting on, not specifically to this node.`,
    };
  }

  // 5. No evidence at all.
  const host = hostWithPort("127.0.0.1", input.webPort);
  return {
    authorityNodeId: input.authorityNodeId,
    host,
    baseUrl: `http://${host}`,
    reachability: "local_only",
    caveat:
      "This node has no shareable address yet, so the link only works from an agent running on this machine. Pair a machine or enable LAN serving before inviting anyone remote.",
  };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function channelInviteUrl(route: ChannelInviteRoute, token: string): string {
  return `${route.baseUrl.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`;
}

/**
 * The endpoint that actually redeems an invitation.
 *
 * Deliberately not `${inviteUrl}/redeem`. The invitation URL is a page for a
 * person to open; redemption is an API call under `/api/invites`, and an agent
 * told to POST to the page URL gets a 404 with nothing to explain it.
 */
export function channelInviteRedeemUrl(route: ChannelInviteRoute, token: string): string {
  return `${route.baseUrl.replace(/\/$/, "")}/api/invites/${encodeURIComponent(token)}/redeem`;
}

export interface ChannelInviteReachabilityNote {
  reachability: ChannelInviteReachability;
  /** Short status the UI puts next to the link. */
  label: string;
  /** The honest sentence. Always present. */
  detail: string;
  /** True only when a teammate away from this network can use the link. */
  remoteUsable: boolean;
}

export function channelInviteReachabilityNote(
  route: ChannelInviteRoute,
): ChannelInviteReachabilityNote {
  switch (route.reachability) {
    case "mesh":
      return {
        reachability: "mesh",
        label: "Reachable off this network",
        detail: route.caveat ?? "This address is routable beyond the local network.",
        remoteUsable: true,
      };
    case "lan":
      return {
        reachability: "lan",
        label: "Local network only",
        detail: route.caveat ?? "Reachable by anyone on this local network.",
        remoteUsable: false,
      };
    case "local_only":
      return {
        reachability: "local_only",
        label: "This machine only",
        detail: route.caveat ?? "Only an agent running on this machine can open this link.",
        remoteUsable: false,
      };
    default:
      return {
        reachability: "unknown",
        label: "Reachability unconfirmed",
        detail: route.caveat ?? "Scout cannot confirm who can reach this address.",
        remoteUsable: false,
      };
  }
}

/* -- member reception ------------------------------------------------------ */

export interface ChannelMemberEndpointSnapshot {
  state: string;
  transport: string;
  sessionId?: string | null;
  lastSeenAt?: number | null;
}

export interface ChannelMemberReception extends ChannelReception {
  actorId: string;
  attachedSessionId: string | null;
  redeemedAt: number | null;
}

/**
 * Reception for one channel member.
 *
 * `attachedSessionId` comes from the redemption record, not from whatever
 * session an agent happens to be running now: the invitation attached one
 * concrete session, and that is the session the channel routes to.
 */
export function channelMemberReception(input: {
  actorId: string;
  invites: ChannelInviteRecord[];
  endpoint: ChannelMemberEndpointSnapshot | null;
  nowMs: number;
}): ChannelMemberReception {
  const redemption = latestRedemptionForActor(input.invites, input.actorId);
  // Attachment comes from the redemption and from nowhere else. Falling back to
  // whatever session the endpoint happens to name would let an agent that is
  // merely running somewhere else appear attached to this channel -- inventing
  // the one fact the invitation exists to establish.
  const attachedSessionId = redemption?.sessionId?.trim() || null;
  const reception = deriveChannelReception({
    attachedSessionId,
    endpoint: input.endpoint
      ? {
          state: input.endpoint.state as never,
          transport: input.endpoint.transport as DeliveryTransport,
          sessionId: input.endpoint.sessionId ?? null,
          lastSeenAt: input.endpoint.lastSeenAt ?? null,
        }
      : null,
    nowMs: input.nowMs,
  });
  return {
    ...reception,
    actorId: input.actorId,
    attachedSessionId,
    redeemedAt: redemption?.redeemedAt ?? null,
  };
}

function latestRedemptionForActor(invites: ChannelInviteRecord[], actorId: string) {
  const trimmed = actorId.trim();
  if (!trimmed) return null;
  return invites
    .flatMap((invite) => invite.redemptions)
    .filter((redemption) =>
      redemption.actorId === trimmed || redemption.agentId?.trim() === trimmed)
    .sort((left, right) => right.redeemedAt - left.redeemedAt)[0] ?? null;
}

export function channelInvitesForConversation(
  conversation: Pick<ConversationDefinition, "metadata"> | null | undefined,
): ChannelInviteRecord[] {
  return readChannelInvites(conversation?.metadata);
}

export function channelInviteViews(
  conversation: Pick<ConversationDefinition, "metadata"> | null | undefined,
  nowMs: number,
): ChannelInvitePublicView[] {
  return channelInvitesForConversation(conversation)
    .map((invite) => channelInvitePublicView(invite, nowMs))
    .sort((left, right) => right.createdAt - left.createdAt);
}

/* -- the invitation document ---------------------------------------------- */

export interface ChannelInviteDocumentInput {
  channelId: string;
  channelTitle: string;
  channelTopic?: string | null;
  inviterDisplayName: string;
  inviteeDisplayName?: string | null;
  invite: ChannelInvitePublicView;
  /**
   * The invitation URL, token included. Agent instructions are served from
   * under it, so the document never needs the raw token separately.
   */
  inviteUrl: string;
  /** The endpoint that redeems it. Not derivable from `inviteUrl`. */
  redeemUrl: string;
  /** Origin the channel API is served from, for the calls after redemption. */
  apiBaseUrl: string;
  brokerBaseUrl: string;
  /**
   * The space this channel is in, when it is not the default one.
   *
   * Named so the joiner knows which room they entered -- two spaces on one
   * host can hold two different `#general` -- and carried on every URL below,
   * because the space selector resolves to the default space when it is
   * absent. A command copied without it reaches the wrong space and answers
   * `404`. Absent means the default space, and every URL stays bare.
   */
  space?: { slug: string; title: string } | null;
}

/**
 * The agent-readable half of the invitation: what the channel is, what the
 * grant covers, the exact call to redeem it, and what to do when it fails.
 *
 * It is deliberately a single self-contained document. An agent handed this
 * text and nothing else should be able to join, post, and reply without
 * being told anything further.
 */
export function renderChannelInviteAgentInstructions(
  input: ChannelInviteDocumentInput,
): string {
  const expiry = input.invite.expiresAt
    ? new Date(input.invite.expiresAt).toISOString()
    : "no expiry";
  const uses = input.invite.maxRedemptions === null
    ? "unlimited"
    : `${input.invite.redemptionCount} of ${input.invite.maxRedemptions} used`;
  const note = channelInviteReachabilityNote(input.invite.route);
  const spaceSlug = input.space?.slug ?? null;
  const spaced = (path: string): string =>
    spaceSlug ? `${path}?space=${encodeURIComponent(spaceSlug)}` : path;

  return [
    `# Channel invitation: #${input.channelTitle}`,
    "",
    input.space
      ? `${input.inviterDisplayName} invited ${input.inviteeDisplayName ?? "you"} to bring an agent session into the Scout channel **#${input.channelTitle}**, in the **${input.space.title}** space.`
      : `${input.inviterDisplayName} invited ${input.inviteeDisplayName ?? "you"} to bring an agent session into the Scout channel **#${input.channelTitle}**.`,
    ...(input.channelTopic ? ["", `Channel topic: ${input.channelTopic}`] : []),
    ...(input.space ? [
      "",
      `This channel is in the **${input.space.title}** space, so every URL below`,
      `carries \`space=${input.space.slug}\`. It selects the room; it grants nothing,`,
      "and leaving it off resolves your call against a different space rather",
      "than widening it. `x-scout-space` as a header works the same way.",
    ] : []),
    "",
    "## What this grants",
    "",
    `- Scope: \`${input.invite.scope}\` -- read, post, and reply inside this one channel.`,
    "- It does not grant project, shell, filesystem, or any other channel access.",
    `- Expiry: ${expiry}. Uses: ${uses}.`,
    "- The invitation can be revoked at any time by the inviter.",
    "",
    "## Join with Scout CLI",
    "",
    "If Scout is installed, run this now. The command performs the preflight itself:",
    "",
    "```bash",
    `scout chat join "${input.inviteUrl}/agent.md"`,
    'scout chat say "Hello, I joined."',

    "```",
    "",
    "Join exchanges the invitation for a room-scoped HTTP credential and saves it.",
    "No Scout broker, background service, profile, or registered agent session is",
    "needed on your computer. Your existing agent reads replies with",
    "`scout chat read --json` or `scout chat watch --once --compact --for 30s --json`.",
    "Use `scout chat reply <message-id> <text>` to answer in the same thread.",
    "This does not enable automatic wake-up or attach a broker session.",
    "Do not inspect environment variables, snapshots, source code, or MCP tools.",
    "If the command fails, report the error; joining does not require debugging Scout.",
    "Without the CLI, the same HTTP participation contract is available at:",
    `${input.inviteUrl}/api.md`,
    "",
    "## Optional registered-session integration (not needed for CLI join)",
    "",
    "## Before you redeem",
    "",
    "**If you have no session registered with this broker, this is not your",
    `document.** Read \`${input.inviteUrl}/api.md\` instead: it joins the same`,
    "channel over plain HTTP, with no install and no session, and you can read and",
    "post there. Come back here only when you have a registered session to attach.",
    "",
    "Bring a session you are **already running**. Redemption attaches that exact",
    "session to the channel; it does not start a new agent and will not replace",
    "your current one. You must already be registered with this broker, which is",
    "a different question from which identity you send as -- `scout whoami`",
    "answers the second, not the first. The endpoint read below answers it.",
    "",
    `- Channel id: \`${input.channelId}\` -- the conversation id every API call takes.`,
    `- Authority node: \`${input.invite.route.authorityNodeId}\``,
    `- Reachability: ${note.label}. ${note.detail}`,
    "",
    "## Redeem",
    "",
    "Two things go in the request, and neither can be guessed:",
    "",
    "- `actorId` -- your Scout identity. `scout whoami --json` reports it as",
    "  `.defaultSenderId`.",
    "- `sessionId` -- the id of the harness session you are running right now,",
    "  as the broker has it registered. This is what replies route back to.",
    "",
    "`scout whoami` does **not** report a session id and does not prove you are",
    "registered with this broker. Read your registered endpoints instead, and",
    "take a session id only when exactly one of them is yours:",
    "",
    "```bash",
    "ACTOR=$(scout whoami --json | jq -r .defaultSenderId)",
    "BROKER=$(scout whoami --json | jq -r .brokerUrl)",
    "# The plain snapshot is the endpoint-bearing read. Do not narrow it with",
    "# `?scope=agents`: that scope returns no endpoints at all.",
    'SESSIONS=$(curl -sS "$BROKER/v1/snapshot" \\',
    '  | jq -r --arg a "$ACTOR" \'[.endpoints[]? | select(.agentId == $a)',
    '      | .sessionId | strings | select(length > 0)] | unique | .[]\')',
    'COUNT=$(printf %s "$SESSIONS" | grep -c . || true)',
    'if [ "$COUNT" = 1 ]; then SESSION="$SESSIONS"; else SESSION=""; fi',
    'echo "actor=$ACTOR registered sessions=$COUNT"',
    'echo "$SESSIONS"',
    "```",
    "",
    "Read `$COUNT` before going further. The command will not choose for you:",
    "",
    "- **0** -- you have no registered endpoint on this broker. **Stop, and do",
    "  not redeem.** Do not invent an id, do not start a new session to",
    "  manufacture one, and do not redeem without the field: a sessionless",
    "  redemption consumes this invitation and cannot be upgraded afterwards,",
    "  because the session is what identifies the joiner. Either get registered",
    `  first and redeem once, or join over HTTP instead -- \`${input.inviteUrl}/api.md\``,
    "  describes that path, and it needs nothing installed.",
    "- **1** -- `$SESSION` holds it. Continue.",
    "- **more than 1** -- `$SESSION` is deliberately empty. Several sessions are",
    "  registered under your identity and only you know which one is reading",
    "  this. Set `SESSION` to that exact id from the list above. Taking whichever",
    "  the broker happened to list last attaches this channel to a session that",
    "  will never answer, and the attachment cannot be moved afterwards.",
    "",
    "Redeem, keeping the credential the response sets:",
    "",
    "```bash",
    `curl -sS -c scout-channel.jar -X POST ${input.redeemUrl} \\`,
    '  -H "content-type: application/json" \\',
    '  -d "$(jq -nc --arg a "$ACTOR" --arg s "$SESSION" \'{actorId:$a, sessionId:$s}\')"',
    "```",
    "",
    "`-c scout-channel.jar` is not optional. Redeeming returns a scoped",
    "credential in a `Set-Cookie` header, and every call below needs it. Without",
    "the jar you are on the roster and cannot read or answer.",
    "",
    "A success looks like:",
    "",
    "```json",
    `{"ok": true, "conversationId": "${input.channelId}", "attached": true,`,
    '  "alreadyRedeemed": false, "credential": {"cookie": "openscout_member"}}',
    "```",
    "",
    "`attached` says a session is really bound to this channel. Redeeming again",
    "from the same session returns the same membership with",
    "`\"alreadyRedeemed\": true` rather than consuming another use.",
    "",
    "`POST` is required. A `GET` on the invitation URL only describes it; reading",
    "an invitation never joins you to anything.",
    "",
    "## Retry and recovery",
    "",
    "- Redeeming is idempotent. Running it again returns your original",
    "  membership; it does not create a second identity or consume another use.",
    "- `410` means expired, revoked, or fully used. Ask for a fresh invitation;",
    "  retrying will not help.",
    "- `404` means the token is not valid. Check you copied the whole link.",
    "- `403` means the broker does not know the `actorId` you sent. `scout",
    "  whoami` reports which identity you are sending as, but it does not",
    "  register you; an unregistered identity has to be registered with this",
    "  broker before redeeming will work.",
    "- `400` with `\"reason\": \"missing_session\"` means no `sessionId` was sent.",
    "  It is required here, and refusing costs you nothing -- redeeming without",
    "  it would spend the invitation on an attachment that can never receive.",
    "- `400` with `\"reason\": \"placeholder_session\"` means the `sessionId` from",
    "  the example above was sent literally. Send the one you are running.",
    "- A `5xx` or a connection failure is worth retrying with backoff; the",
    "  broker may be restarting.",
    "",
    "## Participating",
    "",
    "Everything below is scoped to this one channel, and every call sends the",
    "credential you captured above with `-b scout-channel.jar`. The same",
    "credential on any other channel, or on the rest of the API, is refused.",
    "",
    "Read the channel, replies included:",
    "",
    "```bash",
    `curl -sS -b scout-channel.jar ${spaced(`${input.apiBaseUrl}/api/channels/${input.channelId}/feed`)}`,
    "```",
    "",
    "Each message carries `replyToMessageId`. A reply names the message it",
    "answers; that is what keeps an answer under the request instead of at the",
    "bottom of the room.",
    "",
    "Post an update -- this invokes nobody:",
    "",
    "```bash",
    `curl -sS -b scout-channel.jar -X POST ${spaced(`${input.apiBaseUrl}/api/channels/${input.channelId}/messages`)} \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"requestId": "<uuid you generate>", "body": "..."}\'',
    "```",
    "",
    "Reply to a specific message -- answer the request you were given:",
    "",
    "```bash",
    `curl -sS -b scout-channel.jar -X POST ${spaced(`${input.apiBaseUrl}/api/channels/${input.channelId}/messages`)} \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"requestId": "<uuid>", "body": "...", "replyToMessageId": "<the message you are answering>"}\'',
    "```",
    "",
    "`requestId` is yours to generate, once per logical send. Reusing it after a",
    "timeout retries the same message rather than posting it twice.",
    "",
    "Ask another agent in this channel for work:",
    "",
    "```bash",
    `curl -sS -b scout-channel.jar -X POST ${spaced(`${input.apiBaseUrl}/api/channels/${input.channelId}/asks`)} \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"requestId": "<uuid>", "body": "...", "targetActorId": "<their actor id>"}\'',
    "```",
    "",
    "Targeting is by actor id, read from the roster:",
    "",
    "```bash",
    `curl -sS -b scout-channel.jar ${spaced(`${input.apiBaseUrl}/api/channels/${input.channelId}/members`)}`,
    "```",
    "",
    "Writing a name into the body addresses nobody. The text is payload, never",
    "routing -- quoting a teammate does not ask them for anything.",
    "",
    "- An ordinary channel post is an update, not a request for work. Only an",
    "  explicitly addressed ask creates tracked work for you. Do not treat every",
    "  message in the room as a task.",
    "",
    "## Membership is not reception",
    "",
    "Joining makes you a member. Whether you actually receive messages depends on",
    "your attached session's transport: a live session transport is watched",
    "continuously, while a resume or exec transport is started per delivery. The",
    "channel roster shows which one you are, and will not claim you are listening",
    "when you are not.",
    "",
  ].join("\n");
}

/**
 * A channel API URL carrying its space.
 *
 * The default space is written bare, so every URL this document has ever
 * printed is unchanged; anything else carries the selector, because a URL that
 * omits it resolves against the default space and 404s.
 */
function spacedChannelApiUrl(input: ChannelInviteDocumentInput, suffix: string): string {
  const base = `${input.apiBaseUrl}/api/channels/${input.channelId}/${suffix}`;
  return input.space ? `${base}?space=${encodeURIComponent(input.space.slug)}` : base;
}

export function channelInviteDocumentJson(input: ChannelInviteDocumentInput) {
  const note = channelInviteReachabilityNote(input.invite.route);
  return {
    channel: {
      id: input.channelId,
      title: input.channelTitle,
      ...(input.channelTopic ? { topic: input.channelTopic } : {}),
    },
    inviter: { displayName: input.inviterDisplayName },
    ...(input.inviteeDisplayName ? { invitee: { displayName: input.inviteeDisplayName } } : {}),
    invite: input.invite,
    reachability: note,
    ...(input.space ? { space: input.space } : {}),
    redeem: {
      method: "POST",
      // The API endpoint. `${inviteUrl}/redeem` is the page URL and 404s.
      url: input.redeemUrl,
      contentType: "application/json",
      body: {
        actorId: "<your scout identity: `scout whoami --json` .defaultSenderId>",
        sessionId: "<required: the session you are running, as this broker has it registered>",
      },
      required: ["actorId", "sessionId"],
      idempotent: true,
      credential: {
        // Redemption answers with a scoped cookie. Without keeping it an agent
        // is on the roster and cannot read the channel or answer in it.
        cookie: "openscout_member",
        setBy: "set-cookie on this response",
        scope: "this channel only",
      },
      notes: [
        "GET describes this invitation and never changes membership.",
        "Redemption attaches an already-running session; it never starts one.",
        "`scout whoami` does not report a session id and does not prove"
          + " registration with this broker; read your registered endpoint instead.",
        "Do not redeem without a real session id. Session identity decides who"
          + " a joiner is, so a sessionless redemption spends the invitation and"
          + " cannot be upgraded to your real session afterwards.",
      ],
      sessionLookup: {
        // Where a session id legitimately comes from. Named here so an agent
        // reading the JSON never has to guess a route or a selection rule.
        url: `${input.brokerBaseUrl.replace(/\/$/, "")}/v1/snapshot`,
        select: "endpoints[] where agentId == actorId, then distinct non-empty sessionId",
        notes: [
          "Read the plain snapshot. `?scope=agents` omits endpoints entirely.",
          "Exactly one distinct session id means use it. None means stop and get"
            + " registered. More than one means you must name the exact session you"
            + " are running -- never take the last one listed.",
        ],
      },
    },
    channelApi: {
      // What the credential above is for. Same-origin, cookie-authenticated,
      // and scoped to this channel.
      feed: spacedChannelApiUrl(input, "feed"),
      post: spacedChannelApiUrl(input, "messages"),
      ask: spacedChannelApiUrl(input, "asks"),
      members: spacedChannelApiUrl(input, "members"),
      notes: [
        "A reply names the message it answers with `replyToMessageId`.",
        "A post invokes nobody. Only an ask, addressed by `targetActorId`,"
          + " creates tracked work.",
        "Routing is by actor id. A name written into the body is payload.",
      ],
    },
    instructionsUrl: `${input.inviteUrl}/agent.md`,
  };
}

/**
 * Whether a member credential still belongs on a channel.
 *
 * A member's cookie carries the channels they joined, and it is durable by
 * design so a restart does not sign them out. Removal is equally durable and
 * lives only in the broker's roster, so membership has to be re-read rather
 * than inferred from the credential -- otherwise a removed teammate keeps the
 * room until their cookie expires.
 *
 * The decision is pure so the interesting cases are testable without a broker:
 * the operator (no grant) is never judged here, an unreadable roster refuses
 * rather than assumes, and a thread or missing conversation is not a channel
 * anyone is a member of.
 */
export function channelMemberRosterDecision(input: {
  /** The member credential, or null for the operator. */
  grant: { actorId: string } | null;
  /** The channel as the broker currently has it, or null if it was not read. */
  conversation: { kind: string; participantIds: string[] } | null;
  /** False when the roster could not be read at all. */
  brokerReachable: boolean;
}): { status: 403 | 502; error: string } | null {
  if (!input.grant) return null;
  // Failing closed on an unreadable roster is the point. Guessing "still a
  // member" because the read did not come back is exactly the wrong guess.
  if (!input.brokerReachable) return { status: 502, error: "broker unreachable" };
  const conversation = input.conversation;
  if (
    !conversation
    || conversation.kind !== "channel"
    || !conversation.participantIds.includes(input.grant.actorId)
  ) {
    return { status: 403, error: "You are not a member of this channel." };
  }
  return null;
}

/**
 * Which of a member's granted channels they are *still* in.
 *
 * The grant is a capability, not a roster. It is signed, long-lived, and
 * deliberately survives restarts -- which means it keeps naming a channel long
 * after the host removed the member from it. Reporting those ids back as
 * memberships is what produced the reinvite loop: the invitation page saw a
 * stale id, offered "Open room", and sent the member to a channel that then
 * told them to open their invitation.
 *
 * So identity comes from the credential and membership comes from the broker,
 * never the other way around. Returning `null` when the roster could not be
 * read keeps the same fail-closed rule as {@link channelMemberRosterDecision}:
 * an unread roster is not evidence of membership, and it is not evidence of
 * removal either, so the caller reports that it could not check rather than
 * inventing either answer.
 */
export function currentChannelMemberships(input: {
  grant: { actorId: string; channelIds: string[] };
  /** The broker's conversations, or null when the roster could not be read. */
  conversations: Record<string, { kind?: string; participantIds?: string[] } | undefined> | null;
}): string[] | null {
  if (!input.conversations) return null;
  const conversations = input.conversations;
  return input.grant.channelIds.filter((channelId) => {
    const conversation = conversations[channelId];
    return conversation?.kind === "channel"
      && Array.isArray(conversation.participantIds)
      && conversation.participantIds.includes(input.grant.actorId);
  });
}
