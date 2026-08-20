import { useEffect } from "react";
import { useBrowserLocation } from "../lib/router.ts";
import type { Route } from "../lib/types.ts";
import { isScopePath } from "./paths.ts";
import { isScopePresentation, scopePresentationAttrs } from "./presentation.ts";
import { SCOPE_BRAND_LABEL } from "./paths.ts";
import { scopePresentationTitle } from "./nav.ts";

export function useScopePresentation(): boolean {
  const { pathname } = useBrowserLocation();
  return isScopePath(pathname);
}

export function useScopePresentationAttrs(): Record<string, boolean> | undefined {
  return scopePresentationAttrs(useScopePresentation());
}

/**
 * Shell chrome: document marker for the lean instrument view.
 *
 * SCO-083: do NOT force-write persisted left/right collapse preferences.
 * Presentation collapse is derived in the shell from `active` (path-driven)
 * so leaving Scope cannot leave the normal app collapsed.
 */
export function useScopeShellChrome(options: {
  route: Route;
  /** @deprecated SCO-083 — presentation collapse is derived; no longer written. */
  setLeftCollapsed?: (value: boolean | ((current: boolean) => boolean)) => void;
  /** @deprecated SCO-083 — presentation collapse is derived; no longer written. */
  setRightCollapsed?: (value: boolean | ((current: boolean) => boolean)) => void;
}): { active: boolean; brandLabel: string } {
  const active = useScopePresentation();

  useEffect(() => {
    if (active) {
      document.documentElement.setAttribute("data-scope-presentation", "");
    } else {
      document.documentElement.removeAttribute("data-scope-presentation");
    }
    return () => document.documentElement.removeAttribute("data-scope-presentation");
  }, [active]);

  return {
    active,
    brandLabel: active ? scopePresentationTitle(options.route) : SCOPE_BRAND_LABEL,
  };
}

export function isScopeOnboardingExempt(): boolean {
  return isScopePath(typeof window !== "undefined" ? window.location.pathname : "");
}