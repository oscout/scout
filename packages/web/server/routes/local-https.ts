import type { Context, Hono } from "hono";
import {
  ensureScoutLocalEdgeTrustAsync,
  inspectScoutLocalEdgeTrust,
  type ScoutLocalEdgeTrustReport,
} from "@openscout/runtime/local-edge";

import { isLoopbackScoutAddress, isSameMacScoutRequest, resolveScoutRequestPeerAddress } from "../server-core.ts";
import type { CreateOpenScoutWebServerOptions } from "../web-server-options.ts";
import type { LocalHttpsState } from "../../shared/api/local-https.ts";

export type LocalHttpsRouteDeps = {
  options: Pick<CreateOpenScoutWebServerOptions, "resolvePeerAddress">;
  inspect?: () => ScoutLocalEdgeTrustReport;
  trust?: () => Promise<ScoutLocalEdgeTrustReport>;
};

const TRUST_COMMAND = "scout server trust";

function secureOriginFor(c: Context): string | null {
  const hostname = new URL(c.req.url).hostname.toLowerCase();
  // Loopback pages are already secure over http; there is no https door to offer.
  if (!hostname || hostname === "localhost" || isLoopbackScoutAddress(hostname)) return null;
  return `https://${hostname.includes(":") ? `[${hostname}]` : hostname}`;
}

function toState(c: Context, report: ScoutLocalEdgeTrustReport, canTrustHere: boolean): LocalHttpsState {
  const trusted = report.status === "trusted" || report.status === "installed";
  return {
    status: report.status,
    trusted,
    detail: report.detail,
    secureOrigin: secureOriginFor(c),
    canTrustHere: canTrustHere && report.status === "untrusted",
    command: trusted ? null : TRUST_COMMAND,
  };
}

export function mountLocalHttpsRoutes(app: Hono, deps: LocalHttpsRouteDeps) {
  const inspect = deps.inspect ?? (() => inspectScoutLocalEdgeTrust());
  const trust = deps.trust ?? (() => ensureScoutLocalEdgeTrustAsync());
  // One password dialog at a time; a second click joins the one on screen.
  let inFlight: Promise<ScoutLocalEdgeTrustReport> | null = null;

  const sameMac = (c: Context) => isSameMacScoutRequest(
    c.req.raw,
    (deps.options.resolvePeerAddress ?? resolveScoutRequestPeerAddress)(c),
  );

  app.get("/api/local-https", (c) => c.json(toState(c, inspect(), sameMac(c))));

  app.post("/api/local-https/trust", async (c) => {
    // The macOS password dialog opens on this Mac, so only a page on this Mac
    // may raise it. Other devices get the status and the command to run here.
    if (!sameMac(c)) return c.json({ error: "Trust local HTTPS from this Mac." }, 403);
    inFlight ??= trust().finally(() => { inFlight = null; });
    const report = await inFlight;
    return c.json(toState(c, report, true), report.status === "error" ? 500 : 200);
  });
}
