import {
  channelInvitePublicView,
  evaluateChannelInviteRedemption,
  findChannelInviteByTokenHash,
  readChannelInvites,
  type ChannelInvitePublicView,
  type ChannelInviteInvitee,
  type ChannelInviteRecord,
  type ChannelInviteRedemption,
  type ChannelInviteRejection,
  type ChannelInviteRoute,
  type ActorIdentity,
  type ConversationDefinition,
  type ControlCommand,
  scoutBrokerPaths,
} from "@openscout/protocol";

import { requestScoutBrokerJson } from "@openscout/runtime/broker-api";

import {
  invalidateScoutBrokerContextCache,
  loadScoutBrokerContext,
  resolveScoutBrokerUrl,
  type ScoutBrokerContext,
} from "../broker/service.ts";
import {
  channelInviteUrl,
  hashChannelInviteToken,
  mintChannelInviteToken,
  resolveChannelInviteRoute,
  type ChannelInviteRouteInput,
} from "./channel-invites.ts";

/**
 * The web server's half of channel invitations.
 *
 * Writes are broker `ControlCommand`s rather than conversation upserts, so the
 * broker performs the read-modify-write of a channel's invitation set inside
 * its serialized queue. Reads come from the broker snapshot, where invitations
 * already live in conversation metadata.
 */

export type ChannelInviteError = {
  status: 400 | 403 | 404 | 410 | 502;
  error: string;
  reason?: ChannelInviteRejection["reason"];
};

export type ChannelInviteCreateOutcome =
  | {
      ok: true;
      invite: ChannelInvitePublicView;
      /** Returned once, to the creating operator. Never persisted or logged. */
      token: string;
      inviteUrl: string;
    }
  | { ok: false } & ChannelInviteError;

export type ChannelInviteRedeemOutcome =
  | {
      ok: true;
      invite: ChannelInvitePublicView;
      redemption: ChannelInviteRedemption;
      alreadyRedeemed: boolean;
      conversationId: string;
      channelTitle: string;
      participantIds: string[];
    }
  | { ok: false } & ChannelInviteError;

async function executeBrokerCommand<T>(
  baseUrl: string,
  command: ControlCommand,
): Promise<T> {
  const result = await requestScoutBrokerJson<T>(baseUrl, scoutBrokerPaths.v1.commands, {
    method: "POST",
    body: command,
  });
  invalidateScoutBrokerContextCache(baseUrl);
  return result;
}

function channelConversation(
  broker: ScoutBrokerContext,
  channelId: string,
): ConversationDefinition | null {
  const conversation = broker.snapshot.conversations[channelId.trim()] as
    | ConversationDefinition
    | undefined;
  return conversation?.kind === "channel" ? conversation : null;
}

export async function createChannelInvite(input: {
  channelId: string;
  createdByActorId: string;
  invitee?: ChannelInviteInvitee;
  expiresAt?: number | null;
  maxRedemptions?: number | null;
  route: ChannelInviteRouteInput;
  nowMs?: number;
  createId: () => string;
}): Promise<ChannelInviteCreateOutcome> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { ok: false, status: 502, error: "broker unreachable" };
  }
  const conversation = channelConversation(broker, input.channelId);
  if (!conversation) {
    return { ok: false, status: 404, error: "channel not found" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const minted = mintChannelInviteToken();
  const route: ChannelInviteRoute = resolveChannelInviteRoute(input.route);

  const command: ControlCommand = {
    kind: "channel.invite.create",
    channelId: conversation.id,
    inviteId: input.createId(),
    tokenHash: minted.tokenHash,
    tokenHint: minted.tokenHint,
    createdByActorId: input.createdByActorId,
    createdAt: nowMs,
    expiresAt: input.expiresAt ?? null,
    maxRedemptions: input.maxRedemptions ?? null,
    route,
    ...(input.invitee ? { invitee: input.invitee } : {}),
  };

  const result = await executeBrokerCommand<
    { ok: true; invite: ChannelInvitePublicView } | { ok: false; error: string }
  >(broker.baseUrl, command);
  if (!result.ok) {
    return { ok: false, status: 400, error: result.error };
  }

  return {
    ok: true,
    invite: result.invite,
    token: minted.token,
    inviteUrl: channelInviteUrl(route, minted.token),
  };
}

export async function revokeChannelInvite(input: {
  channelId: string;
  inviteId: string;
  revokedByActorId: string;
  nowMs?: number;
}): Promise<{ ok: true; invite: ChannelInvitePublicView } | ({ ok: false } & ChannelInviteError)> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { ok: false, status: 502, error: "broker unreachable" };
  }
  const result = await executeBrokerCommand<
    { ok: true; invite: ChannelInvitePublicView } | { ok: false; error: string }
  >(broker.baseUrl, {
    kind: "channel.invite.revoke",
    channelId: input.channelId,
    inviteId: input.inviteId,
    revokedByActorId: input.revokedByActorId,
    revokedAt: input.nowMs ?? Date.now(),
  });
  return result.ok
    ? { ok: true, invite: result.invite }
    : { ok: false, status: 404, error: result.error };
}

