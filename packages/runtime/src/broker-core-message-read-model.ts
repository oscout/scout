import {
  conversationNaturalKey,
  conversationsWithNaturalKey,
  type MessageRecord,
} from "@openscout/protocol";

import type { ScoutBrokerMessageQuery } from "./broker-api.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

type BrokerCoreMessageRuntime = {
  snapshot: () => RuntimeRegistrySnapshot;
};

export function listBrokerMessages(
  runtime: BrokerCoreMessageRuntime,
  input: ScoutBrokerMessageQuery = {},
): MessageRecord[] {
  const snapshot = runtime.snapshot();
  const limit = normalizeMessageLimit(input.limit);
  const requestedConversation = input.conversationId
    ? snapshot.conversations[input.conversationId]
    : null;
  const requestedNaturalKey = requestedConversation
    ? conversationNaturalKey(requestedConversation)
    : null;
  const conversationIds = input.conversationId
    ? new Set(
        requestedNaturalKey
          ? conversationsWithNaturalKey(
              Object.values(snapshot.conversations),
              requestedNaturalKey,
            ).map((conversation) => conversation.id)
          : [input.conversationId],
      )
    : null;
  const participantId = input.participantId?.trim();
  const matchesParticipant = (message: MessageRecord): boolean => {
    if (!participantId) {
      return true;
    }
    const conversation = snapshot.conversations[message.conversationId];
    const participantConversation = Boolean(conversation?.participantIds.includes(participantId));
    const directConversation = conversation?.kind === "direct" || conversation?.kind === "group_direct";
    const authored = message.actorId === participantId;
    const addressed = Boolean(message.mentions?.some((mention) => mention.actorId === participantId))
      || Boolean(message.audience?.notify?.includes(participantId))
      || Boolean(message.audience?.invoke?.includes(participantId))
      || Boolean(message.audience?.visibleTo?.includes(participantId));

    if (input.inboxOnly) {
      return addressed || (participantConversation && directConversation);
    }
    return authored || addressed || participantConversation;
  };

  return Object.values(snapshot.messages)
    .filter((message) => !isBrokerRequesterWaitTimeoutStatusMessage(message))
    .filter((message) =>
      !conversationIds || conversationIds.has(message.conversationId)
    )
    .filter(matchesParticipant)
    .filter((message) =>
      input.since === null || input.since === undefined
        ? true
        : message.createdAt >= input.since
    )
    .sort((lhs, rhs) => rhs.createdAt - lhs.createdAt)
    .slice(0, limit)
    .reverse();
}

export function isBrokerRequesterWaitTimeoutStatusMessage(message: MessageRecord): boolean {
  if (message.class !== "status" || metadataString(message.metadata, "source") !== "broker") {
    return false;
  }
  return message.body.includes("Scout stopped waiting for a synchronous result")
    || message.body.includes("the requester stopped waiting after");
}

function normalizeMessageLimit(limit?: number): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.min(limit, 500)
    : 100;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
