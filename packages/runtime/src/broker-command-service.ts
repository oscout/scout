import {
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type CollaborationEvent,
  type CollaborationRecord,
  type ControlCommand,
  type ConversationBinding,
  type ConversationDefinition,
  type DeliveryIntent,
  type MessageRecord,
  type NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type {
  MeshAuthorityForwardResult,
  MeshMessageAuthorityForwardResult,
  PeerForwardResult,
} from "./broker-mesh-forwarding-service.js";

export type BrokerCommandRuntime = {
  collaborationRecord(recordId: string): CollaborationRecord | undefined;
  dispatch(command: ControlCommand): Promise<void>;
};

export type BrokerCommandMesh = {
  authorityNodeForConversation(conversationId: string): unknown;
  forwardCollaborationRecordToAuthority(record: CollaborationRecord): Promise<MeshAuthorityForwardResult>;
  forwardPeerBrokerCollaborationRecord(record: CollaborationRecord): Promise<PeerForwardResult>;
  forwardCollaborationEventToAuthority(event: CollaborationEvent): Promise<MeshAuthorityForwardResult>;
  forwardPeerBrokerCollaborationEvent(event: CollaborationEvent): Promise<PeerForwardResult>;
  forwardConversationMessageToAuthority(message: MessageRecord): Promise<MeshMessageAuthorityForwardResult>;
  forwardPeerBrokerDeliveries(message: MessageRecord, deliveries: DeliveryIntent[]): Promise<PeerForwardResult>;
};

export type BrokerCommandServiceDeps = {
  runtime: BrokerCommandRuntime;
  mesh: BrokerCommandMesh;
  upsertNode: (node: NodeDefinition) => Promise<void>;
  upsertActor: (actor: ActorIdentity) => Promise<void>;
  upsertAgent: (agent: AgentDefinition) => Promise<void>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  upsertConversation: (conversation: ConversationDefinition) => Promise<void>;
  upsertBinding: (binding: ConversationBinding) => Promise<void>;
  recordCollaboration: (
    record: CollaborationRecord,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[]>;
  appendCollaborationEvent: (
    event: CollaborationEvent,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[]>;
  recordMessage: (
    message: MessageRecord,
    options?: { enqueueProjection?: boolean },
  ) => Promise<{ deliveries: DeliveryIntent[]; entries: BrokerJournalEntry[] }>;
  applyProjectedEntries: (entries: BrokerJournalEntry[]) => Promise<void>;
  reconcileStaleLocalDeliveries: () => Promise<void>;
  acceptAndDispatchInvocation: (
    invocation: Extract<ControlCommand, { kind: "agent.invoke" }>["invocation"],
    options: { includeOk: true; logAccepted: true },
  ) => Promise<unknown>;
  log?: (message: string) => void;
};

export class BrokerCommandService {
  constructor(private readonly deps: BrokerCommandServiceDeps) {}

  readonly execute = async (command: ControlCommand): Promise<unknown> => {
    switch (command.kind) {
      case "node.upsert":
        await this.deps.upsertNode(command.node);
        return { ok: true };
      case "actor.upsert":
        await this.deps.upsertActor(command.actor);
        return { ok: true };
      case "agent.upsert":
        await this.deps.upsertAgent(command.agent);
        return { ok: true };
      case "agent.endpoint.upsert":
        await this.deps.persistEndpoint(command.endpoint);
        return { ok: true };
      case "conversation.upsert":
        await this.deps.upsertConversation(command.conversation);
        return { ok: true };
      case "binding.upsert":
        await this.deps.upsertBinding(command.binding);
        return { ok: true };
      case "collaboration.upsert":
        return await this.executeCollaborationUpsert(command.record);
      case "collaboration.event.append":
        return await this.executeCollaborationEventAppend(command.event);
      case "conversation.post":
        return await this.executeConversationPost(command.message);
      case "agent.invoke":
        return await this.deps.acceptAndDispatchInvocation(command.invocation, {
          includeOk: true,
          logAccepted: true,
        });
      case "agent.ensure_awake":
        await this.deps.runtime.dispatch(command);
        return { ok: true };
      case "stream.subscribe":
        return { ok: true };
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  };

  private readonly executeCollaborationUpsert = async (
    record: CollaborationRecord,
  ): Promise<{
    ok: true;
    recordId: string;
    mesh: MeshAuthorityForwardResult | PeerForwardResult;
  }> => {
    if (record.conversationId) {
      const authority = this.deps.mesh.authorityNodeForConversation(record.conversationId);
      if (authority) {
        return {
          ok: true,
          recordId: record.id,
          mesh: await this.deps.mesh.forwardCollaborationRecordToAuthority(record),
        };
      }
    }

    const entries = await this.deps.recordCollaboration(record, {
      enqueueProjection: false,
    });
    const mesh = record.conversationId
      ? { forwarded: [], failed: [] }
      : await this.deps.mesh.forwardPeerBrokerCollaborationRecord(record);
    await this.deps.applyProjectedEntries(entries);
    return {
      ok: true,
      recordId: record.id,
      mesh,
    };
  };

  private readonly executeCollaborationEventAppend = async (
    event: CollaborationEvent,
  ): Promise<{
    ok: true;
    eventId: string;
    mesh: MeshAuthorityForwardResult | PeerForwardResult;
  }> => {
    const record = this.deps.runtime.collaborationRecord(event.recordId);
    if (record?.conversationId) {
      const authority = this.deps.mesh.authorityNodeForConversation(record.conversationId);
      if (authority) {
        return {
          ok: true,
          eventId: event.id,
          mesh: await this.deps.mesh.forwardCollaborationEventToAuthority(event),
        };
      }
    }

    const entries = await this.deps.appendCollaborationEvent(event, {
      enqueueProjection: false,
    });
    const mesh = record?.conversationId
      ? { forwarded: [], failed: [] }
      : await this.deps.mesh.forwardPeerBrokerCollaborationEvent(event);
    await this.deps.applyProjectedEntries(entries);
    return {
      ok: true,
      eventId: event.id,
      mesh,
    };
  };

  private readonly executeConversationPost = async (
    message: MessageRecord,
  ): Promise<{
    ok: true;
    message: MessageRecord;
    deliveries?: DeliveryIntent[];
    mesh: MeshMessageAuthorityForwardResult | PeerForwardResult;
  }> => {
    const authority = this.deps.mesh.authorityNodeForConversation(message.conversationId);
    if (authority) {
      return {
        ok: true,
        message,
        mesh: await this.deps.mesh.forwardConversationMessageToAuthority(message),
      };
    }

    const { deliveries, entries } = await this.deps.recordMessage(message, {
      enqueueProjection: false,
    });
    const mesh = await this.deps.mesh.forwardPeerBrokerDeliveries(message, deliveries);
    await this.deps.applyProjectedEntries(entries);
    await this.deps.reconcileStaleLocalDeliveries();
    this.deps.log?.(
      `[openscout-runtime] message ${message.id} posted by ${message.actorId} to ${message.conversationId} with ${deliveries.length} deliveries`,
    );
    return { ok: true, message, deliveries, mesh };
  };
}
