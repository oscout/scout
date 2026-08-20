import {
  epochMs,
  type ConversationBinding,
  type ConversationDefinition,
  type MessageRecord,
} from "@openscout/protocol";

export type ScoutTelegramNodeSnapshot = {
  id: string;
  registeredAt?: number | null;
  lastSeenAt?: number | null;
};

export type ScoutTelegramRegistrySnapshot = {
  nodes: Record<string, ScoutTelegramNodeSnapshot>;
  bindings: Record<string, ConversationBinding>;
  conversations: Record<string, ConversationDefinition>;
  messages: Record<string, MessageRecord>;
};

export const SCOUT_TELEGRAM_OPERATOR_ID = "operator";
export const SCOUT_TELEGRAM_SHARED_CHANNEL_ID = "channel.shared";
export const SCOUT_TELEGRAM_VOICE_CHANNEL_ID = "channel.voice";
export const SCOUT_TELEGRAM_SYSTEM_CHANNEL_ID = "channel.system";
export const SCOUT_TELEGRAM_PRIMARY_CONVERSATION_ID = "dm.scout.primary";

const SCOUT_TELEGRAM_OWNER_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

function compactScoutTelegramId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "telegram";
}

export function messageBodyFromScoutTelegram(message: {
  text: string;
}): string {
  const text = message.text.trim();
  return text || "[telegram sent an attachment]";
}

export function stableScoutTelegramActorId(message: {
  senderId: string;
}): string {
  return `tg.user.${compactScoutTelegramId(message.senderId)}`;
}

export function stableScoutTelegramBindingId(threadId: string): string {
  return `binding.telegram.${compactScoutTelegramId(threadId)}`;
}

export function stableScoutTelegramMessageId(message: {
  externalThreadId: string;
  externalMessageId: string;
}): string {
  return `msg.telegram.${compactScoutTelegramId(message.externalThreadId)}.${compactScoutTelegramId(message.externalMessageId)}`;
}

export function stableScoutTelegramInvocationId(
  message: {
    externalThreadId: string;
    externalMessageId: string;
  },
  targetAgentId: string,
): string {
  return `inv.telegram.${compactScoutTelegramId(message.externalThreadId)}.${compactScoutTelegramId(message.externalMessageId)}.${compactScoutTelegramId(targetAgentId)}`;
}

function telegramAllowedActorIds(binding: ConversationBinding): string[] {
  return Array.isArray(binding.metadata?.allowedActorIds)
    ? binding.metadata.allowedActorIds.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

export function desiredScoutTelegramBindingMetadata(conversationId: string): Record<string, unknown> {
  if (conversationId === SCOUT_TELEGRAM_PRIMARY_CONVERSATION_ID) {
    return {
      outboundMode: "allowlist",
      operatorId: SCOUT_TELEGRAM_OPERATOR_ID,
      allowedActorIds: [SCOUT_TELEGRAM_OPERATOR_ID, "scout", "system"],
    };
  }

  return {
    outboundMode: "operator_only",
    operatorId: SCOUT_TELEGRAM_OPERATOR_ID,
  };
}

export function shouldDeliverScoutTelegramMessage(
  binding: ConversationBinding,
  message: MessageRecord,
): boolean {
  const source = typeof message.metadata?.source === "string"
    ? String(message.metadata.source)
    : "";
  if (source === "telegram") {
    return false;
  }

  const outboundMode = typeof binding.metadata?.outboundMode === "string"
    ? String(binding.metadata.outboundMode)
    : "operator_only";
  const operatorId = typeof binding.metadata?.operatorId === "string"
    ? String(binding.metadata.operatorId)
    : SCOUT_TELEGRAM_OPERATOR_ID;
  const allowedActorIds = telegramAllowedActorIds(binding);

  if (outboundMode === "all") {
    return true;
  }

  if (outboundMode === "allowlist") {
    return allowedActorIds.includes(message.actorId);
  }

  return message.actorId === operatorId;
}

export function shouldEmitScoutTelegramTypingSignal(
  binding: ConversationBinding,
  message: MessageRecord,
): boolean {
  if (binding.conversationId !== SCOUT_TELEGRAM_PRIMARY_CONVERSATION_ID) {
    return false;
  }

  if (message.class !== "status" || message.actorId !== "system") {
    return false;
  }

  const source = typeof message.metadata?.source === "string"
    ? String(message.metadata.source)
    : "";
  if (source !== "broker") {
    return false;
  }

  return /is working\.?$/i.test(message.body.trim());
}

export function resolveScoutTelegramOwnerNodeId(
  input: {
    ownerNodeId: string;
  },
  snapshot: ScoutTelegramRegistrySnapshot | null,
  localNodeId: string | null | undefined,
  now = Date.now(),
): string | null {
  const explicitOwner = input.ownerNodeId.trim();
  if (explicitOwner) {
    return explicitOwner;
  }

  if (!snapshot || !localNodeId) {
    return localNodeId ?? null;
  }

  const candidates = Object.values(snapshot.nodes)
    .filter((node) => {
      if (node.id === localNodeId) {
        return true;
      }

      const seenAt = normalizeTimestamp(node.lastSeenAt ?? node.registeredAt);
      return seenAt > 0 && now - seenAt <= SCOUT_TELEGRAM_OWNER_HEARTBEAT_TTL_MS;
    })
    .map((node) => node.id)
    .sort((lhs, rhs) => lhs.localeCompare(rhs));

  return candidates[0] ?? localNodeId;
}

function normalizeTimestamp(value: number | null | undefined): number {
  return epochMs(value) ?? 0;
}
