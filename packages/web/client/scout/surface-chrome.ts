/** Per-surface chrome flags — set at the route boundary, consumed by Scout screens. */
export type SurfaceChrome = {
  /** Secondary nav bars (AgentsSubnav, OpsSubnav, …). */
  showSecondaryNav: boolean;
  /** Ops page status footer. */
  showPageStatusBar: boolean;
};

export const DEFAULT_SURFACE_CHROME: SurfaceChrome = {
  showSecondaryNav: true,
  showPageStatusBar: true,
};