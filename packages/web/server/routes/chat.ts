import { inboxDatabaseRevision } from "../db/inbox-revision.ts";
import { ChannelInboxCoordinator } from "../../shared/channel-inbox-coordinator.ts";
import { subscribeInboxChanges } from "../channel-inbox-source.ts";
import { filterChannelInbox, holdChannelInbox, inboxWaitSeconds } from "../../shared/channel-inbox.ts";
import type { Hono } from "hono";
import { parseChatPresenceBeat } from "../../shared/chat-presence.ts";
import { chatExecutionSession, chatSessionApprovals } from "../chat-approval-association.ts";
import { chatQuestionPage, chatQuestionAttentionCounts, decodeChatQuestionCursor } from "../chat-question-page.ts";
import { chatRequestResponsibility } from "../chat-request-responsibility.ts";
import {
  parseChatMentionActorIds,
  applyChatAttentionPreferenceChange,
  parseChatMessageChange,
  parseChatPinChange,
  readChatPins,
  readChannelMemberRemoval,
} from "@openscout/protocol";
import { ChannelEventStreams } from "../channel-event-stream.ts";
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  CHANNEL_NATURAL_KEY_METADATA,
  CHANNEL_SPACE_SLUG_METADATA,
  DEFAULT_CHAT_SPACE_SLUG,
  channelNaturalKeyFromMetadata,
  channelSpaceSlug,
  normalizeChatSpaceSlug,
  spacedChannelNaturalKey,
  isOpaqueChannelId,
  isAllowedReactionEmoji,
  projectMessageReactionChips,
  stableChannelId,
  type AgentEndpoint,
  type ConversationDefinition,
  type MessageRecord,
} from "@openscout/protocol";
import {
  decideScoutWebPairingApproval,
  interruptScoutWebPairingTurn,
  getScoutWebPairingSessionSnapshot,
  refreshScoutWebPairingState,
  type ScoutPairingState,
} from "../pairing.ts";
import { cookieValue, isForwardedHttpsScoutRequest } from "../server-core.ts";
import { endpointFreshnessMs } from "../core/agent-endpoints.ts";
import { blobServeHeaders, getImageBlob } from "../image-blob-store.ts";
import { localPathFromBlobKey, resolveChatAttachments } from "../chat-attachments.ts";
import { queryFlightRecordById, queryRecentMessages, type WebMessage } from "../db-queries.ts";
import {
  loadScoutBrokerContext,
  loadScoutReadCursors,
  markScoutConversationRead,
  updateScoutChatPreferences,
  updateScoutChannelPins,
  correctScoutChatMessage,
  respondScoutChatQuestion,
  readScoutChatQuestionHistory,
  type ScoutBrokerContext,
  sendScoutConversationMessage,
  listScoutMessageReactions,
  sendScoutMessageReaction,
  sendScoutConversationSteer,
  invalidateScoutBrokerContextCache,
  upsertScoutConversation,
  cancelScoutChatFlight,
} from "../core/broker/service.ts";
import { channelAskDispatchNote, planChannelAsks } from "../core/conversations/channel-ask.ts";
import { CHANNEL_MEMBER_COOKIE, channelMemberCookie } from "../core/conversations/channel-member-session.ts";
import {
  apiParticipantActor,
  apiParticipantActorId,
  apiParticipantDisplayName,
  isApiParticipantActor,
  readApiParticipantJoinRequest,
  renderChannelApiParticipantInstructions,
} from "../core/conversations/channel-api-participants.ts";
import {
  CHANNEL_POLL_INTERVAL_CAUGHT_UP_MS,
  ChannelPollCursorError,
  ChannelPollError,
  DEFAULT_CHANNEL_POLL_LIMIT,
  MAX_CHANNEL_POLL_LIMIT,
  clampChannelPollLimit,
  pageChannelPoll,
} from "../core/conversations/channel-polling.ts";
import { ChatReadPositionError, markChatChannelRead, readChatChannelState } from "../core/conversations/channel-read-state.ts";
import {
  CHANNEL_INVITE_TOKEN_PATTERN,
  DEFAULT_CHANNEL_INVITE_TTL_MS,
  channelInviteReachabilityNote,
  hashChannelInviteToken,
  channelInviteRedeemUrl,
  channelInviteUrl,
  channelInviteViews,
  channelMemberRosterDecision,
  currentChannelMemberships,
  channelInvitesForConversation,
  channelMemberReception,
  renderChannelInviteAgentInstructions,
  type ChannelInviteRouteInput,
} from "../core/conversations/channel-invites.ts";
import {
  createChannelInvite,
  joinChannelInviteAsApiParticipant,
  joinChannelInviteAsPerson,
  redeemChannelInvite,
  resolveChannelInviteByToken,
  revokeChannelInvite,
  removeChannelMember,
} from "../core/conversations/channel-invite-service.ts";
import {
  CHAT_SPACE_HEADER,
  CHAT_SPACE_QUERY_KEY,
  chatChannelSpaceDecision,
  chatSpaceChannels,
  chatSpaceRosterAddition,
  createChatSpace,
  DEFAULT_CHAT_SPACE_TITLE,
  findChatSpaceRecord,
  listChatSpaces,
  memberVisibleSpaceSlugs,
  resolveChatSpaceSelection,
  type ChatSpaceSelection,
} from "../core/conversations/chat-spaces.ts";
import {
  getScoutConversationMessages,
  isTransientBrokerWaitStatusMessage,
  normalizeTimestampMs,
  type ScoutConversationMessage,
} from "../core/conversations/service.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import {
  DEFAULT_MESSAGE_PAGE_LIMIT,
  MessageCursorError,
  clampMessagePageLimit,
  compareMessagesAsc,
  encodeMessageHistoryCursor,
  parseMessageHistoryCursor,
} from "../../shared/message-pagination.ts";
import { brokerFlightToWebFlight, queryBrokerFlightsForWeb } from "../web-flights.ts";
import { parseOptionalPositiveInt, serveRawFile } from "../http-helpers.ts";
import type { CreateOpenScoutWebServerOptions } from "../web-server-options.ts";
import type { ChatSendLimiter } from "../chat-send-limiter.ts";
import type { ChatPresence } from "../../shared/chat-presence.ts";
import type { ChannelMemberGrant, ChannelMemberSessionAuthority } from "../core/conversations/channel-member-session.ts";
import {
  channelAskBody,
  channelInviteCreateBody,
  channelInviteJoinBody,
  channelInviteRedeemBody,
  channelInviteRevokeBody,
  channelMessageBody,
  channelReactionBody,
  chatChannelCreateBody,
  chatSpaceCreateBody,
} from "../../shared/api/chat.ts";
import { readJsonBody } from "../request-body.ts";

export type ChatRouteDeps = {
  options: Pick<CreateOpenScoutWebServerOptions, "advertisedHost" | "authToken" | "portalHost" | "publicOrigin" | "webPort">;
  chatSendLimiter: ChatSendLimiter;
  chatPresence: ChatPresence;
  currentDirectory: string;
  channelMemberSessions: ChannelMemberSessionAuthority;
  readChannelMemberGrant: (request: Request) => ChannelMemberGrant | null;
};

