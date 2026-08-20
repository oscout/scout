import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { type CommandOption, type StatusColor, type TakeoverState } from "@hudsonkit";
import { useOptionalFlag } from "hudsonkit/flags";
import { api } from "../lib/api.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../lib/surface-activity.ts";
import { ensureAgentChat } from "../lib/agent-chat.ts";
import { useScout } from "./Provider.tsx";
import { localMachineLabel } from "../lib/mesh-buckets.ts";
import type { MeshStatus, Route } from "../lib/types.ts";
import { MachineScopeControl } from "../components/MachineScopeControl.tsx";
import {
  NEW_CHAT_SHORTCUT_LABEL,
  NEW_TASK_ACTION_LABEL,
} from "../lib/new-chat-shortcut.ts";
import { SCOUTBOT_SUBMIT_EVENT } from "../lib/scoutbot.ts";
import {
  topNavBreadcrumbForRoute,
  topNavItems,
  topNavKeyForRoute,
} from "./topNavConfig.ts";
import { paletteNavCommandOptions } from "./nav-destinations.ts";
import { renderNavCenter } from "./nav-center.tsx";
import { SystemMenu } from "./nav-system-menu.tsx";

export type ScoutStatusBarState = {
  status: { label: string; color: StatusColor };
  activeAgents: { label: string; count: number };
  mesh: { label: string; value: string; color: StatusColor };
  build: { label: string; title: string };
};

type BuildInfo = {
  version: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  mode: "dev" | "production";
};

/* ── useCommands — nav + agent operations ─────────────────────────────── */
export function useScoutCommands(): CommandOption[] {
  const { navigate, agents, reload, applyScoutbotUiAction, openContextCapture } = useScout();
  const opsEnabled = useOptionalFlag("ops.control", true);
  const scoutbotEnabled = useOptionalFlag("surface.scoutbot", true);

  const askScoutbotForState = useCallback(() => {
    applyScoutbotUiAction({ type: "open-scoutbot", mode: "ask" });
    window.dispatchEvent(new CustomEvent(SCOUTBOT_SUBMIT_EVENT, {
      detail: {
        body: "What's the state of things? Give me a terse ops summary, the biggest risk, and the next action you recommend.",
      },
    }));
  }, [applyScoutbotUiAction]);

  return useMemo<CommandOption[]>(() => {
    const commands: CommandOption[] = [
      {
        id: "session:new",
        label: NEW_TASK_ACTION_LABEL,
        action: () => openContextCapture(),
        shortcut: NEW_CHAT_SHORTCUT_LABEL,
      },
      // Static nav destinations projected from the catalog.
      ...paletteNavCommandOptions(navigate, { opsEnabled }),
      {
        id: "nav:settings",
        label: "Open Settings",
        action: () => navigate({ view: "settings", section: "appearance" }),
        shortcut: "Cmd+,",
      },
      ...(scoutbotEnabled ? [{
        id: "scoutbot:open",
        label: "Open Scout",
        action: () => applyScoutbotUiAction({ type: "open-scoutbot", mode: "ask" }),
      }, {
        id: "scoutbot:state",
        label: "Message Scout for State",
        action: () => askScoutbotForState(),
      }, {
        id: "scoutbot:ops-tail",
        label: "Scout: Open Ops Tail",
        action: () => applyScoutbotUiAction({ type: "navigate", route: { view: "ops", mode: "tail" } }),
      }] : []),
      {
        id: "nav:pair",
        label: "Pair Device",
        action: () => navigate({ view: "settings", section: "devices" }),
      },
      {
        id: "scout:reload",
        label: "Reload Agents",
        action: () => void reload(),
      },
    ];

    for (const agent of agents) {
      commands.push({
        id: `scout:open:${agent.id}`,
        label: `Open ${agent.name}`,
        action: () => navigate({ view: "agents-v2", agentId: agent.id }),
      });
      commands.push({
        id: `scout:message:${agent.id}`,
        label: `Message ${agent.name}`,
        action: () => {
          void ensureAgentChat(agent)
            .then((conversationId) => {
              navigate({
                view: "conversation",
                conversationId,
              });
            })
            .catch(() => navigate({
              view: "agents-v2",
              agentId: agent.id,
              tab: "message",
            }));
        },
      });
    }

    return commands;
  }, [agents, applyScoutbotUiAction, askScoutbotForState, navigate, openContextCapture, opsEnabled, scoutbotEnabled, reload]);
}

