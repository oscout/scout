import {
  CHANNEL_INVITE_SCOPE,
  CHANNEL_MEMBER_REMOVALS_KEY,
  readChannelMemberRemoval,
  CHANNEL_INVITES_METADATA_KEY,
  channelInvitePublicView,
  evaluateChannelInviteRedemption,
  findChannelInviteByTokenHash,
  readChannelInvites,
  unknownChannelInviteRejection,
  type ChannelInviteCreateCommand,
  type ChannelInvitePublicView,
  type ChannelInviteRecord,
  type ChannelInviteRedeemCommand,
  type ChannelInviteRedemption,
  type ChannelInviteRejection,
  type ChannelInviteRevokeCommand,
  type ConversationDefinition,
} from "@openscout/protocol";

import type { RuntimeSnapshot } from "./scout-dispatcher.js";

export type BrokerChannelInviteRuntime = {
  snapshot(): RuntimeSnapshot;
};

export type BrokerChannelInviteServiceDeps = {
  runtime: BrokerChannelInviteRuntime;
  /**
   * Canonical read-modify-write on one conversation — the mutator runs inside
   * the serialized durable writer, so the roster/invites journaled here are
   * computed from the latest record, never a stale preimage.
   */
  updateConversation: (
    conversationId: string,
    mutate: (
      current: ConversationDefinition | undefined,
    ) => ConversationDefinition | null | undefined,
  ) => Promise<{ conversation: ConversationDefinition | null }>;
};

export type ChannelInviteCommandResult =
  | { ok: true; invite: ChannelInvitePublicView; participantIds: string[] }
  | { ok: false; error: string; rejection?: ChannelInviteRejection };

export type ChannelInviteRedeemResult =
  | {
      ok: true;
      invite: ChannelInvitePublicView;
      redemption: ChannelInviteRedemption;
      /** True when this call found an existing redemption instead of adding one. */
      alreadyRedeemed: boolean;
      participantIds: string[];
      conversationId: string;
    }
  | { ok: false; error: string; rejection?: ChannelInviteRejection };

/**
 * Broker-owned writes for channel invitations.
 *
 * Every mutation here is a read-modify-write of one conversation's invitation
 * set, serialized per channel by {@link BrokerChannelInviteService.runExclusive}.
 * Keeping the mutation on this side -- rather than letting a surface read a
 * conversation and PUT a whole modified copy back -- is what keeps the broker
 * the only writer and makes overlapping invitation writes safe.
 *
 * The service never sees a raw token. Callers hash first; the broker matches
 * digests. A journal line or snapshot dump therefore cannot be replayed into
 * channel membership.
 */
export class BrokerChannelInviteService {
  constructor(private readonly deps: BrokerChannelInviteServiceDeps) {}

  /**
   * One in-flight mutation per channel.
   *
   * Each mutation reads the channel's invitation set, computes the next one,
   * and awaits a durable write. That read and write must not be split by
   * another mutation of the same channel: two overlapping `create` calls would
   * both start from the same empty set and the second write would erase the
   * first invitation. The broker's journal queue makes each write durable but
   * does not make this pair atomic, so the invariant is enforced where it
   * lives -- here.
   */
  private readonly channelWrites = new Map<string, Promise<unknown>>();

  private async runExclusive<T>(channelId: string, run: () => Promise<T>): Promise<T> {
    const key = channelId.trim();
    const previous = this.channelWrites.get(key) ?? Promise.resolve();
    // Chain on both settle paths: one failed mutation must not wedge the
    // channel for every mutation after it.
    const current = previous.then(run, run);
    const settled = current.then(() => undefined, () => undefined);
    this.channelWrites.set(key, settled);
    try {
      return await current;
    } finally {
      // Only the tail clears the entry, so a queue that is still building up
      // is never dropped mid-chain.
      if (this.channelWrites.get(key) === settled) {
        this.channelWrites.delete(key);
      }
    }
  }

