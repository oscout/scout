import { FeatureFlagsProvider } from "hudsonkit/flags";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MessageComposerEmbedBoundary } from "../components/MessageComposer/MessageComposerEmbedBoundary.tsx";
import type { ScoutTheme } from "../lib/theme.ts";
import {
  SCOUT_AUDIENCE_ORDER,
  SCOUT_DEFAULT_AUDIENCE,
  SCOUT_FLAG_STORAGE_KEY,
  scoutFlagInitialLayers,
  scoutFlags,
} from "../lib/scout-flags.ts";
import { ScoutProvider } from "../scout/Provider.tsx";
import { DiscoveredEmbedHost } from "./EmbedHost.tsx";
import { resolveEmbeddableSurface } from "./discover.ts";

export async function mountDiscoveredEmbed(
  el: HTMLElement,
  initialTheme: ScoutTheme,
): Promise<boolean> {
  const surface = await resolveEmbeddableSurface(window.location.pathname);
  if (!surface) return false;

  createRoot(el).render(
    <StrictMode>
      <MessageComposerEmbedBoundary>
        {/* Same flag stack as OpenScoutAppShell. Without it every embed read the
            hardcoded fallback instead of the registry default, so a surface that
            is gated — live voice — could never turn on inside a native host. */}
        <FeatureFlagsProvider
          registry={scoutFlags}
          audience={SCOUT_DEFAULT_AUDIENCE}
          audienceOrder={SCOUT_AUDIENCE_ORDER}
          storageKey={SCOUT_FLAG_STORAGE_KEY}
          initialLayers={scoutFlagInitialLayers()}
        >
          <ScoutProvider initialTheme={initialTheme}>
            <DiscoveredEmbedHost surface={surface} />
          </ScoutProvider>
        </FeatureFlagsProvider>
      </MessageComposerEmbedBoundary>
    </StrictMode>,
  );
  return true;
}