export interface ResolvedChannelInvite {
  conversation: ConversationDefinition;
  invite: ChannelInviteRecord;
  view: ChannelInvitePublicView;
}

/**
 * Resolve a raw token to its invitation, by digest.
 *
 * This is a pure read: opening an invitation link must never change
 * membership, so nothing here writes. The lookup scans conversations rather
 * than trusting a channel id from the caller, because the link carries only
 * the token.
 */
export async function resolveChannelInviteByToken(
  token: string,
  nowMs = Date.now(),
): Promise<ResolvedChannelInvite | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const broker = await loadScoutBrokerContext();
  if (!broker) return null;

  const tokenHash = hashChannelInviteToken(trimmed);
  for (const candidate of Object.values(broker.snapshot.conversations)) {
    const conversation = candidate as ConversationDefinition;
    if (conversation.kind !== "channel") continue;
    const invite = findChannelInviteByTokenHash(
      readChannelInvites(conversation.metadata),
      tokenHash,
    );
    if (invite) {
      return { conversation, invite, view: channelInvitePublicView(invite, nowMs) };
    }
  }
  return null;
}

export async function redeemChannelInvite(input: {
  token: string;
  actorId: string;
  agentId?: string;
  sessionId?: string;
  endpointId?: string;
  nodeId?: string;
  harness?: string;
  projectRoot?: string;
  displayName?: string;
  nowMs?: number;
  createId: () => string;
}): Promise<ChannelInviteRedeemOutcome> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { ok: false, status: 502, error: "broker unreachable" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const resolved = await resolveChannelInviteByToken(input.token, nowMs);
  if (!resolved) {
    return {
      ok: false,
      status: 404,
      error: "This invitation link is not valid.",
      reason: "unknown_token",
    };
  }

  // Refuse a dead invitation here rather than attempting a write with it.
  //
  // This is a pre-check, not the decision: the broker re-evaluates the same
  // rules against the record it owns, because this snapshot can be stale and
  // only the broker can serialize the write. What it buys is that an expired,
  // revoked, or spent link never reaches the write path at all, and the caller
  // gets the honest status even when the broker is unreachable.
  const precheck = evaluateChannelInviteRedemption({
    invite: resolved.invite,
    nowMs,
    request: {
      actorId: input.actorId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
  });
  if (!precheck.ok) {
    return {
      ok: false,
      ...redemptionFailureStatus(precheck.rejection),
      error: precheck.rejection.message,
    };
  }

  const result = await executeBrokerCommand<
    | {
        ok: true;
        invite: ChannelInvitePublicView;
        redemption: ChannelInviteRedemption;
        alreadyRedeemed: boolean;
        participantIds: string[];
        conversationId: string;
      }
    | { ok: false; error: string; rejection?: ChannelInviteRejection }
  >(broker.baseUrl, {
    kind: "channel.invite.redeem",
    channelId: resolved.conversation.id,
    tokenHash: hashChannelInviteToken(input.token),
    redemptionId: input.createId(),
    redeemedAt: nowMs,
    request: {
      actorId: input.actorId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.endpointId ? { endpointId: input.endpointId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    },
  });

  if (!result.ok) {
    return { ok: false, ...redemptionFailureStatus(result.rejection), error: result.error };
  }

  return {
    ok: true,
    invite: result.invite,
    redemption: result.redemption,
    alreadyRedeemed: result.alreadyRedeemed,
    conversationId: result.conversationId,
    channelTitle: resolved.conversation.title,
    participantIds: result.participantIds,
  };
}


export type ChannelInviteJoinOutcome =
  | {
      ok: true;
      actorId: string;
      displayName: string;
      conversationId: string;
      channelTitle: string;
      alreadyMember: boolean;
    }
  | { ok: false } & ChannelInviteError;

/**
 * Admit a person through an invitation.
 *
 * This is the teammate half of the invitation, and it is deliberately not the
 * same call as agent redemption. An agent arrives already registered with the
 * broker and brings a concrete session; a person arrives with nothing but the
 * link and a name they typed. So this mints a distinct person actor first, then
 * redeems on that actor's behalf.
 *
 * The minted id is opaque and random rather than derived from the typed name:
 * two people named "Art" must be two members, and a display name is not an
 * identity.
 */
export async function joinChannelInviteAsPerson(input: {
  token: string;
  displayName: string;
  /** Reuse an actor the caller already holds -- a member returning on a new invite. */
  existingActorId?: string | null;
  nowMs?: number;
  createId: () => string;
}): Promise<ChannelInviteJoinOutcome> {
  const displayName = input.displayName.trim();
  if (!displayName) {
    return { ok: false, status: 400, error: "A name is required to join." };
  }

  const broker = await loadScoutBrokerContext();
  if (!broker) return { ok: false, status: 502, error: "broker unreachable" };

  const nowMs = input.nowMs ?? Date.now();
  const resolved = await resolveChannelInviteByToken(input.token, nowMs);
  if (!resolved) {
    return {
      ok: false,
      status: 404,
      error: "This invitation link is not valid.",
      reason: "unknown_token",
    };
  }

  // Refuse a dead invitation before minting anything. Creating a person actor
  // for an expired link would leave a real identity behind for a join that
  // never happened.
  const precheck = evaluateChannelInviteRedemption({
    invite: resolved.invite,
    nowMs,
    request: { actorId: input.existingActorId?.trim() || "pending" },
  });
  if (!precheck.ok && precheck.rejection.reason !== "missing_identity") {
    return {
      ok: false,
      ...redemptionFailureStatus(precheck.rejection),
      error: precheck.rejection.message,
    };
  }

  const actorId = input.existingActorId?.trim() || `person-${input.createId()}`;
  const actor: ActorIdentity = { id: actorId, kind: "person", displayName };
  await requestScoutBrokerJson<{ ok: boolean }>(broker.baseUrl, scoutBrokerPaths.v1.actors, {
    method: "POST",
    body: actor,
  });
  invalidateScoutBrokerContextCache(broker.baseUrl);

  const redemption = await redeemChannelInvite({
    token: input.token,
    actorId,
    displayName,
    nowMs,
    createId: input.createId,
  });
  if (!redemption.ok) return redemption;

  return {
    ok: true,
    actorId,
    displayName,
    conversationId: redemption.conversationId,
    channelTitle: redemption.channelTitle,
    alreadyMember: redemption.alreadyRedeemed,
  };
}

export type ChannelInviteApiParticipationOutcome =
  | {
      ok: true;
      actorId: string;
      displayName: string;
      conversationId: string;
      channelTitle: string;
      /** True when this key had already joined: a retry, not a second use. */
      alreadyMember: boolean;
    }
  | ({ ok: false } & ChannelInviteError);

/**
 * Admit a lightweight API participant.
 *
 * The third way an invitation is accepted, and the only one where the joiner
 * brings no identity at all. A person types a name; an agent names a running
 * session; this caller has neither, so the server mints the actor and the
 * caller is told who they turned out to be.
 *
 * `actorId` is derived by the route rather than chosen here, because the
 * derivation needs the host's signing secret -- but it is still the server's
 * id in every sense that matters: the caller cannot compute it, cannot send
 * one, and cannot reach an existing actor with it.
 *
 * The redemption is deliberately sessionless. There is no session, and
 * inventing one would make the roster claim an attachment that can never
 * receive anything.
 */
export async function joinChannelInviteAsApiParticipant(input: {
  token: string;
  actorId: string;
  displayName: string;
  nowMs?: number;
  createId: () => string;
  buildActor: (context: { actorId: string; displayName: string; channelId: string; joinedAt: number }) => ActorIdentity;
}): Promise<ChannelInviteApiParticipationOutcome> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return { ok: false, status: 502, error: "broker unreachable" };

  const nowMs = input.nowMs ?? Date.now();
  const resolved = await resolveChannelInviteByToken(input.token, nowMs);
  if (!resolved) {
    return {
      ok: false,
      status: 404,
      error: "This invitation link is not valid.",
      reason: "unknown_token",
    };
  }

  // Refuse a dead invitation before minting an actor for it, exactly as the
  // person path does: an expired link must not leave a participant identity
  // behind for a join that never happened.
  const precheck = evaluateChannelInviteRedemption({
    invite: resolved.invite,
    nowMs,
    request: { actorId: input.actorId },
  });
  if (!precheck.ok) {
    return {
      ok: false,
      ...redemptionFailureStatus(precheck.rejection),
      error: precheck.rejection.message,
    };
  }

  const actor = input.buildActor({
    actorId: input.actorId,
    displayName: input.displayName,
    channelId: resolved.conversation.id,
    joinedAt: nowMs,
  });
  await requestScoutBrokerJson<{ ok: boolean }>(broker.baseUrl, scoutBrokerPaths.v1.actors, {
    method: "POST",
    body: actor,
  });
  invalidateScoutBrokerContextCache(broker.baseUrl);

  const redemption = await redeemChannelInvite({
    token: input.token,
    actorId: input.actorId,
    displayName: input.displayName,
    nowMs,
    createId: input.createId,
  });
  if (!redemption.ok) return redemption;

  return {
    ok: true,
    actorId: input.actorId,
    displayName: input.displayName,
    conversationId: redemption.conversationId,
    channelTitle: redemption.channelTitle,
    alreadyMember: redemption.alreadyRedeemed,
  };
}

/**
 * Map a rejection onto an HTTP status an agent can branch on without parsing
 * prose: `410` for a capability that is gone for good, `403` for an identity
 * problem the caller can fix, `404` for a token that means nothing here.
 */
function redemptionFailureStatus(
  rejection: ChannelInviteRejection | undefined,
): { status: ChannelInviteError["status"]; reason?: ChannelInviteRejection["reason"] } {
  switch (rejection?.reason) {
    case "expired":
    case "revoked":
    case "exhausted":
      return { status: 410, reason: rejection.reason };
    case "missing_identity":
      return { status: 403, reason: rejection.reason };
    case "unknown_token":
    case "channel_mismatch":
      return { status: 404, reason: rejection.reason };
    case "scope_mismatch":
      return { status: 400, reason: rejection.reason };
    default:
      return { status: 400 };
  }
}

export { resolveScoutBrokerUrl };
