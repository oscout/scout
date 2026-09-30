import { z } from "zod";

export const roleAssignmentBody = z.object({
  roleId: z.string().optional(),
  agentId: z.string().optional(),
  scope: z.object({
    kind: z.string().optional(),
    missionId: z.string().optional(),
    projectRoot: z.string().optional(),
  }).optional(),
  assignedById: z.string().optional(),
  enforceSingleOrchestrator: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RoleAssignmentBody = z.input<typeof roleAssignmentBody>;

export const roleRevokeBody = z.object({
  revokedById: z.string().optional(),
});
export type RoleRevokeBody = z.input<typeof roleRevokeBody>;

// `kind` stays a string here; the broker owns the mission-log kind list and
// rejects unknown kinds itself.
export const missionLogEntryBody = z.object({
  actorId: z.string().optional(),
  kind: z.string().optional(),
  intent: z.string().optional(),
  status: z.string().optional(),
  checkpoint: z.string().optional(),
  nodeId: z.string().optional(),
  note: z.string().optional(),
  blockers: z.array(z.object({ label: z.string(), ownerId: z.string().optional() })).optional(),
  refs: z.record(z.string(), z.string()).optional(),
  projectRoot: z.string().optional(),
});
export type MissionLogEntryBody = z.input<typeof missionLogEntryBody>;
