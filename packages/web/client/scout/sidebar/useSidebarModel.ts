/**
 * Sidebar model seam (SCO-083).
 *
 * Lets Scope (path-driven) or other presentations supply an alternate primary
 * destination list without replacing the left-panel slot. The Scout sidebar
 * remains path-aware via useScopePresentation / isScopePath.
 */
import { useMemo } from "react";
import { useOptionalFlag } from "hudsonkit/flags";
import type { Route } from "../../lib/types.ts";
import { useBrowserLocation } from "../../lib/router.ts";
import { isScopePath } from "../../scope/paths.ts";
import { SCOPE_TOP_NAV_ITEMS, scopeTopNavKeyForRoute } from "../../scope/nav.ts";
import {
  PRIMARY_AREAS,
  defaultRouteForArea,
  primaryAreaForRoute,
  type PrimaryArea,
  type PrimaryAreaId,
} from "../primary-areas.ts";

export type SidebarModelItem = {
  id: string;
  label: string;
  route: Route;
  active: boolean;
};

export type SidebarModel = {
  /** Which chrome owns navigation for this presentation. */
  kind: "scout" | "scope";
  /** Primary destinations for the current presentation. */
  items: SidebarModelItem[];
  /** Active primary destination id. */
  activeId: string | null;
  /** Whether the nav.sidebar experiment is on (Scout chrome only). */
  sidebarChromeEnabled: boolean;
  /** Path-driven Scope presentation (independent of nav.sidebar). */
  scopePresentation: boolean;
};

/**
 * Resolve the active sidebar model from path + flags.
 * Scope wins by path regardless of the sidebar experiment flag.
 */
export function useSidebarModel(route: Route): SidebarModel {
  const { pathname } = useBrowserLocation();
  const sidebarChromeEnabled = useOptionalFlag("nav.sidebar", false);
  const scopePresentation = isScopePath(pathname);

  return useMemo(() => {
    if (scopePresentation) {
      const activeKey = scopeTopNavKeyForRoute(route);
      return {
        kind: "scope" as const,
        items: SCOPE_TOP_NAV_ITEMS.map((item) => ({
          id: item.key,
          label: item.label,
          route: item.route,
          active: item.key === activeKey,
        })),
        activeId: activeKey,
        sidebarChromeEnabled,
        scopePresentation: true,
      };
    }

    const activeAreaId = primaryAreaForRoute(route);
    const items: SidebarModelItem[] = PRIMARY_AREAS.map((area: PrimaryArea) => ({
      id: area.id,
      label: area.label,
      route: defaultRouteForArea(area.id as PrimaryAreaId),
      active: area.id === activeAreaId,
    }));

    return {
      kind: "scout" as const,
      items,
      activeId: activeAreaId,
      sidebarChromeEnabled,
      scopePresentation: false,
    };
  }, [route, scopePresentation, sidebarChromeEnabled]);
}
