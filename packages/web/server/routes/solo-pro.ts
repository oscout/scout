import type { Hono } from "hono";
import {
  checkExpandedWebAccess,
  defaultDistKeyStores,
  type DistKeyStore,
  type ExpandedWebAccess,
} from "@openscout/runtime/dist-access";
import {
  defaultSoloProProbes,
  readSoloProStatus,
  type SoloProProbes,
  type SoloProServedClient,
} from "@openscout/runtime/solo-pro";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

export type SoloProRouteDeps = {
  scoutVersion: string | null;
  served: SoloProServedClient;
  env?: NodeJS.ProcessEnv;
  probes?: SoloProProbes;
  keyStores?: () => DistKeyStore[] | Promise<DistKeyStore[]>;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
};

/**
 * GET  /api/solo-pro               access (as last checked), installed, ready.
 *                                  Local probes only; never the network.
 * POST /api/solo-pro/access/check  asks the download host once, keeps the
 *                                  answer in memory, returns the new status.
 *
 * Neither route installs anything or writes account state; installs stay with
 * `scout web install` / `scout install`. The download key is read only by the
 * explicit check and never returned.
 */
export function mountSoloProRoutes(app: Hono, deps: SoloProRouteDeps) {
  const env = deps.env ?? process.env;
  let probes: SoloProProbes | null = deps.probes ?? null;
  const resolveProbes = () => (probes ??= defaultSoloProProbes({ env }));
  const keyStores = deps.keyStores
    ?? (() => defaultDistKeyStores(resolveOpenScoutSupportPaths().supportDirectory, env));
  let access: ExpandedWebAccess = { state: "unchecked" };
  let inFlight: Promise<ExpandedWebAccess> | null = null;

  const status = () => readSoloProStatus({
    access,
    scoutVersion: deps.scoutVersion,
    served: deps.served,
    probes: resolveProbes(),
    env,
    now: deps.now,
  });

  app.get("/api/solo-pro", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await status());
  });

  app.post("/api/solo-pro/access/check", async (c) => {
    // Concurrent clicks share one request to the host. The stores are built and
    // read only here, asynchronously, so a slow keychain never holds the server.
    inFlight ??= (async () => checkExpandedWebAccess({ env, stores: await keyStores(), fetchImpl: deps.fetchImpl, now: deps.now }))()
      .finally(() => {
        inFlight = null;
      });
    access = await inFlight;
    c.header("cache-control", "no-store");
    return c.json(await status());
  });
}
