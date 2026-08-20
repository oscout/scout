import {
  createScoutControlPlaneServer,
  type ScoutWebAssetMode,
} from "./create-scout-control-plane-server.ts";
import { resolveHost, resolveWebPort } from "@openscout/runtime/local-config";
import { resolveOpenScoutSetupContextRoot } from "@openscout/runtime/setup";

const port = Number.parseInt(
  process.env.OPENSCOUT_WEB_PORT ?? process.env.SCOUT_WEB_PORT ?? String(resolveWebPort()),
  10,
);
const hostname = process.env.SCOUT_WEB_HOST?.trim()
  || process.env.OPENSCOUT_WEB_HOST?.trim()
  || resolveHost();
const currentDirectory = resolveOpenScoutSetupContextRoot({
  env: process.env,
  fallbackDirectory: process.cwd(),
});

const shellStateCacheTtlMs = Number.parseInt(
  process.env.OPENSCOUT_WEB_SHELL_CACHE_TTL_MS
    ?? process.env.SCOUT_WEB_SHELL_CACHE_TTL_MS
    ?? "15000",
  10,
);

const useStaticAssets = process.env.OPENSCOUT_WEB_STATIC === "1" || process.env.SCOUT_STATIC === "1";
/** Vite dev proxies /api here; first shell-state can be slow if the broker is warming up. */
const defaultWebIdleTimeoutSeconds = useStaticAssets ? "30" : "180";
const REQUEST_IDLE_TIMEOUT_SECONDS = Number.parseInt(
  process.env.OPENSCOUT_WEB_IDLE_TIMEOUT_SECONDS?.trim()
    || process.env.SCOUT_WEB_IDLE_TIMEOUT_SECONDS?.trim()
    || defaultWebIdleTimeoutSeconds,
  10,
);
const assetMode: ScoutWebAssetMode = useStaticAssets ? "static" : "vite-proxy";
const staticRoot = process.env.OPENSCOUT_WEB_STATIC_ROOT?.trim()
  || process.env.SCOUT_STATIC_ROOT?.trim()
  || undefined;
const viteDevUrl = process.env.OPENSCOUT_WEB_VITE_URL?.trim()
  || process.env.SCOUT_VITE_URL?.trim()
  || undefined;

const { app, warmupCaches } = createScoutControlPlaneServer({
  currentDirectory,
  shellStateCacheTtlMs: shellStateCacheTtlMs,
  assetMode,
  viteDevUrl,
  staticRoot,
});

export default {
  port,
  hostname,
  idleTimeout: REQUEST_IDLE_TIMEOUT_SECONDS,
  fetch: app.fetch,
};

console.log(`Scout → http://${hostname}:${port}`);
void warmupCaches();
