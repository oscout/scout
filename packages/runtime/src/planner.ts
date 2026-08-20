import type {
  ConversationBinding,
  ConversationDefinition,
  DeliveryIntent,
  DeliveryPolicy,
  DeliveryReason,
  DeliveryTargetKind,
  DeliveryTransport,
  MessageRecord,
  ScoutId,
} from "@openscout/protocol";

export interface DeliveryRoute {
  targetId: ScoutId;
  nodeId?: ScoutId;
  targetKind: DeliveryTargetKind;
  transport: DeliveryTransport;
  bindingId?: ScoutId;
  speechEnabled?: boolean;
}

export interface DeliveryPlanningInput {
  localNodeId?: ScoutId;
  message: MessageRecord;
  conversation: ConversationDefinition;
  participantRoutes: DeliveryRoute[];
  bindingRoutes?: DeliveryRoute[];
  bindings?: ConversationBinding[];
}

function createDeliveryId(
  messageId: string,
  targetId: string,
  reason: DeliveryReason,
  transport: DeliveryTransport,
): string {
  return `del-${messageId}-${targetId}-${reason}-${transport}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function resolveVisibilityAudience(message: MessageRecord, conversation: ConversationDefinition): ScoutId[] {
  if (message.audience?.visibleTo?.length) {
    return unique(message.audience.visibleTo);
  }

  return unique(conversation.participantIds.filter((participantId) => participantId !== message.actorId));
}

function resolveNotifyAudience(message: MessageRecord): ScoutId[] {
  const fromMentions = (message.mentions ?? []).map((mention) => mention.actorId);
  const explicit = message.audience?.notify ?? [];
  return unique([...fromMentions, ...explicit].filter((actorId) => actorId !== message.actorId));
}

function resolveInvocationAudience(message: MessageRecord): ScoutId[] {
  return unique((message.audience?.invoke ?? []).filter((actorId) => actorId !== message.actorId));
}

function notifyDeliveryReason(message: MessageRecord): DeliveryReason {
  return message.audience?.reason === "conversation_visibility"
    ? "conversation_visibility"
    : "mention";
}

function notifyDeliveryPolicy(message: MessageRecord): DeliveryPolicy {
  return notifyDeliveryReason(message) === "conversation_visibility"
    ? "durable"
    : "must_ack";
}

function planTargetDelivery(
  message: MessageRecord,
  route: DeliveryRoute,
  reason: DeliveryReason,
  policy: DeliveryPolicy,
): DeliveryIntent {
  return {
    id: createDeliveryId(message.id, route.targetId, reason, route.transport),
    messageId: message.id,
    targetId: route.targetId,
    targetNodeId: route.nodeId,
    targetKind: route.targetKind,
    transport: route.transport,
    reason,
    policy,
    status: "pending",
    bindingId: route.bindingId,
  };
}

export function planMessageDeliveries(input: DeliveryPlanningInput): DeliveryIntent[] {
  if (input.message.audience?.delivery === "none") {
    return [];
  }

  const visibilityIds = new Set(resolveVisibilityAudience(input.message, input.conversation));
  const notifyIds = new Set(resolveNotifyAudience(input.message));
  const invokeIds = new Set(resolveInvocationAudience(input.message));
  const deliveries = new Map<string, DeliveryIntent>();
  const isDirectConversation = input.conversation.kind === "direct" || input.conversation.kind === "group_direct";

  for (const route of input.participantRoutes) {
    if (visibilityIds.has(route.targetId)) {
      const intent = planTargetDelivery(
        input.message,
        {
          ...route,
          transport: route.nodeId && input.localNodeId && route.nodeId !== input.localNodeId
            ? "peer_broker"
            : route.transport,
        },
        isDirectConversation ? "direct_message" : "conversation_visibility",
        isDirectConversation && notifyIds.has(route.targetId) ? "must_ack" : "durable",
      );
      deliveries.set(intent.id, intent);
    }

    if (notifyIds.has(route.targetId)) {
      if (isDirectConversation && visibilityIds.has(route.targetId)) {
        continue;
      }
      const reason = notifyDeliveryReason(input.message);
      const intent = planTargetDelivery(
        input.message,
        {
          ...route,
          transport: route.nodeId && input.localNodeId && route.nodeId !== input.localNodeId
            ? "peer_broker"
            : route.transport,
        },
        reason,
        notifyDeliveryPolicy(input.message),
      );
      deliveries.set(intent.id, intent);
    }

    if (invokeIds.has(route.targetId)) {
      const intent = planTargetDelivery(
        input.message,
        {
          ...route,
          transport: route.nodeId && input.localNodeId && route.nodeId !== input.localNodeId
            ? "peer_broker"
            : route.transport,
        },
        "invocation",
        "must_ack",
      );
      deliveries.set(intent.id, intent);
    }

    if (input.message.speech?.text && route.speechEnabled) {
      const speechIntent = planTargetDelivery(
        input.message,
        {
          ...route,
          transport: route.transport === "local_socket" ? "native_voice" : "tts",
          targetKind: route.targetKind === "device" ? "voice_session" : route.targetKind,
        },
        "speech",
        "best_effort",
      );
      deliveries.set(speechIntent.id, speechIntent);
    }
  }

  for (const route of input.bindingRoutes ?? []) {
    const intent = planTargetDelivery(input.message, route, "bridge_outbound", "durable");
    deliveries.set(intent.id, intent);
  }

  return [...deliveries.values()];
}
