import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureProviderTelemetryBootstrap } from "@openscout/runtime";
import { resolveWebAuthToken, resolveWebPort } from "@openscout/runtime/local-config";
import { resolveOpenScoutSetupContextRoot } from "@openscout/runtime/setup";
import { resolveOpenScoutWebRoutes } from "../shared/runtime-config.js";
import {
  createOpenScoutWebServer,
} from "./create-openscout-web-server.ts";
import { resolveScoutBrokerUrl } from "./core/broker/service.ts";
import {
  isAuthenticatedScoutRequest,
  isAuthorizedScoutWebSocketRequest,
  isForwardedHttpsScoutRequest,
  isSameMacScoutRequest,
  isScoutWebRequestAllowedFromPeer,
  isTrustedScoutApiRequest,
  createScoutRequestPeerAddressRegistry,
  resolveScoutWebLanAccessScope,
  resolveScoutWebBindHost,
  scoutWebAuthCookie,
  shouldIssueFrontDoorScoutWebCredential,
  shouldIssueLocalScoutWebCredential,
} from "./server-core.ts";
import {
  createScoutWebSessionStore,
  SCOUT_WEB_SESSION_MAX_AGE_SECONDS,
} from "./web-sessions.ts";
import { resolveOpenScoutWebApplicationServerIdentity } from "./app-server-origin.ts";
import {
  createRelayWebSocketProxy,
  handleRelayUpload,
  type RelayWSData,
} from "./relay.ts";
import {
  startManagedTerminalRelay,
  type ManagedTerminalRelay,
} from "./managed-terminal-relay.ts";
import { loadServiceBudgets } from "./service-budgets.ts";
import { startProcessParentWatchdog } from "./process-parent-watchdog.ts";

process.title = "scout-web";

const port = Number.parseInt(
  process.env.OPENSCOUT_WEB_PORT
    ?? process.env.SCOUT_WEB_PORT
    ?? String(resolveWebPort()),
  10,
);
const hostname = resolveScoutWebBindHost(process.env);
const lanAccessScope = resolveScoutWebLanAccessScope(process.env);
const webAuthToken = resolveWebAuthToken(process.env);
const webSessions = createScoutWebSessionStore();
const currentDirectory = resolveOpenScoutSetupContextRoot({
  env: process.env,
  fallbackDirectory: process.cwd(),
});
const shellStateCacheTtlMs = Number.parseInt(process.env.OPENSCOUT_WEB_SHELL_CACHE_TTL_MS ?? "15000", 10);
const providerTelemetryBootstrapEnabled =
  process.env.OPENSCOUT_WEB_PROVIDER_TELEMETRY_BOOTSTRAP?.trim() === "1";
const startupWarmupEnabled =
  process.env.OPENSCOUT_WEB_STARTUP_WARMUP?.trim() === "1";
const routes = resolveOpenScoutWebRoutes(process.env);
const requestPeerAddresses = createScoutRequestPeerAddressRegistry();

function resolveStaticRoot(): string | undefined {
  if (process.env.OPENSCOUT_WEB_STATIC_ROOT?.trim()) {
    return process.env.OPENSCOUT_WEB_STATIC_ROOT.trim();
  }
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const siblingClientRoot = join(selfDir, "client");
  if (existsSync(join(siblingClientRoot, "index.html"))) {
    return siblingClientRoot;
  }
  const sourceDistClientRoot = resolve(selfDir, "../dist/client");
  if (existsSync(join(sourceDistClientRoot, "index.html"))) {
    return sourceDistClientRoot;
  }
  return undefined;
}

const staticRoot = resolveStaticRoot();
const viteDevUrl = process.env.OPENSCOUT_WEB_VITE_URL?.trim() || undefined;
const useViteProxy = Boolean(viteDevUrl) || !staticRoot;
const applicationServerIdentity = resolveOpenScoutWebApplicationServerIdentity(process.env);
const idleTimeoutSeconds = Number.parseInt(
  process.env.OPENSCOUT_WEB_IDLE_TIMEOUT_SECONDS?.trim()
    || (useViteProxy ? "180" : "30"),
  10,
);

