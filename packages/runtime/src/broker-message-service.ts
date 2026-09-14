import { isIdempotentMessageRetry } from "./broker-message-idempotency.js";
import { selectMessageRecordsAsync, readMessageRecord } from "./broker-message-records.js";
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
    options?: { enqueueProjection?: boolean; dedupeExisting?: boolean },
  ) => Promise<{ deliveries: DeliveryIntent[]; entries: BrokerJournalEntry[]; duplicate?: MessageRecord }>;
  applyProjectedEntries: (entries: BrokerJournalEntry[]) => Promise<void>;
  reconcileStaleLocalDeliveries: () => Promise<void>;
  persistFlight: (flight: FlightRecord) => Promise<void>;
  activeLocalEndpointForAgent: (agentId: string) => unknown;
};

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
    const existing = await readMessageRecord(this.deps.runtime.peek().messages,message.id);
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

    const { deliveries, entries, duplicate } = await this.deps.recordMessage(message, {
      enqueueProjection: false,
      dedupeExisting: true,
    });
    if (duplicate) return { ok: true, message: duplicate, deliveries: [], duplicate: true };
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

  readonly existingBrokerReplyForInvocation = async (
    invocation: InvocationRequest,
    agentId: string,
    sinceMs: number,
  ): Promise<MessageRecord | null> => {
    if (!invocation.conversationId || !invocation.messageId) {
      return null;
    }

    const since = Math.max(0, sinceMs - 5_000);
    const replies = await selectMessageRecordsAsync(this.deps.runtime.peek().messages, 1,
      (lhs, rhs) => rhs.createdAt - lhs.createdAt, (message) =>
        message.conversationId === invocation.conversationId
        && message.replyToMessageId === invocation.messageId
        && message.actorId === agentId
        && message.class === "agent"
        && message.createdAt >= since, {selection:{conversationIds:[invocation.conversationId],actorId:agentId,replyToMessageId:invocation.messageId,since,newestFirst:true}});

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
