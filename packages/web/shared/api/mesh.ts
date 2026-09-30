import { z } from "zod";

// PATCH /api/machines/:reference — forwarded to the broker, so unknown keys
// are dropped rather than passed through.
export const machineAnnotationBody = z.object({
  displayName: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});
export type MachineAnnotationBody = z.input<typeof machineAnnotationBody>;

export const tailscaleControlBody = z.object({
  action: z.enum(["open_app"]),
});
export type TailscaleControlBody = z.input<typeof tailscaleControlBody>;

// A dotted IPv4 literal only: the route interpolates it into a URL, so
// anything else (userinfo, ports, hostnames) must not get that far.
export const tailnetProbeBody = z.object({
  ip: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}$/u, "must be an IPv4 address"),
});
export type TailnetProbeBody = z.input<typeof tailnetProbeBody>;

// Problems GET /api/mesh reports under `issues`.
export type MeshIssueCode =
  | "broker_unreachable"
  | "broker_slow"
  | "broker_degraded"
  | "broker_snapshot_unavailable"
  | "tailscale_stopped"
  | "local_only"
  | "mesh_loopback"
  | "discovery_unconfigured";

export type MeshIssue = {
  code: MeshIssueCode;
  severity: "warning" | "error";
  title: string;
  summary: string;
  action: string | null;
  actionCommand: string | null;
};
