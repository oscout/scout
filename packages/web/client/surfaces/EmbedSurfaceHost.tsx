import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useBrowserLocation } from "../lib/router.ts";
import type { Route } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";
import { routeEmbeddedNavigation } from "./embed-navigation.ts";
import type { RegisteredSurface } from "./types.ts";
import { resolveEmbedChrome } from "./types.ts";

function routeMatchesSurfaceRoute(route: unknown, surfaceRoute: unknown): boolean {
  if (!route || typeof route !== "object" || !surfaceRoute || typeof surfaceRoute !== "object") {
    return false;
  }
  const current = route as Record<string, unknown>;
  return Object.entries(surfaceRoute as Record<string, unknown>)
    .every(([key, value]) => current[key] === value);
}

/**
 * Mounts one embeddable surface for a native host. When the route leaves the
 * surface, `renderFallback` decides what shows: the full app resolves any
 * pane; the basic client has nothing else to offer. Kept free of the full
 * pane resolver so the basic client can use it without that graph.
 */
export function EmbedSurfaceHost({
  surface,
  renderFallback,
  installKeyboard,
}: {
  surface: RegisteredSurface;
  renderFallback?: (props: { route: Route; navigate: (route: Route) => void }) => ReactNode;
  /** Native-area go-shortcuts; the full app passes them (they name full-app destinations). */
  installKeyboard?: (navigate: (route: Route) => void) => () => void;
}) {
  const { route, navigate } = useScout();
  const { searchStr } = useBrowserLocation();
  const Screen = surface.Screen;
  const embed = surface.embed!;
  const ownsInternalRoutes = Boolean(surface.embed?.ownsInternalRoutes);
  const isInternalRoute = useCallback(
    (destination: Route) =>
      ownsInternalRoutes && routeMatchesSurfaceRoute(destination, surface.route)
      && (embed.isInternalRoute?.(destination) ?? true),
    [ownsInternalRoutes, surface.route, embed.isInternalRoute],
  );
  const navigateFromEmbed = useCallback(
    (destination: Route) =>
      routeEmbeddedNavigation(destination, navigate, undefined, isInternalRoute),
    [isInternalRoute, navigate],
  );
  useEffect(() => {
    if (!installKeyboard) return;
    if (!["/embed/home", "/embed/search", "/embed/ops"].includes(window.location.pathname)) return;
    return installKeyboard(navigateFromEmbed);
  }, [installKeyboard, navigateFromEmbed]);
  const shouldRenderSurface =
    typeof window === "undefined"
    || surface.embedPaths.includes(window.location.pathname)
    || routeMatchesSurfaceRoute(route, surface.route);

  const extraProps = useMemo(() => {
    if (!embed.resolveEmbedProps) return {};
    return embed.resolveEmbedProps(new URLSearchParams(searchStr));
  }, [embed, searchStr]);

  const chrome = resolveEmbedChrome(embed);
  const rootClassName = [
    embed.rootClassName,
    "s-discovered-embed",
    chrome.showSecondaryNav ? "" : "s-discovered-embed--lean",
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClassName} data-scout-theme data-scout-surface={surface.id}>
      {shouldRenderSurface
        ? <Screen navigate={navigateFromEmbed} embedded {...extraProps} />
        : renderFallback?.({ route, navigate: navigateFromEmbed }) ?? null}
    </div>
  );
}
