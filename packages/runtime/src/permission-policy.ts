import {
  formatScoutPermissionProfiles,
  normalizeScoutPermissionProfile,
  type ScoutPermissionProfile,
} from "@openscout/protocol";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type PermissionEnforcementLevel = "native" | "advisory" | "unsupported";

export type CodexPermissionPosture = {
  profile: ScoutPermissionProfile;
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  enforcement: PermissionEnforcementLevel;
  note?: string;
};

export function parseScoutPermissionProfile(
  value: string | null | undefined,
): ScoutPermissionProfile | undefined {
  const profile = normalizeScoutPermissionProfile(value);
  if (value && !profile) {
    throw new Error(`Unknown permission profile "${value}". Expected one of: ${formatScoutPermissionProfiles()}.`);
  }
  return profile;
}

export function compileCodexPermissionProfile(
  profileInput: ScoutPermissionProfile | string | null | undefined,
): CodexPermissionPosture {
  const profile = profileInput
    ? parseScoutPermissionProfile(profileInput) ?? "trusted_local"
    : "trusted_local";

  switch (profile) {
    case "observe":
    case "review":
      return {
        profile,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        enforcement: "native",
      };
    case "workspace_write":
      return {
        profile,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        enforcement: "native",
      };
    case "sandboxed_write":
      return {
        profile,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        enforcement: "advisory",
        note: "External sandbox placement is not wired yet; Codex receives its native workspace-write sandbox.",
      };
    case "external_sandbox":
      return {
        profile,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        enforcement: "advisory",
        note: "External sandbox placement is not wired yet; Codex receives its native workspace-write sandbox.",
      };
    case "trusted_local":
      return {
        profile,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        enforcement: "native",
      };
  }
}
