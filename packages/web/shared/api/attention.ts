import { z } from "zod";

export const approvalDecisionBody = z.object({
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  blockId: z.string().optional(),
  version: z.number().optional(),
  decision: z.string().optional(),
  reason: z.string().nullable().optional(),
});
export type ApprovalDecisionBody = z.input<typeof approvalDecisionBody>;
