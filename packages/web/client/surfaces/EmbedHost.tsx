import { lazy, Suspense } from "react";
import type { Route } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";
import { EmbedSurfaceHost } from "./EmbedSurfaceHost.tsx";
import { installNativeAreaKeyboard } from "./native-area-keyboard.ts";
import type { RegisteredSurface } from "./types.ts";

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

function FullAppFallback({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  const { agents } = useScout();
  return (
    <Suspense fallback={null}>
      <RoutedSurfaceFallback route={route} navigate={navigate} agents={agents} />
    </Suspense>
  );
}

/** The full app's embed host: any route the surface hands off resolves to its pane. */
export function DiscoveredEmbedHost({ surface }: { surface: RegisteredSurface }) {
  return (
    <EmbedSurfaceHost
      surface={surface}
      renderFallback={(props) => <FullAppFallback {...props} />}
      installKeyboard={installNativeAreaKeyboard}
    />
  );
}