export function useScoutStatusBarState(): ScoutStatusBarState {
  const { onlineCount, apiConnection } = useScout();
  const [mesh, setMesh] = useState<MeshStatus | null>(null);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const requestIdRef = useRef(0);

  const loadMesh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const data = await api<MeshStatus>("/api/mesh");
      if (requestId !== requestIdRef.current) return;
      setMesh(data);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setMesh(null);
    }
  }, []);

  useEffect(() => {
    void loadMesh();
    const refreshIfActive = () => {
      if (isScoutSurfaceActive()) void loadMesh();
    };
    const timer = setInterval(refreshIfActive, 15_000);
    const stopActivationListener = onScoutSurfaceActivated(refreshIfActive);
    return () => {
      clearInterval(timer);
      stopActivationListener();
    };
  }, [loadMesh]);

  useEffect(() => {
    api<BuildInfo>("/api/build")
      .then(setBuild)
      .catch(() => setBuild(null));
  }, []);

  const buildLabel = (() => {
    if (!build) return { label: "dev", title: "Build information unavailable" };
    const mode = build.mode === "production" ? "prod" : "dev";
    const branch = build.branch ?? "unknown";
    const commit = build.commit ? ` @ ${build.commit}${build.dirty ? "*" : ""}` : "";
    return {
      label: `${mode} ${branch}${commit}`,
      title: [
        `Mode: ${build.mode}`,
        `Version: ${build.version ?? "unknown"}`,
        `Branch: ${build.branch ?? "unknown"}`,
        `Commit: ${build.commit ?? "unknown"}`,
        `Dirty: ${build.dirty === null ? "unknown" : build.dirty ? "yes" : "no"}`,
      ].join("\n"),
    };
  })();

  return {
    status: apiConnection.status === "offline"
      ? { label: "Scout: OFFLINE", color: "red" }
      : apiConnection.status === "degraded"
      ? { label: "Scout: DEGRADED", color: "amber" }
      : mesh === null
      ? { label: "Broker: …", color: "neutral" }
      : mesh.health.reachable
        ? { label: "Broker: UP", color: "emerald" }
        : { label: "Broker: DOWN", color: "red" },
    activeAgents: {
      label: "Registered",
      count: onlineCount,
    },
    mesh: (() => {
      const label = localMachineLabel(mesh);
      if (apiConnection.status === "offline") {
        return { label, value: "offline", color: "red" as StatusColor };
      }
      if (mesh === null) {
        return { label, value: "checking", color: "neutral" as StatusColor };
      }
      if (!mesh.health.reachable) {
        return { label, value: "offline", color: "neutral" as StatusColor };
      }
      const remoteNodes = Object.values(mesh.nodes).filter((node) => node.id !== mesh.localNode?.id);
      if (remoteNodes.length > 0) {
        return { label, value: "connected", color: "neutral" as StatusColor };
      }
      if (mesh.identity.discoverable) {
        return { label, value: "discoverable", color: "neutral" as StatusColor };
      }
      return { label, value: "local", color: "amber" as StatusColor };
    })(),
    build: buildLabel,
  };
}

/* ── useStatus — shell compatibility ───────────────────────────────────── */
export function useScoutStatus(): { label: string; color: StatusColor } {
  return useScoutStatusBarState().status;
}

/* ── useNavCenter — tab bar + breadcrumb (legacy top bar only) ─────────── */
export function useScoutNavCenter(): ReactNode | null {
  const { route, navigate } = useScout();
  const sidebarChrome = useOptionalFlag("nav.sidebar", false);

  // SCO-085: ScoutNavigationBar is unmounted in sidebar mode. Breadcrumb lives
  // in the shared center-pane header seam (CenterPaneHeader), not a hidden bar.
  // Generic app.hooks.useSearch is intentionally unsupported in sidebar mode
  // (createScoutApp never wires one).
  if (sidebarChrome) {
    return null;
  }

  return renderNavCenter({
    items: topNavItems(),
    activeKey: topNavKeyForRoute(route),
    breadcrumb: topNavBreadcrumbForRoute(route),
    navigate,
  });
}

/* ── useNavActions ─────────────────────────────────────────────────────── */
export function useScoutNavActions(): ReactNode | null {
  const { openSettings } = useScout();
  const sidebarChrome = useOptionalFlag("nav.sidebar", false);

  // SCO-085: MachineScopeControl + Settings live in the sidebar footer / areas
  // when sidebar chrome is on. Never render-and-hide both (duplicate ids).
  if (sidebarChrome) {
    return null;
  }

  return createElement("div", { className: "scout-nav-actions" },
    createElement(SystemMenu),
    createElement(MachineScopeControl, { variant: "nav" }),
    createElement(
      "button",
      {
        onClick: () => openSettings(),
        className: "scout-nav-action scout-nav-action--settings",
        title: "Settings",
      },
      createElement(Settings, { size: 12, strokeWidth: 1.6, "aria-hidden": true }),
      createElement("span", null, "Settings"),
    ),
  );
}

/* ── useLayoutMode ─────────────────────────────────────────────────────── */
export function useScoutLayoutMode(): "canvas" | "panel" {
  return "panel";
}

/* ── useTakeover — gate chrome on first-run onboarding ─────────────────── */
function isOnboardingExemptRoute(route: Route): boolean {
  return route.view === "ops" && route.mode === "lanes";
}

export function useScoutTakeover(): TakeoverState | null {
  const { onboarding, onboardingSkipped, skipOnboarding, route } = useScout();
  // Lanes is a first-class ops surface (and mirrors the native/embed deck).
  // Don't block it behind first-run project setup.
  if (isOnboardingExemptRoute(route)) {
    return { active: false, dismissible: true };
  }
  // Until the first fetch resolves we pass through; false negatives would
  // block the app on reloads and true would flash a takeover for returning
  // users. Waiting one RTT is cheap and correct.
  if (!onboarding) return null;
  if (onboardingSkipped || onboarding.needed === false || onboarding.skippedAt || onboarding.completedAt) {
    return { active: false, dismissible: true };
  }
  const needsLocal = !onboarding.hasLocalConfig;
  const needsProject = !onboarding.hasProjectConfig;
  const needsName = !onboarding.hasOperatorName;
  // Core inputs done but the broker/runtime aren't ready yet: SetupStep is
  // still owed. The early return above already excludes completed/skipped
  // onboarding, so this only fires while first-run is genuinely unfinished.
  const needsSetup = !onboarding.brokerReachable || !onboarding.hasReadyRuntime;
  const active = needsLocal || needsName || needsProject || needsSetup;
  return {
    active,
    dismissible: true,
    onDismiss: skipOnboarding,
  };
}
