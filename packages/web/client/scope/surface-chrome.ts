import type { SurfaceChrome } from "../scout/surface-chrome.ts";
import { isScopePath } from "./paths.ts";

const SCOPE_SURFACE_CHROME: SurfaceChrome = {
  showSecondaryNav: false,
  showPageStatusBar: false,
};

/** Chrome for the active URL — Scope paths use lean instrument chrome. */
export function resolveSurfaceChrome(pathname: string): SurfaceChrome {
  return isScopePath(pathname) ? SCOPE_SURFACE_CHROME : {
    showSecondaryNav: true,
    showPageStatusBar: true,
  };
}