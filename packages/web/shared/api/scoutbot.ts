import { z } from "zod";
import { outgoingAttachment } from "./attachments.ts";

// Scoutbot routes that read `unknown` fields and check each one themselves
// (sessions, reminders, credentials, recap) are not listed here.

export const scoutbotConfigBody = z.object({
  model: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
});
export type ScoutbotConfigBody = z.input<typeof scoutbotConfigBody>;

export const scoutbotChatBody = z.object({
  body: z.string().optional(),
  // Parsed by the route and the assistant, which own their error messages.
  route: z.unknown().optional(),
  uiContext: z.unknown().optional(),
  voiceTurn: z.unknown().optional(),
  stream: z.unknown().optional(),
  usageMode: z.unknown().optional(),
});
export type ScoutbotChatBody = z.input<typeof scoutbotChatBody>;

export const scoutbotPrewarmBody = z.object({
  route: z.unknown().optional(),
});
export type ScoutbotPrewarmBody = z.input<typeof scoutbotPrewarmBody>;

export const scoutbotAskActionBody = z.object({
  targetLabel: z.string().optional(),
  targetAgentId: z.string().optional(),
  body: z.string().optional(),
  channel: z.string().optional(),
});
export type ScoutbotAskActionBody = z.input<typeof scoutbotAskActionBody>;

export const scoutbotBriefBody = z.object({
  route: z.unknown().optional(),
  ttlMs: z.number().nullable().optional(),
});
export type ScoutbotBriefBody = z.input<typeof scoutbotBriefBody>;

// POST /api/scoutbot/messages
export const scoutbotThreadMessageBody = z.object({
  threadId: z.unknown().optional(),
  body: z.unknown().optional(),
  attachments: z.array(outgoingAttachment).optional(),
  replyToMessageId: z.unknown().optional(),
});
export type ScoutbotThreadMessageBody = z.input<typeof scoutbotThreadMessageBody>;
