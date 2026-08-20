import type {
  AgentDefinition,
  ConversationDefinition,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import {
  completedFlightFromBrokerReply,
  messageAnswersInvocation,
  messageVisibilityForConversation,
} from "./broker-conversation-helpers.js";
import type {
  MeshMessageAuthorityForwardResult,
  PeerForwardResult,
} from "./broker-mesh-forwarding-service.js";
import {
  isWorkingFlightState,
  shouldNotifyInvocationRequester,
} from "./broker-local-invocation-helpers.js";

export type BrokerMessageRuntime = {
  peek(): { messages: Record<string, MessageRecord> };
  snapshot(): { invocations: Record<string, InvocationRequest> };
  conversation(conversationId: string): ConversationDefinition | undefined;
  agent(agentId: string): AgentDefinition | undefined;
  flightForInvocation(invocationId: string): FlightRecord | undefined;
};

export type BrokerMessageMesh = {
  authorityNodeForConversation(conversationId: string): {
    conversation: ConversationDefinition;
    authorityNode: NodeDefinition;
  } | null;
  forwardConversationMessageToAuthority(message: MessageRecord): Promise<MeshMessageAuthorityForwardResult>;
  forwardPeerBrokerDeliveries(
    message: MessageRecord,
    deliveries: DeliveryIntent[],
  ): Promise<PeerForwardResult>;
};

export type BrokerMessageServiceDeps = {
  nodeId: string;
  systemActorId: string;
  runtime: BrokerMessageRuntime;
  mesh: BrokerMessageMesh;
  createId: (prefix: string) => string;
  recordMessage: (
    message: MessageRecord,
    options?: { enqueueProjection?: boolean },
  ) => Promise<{ deliveries: DeliveryIntent[]; entries: BrokerJournalEntry[] }>;
  applyProjectedEntries: (entries: BrokerJournalEntry[]) => Promise<void>;
  reconcileStaleLocalDeliveries: () => Promise<void>;
  persistFlight: (flight: FlightRecord) => Promise<void>;
  activeLocalEndpointForAgent: (agentId: string) => unknown;
};

function clientMessageId(message: MessageRecord): string | null {
  const value = message.metadata?.clientMessageId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isIdempotentMessageRetry(
  existing: MessageRecord,
  incoming: MessageRecord,
): boolean {
  const existingClientId = clientMessageId(existing);
  return Boolean(
    existingClientId
    && existingClientId === clientMessageId(incoming)
    && existing.conversationId === incoming.conversationId
    && existing.actorId === incoming.actorId
    && existing.class === incoming.class
    && existing.body === incoming.body
    && (existing.replyToMessageId ?? null) === (incoming.replyToMessageId ?? null)
    && (existing.threadConversationId ?? null) === (incoming.threadConversationId ?? null)
    && JSON.stringify(existing.mentions ?? []) === JSON.stringify(incoming.mentions ?? [])
    && JSON.stringify(existing.attachments ?? []) === JSON.stringify(incoming.attachments ?? [])
    && JSON.stringify(existing.speech ?? null) === JSON.stringify(incoming.speech ?? null)
  );
}

export class BrokerMessageService {
  constructor(private readonly deps: BrokerMessageServiceDeps) {}

  readonly postConversationMessage = async (
    message: MessageRecord,
  ): Promise<{
    ok: true;
    message: MessageRecord;
    deliveries: DeliveryIntent[];
    forwarded?: true;
    authorityNodeId?: string;
    duplicate?: boolean;
  }> => {
    const existing = this.deps.runtime.peek().messages[message.id];
    if (existing) {
      if (!isIdempotentMessageRetry(existing, message)) {
        throw new Error(`message id ${message.id} is already assigned to a different record`);
      }
      return {
        ok: true,
        message: existing,
        deliveries: [],
        duplicate: true,
      };
    }

    const authority = this.deps.mesh.authorityNodeForConversation(message.conversationId);
    if (authority) {
      const forwarded = await this.deps.mesh.forwardConversationMessageToAuthority(message);
      return {
        ok: true,
        message,
        deliveries: forwarded.deliveries ?? [],
        ...forwarded,
      };
    }

    const { deliveries, entries } = await this.deps.recordMessage(message, {
      enqueueProjection: false,
    });
    await this.deps.mesh.forwardPeerBrokerDeliveries(message, deliveries);
    await this.deps.applyProjectedEntries(entries);
    await this.deps.reconcileStaleLocalDeliveries();
    await this.completeInvocationsForBrokerReply(message);
    return { ok: true, message, deliveries };
  };

  readonly postInvocationStatusMessage = async (
    invocation: InvocationRequest,
    flight: {
      id?: string;
      summary?: string;
      error?: string;
    },
  ): Promise<void> => {
    if (!invocation.conversationId) {
      return;
    }

    const conversation = this.deps.runtime.conversation(invocation.conversationId);
    if (!conversation) {
      return;
    }

    const body = [flight.summary, flight.error]
      .filter((value): value is string => Boolean(value && value.trim().length > 0))
      .join("\n");
    if (!body) {
      return;
    }

    await this.postConversationMessage({
      id: this.deps.createId("msg"),
      conversationId: invocation.conversationId,
      actorId: this.deps.systemActorId,
      originNodeId: this.deps.nodeId,
      class: "status",
      body,
      replyToMessageId: invocation.messageId,
      ...(shouldNotifyInvocationRequester(invocation)
        ? { audience: { notify: [invocation.requesterId] } }
        : { audience: { delivery: "none" } }),
      visibility: messageVisibilityForConversation(conversation),
      policy: "durable",
      createdAt: Date.now(),
      metadata: {
        ...(flight.id ? { flightId: flight.id } : {}),
        invocationId: invocation.id,
        source: "broker",
        targetAgentId: invocation.targetAgentId,
      },
    });
  };

  readonly existingBrokerReplyForInvocation = (
    invocation: InvocationRequest,
    agentId: string,
    sinceMs: number,
  ): MessageRecord | null => {
    if (!invocation.conversationId || !invocation.messageId) {
      return null;
    }

    const since = Math.max(0, sinceMs - 5_000);
    const replies = Object.values(this.deps.runtime.peek().messages)
      .filter((message) =>
        message.conversationId === invocation.conversationId
        && message.replyToMessageId === invocation.messageId
        && message.actorId === agentId
        && message.class === "agent"
        && message.createdAt >= since
      )
      .sort((lhs, rhs) => rhs.createdAt - lhs.createdAt);

    return replies[0] ?? null;
  };

  readonly completeInvocationForBrokerReply = async (
    invocation: InvocationRequest,
    reply: MessageRecord,
  ): Promise<boolean> => {
    const flight = this.deps.runtime.flightForInvocation(invocation.id);
    if (!flight || !isWorkingFlightState(flight.state)) {
      return false;
    }
    const startedAt = flight.startedAt ?? invocation.createdAt;
    if (reply.createdAt < Math.max(0, startedAt - 5_000)) {
      return false;
    }

    await this.deps.persistFlight(completedFlightFromBrokerReply(
      invocation,
      flight,
      reply,
      this.deps.runtime.agent(invocation.targetAgentId)?.displayName,
    ));
    return true;
  };

  readonly completeInvocationsForBrokerReply = async (message: MessageRecord): Promise<void> => {
    if (message.class !== "agent" || !message.replyToMessageId || !message.body.trim()) {
      return;
    }

    const invocations = Object.values(this.deps.runtime.snapshot().invocations)
      .filter((invocation) => messageAnswersInvocation(message, invocation));
    for (const invocation of invocations) {
      await this.completeInvocationForBrokerReply(invocation, message);
    }
  };

  readonly onlineConversationNotifyTargets = (
    conversation: ConversationDefinition,
    requesterId: string,
  ): string[] => {
    return conversation.participantIds.filter((participantId) => {
      if (participantId === requesterId) {
        return false;
      }
      if (!this.deps.runtime.agent(participantId)) {
        return false;
      }
      return Boolean(this.deps.activeLocalEndpointForAgent(participantId));
    });
  };
}
