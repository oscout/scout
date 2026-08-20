import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { MessageComposerEmbedBoundary } from "./components/MessageComposer/MessageComposerEmbedBoundary.tsx";
import {
  isLikelyDiscoveredEmbedPath,
  shouldBootstrapDiscoveredEmbed,
} from "./surfaces/embed-path.ts";

import {
  applyScoutThemeToDocument,
  resolveScoutStartupAppearanceDetails,
  resolveScoutStartupTheme,
  resolveScoutStartupTemplate,
} from "./lib/theme.ts";
import { DevErrorOverlay } from "./dev/DevErrorOverlay.tsx";
import "./styles/tokens.css";
import "./styles/primitives.css";
import "./arc-tailwind.css";
import "./app.css";

const el = document.getElementById("root");
if (!el) {
  throw new Error("missing #root");
}
const rootElement = el;

const initialTheme = resolveScoutStartupTheme();
applyScoutThemeToDocument(
  initialTheme,
  resolveScoutStartupTemplate(),
  resolveScoutStartupAppearanceDetails(),
);

const pathname = window.location.pathname;
const isScoutbotFxLab = pathname === "/dev/scoutbot-fx";
const isEmbeddableSurfacesLab = pathname === "/dev/embeddable-surfaces";
const observeEmbedMatch = pathname.match(/^\/embed\/observe\/([^/]+)$/);
const isRepoDiffEmbed = pathname === "/embed/repo-diff";
const isSessionEmbed = pathname === "/embed/session";
const isTerminalEmbed = pathname === "/embed/terminal";
const isScoutDeck = pathname === "/deck" || pathname === "/deck/";
const useDiscoveredEmbed = shouldBootstrapDiscoveredEmbed(pathname);

class ScoutBootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; componentStack: string }
> {
  state = { error: null as Error | null, componentStack: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[openscout] app render failed", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ padding: "24px", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
        <h1 style={{ fontSize: "16px" }}>Scout could not render this view</h1>
        <pre style={{ whiteSpace: "pre-wrap", color: "#e8993d" }}>{this.state.error.message}</pre>
        {this.state.componentStack ? (
          <pre style={{ whiteSpace: "pre-wrap", color: "#9fa4ad" }}>{this.state.componentStack}</pre>
        ) : null}
      </main>
    );
  }
}

async function renderShell() {
  let content: ReactNode;

  if (isScoutDeck) {
    const { ScoutDeckSurface } = await import("./native-surfaces/deck/ScoutDeckSurface.tsx");
    content = <ScoutDeckSurface />;
  } else if (isScoutbotFxLab) {
    const { ScoutbotFxLab } = await import("./dev/ScoutbotFxLab.tsx");
    content = <ScoutbotFxLab />;
  } else if (isEmbeddableSurfacesLab) {
    const { EmbeddableSurfacesLab } = await import("./dev/EmbeddableSurfacesLab.tsx");
    content = <EmbeddableSurfacesLab />;
  } else if (isTerminalEmbed) {
    const { TerminalEmbedScreen } = await import("./screens/terminal/TerminalEmbedScreen.tsx");
    content = <TerminalEmbedScreen />;
  } else {
    const { createScoutApp } = await import("./scout");
    const scoutApp = createScoutApp({ initialTheme });

    if (observeEmbedMatch) {
      const { ObserveEmbedScreen } = await import("./screens/ObserveEmbedScreen.tsx");
      content = (
        <scoutApp.Provider>
          <ObserveEmbedScreen agentId={decodeURIComponent(observeEmbedMatch[1])} />
        </scoutApp.Provider>
      );
    } else if (isRepoDiffEmbed) {
      const { RepoDiffEmbedScreen } = await import("./screens/RepoDiffEmbedScreen.tsx");
      content = (
        <scoutApp.Provider>
          <RepoDiffEmbedScreen />
        </scoutApp.Provider>
      );
    } else if (isSessionEmbed) {
      const { SessionEmbedScreen } = await import("./screens/sessions/SessionEmbedScreen.tsx");
      content = (
        <scoutApp.Provider>
          <SessionEmbedScreen />
        </scoutApp.Provider>
      );
    } else {
      const [{ OpenScoutAppShell }, { wireScopeOntoScout }] = await Promise.all([
        import("./OpenScoutAppShell.tsx"),
        import("./scope/index.ts"),
      ]);
      wireScopeOntoScout(scoutApp);
      content = <OpenScoutAppShell app={scoutApp} />;
    }
  }

  createRoot(rootElement).render(
    <StrictMode>
      <ScoutBootErrorBoundary>
        {isLikelyDiscoveredEmbedPath(pathname)
          ? <MessageComposerEmbedBoundary>{content}</MessageComposerEmbedBoundary>
          : content}
      </ScoutBootErrorBoundary>
      {import.meta.env.DEV ? <DevErrorOverlay /> : null}
    </StrictMode>,
  );
}

function renderEmbedMiss(missingPath: string) {
  createRoot(rootElement).render(
    <StrictMode>
      <div className="s-embed-miss" data-scout-theme>
        <h1>Embed surface unavailable</h1>
        <p>
          No registered surface for <code>{missingPath}</code>. Rebuild the web client and restart
          the Scout web server.
        </p>
      </div>
      {import.meta.env.DEV ? <DevErrorOverlay /> : null}
    </StrictMode>,
  );
}

if (useDiscoveredEmbed) {
  void import("./surfaces/embed-entry.tsx")
    .then(async ({ mountDiscoveredEmbed }) => {
      const mounted = await mountDiscoveredEmbed(rootElement, initialTheme);
      if (!mounted) {
        renderEmbedMiss(pathname);
      }
    })
    .catch((error) => {
      console.error("[openscout] embed bootstrap failed", error);
      renderEmbedMiss(pathname);
    });
} else {
  void renderShell();
}
