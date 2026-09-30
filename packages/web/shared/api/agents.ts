import { z } from "zod";

// POST /api/agents/:agentId/config and /archive read each field with their
// own type checks; the schemas only guarantee an object.
export const agentConfigPatchBody = z.record(z.string(), z.unknown());
export type AgentConfigPatchBody = z.input<typeof agentConfigPatchBody>;

export const agentArchiveBody = z.object({
  archived: z.boolean().optional(),
});
export type AgentArchiveBody = z.input<typeof agentArchiveBody>;
