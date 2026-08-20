import { epochMs, type ConversationDefinition, type MessageRecord } from "@openscout/protocol";

type ScoutVoicePlaybackSnapshot = {
  messages: Record<string, MessageRecord>;
  conversations: Record<string, ConversationDefinition>;
};

export type ScoutVoicePlaybackSelection = {
  messageId: string;
  conversationId: string;
  spokenText: string;
  voice: string | null;
};

export type ScoutVoicePlaybackInput = {
  snapshot: ScoutVoicePlaybackSnapshot;
  observedMessageIds: ReadonlySet<string> | Iterable<string>;
  repliesEnabled: boolean;
  operatorId?: string;
};

function normalizeTimestamp(value: number | null | undefined): number {
  const ms = epochMs(value);
  return ms === null ? 0 : Math.floor(ms / 1000);
}

function sanitizeScoutVoiceBody(body: string): string {
  return body
    .replace(/\[ask:[^\]]+\]\s*/g, "")
    .replace(/\[speak\]\s*/gi, "")
    .replace(/^(@[\w.-]+\s+)+/g, "")
    .trim();
}

function normalizedChannel(conversation: ConversationDefinition | undefined): string | null {
  if (!conversation) return null;
  if (conversation.id.startsWith("channel.")) {
    return conversation.id.replace(/^channel\./, "");
  }
  return null;
}

function spokenTextForMessage(message: MessageRecord): string | null {
  const explicitSpeech = message.speech?.text?.trim();
  if (explicitSpeech) {
    return explicitSpeech;
  }

  const taggedSpeech = message.body.match(/^\[speak\]\s*([\s\S]+)$/i)?.[1]?.trim();
  return taggedSpeech || null;
}

function isSystemMessage(message: MessageRecord, conversation: ConversationDefinition | undefined): boolean {
  return message.class === "system" || conversation?.kind === "system" || normalizedChannel(conversation) === "system";
}

function toObservedMessageIdSet(observedMessageIds: ReadonlySet<string> | Iterable<string>): Set<string> {
  return observedMessageIds instanceof Set ? new Set(observedMessageIds) : new Set(Array.from(observedMessageIds));
}

export function selectScoutVoicePlaybackMessage(
  input: ScoutVoicePlaybackInput,
): ScoutVoicePlaybackSelection | null {
  if (!input.repliesEnabled) {
    return null;
  }

  const observedMessageIds = toObservedMessageIdSet(input.observedMessageIds);
  const messages = Object.values(input.snapshot.messages)
    .filter((message) => message.metadata?.transportOnly !== "true")
    .sort((left, right) => normalizeTimestamp(left.createdAt) - normalizeTimestamp(right.createdAt));
  const newMessages = messages.filter((message) => !observedMessageIds.has(message.id));

  if (newMessages.length === 0) {
    return null;
  }

  const operatorId = input.operatorId ?? "operator";
  const newestSpeakableMessage = [...newMessages].reverse().find((message) => {
    const conversation = input.snapshot.conversations[message.conversationId];
    const spokenText = spokenTextForMessage(message);
    if (!spokenText) {
      return false;
    }

    if (message.actorId === operatorId) {
      return false;
    }

    if (isSystemMessage(message, conversation)) {
      return false;
    }

    return sanitizeScoutVoiceBody(message.body).length > 0;
  });

  if (!newestSpeakableMessage) {
    return null;
  }

  const spokenText = spokenTextForMessage(newestSpeakableMessage);
  if (!spokenText) {
    return null;
  }

  return {
    messageId: newestSpeakableMessage.id,
    conversationId: newestSpeakableMessage.conversationId,
    spokenText,
    voice: newestSpeakableMessage.speech?.voice?.trim() || null,
  };
}
