import { z } from "zod";
import type { TerminalWorkspaceRecordInput } from "@openscout/protocol";

const nullableString = z.string().nullable().optional();

const terminalWorkspaceCell = z.object({
  id: z.string(),
  surfaceId: nullableString,
  terminalSessionId: nullableString,
  intent: z.object({
    hostId: nullableString,
    sessionName: nullableString,
    cwd: nullableString,
    harness: nullableString,
    resumeCommand: nullableString,
  }),
});

// PUT/POST /api/terminal-workspaces. `name` is optional here only so the
// route keeps answering "name is required"; the record is stored as JSON, so
// every nested field is checked before it lands.
export const terminalWorkspaceBody = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  purpose: z.string().optional(),
  columns: z.number().optional(),
  layout: z.object({
    mode: z.enum(["solo", "lanes", "grid"]),
    columns: z.union([z.number(), z.literal("dynamic")]).optional(),
  }).optional(),
  cells: z.array(terminalWorkspaceCell).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<Partial<TerminalWorkspaceRecordInput>>;
export type TerminalWorkspaceBody = z.input<typeof terminalWorkspaceBody>;

export const herdrFocusBody = z.object({ target: z.string().optional() });
export type HerdrFocusBody = z.input<typeof herdrFocusBody>;

export const terminalHostSessionCreateBody = z.object({
  sessionName: z.string().optional(),
  cwd: nullableString,
});
export type TerminalHostSessionCreateBody = z.input<typeof terminalHostSessionCreateBody>;

export const terminalRunBody = z.object({
  command: z.string().optional(),
  cwd: nullableString,
  agentId: nullableString,
});
export type TerminalRunBody = z.input<typeof terminalRunBody>;

export const terminalRelayDestroyBody = z.object({ sessionId: z.string().optional() });
export type TerminalRelayDestroyBody = z.input<typeof terminalRelayDestroyBody>;

export const terminalSurfaceControlBody = z.object({
  backend: z.string().optional(),
  sessionName: z.string().optional(),
  action: z.string().optional(),
});
export type TerminalSurfaceControlBody = z.input<typeof terminalSurfaceControlBody>;
