import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationEvent,
  CollaborationRecord,
  ConversationBinding,
  ConversationDefinition,
  ControlCommand,
  ControlEvent,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
} from "@openscout/protocol";
import type { RuntimeRegistrySnapshot } from "./registry.js";

export interface ControlRuntime {
  dispatch(command: ControlCommand): Promise<void>;
  snapshot(): RuntimeRegistrySnapshot;
  recentEvents(limit?: number): ControlEvent[];
  upsertNode(node: NodeDefinition): Promise<void>;
  upsertActor(actor: ActorIdentity): Promise<void>;
  upsertAgent(agent: AgentDefinition): Promise<void>;
  upsertEndpoint(endpoint: AgentEndpoint): Promise<void>;
  upsertConversation(conversation: ConversationDefinition): Promise<void>;
  upsertBinding(binding: ConversationBinding): Promise<void>;
  upsertFlight(flight: FlightRecord): Promise<void>;
  upsertCollaboration(record: CollaborationRecord): Promise<void>;
  appendCollaborationEvent(event: CollaborationEvent): Promise<void>;
  postMessage(message: MessageRecord, options?: { localOnly?: boolean }): Promise<DeliveryIntent[]>;
  invokeAgent(invocation: InvocationRequest): Promise<FlightRecord>;
  subscribe(listener: (event: ControlEvent) => void): () => void;
}
