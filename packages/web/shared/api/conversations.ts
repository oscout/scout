import { z } from "zod";

export const conversationReadCursorBody = z.object({
  actorId: z.string().optional(),
  lastReadMessageId: z.string().optional(),
  lastReadSeq: z.number().optional(),
  lastReadAt: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ConversationReadCursorBody = z.input<typeof conversationReadCursorBody>;

export const conversationMemberBody = z.object({
  actorId: z.string().optional(),
});
export type ConversationMemberBody = z.input<typeof conversationMemberBody>;
