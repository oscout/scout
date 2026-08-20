import {
  DEFAULT_HEALTH_PATH,
  DEFAULT_EVENTS_STREAM_PATH,
  DEFAULT_TAIL_STREAM_PATH,
  DEFAULT_TERMINAL_RELAY_PATH,
  DEFAULT_TERMINAL_RELAY_HEALTH_PATH,
  DEFAULT_TERMINAL_RUN_PATH,
  DEFAULT_VITE_HMR_PATH,
  normalizeRoutePath,
} from "../../shared/runtime-config.js";

type ScoutBootstrapRoutes = {
  healthPath?: string;
  terminalRunPath?: string;
  terminalRelayPath?: string;
  terminalRelayHealthPath?: string;
  tailStreamPath?: string;
  eventsStreamPath?: string;
  viteHmrPath?: string;
};

type ScoutBootstrapFeatureFlags = {
  bundle?: string | null;
};

type ScoutBootstrap = {
  theme?: string;
  featureFlags?: ScoutBootstrapFeatureFlags;
  routes?: ScoutBootstrapRoutes;
};

declare global {
  interface Window {
    __OPENSCOUT_WEB_BOOTSTRAP__?: ScoutBootstrap;
  }
}

const ROUTE_DEFAULTS = {
  healthPath: DEFAULT_HEALTH_PATH,
  terminalRunPath: DEFAULT_TERMINAL_RUN_PATH,
  terminalRelayPath: DEFAULT_TERMINAL_RELAY_PATH,
  terminalRelayHealthPath: DEFAULT_TERMINAL_RELAY_HEALTH_PATH,
  tailStreamPath: DEFAULT_TAIL_STREAM_PATH,
  eventsStreamPath: DEFAULT_EVENTS_STREAM_PATH,
  viteHmrPath: DEFAULT_VITE_HMR_PATH,
} satisfies Required<ScoutBootstrapRoutes>;

function readScoutBootstrap(): ScoutBootstrap | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.__OPENSCOUT_WEB_BOOTSTRAP__ ?? null;
}

export function readScoutBootstrapTheme(): string | null {
  const theme = readScoutBootstrap()?.theme;
  return typeof theme === "string" ? theme : null;
}

export function readScoutBootstrapFlagBundle(): string | null {
  const bundle = readScoutBootstrap()?.featureFlags?.bundle;
  return typeof bundle === "string" ? bundle : null;
}

export function resolveScoutRoutePath<K extends keyof typeof ROUTE_DEFAULTS>(
  key: K,
): (typeof ROUTE_DEFAULTS)[K] {
  return normalizeRoutePath(
    readScoutBootstrap()?.routes?.[key],
    ROUTE_DEFAULTS[key],
  ) as (typeof ROUTE_DEFAULTS)[K];
}

export function resolveScoutTerminalRelayUrl(): string {
  const terminalRelayPath = resolveScoutRoutePath("terminalRelayPath");

  if (typeof window === "undefined") {
    return `ws://localhost:43120${terminalRelayPath}`;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${terminalRelayPath}`;
}

export function resolveScoutTerminalRelayHealthUrl(): string {
  const terminalRelayHealthPath = resolveScoutRoutePath("terminalRelayHealthPath");

  if (typeof window === "undefined") {
    return `http://localhost:43120${terminalRelayHealthPath}`;
  }

  return `${window.location.protocol}//${window.location.host}${terminalRelayHealthPath}`;
}

function resolveScoutWebSocketUrl(path: string): string {
  if (typeof window === "undefined") {
    return `ws://localhost:43120${path}`;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export function resolveScoutTailStreamUrl(): string {
  return resolveScoutWebSocketUrl(resolveScoutRoutePath("tailStreamPath"));
}

export function resolveScoutEventsStreamUrl(): string {
  return resolveScoutWebSocketUrl(resolveScoutRoutePath("eventsStreamPath"));
}