  /** Called by the operator-authorized command path; never by an invitee. */
  readonly removeMember = async (command: {
    channelId: string; actorId: string; removedByActorId: string; removedAt: number;
  }): Promise<{ ok: true; participantIds: string[] } | { ok: false; error: string }> =>
    this.runExclusive(typeof command.channelId === "string" ? command.channelId : "", async () => {
      const actorId = typeof command.actorId === "string" ? command.actorId.trim() : "";
      if (!actorId || typeof command.removedByActorId !== "string" || !command.removedByActorId.trim() || !Number.isFinite(command.removedAt)) {
        return { ok: false, error: "A member, removing actor, and timestamp are required." };
      }
      if (actorId === command.removedByActorId) return { ok: false, error: "The operator cannot remove their own channel access." };
      let error: string | null = null;
      const update = await this.deps.updateConversation(command.channelId, current => {
        if (!current || current.kind !== "channel") { error = "Channel not found."; return null; }
        const prior = readChannelMemberRemoval(current.metadata, actorId);
        if (!current.participantIds.includes(actorId)) {
          if (!prior) error = "That identity is not a channel member.";
          return null;
        }
        const existing = current.metadata?.[CHANNEL_MEMBER_REMOVALS_KEY];
        const records = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
        return {
          ...current,
          participantIds: current.participantIds.filter(id => id !== actorId),
          metadata: {
            ...current.metadata,
            [CHANNEL_MEMBER_REMOVALS_KEY]: {
              ...records,
              [actorId]: {
                removedAt: command.removedAt, removedByActorId: command.removedByActorId,
                blockedInviteIds: [...new Set([...(prior?.blockedInviteIds ?? []), ...readChannelInvites(current.metadata).map(invite => invite.id)])],
              },
            },
          },
        };
      });
      if (error || !update.conversation) return { ok: false, error: error ?? "Channel not found." };
      return { ok: true, participantIds: update.conversation.participantIds };
    });

  readonly create = async (
    command: ChannelInviteCreateCommand,
  ): Promise<ChannelInviteCommandResult> =>
    this.runExclusive(command.channelId, async () => {
      const conversation = this.channelConversation(command.channelId);
      if (!conversation) {
        return { ok: false, error: `Channel ${command.channelId} not found.` };
      }

      const invites = readChannelInvites(conversation.metadata);
      const duplicate = invites.find((invite) => invite.id === command.inviteId);
      if (duplicate) {
        return {
          ok: true,
          invite: channelInvitePublicView(duplicate, command.createdAt),
          participantIds: conversation.participantIds,
        };
      }

      const invite: ChannelInviteRecord = {
        id: command.inviteId,
        channelId: conversation.id,
        scope: CHANNEL_INVITE_SCOPE,
        tokenHash: command.tokenHash.trim().toLowerCase(),
        tokenHint: command.tokenHint,
        createdAt: command.createdAt,
        createdByActorId: command.createdByActorId,
        expiresAt: command.expiresAt,
        maxRedemptions: command.maxRedemptions,
        ...(command.invitee ? { invitee: command.invitee } : {}),
        route: command.route,
        redemptions: [],
        ...(command.metadata ? { metadata: command.metadata } : {}),
      };

      const written = await this.writeInvites(conversation.id, [...invites, invite]);
      if (!written) {
        // The channel record vanished between validation and the write —
        // report the same failure as an unknown channel.
        return { ok: false, error: `Channel ${command.channelId} not found.` };
      }
      return {
        ok: true,
        invite: channelInvitePublicView(invite, command.createdAt),
        participantIds: written.participantIds,
      };
  });

  readonly revoke = async (
    command: ChannelInviteRevokeCommand,
  ): Promise<ChannelInviteCommandResult> =>
    this.runExclusive(command.channelId, async () => {
      const conversation = this.channelConversation(command.channelId);
      if (!conversation) {
        return { ok: false, error: `Channel ${command.channelId} not found.` };
      }

      const invites = readChannelInvites(conversation.metadata);
      const target = invites.find((invite) => invite.id === command.inviteId);
      if (!target) {
        return { ok: false, error: `Invitation ${command.inviteId} not found.` };
      }

      // Revoking twice is not an error: the caller's intent already holds, and
      // the first revocation's timestamp is the truthful one.
      const revoked: ChannelInviteRecord = target.revokedAt !== undefined
        ? target
        : {
            ...target,
            revokedAt: command.revokedAt,
            revokedByActorId: command.revokedByActorId,
          };
      let latestParticipantIds = conversation.participantIds;
      if (revoked !== target) {
        const written = await this.writeInvites(
          conversation.id,
          invites.map((invite) => (invite.id === target.id ? revoked : invite)),
        );
        if (!written) {
          return { ok: false, error: `Channel ${command.channelId} not found.` };
        }
        latestParticipantIds = written.participantIds;
      }
      return {
        ok: true,
        invite: channelInvitePublicView(revoked, command.revokedAt),
        participantIds: latestParticipantIds,
      };
  });

