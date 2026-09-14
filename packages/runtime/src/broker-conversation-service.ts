import {
  conversationNaturalKey,
  conversationsWithNaturalKey,
  directChannelNaturalKey,
  namedChannelNaturalKey,
  stableChannelId,
  systemChannelNaturalKey,
  type ActorIdentity,
  type ConversationDefinition,
} from "@openscout/protocol";

import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import {
  brokerActorDisplayName,
  findConversationByIdentity,
  resolveConversationShareMode,
  titleCaseName,
} from "./broker-conversation-helpers.js";
import { isOperatorTitled, resolveConversationTitle } from "./conversation-title.js";

export type BrokerConversationRuntime = {
  snapshot(): RuntimeSnapshot;
};

export type BrokerConversationServiceDeps = {
  nodeId: string;
  operatorActorId: string;
  dispatcherAgentId: string;
  runtime: BrokerConversationRuntime;
  operatorDisplayName: () => string;
  createChannelId: () => string;
  upsertActor: (actor: ActorIdentity) => Promise<void>;
  upsertConversation: (conversation: ConversationDefinition) => Promise<void>;
};

export class BrokerConversationService {
  constructor(private readonly deps: BrokerConversationServiceDeps) {}

  readonly ensureActorForDelivery = async (actorId: string): Promise<void> => {
    const snapshot = this.deps.runtime.snapshot();
    const existingActor = snapshot.actors[actorId];
    const displayName = actorId === this.deps.operatorActorId
      ? this.deps.operatorDisplayName()
      : titleCaseName(actorId);

    if (existingActor || snapshot.agents[actorId]) {
      if (actorId === this.deps.operatorActorId
        && existingActor
        && existingActor.displayName !== displayName) {
        await this.deps.upsertActor({
          ...existingActor,
          kind: "person",
          displayName,
          handle: existingActor.handle || actorId,
          labels: existingActor.labels ?? ["scout"],
          metadata: existingActor.metadata ?? { source: "broker-deliver" },
        });
      }
      return;
    }

    await this.deps.upsertActor({
      id: actorId,
      kind: actorId === this.deps.operatorActorId ? "person" : "agent",
      displayName,
      handle: actorId,
      labels: ["scout"],
      metadata: { source: "broker-deliver" },
    });
  };

  readonly ensureDeliveryConversation = async (input: {
    requesterId: string;
    targetAgentId?: string;
    channel?: string;
  }): Promise<ConversationDefinition> => {
    const snapshot = this.deps.runtime.snapshot();
    const normalizedChannel = input.channel?.trim();
    const targetAgentId = input.targetAgentId?.trim();

    if (!normalizedChannel && targetAgentId) {
      return await this.ensureDirectConversation(snapshot, input.requesterId, targetAgentId);
    }

    if (!normalizedChannel) {
      throw new Error("Delivery requires an explicit target or channel; use scout broadcast to tell everyone.");
    }

    return await this.ensureChannelConversation(snapshot, {
      requesterId: input.requesterId,
      targetAgentId,
      // Keep the explicit legacy wire selector, but never feed the retired room.
      channel: normalizedChannel === "shared" ? "broadcast" : normalizedChannel,
    });
  };

  private async ensureDirectConversation(
    snapshot: RuntimeSnapshot,
    requesterId: string,
    targetAgentId: string,
  ): Promise<ConversationDefinition> {
    const participantIds = [...new Set([requesterId, targetAgentId])].sort();
    const shareMode = resolveConversationShareMode(snapshot, participantIds, "local", this.deps.nodeId);
    const naturalKey = directChannelNaturalKey(participantIds);
    const existing = findConversationByIdentity(snapshot, naturalKey);
    const conversationId = existing?.id ?? this.deps.createChannelId();
    const alreadyMatches = existing
      && existing.kind === "direct"
      && existing.visibility === "private"
      && existing.shareMode === shareMode
      && existing.participantIds.join("\u0000") === participantIds.join("\u0000");
    if (alreadyMatches) {
      return existing;
    }

    const nonOperatorParticipants = participantIds.filter((participantId) => participantId !== this.deps.operatorActorId);
    const conversationTitle = requesterId === this.deps.operatorActorId || targetAgentId === this.deps.operatorActorId
      ? this.actorDisplayName(snapshot, nonOperatorParticipants[0] ?? targetAgentId)
      : `${this.actorDisplayName(snapshot, requesterId)} <> ${this.actorDisplayName(snapshot, targetAgentId)}`;
    const conversation: ConversationDefinition = {
      id: conversationId,
      kind: "direct",
      /* Automatic naming defers to a human one. Without this, re-deriving the
         conversation — a share-mode flip, a participant change — silently
         undoes a rename. */
      title: resolveConversationTitle({
        derived: targetAgentId === this.deps.dispatcherAgentId && requesterId === this.deps.operatorActorId
          ? "Scout"
          : conversationTitle,
        existingTitle: existing?.title,
        existingMetadata: existing?.metadata,
      }),
      visibility: "private",
      shareMode,
      authorityNodeId: this.deps.nodeId,
      participantIds,
      metadata: {
        surface: "broker",
        naturalKey,
        ...(targetAgentId === this.deps.dispatcherAgentId && requesterId === this.deps.operatorActorId ? { role: "partner" } : {}),
        /* The rename mark rides on metadata, and this object replaces it
           wholesale — carry it or the guard above has nothing to read next
           time. */
        ...(isOperatorTitled(existing?.metadata)
          ? { titleSource: existing!.metadata!.titleSource, titleSetAt: existing!.metadata!.titleSetAt }
          : {}),
      },
    };
    await this.deps.upsertConversation(conversation);
    return conversation;
  }

