import { createElement, type ReactNode } from "react";
import type { HudsonApp, AppIntent } from "@hudsonkit";
import { ScoutProvider } from "./Provider.tsx";
import { ScoutContent } from "./slots/Content.tsx";
import { ScoutInspector } from "./slots/Inspector.tsx";
import { ScoutLeftPanel } from "./slots/LeftPanel.tsx";
import { ScoutTerminal } from "./slots/Terminal.tsx";
import { OnboardingTakeover } from "./takeover/OnboardingTakeover.tsx";
import {
  useScoutCommands,
  useScoutStatus,
  useScoutNavCenter,
  useScoutNavActions,
  useScoutLayoutMode,
  useScoutTakeover,
} from "./hooks.ts";
import type { ScoutTheme } from "../lib/theme.ts";
import {
  SCOUT_THEME_STORAGE_KEY,
  resolveScoutStartupTemplate,
} from "../lib/theme.ts";
import { ThemeProvider } from "hudsonkit/theme";

const intents: AppIntent[] = [
  {
    commandId: "nav:home",
    title: "Go to Home",
    description: "Navigate to the home overview showing queue, threads, signal, and activity",
    category: "navigation",
    keywords: ["home", "inbox", "dashboard"],
    shortcut: "Cmd+1",
  },
  {
    commandId: "nav:agents",
    title: "Go to Agents",
    description: "Navigate to the agents roster showing all registered agents",
    category: "navigation",
    keywords: ["agents", "roster", "list"],
    shortcut: "Cmd+2",
  },
  {
    commandId: "nav:messages",
    title: "Go to Chat",
    description:
      "Navigate to the unified chat surface backed by the normalized conversations service",
    category: "navigation",
    // Channel keywords fold in here: route unification retired the separate
    // Channels destination, so palette search for "channel" lands on Chat.
    keywords: [
      "conversations",
      "comms",
      "chat",
      "threads",
      "channels",
      "channel",
      "group",
      "broadcast",
    ],
    shortcut: "Cmd+3",
  },
  {
    commandId: "nav:sessions",
    title: "Open Sessions",
    description:
      "Navigate to the sessions list showing all active conversations",
    category: "navigation",
    keywords: ["sessions", "conversations", "threads"],
  },
  {
    commandId: "nav:search",
    title: "Go to Search",
    description:
      "Navigate to the session knowledge search surface for extraction, search, and raw-log drilldown planning",
    category: "navigation",
    keywords: ["search", "knowledge", "qmd", "history"],
    shortcut: "Cmd+4",
  },
  {
    commandId: "nav:activity",
    title: "Open Activity",
    description: "Navigate to the activity feed showing recent events",
    category: "navigation",
    keywords: ["activity", "feed", "events", "log"],
  },
  {
    commandId: "nav:mesh",
    title: "Open Mesh",
    description: "Navigate to the mesh network view showing nodes and topology",
    category: "navigation",
    keywords: ["mesh", "network", "nodes", "peers", "topology"],
  },
  {
    commandId: "nav:dispatch",
    title: "Open Dispatch",
    description: "Navigate to the dispatch ledger for routing, delivery attempts, and failed queries",
    category: "navigation",
    keywords: ["dispatch", "broker", "routing", "delivery", "messages"],
  },
  {
    commandId: "nav:repos",
    title: "Open Repos",
    description: "Navigate to the repos view for branches, diffs, and working-tree state",
    category: "navigation",
    keywords: ["repos", "repositories", "git", "branches", "diffs"],
  },
  {
    commandId: "nav:harnesses",
    title: "Open Providers",
    description: "Open the central view for providers, harnesses, observed topology, and budget feeds",
    category: "navigation",
    keywords: ["provider", "providers", "harness", "harnesses", "claude", "codex", "budget", "usage", "topology"],
  },
  {
    commandId: "nav:ops",
    title: "Go to Ops",
    description: "Navigate to the operator workspace for dispatch, mesh, tail, runtime, alerts, and agent operations",
    category: "navigation",
    keywords: ["ops", "operator", "control", "tail", "runtime", "services", "atop", "dispatch", "mesh"],
    shortcut: "Cmd+5",
  },
  {
    commandId: "nav:ops-atop",
    title: "Open Runtime",
    description: "Open the live agent/process view with observed harness families",
    category: "navigation",
    keywords: ["runtime", "services", "atop", "process", "session", "agent", "topology"],
  },
  {
    commandId: "nav:settings",
    title: "Open Settings",
    description:
      "Open the settings screen for pairing, identity, and relay config",
    category: "settings",
    keywords: ["settings", "preferences", "config", "pair"],
    shortcut: "Cmd+,",
  },
  {
    commandId: "nav:agent-config",
    title: "Open Agent Configuration",
    description:
      "Open the unified agent configuration surface for runtimes, agents, tools, delivery, and broker state",
    category: "settings",
    keywords: ["agent config", "runtimes", "providers", "mcp", "tools"],
  },
  {
    commandId: "nav:pair",
    title: "Pair Device",
    description: "Open the device pairing flow to connect a mobile device",
    category: "settings",
    keywords: ["pair", "qr", "device", "phone", "mobile"],
  },
  {
    commandId: "scout:reload",
    title: "Reload Agents",
    description: "Refresh the agent list and message state from the broker",
    category: "workspace",
    keywords: ["reload", "refresh", "sync"],
  },
  {
    commandId: "scout:open:*",
    title: "Open Agent",
    description:
      "Open the agent's view (runtime, sessions, inspector) for one specific agent.",
    category: "navigation",
    keywords: ["open", "agent", "view", "inspect"],
    params: [
      {
        name: "agentId",
        description: "The agent identifier to open",
        type: "string",
      },
    ],
  },
  {
    commandId: "scout:message:*",
    title: "Message Agent",
    description:
      "Open the DM conversation for one specific agent to message them. One agent maps to a DM; group work belongs in an explicit channel and broadcasts belong in the shared channel.",
    category: "workspace",
    keywords: ["message", "chat", "conversation", "dm", "tell", "ask", "reply"],
    params: [
      {
        name: "agentId",
        description: "The agent identifier to message",
        type: "string",
      },
    ],
  },
];