  /**
   * Redeem an invitation for one already-running agent session.
   *
   * Redemption adds membership; it never creates an identity. The actor must
   * already be a registered agent, helper, bridge, or person in the broker.
   * An invitation that could mint a participant out of a bare token would be a
   * registration flow wearing an invitation's clothes.
   */
  readonly redeem = async (
    command: ChannelInviteRedeemCommand,
  ): Promise<ChannelInviteRedeemResult> =>
    this.runExclusive(command.channelId, async () => {
      const conversation = this.channelConversation(command.channelId);
      if (!conversation) {
        // Do not distinguish an unknown channel from an unknown token: both are
        // "this link is not valid" to anybody holding a bad token.
        const rejection = unknownChannelInviteRejection();
        return { ok: false, error: rejection.message, rejection };
      }

      const invites = readChannelInvites(conversation.metadata);
      const invite = findChannelInviteByTokenHash(invites, command.tokenHash);
      if (!invite) {
        const rejection = unknownChannelInviteRejection();
        return { ok: false, error: rejection.message, rejection };
      }

      const snapshot = this.deps.runtime.snapshot();
      const actorId = command.request.actorId?.trim() ?? "";
      const isRegistered = Boolean(snapshot.agents[actorId] || snapshot.actors[actorId]);
      if (!isRegistered) {
        return {
          ok: false,
          error: `${actorId || "That identity"} is not registered with this broker. Bring an agent session that is already running under Scout, then redeem again.`,
          rejection: {
            reason: "missing_identity",
            message: "The redeeming identity is not registered with this broker.",
          },
        };
      }

      const outcome = evaluateChannelInviteRedemption({
        invite,
        request: command.request,
        nowMs: command.redeemedAt,
      });
      if (!outcome.ok) {
        return { ok: false, error: outcome.rejection.message, rejection: outcome.rejection };
      }

      const additions = [
        actorId,
        ...(invite.invitee?.actorId ? [invite.invitee.actorId] : []),
      ];

      const removedRejection = {
        ok: false as const,
        error: "This membership was removed. Ask for a new invitation.",
        rejection: { reason: "membership_removed" as const, message: "This membership was removed. Ask for a new invitation." },
      };
      const blocked = (current: ConversationDefinition) => additions.some(id =>
        readChannelMemberRemoval(current.metadata, id)?.blockedInviteIds.includes(invite.id));
      if (blocked(conversation)) return removedRejection;
      let deniedByRemoval = false;

      if (outcome.existing) {
        // A retry can repair a partial roster, but explicit removals above block
        // old links. The redemption row, its timestamp, and the remaining slots stand. The
        // roster merge happens inside the durable writer so a concurrent
        // membership removal is not clobbered by this stale read.
        let participantIds = this.participantsWith(conversation, additions);
        const update = await this.deps.updateConversation(conversation.id, (current) => {
          if (!current) return null;
          if (blocked(current)) { deniedByRemoval = true; return null; }
          const next = this.participantsWith(current, additions);
          participantIds = next;
          if (next.join(",") === [...current.participantIds].sort().join(",")) {
            return null;
          }
          return { ...current, participantIds: next };
        });
        if (deniedByRemoval) return removedRejection;
        if (!update.conversation) {
          // The channel record vanished between validation and the write.
          const rejection = unknownChannelInviteRejection();
          return { ok: false, error: rejection.message, rejection };
        }
        return {
          ok: true,
          invite: channelInvitePublicView(invite, command.redeemedAt),
          redemption: outcome.existing,
          alreadyRedeemed: true,
          participantIds,
          conversationId: conversation.id,
        };
      }

      const redemption: ChannelInviteRedemption = {
        id: command.redemptionId,
        actorId,
        ...(command.request.agentId?.trim() ? { agentId: command.request.agentId.trim() } : {}),
        ...(command.request.sessionId?.trim() ? { sessionId: command.request.sessionId.trim() } : {}),
        ...(command.request.endpointId?.trim() ? { endpointId: command.request.endpointId.trim() } : {}),
        ...(command.request.nodeId?.trim() ? { nodeId: command.request.nodeId.trim() } : {}),
        ...(command.request.harness?.trim() ? { harness: command.request.harness.trim() } : {}),
        ...(command.request.projectRoot?.trim() ? { projectRoot: command.request.projectRoot.trim() } : {}),
        ...(command.request.displayName?.trim() ? { displayName: command.request.displayName.trim() } : {}),
        redeemedAt: command.redeemedAt,
      };

      const nextInvite: ChannelInviteRecord = {
        ...invite,
        redemptions: [...invite.redemptions, redemption],
      };
      // Roster and invites merge inside the durable writer against the latest
      // record: a retention membership removal (or any concurrent write)
      // queued ahead of this one must not be overwritten by the stale
      // `conversation` preimage read above.
      let participantIds = this.participantsWith(conversation, additions);
      const update = await this.deps.updateConversation(conversation.id, (current) => {
        if (!current) return null;
        if (blocked(current)) { deniedByRemoval = true; return null; }
        participantIds = this.participantsWith(current, additions);
        const baseInvites = readChannelInvites(current.metadata);
        const nextInvites = baseInvites.some((entry) => entry.id === invite.id)
          ? baseInvites.map((entry) => (entry.id === invite.id ? nextInvite : entry))
          : [...baseInvites, nextInvite];
        return {
          ...current,
          participantIds,
          metadata: {
            ...(current.metadata ?? {}),
            [CHANNEL_INVITES_METADATA_KEY]: nextInvites,
          },
        };
      });
      if (deniedByRemoval) return removedRejection;
      if (!update.conversation) {
        // The channel record vanished between validation and the write — the
        // redemption was never committed, so it must not be reported.
        const rejection = unknownChannelInviteRejection();
        return { ok: false, error: rejection.message, rejection };
      }

      return {
        ok: true,
        invite: channelInvitePublicView(nextInvite, command.redeemedAt),
        redemption,
        alreadyRedeemed: false,
        participantIds,
        conversationId: conversation.id,
      };
  });

