import type { MetadataMap, ScoutId } from "./common.js";

/**
 * Channel invitations: a portable, scoped, revocable capability that lets a
 * teammate bring an agent session they are *already running* into a Scout
 * channel.
 *
 * Three boundaries shape this module.
 *
 * 1. **The secret never lands in a record.** Only `tokenHash` is persisted, so
 *    a snapshot, a journal line, or a log dump cannot be replayed into channel
 *    membership. The raw token exists in the invitation URL and nowhere else.
 * 2. **Membership is not reception.** Redeeming an invitation makes an actor a
 *    channel participant. Whether that actor can actually *receive* is a
 *    separate, live judgement made from endpoint evidence — see
 *    {@link deriveChannelReception}.
 * 3. **Reachability is stated, not assumed.** A loopback route is recorded as
 *    `local_only` so a surface can say plainly that the link will not work for
 *    a teammate on another machine.
 *
 * Invites live in the owning conversation's metadata under
 * {@link CHANNEL_INVITES_METADATA_KEY}; the broker remains the only writer.
 */

export const CHANNEL_INVITES_METADATA_KEY = "channelInvites";

/**
 * The only scope this pilot grants. It permits posting, reading, and replying
 * inside one channel — never project, shell, or filesystem authority.
 */
export type ChannelInviteScope = "channel_participation";

export const CHANNEL_INVITE_SCOPE: ChannelInviteScope = "channel_participation";

/** How far the recorded route actually reaches. */
export type ChannelInviteReachability =
  /** Loopback only: useless to anybody not on the authority machine. */
  | "local_only"
  /** A LAN/mDNS doorway name or address on the local network. */
  | "lan"
  /** A tailnet/mesh route that survives leaving the LAN. */
  | "mesh"
  /** No evidence either way; do not claim it works. */
  | "unknown";

export interface ChannelInviteRoute {
  /** The broker node that owns the channel and must accept the redemption. */
  authorityNodeId: ScoutId;
  /** Host an invited agent should dial. */
  host: string;
  /** Absolute base URL the invitation document points at. */
  baseUrl: string;
  reachability: ChannelInviteReachability;
  /**
   * Why this route may not reach the invitee. Present whenever reachability is
   * anything but `mesh`; surfaces must render it rather than imply the link
   * works everywhere.
   */
  caveat?: string;
}

/** One concrete agent session that accepted one invitation. */
export interface ChannelInviteRedemption {
  id: ScoutId;
  /** The channel participant this redemption created or confirmed. */
  actorId: ScoutId;
  agentId?: ScoutId;
  /** The pre-existing harness session attached to the channel. */
  sessionId?: string;
  endpointId?: ScoutId;
  nodeId?: ScoutId;
  harness?: string;
  projectRoot?: string;
  displayName?: string;
  redeemedAt: number;
}

export interface ChannelInviteInvitee {
  displayName: string;
  handle?: string;
  /** Set when the invitation names a durable person actor up front. */
  actorId?: ScoutId;
}

export interface ChannelInviteRecord {
  id: ScoutId;
  channelId: ScoutId;
  scope: ChannelInviteScope;
  /** Lowercase hex digest of the raw token. The raw token is never stored. */
  tokenHash: string;
  /** A short non-secret fragment so humans can tell two invitations apart. */
  tokenHint: string;
  createdAt: number;
  createdByActorId: ScoutId;
  expiresAt: number | null;
  maxRedemptions: number | null;
  revokedAt?: number;
  revokedByActorId?: ScoutId;
  invitee?: ChannelInviteInvitee;
  route: ChannelInviteRoute;
  redemptions: ChannelInviteRedemption[];
  metadata?: MetadataMap;
}

export type ChannelInviteState = "active" | "expired" | "revoked" | "exhausted";

export function channelInviteState(
  invite: ChannelInviteRecord,
  nowMs: number,
): ChannelInviteState {
  if (invite.revokedAt !== undefined) return "revoked";
  if (invite.expiresAt !== null && invite.expiresAt <= nowMs) return "expired";
  if (
    invite.maxRedemptions !== null
    && invite.redemptions.length >= invite.maxRedemptions
  ) {
    return "exhausted";
  }
  return "active";
}

export type ChannelInviteRejectionReason =
  | "unknown_token"
  | "expired"
  | "revoked"
  | "exhausted"
  | "scope_mismatch"
  | "channel_mismatch"
  | "missing_identity";

export interface ChannelInviteRejection {
  reason: ChannelInviteRejectionReason;
  message: string;
}

export interface ChannelInviteRedemptionRequest {
  actorId: ScoutId;
  agentId?: ScoutId;
  sessionId?: string;
  endpointId?: ScoutId;
  nodeId?: ScoutId;
  harness?: string;
  projectRoot?: string;
  displayName?: string;
  channelId?: ScoutId;
  scope?: string;
}

export type ChannelInviteRedemptionOutcome =
  | {
      ok: true;
      /**
       * The redemption already on file for this identity. Present on a retry;
       * the caller must reuse it rather than appending a second row or
       * consuming another slot.
       */
      existing: ChannelInviteRedemption | null;
    }
  | { ok: false; rejection: ChannelInviteRejection };

/**
 * Decide whether one redemption attempt may proceed.
 *
 * Retries are first-class: an identity that already redeemed this invitation
 * is accepted again with its original redemption, even once the invitation is
 * exhausted. Re-running an agent's join command must never mint a second
 * identity, burn a second slot, or replace a live session.
 */