export function createScoutApp(options: { initialTheme?: ScoutTheme } = {}): HudsonApp {
  const { initialTheme = "dark" } = options;
  const initialTemplate = resolveScoutStartupTemplate();

  return {
    id: "openscout",
    name: "Scout",
    description:
      "All your agents, one message away. Scout is a control plane for managing coding agents: Send posts into a Chat, direct agent messages create or steer Runs, and shared work stays in explicit channels.",
    mode: "panel",
    icon: createElement(
      "svg",
      {
        width: 14,
        height: 14,
        viewBox: "0 0 20 20",
        fill: "none",
        stroke: "currentColor",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      },
      createElement("polygon", {
        points: "10,4.3 14.8,7.1 14.8,12.9 10,15.7 5.2,12.9 5.2,7.1",
        strokeWidth: 1.9,
      }),
      createElement("polygon", {
        points: "10,7 12.4,8.4 12.4,10.6 10,12 7.6,10.6 7.6,8.4",
        strokeWidth: 1.32,
        opacity: 0.74,
      }),
    ),

    Provider: ({ children }: { children: ReactNode }) =>
      createElement(
        ThemeProvider,
        {
          defaultTheme: initialTheme,
          defaultTemplate: initialTemplate,
          storageKey: SCOUT_THEME_STORAGE_KEY,
          children: createElement(ScoutProvider, { initialTheme, children }),
        },
      ),

    leftPanel: {
      title: "Navigation",
    },

    rightPanel: {
      title: "Context",
    },

    slots: {
      Content: ScoutContent,
      LeftPanel: ScoutLeftPanel,
      Inspector: ScoutInspector,
      Takeover: OnboardingTakeover,
      Terminal: ScoutTerminal,
    },

    intents,

    hooks: {
      useCommands: useScoutCommands,
      useStatus: useScoutStatus,
      useNavCenter: useScoutNavCenter,
      useNavActions: useScoutNavActions,
      useLayoutMode: useScoutLayoutMode,
      useTakeover: useScoutTakeover,
    },
  };
}

export const scoutApp: HudsonApp = createScoutApp();