  private async ensureChannelConversation(
    snapshot: RuntimeSnapshot,
    input: {
      requesterId: string;
      targetAgentId?: string;
      channel: string;
    },
  ): Promise<ConversationDefinition> {
    const broadcastParticipants = input.channel === "broadcast" ? [...new Set([
      this.deps.operatorActorId,
      input.requesterId,
      ...Object.values(snapshot.endpoints)
        .filter((endpoint) => endpoint.state !== "offline" && snapshot.agents[endpoint.agentId])
        .map((endpoint) => endpoint.agentId),
    ])].sort() : [];
    const scopedParticipants = [...new Set([
      this.deps.operatorActorId,
      input.requesterId,
      ...(input.targetAgentId ? [input.targetAgentId] : []),
    ])].sort();
    const systemParticipants = [...new Set([
      this.deps.operatorActorId,
      input.requesterId,
    ])].sort();

    const definition = this.channelDefinition(snapshot, {
      channel: input.channel,
      broadcastParticipants,
      scopedParticipants,
      systemParticipants,
    });
    const existing = snapshot.conversations[definition.id];
    const naturalKey = conversationNaturalKey(definition);
    const equivalentConversations = naturalKey
      ? conversationsWithNaturalKey(Object.values(snapshot.conversations), naturalKey)
      : [];
    // Broadcast membership is a send-time snapshot, not an accumulating roster.
    const nextParticipants = input.channel === "broadcast" ? definition.participantIds : [...new Set([
      ...equivalentConversations.flatMap((conversation) => conversation.participantIds),
      ...definition.participantIds,
    ])].sort();
    if (
      existing
      && existing.kind === definition.kind
      && existing.visibility === definition.visibility
      && existing.shareMode === definition.shareMode
      && existing.participantIds.join("\u0000") === nextParticipants.join("\u0000")
    ) {
      return existing;
    }

    const conversation: ConversationDefinition = {
      ...definition,
      participantIds: nextParticipants,
    };
    await this.deps.upsertConversation(conversation);
    return conversation;
  }

  private channelDefinition(
    snapshot: RuntimeSnapshot,
    input: {
      channel: string;
      broadcastParticipants: string[];
      scopedParticipants: string[];
      systemParticipants: string[];
    },
  ): ConversationDefinition {
    if (input.channel === "voice") {
      const naturalKey = namedChannelNaturalKey("voice");
      return {
        id: stableChannelId(naturalKey),
        kind: "channel",
        title: "voice",
        visibility: "workspace",
        shareMode: resolveConversationShareMode(snapshot, input.scopedParticipants, "local", this.deps.nodeId),
        authorityNodeId: this.deps.nodeId,
        participantIds: input.scopedParticipants,
        metadata: {
          surface: "broker",
          channel: "voice",
          naturalKey,
        },
      };
    }

    if (input.channel === "system") {
      const naturalKey = systemChannelNaturalKey("system");
      return {
        id: stableChannelId(naturalKey),
        kind: "system",
        title: "system",
        visibility: "system",
        shareMode: "local",
        authorityNodeId: this.deps.nodeId,
        participantIds: input.systemParticipants,
        metadata: {
          surface: "broker",
          channel: "system",
          naturalKey,
        },
      };
    }

    if (input.channel === "broadcast") {
      const naturalKey = namedChannelNaturalKey("broadcast");
      return {
        id: stableChannelId(naturalKey),
        kind: "channel",
        title: "broadcast",
        visibility: "workspace",
        shareMode: "shared",
        authorityNodeId: this.deps.nodeId,
        participantIds: input.broadcastParticipants,
        metadata: {
          surface: "broker",
          channel: "broadcast",
          naturalKey,
        },
      };
    }

    const naturalKey = namedChannelNaturalKey(input.channel);
    return {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: input.channel,
      visibility: "workspace",
      shareMode: resolveConversationShareMode(snapshot, input.scopedParticipants, "local", this.deps.nodeId),
      authorityNodeId: this.deps.nodeId,
      participantIds: input.scopedParticipants,
      metadata: {
        surface: "broker",
        channel: input.channel,
        naturalKey,
      },
    };
  }

  private actorDisplayName(snapshot: RuntimeSnapshot, actorId: string): string {
    return brokerActorDisplayName(snapshot, actorId, {
      operatorActorId: this.deps.operatorActorId,
      operatorDisplayName: this.deps.operatorDisplayName(),
    });
  }
}
