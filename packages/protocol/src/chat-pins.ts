/** Channel-visible references, distinct from a person's private saved messages. */
export interface ChatPin {
  messageId: string;
  pinnedBy: string;
  pinnedAt: number;
}
export interface ChatPinChange { messageId: string; pinned: boolean }

export function readChatPins(value: unknown): ChatPin[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is ChatPin => {
    if (!item || typeof item !== "object" || typeof item.messageId !== "string" || !item.messageId
      || typeof item.pinnedBy !== "string" || !item.pinnedBy || typeof item.pinnedAt !== "number"
      || !Number.isFinite(item.pinnedAt) || seen.has(item.messageId)) return false;
    seen.add(item.messageId);
    return true;
  }).map(({ messageId, pinnedBy, pinnedAt }) => ({ messageId, pinnedBy, pinnedAt }));
}

export function parseChatPinChange(value: unknown): ChatPinChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid channel pin change.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || typeof input.messageId !== "string" || !input.messageId
    || input.messageId.trim() !== input.messageId || input.messageId.length > 256 || typeof input.pinned !== "boolean") {
    throw new Error("Invalid channel pin change.");
  }
  return { messageId: input.messageId, pinned: input.pinned };
}

export function applyChatPinChange(current: unknown, change: unknown, actorId: string, now: number): ChatPin[] {
  const input = parseChatPinChange(change);
  const pins = readChatPins(current);
  if (!input.pinned) return pins.filter(pin => pin.messageId !== input.messageId);
  // An idempotent repeat must not rewrite who originally pinned the message.
  if (pins.some(pin => pin.messageId === input.messageId)) return pins;
  if (pins.length >= 50) throw new Error("Channel pin limit reached. Unpin a message before adding another.");
  if (!actorId || !Number.isFinite(now)) throw new Error("Invalid pin attribution.");
  return [...pins, { messageId: input.messageId, pinnedBy: actorId, pinnedAt: now }];
}
