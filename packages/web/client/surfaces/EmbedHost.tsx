import { lazy, Suspense, useCallback, useMemo } from "react";
import type { Route } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";
import { routeEmbeddedNavigation } from "./embed-navigation.ts";
import type { RegisteredSurface } from "./types.ts";
import { resolveEmbedChrome } from "./types.ts";

type RoutedSurfaceFallbackProps = Pick<
  ReturnType<typeof useScout>,
  "route" | "navigate" | "agents"
>;

const RoutedSurfaceFallback = lazy(async () => {
  const { resolveContentPane } = await import("../screens/resolve-panes.tsx");
  return {
    default: ({ route, navigate, agents }: RoutedSurfaceFallbackProps) =>
      resolveContentPane(route, navigate, agents),
  };
});

function routeMatchesSurfaceRoute(route: unknown, surfaceRoute: unknown): boolean {
  if (!route || typeof route !== "object" || !surfaceRoute || typeof surfaceRoute !== "object") {
    return false;
  }
  const current = route as Record<string, unknown>;
  return Object.entries(surfaceRoute as Record<string, unknown>)
    .every(([key, value]) => current[key] === value);
}

export function DiscoveredEmbedHost({ surface }: { surface: RegisteredSurface }) {
  const { route, navigate, agents } = useScout();
  const Screen = surface.Screen;
  const embed = surface.embed!;
  const ownsInternalRoutes = Boolean(surface.embed?.ownsInternalRoutes);
  const isInternalRoute = useCallback(
    (destination: Route) =>
      ownsInternalRoutes && routeMatchesSurfaceRoute(destination, surface.route),
    [ownsInternalRoutes, surface.route],
  );
  const navigateFromEmbed = useCallback(
    (destination: Route) =>
      routeEmbeddedNavigation(destination, navigate, undefined, isInternalRoute),
    [isInternalRoute, navigate],
  );
  const shouldRenderSurface =
    typeof window === "undefined"
    || surface.embedPaths.includes(window.location.pathname)
    || routeMatchesSurfaceRoute(route, surface.route);

  const extraProps = useMemo(() => {
    if (!embed.resolveEmbedProps) return {};
    return embed.resolveEmbedProps(new URLSearchParams(window.location.search));
  }, [embed]);

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
        : (
          <Suspense fallback={null}>
            <RoutedSurfaceFallback route={route} navigate={navigateFromEmbed} agents={agents} />
          </Suspense>
        )}
    </div>
  );
}
