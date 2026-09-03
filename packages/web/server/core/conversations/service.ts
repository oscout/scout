import type {
  ActorKind,
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  ConversationKind,
  ConversationProjectionSnapshot,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  ScoutExecutionResolution,
} from "@openscout/protocol";
import {
  conversationNaturalKey,
  conversationsWithNaturalKey,
  epochMs,
  isOpaqueChannelId,
  stableChannelId,
} from "@openscout/protocol";
import { configuredOperatorActorIds } from "@openscout/runtime/conversations/legacy-ids";

import {
  loadScoutBrokerContext,
  type ScoutBrokerContext,
  type ScoutBrokerSnapshot,
} from "../broker/service.ts";
import {
  MessageCursorError,
  clampMessagePageLimit,
  compareMessagesAsc,
  parseMessageHistoryCursor,
  type MessageOrderKey,
} from "../../../shared/message-pagination.ts";

export type ScoutConversationListFilters = {
  query?: string;
  limit?: number;
  kinds?: ConversationKind[];
  conversationId?: string;
  machineId?: string;
};

/// Per-conversation ask signal surfaced to the comms list. `state` is "pending"
/// while the originating agent is still blocked on the operator, and "answered"
/// once the most recent ask in this conversation has been resolved. The UI only
/// renders a chip/band while pending — an answered ask is resolved, so a chip
/// there would be noise.
export type ScoutConversationAsk = {
  from: string;
  text: string;
  state: "pending" | "answered";
};

export type ScoutConversationTurn = {
  messageId: string;
  invocationId: string | null;
  flightId: string | null;
  from: string;
  text: string;
  state: "queued" | "working" | "waiting" | "completed" | "failed" | "replied";
  nextMoveOwner: "agent" | "operator" | "none";
  updatedAt: number;
};

export type ScoutConversationParticipant = {
  actorId: string;
  kind: string;
  displayName: string;
  label: string;
  scopedAlias: string | null;
  agentId: string | null;
  sessionId: string | null;
  harness: string | null;
  model: string | null;
  reasoningEffort: string | null;
  transport: string | null;
  workspaceRoot: string | null;
};

export type ScoutConversationSummary = {
  id: string;
  chatId: string;
  equivalentConversationIds: string[];
  kind: string;
  title: string;
  alias?: string | null;
  naturalKey?: string | null;
  /// Complete roster, including members whose rich record is omitted below.
  participantIds: string[];
  /// May be capped for large non-direct rosters; kept records align with the
  /// leading entries in `participantIds`.
  participants: ScoutConversationParticipant[];
  /// True total participant count, even when `participants` is capped.
  participantCount: number;
  authorityNodeId: string | null;
  authorityNodeName: string | null;
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  model: string | null;
  reasoningEffort: string | null;
  transport: string | null;
  sessionId: string | null;
  currentBranch: string | null;
  parentConversationId: string | null;
  anchorMessageId: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  workspaceRoot: string | null;
  /// Messages the operator has not yet read in this conversation. Always present;
  /// 0 means fully read (or we cannot determine a read position yet).
  unreadCount: number;
  /// Best-effort per-conversation ask, omitted entirely when there is no signal.
  ask?: ScoutConversationAsk;
  /// Rebuildable status of the latest operator turn that requested a reply.
  turn?: ScoutConversationTurn;
};

/**
 * Compact list adapter for the durable conversation projection. List surfaces
 * can keep using these rows after broker startup; selected-conversation reads
 * load the richer roster, ask, and turn detail separately.
 */
export function provisionalScoutConversations(
  snapshot: ConversationProjectionSnapshot,
  filters: ScoutConversationListFilters = {},
): ScoutConversationSummary[] {
  const allowedKinds = new Set(filters.kinds ?? DEFAULT_CONVERSATION_KINDS);
  const query = normalizeQuery(filters.query);
  const limit = Math.max(1, Math.floor(filters.limit ?? snapshot.items.length));

  return snapshot.items
    .filter((item) => (
      item.entityKind === "scout_conversation"
      && item.visibilityState === "visible"
      && Boolean(item.conversationId)
      && allowedKinds.has(item.kind as ConversationKind)
    ))
    .filter((item) => !query || [
      item.title,
      item.alias,
      item.agentName,
      item.preview,
      item.projectRoot,
    ].some((value) => value?.toLocaleLowerCase().includes(query)))
    .slice(0, limit)
    .map((item): ScoutConversationSummary => {
      const conversationId = item.conversationId!;
      const participantIds = item.kind === "direct" && item.agentId
        ? ["operator", item.agentId]
        : [];
      return {
        id: conversationId,
        chatId: conversationId,
        equivalentConversationIds: [conversationId],
        kind: item.kind,
        title: item.title ?? item.agentName ?? item.alias ?? conversationId,
        alias: item.alias,
        naturalKey: item.naturalKey,
        participantIds,
        participants: [],
        participantCount: item.participantCount,
        authorityNodeId: item.authorityNodeId,
        authorityNodeName: item.authorityNodeName,
        agentId: item.agentId,
        agentName: item.agentName,
        harness: item.harness,
        model: item.model,
        reasoningEffort: item.effort,
        transport: null,
        sessionId: item.runtimeSessionId,
        currentBranch: item.currentBranch,
        parentConversationId: item.parentConversationId,
        anchorMessageId: item.anchorMessageId,
        preview: item.preview,
        messageCount: item.messageCount,
        lastMessageAt: item.lastMessageAt,
        workspaceRoot: item.projectRoot,
        unreadCount: item.unreadCount,
      };
    });
}

export type ScoutConversationMessage = {
  id: string;
  conversationId: string;
  actorId: string;
  actorName: string;
  body: string;
  createdAt: number;
  class: MessageRecord["class"];
  metadata: MessageRecord["metadata"] | null;
  replyToMessageId: string | null;
  threadConversationId: string | null;
  attachments: NonNullable<MessageRecord["attachments"]>;
  threadSummary?: {
    count: number;
    participants: string[];
    lastActiveAt: number;
  };
};

const DEFAULT_CONVERSATION_KINDS: ConversationKind[] = [
  "direct",
  "channel",
  "group_direct",
  "thread",
];

const SCOPED_ALIAS_POOL = [
  "Curie",
  "Dewey",
  "Turing",
  "Noether",
  "Lovelace",
  "Hopper",
  "Franklin",
  "Faraday",
  "Tesla",
  "Newton",
  "Darwin",
  "Ada",
  "Sagan",
  "Feynman",
  "Bohr",
  "Kepler",
];

