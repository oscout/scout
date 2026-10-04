/**
 * Embeds the basic client carries for native hosts. The Mac app loads these
 * paths into web views; basic serves the ones that match what it already has
 * (Settings, Home, a thread, a session) and says plainly when a path needs
 * the full web app, instead of folding it onto the basic shell.
 *
 * Nothing here may reach the full app's pane resolver or the discovery glob:
 * each embed is one explicit import.
 */
import { lazy, Suspense, useCallback, type ComponentType } from "react";

import { routeEmbeddedNavigation } from "../surfaces/embed-navigation.ts";
import { registerSurface, type SurfaceModule } from "../surfaces/discover-build.ts";
import { EmbedSurfaceHost } from "../surfaces/EmbedSurfaceHost.tsx";
import type { Route } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";
import { BasicHome } from "./BasicHome.tsx";
import { isBasicEmbedPath, type BasicEmbedPath } from "./profile.ts";

export { isEmbedPath } from "./profile.ts";

function surfaceEmbed(modulePath: string, load: () => Promise<SurfaceModule>): ComponentType {
  return lazy(async () => {
    const surface = registerSurface(modulePath, await load());
    if (!surface) throw new Error(`${modulePath} has no embeddable scoutSurface`);
    return { default: () => <EmbedSurfaceHost surface={surface} /> };
  });
}

/** Basic's Home in a native host: no basic header, navigation handed to the host. */
function HomeEmbed() {
  const { navigate } = useScout();
  const navigateFromEmbed = useCallback(
    (route: Route) => routeEmbeddedNavigation(route, navigate),
    [navigate],
  );
  return (
    <div className="s-discovered-embed sb-embed-home" data-scout-theme data-scout-surface="home">
      <BasicHome navigate={navigateFromEmbed} />
    </div>
  );
}

const SessionEmbed = lazy(async () => {
  const { SessionEmbedScreen } = await import("../screens/sessions/SessionEmbedScreen.tsx");
  return { default: SessionEmbedScreen };
});

const BASIC_EMBEDS: Record<BasicEmbedPath, ComponentType> = {
  "/embed/settings": surfaceEmbed("../screens/settings/ScoutSettings.tsx", () => import("../screens/settings/ScoutSettings.tsx")),
  "/embed/thread": surfaceEmbed("../screens/chat/ConversationScreen.tsx", () => import("../screens/chat/ConversationScreen.tsx")),
  "/embed/home": HomeEmbed,
  "/embed/session": SessionEmbed,
};

function FullAppOnly() {
  return (
    <main className="sb-embed-miss" data-scout-theme>
      <h1>This view is in the full web app</h1>
      <p>
        This Scout serves the basic web app. Run <code>scout web install</code> to add the full one.
      </p>
    </main>
  );
}

export function BasicEmbed({ pathname }: { pathname: string }) {
  if (!isBasicEmbedPath(pathname)) return <FullAppOnly />;
  const Embed = BASIC_EMBEDS[pathname];
  return (
    <Suspense fallback={null}>
      <Embed />
    </Suspense>
  );
}
