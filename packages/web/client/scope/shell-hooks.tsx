import { createElement, type ReactNode } from "react";
import type { HudsonApp } from "@hudsonkit";
import type { TakeoverState } from "@hudsonkit";
import { useOptionalFlag } from "hudsonkit/flags";
import { useScout } from "../scout/Provider.tsx";
import { renderNavCenter } from "../scout/nav-center.tsx";
import {
  useScoutNavActions as useScoutNavActionsBase,
  useScoutNavCenter as useScoutNavCenterBase,
  useScoutTakeover,
} from "../scout/hooks.ts";
import { SCOPE_BRAND_LABEL } from "./paths.ts";
import { useScopePresentation } from "./hooks.ts";
import { SCOPE_TOP_NAV_ITEMS, scopeTopNavKeyForRoute } from "./nav.ts";
import { ScopeAppContent } from "./ScopeAppContent.tsx";

export function useScopeNavCenter(): ReactNode | null {
  const { route, navigate } = useScout();

  return renderNavCenter({
    className: "scout-nav-tabs scout-nav-tabs--scope",
    brandTag: SCOPE_BRAND_LABEL,
    items: SCOPE_TOP_NAV_ITEMS,
    activeKey: scopeTopNavKeyForRoute(route),
    navigate,
  });
}

export function useIntegratedNavCenter(): ReactNode | null {
  const scope = useScopePresentation();
  const scoutNav = useScoutNavCenterBase();
  const scopeNav = useScopeNavCenter();
  // SCO-085: sidebar mode unmounts the top bar; Scope destinations live in
  // ScoutSidebar via useSidebarModel. Do not project a duplicate nav-center.
  if (useOptionalFlag("nav.sidebar", false)) return null;
  return scope ? scopeNav : scoutNav;
}

export function useIntegratedNavActions(): ReactNode | null {
  const scope = useScopePresentation();
  const scoutActions = useScoutNavActionsBase();
  if (useOptionalFlag("nav.sidebar", false)) return null;

  if (!scope) return scoutActions;

  return createElement("div", { className: "scout-nav-actions" });
}

export function useIntegratedTakeover(): TakeoverState | null {
  const scope = useScopePresentation();
  const takeover = useScoutTakeover();
  if (scope) return { active: false, dismissible: true };
  return takeover;
}

/** Attach Scope on top of Scout — slots and shell hooks only; Scout code stays Scope-free. */
export function wireScopeOntoScout(app: HudsonApp): void {
  app.slots.Content = ScopeAppContent;
  app.hooks.useNavCenter = useIntegratedNavCenter;
  app.hooks.useNavActions = useIntegratedNavActions;
  app.hooks.useTakeover = useIntegratedTakeover;
}