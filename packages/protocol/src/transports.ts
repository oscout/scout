import type { DeliveryTransport, MetadataMap, ScoutId } from "./common.js";
import type { AgentDefinition, AgentEndpoint, ActorIdentity } from "./actors.js";
import type { ConversationBinding, ConversationDefinition } from "./conversations.js";
import type { InvocationRequest } from "./invocations.js";
import type { NodeDefinition } from "./mesh.js";
import type { MessageRecord } from "./messages.js";
import type { CollaborationEvent, CollaborationRecord } from "./collaboration.js";

export interface SubscriptionRequest {
  actorId: ScoutId;
  conversationIds?: ScoutId[];
  flightIds?: ScoutId[];
  eventKinds?: string[];
}

export interface PostMessageCommand {
  kind: "conversation.post";
  message: MessageRecord;
}

export interface InvokeAgentCommand {
  kind: "agent.invoke";
  invocation: InvocationRequest;
}

export interface EnsureAwakeCommand {
  kind: "agent.ensure_awake";
  agentId: ScoutId;
  requesterId: ScoutId;
  reason: string;
  metadata?: MetadataMap;
}

export interface SubscribeCommand {
  kind: "stream.subscribe";
  subscription: SubscriptionRequest;
  transport: Extract<DeliveryTransport, "local_socket" | "websocket">;
}

export interface NodeUpsertCommand {
  kind: "node.upsert";
  node: NodeDefinition;
}

export interface ActorUpsertCommand {
  kind: "actor.upsert";
  actor: ActorIdentity;
}

export interface AgentUpsertCommand {
  kind: "agent.upsert";
  agent: AgentDefinition;
}

export interface AgentEndpointUpsertCommand {
  kind: "agent.endpoint.upsert";
  endpoint: AgentEndpoint;
}

export interface ConversationUpsertCommand {
  kind: "conversation.upsert";
  conversation: ConversationDefinition;
}

export interface BindingUpsertCommand {
  kind: "binding.upsert";
  binding: ConversationBinding;
}

export interface CollaborationUpsertCommand {
  kind: "collaboration.upsert";
  record: CollaborationRecord;
}

export interface CollaborationEventAppendCommand {
  kind: "collaboration.event.append";
  event: CollaborationEvent;
}

export type ControlCommand =
  | NodeUpsertCommand
  | ActorUpsertCommand
  | AgentUpsertCommand
  | AgentEndpointUpsertCommand
  | ConversationUpsertCommand
  | BindingUpsertCommand
  | CollaborationUpsertCommand
  | CollaborationEventAppendCommand
  | PostMessageCommand
  | InvokeAgentCommand
  | EnsureAwakeCommand
  | SubscribeCommand;
