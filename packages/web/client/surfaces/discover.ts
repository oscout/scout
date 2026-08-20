import {
  buildLazySurfaceRegistry,
  type LazySurfaceModule,
  type SurfaceModule,
} from "./discover-build.ts";
import type { RegisteredSurface } from "./types.ts";

// Tests are excluded explicitly: this glob decides what reaches the browser
// bundle, so without the negation a `*.test.tsx` beside a screen pulls
// `bun:test` and `react-dom/server` into the client build and fails it. That is
// why screen-level component tests did not exist before — the failure looked
// like the test was wrong rather than the glob being too wide.
const screenModules = import.meta.glob<SurfaceModule>([
  "../screens/**/*.tsx",
  "!../screens/**/*.test.tsx",
]);

// The definitions remain beside their screens. This small routing index lets an
// embed select one lazy module without evaluating every screen just to inspect
// its scoutSurface export. The lazy registry verifies both copies agree.
const lazySurfaceModules = [
  {
    modulePath: "../screens/broker/BrokerScreen.tsx",
    embedPaths: ["/embed/dispatch"],
  },
  {
    modulePath: "../screens/chat/ConversationScreen.tsx",
    embedPaths: ["/embed/thread"],
  },
  {
    modulePath: "../screens/code/CodeScreen.tsx",
    embedPaths: ["/embed/code"],
  },
  {
    modulePath: "../screens/ops/AgentLanesView.tsx",
    embedPaths: ["/embed/agent-lanes", "/ops/lanes/embed", "/embed/lanes", "/embed/traces"],
  },
  {
    modulePath: "../screens/projects/ProjectsScreen.tsx",
    embedPaths: ["/embed/projects"],
  },
  {
    modulePath: "../screens/voice/RealtimeVoiceScreen.tsx",
    embedPaths: ["/embed/voice"],
  },
] as const satisfies readonly LazySurfaceModule[];

const lazyRegistry = buildLazySurfaceRegistry(screenModules, lazySurfaceModules);

export function resolveEmbeddableSurface(pathname: string): Promise<RegisteredSurface | null> {
  return lazyRegistry.resolve(pathname);
}

export async function listEmbeddableSurfaceSummaries() {
  const surfaces = await lazyRegistry.loadAll();
  return surfaces.map((surface) => ({
    id: surface.id,
    label: surface.label,
    webPath: surface.webPath,
    embedPath: surface.embedPath,
    embedAliases: surface.embed?.aliases ?? [],
    profile: surface.embed?.profile ?? `macos.${surface.id}`,
    route: surface.route,
    modulePath: surface.modulePath,
    screen: surface.screen,
    macosHost: surface.embed?.hosts?.macos ?? true,
  }));
}
