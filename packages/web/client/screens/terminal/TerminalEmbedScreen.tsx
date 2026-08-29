import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ContextMenuProvider } from "../../components/ContextMenu.tsx";
import { api } from "../../lib/api.ts";
import { friendlyApiError } from "../../lib/api-errors.ts";
import { isAgentOnline } from "../../lib/agent-state.ts";
import { routeFromUrl, routePath } from "../../lib/router.ts";
import {
  resolveScoutNativeThemeVars,
  resolveScoutStartupTheme,
  SCOUT_DEFAULT_APPEARANCE_DETAILS,
} from "../../lib/theme.ts";
import {
  ScoutContext,
  DARK_THEME_VARS,
  LIGHT_THEME_VARS,
  type ApiConnectionState,
  type ScoutContextValue,
} from "../../scout/Provider.tsx";
import type { Agent, Route } from "../../lib/types.ts";
import { TerminalContent, type TerminalRoute } from "./Terminal.tsx";

function terminalRouteFromEmbedLocation(): TerminalRoute {
  const params = new URLSearchParams(window.location.search);
  const target = params.get("route")?.trim() || "/terminal";
  const route = routeFromUrl(target);
  return route.view === "terminal" ? route : { view: "terminal" };
}

function embedHrefForTerminalRoute(route: TerminalRoute): string {
  const params = new URLSearchParams(window.location.search);
  params.set("route", routePath(route));
  if (!params.has("profile")) {
    params.set("profile", "macos.terminal");
  }
  return `${window.location.pathname}?${params.toString()}${window.location.hash}`;
}

export function TerminalEmbedScreen() {
  const [route, setRoute] = useState<TerminalRoute>(() => terminalRouteFromEmbedLocation());
  const isTerminalSurface = Boolean(
    route.terminalBackend
    || route.agentId
    || route.terminalSessionId
    || route.terminalSurfaceKey,
  );

  useEffect(() => {
    const onPopState = () => setRoute(terminalRouteFromEmbedLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    if (next.view !== "terminal") {
      const terminalHome: TerminalRoute = { view: "terminal" };
      const href = embedHrefForTerminalRoute(terminalHome);
      window.history.pushState(null, "", href);
      setRoute(terminalHome);
      return;
    }
    const href = embedHrefForTerminalRoute(next);
    window.history.pushState(null, "", href);
    setRoute(next);
  }, []);

  return (
    <TerminalEmbedScoutProvider route={route} navigate={navigate}>
      <div className={`s-terminal-embed${isTerminalSurface ? " s-terminal-embed--surface" : ""}`}>
        <TerminalContent route={route} navigate={navigate} />
      </div>
    </TerminalEmbedScoutProvider>
  );
}

function TerminalEmbedScoutProvider({
  route,
  navigate,
  children,
}: {
  route: Route;
  navigate: (route: Route) => void;
  children: ReactNode;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [apiConnection, setApiConnection] = useState<ApiConnectionState>({
    status: "checking",
    message: null,
    lastCheckedAt: null,
  });
  const reloadInFlightRef = useRef<Promise<void> | null>(null);
  const initialTheme = useMemo(() => resolveScoutStartupTheme(), []);
  const nativeThemeVars = useMemo(() => resolveScoutNativeThemeVars(), []);
  const themeVars = useMemo(
    () => ({
      ...(initialTheme === "light" ? LIGHT_THEME_VARS : DARK_THEME_VARS),
      ...(nativeThemeVars ?? {}),
    }),
    [initialTheme, nativeThemeVars],
  );

  const markOnline = useCallback(() => {
    setApiConnection({ status: "online", message: null, lastCheckedAt: Date.now() });
  }, []);

  const markOffline = useCallback((cause: unknown) => {
    setApiConnection({
      status: "offline",
      message: friendlyApiError(cause),
      lastCheckedAt: Date.now(),
    });
  }, []);

  const reload = useCallback(async () => {
    if (reloadInFlightRef.current) return reloadInFlightRef.current;
    const request = (async () => {
      try {
        setAgents(await api<Agent[]>("/api/agents"));
        markOnline();
      } catch (cause) {
        markOffline(cause);
      }
    })();
    reloadInFlightRef.current = request;
    try {
      await request;
    } finally {
      reloadInFlightRef.current = null;
    }
  }, [markOffline, markOnline]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "hidden") return;
      void reload();
    };
    const interval = window.setInterval(refreshIfVisible, 15_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [reload]);

  const onlineCount = useMemo(() => agents.filter((agent) => isAgentOnline(agent.state)).length, [agents]);

  const value = useMemo<ScoutContextValue>(() => ({
    route,
    navigate,
    navigateBack: () => {
      if (typeof window !== "undefined") window.history.back();
    },
    canNavigateBack: typeof window !== "undefined" && window.history.length > 1,
    agents,
    agentsLoaded: apiConnection.status !== "checking",
    onlineCount,
    apiConnection,
    appearanceDetails: SCOUT_DEFAULT_APPEARANCE_DETAILS,
    updateAppearanceDetails: () => {},
    reload,
    onboarding: null,
    operatorName: null,
    refreshOnboarding: async () => {},
    onboardingSkipped: true,
    skipOnboarding: () => {},
    settingsOpen: false,
    openSettings: () => {},
    closeSettings: () => {},
    scoutbotAgentId: "scoutbot",
    scoutbotConversationId: null,
    applyScoutbotUiAction: () => {},
    selectedBrokerAttempt: null,
    inspectBrokerAttempt: () => {},
    clearBrokerAttempt: () => {},
    selectedKnowledgeHit: null,
    selectedKnowledgeQuery: "",
    inspectKnowledgeHit: () => {},
    clearKnowledgeHit: () => {},
    focusedSession: null,
    focusSession: () => {},
    openFilePreview: () => {},
    closeFilePreview: () => {},
    openContextCapture: () => {},
    closeContextCapture: () => {},
  }), [agents, apiConnection, navigate, onlineCount, reload, route]);

  return (
    <ScoutContext.Provider value={value}>
      <div data-scout-theme={initialTheme} data-scout-theme-mode={initialTheme} style={themeVars}>
        <ContextMenuProvider>{children}</ContextMenuProvider>
      </div>
    </ScoutContext.Provider>
  );
}
