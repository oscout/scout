/**
 * Entry for the basic web client that ships in the `@openscout/scout` npm
 * package: Home, DMs and Tail over the local broker. It shares the full app's
 * provider, theme and screens, but mounts none of the full shell — no Hudson
 * panel frame, pane resolver, terminal, voice or ops surfaces.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "hudsonkit/theme";

import {
  applyScoutThemeToDocument,
  resolveScoutStartupAppearanceDetails,
  resolveScoutStartupTemplate,
  resolveScoutStartupTheme,
  SCOUT_THEME_STORAGE_KEY,
} from "../lib/theme.ts";
import { ScoutProvider } from "../scout/Provider.tsx";
import { FeatureFlagsProvider } from "hudsonkit/flags";

import { MessageComposerEmbedBoundary } from "../components/MessageComposer/MessageComposerEmbedBoundary.tsx";
import {
  SCOUT_AUDIENCE_ORDER,
  SCOUT_DEFAULT_AUDIENCE,
  SCOUT_FLAG_STORAGE_KEY,
  scoutFlagInitialLayers,
  scoutFlags,
} from "../lib/scout-flags.ts";
import { BasicApp, BasicBootErrorBoundary } from "./BasicApp.tsx";
import { BasicEmbed, isEmbedPath } from "./BasicEmbed.tsx";
import "../styles/tokens.css";
import "../styles/primitives.css";
import "../arc-tailwind.css";
import "../app.css";
import "./basic.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("missing #root");
}

const initialTheme = resolveScoutStartupTheme();
const initialTemplate = resolveScoutStartupTemplate();
applyScoutThemeToDocument(initialTheme, initialTemplate, resolveScoutStartupAppearanceDetails());

const embedPath = isEmbedPath(window.location.pathname) ? window.location.pathname : null;

createRoot(rootElement).render(
  <StrictMode>
    <BasicBootErrorBoundary>
      <ThemeProvider
        defaultTheme={initialTheme}
        defaultTemplate={initialTemplate}
        storageKey={SCOUT_THEME_STORAGE_KEY}
      >
        <ScoutProvider initialTheme={initialTheme}>
          {embedPath ? (
            // Same flag stack the full app's embeds mount under.
            <MessageComposerEmbedBoundary>
              <FeatureFlagsProvider
                registry={scoutFlags}
                audience={SCOUT_DEFAULT_AUDIENCE}
                audienceOrder={SCOUT_AUDIENCE_ORDER}
                storageKey={SCOUT_FLAG_STORAGE_KEY}
                initialLayers={scoutFlagInitialLayers()}
              >
                <BasicEmbed pathname={embedPath} />
              </FeatureFlagsProvider>
            </MessageComposerEmbedBoundary>
          ) : <BasicApp />}
        </ScoutProvider>
      </ThemeProvider>
    </BasicBootErrorBoundary>
  </StrictMode>,
);
