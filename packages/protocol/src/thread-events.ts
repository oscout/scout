import type { CollaborationEvent, CollaborationRecord } from "./collaboration.js";
import type { MetadataMap, ScoutId } from "./common.js";
import type { ConversationDefinition } from "./conversations.js";
import type { FlightRecord } from "./invocations.js";
import type { MessageClass, MessageRecord } from "./messages.js";

export type ThreadEventKind =
  | "message.posted"
  | "flight.updated"
  | "collaboration.upserted"
  | "collaboration.event.appended"
  | "attention.requested"
  | "watch.reset_required";

export type ThreadWatchMode = "summary" | "shared";

export type ThreadNotificationTier = "interrupt" | "badge" | "silent";

export type ThreadNotificationReason =
  | "mention"
  | "thread_reply"
  | "next_move"
  | "flight_completed"
  | "flight_failed";

export interface ThreadEventNotification {
  tier: ThreadNotificationTier;
  targetActorIds?: ScoutId[];
  reason?: ThreadNotificationReason;
  summary: string;
}

export interface ThreadMessageSummary {
  id: ScoutId;
  actorId: ScoutId;
  class: MessageClass;
  replyToMessageId?: ScoutId;
  threadConversationId?: ScoutId;
  mentionActorIds: ScoutId[];
  createdAt: number;
  summary: string;
}

export interface ThreadFlightSummary {
  id: ScoutId;
  invocationId: ScoutId;
  requesterId: ScoutId;
  targetAgentId: ScoutId;
  state: FlightRecord["state"];
  summary?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ThreadCollaborationSummary {
  id: ScoutId;
  kind: CollaborationRecord["kind"];
  state: string;
  acceptanceState: CollaborationRecord["acceptanceState"];
  title: string;
  summary?: string;
  ownerId?: ScoutId;
  nextMoveOwnerId?: ScoutId;
  updatedAt: number;
}

export interface ThreadCollaborationEventSummary {
  id: ScoutId;
  recordId: ScoutId;
  recordKind: CollaborationEvent["recordKind"];
  kind: CollaborationEvent["kind"];
  actorId: ScoutId;
  at: number;
  summary?: string;
}

export type ThreadMessagePayload = {
  message: MessageRecord | ThreadMessageSummary;
};

export type ThreadFlightPayload = {
  flight: FlightRecord | ThreadFlightSummary;
};

export type ThreadCollaborationPayload = {
  record: CollaborationRecord | ThreadCollaborationSummary;
};

export type ThreadCollaborationEventPayload = {
  event: CollaborationEvent | ThreadCollaborationEventSummary;
};

export type ThreadAttentionPayload = {
  summary: string;
  metadata?: MetadataMap;
};

export type ThreadResetRequiredPayload = {
  reason: "cursor_out_of_range" | "lease_expired";
  latestSeq: number;
};

export type ThreadEventPayload =
  | ThreadMessagePayload
  | ThreadFlightPayload
  | ThreadCollaborationPayload
  | ThreadCollaborationEventPayload
  | ThreadAttentionPayload
  | ThreadResetRequiredPayload;

export interface ThreadEventEnvelope {
  id: ScoutId;
  conversationId: ScoutId;
  authorityNodeId: ScoutId;
  seq: number;
  kind: ThreadEventKind;
  actorId?: ScoutId;
  ts: number;
  payload: ThreadEventPayload;
  notification?: ThreadEventNotification;
}

export interface ThreadWatchOpenRequest {
  conversationId: ScoutId;
  watcherNodeId: ScoutId;
  watcherId: ScoutId;
  afterSeq?: number;
  leaseMs?: number;
}

export interface ThreadWatchOpenResponse {
  watchId: ScoutId;
  conversationId: ScoutId;
  authorityNodeId: ScoutId;
  acceptedAfterSeq: number;
  latestSeq: number;
  leaseExpiresAt: number;
  mode: ThreadWatchMode;
}

export interface ThreadWatchRenewRequest {
  watchId: ScoutId;
  leaseMs?: number;
}

export interface ThreadWatchRenewResponse {
  watchId: ScoutId;
  leaseExpiresAt: number;
}

export interface ThreadWatchCloseRequest {
  watchId: ScoutId;
  reason?: string;
}

export interface ThreadEventsReplayRequest {
  conversationId: ScoutId;
  afterSeq: number;
  limit?: number;
}

export interface ThreadSnapshotRequest {
  conversationId: ScoutId;
}

export type ThreadSnapshotMessage = MessageRecord | ThreadMessageSummary;
export type ThreadSnapshotCollaboration = CollaborationRecord | ThreadCollaborationSummary;
export type ThreadSnapshotFlight = FlightRecord | ThreadFlightSummary;

export interface ThreadSnapshot {
  conversation: ConversationDefinition;
  latestSeq: number;
  messages?: ThreadSnapshotMessage[];
  collaboration?: ThreadSnapshotCollaboration[];
  activeFlights?: ThreadSnapshotFlight[];
}

export interface LocalThreadCursor {
  conversationId: ScoutId;
  authorityNodeId: ScoutId;
  lastAppliedSeq: number;
  updatedAt: number;
}

export interface ThreadWatchError {
  code:
    | "no_responder"
    | "forbidden"
    | "unknown_conversation"
    | "lease_expired"
    | "cursor_out_of_range"
    | "invalid_request"
    | "internal";
  message: string;
}
