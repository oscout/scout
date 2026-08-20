/**
 * Host / distribution surface for Scout UI shells. Drives which host integrations
 * are allowed (native picker, broker install, etc.) without coupling shells to
 * package names at runtime.
 */
export type ScoutHostSurface = "desktop" | "web" | "cli";

/**
 * Fine-grained host abilities exposed to the desktop UI so it can hide or soften
 * actions that this distribution cannot support.
 */
export type ScoutSurfaceCapabilities = {
  /** Install/update OpenScout runtime, onboarding doctor/setup that provisions services */
  canProvisionRuntime: boolean;
  /** Start/stop/restart broker service (launchd / CLI subprocess) */
  canManageBroker: boolean;
  /** Read/write OpenScout settings, project lists, workspace discovery on disk */
  canEditFilesystem: boolean;
  /** Native folder picker; web uses manual paths only */
  canPickDirectory: boolean;
  /** Reveal path in Finder / shell.showItemInFolder */
  canRevealPath: boolean;
  /** Open tmux / Terminal / native log session for an agent */
  canOpenNativeSession: boolean;
  /** Quit or reload the host application process */
  canQuitHost: boolean;
};

export function resolveScoutSurfaceCapabilities(surface: ScoutHostSurface): ScoutSurfaceCapabilities {
  switch (surface) {
    case "desktop":
      return {
        canProvisionRuntime: true,
        canManageBroker: true,
        canEditFilesystem: true,
        canPickDirectory: true,
        canRevealPath: true,
        canOpenNativeSession: true,
        canQuitHost: true,
      };
    case "web":
      return {
        canProvisionRuntime: false,
        /** Broker install/start/stop is host-local; web shell is only for browsing. */
        canManageBroker: false,
        /** Retire/restore and similar registry edits are not allowed from the web host. */
        canEditFilesystem: false,
        canPickDirectory: false,
        canRevealPath: false,
        canOpenNativeSession: false,
        canQuitHost: false,
      };
    case "cli":
      return {
        canProvisionRuntime: true,
        canManageBroker: true,
        canEditFilesystem: true,
        canPickDirectory: false,
        canRevealPath: false,
        canOpenNativeSession: false,
        canQuitHost: false,
      };
  }
}

/** Use when constructing app info for `@openscout/scout` terminal-only flows. */
export const SCOUT_CLI_HOST_SURFACE: ScoutHostSurface = "cli";
