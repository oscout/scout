/**
 * Scout continuation policy.
 *
 * These levels are the operator-facing permission manager. They do two jobs:
 * name when Scout will swallow a remaining harness stop, and (later) set the
 * underlying tool's permission floor so fewer stops exist. The floor is
 * best-effort. Claude will still leak; that is why continuation exists.
 */

export const CONTINUATION_LEVELS = ["ask", "workspace", "unattended", "silent"] as const;

export type ContinuationLevel = (typeof CONTINUATION_LEVELS)[number];

/**
 * With no explicit grant, Scout continues nothing: every live stop notifies.
 * Higher levels are opt-in per session or project (see `grants.ts`).
 */
export const DEFAULT_CONTINUATION_LEVEL: ContinuationLevel = "ask";

export type ClaudePermissionFloor =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions";

export type CodexPermissionFloor = {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
};

export function normalizeContinuationLevel(
  value: string | null | undefined,
): ContinuationLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  return CONTINUATION_LEVELS.find((level) => level === normalized);
}

export function claudePermissionFloor(level: ContinuationLevel): ClaudePermissionFloor {
  switch (level) {
    case "ask":
      return "default";
    case "workspace":
      return "acceptEdits";
    case "unattended":
      return "auto";
    case "silent":
      return "bypassPermissions";
  }
}

export function codexPermissionFloor(level: ContinuationLevel): CodexPermissionFloor {
  switch (level) {
    case "ask":
      return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "workspace":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "unattended":
    case "silent":
      return { approvalPolicy: "never", sandbox: "workspace-write" };
  }
}
