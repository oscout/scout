import type { MessageRecord } from "./messages.js";

export interface ChatMessageCorrection { revision: number; editedAt?: number; deletedAt?: number; changedBy: string }
export type ChatMessageChange = { expectedRevision: number; body: string } | { expectedRevision: number; deleted: true };
export class ChatMessageCorrectionError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
export function readChatMessageCorrection(metadata: unknown): ChatMessageCorrection | undefined {
  const value = (metadata as { chatCorrection?: unknown } | null)?.chatCorrection;
  if (!value || typeof value !== "object") return;
  const item = value as ChatMessageCorrection;
  if (!Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.changedBy !== "string") return;
  return { revision: item.revision, changedBy: item.changedBy,
    ...(typeof item.editedAt === "number" && Number.isFinite(item.editedAt) ? { editedAt: item.editedAt } : {}),
    ...(typeof item.deletedAt === "number" && Number.isFinite(item.deletedAt) ? { deletedAt: item.deletedAt } : {}) };
}
export function parseChatMessageChange(value: unknown): ChatMessageChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatMessageCorrectionError(400, "Invalid message change.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) throw new ChatMessageCorrectionError(400, "Invalid message revision.");
  if (input.deleted === true) return { expectedRevision: input.expectedRevision as number, deleted: true };
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 32_000) throw new ChatMessageCorrectionError(400, "Message must contain between 1 and 32000 characters.");
  return { expectedRevision: input.expectedRevision as number, body: input.body };
}

/** A correction affects the shared record, never a new delivery or invocation. */
export function correctChatMessage<T extends Pick<MessageRecord, "actorId" | "body"> & {
  metadata?: MessageRecord["metadata"] | null; attachments?: unknown[]; mentions?: unknown[]; speech?: unknown;
}>(message: T, input: unknown, actorId: string, canModerate: boolean, now: number): T {
  const change = parseChatMessageChange(input);
  const prior = readChatMessageCorrection(message.metadata);
  const deleting = "deleted" in change;
  if (message.actorId !== actorId && !(deleting && canModerate)) throw new ChatMessageCorrectionError(403, "Only the author can edit this message. Hosts can also delete messages.");
  if ((prior?.revision ?? 0) !== change.expectedRevision) throw new ChatMessageCorrectionError(409, "This message changed since you opened it. Review the latest version before trying again.");
  if (prior?.deletedAt != null) throw new ChatMessageCorrectionError(409, "This message has already been deleted.");
  const correction: ChatMessageCorrection = { ...prior, revision: (prior?.revision ?? 0) + 1, changedBy: actorId, ...(deleting ? { deletedAt: now } : { editedAt: now }) };
  return { ...message, body: deleting ? "" : change.body,
    ...(deleting ? { attachments: [], mentions: [], speech: undefined } : {}),
    metadata: { ...message.metadata, chatCorrection: correction } };
}