function toWebSocketUrl(httpUrl: string, pathname: string, search = ""): string {
  const target = new URL(pathname, httpUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.search = search;
  return target.toString();
}

/** Host header reduced to the bare name (lower-cased, port and brackets dropped). */
function requestHostName(value: string | null): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed.startsWith("[")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }
  return trimmed.split(":")[0] ?? "";
}

async function bootstrapProviderTelemetry(): Promise<void> {
  try {
    const telemetry = await ensureProviderTelemetryBootstrap({ env: process.env });
    const budgets = await loadServiceBudgets(true);
    if (process.env.OPENSCOUT_DEBUG_SERVICE_BUDGETS === "1") {
      console.warn("[scout] provider telemetry bootstrap", {
        claude: telemetry.claude.status,
        statuslineLatest: telemetry.statuslineLatest.status,
        budgetFeeds: budgets.gauges.map((gauge) => gauge.id),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[scout] Provider telemetry bootstrap failed: ${message}`);
  }
}

let terminalRelay: ManagedTerminalRelay | null = null;
let terminalRelayStart: Promise<ManagedTerminalRelay | null> | null = null;

function stopTerminalRelay(): void {
  terminalRelay?.shutdown();
  terminalRelay = null;
  terminalRelayStart = null;
}

function startTerminalRelay(): Promise<ManagedTerminalRelay | null> {
  if (terminalRelayStart) {
    return terminalRelayStart;
  }
  terminalRelayStart = startManagedTerminalRelay({
    hostname,
    webPort: port,
  })
    .then((relay) => {
      terminalRelay = relay;
      return relay;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[scout] Terminal relay unavailable: ${message}`);
      return null;
    })
    .finally(() => {
      terminalRelayStart = null;
    });
  return terminalRelayStart;
}

async function ensureTerminalRelay(): Promise<ManagedTerminalRelay | null> {
  if (terminalRelay && await terminalRelay.healthcheck()) {
    return terminalRelay;
  }
  terminalRelay?.shutdown();
  terminalRelay = null;
  return startTerminalRelay();
}

const web = await createOpenScoutWebServer({
  currentDirectory,
  webPort: port,
  shellStateCacheTtlMs,
  assetMode: useViteProxy ? "vite-proxy" : "static",
  viteDevUrl,
  staticRoot,
  advertisedHost: applicationServerIdentity.advertisedHost,
  portalHost: applicationServerIdentity.portalHost,
  publicOrigin: applicationServerIdentity.publicOrigin,
  trustedHosts: applicationServerIdentity.trustedHosts,
  trustedOrigins: applicationServerIdentity.trustedOrigins,
  authToken: webAuthToken,
  sessions: webSessions,
  resolvePeerAddress: requestPeerAddresses.resolve,
  runTerminalCommand: async (request) => {
    const relay = await ensureTerminalRelay();
    if (!relay) {
      throw new Error("Terminal relay is unavailable");
    }
    await relay.queueCommand(request);
  },
  destroyTerminalRelaySession: async (sessionId) => {
    const relay = await ensureTerminalRelay();
    if (!relay) {
      throw new Error("Terminal relay is unavailable");
    }
    return relay.destroySession(sessionId);
  },
  destroyTerminalRelaySurface: async (backend, sessionName) => {
    const relay = await ensureTerminalRelay();
    if (!relay) {
      throw new Error("Terminal relay is unavailable");
    }
    return relay.destroySurface(backend, sessionName);
  },
  terminalRelayHealthcheck: async () => {
    const relay = await ensureTerminalRelay();
    return relay ? relay.healthcheck() : false;
  },
  scoutbot: { enabled: true },
});
const { app, warmupCaches } = web;

const honoFetch = app.fetch;
const relayWebSocket = createRelayWebSocketProxy();

let server: ReturnType<typeof Bun.serve<RelayWSData>>;
try {
  server = Bun.serve<RelayWSData>({
    port,
    hostname,
    idleTimeout: idleTimeoutSeconds,

    async fetch(req, server) {
      const url = new URL(req.url);
      const peerAddress = server.requestIP(req)?.address;

      if (!isScoutWebRequestAllowedFromPeer(req, peerAddress, lanAccessScope)) {
        return new Response("Not Found", { status: 404 });
      }

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        let upstreamUrl: string | null = null;
        let upstreamHeaders: Record<string, string> | undefined;

        // A `*.scout.local` peer doorway: bridge the socket to the peer's web
        // server. The peer's own gates apply upstream — the doorway name is
        // its advertised host, and the browser's session cookie flows through
        // for that origin. Same-Mac only, like the HTTP doorway proxy.
        const requestHost = requestHostName(req.headers.get("host"));
        const peer = requestHost && isSameMacScoutRequest(req, peerAddress)
          ? await web.resolvePortalPeerUpstream(requestHost).catch(() => null)
          : null;

        if (peer?.kind === "proxy") {
          const upstream = peer.upstream;
          upstreamUrl = toWebSocketUrl(upstream.base, url.pathname, url.search);
          upstreamHeaders = {
            host: upstream.preserveDoorwayHost
              ? requestHost
              : new URL(upstream.base).host,
            ...(req.headers.get("origin") ? { origin: req.headers.get("origin")! } : {}),
            ...(req.headers.get("cookie") ? { cookie: req.headers.get("cookie")! } : {}),
          };
        } else if (peer?.kind === "offline") {
          return new Response(`${peer.label} is not reachable right now.`, { status: 503 });
        } else {
          // Block cross-origin (drive-by) upgrades to the privileged proxy sockets.
          // The vite HMR socket is exempt (dev-only, its own origin).
          const guardsOrigin =
            url.pathname === routes.terminalRelayPath
            || url.pathname === routes.tailStreamPath
            || url.pathname === routes.eventsStreamPath;
          if (
            guardsOrigin
            && (
              !isAuthorizedScoutWebSocketRequest(req, webAuthToken, {
                trustedHosts: applicationServerIdentity.trustedHosts,
                trustedOrigins: applicationServerIdentity.trustedOrigins,
                sessions: webSessions,
              }, peerAddress)
            )
          ) {
            return new Response("Unauthorized", {
              status: 401,
              headers: { "WWW-Authenticate": 'Bearer realm="OpenScout Web"' },
            });
          }

          if (url.pathname === routes.terminalRelayPath) {
            const relay = await ensureTerminalRelay();
            upstreamUrl = relay?.targetWebSocketUrl
              ? `${relay.targetWebSocketUrl}${url.search}`
              : null;
            if (!upstreamUrl) {
              return new Response("Terminal relay unavailable", { status: 503 });
            }
          } else if (url.pathname === routes.tailStreamPath || url.pathname === routes.eventsStreamPath) {
            upstreamUrl = toWebSocketUrl(resolveScoutBrokerUrl(), "/trpc", url.search);
          } else if (viteDevUrl && url.pathname === routes.viteHmrPath) {
            upstreamUrl = toWebSocketUrl(viteDevUrl, url.pathname, url.search);
          } else {
            return new Response("WebSocket endpoint not found", { status: 404 });
          }
        }

        const ok = server.upgrade(req, {
          data: {
            upstream: null,
            pending: [],
            upstreamProtocol: req.headers.get("sec-websocket-protocol"),
            upstreamUrl,
            upstreamHeaders,
          },
        });
        return ok
          ? (undefined as unknown as Response)
          : new Response("WebSocket upgrade failed", { status: 500 });
      }

      if (
        req.method === "POST"
        && (url.pathname === routes.uploadPath || url.pathname === routes.relayUploadPath)
      ) {
        if (
          !isTrustedScoutApiRequest(req, {
            trustedHosts: applicationServerIdentity.trustedHosts,
            trustedOrigins: applicationServerIdentity.trustedOrigins,
          }, peerAddress)
          || !isAuthenticatedScoutRequest(req, webAuthToken, webSessions.validate)
        ) {
          return new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Bearer realm="OpenScout Web"' },
          });
        }
        return handleRelayUpload(req);
      }

      // The bootstrap script auto-issues a browser session on two vouched
      // paths: a same-Mac client (loopback / local edge), or a declared front
      // door (an authenticating reverse proxy such as an exe.dev private share
      // or the OSN mesh front door). Already-authenticated requests pass
      // through untouched so page loads don't mint a fresh session each time.
      const frontDoorEligible = url.pathname === routes.bootstrapScriptPath
        && shouldIssueFrontDoorScoutWebCredential(
          req,
          peerAddress,
          applicationServerIdentity.frontDoorOrigins,
          applicationServerIdentity.frontDoorPeers,
        );
      const bootstrapEligible = url.pathname === routes.bootstrapScriptPath
        && !isAuthenticatedScoutRequest(req, webAuthToken, webSessions.validate)
        && (frontDoorEligible || shouldIssueLocalScoutWebCredential(req, peerAddress));
      const honoRequest = bootstrapEligible
        ? new Request(req, {
            headers: (() => {
              const headers = new Headers(req.headers);
              headers.set("authorization", `Bearer ${webAuthToken}`);
              return headers;
            })(),
          })
        : req;
      requestPeerAddresses.remember(honoRequest, peerAddress);
      const response = await honoFetch(honoRequest, server);
      if (!bootstrapEligible || response.status >= 400) return response;

      const headers = new Headers(response.headers);
      // Front-door browsers get a minted, revocable session. Loopback clients
      // keep the operator-token cookie: CLI helpers fetch bootstrap on every
      // uncredentialed call, and minting there would churn the session store.
      const secure = isForwardedHttpsScoutRequest(req);
      try {
        headers.append("set-cookie", frontDoorEligible
          ? scoutWebAuthCookie(
              webSessions.mint({ label: "front-door" }),
              secure,
              SCOUT_WEB_SESSION_MAX_AGE_SECONDS,
            )
          : scoutWebAuthCookie(webAuthToken, secure));
      } catch {
        void response.body?.cancel().catch(() => {});
        return Response.json({ error: "session storage unavailable" }, {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },

    websocket: relayWebSocket,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE|address already in use|in use/i.test(message)) {
    console.error(
      `[scout] Port ${port} is already in use on ${hostname}.\n` +
        `        Try: bun dev --port ${port + 100}  (or another free port)`,
    );
  } else {
    console.error(`[scout] Failed to start server on ${hostname}:${port} — ${message}`);
  }
  stopTerminalRelay();
  process.exit(1);
}

// Graceful shutdown: terminate long-lived WS upstreams first, then drain HTTP,
// then exit. A second signal forces immediate exit.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
let shuttingDown = false;
// Broker-launched web must not survive a broker crash as an unowned listener.
// Standalone `scout server` processes do not receive OPENSCOUT_PARENT_PID, so
// this is intentionally inactive outside broker supervision.
const parentWatchdog = startProcessParentWatchdog(process.env.OPENSCOUT_PARENT_PID);
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    console.log(`[scout] ${signal} received during shutdown — forcing exit.`);
    process.exit(1);
  }
  shuttingDown = true;
  if (parentWatchdog) clearInterval(parentWatchdog);
  console.log(`[scout] ${signal} received — draining (up to ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms)...`);
  const forceExit = setTimeout(() => {
    console.error("[scout] Drain timeout exceeded — forcing exit.");
    process.exit(1);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS);
  forceExit.unref?.();
  // Tear down the terminal relay first so its WebSocket upstreams (long-lived
  // PTY/tmux sessions) close — otherwise server.stop() would wait the full
  // drain window for those connections to finish on their own.
  stopTerminalRelay();
  try { await web.stop(); } catch { /* ignore */ }
  try {
    await server.stop();
  } catch (error) {
    console.error("[scout] server.stop() failed:", error);
  }
  clearTimeout(forceExit);
  process.exit(0);
};
process.on("SIGINT", (signal) => { void shutdown(signal); });
process.on("SIGTERM", (signal) => { void shutdown(signal); });

console.log(`OpenScout Web -> http://${hostname}:${server.port}`);
console.log(`OpenScout URL -> ${applicationServerIdentity.publicOrigin ?? `http://${applicationServerIdentity.advertisedHost}:${server.port}`}`);
console.log(`Relay WebSocket -> ws://${hostname}:${server.port}${routes.terminalRelayPath}`);
if (startupWarmupEnabled) {
  setTimeout(() => void warmupCaches(), 5_000).unref?.();
}
if (providerTelemetryBootstrapEnabled) {
  setTimeout(() => void bootstrapProviderTelemetry(), 30_000).unref?.();
}
