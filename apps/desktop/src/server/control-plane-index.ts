import { createScoutControlPlaneServer } from "./create-scout-control-plane-server.ts";
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

const { app, warmupCaches } = createScoutControlPlaneServer({
  currentDirectory,
  assetMode: "static",
});

export default {
  port,
  hostname,
  idleTimeout: 30,
  fetch: app.fetch,
};

console.log(`Scout → http://${hostname}:${port}`);
void warmupCaches();
