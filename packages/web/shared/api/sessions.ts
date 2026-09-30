import { z } from "zod";
import { outgoingAttachment } from "./attachments.ts";

// POST /api/sessions — start fresh in a project, start an agent fresh,
// continue an agent's harness session, or seed a conversation from a message.
export const sessionStartBody = z.object({
  target: z.object({
    agentId: z.string().optional(),
    projectPath: z.string().optional(),
  }).optional(),
  execution: z.object({
    harness: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    session: z.string().optional(),
    targetSessionId: z.string().optional(),
    forkFromSessionId: z.string().optional(),
    forkFromStateId: z.string().optional(),
  }).optional(),
  agent: z.object({
    persistence: z.string().optional(),
    handle: z.string().optional(),
  }).optional(),
  seed: z.object({
    instructions: z.string().optional(),
    clientMessageId: z.string().optional(),
    fromMessageId: z.string().optional(),
    fromConversationId: z.string().optional(),
    attachments: z.array(outgoingAttachment).optional(),
    branchFrom: z.object({
      sessionId: z.string().optional(),
      messageId: z.string().optional(),
    }).optional(),
  }).optional(),
});
export type SessionStartBody = z.input<typeof sessionStartBody>;
