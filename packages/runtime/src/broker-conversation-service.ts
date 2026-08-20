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

    return await this.ensureChannelConversation(snapshot, {
      requesterId: input.requesterId,
      targetAgentId,
      channel: normalizedChannel || "shared",
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
      title: targetAgentId === this.deps.dispatcherAgentId && requesterId === this.deps.operatorActorId ? "Scout" : conversationTitle,
      visibility: "private",
      shareMode,
      authorityNodeId: this.deps.nodeId,
      participantIds,
      metadata: {
        surface: "broker",
        naturalKey,
        ...(targetAgentId === this.deps.dispatcherAgentId && requesterId === this.deps.operatorActorId ? { role: "partner" } : {}),
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
    const sharedParticipants = [...new Set([
      this.deps.operatorActorId,
      input.requesterId,
      ...Object.keys(snapshot.agents),
    ])].sort();
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
      sharedParticipants,
      scopedParticipants,
      systemParticipants,
    });
    const existing = snapshot.conversations[definition.id];
    const naturalKey = conversationNaturalKey(definition);
    const equivalentConversations = naturalKey
      ? conversationsWithNaturalKey(Object.values(snapshot.conversations), naturalKey)
      : [];
    const nextParticipants = [...new Set([
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
      sharedParticipants: string[];
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

    if (input.channel === "shared") {
      const naturalKey = namedChannelNaturalKey("shared");
      return {
        id: stableChannelId(naturalKey),
        kind: "channel",
        title: "shared-channel",
        visibility: "workspace",
        shareMode: "shared",
        authorityNodeId: this.deps.nodeId,
        participantIds: input.sharedParticipants,
        metadata: {
          surface: "broker",
          channel: "shared",
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
