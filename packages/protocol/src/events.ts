import type { ScoutId } from "./common.js";
import type { NodeDefinition } from "./mesh.js";
import type { ConversationBinding, ConversationDefinition } from "./conversations.js";
import type { DeliveryAttempt, DeliveryIntent } from "./deliveries.js";
import type { FlightRecord, InvocationRequest } from "./invocations.js";
import type { MessageRecord } from "./messages.js";
import type { ConversationReadCursor } from "./read-receipts.js";
import type { AgentDefinition, AgentEndpoint, ActorIdentity } from "./actors.js";
import type { CollaborationEvent, CollaborationRecord } from "./collaboration.js";
import type { ScoutDispatchRecord } from "./scout-dispatch.js";

export const OPENSCOUT_CONTROL_EVENT_VERSION = 1 as const;

export interface ControlEventBase<K extends string, P> {
  id: ScoutId;
  kind: K;
  ts: number;
  actorId: ScoutId;
  nodeId?: ScoutId;
  /**
   * Schema version of the control-event envelope. Optional by design: legacy
   * persisted events pre-date the version field and carry no `v`, yet must
   * still satisfy this type so they can be replayed. After
   * {@link normalizeControlEvent}, `v` is always present.
   */
  readonly v?: typeof OPENSCOUT_CONTROL_EVENT_VERSION;
  payload: P;
}

export type NodeUpsertedEvent = ControlEventBase<"node.upserted", {
  node: NodeDefinition;
}>;

export type ActorRegisteredEvent = ControlEventBase<"actor.registered", {
  actor: ActorIdentity;
}>;

export type AgentRegisteredEvent = ControlEventBase<"agent.registered", {
  agent: AgentDefinition;
}>;

export type AgentEndpointUpsertedEvent = ControlEventBase<"agent.endpoint.upserted", {
  endpoint: AgentEndpoint;
}>;

export type AgentEndpointDeletedEvent = ControlEventBase<"agent.endpoint.deleted", {
  endpointId: string;
}>;

export type ConversationUpsertedEvent = ControlEventBase<"conversation.upserted", {
  conversation: ConversationDefinition;
}>;

export type BindingUpsertedEvent = ControlEventBase<"binding.upserted", {
  binding: ConversationBinding;
}>;

export type MessagePostedEvent = ControlEventBase<"message.posted", {
  message: MessageRecord;
}>;

export type ConversationReadCursorUpdatedEvent = ControlEventBase<"conversation.read_cursor.updated", {
  cursor: ConversationReadCursor;
}>;

export type InvocationRequestedEvent = ControlEventBase<"invocation.requested", {
  invocation: InvocationRequest;
}>;

export type FlightUpdatedEvent = ControlEventBase<"flight.updated", {
  flight: FlightRecord;
}>;

export type DeliveryPlannedEvent = ControlEventBase<"delivery.planned", {
  delivery: DeliveryIntent;
}>;

export type DeliveryAttemptedEvent = ControlEventBase<"delivery.attempted", {
  attempt: DeliveryAttempt;
}>;

export type DeliveryStateChangedEvent = ControlEventBase<"delivery.state.changed", {
  delivery: DeliveryIntent;
  previousStatus?: DeliveryIntent["status"];
}>;

export type CollaborationUpsertedEvent = ControlEventBase<"collaboration.upserted", {
  record: CollaborationRecord;
}>;

export type CollaborationEventAppendedEvent = ControlEventBase<"collaboration.event.appended", {
  event: CollaborationEvent;
}>;

export type ScoutDispatchedEvent = ControlEventBase<"scout.dispatched", {
  dispatch: ScoutDispatchRecord;
}>;

export type ControlEvent =
  | NodeUpsertedEvent
  | ActorRegisteredEvent
  | AgentRegisteredEvent
  | AgentEndpointUpsertedEvent
  | AgentEndpointDeletedEvent
  | ConversationUpsertedEvent
  | BindingUpsertedEvent
  | MessagePostedEvent
  | ConversationReadCursorUpdatedEvent
  | InvocationRequestedEvent
  | FlightUpdatedEvent
  | DeliveryPlannedEvent
  | DeliveryAttemptedEvent
  | DeliveryStateChangedEvent
  | CollaborationUpsertedEvent
  | CollaborationEventAppendedEvent
  | ScoutDispatchedEvent;

/**
 * Stamp the current envelope version onto a control event when it is missing.
 *
 * The `v` field is optional on {@link ControlEventBase} so that legacy events
 * persisted before versioning existed still satisfy the type (the package
 * deliberately preserves legacy shapes for replay). This helper is the bridge:
 * use it on the stamp-on-write path so newly produced events carry `v`, and on
 * the normalize-on-read path so replayed legacy events are upgraded to the
 * current version. It is a pure function — the input is never mutated.
 */
export function normalizeControlEvent<E extends ControlEvent>(
  event: E,
): E & { v: typeof OPENSCOUT_CONTROL_EVENT_VERSION } {
  return { ...event, v: event.v ?? OPENSCOUT_CONTROL_EVENT_VERSION };
}
