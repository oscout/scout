export const DEFAULT_API_BASE_PATH = "/api";
export const DEFAULT_BOOTSTRAP_SCRIPT_PATH = `${DEFAULT_API_BASE_PATH}/bootstrap.js`;
export const DEFAULT_HEALTH_PATH = `${DEFAULT_API_BASE_PATH}/health`;
export const DEFAULT_TERMINAL_RUN_PATH = `${DEFAULT_API_BASE_PATH}/terminal/run`;
export const DEFAULT_UPLOAD_PATH = `${DEFAULT_API_BASE_PATH}/upload`;
export const DEFAULT_RELAY_UPLOAD_PATH = `${DEFAULT_API_BASE_PATH}/relay/upload`;
export const DEFAULT_TERMINAL_RELAY_PATH = "/ws/terminal";
export const DEFAULT_TERMINAL_RELAY_HEALTH_PATH = `${DEFAULT_TERMINAL_RELAY_PATH}/health`;
export const DEFAULT_TAIL_STREAM_PATH = "/ws/tail";
export const DEFAULT_EVENTS_STREAM_PATH = "/ws/events";
export const DEFAULT_VITE_HMR_PATH = "/ws/hmr";

import { SCOPE_FLAG_BUNDLE_ALIASES } from "./scope-integration.js";

const OPENSCOUT_WEB_FLAG_BUNDLE_ALIASES = {
  a: "light-prod",
  control: "light-prod",
  light: "light-prod",
  "light-prod": "light-prod",
  prod: "light-prod",
  production: "light-prod",
  b: "max-pro",
  max: "max-pro",
  "max-pro": "max-pro",
  pro: "max-pro",
  treatment: "max-pro",
  ...SCOPE_FLAG_BUNDLE_ALIASES,
};

export function normalizeRoutePath(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const normalized = `${trimmed.startsWith("/") ? "" : "/"}${trimmed}`
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/g, "");

  return normalized || fallback;
}

function routeChildPath(basePath, childPath, fallback) {
  const normalizedBase = normalizeRoutePath(basePath, fallback);
  return normalizeRoutePath(`${normalizedBase}/${childPath}`, fallback);
}

export function resolveOpenScoutWebRoutes(env = process.env) {
  const terminalRelayPath = normalizeRoutePath(
    env.OPENSCOUT_WEB_TERMINAL_RELAY_PATH,
    DEFAULT_TERMINAL_RELAY_PATH,
  );

  return {
    apiBasePath: DEFAULT_API_BASE_PATH,
    bootstrapScriptPath: DEFAULT_BOOTSTRAP_SCRIPT_PATH,
    healthPath: DEFAULT_HEALTH_PATH,
    terminalRunPath: DEFAULT_TERMINAL_RUN_PATH,
    uploadPath: DEFAULT_UPLOAD_PATH,
    relayUploadPath: DEFAULT_RELAY_UPLOAD_PATH,
    terminalRelayPath,
    terminalRelayHealthPath: normalizeRoutePath(
      env.OPENSCOUT_WEB_TERMINAL_RELAY_HEALTH_PATH,
      routeChildPath(terminalRelayPath, "health", DEFAULT_TERMINAL_RELAY_HEALTH_PATH),
    ),
    tailStreamPath: normalizeRoutePath(
      env.OPENSCOUT_WEB_TAIL_STREAM_PATH,
      DEFAULT_TAIL_STREAM_PATH,
    ),
    eventsStreamPath: normalizeRoutePath(
      env.OPENSCOUT_WEB_EVENTS_STREAM_PATH,
      DEFAULT_EVENTS_STREAM_PATH,
    ),
    viteHmrPath: normalizeRoutePath(
      env.OPENSCOUT_WEB_VITE_HMR_PATH,
      DEFAULT_VITE_HMR_PATH,
    ),
  };
}

export function normalizeOpenScoutWebFlagBundle(value) {
  if (typeof value !== "string") {
    return null;
  }

  return OPENSCOUT_WEB_FLAG_BUNDLE_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function resolveOpenScoutWebFeatureFlags(env = process.env) {
  const bundle = normalizeOpenScoutWebFlagBundle(
    env.OPENSCOUT_WEB_FLAG_BUNDLE ??
      env.OPENSCOUT_WEB_EXPERIENCE ??
      env.OPENSCOUT_WEB_AB_VARIANT,
  );

  return bundle ? { bundle } : {};
}

export function createOpenScoutWebBootstrap(env = process.env) {
  return {
    featureFlags: resolveOpenScoutWebFeatureFlags(env),
    routes: resolveOpenScoutWebRoutes(env),
  };
}

export function serializeOpenScoutWebBootstrap(env = process.env) {
  return [
    "window.__OPENSCOUT_WEB_BOOTSTRAP__ = Object.assign(",
    "{}",
    ", window.__OPENSCOUT_WEB_BOOTSTRAP__ || {}",
    `, ${JSON.stringify(createOpenScoutWebBootstrap(env))}`,
    ");",
  ].join("");
}