function normalizeTimestamp(value: number | null | undefined): number | null {
  const ms = epochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

function normalizeTimestampMs(value: number | null | undefined): number | null {
  return epochMs(value);
}

function normalizeMetadataTimestamp(value: unknown): number {
  const ms = epochMs(value);
  return ms === null ? 0 : Math.floor(ms / 1000);
}

function endpointStateRank(endpoint: AgentEndpoint): number {
  switch (endpoint.state) {
    case "active": return 5;
    case "waiting": return 4;
    case "idle": return 3;
    default: return 0;
  }
}

function endpointActivity(endpoint: AgentEndpoint): number {
  return Math.max(
    normalizeMetadataTimestamp(endpoint.metadata?.lastCompletedAt),
    normalizeMetadataTimestamp(endpoint.metadata?.lastStartedAt),
    normalizeMetadataTimestamp(endpoint.metadata?.lastFailedAt),
    normalizeMetadataTimestamp(endpoint.metadata?.staleAt),
    normalizeMetadataTimestamp(endpoint.metadata?.startedAt),
  );
}

function endpointStartedAt(endpoint: AgentEndpoint): number {
  return Math.max(
    normalizeMetadataTimestamp(endpoint.metadata?.lastStartedAt),
    normalizeMetadataTimestamp(endpoint.metadata?.startedAt),
  );
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataTimestampMs(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" ? normalizeTimestampMs(value) : null;
}

function metadataObject(
  metadata: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metadataSessionId(metadata: Record<string, unknown> | undefined): string | null {
  return metadataString(metadata, "targetSessionId")
    ?? metadataString(metadata, "responderSessionId")
    ?? metadataString(metadata, "sessionId")
    ?? metadataString(metadata, "externalSessionId")
    ?? metadataString(metadata, "threadId")
    ?? metadataString(metadataObject(metadata, "returnAddress"), "sessionId");
}

function executionResolutionDimension(
  resolution: ScoutExecutionResolution | null | undefined,
  dimension: "harness" | "model" | "reasoningEffort",
): string | null {
  const value = resolution?.[dimension];
  return value?.observed?.trim()
    || value?.resolved?.trim()
    || value?.requested?.trim()
    || null;
}

type ScoutConversationRuntime = {
  harness: string | null;
  model: string | null;
  reasoningEffort: string | null;
  transport: string | null;
};

function executionResolutionFromUnknown(value: unknown): ScoutExecutionResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const resolution = value as Partial<ScoutExecutionResolution>;
  return resolution.schemaVersion === "openscout.execution-resolution.v1"
    ? resolution as ScoutExecutionResolution
    : null;
}

function flightSessionRuntime(
  flights: FlightRecord[],
  sessionId: string | null,
): { resolution: ScoutExecutionResolution | null; harness: string | null; transport: string | null } | null {
  for (const flight of [...flights].reverse()) {
    const rawTrace = flight.metadata?.sessionTrace;
    if (!Array.isArray(rawTrace)) continue;
    const entries = [...rawTrace].reverse();
    const candidate = entries.find((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const id = metadataString(entry as Record<string, unknown>, "sessionId");
      return sessionId ? id === sessionId : Boolean(id);
    });
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    return {
      resolution: executionResolutionFromUnknown(record.executionResolution),
      harness: metadataString(record, "harness"),
      transport: metadataString(record, "transport"),
    };
  }
  return null;
}

function latestConversationRuntime(input: {
  sessionId: string | null;
  participants: ScoutConversationParticipant[];
  invocations: InvocationRequest[];
  flights: FlightRecord[];
  endpoint: AgentEndpoint | null;
}): ScoutConversationRuntime {
  const matchingParticipant = input.sessionId
    ? input.participants.find((participant) => participant.sessionId === input.sessionId) ?? null
    : null;
  const matchingInvocation = input.sessionId
    ? [...input.invocations].reverse().find((invocation) =>
      invocation.executionResolution?.sessionId === input.sessionId
        || invocation.execution?.targetSessionId === input.sessionId
        || metadataSessionId(invocation.metadata) === input.sessionId
    ) ?? null
    : null;
  const latestInvocation = input.invocations.at(-1) ?? null;
  const invocation = matchingInvocation ?? latestInvocation;
  const trace = flightSessionRuntime(input.flights, input.sessionId);
  const resolution = matchingInvocation?.executionResolution
    ?? trace?.resolution
    ?? invocation?.executionResolution
    ?? null;

  return {
    harness: executionResolutionDimension(resolution, "harness")
      ?? trace?.harness
      ?? matchingParticipant?.harness
      ?? invocation?.execution?.harness?.trim()
      ?? input.endpoint?.harness
      ?? null,
    model: executionResolutionDimension(resolution, "model")
      ?? matchingParticipant?.model
      ?? invocation?.execution?.model?.trim()
      ?? metadataString(input.endpoint?.metadata, "observedModel")
      ?? metadataString(input.endpoint?.metadata, "model"),
    reasoningEffort: executionResolutionDimension(resolution, "reasoningEffort")
      ?? matchingParticipant?.reasoningEffort
      ?? invocation?.execution?.reasoningEffort?.trim()
      ?? metadataString(input.endpoint?.metadata, "observedReasoningEffort")
      ?? metadataString(input.endpoint?.metadata, "reasoningEffort"),
    transport: trace?.transport
      ?? matchingParticipant?.transport
      ?? input.endpoint?.transport
      ?? null,
  };
}

function formatChannelAlias(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function conversationAlias(input: {
  id: string;
  kind: string;
  title: string;
  metadata?: Record<string, unknown>;
}): string | null {
  const explicitAlias = metadataString(input.metadata, "alias");
  if (explicitAlias) return explicitAlias;

  const channel = metadataString(input.metadata, "channel");
  if (channel && channel !== "system") {
    return formatChannelAlias(channel);
  }

  if (input.kind === "channel") {
    return formatChannelAlias(input.title);
  }

  return null;
}

function conversationIdentityFields(input: {
  id: string;
  kind: string;
  title: string;
  metadata?: Record<string, unknown>;
}): Pick<ScoutConversationSummary, "alias" | "naturalKey"> {
  return {
    alias: conversationAlias(input),
    naturalKey: conversationNaturalKey(input),
  };
}

function metadataBoolean(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return metadata?.[key] === true;
}

function metadataHasValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const value = metadata?.[key];
  if (value == null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function isFailedCardlessLaunchStub(endpoint: AgentEndpoint | null): boolean {
  if (!endpoint || endpoint.state !== "offline") return false;
  const metadata = endpoint.metadata;
  const hasSession = Boolean(endpoint.sessionId?.trim())
    || Boolean(metadataString(metadata, "externalSessionId"))
    || Boolean(metadataString(metadata, "threadId"));
  return metadataBoolean(metadata, "cardless")
    && metadataBoolean(metadata, "pendingExternalSession")
    && !hasSession
    && (
      metadataHasValue(metadata, "lastError")
      || metadataHasValue(metadata, "lastFailedAt")
    );
}

function titleCaseToken(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function humanizeWorkspaceName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const base = trimmed.split("/").at(-1)?.trim() || trimmed;
  if (!base) return null;
  return base
    .split(/[-_]+/g)
    .filter((token) => token.length > 0)
    .map(titleCaseToken)
    .join(" ");
}

function normalizeQuery(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/// List previews are teasers, not transcripts: the web client trims to 60
/// chars and the widest consumer shows a couple of lines. Full bodies remain
/// available from the message endpoints.
const PREVIEW_MAX_CHARS = 240;

function truncatedPreview(body: string | null | undefined): string | null {
  if (body == null) return null;
  if (body.length <= PREVIEW_MAX_CHARS) return body;
  let sliced = body.slice(0, PREVIEW_MAX_CHARS);
  // Never split a surrogate pair: a lone high surrogate is invalid JSON text
  // for strict decoders (the native comms client reads this same payload).
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

function latestMessageByConversation(snapshot: ScoutBrokerSnapshot): Map<string, MessageRecord[]> {
  const buckets = new Map<string, MessageRecord[]>();
  for (const message of Object.values(snapshot.messages)) {
    const next = buckets.get(message.conversationId) ?? [];
    next.push(message);
    buckets.set(message.conversationId, next);
  }
  for (const messages of buckets.values()) {
    messages.sort((left, right) => (
      (normalizeTimestamp(left.createdAt) ?? 0) - (normalizeTimestamp(right.createdAt) ?? 0)
    ));
  }
  return buckets;
}

function isTransientBrokerWaitStatusMessage(message: MessageRecord): boolean {
  if (message.class !== "status" || metadataString(message.metadata, "source") !== "broker") {
    return false;
  }
  return message.body.includes("Scout stopped waiting for a synchronous result")
    || message.body.includes("the requester stopped waiting after");
}

function messageActorName(snapshot: ScoutBrokerSnapshot, actorId: string): string {
  return snapshot.actors[actorId]?.displayName
    ?? snapshot.agents[actorId]?.displayName
    ?? actorId;
}

function threadSummaryForMessage(
  snapshot: ScoutBrokerSnapshot,
  endpoints: AgentEndpointIndex,
  operatorIds: ReadonlySet<string>,
  messagesByConversation: Map<string, MessageRecord[]>,
  message: MessageRecord,
): ScoutConversationMessage["threadSummary"] {
  const childConversations = Object.values(snapshot.conversations).filter((conversation) =>
    conversation.parentConversationId === message.conversationId
      && conversation.messageId === message.id
  );
  if (childConversations.length === 0) return undefined;

  const participants: string[] = [];
  const childMessages: MessageRecord[] = [];
  for (const conversation of childConversations) {
    for (const participant of buildScopedParticipants(
      snapshot,
      endpoints,
      operatorIds,
      conversation.id,
      conversation.participantIds,
    )) {
      if (!participants.some((label) => label.localeCompare(
        participant.label,
        undefined,
        { sensitivity: "accent" },
      ) === 0)) {
        participants.push(participant.label);
      }
    }
    childMessages.push(
      ...(messagesByConversation.get(conversation.id) ?? [])
        .filter((candidate) => !isTransientBrokerWaitStatusMessage(candidate)),
    );
  }

  return {
    count: childMessages.length,
    participants,
    lastActiveAt: childMessages.reduce(
      (latest, candidate) => Math.max(
        latest,
        normalizeTimestampMs(candidate.createdAt) ?? 0,
      ),
      normalizeTimestampMs(message.createdAt) ?? 0,
    ),
  };
}

function invocationsByConversation(snapshot: ScoutBrokerSnapshot): Map<string, InvocationRequest[]> {
  const buckets = new Map<string, InvocationRequest[]>();
  for (const invocation of Object.values(snapshot.invocations ?? {})) {
    if (!invocation.conversationId) continue;
    const next = buckets.get(invocation.conversationId) ?? [];
    next.push(invocation);
    buckets.set(invocation.conversationId, next);
  }
  for (const invocations of buckets.values()) {
    invocations.sort((left, right) =>
      (normalizeTimestampMs(left.createdAt) ?? 0) - (normalizeTimestampMs(right.createdAt) ?? 0)
    );
  }
  return buckets;
}

function flightsByConversation(
  snapshot: ScoutBrokerSnapshot,
  invocationById: Map<string, InvocationRequest>,
): Map<string, FlightRecord[]> {
  const buckets = new Map<string, FlightRecord[]>();
  for (const flight of Object.values(snapshot.flights ?? {})) {
    const invocation = invocationById.get(flight.invocationId);
    if (!invocation?.conversationId) continue;
    const next = buckets.get(invocation.conversationId) ?? [];
    next.push(flight);
    buckets.set(invocation.conversationId, next);
  }
  for (const flights of buckets.values()) {
    flights.sort((left, right) =>
      (normalizeTimestampMs(left.completedAt ?? left.startedAt) ?? 0)
        - (normalizeTimestampMs(right.completedAt ?? right.startedAt) ?? 0)
    );
  }
  return buckets;
}

function conversationTurn(input: {
  snapshot: ScoutBrokerSnapshot;
  messages: MessageRecord[];
  invocations: InvocationRequest[];
  flights: FlightRecord[];
  operatorIds: Set<string>;
  conversationMetadata?: Record<string, unknown>;
}): ScoutConversationTurn | undefined {
  const messagesById = new Map(input.messages.map((message) => [message.id, message]));
  const candidates = new Map<string, {
    message: MessageRecord;
    invocation: InvocationRequest | null;
  }>();

  for (const invocation of input.invocations) {
    if (!invocation.messageId) continue;
    const message = messagesById.get(invocation.messageId);
    if (!message) continue;
    if (!input.operatorIds.has(invocation.requesterId) && !input.operatorIds.has(message.actorId)) {
      continue;
    }
    candidates.set(message.id, { message, invocation });
  }

  for (const message of input.messages) {
    if (!input.operatorIds.has(message.actorId)) continue;
    if (metadataString(message.metadata, "replyExpectation") !== "required") continue;
    if (!candidates.has(message.id)) {
      candidates.set(message.id, { message, invocation: null });
    }
  }

  const latest = [...candidates.values()].sort((left, right) =>
    (normalizeTimestampMs(right.message.createdAt) ?? 0)
      - (normalizeTimestampMs(left.message.createdAt) ?? 0)
  )[0];
  if (!latest) return undefined;

  const replies = input.messages
    .filter((message) => message.replyToMessageId === latest.message.id)
    .sort((left, right) =>
      (normalizeTimestampMs(left.createdAt) ?? 0)
        - (normalizeTimestampMs(right.createdAt) ?? 0)
    );
  const failureReply = [...replies].reverse().find((message) =>
    metadataString(message.metadata, "routingState") === "failed"
      || metadataString(message.metadata, "deliveryIssueKind") !== null
  );
  const agentReply = [...replies].reverse().find((message) =>
    message.class === "agent" && !input.operatorIds.has(message.actorId)
  );
  const flight = latest.invocation
    ? [...input.flights].reverse().find((candidate) =>
        candidate.invocationId === latest.invocation!.id
      ) ?? null
    : null;

  let state: ScoutConversationTurn["state"];
  let nextMoveOwner: ScoutConversationTurn["nextMoveOwner"];
  if (
    metadataString(latest.message.metadata, "routingState") === "failed"
    || failureReply
  ) {
    state = "failed";
    nextMoveOwner = "none";
  } else if (agentReply) {
    state = "replied";
    nextMoveOwner = "none";
  } else if (flight?.state === "running") {
    state = "working";
    nextMoveOwner = "agent";
  } else if (flight?.state === "waiting") {
    state = "waiting";
    nextMoveOwner = "none";
  } else if (flight?.state === "failed" || flight?.state === "cancelled") {
    state = "failed";
    nextMoveOwner = "none";
  } else if (flight?.state === "completed") {
    state = "completed";
    nextMoveOwner = "none";
  } else {
    state = "queued";
    nextMoveOwner = "agent";
  }

  const terminalReply = failureReply ?? agentReply;
  const updatedAt = normalizeTimestampMs(
    terminalReply?.createdAt
      ?? flight?.completedAt
      ?? flight?.startedAt
      ?? latest.invocation?.createdAt
      ?? latest.message.createdAt,
  ) ?? 0;
  const failureDismissedAt = metadataTimestampMs(
    flight?.metadata,
    "operatorAttentionDismissedAt",
  );
  if (state === "failed" && failureDismissedAt !== null && failureDismissedAt >= updatedAt) {
    return undefined;
  }
  const dismissedMessageId = metadataString(
    input.conversationMetadata,
    "operatorAttentionDismissedMessageId",
  );
  const conversationDismissedAt = metadataTimestampMs(
    input.conversationMetadata,
    "operatorAttentionDismissedAt",
  );
  if (
    state === "failed"
    && dismissedMessageId === latest.message.id
    && conversationDismissedAt !== null
    && conversationDismissedAt >= updatedAt
  ) {
    return undefined;
  }
  return {
    messageId: latest.message.id,
    invocationId: latest.invocation?.id ?? null,
    flightId: flight?.id ?? null,
    from: messageActorName(input.snapshot, latest.message.actorId),
    text: latest.message.body,
    state,
    nextMoveOwner,
    updatedAt,
  };
}

function latestConversationSessionId(input: {
  messages: MessageRecord[];
  invocations: InvocationRequest[];
  flights: FlightRecord[];
}): string | null {
  for (const message of [...input.messages].reverse()) {
    const sessionId = metadataSessionId(message.metadata);
    if (sessionId) return sessionId;
  }
  for (const flight of [...input.flights].reverse()) {
    const sessionId = metadataSessionId(flight.metadata);
    if (sessionId) return sessionId;
  }
  for (const invocation of [...input.invocations].reverse()) {
    const sessionId = invocation.execution?.targetSessionId?.trim()
      || invocation.execution?.forkFromSessionId?.trim()
      || metadataSessionId(invocation.metadata);
    if (sessionId) return sessionId;
  }
  return null;
}

/// Best-endpoint-per-agent lookup, built once per request. Replaces the former
/// per-participant scan+sort over the whole endpoint table.
type AgentEndpointIndex = ReadonlyMap<string, AgentEndpoint>;

/// The exact preference order the former per-agent `filter(...).sort(...)[0]`
/// applied: highest state rank, then most recent start, then most recent
/// activity, then greatest endpoint id.
function compareEndpointPreference(left: AgentEndpoint, right: AgentEndpoint): number {
  return endpointStateRank(right) - endpointStateRank(left)
    || endpointStartedAt(right) - endpointStartedAt(left)
    || endpointActivity(right) - endpointActivity(left)
    || right.id.localeCompare(left.id);
}

/// One pass over the endpoint table keeping, per agent, the endpoint the
/// preference order ranks first. The comparator is a strict total order
/// (endpoint ids are unique), so the single-pass minimum is the same endpoint
/// the previous sort-then-take-first selected.
function bestEndpointByAgent(snapshot: ScoutBrokerSnapshot): AgentEndpointIndex {
  const best = new Map<string, AgentEndpoint>();
  for (const endpoint of Object.values(snapshot.endpoints)) {
    const incumbent = best.get(endpoint.agentId);
    if (!incumbent || compareEndpointPreference(endpoint, incumbent) < 0) {
      best.set(endpoint.agentId, endpoint);
    }
  }
  return best;
}

function endpointForAgent(endpoints: AgentEndpointIndex, agentId: string): AgentEndpoint | null {
  return endpoints.get(agentId) ?? null;
}

function agentDisplayName(
  snapshot: ScoutBrokerSnapshot,
  endpoints: AgentEndpointIndex,
  agentId: string,
): string {
  const endpoint = endpointForAgent(endpoints, agentId);
  const workspaceTitle = humanizeWorkspaceName(endpoint?.projectRoot ?? endpoint?.cwd ?? null);
  if (workspaceTitle) {
    return workspaceTitle;
  }
  return snapshot.agents[agentId]?.displayName
    ?? snapshot.actors[agentId]?.displayName
    ?? agentId;
}

function stableAliasSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function scopedAliasForParticipant(
  scopeId: string,
  participantId: string,
  usedAliases: Set<string>,
): string {
  const seed = stableAliasSeed(`${scopeId}:${participantId}`);
  for (let offset = 0; offset < SCOPED_ALIAS_POOL.length; offset += 1) {
    const alias = SCOPED_ALIAS_POOL[(seed + offset) % SCOPED_ALIAS_POOL.length]!;
    if (!usedAliases.has(alias)) {
      usedAliases.add(alias);
      return alias;
    }
  }
  const fallback = `Agent ${usedAliases.size + 1}`;
  usedAliases.add(fallback);
  return fallback;
}

function cleanParticipantDisplayName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Agent";
  const sessionMatch = trimmed.match(/^(.+?):session\b/iu);
  if (sessionMatch?.[1]) {
    return humanizeWorkspaceName(sessionMatch[1]) ?? titleCaseToken(sessionMatch[1]);
  }
  if (/^session[-_]/iu.test(trimmed)) {
    return "Session";
  }
  return trimmed;
}

function participantEndpoint(
  endpoints: AgentEndpointIndex,
  participantId: string,
): AgentEndpoint | null {
  return endpointForAgent(endpoints, participantId);
}

function participantBaseName(
  snapshot: ScoutBrokerSnapshot,
  endpoints: AgentEndpointIndex,
  operatorIds: ReadonlySet<string>,
  participantId: string,
): string {
  if (operatorIds.has(participantId)) return "Operator";
  if (snapshot.agents[participantId]) {
    return cleanParticipantDisplayName(agentDisplayName(snapshot, endpoints, participantId));
  }
  return cleanParticipantDisplayName(
    snapshot.actors[participantId]?.displayName
      ?? participantId,
  );
}

function buildScopedParticipants(
  snapshot: ScoutBrokerSnapshot,
  endpoints: AgentEndpointIndex,
  operatorIds: ReadonlySet<string>,
  conversationId: string,
  participantIds: string[],
): ScoutConversationParticipant[] {
  const uniqueParticipantIds = [...new Set(participantIds)];
  const bases = new Map<string, string>();
  const baseCounts = new Map<string, number>();
  for (const participantId of uniqueParticipantIds) {
    const base = participantBaseName(snapshot, endpoints, operatorIds, participantId);
    bases.set(participantId, base);
    const key = base.toLowerCase();
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  }

  const usedAliases = new Set<string>();
  return uniqueParticipantIds.map((participantId) => {
    const actor = snapshot.actors[participantId];
    const agent = snapshot.agents[participantId] ?? null;
    const endpoint = participantEndpoint(endpoints, participantId);
    const kind: ActorKind = actor?.kind ?? agent?.kind ?? "agent";
    const displayName = bases.get(participantId) ?? participantId;
    const scopedAlias = operatorIds.has(participantId)
      ? null
      : scopedAliasForParticipant(conversationId, participantId, usedAliases);
    const duplicateName = (baseCounts.get(displayName.toLowerCase()) ?? 0) > 1;
    const needsScopedLabel = Boolean(scopedAlias)
      && (duplicateName || kind === "session" || agent?.metadata?.cardless === true);
    return {
      actorId: participantId,
      kind,
      displayName,
      label: needsScopedLabel && scopedAlias ? `${displayName} · ${scopedAlias}` : displayName,
      scopedAlias,
      agentId: agent?.id ?? null,
      // Session actors carry the same facts in their actor metadata as a
      // durable fallback. The endpoint is authoritative while it exists, but
      // channel history must stay readable after an ephemeral endpoint is
      // rotated or retired.
      sessionId: endpoint?.sessionId
        ?? metadataSessionId(endpoint?.metadata)
        ?? metadataSessionId(actor?.metadata)
        ?? (kind === "session" ? participantId : null),
      harness: endpoint?.harness
        ?? metadataString(actor?.metadata, "harness"),
      model: metadataString(endpoint?.metadata, "observedModel")
        ?? metadataString(endpoint?.metadata, "model")
        ?? metadataString(actor?.metadata, "model"),
      reasoningEffort: metadataString(endpoint?.metadata, "observedReasoningEffort")
        ?? metadataString(endpoint?.metadata, "reasoningEffort")
        ?? metadataString(actor?.metadata, "reasoningEffort"),
      transport: endpoint?.transport
        ?? metadataString(actor?.metadata, "transport"),
      workspaceRoot: endpoint?.projectRoot
        ?? endpoint?.cwd
        ?? metadataString(actor?.metadata, "projectRoot"),
    };
  });
}

function directConversationAgent(
  snapshot: ScoutBrokerSnapshot,
  endpoints: AgentEndpointIndex,
  operatorActorIds: ReadonlySet<string>,
  participantIds: string[],
): { agentId: string | null; actor: ActorIdentity | null; agent: AgentDefinition | null; endpoint: AgentEndpoint | null } {
  const agentId =
    participantIds.find((participantId) =>
      !operatorActorIds.has(participantId) && Boolean(snapshot.agents[participantId])
    )
    ?? participantIds.find((participantId) => Boolean(snapshot.agents[participantId]))
    ?? participantIds.find((participantId) => !operatorActorIds.has(participantId))
    ?? null;
  const actor = agentId ? snapshot.actors[agentId] ?? null : null;
  const agent = agentId ? snapshot.agents[agentId] ?? null : null;
  const endpoint = agentId ? endpointForAgent(endpoints, agentId) : null;
  return { agentId, actor, agent, endpoint };
}

function includeConversation(
  summary: ScoutConversationSummary,
  query: string,
): boolean {
  if (!query) return true;
  return [
    summary.id,
    summary.kind,
    summary.title,
    summary.agentId ?? "",
    summary.agentName ?? "",
    summary.harness ?? "",
    summary.model ?? "",
    summary.reasoningEffort ?? "",
    summary.preview ?? "",
    summary.workspaceRoot ?? "",
    ...summary.participantIds,
    ...summary.participants.flatMap((participant) => [
      participant.displayName,
      participant.label,
      participant.scopedAlias ?? "",
    ]),
  ].some((value) => value.toLowerCase().includes(query));
}

/// The operator's furthest-read timestamp per conversation. Mirrors the proven
/// mobile-comms unread logic (core/mobile/service.ts ~L1218): a conversation can
/// carry several operator-flavored read cursors (canonical "operator" plus the
/// configured name/handle), so we keep the *max* `lastReadAt`. `MessageRecord`
/// has no monotonic `seq`, so — like mobile — we count by `createdAt`, which the
/// broker stamps and the cursor's `lastReadAt` is expressed in.
function operatorReadAtByConversation(
  snapshot: ScoutBrokerSnapshot,
  operatorIds: ReadonlySet<string>,
): Map<string, number> {
  const readAt = new Map<string, number>();
  for (const cursor of Object.values(snapshot.readCursors ?? {})) {
    if (!operatorIds.has(cursor.actorId)) continue;
    const prev = readAt.get(cursor.conversationId) ?? 0;
    readAt.set(cursor.conversationId, Math.max(prev, normalizeTimestampMs(cursor.lastReadAt) ?? 0));
  }
  return readAt;
}

/// Count messages newer than the operator's read position that the operator did
/// not author. When the operator has no cursor for the conversation we cannot
/// tell what has been seen, so we return 0 (prefer under- over over-counting, per
/// the data-contract note) rather than flagging the whole history as unread.
function unreadCountForConversation(
  messages: MessageRecord[],
  readAt: number | undefined,
  operatorIds: Set<string>,
): number {
  if (readAt == null || readAt <= 0) return 0;
  let count = 0;
  for (const message of messages) {
    const createdAt = normalizeTimestampMs(message.createdAt) ?? 0;
    if (createdAt > readAt && !operatorIds.has(message.actorId)) {
      count += 1;
    }
  }
  return count;
}

function equivalentNamedConversationIds(
  snapshot: ScoutBrokerSnapshot,
  conversationId: string,
): Set<string> {
  const conversation = snapshot.conversations[conversationId];
  const naturalKey = conversation ? conversationNaturalKey(conversation) : null;
  if (!conversation || !naturalKey || conversation.kind !== "channel") {
    return new Set([conversationId]);
  }
  return new Set(conversationsWithNaturalKey(
    Object.values(snapshot.conversations),
    naturalKey,
  ).filter((candidate) => candidate.kind === conversation.kind).map((candidate) => candidate.id));
}

function coalesceDuplicateNamedChannels(
  summaries: ScoutConversationSummary[],
  snapshot: ScoutBrokerSnapshot,
  endpoints: AgentEndpointIndex,
  operatorIds: ReadonlySet<string>,
  preferredId?: string | null,
): ScoutConversationSummary[] {
  const groups = new Map<string, ScoutConversationSummary[]>();
  for (const summary of summaries) {
    const key = summary.kind === "channel" && summary.naturalKey
      ? `channel:${summary.naturalKey}`
      : `id:${summary.id}`;
    const group = groups.get(key) ?? [];
    group.push(summary);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const sorted = [...group].sort((left, right) =>
      (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0)
      || right.messageCount - left.messageCount
      || left.id.localeCompare(right.id)
    );
    const naturalKey = group[0]?.naturalKey;
    const stableId = naturalKey ? stableChannelId(naturalKey) : null;
    const canonical = group.find((summary) => summary.id === preferredId)
      ?? group.find((summary) => summary.id === stableId)
      ?? sorted[0]!;
    const latest = sorted[0]!;
    const participantIds = [...new Set(group.flatMap((summary) => summary.participantIds))].sort();
    const latestTurn = group
      .map((summary) => summary.turn)
      .filter((turn): turn is ScoutConversationTurn => Boolean(turn))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return {
      ...canonical,
      equivalentConversationIds: [...new Set(
        group.flatMap((summary) => summary.equivalentConversationIds),
      )].sort(),
      participantIds,
      participantCount: participantIds.length,
      participants: buildScopedParticipants(
        snapshot,
        endpoints,
        operatorIds,
        canonical.id,
        participantIds,
      ),
      preview: latest.preview,
      lastMessageAt: latest.lastMessageAt,
      sessionId: latest.sessionId ?? canonical.sessionId,
      harness: latest.harness ?? canonical.harness,
      model: latest.model ?? canonical.model,
      reasoningEffort: latest.reasoningEffort ?? canonical.reasoningEffort,
      transport: latest.transport ?? canonical.transport,
      messageCount: Math.max(...group.map((summary) => summary.messageCount)),
      unreadCount: Math.max(...group.map((summary) => summary.unreadCount)),
      ...(latestTurn ? { turn: latestTurn } : {}),
    };
  });
}

function conversationMatchesMachine(
  snapshot: ScoutBrokerSnapshot,
  summary: ScoutConversationSummary,
  machineId: string,
): boolean {
  if (summary.authorityNodeId === machineId) return true;
  return summary.participantIds.some((participantId) => {
    const agent = snapshot.agents?.[participantId];
    return agent?.authorityNodeId === machineId || agent?.homeNodeId === machineId;
  });
}

export async function getScoutConversations(
  filters: ScoutConversationListFilters = {},
  brokerContext?: ScoutBrokerContext,
): Promise<ScoutConversationSummary[]> {
  const broker = brokerContext ?? await loadScoutBrokerContext(
    undefined,
    filters.machineId ? {} : { scope: "conversations" },
  );
  if (!broker) {
    return [];
  }

  const snapshot = broker.snapshot;
  const messagesByConversation = latestMessageByConversation(snapshot);
  const invocationsByConversationId = invocationsByConversation(snapshot);
  const invocationById = new Map(Object.values(snapshot.invocations ?? {}).map((invocation) => [invocation.id, invocation]));
  const flightsByConversationId = flightsByConversation(snapshot, invocationById);
  const allowedKinds = new Set(filters.kinds ?? DEFAULT_CONVERSATION_KINDS);
  const query = normalizeQuery(filters.query);
  const operatorIds = new Set(configuredOperatorActorIds());
  const endpointsByAgent = bestEndpointByAgent(snapshot);
  const readAtByConversation = operatorReadAtByConversation(snapshot, operatorIds);

  const conversationIdFilter = filters.conversationId?.trim() || null;
  const conversationIdFilterIds = conversationIdFilter
    ? equivalentNamedConversationIds(snapshot, conversationIdFilter)
    : null;

  const summaries = Object.values(snapshot.conversations)
    .flatMap((conversation): ScoutConversationSummary[] => {
      if (conversationIdFilterIds && !conversationIdFilterIds.has(conversation.id)) {
        return [];
      }

      if (!isOpaqueChannelId(conversation.id)) {
        return [];
      }

      if (!allowedKinds.has(conversation.kind)) {
        return [];
      }

      const equivalentConversationIds = [
        ...equivalentNamedConversationIds(snapshot, conversation.id),
      ].sort();
      const equivalentConversations = equivalentConversationIds
        .map((id) => snapshot.conversations[id])
        .filter((candidate): candidate is ScoutBrokerSnapshot["conversations"][string] => Boolean(candidate));
      const participantIds = [...new Set(
        equivalentConversations.flatMap((candidate) => candidate.participantIds),
      )].sort();
      const messages = equivalentConversationIds
        .flatMap((id) => messagesByConversation.get(id) ?? [])
        .sort((left, right) =>
          (normalizeTimestampMs(left.createdAt) ?? 0) - (normalizeTimestampMs(right.createdAt) ?? 0)
          || left.id.localeCompare(right.id)
        );
      const invocations = equivalentConversationIds
        .flatMap((id) => invocationsByConversationId.get(id) ?? []);
      const flights = equivalentConversationIds
        .flatMap((id) => flightsByConversationId.get(id) ?? []);
      const latestMessage = messages.at(-1) ?? null;
      const messageCount = messages.length;
      const sessionId = latestConversationSessionId({ messages, invocations, flights });
      const unreadCount = equivalentConversationIds.reduce((total, id) =>
        total + unreadCountForConversation(
          messagesByConversation.get(id) ?? [],
          readAtByConversation.get(id),
          operatorIds,
        ), 0);
      const isChildConversation = Boolean(conversation.parentConversationId && conversation.messageId);
      const askField = {};
      const turn = conversationTurn({
        snapshot,
        messages,
        invocations,
        flights,
        operatorIds,
        conversationMetadata: conversation.metadata,
      });
      const participants = buildScopedParticipants(
        snapshot,
        endpointsByAgent,
        operatorIds,
        conversation.id,
        participantIds,
      );

      if (conversation.kind === "direct") {
        const { agentId, actor, agent, endpoint } = directConversationAgent(
          snapshot,
          endpointsByAgent,
          operatorIds,
          participantIds,
        );
        if (
          !agentId
          || (!agent && !actor)
          || metadataBoolean(agent?.metadata, "retiredFromFleet")
          || metadataBoolean(actor?.metadata, "retiredFromFleet")
          || isFailedCardlessLaunchStub(endpoint)
          || (!isChildConversation && messageCount === 0)
        ) {
          return [];
        }
        const title = agentDisplayName(snapshot, endpointsByAgent, agentId);
        const identityFields = conversationIdentityFields(conversation);
        const runtime = latestConversationRuntime({
          sessionId,
          participants,
          invocations,
          flights,
          endpoint,
        });
        return [{
          id: conversation.id,
          chatId: conversation.id,
          equivalentConversationIds,
          kind: conversation.kind,
          title,
          ...identityFields,
          participantIds,
          participants,
          participantCount: participantIds.length,
          authorityNodeId: conversation.authorityNodeId ?? null,
          authorityNodeName: snapshot.nodes?.[conversation.authorityNodeId]?.name ?? null,
          agentId,
          agentName: title,
          harness: runtime.harness,
          model: runtime.model,
          reasoningEffort: runtime.reasoningEffort,
          transport: runtime.transport,
          sessionId,
          currentBranch:
            metadataString(endpoint?.metadata, "branch")
            ?? metadataString(endpoint?.metadata, "workspaceQualifier")
            ?? metadataString(agent?.metadata, "branch")
            ?? metadataString(agent?.metadata, "workspaceQualifier"),
          parentConversationId: conversation.parentConversationId ?? null,
          anchorMessageId: conversation.messageId ?? null,
          preview: truncatedPreview(latestMessage?.body),
          messageCount,
          lastMessageAt: normalizeTimestampMs(latestMessage?.createdAt),
          workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
          unreadCount,
          ...askField,
          ...(turn ? { turn } : {}),
        }];
      }

      if (conversation.kind === "channel" || conversation.kind === "group_direct") {
        const visible = isChildConversation || messageCount >= 1 || participantIds.includes("operator");
        if (!visible) {
          return [];
        }
      } else if (conversation.kind === "thread") {
        if (!isChildConversation && messageCount === 0) {
          return [];
        }
      } else if (conversation.kind === "system") {
        return [];
      }

      const identityFields = conversationIdentityFields(conversation);
      const runtime = latestConversationRuntime({
        sessionId,
        participants,
        invocations,
        flights,
        endpoint: null,
      });

      return [{
        id: conversation.id,
        chatId: conversation.id,
        equivalentConversationIds,
        kind: conversation.kind,
        title: conversation.title,
        ...identityFields,
        participantIds,
        participants,
        participantCount: participantIds.length,
        authorityNodeId: conversation.authorityNodeId ?? null,
        authorityNodeName: snapshot.nodes?.[conversation.authorityNodeId]?.name ?? null,
        agentId: null,
        agentName: null,
        harness: runtime.harness,
        model: runtime.model,
        reasoningEffort: runtime.reasoningEffort,
        transport: runtime.transport,
        sessionId,
        currentBranch: null,
        parentConversationId: conversation.parentConversationId ?? null,
        anchorMessageId: conversation.messageId ?? null,
        preview: truncatedPreview(latestMessage?.body),
        messageCount,
        lastMessageAt: normalizeTimestampMs(latestMessage?.createdAt),
        workspaceRoot: null,
        unreadCount,
        ...askField,
        ...(turn ? { turn } : {}),
      }];
    })
    .filter((summary) => includeConversation(summary, query))
    .sort((left, right) => (
      (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0)
      || right.messageCount - left.messageCount
      || left.title.localeCompare(right.title)
    ));

  const machineId = filters.machineId?.trim() || null;
  const coalesced = coalesceDuplicateNamedChannels(
    summaries,
    snapshot,
    endpointsByAgent,
    operatorIds,
    conversationIdFilter,
  ).filter((summary) =>
    !machineId || conversationMatchesMachine(snapshot, summary, machineId)
  ).sort((left, right) => (
    (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0)
    || right.messageCount - left.messageCount
    || left.title.localeCompare(right.title)
  ));
  const limit = typeof filters.limit === "number" && filters.limit > 0
    ? Math.floor(filters.limit)
    : null;
  const page = limit ? coalesced.slice(0, limit) : coalesced;
  // Cap only what ships: query/machine filters above ran on full rosters.
  return page.map((summary) => capSummaryRoster(summary, operatorIds, endpointsByAgent));
}

/// Non-direct rosters can be huge (a broadcast channel carries thousands of
/// participants, mostly historic sessions) and their rich entries were the
/// bulk of the list payload. `participantIds` always ships COMPLETE — bare
/// ids are cheap, and consumers use them for membership checks (machine
/// scoping, deep links) that must see every member. Only the rich
/// `participants` array is capped. Selection prefers the operator, then
/// endpoint-backed members, then the remaining roster, preserving input order
/// within each tier. Endpoint-backed rosters are not assumed to be bounded:
/// once the cap is full, lower-ranked rich records are omitted. Kept ids are
/// moved to the front of `participantIds` so consumers that zip
/// `participants[i]` with `participantIds[i]` stay aligned. `participantCount`
/// carries the real total. Direct/group_direct rosters are tiny and name the
/// conversation, so they stay complete.
const CHANNEL_ROSTER_CAP = 32;

function capSummaryRoster(
  summary: ScoutConversationSummary,
  operatorIds: ReadonlySet<string>,
  endpoints: AgentEndpointIndex,
): ScoutConversationSummary {
  if (summary.kind === "direct" || summary.kind === "group_direct") return summary;
  if (summary.participantIds.length <= CHANNEL_ROSTER_CAP) return summary;

  const keep = new Set<string>();
  const fillFromTier = (matches: (id: string) => boolean): void => {
    for (const id of summary.participantIds) {
      if (keep.size >= CHANNEL_ROSTER_CAP) return;
      if (matches(id)) keep.add(id);
    }
  };
  fillFromTier((id) => operatorIds.has(id));
  fillFromTier((id) => !operatorIds.has(id) && participantEndpoint(endpoints, id) !== null);
  fillFromTier(() => true);

  const keptIds = summary.participantIds.filter((id) => keep.has(id));
  const droppedIds = summary.participantIds.filter((id) => !keep.has(id));
  return {
    ...summary,
    participantIds: [...keptIds, ...droppedIds],
    participants: summary.participants.filter((participant) => keep.has(participant.actorId)),
  };
}

/// Read a conversation transcript from the same broker snapshot that powers
/// the conversation list. `null` means the broker cannot answer and lets the
/// HTTP compatibility route fall back to its durable SQLite projection.
export async function getScoutConversationMessages(
  conversationId: string,
  limit = 80,
  beforeMessageId?: string,
  brokerContext?: ScoutBrokerContext | null,
): Promise<ScoutConversationMessage[] | null> {
  const normalizedId = conversationId.trim();
  if (!normalizedId || !isOpaqueChannelId(normalizedId)) {
    return [];
  }

  const broker = brokerContext === undefined
    ? await loadScoutBrokerContext(undefined, { scope: "conversations" })
    : brokerContext;
  if (!broker) return null;

  const snapshot = broker.snapshot;
  const messagesByConversation = latestMessageByConversation(snapshot);
  const equivalentIds = equivalentNamedConversationIds(snapshot, normalizedId);
  // Order and page under the one shared total order so a cursor minted from a
  // SQLite page (or from the client cache) names the same position here.
  const ordered = [...equivalentIds]
    .flatMap((id) => messagesByConversation.get(id) ?? [])
    .filter((message) => !isTransientBrokerWaitStatusMessage(message))
    .map((message) => ({
      message,
      key: { createdAt: normalizeTimestampMs(message.createdAt) ?? 0, id: message.id },
    }))
    .sort((left, right) => compareMessagesAsc(left.key, right.key));
  const resolvedLimit = clampMessagePageLimit(limit);
  const before = resolveBrokerPageCursor(beforeMessageId, ordered);
  // Page by position, not by anchor identity: a deleted cursor still lands
  // between the same two messages instead of reading as end-of-history.
  const pageEndIndex = before
    ? ordered.findIndex((entry) => compareMessagesAsc(entry.key, before) >= 0)
    : ordered.length;
  const pageEnd = pageEndIndex < 0 ? ordered.length : pageEndIndex;
  const pageStart = Math.max(0, pageEnd - resolvedLimit);
  const visibleMessages = ordered.slice(pageStart, pageEnd).map((entry) => entry.message);

  // The snapshot is a rolling window, so an empty page is silence, not an
  // answer: everything older than the window is simply not in it. Reporting it
  // as an authoritative empty transcript is what makes a conversation past the
  // window open blank — the row still exists, the record still asks for the
  // operator, and the destination shows "No messages yet" over a transcript
  // SQLite still holds. Hand the read to the durable projection instead; it
  // applies the same transient-status filter and the same cursor grammar, so a
  // genuinely empty conversation still answers empty and a page below the
  // window continues the same scrollback rather than reading as its end.
  if (visibleMessages.length === 0) return null;

  const endpointsByAgent = bestEndpointByAgent(snapshot);
  const operatorIds = new Set(configuredOperatorActorIds());
  return visibleMessages.map((message) => {
    const threadSummary = threadSummaryForMessage(
      snapshot,
      endpointsByAgent,
      operatorIds,
      messagesByConversation,
      message,
    );
    return {
      id: message.id,
      conversationId: normalizedId,
      actorId: message.actorId,
      actorName: messageActorName(snapshot, message.actorId),
      body: message.body,
      createdAt: normalizeTimestampMs(message.createdAt) ?? 0,
      class: message.class,
      metadata: message.metadata ?? null,
      replyToMessageId: message.replyToMessageId ?? null,
      threadConversationId: message.threadConversationId ?? null,
      attachments: message.attachments ?? [],
      ...(threadSummary ? { threadSummary } : {}),
    };
  });
}

/// Resolve `beforeMessageId` against an already-ordered transcript. A composite
/// cursor carries its own position; a legacy bare id is looked up, and a lookup
/// that misses is reported so the caller cannot read it as end-of-history.
function resolveBrokerPageCursor(
  beforeMessageId: string | undefined,
  ordered: ReadonlyArray<{ key: MessageOrderKey }>,
): MessageOrderKey | null {
  const cursor = parseMessageHistoryCursor(beforeMessageId);
  if (!cursor) return null;
  if (cursor.kind === "position") {
    return { createdAt: cursor.createdAt, id: cursor.id };
  }
  const anchor = ordered.find((entry) => entry.key.id === cursor.id);
  if (!anchor) {
    throw new MessageCursorError("unknown", cursor.id);
  }
  return anchor.key;
}

export async function getScoutConversationById(
  conversationId: string,
): Promise<ScoutConversationSummary | null> {
  const normalizedId = conversationId.trim();
  if (!normalizedId || !isOpaqueChannelId(normalizedId)) {
    return null;
  }
  const matches = await getScoutConversations({ conversationId: normalizedId, limit: 1 });
  return matches[0] ?? null;
}