export function evaluateChannelInviteRedemption(input: {
  invite: ChannelInviteRecord;
  request: ChannelInviteRedemptionRequest;
  nowMs: number;
}): ChannelInviteRedemptionOutcome {
  const { invite, request, nowMs } = input;

  const actorId = request.actorId?.trim();
  if (!actorId) {
    return {
      ok: false,
      rejection: {
        reason: "missing_identity",
        message: "Redemption needs the actor id of the agent session that is joining.",
      },
    };
  }

  if (request.channelId?.trim() && request.channelId.trim() !== invite.channelId) {
    return {
      ok: false,
      rejection: {
        reason: "channel_mismatch",
        message: "This invitation does not belong to the requested channel.",
      },
    };
  }

  if (request.scope?.trim() && request.scope.trim() !== invite.scope) {
    return {
      ok: false,
      rejection: {
        reason: "scope_mismatch",
        message: `This invitation grants ${invite.scope} only.`,
      },
    };
  }

  const existing = findChannelInviteRedemption(invite, request);
  if (existing) {
    // Revocation still bites: a revoked invitation stops being a usable
    // capability even for an identity that once held it.
    if (invite.revokedAt !== undefined) {
      return { ok: false, rejection: channelInviteRejection("revoked") };
    }
    return { ok: true, existing };
  }

  const state = channelInviteState(invite, nowMs);
  if (state !== "active") {
    return { ok: false, rejection: channelInviteRejection(state) };
  }

  return { ok: true, existing: null };
}

/**
 * The redemption already recorded for this identity, if any.
 *
 * **Session identity is decisive.** When a request carries a session id, only a
 * redemption for that exact session counts as the same joiner. A durable agent
 * running two concrete sessions is two distinct attachments: this feature
 * exists to attach *the exact session* a teammate is already working in, so
 * letting a second session inherit the first one's membership through a shared
 * agent id would hand it the wrong context and silently skip a use of the
 * invitation.
 *
 * Only when no session is carried does the durable actor or agent id decide.
 */
export function findChannelInviteRedemption(
  invite: ChannelInviteRecord,
  request: Pick<ChannelInviteRedemptionRequest, "actorId" | "sessionId" | "agentId">,
): ChannelInviteRedemption | null {
  const sessionId = request.sessionId?.trim();
  if (sessionId) {
    return invite.redemptions.find(
      (redemption) => redemption.sessionId?.trim() === sessionId,
    ) ?? null;
  }

  const actorId = request.actorId?.trim();
  const agentId = request.agentId?.trim();
  return invite.redemptions.find((redemption) => {
    if (actorId && redemption.actorId === actorId) return true;
    return Boolean(agentId) && redemption.agentId?.trim() === agentId;
  }) ?? null;
}

function channelInviteRejection(
  state: Exclude<ChannelInviteState, "active">,
): ChannelInviteRejection {
  switch (state) {
    case "expired":
      return { reason: "expired", message: "This invitation has expired. Ask for a new one." };
    case "revoked":
      return { reason: "revoked", message: "This invitation was revoked." };
    case "exhausted":
      return {
        reason: "exhausted",
        message: "This invitation has already been used the maximum number of times.",
      };
  }
}

export function unknownChannelInviteRejection(): ChannelInviteRejection {
  // Deliberately identical for a malformed, unknown, and deleted token: a
  // probe must not learn which invitations exist.
  return { reason: "unknown_token", message: "This invitation link is not valid." };
}

/** Read the invitations stored on a conversation record. */
export function readChannelInvites(
  metadata: MetadataMap | undefined,
): ChannelInviteRecord[] {
  const raw = metadata?.[CHANNEL_INVITES_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ChannelInviteRecord =>
    Boolean(entry)
    && typeof entry === "object"
    && typeof (entry as ChannelInviteRecord).id === "string"
    && typeof (entry as ChannelInviteRecord).tokenHash === "string"
    && Array.isArray((entry as ChannelInviteRecord).redemptions));
}

/** Match a presented token against stored invitations by its digest. */
export function findChannelInviteByTokenHash(
  invites: ChannelInviteRecord[],
  tokenHash: string,
): ChannelInviteRecord | null {
  const normalized = tokenHash.trim().toLowerCase();
  if (!normalized) return null;
  return invites.find((invite) => invite.tokenHash.toLowerCase() === normalized) ?? null;
}

/**
 * The public view of an invitation: everything a human or agent needs to
 * understand the offer, and nothing that could be replayed into membership.
 */
export interface ChannelInvitePublicView {
  id: ScoutId;
  channelId: ScoutId;
  /** Public authorship, used to show who may revoke this invitation. */
  createdByActorId: ScoutId;
  scope: ChannelInviteScope;
  state: ChannelInviteState;
  tokenHint: string;
  createdAt: number;
  expiresAt: number | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  invitee?: ChannelInviteInvitee;
  route: ChannelInviteRoute;
  redemptions: ChannelInviteRedemption[];
}

export function channelInvitePublicView(
  invite: ChannelInviteRecord,
  nowMs: number,
): ChannelInvitePublicView {
  return {
    id: invite.id,
    channelId: invite.channelId,
    createdByActorId: invite.createdByActorId,
    scope: invite.scope,
    state: channelInviteState(invite, nowMs),
    tokenHint: invite.tokenHint,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    maxRedemptions: invite.maxRedemptions,
    redemptionCount: invite.redemptions.length,
    ...(invite.invitee ? { invitee: invite.invitee } : {}),
    route: invite.route,
    redemptions: invite.redemptions,
  };
}