  /** Read-only: every invitation on a channel, without any token digest. */
  readonly list = (channelId: string, nowMs: number): ChannelInvitePublicView[] => {
    const conversation = this.channelConversation(channelId);
    if (!conversation) return [];
    return readChannelInvites(conversation.metadata)
      .map((invite) => channelInvitePublicView(invite, nowMs))
      .sort((left, right) => right.createdAt - left.createdAt);
  };

  /**
   * Find the channel holding a token digest. Invitation links carry only the
   * token, so the doorway resolves the channel from the digest rather than
   * trusting a channel id supplied alongside it.
   */
  readonly findChannelForTokenHash = (tokenHash: string): {
    conversation: ConversationDefinition;
    invite: ChannelInviteRecord;
  } | null => {
    const normalized = tokenHash.trim().toLowerCase();
    if (!normalized) return null;
    const snapshot = this.deps.runtime.snapshot();
    for (const conversation of Object.values(snapshot.conversations)) {
      const invite = findChannelInviteByTokenHash(
        readChannelInvites(conversation.metadata),
        normalized,
      );
      if (invite) return { conversation, invite };
    }
    return null;
  };

  private channelConversation(channelId: string): ConversationDefinition | null {
    const conversation = this.deps.runtime.snapshot().conversations[channelId.trim()];
    if (!conversation) return null;
    // Invitations are a channel affordance. A direct message has no roster to
    // join, and a thread inherits its parent's membership.
    return conversation.kind === "channel" ? conversation : null;
  }

  private participantsWith(
    conversation: ConversationDefinition,
    additions: string[],
  ): string[] {
    return [...new Set([
      ...conversation.participantIds,
      ...additions.map((value) => value.trim()).filter(Boolean),
    ])].sort();
  }

  /**
   * Write the invite set through the canonical writer: the metadata merge runs
   * against the latest record inside the durable write, so fields this service
   * does not own (roster included) are preserved as they are at write time.
   * Returns the committed/current record, or null when the channel record is
   * gone — callers must treat null as failure rather than report a mutation
   * that never reached the journal.
   */
  private async writeInvites(
    channelId: string,
    invites: ChannelInviteRecord[],
  ): Promise<ConversationDefinition | null> {
    const result = await this.deps.updateConversation(channelId, (current) => {
      if (!current) return null;
      return {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          [CHANNEL_INVITES_METADATA_KEY]: invites,
        },
      };
    });
    return result.conversation;
  }
}
