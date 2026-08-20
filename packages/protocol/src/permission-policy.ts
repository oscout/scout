export const SCOUT_PERMISSION_PROFILES = [
  "observe",
  "review",
  "workspace_write",
  "sandboxed_write",
  "trusted_local",
  "external_sandbox",
] as const;

export type ScoutPermissionProfile = typeof SCOUT_PERMISSION_PROFILES[number];

export function normalizeScoutPermissionProfile(
  value: string | null | undefined,
): ScoutPermissionProfile | undefined {
  const normalized = value?.trim().replaceAll("-", "_");
  return SCOUT_PERMISSION_PROFILES.find((profile) => profile === normalized);
}

export function formatScoutPermissionProfiles(): string {
  return SCOUT_PERMISSION_PROFILES.join("|");
}