export function mountChatRoutes(app: Hono, deps: ChatRouteDeps) {
  const { options, readChannelMemberGrant, channelMemberSessions, chatPresence, currentDirectory, chatSendLimiter } = deps;

  /* -- channel invitations ------------------------------------------------- */

  // The invitation route is resolved per request rather than cached: the node's
  // reachability can change under us (a tailnet coming up, a public origin being
  // configured), and an invitation that overstates its reach is the exact
  // failure this feature must not ship.
  const resolveInviteRouteInput = (
    authorityNodeId: string,
  ): ChannelInviteRouteInput => ({
    authorityNodeId,
    advertisedHost: options.advertisedHost ?? null,
    portalHost: options.portalHost ?? null,
    publicOrigin: options.publicOrigin ?? null,
    webPort: options.webPort ?? null,
    // Only a configured public origin is treated as routable off-network. The
    // portal's LAN/tailnet links are peer-resolution hints, not a promise that
    // a given URL resolves for the person holding the invitation.
    meshBaseUrl: null,
  });

  /**
   * How long an authorization read may take before it is refused.
   *
   * Failing closed on a slow or unreachable broker is the point: the roster is
   * what says a member still belongs here, and guessing "yes" because the read
   * did not come back is exactly the wrong guess.
   */
  const CHANNEL_ROSTER_READ_TIMEOUT_MS = 5_000;

  /**
   * Refuse a member who is no longer on a channel's roster.
   *
   * A member's cookie carries the channels they joined, which is durable by
   * design -- it survives a restart. Being *removed* from a channel is equally
   * durable and lives only in the broker, so membership has to be re-read
   * rather than inferred from the credential, or a removed teammate would keep
   * the room until their cookie expired.
   *
   * The read deliberately bypasses the snapshot cache. Passing a signal makes
   * `loadScoutBrokerContext` skip the cache for this call alone, which is what
   * is wanted here: an authorization decision must not be answered from a
   * snapshot that predates the removal, and forcing a refresh instead would
   * evict the operator's caches as a side effect of a guest's request.
   *
   * The operator is not a member and is not checked here; their own credential
   * is what authorizes them.
   */
  const denyRemovedChannelMember = async (
    request: Request,
    channelId: string,
  ): Promise<{ status: 403 | 502; error: string } | null> => {
    const grant = readChannelMemberGrant(request);
    if (!grant) return null;
    const fresh = await loadScoutBrokerContext(undefined, {
      scope: "conversations",
      signal: AbortSignal.timeout(CHANNEL_ROSTER_READ_TIMEOUT_MS),
    }).catch(() => null);
    return channelMemberRosterDecision({
      grant,
      brokerReachable: Boolean(fresh),
      conversation: (fresh?.snapshot.conversations?.[channelId] as
        | ConversationDefinition
        | undefined) ?? null,
    });
  };

  /**
   * This node's reserved chat name. Invitations advertise it, and its root
   * redirects to the chat surface.
   */
  const chatServiceHost = (): string => {
    const portalHost = options.portalHost?.trim().toLowerCase();
    return portalHost ? `chat.${portalHost}` : "chat.scout.local";
  };

  /** The operator's actor id in the broker. Members are distinct person actors. */
  const CHAT_OPERATOR_ACTOR_ID = "operator";

  type ChatViewer = { actorId: string; displayName: string; isOperator: boolean };

  const chatViewerFor = (request: Request): ChatViewer => {
    const member = readChannelMemberGrant(request);
    if (member) {
      return { actorId: member.actorId, displayName: member.displayName, isOperator: false };
    }
    // Reaching a handler means the middleware already accepted the request, so
    // anything that is not a member credential is the operator.
    return {
      actorId: CHAT_OPERATOR_ACTOR_ID,
      displayName: resolveOperatorName().trim() || "Operator",
      isOperator: true,
    };
  };

  /**
   * Which space this request is about.
   *
   * `?space=` and `X-Scout-Space` are two spellings of the same *selector*: a
   * browser puts it in the URL so a link carries it, and an HTTP client that
   * was handed a bare endpoint can set the header instead. Neither is a
   * credential. The rules live in `resolveChatSpaceSelection`, and the one that
   * matters is that an absent selector resolves to the caller's own narrowest
   * space -- their credential's, or the default -- never to "all of them".
   */
  const resolveChatSpaceFor = (request: Request): ChatSpaceSelection => {
    const url = new URL(request.url);
    const grant = readChannelMemberGrant(request);
    return resolveChatSpaceSelection({
      requested: url.searchParams.get(CHAT_SPACE_QUERY_KEY)
        ?? request.headers.get(CHAT_SPACE_HEADER),
      grantSpaceSlug: grant?.spaceSlug ?? (grant ? DEFAULT_CHAT_SPACE_SLUG : null),
    });
  };

  type ChatChannelResolution =
    | {
        ok: true;
        broker: ScoutBrokerContext;
        conversation: ConversationDefinition;
        viewer: ChatViewer;
        spaceSlug: string;
      }
    | { ok: false; status: 400 | 403 | 404 | 502; error: string };

  /**
   * Resolve a channel for a chat request, and refuse it unless the caller is a
   * member of that exact channel, in that exact space.
   *
   * The scoped-credential middleware already limits a member to the channels
   * their cookie names. This is the second, independent check, and it is the
   * one that matters for removal: it re-reads the broker's roster past the
   * snapshot cache, so a member taken out of a channel loses it on their next
   * request rather than when their cookie expires.
   *
   * It is also the one choke point every channel read and write passes
   * through -- feed, poll, events, messages, asks, members and invitations --
   * which is what makes the space boundary real rather than cosmetic. A
   * channel in another space answers 404 here even when the client hand-crafts
   * the request with the right id, and it answers 404 rather than 403 so the
   * refusal is not a directory of the rooms you are not in.
   */
  const resolveChatChannel = async (
    request: Request,
    channelId: string,
  ): Promise<ChatChannelResolution> => {
    if (!isOpaqueChannelId(channelId)) {
      return { ok: false, status: 400, error: "channelId must be an opaque chat id" };
    }
    const space = resolveChatSpaceFor(request);
    if (!space.ok) return { ok: false, status: 400, error: space.error };
    const denial = await denyRemovedChannelMember(request, channelId);
    if (denial) return { ok: false, status: denial.status, error: denial.error };
    const broker = await loadScoutBrokerContext();
    if (!broker) return { ok: false, status: 502, error: "broker unreachable" };
    const conversation = broker.snapshot.conversations?.[channelId] as
      | ConversationDefinition
      | undefined;
    if (!conversation || conversation.kind !== "channel") {
      return { ok: false, status: 404, error: "channel not found" };
    }
    const grant = readChannelMemberGrant(request);
    const spaceDenial = chatChannelSpaceDecision({
      channelSpaceSlug: channelSpaceSlug(conversation),
      selectedSpaceSlug: space.slug,
      grantSpaceSlug: grant ? grant.spaceSlug ?? DEFAULT_CHAT_SPACE_SLUG : null,
    });
    if (spaceDenial) return { ok: false, status: spaceDenial.status, error: spaceDenial.error };
    return {
      ok: true,
      broker,
      conversation,
      viewer: chatViewerFor(request),
      spaceSlug: channelSpaceSlug(conversation),
    };
  };

  /**
   * The space an invitation's channel lives in, and what to call it.
   *
   * Read from the channel record, never from the request: a channel is in
   * exactly one space, so an invitation is space-scoped for free and there is
   * nothing for a caller to name. This is what lets the acceptance routes bind
   * a credential to one space without trusting anything the joiner sent.
   */
  const chatSpaceForChannelId = async (
    channelId: string,
  ): Promise<{ slug: string; title: string }> => {
    const broker = await loadScoutBrokerContext().catch(() => null);
    const conversations = broker?.snapshot.conversations as
      Record<string, ConversationDefinition | undefined> | undefined;
    const conversation = conversations?.[channelId];
    // An unreadable channel reads as the default space rather than as "no
    // space". A credential is about to be bound to this answer, and the
    // narrowest answer is the only safe one to guess.
    const slug = conversation ? channelSpaceSlug(conversation) : DEFAULT_CHAT_SPACE_SLUG;
    if (slug === DEFAULT_CHAT_SPACE_SLUG) {
      return { slug, title: DEFAULT_CHAT_SPACE_TITLE };
    }
    const record = findChatSpaceRecord(conversations, slug);
    return { slug, title: record?.title.trim() || slug };
  };

  /**
   * Put a joiner on the space's roster.
   *
   * Space membership is derived, not invited: being let into a channel is what
   * puts you in its space. Best-effort on purpose -- the roster is a label, and
   * a failed write here must never turn a successful join into a failure.
   */
  const addActorToChatSpaceRoster = async (spaceSlug: string, actorId: string): Promise<void> => {
    if (spaceSlug === DEFAULT_CHAT_SPACE_SLUG) return;
    try {
      const broker = await loadScoutBrokerContext().catch(() => null);
      if (!broker) return;
      const next = chatSpaceRosterAddition({
        conversations: broker.snapshot.conversations as
          Record<string, ConversationDefinition | undefined> | undefined,
        spaceSlug,
        actorId,
      });
      if (!next) return;
      await upsertScoutConversation(next);
      invalidateScoutBrokerContextCache(broker.baseUrl);
    } catch {
      // The join already succeeded. A missing roster label is a cosmetic gap.
    }
  };

  /**
   * A channel API path carrying its space.
   *
   * Every URL this server hands to a client goes through here, so a document,
   * a poll URL and a redirect cannot drift into three different spellings of
   * the same rule. The default space is written bare, which keeps every URL
   * that exists today byte-identical.
   */
  const chatChannelPath = (channelId: string, suffix: string, spaceSlug: string): string => {
    const base = `/api/channels/${encodeURIComponent(channelId)}/${suffix}`;
    return spaceSlug === DEFAULT_CHAT_SPACE_SLUG
      ? base
      : `${base}?${CHAT_SPACE_QUERY_KEY}=${encodeURIComponent(spaceSlug)}`;
  };

  app.get("/api/channels/:id/invites", async (c) => {
    const channelId = c.req.param("id");
    // Through the same resolver as the feed. An invitation list is a read of
    // the room, so a room in another space must be as unreachable here as it
    // is there -- a second, laxer path to the same conversation is how a
    // namespace boundary turns into a suggestion.
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    return c.json({ invites: channelInviteViews(resolved.conversation, Date.now()) });
  });

  app.post("/api/channels/:id/invites", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const parsed = await readJsonBody(c, channelInviteCreateBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    // Authorship comes from the credential. A member may invite their own agent
    // into the channel they joined, but neither they nor a crafted body may
    // attribute that invitation to the operator.
    const inviter = readChannelMemberGrant(c.req.raw);
    const createdByActorId = inviter
      ? inviter.actorId
      : body.createdByActorId?.trim() || "operator";
    const broker = resolved.broker;

    const nowMs = Date.now();
    const expiresInMs = body.expiresInMs === null
      ? null
      : body.expiresInMs ?? DEFAULT_CHANNEL_INVITE_TTL_MS;
    const outcome = await createChannelInvite({
      channelId,
      createdByActorId,
      ...(body.invitee?.displayName?.trim()
        ? {
            invitee: {
              ...(body.invitee.actorId?.trim() ? { actorId: body.invitee.actorId.trim() } : {}),
              displayName: body.invitee.displayName.trim(),
            },
          }
        : {}),
      expiresAt: expiresInMs === null ? null : nowMs + expiresInMs,
      maxRedemptions: body.maxRedemptions ?? null,
      route: resolveInviteRouteInput(broker.node.id),
      nowMs,
      createId: () => `cinv-${randomUUID()}`,
    });
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);

    // The raw token is returned exactly once, to whoever created the invitation,
    // and is never written to a log line or a broker record.
    return c.json({
      invite: outcome.invite,
      token: outcome.token,
      inviteUrl: outcome.inviteUrl,
      agentInstructionsUrl: `${outcome.inviteUrl}/agent.md`,
      reachability: channelInviteReachabilityNote(outcome.invite.route),
      serviceHost: chatServiceHost(),
    });
  });

  app.post("/api/channels/:id/invites/:inviteId/revoke", async (c) => {
    const channelId = c.req.param("id");
    const inviteId = c.req.param("inviteId");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const parsed = await readJsonBody(c, channelInviteRevokeBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    // Revocation authorship follows creation authorship: from the credential,
    // never the body.
    const revoker = readChannelMemberGrant(c.req.raw);
    if (revoker) {
      // A member who can hand out an invitation must be able to take it back,
      // or they can let someone into the room and then not undo it. What they
      // must not do is revoke the host's invitations, so authorship is checked
      // against the stored record rather than trusted from the request.
      const invite = channelInvitesForConversation(resolved.conversation)
        .find((record) => record.id === inviteId);
      if (!invite) return c.json({ error: "invitation not found" }, 404);
      if (invite.createdByActorId !== revoker.actorId) {
        return c.json({ error: "Only the person who created this invitation can revoke it." }, 403);
      }
    }
    const outcome = await revokeChannelInvite({
      channelId,
      inviteId,
      revokedByActorId: revoker?.actorId ?? body.revokedByActorId?.trim() ?? "operator",
    });
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    return c.json({ ok: true, invite: outcome.invite });
  });

  app.post("/api/channels/:id/members/revoke", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (!resolved.viewer.isOperator) {
      return c.json({ error: "Only the operator can remove channel members." }, 403);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "actorId")
      || typeof body.actorId !== "string" || !body.actorId.trim()) {
      return c.json({ error: "Choose a channel member to remove." }, 400);
    }
    const outcome = await removeChannelMember({
      channelId, actorId: body.actorId.trim(), removedByActorId: resolved.viewer.actorId,
    });
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    return c.json({ ok: true });
  });

  app.get("/api/channels/:id/members", async (c) => {
    const channelId = c.req.param("id");
    const rosterMember = readChannelMemberGrant(c.req.raw);
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { conversation } = resolved;
    // Membership is durable. Do not read it from the rolling 24h snapshot;
    // that window is for messages. A later thin snapshot was wiping the roster.
    const completeBroker = await loadScoutBrokerContext(undefined, { since: null });
    const broker = completeBroker ?? resolved.broker;
    const nowMs = Date.now();
    const durable = (broker.snapshot.conversations?.[channelId] as ConversationDefinition | undefined)
      ?? conversation;
    const invites = channelInvitesForConversation(durable);
    const endpoints = Object.values(broker.snapshot.endpoints ?? {}) as AgentEndpoint[];
    const memberIds = new Set(durable.participantIds);
    // Snapshot windows can omit a member who has not spoken recently.
    // Preserve legacy participants inferred from history, except explicit removals.
    const conversations = broker.snapshot.conversations ?? {};
    for (const message of Object.values(broker.snapshot.messages ?? {}) as MessageRecord[]) {
      if (!memberIds.has(message.actorId) && readChannelMemberRemoval(durable.metadata, message.actorId)) continue;
      const home = message.conversationId;
      if (home === channelId) {
        memberIds.add(message.actorId);
        continue;
      }
      const parent = conversations[home]?.parentConversationId;
      if (parent === channelId) memberIds.add(message.actorId);
    }
    const members = [...memberIds].map((actorId) => {
      const actor = broker.snapshot.actors?.[actorId];
      const agent = broker.snapshot.agents?.[actorId];
      // Freshest endpoint for this actor. Reception itself decides whether the
      // endpoint is evidence for the *attached* session -- picking the newest
      // here only avoids judging a member by a stale record.
      const endpoint = endpoints
        .filter((candidate) => candidate.agentId === actorId)
        .sort((left, right) => endpointFreshnessMs(right) - endpointFreshnessMs(left))[0]
        ?? null;
      // Ownership is what makes an agent render as "Maya's Codex" rather than
      // as a free-floating participant. It comes from the agent definition, so
      // an agent with no owner stays unowned rather than being adopted by the
      // local operator.
      const owner = agent?.ownerId ? broker.snapshot.actors?.[agent.ownerId] : undefined;
      return {
        actorId,
        kind: actor?.kind ?? (agent ? "agent" : "unknown"),
        displayName: actor?.displayName ?? agent?.displayName ?? actorId,
        // Declared, so a surface never has to infer it from an absent session.
        // "api" means readable and postable, never invocable.
        participation: isApiParticipantActor({
          id: actorId,
          metadata: (actor as { metadata?: Record<string, unknown> } | undefined)?.metadata
            ?? null,
        })
          ? "api"
          : "session",
        ...(agent?.ownerId
          ? {
              owner: {
                actorId: agent.ownerId,
                displayName: owner?.displayName ?? agent.ownerId,
              },
            }
          : {}),
        // Harness and workspace describe the concrete endpoint, not the durable
        // agent, so they are read from the endpoint or omitted.
        ...(endpoint?.harness ? { harness: endpoint.harness } : {}),
        ...(endpoint?.projectRoot ? { projectRoot: endpoint.projectRoot } : {}),
        reception: channelMemberReception({
          actorId,
          invites,
          endpoint: endpoint
            ? {
                state: endpoint.state,
                transport: endpoint.transport,
                sessionId: endpoint.sessionId ?? null,
                // 0 means "no evidence at all", which reception must read as
                // never-observed rather than as the epoch.
                lastSeenAt: endpointFreshnessMs(endpoint) || null,
              }
            : null,
          nowMs,
        }),
      };
    });
    const currentGrant = readChannelMemberGrant(c.req.raw);
    if (rosterMember && (!currentGrant || currentGrant.actorId !== rosterMember.actorId || resolved.viewer.actorId !== rosterMember.actorId)) {
      return c.json({ error: "Channel member identity is no longer valid." }, 403);
    }
    const visibleMembers = rosterMember
      ? members.filter(member => !readChannelMemberRemoval(durable.metadata, member.actorId)).map(({ actorId, displayName, kind }) => ({ actorId, displayName, kind }))
      : members;
    return c.json({ channelId, members: visibleMembers, authoritative: Boolean(completeBroker?.snapshot.conversations?.[channelId]) });
  });

  /**
   * Describe an invitation. A pure read: opening a link must never join a
   * channel, so there is no mutating GET anywhere in this feature.
   */
  app.get("/api/invites/:token", async (c) => {
    const token = c.req.param("token");
    if (!CHANNEL_INVITE_TOKEN_PATTERN.test(token)) {
      return c.json({ error: "This invitation link is not valid." }, 404);
    }
    const resolved = await resolveChannelInviteByToken(token);
    if (!resolved) return c.json({ error: "This invitation link is not valid." }, 404);
    const previewSpace = await chatSpaceForChannelId(resolved.conversation.id);
    return c.json({
      channel: {
        id: resolved.conversation.id,
        title: resolved.conversation.title,
        ...(resolved.conversation.topic ? { topic: resolved.conversation.topic } : {}),
        memberCount: resolved.conversation.participantIds.length,
      },
      invite: resolved.view,
      reachability: channelInviteReachabilityNote(resolved.view.route),
      // Which room, when two spaces can hold the same name. A landing page that
      // cannot say this leaves the joiner to guess.
      space: { slug: previewSpace.slug, title: previewSpace.title },
    });
  });

  app.post("/api/invites/:token/redeem", async (c) => {
    const token = c.req.param("token");
    if (!CHANNEL_INVITE_TOKEN_PATTERN.test(token)) {
      return c.json({ error: "This invitation link is not valid." }, 404);
    }
    const parsed = await readJsonBody(c, channelInviteRedeemBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const actorId = body.actorId?.trim();
    if (!actorId) {
      return c.json({ error: "actorId is required", reason: "missing_identity" }, 403);
    }
    // An agent redemption must name the session it is attaching, and redeeming
    // without one is not a safe half-step: a sessionless redemption is recorded
    // against the actor and consumes a use, and because session identity is
    // decisive, a later redemption carrying the real session is a *different*
    // joiner -- so on a single-use invitation it is rejected as exhausted.
    // Refusing here costs nothing; redeeming early costs the invitation.
    //
    // People join sessionless through `/join`, which mints a person actor and
    // has no session to attach.
    const sessionId = body.sessionId?.trim();
    if (!sessionId) {
      return c.json(
        {
          error: "sessionId is required: name the session you are running now."
            + " Redeeming without one consumes this invitation and cannot be"
            + " upgraded to your real session afterwards.",
          reason: "missing_session",
        },
        400,
      );
    }
    // A placeholder left in from a copied example is worse still: it records an
    // attachment to a session that does not exist, so the channel reports the
    // member as attached while every ask routes into nothing.
    if (/^[<{].*[>}]$/.test(sessionId)) {
      return c.json(
        {
          error: "sessionId looks like a placeholder from an example."
            + " Send the id of the session you are actually running.",
          reason: "placeholder_session",
        },
        400,
      );
    }
    const outcome = await redeemChannelInvite({
      token,
      actorId,
      ...(body.agentId?.trim() ? { agentId: body.agentId.trim() } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(body.endpointId?.trim() ? { endpointId: body.endpointId.trim() } : {}),
      ...(body.nodeId?.trim() ? { nodeId: body.nodeId.trim() } : {}),
      ...(body.harness?.trim() ? { harness: body.harness.trim() } : {}),
      ...(body.projectRoot?.trim() ? { projectRoot: body.projectRoot.trim() } : {}),
      ...(body.displayName?.trim() ? { displayName: body.displayName.trim() } : {}),
      createId: () => `crdm-${randomUUID()}`,
    });
    if (!outcome.ok) {
      return c.json(
        { error: outcome.error, ...(outcome.reason ? { reason: outcome.reason } : {}) },
        outcome.status,
      );
    }
    // Redemption hands back a credential, the same as a person's join does.
    // Without one an invited agent could be added to the roster and then be
    // unable to read the channel or answer in it -- membership with no way to
    // participate, which is not what the invitation offers.
    //
    // The grant is the same narrow kind: this actor, this channel, nothing
    // else. An agent redeeming a second invitation widens it by one channel.
    //
    // A cookie already in the jar is only widened when it belongs to *this*
    // actor. A browser or a shared jar can easily be carrying a person's grant
    // or another agent's, and widening that one would hand this channel to
    // whoever the cookie names instead of to the agent that just redeemed.
    const redeemSpace = await chatSpaceForChannelId(outcome.conversationId);
    const existingGrantToken = cookieValue(c.req.raw, CHANNEL_MEMBER_COOKIE);
    const existingGrant = existingGrantToken
      ? channelMemberSessions.validate(existingGrantToken)
      : null;
    // Widening stops at the space boundary. `grantChannel` refuses rather than
    // widening when the new channel is in a different space, and the refusal
    // falls through to a fresh credential -- so a second space is a second
    // credential, and the first one is left untouched rather than quietly
    // turned into a key for both.
    const issued = (existingGrant?.actorId === actorId && existingGrantToken
      ? channelMemberSessions.grantChannel(existingGrantToken, outcome.conversationId, {
          spaceSlug: redeemSpace.slug,
        })
      : null)
      ?? channelMemberSessions.mint({
        actorId,
        displayName: body.displayName?.trim() || actorId,
        channelId: outcome.conversationId,
        spaceSlug: redeemSpace.slug,
      });
    c.header(
      "set-cookie",
      channelMemberCookie(
        issued.token,
        isForwardedHttpsScoutRequest(c.req.raw),
        c.req.header("host"),
      ),
    );
    await addActorToChatSpaceRoster(redeemSpace.slug, actorId);

    return c.json({
      ok: true,
      space: { slug: redeemSpace.slug, title: redeemSpace.title },
      // `alreadyRedeemed` is the idempotency signal: a retry from the same
      // session returns the original redemption rather than a second one.
      alreadyRedeemed: outcome.alreadyRedeemed,
      conversationId: outcome.conversationId,
      channelTitle: outcome.channelTitle,
      redemption: outcome.redemption,
      invite: outcome.invite,
      participantIds: outcome.participantIds,
      // Stated rather than implied: this path always attaches a session, and
      // the field is what a client checks instead of assuming it did.
      attached: Boolean(outcome.redemption.sessionId),
      // Named so a non-browser client knows which cookie to keep. The value is
      // in the Set-Cookie header only; it is never echoed in the body.
      credential: { cookie: CHANNEL_MEMBER_COOKIE, expiresAt: issued.grant.expiresAt },
    });
  });

  /**
   * Admit a teammate. This is the human half of the invitation: they arrive
   * with a link and a name, and leave with a member credential scoped to the
   * one channel they joined -- never the operator's token.
   */
  app.post("/api/invites/:token/join", async (c) => {
    const token = c.req.param("token");
    if (!CHANNEL_INVITE_TOKEN_PATTERN.test(token)) {
      return c.json({ error: "This invitation link is not valid." }, 404);
    }
    const parsed = await readJsonBody(c, channelInviteJoinBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const displayName = body.displayName?.trim();
    if (!displayName) {
      return c.json({ error: "A name is required to join." }, 400);
    }

    // A returning member keeps the actor they already have, so re-joining does
    // not mint a second person for the same human.
    const existing = readChannelMemberGrant(c.req.raw);
    const outcome = await joinChannelInviteAsPerson({
      token,
      displayName,
      existingActorId: existing?.actorId ?? null,
      createId: () => randomUUID(),
    });
    if (!outcome.ok) {
      return c.json(
        { error: outcome.error, ...(outcome.reason ? { reason: outcome.reason } : {}) },
        outcome.status,
      );
    }

    const joinSpace = await chatSpaceForChannelId(outcome.conversationId);
    const cookie = cookieValue(c.req.raw, CHANNEL_MEMBER_COOKIE);
    // Widening a grant re-mints the token, so either branch hands back a cookie
    // and the browser always leaves this route holding the current one. Across
    // a space boundary the widening is refused and the fresh mint is what the
    // browser leaves with -- the previous space's credential is not revoked and
    // not extended.
    const issued = (cookie
      ? channelMemberSessions.grantChannel(cookie, outcome.conversationId, {
          spaceSlug: joinSpace.slug,
        })
      : null)
      ?? channelMemberSessions.mint({
        actorId: outcome.actorId,
        displayName: outcome.displayName,
        channelId: outcome.conversationId,
        spaceSlug: joinSpace.slug,
      });
    c.header(
      "set-cookie",
      channelMemberCookie(
        issued.token,
        isForwardedHttpsScoutRequest(c.req.raw),
        c.req.header("host"),
      ),
    );
    await addActorToChatSpaceRoster(joinSpace.slug, outcome.actorId);

    return c.json({
      ok: true,
      actorId: outcome.actorId,
      displayName: outcome.displayName,
      conversationId: outcome.conversationId,
      channelTitle: outcome.channelTitle,
      alreadyMember: outcome.alreadyMember,
      space: { slug: joinSpace.slug, title: joinSpace.title },
    });
  });

  /**
   * Accept an invitation as a lightweight API participant.
   *
   * The third acceptance path, and the one with no identity behind it. `/join`
   * admits a person who types a name; `/redeem` attaches an agent's running
   * session; this admits an HTTP client that has neither and does not intend to
   * install anything to get one.
   *
   * What separates it from the other two is that the *server* decides who
   * joined. The invitation is authority to enter a room, never authority to be
   * somebody already in it, so a body naming an `actorId` or a `sessionId` is
   * refused rather than honoured -- and refused loudly, because a caller whose
   * identity field was quietly dropped would go on believing it took effect.
   *
   * Nothing here attaches a session, and nothing here pretends to. The member
   * that comes out is readable and can post; it cannot be invoked, and
   * `/asks` says so by name rather than queueing work against it.
   */
  app.post("/api/invites/:token/participate", async (c) => {
    const token = c.req.param("token");
    if (!CHANNEL_INVITE_TOKEN_PATTERN.test(token)) {
      return c.json({ error: "This invitation link is not valid." }, 404);
    }
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const request = readApiParticipantJoinRequest(raw);
    if (!request.ok) {
      return c.json({ error: request.error, reason: request.reason }, request.status);
    }

    // Derived, never accepted. `participantKey` is an idempotency key mixed
    // into an HMAC the caller cannot compute, so replaying the join with the
    // same key returns the same participant instead of spending another use of
    // the invitation -- and a key learned from one invitation cannot be aimed
    // at another, because the token digest is mixed in too.
    const actorId = apiParticipantActorId({
      tokenHash: hashChannelInviteToken(token),
      participantKey: request.participantKey,
      signingSecret: options.authToken ?? null,
    });
    const displayName = apiParticipantDisplayName(request.displayName, actorId);

    const outcome = await joinChannelInviteAsApiParticipant({
      token,
      actorId,
      displayName,
      createId: () => `crdm-${randomUUID()}`,
      buildActor: apiParticipantActor,
    });
    if (!outcome.ok) {
      return c.json(
        { error: outcome.error, ...(outcome.reason ? { reason: outcome.reason } : {}) },
        outcome.status,
      );
    }

    // The space the channel is in, read from the channel. Nothing the caller
    // sent has any say in it.
    const participateSpace = await chatSpaceForChannelId(outcome.conversationId);

    // A fresh grant every time, never a widening of a cookie already in the
    // jar. This route can be called by anything, and widening whatever
    // credential happened to arrive would hand this channel to whoever that
    // credential names instead of to the participant that just joined.
    const issued = channelMemberSessions.mint({
      actorId: outcome.actorId,
      displayName: outcome.displayName,
      channelId: outcome.conversationId,
      // Bound to one space as well as one channel. A second space means a
      // second credential; this one can never be widened into it.
      spaceSlug: participateSpace.slug,
      // Signed into the credential, so it narrows what the credential can do
      // rather than merely describing it: read, post and reply in this one
      // channel, which is exactly what `api.md` promised the joiner. Minting
      // further invitations and dispatching tracked work are not in that
      // promise, and a marker the client cannot strip is what keeps them out.
      participation: "api",
    });
    // The cookie is set as a convenience for a client that keeps a jar. The
    // bearer token below is the credential this mode is built around, and
    // unlike the browser paths it is returned in the body -- there is no
    // HttpOnly benefit to a caller that is not a browser, and a credential the
    // client cannot read is a credential it cannot send.
    c.header(
      "set-cookie",
      channelMemberCookie(
        issued.token,
        isForwardedHttpsScoutRequest(c.req.raw),
        c.req.header("host"),
      ),
    );
    await addActorToChatSpaceRoster(participateSpace.slug, outcome.actorId);

    return c.json({
      ok: true,
      participation: "api",
      actorId: outcome.actorId,
      displayName: outcome.displayName,
      conversationId: outcome.conversationId,
      channelTitle: outcome.channelTitle,
      alreadyMember: outcome.alreadyMember,
      // Stated, not implied. This mode never attaches a session, so the field
      // that means "something can receive here" is constant and false.
      attached: false,
      credential: {
        scheme: "Bearer",
        header: "authorization",
        token: issued.token,
        expiresAt: issued.grant.expiresAt,
        cookie: CHANNEL_MEMBER_COOKIE,
      },
      space: { slug: participateSpace.slug, title: participateSpace.title },
      poll: {
        // The space rides in the URL. A client handed a bare path would have
        // its request resolved against the default space and get a 404 for a
        // room it is legitimately in -- so the URL we hand out is the one that
        // works, rather than one the reader has to know to repair.
        url: chatChannelPath(outcome.conversationId, "poll", participateSpace.slug),
        intervalMs: CHANNEL_POLL_INTERVAL_CAUGHT_UP_MS,
      },
    });
  });

  /**
   * Who the member cookie says you are, and which channels you are still in.
   *
   * Identity is read from the credential; membership is re-read from the
   * broker on every call. The grant outlives removal by design, so echoing its
   * channel ids back would tell a removed teammate to open a room that will
   * turn them away -- and the invitation page would loop them between the two.
   */
  app.get("/api/member/me", async (c) => {
    const grant = readChannelMemberGrant(c.req.raw);
    if (!grant) return c.json({ member: null });
    const fresh = await loadScoutBrokerContext(undefined, {
      scope: "conversations",
      signal: AbortSignal.timeout(CHANNEL_ROSTER_READ_TIMEOUT_MS),
    }).catch(() => null);
    const channelIds = currentChannelMemberships({
      grant,
      conversations: (fresh?.snapshot.conversations as
        | Record<string, ConversationDefinition | undefined>
        | undefined) ?? null,
    });
    // Unverifiable is not the same as "in nothing", and the surface already
    // treats a failed identity read as simply not recognising the visitor.
    if (!channelIds) return c.json({ error: "broker unreachable" }, 502);
    return c.json({
      member: {
        actorId: grant.actorId,
        displayName: grant.displayName,
        channelIds,
      },
    });
  });

  app.get("/invite/:token/agent.md", async (c) => {
    const token = c.req.param("token");
    if (!CHANNEL_INVITE_TOKEN_PATTERN.test(token)) {
      return c.text("This invitation link is not valid.", 404);
    }
    const resolved = await resolveChannelInviteByToken(token);
    if (!resolved) return c.text("This invitation link is not valid.", 404);
    const broker = await loadScoutBrokerContext();
    const inviterActor = broker?.snapshot.actors?.[resolved.invite.createdByActorId];
    const agentSpace = await chatSpaceForChannelId(resolved.conversation.id);
    const markdown = renderChannelInviteAgentInstructions({
      channelId: resolved.conversation.id,
      // Omitted for the default space, which keeps this document byte-identical
      // for every channel that predates spaces.
      ...(agentSpace.slug === DEFAULT_CHAT_SPACE_SLUG ? {} : { space: agentSpace }),
      channelTitle: resolved.conversation.title,
      channelTopic: resolved.conversation.topic ?? null,
      inviterDisplayName:
        inviterActor?.displayName ?? resolved.invite.createdByActorId,
      inviteeDisplayName: resolved.invite.invitee?.displayName ?? null,
      invite: resolved.view,
      inviteUrl: channelInviteUrl(resolved.view.route, token),
      redeemUrl: channelInviteRedeemUrl(resolved.view.route, token),
      apiBaseUrl: resolved.view.route.baseUrl.replace(/\/$/, ""),
      brokerBaseUrl: resolved.view.route.baseUrl,
    });
    return c.body(markdown, 200, {
      "content-type": "text/markdown; charset=utf-8",
      // The document embeds the token. Keep it out of shared caches.
      "cache-control": "no-store",
    });
  });

  /**
   * The same invitation, read by something that will not be installing
   * anything.
   *
   * Kept as a separate document rather than a section of `agent.md` because
   * the two describe genuinely different memberships, and interleaving them is
   * how a reader ends up attempting the session-bound path with no session --
   * which costs them the invitation. Each document is complete on its own and
   * says plainly which one the reader wants.
   */
  app.get("/invite/:token/api.md", async (c) => {
    const token = c.req.param("token");
    if (!CHANNEL_INVITE_TOKEN_PATTERN.test(token)) {
      return c.text("This invitation link is not valid.", 404);
    }
    const resolved = await resolveChannelInviteByToken(token);
    if (!resolved) return c.text("This invitation link is not valid.", 404);
    const broker = await loadScoutBrokerContext();
    const inviterActor = broker?.snapshot.actors?.[resolved.invite.createdByActorId];
    const apiBaseUrl = resolved.view.route.baseUrl.replace(/\/$/, "");
    const apiSpace = await chatSpaceForChannelId(resolved.conversation.id);
    const markdown = renderChannelApiParticipantInstructions({
      channelId: resolved.conversation.id,
      ...(apiSpace.slug === DEFAULT_CHAT_SPACE_SLUG ? {} : { space: apiSpace }),
      channelTitle: resolved.conversation.title,
      channelTopic: resolved.conversation.topic ?? null,
      inviterDisplayName:
        inviterActor?.displayName ?? resolved.invite.createdByActorId,
      invite: resolved.view,
      apiBaseUrl,
      participateUrl:
        `${apiBaseUrl}/api/invites/${encodeURIComponent(token)}/participate`,
    });
    return c.body(markdown, 200, {
      "content-type": "text/markdown; charset=utf-8",
      // The document embeds the token. Keep it out of shared caches.
      "cache-control": "no-store",
    });
  });

  /* -- the chat surface ----------------------------------------------------- */

  /**
   * Scout Chat's own HTTP surface, shaped by docs/eng/chat-channel-invites-api.md.
   *
   * Two things are deliberately kept apart here. A post to a channel is an
   * update and invokes nobody; addressing one agent is a separate route that
   * raises a tracked request. Collapsing them would turn every remark in a busy
   * room into work for whoever happens to be in it.
   */

  /**
   * One message as the chat surface reads it.
   *
   * This is the projection the rest of the web API already serves for messages,
   * so the client has one shape to render: the broker record plus the resolved
   * author name and the reply anchor. `channelId` is the *root* channel even
   * when the record itself lives in a thread conversation, which is what lets
   * the surface show a reply under the message it answers without knowing that
   * threads are separate conversations underneath.
   */
  const chatMessageProjection = (
    message: {
      id: string;
      conversationId: string;
      actorId: string;
      actorName?: string;
      body: string;
      createdAt: number;
      class?: string;
      metadata?: Record<string, unknown> | null;
      replyToMessageId?: string | null;
      threadConversationId?: string | null;
      attachments?: MessageRecord["attachments"];
      mentions?: MessageRecord["mentions"];
      reactions?: ReturnType<typeof projectMessageReactionChips>;
    },
    channelId: string,
    replyToMessageId: string | null,
  ) => ({
    id: message.id,
    channelId,
    conversationId: message.conversationId,
    actorId: message.actorId,
    actorName: message.actorName ?? message.actorId,
    body: message.body,
    createdAt: message.createdAt,
    class: message.class ?? "agent",
    metadata: message.metadata ?? null,
    // A message posted into a thread conversation is projected as a reply to
    // that thread's anchor, so `replyToMessageId` is the single thing the
    // client threads on.
    replyToMessageId: replyToMessageId ?? message.replyToMessageId ?? null,
    threadConversationId: message.threadConversationId ?? null,
    attachments: message.attachments ?? [],
    ...(message.mentions?.length ? { mentions: message.mentions } : {}),
    ...(message.reactions ? { reactions: message.reactions } : {}),
  });

  /**
   * Merge the broker's rolling window with durable SQLite history.
   *
   * Neither source is the conversation on its own: the snapshot drops
   * whatever has rolled out of the window, while the durable copy of a row the
   * broker still holds can lag it (reactions, thread summaries). Keyed on
   * message id with the broker winning a duplicate, then re-ordered under the
   * shared (createdAt, id) order and cut to the newest `limit` rows -- the
   * same page shape either source serves alone.
   */
  const mergeChatConversationMessages = (
    brokerRows: ScoutConversationMessage[] | null,
    durableRows: WebMessage[],
    limit: number,
  ): Array<ScoutConversationMessage | WebMessage> => {
    const byId = new Map<string, ScoutConversationMessage | WebMessage>(
      durableRows.map((row) => [row.id, row]),
    );
    for (const row of brokerRows ?? []) byId.set(row.id, row);
    return [...byId.values()].sort(compareMessagesAsc).slice(-limit);
  };

  /**
   * Read one conversation's messages from the broker window and SQLite
   * together, so a warm snapshot no longer shrinks the transcript to whatever
   * the window still holds.
   */
  const loadChatConversationMessages = async (conversationId: string, limit: number, beforeMessageId?: string) => {
    const brokerContext = await loadScoutBrokerContext(undefined, {
      scope: "conversations",
      waitForInitial: false,
      initialRefreshDelayMs: 750,
    }).catch(() => null);
    const brokerMessages = await getScoutConversationMessages(
      conversationId,
      limit,
      beforeMessageId,
      brokerContext,
    );
    const durableMessages = queryRecentMessages(limit, { conversationId, beforeMessageId });
    return mergeChatConversationMessages(brokerMessages, durableMessages, limit);
  };

  /**
   * Create a channel inside a space, or return the one already there.
   *
   * The id is minted from the *spaced* natural key, which is what puts the
   * channel in the space: `home` returns the byte-identical legacy key, so a
   * channel created today and a channel created before spaces existed land on
   * the same id for the same name. Nothing is migrated because nothing moves.
   */
  const ensureChatSpaceChannel = async (input: {
    broker: ScoutBrokerContext;
    spaceSlug: string;
    title: string;
    topic?: string | null;
  }): Promise<{ conversation: ConversationDefinition; existed: boolean }> => {
    const naturalKey = spacedChannelNaturalKey(input.spaceSlug, input.title);
    const existing = (Object.values(input.broker.snapshot.conversations ?? {}) as ConversationDefinition[])
      .find((candidate) => channelNaturalKeyFromMetadata(candidate.metadata) === naturalKey);
    if (existing) return { conversation: existing, existed: true };

    const conversation: ConversationDefinition = {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: input.title,
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: input.broker.node.id,
      participantIds: [CHAT_OPERATOR_ACTOR_ID],
      ...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
      metadata: {
        [CHANNEL_NATURAL_KEY_METADATA]: naturalKey,
        // Written for the default space too. The marker is redundant there --
        // `channelSpaceSlug` derives `home` from the key anyway -- but writing
        // it makes a record self-describing rather than requiring the reader to
        // know the key grammar.
        [CHANNEL_SPACE_SLUG_METADATA]: normalizeChatSpaceSlug(input.spaceSlug)
          ?? DEFAULT_CHAT_SPACE_SLUG,
      },
    };
    await upsertScoutConversation(conversation);
    return { conversation, existed: false };
  };

  app.get("/api/chat/bootstrap", async (c) => {
    const viewer = chatViewerFor(c.req.raw);
    const grant = readChannelMemberGrant(c.req.raw);
    const space = resolveChatSpaceFor(c.req.raw);
    if (!space.ok) return c.json({ error: space.error }, space.status);
    const broker = await loadScoutBrokerContext(undefined, grant ? {
      scope: "conversations",
      signal: AbortSignal.timeout(CHANNEL_ROSTER_READ_TIMEOUT_MS),
    } : {});
    if (!broker) return c.json({ error: "broker unreachable" }, 502);
    const conversations = broker.snapshot.conversations as
      Record<string, ConversationDefinition | undefined> | undefined;
    const memberChannels = new Set(grant ? currentChannelMemberships({
      grant,
      conversations: conversations as Record<string, ConversationDefinition>,
    }) ?? [] : []);

    // Which rooms this viewer could see at all, before the space narrows it.
    // Membership decides it for a member; the operator sees the channels on
    // this node.
    const visibleChannelIds = viewer.isOperator ? null : memberChannels;

    // E4: the space narrows the *server's* answer, not just the sidebar. This
    // is the read the operator relies on today, and it is now scoped -- which
    // is exactly why the boundary is also enforced per channel in
    // `resolveChatChannel`: a list is a convenience, never a permission.
    const channels = chatSpaceChannels(conversations, space.slug)
      .filter((conversation) => viewer.isOperator || memberChannels.has(conversation.id))
      .sort((left, right) => left.title.localeCompare(right.title));

    const spaces = listChatSpaces(conversations, { visibleChannelIds })
      // A member sees the spaces their own channels put them in. They cannot
      // enumerate the rest and are not told the rest exist.
      .filter((entry) => viewer.isOperator
        || entry.slug === space.slug
        || entry.channelCount > 0);

    const questionCounts = chatQuestionAttentionCounts(Object.values(broker.snapshot.collaborationRecords ?? {}),
      broker.snapshot.conversations, new Set(channels.map(channel => channel.id)), viewer.actorId);
    return c.json({ viewer, space: space.slug, spaces, channels, questionCounts });
  });

  /**
   * The spaces this viewer can open, and creating one.
   *
   * A space is a broker conversation with `kind: "system"`, so listing them is
   * a scan of the snapshot rather than a new broker route, and creating one is
   * the conversation upsert that already exists. Nothing new is stored
   * anywhere.
   */
  app.get("/api/chat/spaces", async (c) => {
    const viewer = chatViewerFor(c.req.raw);
    const grant = readChannelMemberGrant(c.req.raw);
    const broker = await loadScoutBrokerContext(undefined, grant ? {
      scope: "conversations",
      signal: AbortSignal.timeout(CHANNEL_ROSTER_READ_TIMEOUT_MS),
    } : {});
    if (!broker) return c.json({ error: "broker unreachable" }, 502);
    const conversations = broker.snapshot.conversations as
      Record<string, ConversationDefinition | undefined> | undefined;
    if (!viewer.isOperator && grant) {
      const memberChannels = new Set(currentChannelMemberships({
        grant,
        conversations: conversations as Record<string, ConversationDefinition>,
      }) ?? []);
      const slugs = memberVisibleSpaceSlugs(conversations, memberChannels);
      return c.json({
        spaces: listChatSpaces(conversations, { visibleChannelIds: memberChannels })
          .filter((entry) => slugs.has(entry.slug)),
      });
    }
    return c.json({ spaces: listChatSpaces(conversations) });
  });

  app.post("/api/chat/spaces", async (c) => {
    // Operator-only, for the same reason channel creation is: a member
    // credential joins rooms, it does not carve out new namespaces, and it
    // must never be able to widen its own reach.
    if (readChannelMemberGrant(c.req.raw)) {
      return c.json({ error: "Only the host can create spaces." }, 403);
    }
    const parsed = await readJsonBody(c, chatSpaceCreateBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const title = body.title?.trim();
    if (!title) return c.json({ error: "title is required" }, 400);

    const broker = await loadScoutBrokerContext();
    if (!broker) return c.json({ error: "broker unreachable" }, 502);
    const conversations = broker.snapshot.conversations as
      Record<string, ConversationDefinition | undefined> | undefined;

    const outcome = await createChatSpace({
      title,
      slug: body.slug ?? null,
      authorityNodeId: broker.node.id,
      participantIds: [CHAT_OPERATOR_ACTOR_ID],
      conversations,
      upsert: (conversation) => upsertScoutConversation(conversation),
    });
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);

    // A space with no room in it is a dead end the operator has to notice and
    // fix, so the first channel is created with it rather than after it. The
    // name is theirs to choose; `general` is only the fallback.
    const channelTitle = body.channel?.trim() || "general";
    const channel = await ensureChatSpaceChannel({
      broker,
      spaceSlug: outcome.space.slug,
      title: channelTitle,
      topic: body.channelTopic?.trim() || null,
    });

    invalidateScoutBrokerContextCache(broker.baseUrl);
    return c.json({
      space: { ...outcome.space, channelCount: outcome.space.channelCount || 1 },
      existed: outcome.existed,
      channel: channel.conversation,
      channelExisted: channel.existed,
    });
  });

  app.post("/api/chat/channels", async (c) => {
    // Operator-only for this slice. A member credential joins channels; it does
    // not create them, and it must not be able to widen its own reach.
    if (readChannelMemberGrant(c.req.raw)) {
      return c.json({ error: "Only the host can create channels." }, 403);
    }
    const parsed = await readJsonBody(c, chatChannelCreateBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const title = body.title?.trim();
    if (!title) return c.json({ error: "title is required" }, 400);

    // E5: a channel is always created *into* a space. The body may name it so
    // a client can create without a URL selector; otherwise the request's own
    // selector decides, and an absent selector is the default space -- which is
    // where `POST /api/chat/channels` put every channel before this existed.
    const space = resolveChatSpaceSelection({
      requested: body.space ?? new URL(c.req.raw.url).searchParams.get(CHAT_SPACE_QUERY_KEY)
        ?? c.req.raw.headers.get(CHAT_SPACE_HEADER),
    });
    if (!space.ok) return c.json({ error: space.error }, space.status);

    const broker = await loadScoutBrokerContext();
    if (!broker) return c.json({ error: "broker unreachable" }, 502);

    const { conversation, existed } = await ensureChatSpaceChannel({
      broker,
      spaceSlug: space.slug,
      title,
      topic: body.topic ?? null,
    });
    if (!existed) invalidateScoutBrokerContextCache(broker.baseUrl);
    return c.json({ conversation, existed, space: space.slug });
  });

  /**
   * The channel feed: its messages, replies included, plus the tracked requests
   * raised in it.
   *
   * Replies live in thread conversations underneath the channel. They are
   * normalized here onto the thread's anchor message, so the client renders one
   * flat feed of roots with replies hanging off `replyToMessageId` and never has
   * to know that a thread is a conversation of its own.
   */
  const channelEventStreams = new ChannelEventStreams();
  app.get("/api/channels/:id/events", async (c) => {
    const channelId = c.req.param("id");
    const initial = await resolveChatChannel(c.req.raw, channelId);
    if (!initial.ok) return c.json({ error: initial.error }, initial.status);
    const originalMember = readChannelMemberGrant(c.req.raw);
    return channelEventStreams.open(c.req.raw, {
      channelId,
      readScope: async () => {
        const empty = { allowed: false, conversationIds: new Set<string>() };
        const grant = readChannelMemberGrant(c.req.raw);
        // An expired member cookie must never be reclassified as an operator.
        if (originalMember && (!grant || grant.actorId !== originalMember.actorId)) return empty;
        const fresh = await loadScoutBrokerContext(undefined, {
          scope: "conversations",
          signal: AbortSignal.timeout(CHANNEL_ROSTER_READ_TIMEOUT_MS),
        }).catch(() => null);
        const conversation = fresh?.snapshot.conversations?.[channelId] as ConversationDefinition | undefined;
        if (!fresh || !conversation || conversation.kind !== "channel") return empty;
        if (grant && channelMemberRosterDecision({ grant, brokerReachable: true, conversation })) return empty;
        const threads = (Object.values(fresh.snapshot.conversations) as ConversationDefinition[])
          .filter(item => item.kind === "thread" && item.parentConversationId === channelId);
        return { allowed: true, conversationIds: new Set([channelId, ...threads.map(item => item.id)]) };
      },
    });
  });

  /**
   * The channel as one transcript: its own messages plus every reply living in
   * a thread under it, in one ascending order, with the tracked requests the
   * broker actually has flights for.
   *
   * Shared by the feed and the poll so the two cannot drift. A poller that saw
   * a different set of messages -- or the same messages in a different order --
   * than the feed would be handed a cursor from one and a page from the other.
   */
  const loadChatChannelProjection = async (
    broker: ScoutBrokerContext,
    channelId: string,
    limit: number,
    viewerActorId?: string,
  ) => {
    const threads = (Object.values(broker.snapshot.conversations ?? {}) as ConversationDefinition[])
      .filter((candidate) => candidate.kind === "thread"
        && candidate.parentConversationId === channelId);

    const rootMessages = (await loadChatConversationMessages(channelId, limit))
      .map((message) => chatMessageProjection(message, channelId, null));
    const threadReads = await Promise.all(threads.map(async (thread) => {
      const anchorMessageId = thread.messageId ?? null;
      const messages = await loadChatConversationMessages(thread.id, limit);
      return messages.map((message) => chatMessageProjection(
        message,
        channelId,
        message.replyToMessageId ?? anchorMessageId,
      ));
    }));

    // The earliest position this projection can be *trusted* from.
    //
    // Every conversation is read as its own newest slice, so a read that came
    // back full has older rows behind it that the merge does not contain. A
    // thread whose messages predate the root's slice therefore drags the merged
    // array's oldest row back past where the root read stopped -- and the
    // stretch in between is a hole, not history. The anchor is the newest of
    // the full reads' oldest rows: at or after it, the merge is a genuine
    // suffix with nothing missing. A read that did not fill bounds nothing,
    // because it is everything this host can see for that conversation.
    let retainedFrom: { createdAt: number; id: string } | null = null;
    for (const rows of [rootMessages, ...threadReads]) {
      if (rows.length < limit) continue;
      const oldest = rows.reduce((left, right) =>
        compareMessagesAsc(left, right) <= 0 ? left : right);
      if (!retainedFrom || compareMessagesAsc(oldest, retainedFrom) > 0) {
        retainedFrom = { createdAt: oldest.createdAt, id: oldest.id };
      }
    }

    const reactionRows = await listScoutMessageReactions(channelId);
    const reactionsByMessage = new Map<string, NonNullable<typeof reactionRows>>();
    if (reactionRows && viewerActorId) {
      for (const row of reactionRows) {
        const list = reactionsByMessage.get(row.messageId) ?? [];
        list.push(row);
        reactionsByMessage.set(row.messageId, list);
      }
    }

    const attachReactions = <T extends { id: string }>(row: T): T => {
      if (!viewerActorId || reactionRows === null) return row;
      return {
        ...row,
        reactions: projectMessageReactionChips(reactionsByMessage.get(row.id) ?? [], viewerActorId),
      };
    };

    const messages = [...rootMessages, ...threadReads.flat()]
      .map((row) => attachReactions(row))
      .sort((left, right) => compareMessagesAsc(left, right));

    // Tracked requests come from flight records only. A request the broker has
    // no flight for is not listed: inventing one here is exactly the "looks
    // dispatched" failure this feature exists to avoid.
    const threadIds = new Set(threads.map((thread) => thread.id));
    const requests = queryBrokerFlightsForWeb(broker, {})
      .filter((flight) => flight.conversationId === channelId
        || (flight.conversationId ? threadIds.has(flight.conversationId) : false))
      .map((flight) => {
        const record = broker.snapshot.flights?.[flight.id] ?? queryFlightRecordById(flight.id);
        const requesterActorId = record?.requesterId;
        const requesterName = requesterActorId
          ? broker.snapshot.actors?.[requesterActorId]?.displayName ?? requesterActorId : undefined;
        const output = record?.output?.trim();
        const responsibility = chatRequestResponsibility(
          flight.collaborationRecordId ? broker.snapshot.collaborationRecords?.[flight.collaborationRecordId] : undefined,
          channelId, threadIds, id => broker.snapshot.actors?.[id]?.displayName ?? id, viewerActorId,
        );
        return {
          messageId: flight.messageId ?? null,
          flightId: flight.id,
          state: flight.state,
          targetActorId: flight.agentId,
          ...(flight.agentName ? { targetName: flight.agentName } : {}),
          ...(requesterActorId ? { requesterActorId, requesterName } : {}),
          ...(flight.summary ? { summary: flight.summary } : {}),
          ...(responsibility ? { responsibility } : {}),
          ...(output ? {
            output: output.slice(0, 4000),
            outputTruncated: output.length > 4000,
            outputUrl: chatChannelPath(channelId, `asks/${encodeURIComponent(flight.id)}/output`,
              channelSpaceSlug(broker.snapshot.conversations[channelId])),
          } : {}),
          ...(record?.error ? { error: record.error } : {}),
          ...(flight.startedAt != null ? { startedAt: flight.startedAt } : {}),
          ...(flight.completedAt != null ? { completedAt: flight.completedAt } : {}),
        };
      });

    // A root read that came back short is the whole channel: its first
    // message is in hand, so the surface may draw where the channel begins.
    const reachesStart = rootMessages.length < limit;
    return { messages, requests, retainedFrom, reactionRows, reachesStart };
  };

  const inboxCoordinator = new ChannelInboxCoordinator<Awaited<ReturnType<typeof loadChatChannelProjection>>>();

  /**
   * How wide a poll reads, fixed rather than derived from the caller's page
   * size.
   *
   * The window is what decides whether a cursor is stale, so deriving it from
   * `limit` would make staleness a property of the page size the caller
   * happened to ask for: a client that shrank its page would be told history
   * moved past it when nothing had. Four maximum pages is wide enough that a
   * poller keeping up never meets the boundary.
   */
  const CHANNEL_POLL_READ_WIDTH = clampMessagePageLimit(MAX_CHANNEL_POLL_LIMIT * 4);

  app.get("/api/channels/:id/feed", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

    const limit = clampMessagePageLimit(
      parseOptionalPositiveInt(c.req.query("limit"), DEFAULT_MESSAGE_PAGE_LIMIT),
      DEFAULT_MESSAGE_PAGE_LIMIT,
    );
    const { messages, requests, reachesStart } = await loadChatChannelProjection(
      resolved.broker,
      channelId,
      limit,
      resolved.viewer.actorId,
    );
    return c.json({ channelId, messages, requests, reachesStart });
  });

  const channelReadDependencies = {
    loadMessages: loadChatConversationMessages,
    loadCursors: (conversationId: string) => loadScoutReadCursors({ conversationId }),
    markRead: (conversationId: string, actorId: string, messageId: string) => markScoutConversationRead({
      conversationId, actorId, lastReadMessageId: messageId, metadata: { source: "scout-chat" },
    }),
  };

  app.get("/api/channels/:id/search", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const query = c.req.query("q")?.trim() ?? "";
    if (!query || query.length > 200) return c.json({ error: "Enter between 1 and 200 characters to search." }, 400);
    try {
      const beforeText = c.req.query("cursor");
      const before = parseMessageHistoryCursor(beforeText);
      if (before?.kind === "legacy") return c.json({ error: "Invalid search cursor." }, 400);
      const threads = (Object.values(resolved.broker.snapshot.conversations ?? {}) as ConversationDefinition[])
        .filter(item => item.kind === "thread" && item.parentConversationId === channelId);
      const scopes = [channelId, ...threads.map(item => item.id)];
      const fold = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
      const matches = Object.values(resolved.broker.snapshot.messages ?? {})
        .filter(message => !isTransientBrokerWaitStatusMessage(message))
        .map(message => ({ ...message, createdAt: normalizeTimestampMs(message.createdAt) ?? 0 }))
        .filter(message => scopes.includes(message.conversationId)
        && fold(message.body).includes(fold(query)) && (!before || compareMessagesAsc(message, before) < 0));
      const durable = queryRecentMessages(51, { conversationIds: scopes, search: query, beforeMessageId: beforeText });
      const merged = new Map(durable.map(message => [message.id, chatMessageProjection(message, channelId,
        threads.find(thread => thread.id === message.conversationId)?.messageId ?? null)]));
      for (const message of matches) merged.set(message.id, chatMessageProjection(message, channelId,
        threads.find(thread => thread.id === message.conversationId)?.messageId ?? null));
      const sorted = [...merged.values()].sort((a, b) => compareMessagesAsc(b, a));
      const messages = sorted.slice(0, 50);
      return c.json({ messages, nextCursor: sorted.length > 50 ? encodeMessageHistoryCursor(messages.at(-1)!) : null });
    } catch (error) {
      return c.json({ error: error instanceof MessageCursorError ? "Invalid search cursor." : "Search could not be completed. Try again." }, error instanceof MessageCursorError ? 400 : 502);
    }
  });

  app.get("/api/channels/:id/messages/:messageId/context", async (c) => {
    const channelId = c.req.param("id");
    const messageId = c.req.param("messageId");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    try {
      const conversations = Object.values(resolved.broker.snapshot.conversations ?? {}) as ConversationDefinition[];
      const findMessage = (id: string) => resolved.broker.snapshot.messages?.[id]
        ?? queryRecentMessages(1, { messageId: id })[0];
      const target = findMessage(messageId);
      const thread = target && conversations.find(item => item.id === target.conversationId
        && item.kind === "thread" && item.parentConversationId === channelId);
      if (!target || (target.conversationId !== channelId && !thread)) return c.json({ error: "Message is not available in this channel." }, 404);
      const rootId = thread?.messageId ?? target.replyToMessageId ?? target.id;
      const root = findMessage(rootId);
      if (!root || root.conversationId !== channelId) return c.json({ error: "Thread root is no longer available." }, 404);
      const threadConversation = conversations.find(item => item.kind === "thread" && item.parentConversationId === channelId && item.messageId === root.id);
      const cursorText = c.req.query("cursor");
      if (parseMessageHistoryCursor(cursorText)?.kind === "legacy") return c.json({ error: "Invalid reply cursor." }, 400);
      const replyWindow = threadConversation ? await loadChatConversationMessages(threadConversation.id, 101, cursorText) : [];
      const replies = replyWindow.slice(-100);
      const messages = new Map([[root.id, chatMessageProjection(root, channelId, null)]]);
      for (const reply of replies) messages.set(reply.id, chatMessageProjection(reply, channelId, root.id));
      if (target.id !== root.id) messages.set(target.id, chatMessageProjection(target, channelId, root.id));
      return c.json({ rootMessageId: root.id, messages: [...messages.values()].sort(compareMessagesAsc), hasMore: replyWindow.length > 100, nextCursor: replyWindow.length > 100 ? encodeMessageHistoryCursor(replies[0]!) : null });
    } catch (error) {
      return c.json({ error: error instanceof MessageCursorError ? "Invalid reply cursor." : "Message context could not be loaded. Try again." }, error instanceof MessageCursorError ? 400 : 502);
    }
  });

  app.post("/api/channels/:id/presence", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (readChannelMemberGrant(c.req.raw)?.participation === "api") return c.json({ error: "Human Chat activity requires a teammate session." }, 403);
    const body = parseChatPresenceBeat(await c.req.json().catch(() => null));
    if (!body) return c.json({ error: "Invalid Chat activity signal." }, 400);
    const { broker, viewer, conversation } = resolved;
    const scope = JSON.stringify([broker.baseUrl, resolved.spaceSlug, channelId]);
    if (!chatPresence.update(scope, viewer.actorId, viewer.displayName, viewer.isOperator, body)) return c.json({ error: "Chat activity is temporarily unavailable." }, 503);
    c.header("Cache-Control", "no-store");
    return c.json({ people: chatPresence.read(scope, new Set(conversation.participantIds)) });
  });

  app.get("/api/channels/:id/questions", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { broker } = resolved;
    const threadIds = new Set(Object.values(broker.snapshot.conversations).filter(item => item.kind === "thread" && item.parentConversationId === channelId).map(item => item.id));
    try {
      const page = chatQuestionPage(Object.values(broker.snapshot.collaborationRecords ?? {}), channelId, threadIds, c.req.query("cursor"));
      return c.json({ questions: page.records.map(record => chatRequestResponsibility(record, channelId, threadIds,
        id => broker.snapshot.actors?.[id]?.displayName ?? id, resolved.viewer.actorId)), nextCursor: page.nextCursor });
    } catch { return c.json({ error: "Invalid question cursor." }, 400); }
  });

  app.get("/api/channels/:id/questions/history", async (c) => {
    const channelId = c.req.param("id");
    const initial = await resolveChatChannel(c.req.raw, channelId);
    if (!initial.ok) return c.json({ error: initial.error }, initial.status);
    let after: ReturnType<typeof decodeChatQuestionCursor>;
    try { after = decodeChatQuestionCursor(c.req.query("cursor"), channelId, true); }
    catch { return c.json({ error: "Invalid question history cursor." }, 400); }
    let records: Awaited<ReturnType<typeof readScoutChatQuestionHistory>>;
    try { records = await readScoutChatQuestionHistory(initial.broker.baseUrl, channelId, after); }
    catch { return c.json({ error: "Question history could not be read. Try again." }, 503); }
    invalidateScoutBrokerContextCache(initial.broker.baseUrl);
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { broker } = resolved;
    const threadIds = new Set(Object.values(broker.snapshot.conversations).filter(item => item.kind === "thread" && item.parentConversationId === channelId).map(item => item.id));
    const page = chatQuestionPage(records, channelId, threadIds, c.req.query("cursor"), 50, true);
    c.header("Cache-Control", "no-store");
    return c.json({ questions: page.records.map(record => chatRequestResponsibility(record, channelId, threadIds,
      id => broker.snapshot.actors?.[id]?.displayName ?? id, resolved.viewer.actorId)), nextCursor: page.nextCursor });
  });

  app.post("/api/channels/:id/questions/:questionId/respond", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const change = await c.req.json().catch(() => null);
    if (!change || typeof change !== "object" || Array.isArray(change)
      || Object.keys(change).some(key => !["action", "expectedUpdatedAt", "answer"].includes(key))) return c.json({ error: "Invalid question response." }, 400);
    try {
      const result = await respondScoutChatQuestion({ channelId, questionId: c.req.param("questionId"),
        actorId: resolved.viewer.actorId, isOperator: resolved.viewer.isOperator, change, baseUrl: resolved.broker.baseUrl });
      const threadIds = new Set(Object.values(resolved.broker.snapshot.conversations).filter(item => item.kind === "thread" && item.parentConversationId === channelId).map(item => item.id));
      const responsibility = chatRequestResponsibility(result.record, channelId, threadIds,
        id => resolved.broker.snapshot.actors?.[id]?.displayName ?? id, resolved.viewer.actorId);
      if (!responsibility) return c.json({ error: "Question is not available in this channel." }, 404);
      return c.json({ ok: true, responsibility });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 502;
      return c.json({ error: [400, 403, 404, 409].includes(status) && error instanceof Error ? error.message : "The question response could not be confirmed. Refresh before trying again." },
        ([400, 403, 404, 409].includes(status) ? status : 502) as 400 | 403 | 404 | 409 | 502);
    }
  });

  app.post("/api/channels/:id/corrections", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const body = await c.req.json().catch(() => null);
    let change;
    try {
      if (!body || Object.keys(body).length !== 2 || typeof body.messageId !== "string" || !body.messageId) throw new Error();
      change = parseChatMessageChange(body.change);
    } catch { return c.json({ error: "Invalid message correction." }, 400); }
    try {
      const result = await correctScoutChatMessage({ conversationId: channelId, messageId: body.messageId,
        actorId: resolved.viewer.actorId, canModerate: resolved.viewer.isOperator, change });
      return c.json({ ok: true, message: chatMessageProjection(result.message, channelId, result.message.replyToMessageId ?? null) });
    } catch (error) {
      // Authorization and revision conflicts are evaluated at the canonical writer.
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 502;
      return c.json({ error: status === 409 ? "This message changed. Reload it before trying again." : status === 403 ? "You cannot change this message." : "Message could not be changed. Try again." }, ([400, 403, 404, 409].includes(status) ? status : 502) as 400 | 403 | 404 | 409 | 502);
    }
  });

  app.post("/api/channels/:id/pins", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    let change;
    try { change = parseChatPinChange(await c.req.json()); }
    catch { return c.json({ error: "Invalid channel pin change." }, 400); }
    try {
      if (change.pinned) {
        const conversationIds = new Set([channelId, ...Object.values(resolved.broker.snapshot.conversations ?? {})
          .filter(item => item.kind === "thread" && item.parentConversationId === channelId).map(item => item.id)]);
        const message = resolved.broker.snapshot.messages?.[change.messageId]
          ?? queryRecentMessages(1, { conversationIds: [...conversationIds], messageId: change.messageId })[0];
        if (!message?.conversationId || !conversationIds.has(message.conversationId)) return c.json({ error: "Message is not available in this channel." }, 400);
      }
      const result = await updateScoutChannelPins({ conversationId: channelId, actorId: resolved.viewer.actorId, change });
      return c.json({ ok: true, pins: readChatPins(result.conversation.metadata?.chatPins) });
    } catch { return c.json({ error: "Channel pins could not be saved. Try again." }, 502); }
  });

  app.post("/api/channels/:id/attention", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const change: unknown = await c.req.json().catch(() => null);
    try { applyChatAttentionPreferenceChange(undefined, change); }
    catch { return c.json({ error: "Invalid attention preference change." }, 400); }
    const follow = change as { threadId?: string; following?: boolean };
    try {
      if (follow.following) {
        const root = resolved.broker.snapshot.messages?.[follow.threadId!]
          ?? queryRecentMessages(1, { conversationId: channelId, messageId: follow.threadId })[0];
        if (!root || root.conversationId !== channelId || root.replyToMessageId) {
          return c.json({ error: "Thread root is not available in this channel." }, 400);
        }
      }
      const save = change as { messageId?: string; saved?: boolean };
      if (save.saved) {
        const conversationIds = new Set([channelId, ...Object.values(resolved.broker.snapshot.conversations ?? {})
          .filter(item => item.kind === "thread" && item.parentConversationId === channelId).map(item => item.id)]);
        const message = resolved.broker.snapshot.messages?.[save.messageId!]
          ?? queryRecentMessages(1, { conversationIds: [...conversationIds], messageId: save.messageId })[0];
        if (!message || !message.conversationId || !conversationIds.has(message.conversationId)) {
          return c.json({ error: "Message is not available in this channel." }, 400);
        }
      }
      return c.json(await updateScoutChatPreferences({ conversationId: channelId, actorId: resolved.viewer.actorId, change }));
    } catch {
      return c.json({ error: "Attention preferences could not be saved. Try again shortly." }, 502);
    }
  });

  app.get("/api/channels/:id/read-state", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    try {
      return c.json(await readChatChannelState({
        channelId,
        actorId: resolved.viewer.actorId,
        conversations: Object.values(resolved.broker.snapshot.conversations ?? {}),
        dependencies: channelReadDependencies,
      }));
    } catch {
      return c.json({ error: "Read state could not be refreshed. Try again shortly." }, 502);
    }
  });

  app.post("/api/channels/:id/read-state", async (c) => {
    const channelId = c.req.param("id");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const body = await c.req.json().catch(() => null) as { messageId?: unknown; rootMessageId?: unknown } | null;
    if (!body || typeof body.messageId !== "string" || !body.messageId.trim()
      || (body.rootMessageId != null && typeof body.rootMessageId !== "string")) {
      return c.json({ error: "A message read position is required." }, 400);
    }
    try {
      await markChatChannelRead({
        channelId,
        actorId: resolved.viewer.actorId,
        messageId: body.messageId,
        rootMessageId: typeof body.rootMessageId === "string" ? body.rootMessageId : null,
        conversations: Object.values(resolved.broker.snapshot.conversations ?? {}),
        dependencies: channelReadDependencies,
      });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof ChatReadPositionError ? error.message : "Read position could not be saved. Try again shortly." },
        error instanceof ChatReadPositionError ? 400 : 502);
    }
  });

  /**
   * Bounded polling for a member reading this channel over HTTP.
   *
   * This is the read half of lightweight API participation, and it is only a
   * read. Nothing here wakes an agent, dispatches work, or acknowledges any:
   * the page is what the host can currently see, and `requests` rides along as
   * the *current state* of tracked flights rather than as a stream of events
   * about them.
   *
   * The page is fetched wider than it is served so the cursor can be checked
   * against real history rather than against the page we were about to return.
   * If the visible window no longer reaches back to the caller's cursor,
   * `channelPollPage` refuses with `stale_cursor` instead of handing back the
   * tail with the middle quietly missing.
   */
  app.get("/api/channels/:id/:pollResource{poll|inbox}", async (c) => {
    const inbox = c.req.param("pollResource") === "inbox";
    let wait = 0;
    try { if (inbox) wait = inboxWaitSeconds(c.req.query("wait")); }
    catch { return c.json({ error: "wait must be between 0 and 25 seconds" }, 400); }
    const channelId = c.req.param("id");
    const originalMember = readChannelMemberGrant(c.req.raw);
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

    if (readChannelMemberGrant(c.req.raw)) {
      chatPresence.update(JSON.stringify([resolved.broker.baseUrl, resolved.spaceSlug, channelId]),
        resolved.viewer.actorId, resolved.viewer.displayName, resolved.viewer.isOperator,
        { clientId: "participant-poll", sequence: Date.now(), active: true, typing: false });
    }
    const originalActorId = originalMember?.actorId ?? resolved.viewer.actorId;
    const assertOriginalIdentity = () => {
      const grant = readChannelMemberGrant(c.req.raw);
      if (originalMember ? (!grant || grant.actorId !== originalActorId) : Boolean(grant)) throw new Error("Inbox identity is no longer valid");
    };
    const conversationIds = new Set<string>([channelId]);
    const lease = inbox ? inboxCoordinator.acquire(JSON.stringify([resolved.broker.baseUrl, channelId]), {
      check: async () => {
        const broker = await loadScoutBrokerContext();
        if (!broker || broker.baseUrl !== resolved.broker.baseUrl) throw new Error("Broker unavailable");
        conversationIds.clear(); conversationIds.add(channelId);
        for (const conversation of Object.values(broker.snapshot.conversations ?? {})) {
          if (conversation.kind === "thread" && conversation.parentConversationId === channelId) conversationIds.add(conversation.id);
        }
        // One latest-row query per conversation, shared by all channel waiters.
        const positions = await Promise.all([...conversationIds].sort().map(async id => {
          const latest = (await loadChatConversationMessages(id, 1))[0];
          return [id, latest];
        }));
        // data_version changes on every commit by another connection (the
        // broker), covering durable messages, edits, deletions and reactions.
        // Flights and records are read from the cached broker snapshot, which
        // can lag a commit, so they keep a compact digest of their own.
        const snapshotState = [
          queryBrokerFlightsForWeb(broker, {}).filter(flight => flight.conversationId && conversationIds.has(flight.conversationId))
            .map(flight => { const record = broker.snapshot.flights?.[flight.id]; return [flight.id, flight.state, flight.completedAt ?? null, record?.output?.length ?? 0, record?.error ?? null]; }),
          Object.values(broker.snapshot.collaborationRecords ?? {}).filter(record => record.conversationId && conversationIds.has(record.conversationId))
            .map(record => [record.id, record.state, record.updatedAt]),
        ];
        const revision = inboxDatabaseRevision();
        if (revision !== null) return JSON.stringify([positions, revision, snapshotState]);
        return JSON.stringify([positions, snapshotState,
          Object.values(broker.snapshot.messages ?? {}).filter(message => conversationIds.has(message.conversationId)),
          await listScoutMessageReactions(channelId),
        ]);
      },
      load: async () => {
        const broker = await loadScoutBrokerContext();
        if (!broker || broker.baseUrl !== resolved.broker.baseUrl) throw new Error("Broker unavailable");
        return loadChatChannelProjection(broker, channelId, CHANNEL_POLL_READ_WIDTH);
      },
      subscribe: changed => subscribeInboxChanges(conversationIds, changed),
    }) : undefined;
    let observedVersion = lease?.changes.version ?? 0;
    const readPage = async (cursor: string | null) => {
      assertOriginalIdentity();
      // Refresh membership and snapshot on every held read: revocation still applies.
      const current = await resolveChatChannel(c.req.raw, channelId);
      assertOriginalIdentity();
      if (!current.ok || current.viewer.actorId !== originalActorId) throw new Error("Channel access no longer available");
      const limit = clampChannelPollLimit(
        parseOptionalPositiveInt(c.req.query("limit"), DEFAULT_CHANNEL_POLL_LIMIT),
      );
      // Read several pages' worth. The extra is not served; it is what gives the
      // paging module a window wide enough to tell "you are behind" from "the
      // history you are asking to continue from is gone".
      observedVersion = lease?.changes.version ?? 0;
      const projection = lease ? await lease.read() : await loadChatChannelProjection(
        current.broker, channelId, CHANNEL_POLL_READ_WIDTH, current.viewer.actorId);
      assertOriginalIdentity();
      const { retainedFrom } = projection;
      // Cache only viewer-neutral data; reactions and actions remain per-viewer.
      const messages = lease ? projection.messages.map(message => ({ ...message,
        ...(projection.reactionRows ? { reactions: projectMessageReactionChips(projection.reactionRows.filter(row => row.messageId === message.id), current.viewer.actorId) } : {}),
      })) : projection.messages;
      const currentThreadIds = new Set(Object.values(current.broker.snapshot.conversations ?? {})
        .filter(conversation => conversation.kind === "thread" && conversation.parentConversationId === channelId).map(conversation => conversation.id));
      const requests = lease ? projection.requests.map(request => ({ ...request,
        ...(request.responsibility ? { responsibility: chatRequestResponsibility(
          current.broker.snapshot.collaborationRecords?.[request.responsibility.recordId], channelId,
          currentThreadIds, id => current.broker.snapshot.actors?.[id]?.displayName ?? id, current.viewer.actorId,
        ) } : {}),
      })) : projection.requests;
      // Only the trusted suffix is offered to the pager. Rows older than the
      // anchor are real messages, but the window does not hold everything between
      // them and the anchor, so paging across that boundary would hand back a page
      // with the difference silently missing. Refusing the cursor and sending the
      // caller back to `/feed` is the answer; a short page is not.
      const windowStart = retainedFrom;
      const events = windowStart
        ? messages.filter((message) => compareMessagesAsc(message, windowStart) >= 0)
        : messages;

      const page = pageChannelPoll({
        channelId,
        events,
        cursor,
        limit,
        // "suffix", never "complete". What was loaded above is the newest slice
        // of a rolling snapshot, so its oldest row is the earliest position this
        // host can still serve -- not the start of the transcript. Asserting
        // completeness here is what would turn a cursor the window no longer
        // covers into a page with the middle quietly missing.
        completeness: "suffix",
      });
      const questionMessageIds = new Set<string>();
      if (inbox) for (const record of Object.values(current.broker.snapshot.collaborationRecords ?? {})) {
        if (record.kind !== "question" || (record.ownerId !== current.viewer.actorId && record.nextMoveOwnerId !== current.viewer.actorId)) continue;
        // Delivery metadata explicitly links messages to collaboration records.
        for (const message of messages) if (message.metadata?.collaborationRecordId === record.id) questionMessageIds.add(message.id);
      }
      return {
        channelId,
        ...(inbox ? filterChannelInbox(page.events, messages, current.viewer.actorId, requests, questionMessageIds) : { messages: page.events }),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        recommendedPollIntervalMs: page.recommendedPollIntervalMs,
        // Current state of this channel's tracked flights, not a stream of
        // events about them. A poller that missed a transition is not told of
        // it, and nothing here acknowledges work.
        requests: inbox ? requests.filter(request => request.targetActorId === current.viewer.actorId || request.responsibility?.actorId === current.viewer.actorId) : requests,
      };
    };
    try {
      const page = await readPage(c.req.query("cursor") ?? null);
      return inbox ? holdChannelInbox(c.req.raw, page, wait, readPage, {
        wait: signal => lease!.changes.wait(observedVersion, signal), release: () => lease!.release(),
      }) : c.json(page);
    } catch (error) {
      lease?.release();
      if (error instanceof ChannelPollCursorError) {
        // `stale` is the one that is not the caller's mistake: history moved
        // past them. It is a different answer from a bad cursor, so it gets a
        // different status and a different instruction.
        return c.json(
          {
            error: error.reason === "stale"
              ? "History moved past that cursor. Re-read this channel's feed and"
                + " restart polling without a cursor. Deduplicate by message id; older history may be unavailable."
              : error.message,
            reason: error.reason,
          },
          error.reason === "stale" ? 409 : 400,
        );
      }
      if (error instanceof ChannelPollError) {
        return c.json({ error: error.message, reason: "invalid_poll" }, 400);
      }
      throw error;
    }
  });

  /**
   * A plain channel post. It invokes nobody, including the agents in the room.
   */
  app.get("/api/channels/:id/attachments/:attachmentId", async (c) => {
    const channelId = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { messages } = await loadChatChannelProjection(
      resolved.broker,
      channelId,
      CHANNEL_POLL_READ_WIDTH,
      resolved.viewer.actorId,
    );
    const attachment = messages
      .flatMap((message) => message.attachments ?? [])
      .find((item) => item.id === attachmentId);
    if (!attachment) return c.json({ error: "attachment not found" }, 404);
    const localPath = localPathFromBlobKey(attachment.blobKey);
    if (localPath) {
      return serveRawFile(c, currentDirectory, localPath);
    }
    const blobId = attachment.url?.match(/\/api\/blobs\/([^/?#]+)/)?.[1]
      ?? attachment.blobKey?.trim();
    if (!blobId) return c.json({ error: "attachment has no bytes" }, 404);
    const entry = getImageBlob(blobId);
    if (!entry) return c.json({ error: "attachment expired" }, 404);
    return new Response(Bun.file(entry.path), { headers: blobServeHeaders(entry) });
  });

  app.post("/api/channels/:id/messages", async (c) => {
    const channelId = c.req.param("id");
    const parsed = await readJsonBody(c, channelMessageBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const text = body.body?.trim() ?? "";
    const incomingAttachments = body.attachments ?? [];
    if (!text && incomingAttachments.length === 0) {
      return c.json({ error: "body or attachments is required" }, 400);
    }

    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { viewer } = resolved;
    let mentionActorIds: string[];
    try { mentionActorIds = parseChatMentionActorIds(body.mentionActorIds); }
    catch { return c.json({ error: "Choose at most 20 valid mention recipients." }, 400); }
    const allowed = new Set([...resolved.conversation.participantIds, CHAT_OPERATOR_ACTOR_ID]);
    if (mentionActorIds.some(id => !allowed.has(id))) {
      return c.json({ error: "A mention recipient is no longer in this channel. Remove them and retry." }, 409);
    }
    const mentions = mentionActorIds.map(actorId => ({ actorId,
      label: resolved.broker.snapshot.actors?.[actorId]?.displayName
        ?? resolved.broker.snapshot.agents?.[actorId]?.displayName
        ?? (actorId === CHAT_OPERATOR_ACTOR_ID ? resolveOperatorName() : actorId),
    }));

    const resolvedAttachments = resolveChatAttachments(incomingAttachments, {
      channelId,
      currentDirectory,
      allowLocalPaths: viewer.isOperator,
      requestOrigin: new URL(c.req.url).origin,
    });
    if (!resolvedAttachments.ok) {
      return c.json({ error: resolvedAttachments.error }, resolvedAttachments.status);
    }
    const attachments = resolvedAttachments.attachments;

    const retryAfter = chatSendLimiter.take(viewer.actorId);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: `You are sending too quickly. Wait ${retryAfter} seconds and try again; your draft is preserved.` }, 429);
    }

    const createdAtMs = Date.now();
    const replyToMessageId = body.replyToMessageId?.trim() || null;
    const posted = await sendScoutConversationMessage({
      conversationId: channelId,
      senderId: viewer.actorId,
      body: text,
      attentionMentions: mentions,
      ...(attachments.length > 0 ? { attachments } : {}),
      // `requestId` makes a retry after an uncertain failure land on the same
      // record rather than posting the message twice.
      clientMessageId: body.requestId?.trim() || null,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      // The whole point of this route: a post reaches the room without asking
      // anyone in it for work.
      notifyParticipantAgents: false,
      // And the body is payload, not an address. Quoting "@kepler said ..." in
      // a channel must not notify or wake Kepler.
      resolveMentionsFromBody: false,
      createdAtMs,
      currentDirectory,
      source: "scout-chat",
    });
    if (!posted.usedBroker || !posted.messageId) {
      return c.json({ error: "broker unreachable" }, 502);
    }

    return c.json({
      message: chatMessageProjection(
        {
          id: posted.messageId,
          conversationId: channelId,
          actorId: viewer.actorId,
          actorName: viewer.displayName,
          body: text,
          mentions,
          createdAt: createdAtMs,
          reactions: [],
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        channelId,
        replyToMessageId,
      ),
    });
  });

  const reactionMethodNotAllowed = (c: Context) =>
    c.json({ error: "method not allowed" }, 405);

  app.get("/api/channels/:id/reactions", reactionMethodNotAllowed);
  app.get("/api/channels/:id/reactions/remove", reactionMethodNotAllowed);

  const readReactionBody = async (c: Context) => {
    const parsed = channelReactionBody.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!parsed.success) return { error: "invalid_body" as const, status: 400 as const };
    const body = parsed.data;
    if (body && "actorId" in body && body.actorId !== undefined) {
      return { error: "identity_not_accepted" as const, status: 400 as const };
    }
    const messageId = body.messageId?.trim();
    const emoji = body.emoji?.trim();
    if (!messageId) return { error: "messageId is required" as const, status: 400 as const };
    if (!emoji || !isAllowedReactionEmoji(emoji)) {
      return { error: "invalid_emoji" as const, status: 400 as const };
    }
    return { messageId, emoji, requestId: body.requestId?.trim() || null };
  };

  app.post("/api/channels/:id/reactions", async (c) => {
    const channelId = c.req.param("id");
    const parsed = await readReactionBody(c);
    if ("error" in parsed) {
      return c.json(
        { error: parsed.error, ...(parsed.error === "invalid_emoji" || parsed.error === "identity_not_accepted" ? { reason: parsed.error } : {}) },
        parsed.status,
      );
    }
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    try {
      const posted = await sendScoutMessageReaction({
        channelId,
        messageId: parsed.messageId,
        actorId: resolved.viewer.actorId,
        emoji: parsed.emoji,
      });
      if (!posted.usedBroker) return c.json({ error: "broker unreachable" }, 502);
      return c.json({ ok: true, replayed: posted.replayed });
    } catch (error) {
      const reason = (error as { reason?: string }).reason;
      const status = (error as { status?: number }).status;
      if (reason === "wrong_channel" || reason === "message_not_found") {
        return c.json({ error: "message is not in this channel", reason: "wrong_channel" }, 404);
      }
      if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
        return c.json({ error: error instanceof Error ? error.message : String(error), reason }, status as ContentfulStatusCode);
      }
      throw error;
    }
  });

  app.post("/api/channels/:id/reactions/remove", async (c) => {
    const channelId = c.req.param("id");
    const parsed = await readReactionBody(c);
    if ("error" in parsed) {
      return c.json(
        { error: parsed.error, ...(parsed.error === "invalid_emoji" || parsed.error === "identity_not_accepted" ? { reason: parsed.error } : {}) },
        parsed.status,
      );
    }
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    try {
      const posted = await sendScoutMessageReaction({
        channelId,
        messageId: parsed.messageId,
        actorId: resolved.viewer.actorId,
        emoji: parsed.emoji,
        remove: true,
      });
      if (!posted.usedBroker) return c.json({ error: "broker unreachable" }, 502);
      return c.json({ ok: true, replayed: posted.replayed });
    } catch (error) {
      const reason = (error as { reason?: string }).reason;
      if (reason === "wrong_channel" || reason === "message_not_found") {
        return c.json({ error: "message is not in this channel", reason: "wrong_channel" }, 404);
      }
      throw error;
    }
  });

  /**
   * Address one agent. This is the only way a channel post becomes work.
   *
   * The target session comes from that channel's redemption -- never from the
   * request body, and never by launching something new. The invitation attached
   * one concrete session, and that session is what this room can reach.
   */
  app.post("/api/channels/:id/asks", async (c) => {
    const channelId = c.req.param("id");
    const parsed = await readJsonBody(c, channelAskBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const text = body.body?.trim();
    // Routing is by actor id. A display name typed into the body is prose, not
    // an address, and is never resolved into a target here.
    const targetActorId = body.targetActorId?.trim();
    if (!text) return c.json({ error: "body is required" }, 400);
    if (!targetActorId) return c.json({ error: "targetActorId is required" }, 400);

    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { broker, conversation, viewer } = resolved;
    const resolvedAttachments = resolveChatAttachments(body.attachments, {
      channelId, currentDirectory, allowLocalPaths: viewer.isOperator, requestOrigin: new URL(c.req.url).origin,
    });
    if (!resolvedAttachments.ok) return c.json({ error: resolvedAttachments.error }, resolvedAttachments.status);
    const attachments = resolvedAttachments.attachments;
    let mentionActorIds: string[];
    try { mentionActorIds = parseChatMentionActorIds(body.mentionActorIds); }
    catch { return c.json({ error: "Choose at most 20 valid mention recipients." }, 400); }
    const allowedMentionIds = new Set([...conversation.participantIds, CHAT_OPERATOR_ACTOR_ID]);
    if (mentionActorIds.some(id => !allowedMentionIds.has(id))) return c.json({ error: "A mention recipient is no longer in this channel. Remove them and retry." }, 409);
    const attentionMentions = mentionActorIds.map(actorId => ({ actorId,
      label: broker.snapshot.actors?.[actorId]?.displayName ?? broker.snapshot.agents?.[actorId]?.displayName
        ?? (actorId === CHAT_OPERATOR_ACTOR_ID ? resolveOperatorName() : actorId),
    }));

    const nowMs = Date.now();
    const endpoints = Object.values(broker.snapshot.endpoints ?? {}) as AgentEndpoint[];
    const agent = broker.snapshot.agents?.[targetActorId];
    const actor = broker.snapshot.actors?.[targetActorId];
    const endpoint = endpoints
      .filter((candidate) => candidate.agentId === targetActorId)
      .sort((left, right) => endpointFreshnessMs(right) - endpointFreshnessMs(left))[0]
      ?? null;

    const plan = planChannelAsks({
      mentionedActorIds: [targetActorId],
      participantIds: conversation.participantIds,
      invites: channelInvitesForConversation(conversation),
      nowMs,
      candidates: [{
        actorId: targetActorId,
        isAgent: Boolean(agent) || actor?.kind === "agent",
        // A member who joined over HTTP is an agent with nowhere to route to.
        // Marking it here is what keeps this route from reading "no attached
        // session yet" -- a state that resolves on its own -- over a member
        // whose whole mode is that it never attaches one.
        //
        // The id is passed alongside the record because the record is the part
        // that can be missing: a snapshot taken before the actor write lands
        // still has the participant on the roster, and answering "that is a
        // person" then would be a worse answer than the prefix gives.
        isApiParticipant: isApiParticipantActor({
          id: targetActorId,
          metadata: (actor as { metadata?: Record<string, unknown> } | undefined)?.metadata
            ?? null,
        }),
        label: agent?.displayName ?? actor?.displayName ?? targetActorId,
        endpoint: endpoint
          ? {
              state: endpoint.state,
              transport: endpoint.transport,
              sessionId: endpoint.sessionId ?? null,
              lastSeenAt: endpointFreshnessMs(endpoint) || null,
            }
          : null,
      }],
    });

    const ask = plan.asks[0];
    if (!ask) {
      // An unroutable target fails with something the asker can act on, rather
      // than creating a request that can never be delivered.
      const skipped = plan.skipped[0];
      return c.json(
        {
          error: skipped?.detail ?? "That agent cannot be asked in this channel.",
          ...(skipped?.reason ? { reason: skipped.reason } : {}),
        },
        409,
      );
    }

    const retryAfter = chatSendLimiter.take(viewer.actorId);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: `You are sending too quickly. Wait ${retryAfter} seconds and try again; your draft is preserved.` }, 429);
    }

    const replyToMessageId = body.replyToMessageId?.trim() || null;
    const dispatched = await sendScoutConversationSteer({
      conversationId: channelId,
      senderId: viewer.actorId,
      body: text,
      targetParticipantIds: [ask.actorId],
      intent: "invoke",
      // The exact session the invitation attached. `existing` is what keeps a
      // reply coming back into this session and this thread instead of starting
      // a fresh one somewhere else.
      execution: { session: "existing", targetSessionId: ask.sessionId },
      // One selected actor id is the entire address. A name written in the
      // message text is prose and never widens this into a second invocation.
      resolveMentionsFromBody: false,
      attentionMentions,
      ...(attachments.length ? { attachments } : {}),
      clientMessageId: body.requestId?.trim() || null,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      createdAtMs: nowMs,
      currentDirectory,
      source: "scout-chat",
    });
    if (!dispatched.usedBroker || !dispatched.messageId) {
      return c.json({ error: "broker unreachable" }, 502);
    }
    const flight = dispatched.flights?.[0] ?? dispatched.flight ?? null;
    if (!flight) {
      // No flight means no tracked request. Saying otherwise would put a
      // pending row on the surface for work the broker never accepted.
      return c.json(
        { error: `The broker did not accept a request for ${ask.label}.` },
        502,
      );
    }

    return c.json({
      message: chatMessageProjection(
        {
          id: dispatched.messageId,
          conversationId: channelId,
          actorId: viewer.actorId,
          actorName: viewer.displayName,
          body: text,
          attachments,
          mentions: [...new Map([{ actorId: ask.actorId, label: ask.label }, ...attentionMentions].map(mention => [mention.actorId, mention])).values()],
          createdAt: nowMs,
        },
        channelId,
        replyToMessageId,
      ),
      request: {
        messageId: dispatched.messageId,
        flightId: flight.id,
        state: flight.state,
        targetActorId: ask.actorId,
        // The reachability reading travels with the request so the surface can
        // say what the route actually is. It is not a delivery receipt, and
        // the note below never claims one.
        reception: ask.reception,
        note: channelAskDispatchNote(ask.reception, ask.label),
      },
    });
  });

  app.on(["GET", "POST"], "/api/channels/:id/asks/:flightId/execution", async (c) => {
    const channelId = c.req.param("id");
    const flightId = c.req.param("flightId");
    const submitting = c.req.method === "POST";
    const body = submitting ? await c.req.json().catch(() => null) as Record<string, unknown> | null : null;
    if (submitting && (!body || Object.keys(body).some(key => !["sessionId", "turnId"].includes(key))
      || ![body.sessionId, body.turnId].every(value => typeof value === "string" && value.trim()))) {
      return c.json({ error: "The observed session and turn are required." }, 400);
    }
    const initial = await resolveChatChannel(c.req.raw, channelId);
    if (!initial.ok) return c.json({ error: initial.error }, initial.status);
    if (!initial.viewer.isOperator) return c.json({ error: "Execution controls require the host." }, 403);
    const locate = (broker: typeof initial.broker) => {
      const flights = queryBrokerFlightsForWeb(broker, {});
      const flight = flights.find(item => item.id === flightId);
      const conversation = flight?.conversationId ? broker.snapshot.conversations[flight.conversationId] : undefined;
      const inChannel = flight && (flight.conversationId === channelId
        || (conversation?.kind === "thread" && conversation.parentConversationId === channelId));
      return { inChannel, session: inChannel ? chatExecutionSession(flightId, flights, broker.node.id) : null };
    };
    const first = locate(initial.broker);
    if (!first.inChannel) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", "no-store");
    if (!first.session) return submitting
      ? c.json({ error: "A unique active local execution session could not be established." }, 409)
      : c.json({ available: false });
    const snapshot = await getScoutWebPairingSessionSnapshot(first.session.sessionId);
    if (!snapshot) return c.json({ error: "The execution session could not be read. No interrupt was forwarded." }, 503);
    // Revalidate access and competing flights after reading the bridge.
    invalidateScoutBrokerContextCache(initial.broker.baseUrl);
    const current = await resolveChatChannel(c.req.raw, channelId);
    if (!current.ok) return c.json({ error: current.error }, current.status);
    if (!current.viewer.isOperator) return c.json({ error: "Execution controls require the host." }, 403);
    const latest = locate(current.broker);
    if (!latest.inChannel) return c.json({ error: "not found" }, 404);
    const session = latest.session;
    if (!session || session.sessionId !== first.session.sessionId || session.startedAt !== first.session.startedAt
      || snapshot.session.id !== session.sessionId) return c.json({ error: "The execution association changed. Refresh session state." }, 409);
    const turn = snapshot.turns.at(-1);
    const associated = turn && Number.isFinite(turn.startedAt) && turn.startedAt >= session.startedAt;
    const interruptible = Boolean(associated && turn.status === "streaming" && snapshot.currentTurnId === turn.id);
    if (!submitting) return c.json({ available: true, sessionId: session.sessionId, sessionName: snapshot.session.name,
      ...(associated ? { turnId: turn.id, status: turn.status } : {}), interruptible });
    if (!interruptible || body!.sessionId !== session.sessionId || body!.turnId !== turn!.id) {
      return c.json({ error: "That turn is no longer the observed active turn. Refresh session state." }, 409);
    }
    try {
      await interruptScoutWebPairingTurn({ sessionId: session.sessionId, turnId: turn!.id });
      return c.json({ ok: true, status: "submitted" });
    } catch {
      return c.json({ error: "The interrupt could not be confirmed. Refresh session state; do not assume execution stopped." }, 502);
    }
  });

  app.get("/api/channels/:id/asks/:flightId/approvals", async (c) => {
    const channelId = c.req.param("id");
    const flightId = c.req.param("flightId");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (!resolved.viewer.isOperator) return c.json({ error: "Session approvals require the host." }, 403);
    const flights = queryBrokerFlightsForWeb(resolved.broker, {});
    const flight = flights.find(item => item.id === flightId);
    const conversation = flight?.conversationId ? resolved.broker.snapshot.conversations[flight.conversationId] : undefined;
    if (!flight || !(flight.conversationId === channelId
      || (conversation?.kind === "thread" && conversation.parentConversationId === channelId))) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", "no-store");
    // Resolve association before reading the bridge, including competing flights
    // outside this channel. An empty list is not a claim that the agent is unblocked.
    const association = chatSessionApprovals(flightId, flights, [], resolved.broker.node.id);
    if (!association) return c.json({ available: false, approvals: [] });
    try {
      const pairing = await refreshScoutWebPairingState(currentDirectory);
      if (!pairing.isRunning) return c.json({ error: "The session bridge is unavailable." }, 503);
      const current = chatSessionApprovals(flightId, flights, pairing.pendingApprovals, resolved.broker.node.id);
      return c.json({ available: true, sessionId: current!.sessionId, approvals: current!.approvals });
    } catch { return c.json({ error: "Could not read current session approvals." }, 503); }
  });

  app.post("/api/channels/:id/asks/:flightId/approvals/decide", async (c) => {
    const channelId = c.req.param("id");
    const flightId = c.req.param("flightId");
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).some(key => !["sessionId", "turnId", "blockId", "version", "decision", "reason"].includes(key))
      || ![body.sessionId, body.turnId, body.blockId].every(value => typeof value === "string" && value.trim().length > 0)
      || !Number.isSafeInteger(body.version) || (body.version as number) < 0
      || !["approve", "deny"].includes(body.decision as string)
      || (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 4000))) {
      return c.json({ error: "A valid approval identity, version, and approve/deny decision are required." }, 400);
    }
    const initial = await resolveChatChannel(c.req.raw, channelId);
    if (!initial.ok) return c.json({ error: initial.error }, initial.status);
    if (!initial.viewer.isOperator) return c.json({ error: "Session approvals require the host." }, 403);
    let pairing: ScoutPairingState;
    try { pairing = await refreshScoutWebPairingState(currentDirectory); }
    catch { return c.json({ error: "Could not verify the current approval. No decision was forwarded." }, 503); }
    if (!pairing.isRunning) return c.json({ error: "The session bridge is unavailable. No decision was forwarded." }, 503);
    // Re-read broker ownership after the bridge await rather than authorizing
    // against a flight snapshot captured before a potentially slow request.
    invalidateScoutBrokerContextCache(initial.broker.baseUrl);
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (!resolved.viewer.isOperator) return c.json({ error: "Session approvals require the host." }, 403);
    const flights = queryBrokerFlightsForWeb(resolved.broker, {});
    const flight = flights.find(item => item.id === flightId);
    const conversation = flight?.conversationId ? resolved.broker.snapshot.conversations[flight.conversationId] : undefined;
    if (!flight || !(flight.conversationId === channelId
      || (conversation?.kind === "thread" && conversation.parentConversationId === channelId))) return c.json({ error: "not found" }, 404);
    const association = chatSessionApprovals(flightId, flights, pairing.pendingApprovals, resolved.broker.node.id);
    const approval = association?.approvals.find(item => item.sessionId === body.sessionId && item.turnId === body.turnId
      && item.blockId === body.blockId && item.version === body.version);
    if (!approval) return c.json({ error: "This approval or its execution association changed. Refresh before deciding." }, 409);
    try {
      await decideScoutWebPairingApproval({ sessionId: approval.sessionId, turnId: approval.turnId,
        blockId: approval.blockId, version: approval.version, decision: body.decision as "approve" | "deny",
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}) }, currentDirectory);
      return c.json({ ok: true, status: "submitted", decision: body.decision });
    } catch {
      return c.json({ error: "Could not confirm the approval submission. Refresh session state before deciding again." }, 502);
    }
  });

  app.get("/api/channels/:id/asks/:flightId/output", async (c) => {
    const channelId = c.req.param("id");
    const flightId = c.req.param("flightId");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { broker } = resolved;
    const flight = queryBrokerFlightsForWeb(broker, { flightId }).find((item) => item.id === flightId);
    const conversation = flight?.conversationId
      ? broker.snapshot.conversations[flight.conversationId] : undefined;
    if (!flight || !(flight.conversationId === channelId
      || (conversation?.kind === "thread" && conversation.parentConversationId === channelId))) {
      return c.json({ error: "not found" }, 404);
    }
    const record = broker.snapshot.flights?.[flightId] ?? queryFlightRecordById(flightId);
    if (!record?.output?.trim()) return c.json({ error: "No recorded output is available." }, 404);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.text(record.output);
  });

  app.post("/api/channels/:id/asks/:flightId/cancel", async (c) => {
    const channelId = c.req.param("id");
    const flightId = c.req.param("flightId");
    const resolved = await resolveChatChannel(c.req.raw, channelId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { broker } = resolved;
    const flight = broker.snapshot.flights?.[flightId];
    if (!flight) return c.json({ error: "not found" }, 404);
    const web = brokerFlightToWebFlight(broker, flight);
    const threadIds = new Set(
      (Object.values(broker.snapshot.conversations ?? {}) as ConversationDefinition[])
        .filter((item) => item.kind === "thread" && item.parentConversationId === channelId)
        .map((item) => item.id),
    );
    const inChannel = web.conversationId === channelId
      || (web.conversationId ? threadIds.has(web.conversationId) : false);
    if (!inChannel) return c.json({ error: "not found" }, 404);
    if (!resolved.viewer.isOperator && flight.requesterId !== resolved.viewer.actorId) {
      return c.json({ error: "Only the requester or operator can cancel this request." }, 403);
    }
    const state = String(flight.state ?? "").toLowerCase();
    const terminal = state === "completed" || state === "cancelled" || state === "canceled" || state === "failed";
    const outcome = await cancelScoutChatFlight(flightId, broker.baseUrl);
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    return c.json({
      ok: true,
      replayed: terminal,
      request: {
        messageId: web.messageId ?? null,
        flightId,
        state: outcome.state,
        targetActorId: flight.targetAgentId,
      },
    });
  });

  return { chatServiceHost, channelEventStreams };
}
