import { z } from "zod";
import { outgoingAttachment } from "./attachments.ts";

// Execution overrides are resolved against the runtime catalog by the route.
const executionOverride = z.object({
  harness: z.unknown().optional(),
  model: z.unknown().optional(),
  reasoningEffort: z.unknown().optional(),
});

// POST /api/chats/:chatId/messages
export const chatMessageSendBody = z.object({
  body: z.unknown().optional(),
  attachments: z.array(outgoingAttachment).optional(),
  replyToMessageId: z.unknown().optional(),
  clientMessageId: z.unknown().optional(),
});
export type ChatMessageSendBody = z.input<typeof chatMessageSendBody>;

// POST /api/send
export const sendBody = z.object({
  body: z.string().optional(),
  chatId: z.string().optional(),
  cId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  attachments: z.array(outgoingAttachment).optional(),
  intent: z.string().optional(),
  mode: z.string().optional(),
  targetParticipantIds: z.array(z.string()).optional(),
  replyToMessageId: z.unknown().optional(),
  execution: executionOverride.optional(),
});
export type SendBody = z.input<typeof sendBody>;

// POST /api/ask
export const askBody = z.object({
  body: z.unknown().optional(),
  chatId: z.string().optional(),
  cId: z.string().optional(),
  conversationId: z.string().optional(),
  targetAgentId: z.unknown().optional(),
  targetLabel: z.unknown().optional(),
  metadata: z.unknown().optional(),
  attachments: z.array(outgoingAttachment).optional(),
  execution: executionOverride.optional(),
});
export type AskBody = z.input<typeof askBody>;

// POST /api/sessions/reply: a reply to a harness session seen in the tail.
// Same delivery as the phone's askSession: into the live place, else resume.
export const sessionReplyBody = z.object({
  sessionId: z.string().min(1),
  harness: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  body: z.string(),
  clientMessageId: z.string().nullable().optional(),
  source: z.string().optional(),
});
export type SessionReplyBody = z.input<typeof sessionReplyBody>;
