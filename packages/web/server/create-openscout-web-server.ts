import { ChatPresence } from "../shared/chat-presence.ts";
import { ChatSendLimiter } from "./chat-send-limiter.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

import { Hono, type Context } from "hono";
import {
  machineLabel,
  machinePresence,
  normalizeMachineHostName,
  type MachineRecord,
  type ScoutRuntimeCapabilityCatalog,
} from "@openscout/protocol";
import {
  createPendingPairRequestStore,
  pairRequestStatePath,
} from "./pairing-pair-requests.ts";
import { startScoutPairLanBeacon } from "./pairing-lan-beacon.ts";
import {
  coalesce,
  createCachedSnapshot,
  cookieValue,
  installScoutApiMiddleware,
  isLoopbackScoutAddress,
  isSameMacScoutRequest,
  isScoutWebRequestAllowedFromPeer,
  registerScoutWebAssets,
  resolveScoutRequestPeerAddress,
  resolveScoutWebLanAccessScope,
  SCOUT_WEB_LOGIN_PAGE_PATH,
} from "./server-core.ts";
import { renderScoutWebLoginPage } from "./web-login-page.ts";
import {
  askScoutQuestion,
  requestScoutHostWeb,
  resolveScoutBrokerUrl,
} from "./core/broker/service.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import { readBundledScoutVersion, readWebClientProfile } from "@openscout/runtime/web-full-client";
import { createAmbientVoiceController } from "./ambient-voice-controller.ts";
import { synthesizeScoutSpeech } from "./scout-voice.ts";
import {
  cancelScoutVoiceSession,
  createScoutVoiceSession,
  hasActiveScoutVoiceDictation,
  isScoutVoiceHostSpeaking,
  setScoutVoiceAmbientListener,
} from "./scout-voice-session.ts";
import {
  CHANNEL_MEMBER_COOKIE,
  channelMemberBearerToken,
  channelMemberMayAccess,
  createChannelMemberSessionAuthority,
  type ChannelMemberGrant,
} from "./core/conversations/channel-member-session.ts";
import {
  getTailDiscovery,
  refreshTailDiscovery,
  readRecentTranscriptEvents,
  snapshotRecentEvents,
} from "@openscout/runtime/tail";
import {
  mountRepoDiffRoutes,
} from "./routes/repo-diff.ts";
import {
  createScoutbotWebServices,
  mountScoutbotRoutes,
  type WebTailRuntime,
} from "./routes/scoutbot.ts";
import { mountScoutVoiceRoutes } from "./routes/voice.ts";
import { mountScoutDeckSurfaceRoutes } from "./routes/deck-surface.ts";
import {
  loadMachines,
} from "./core/machines/service.ts";
import { createMeshNodeStateStore } from "./core/mesh/node-state.ts";
import {
  loadOpenScoutWebShellState,
  type OpenScoutWebShellState,
} from "./runtime-summary.ts";
import {
  startGlobalHeuristicsWatcher,
} from "./material-heuristics.ts";
import {
  gitBuildInfoProbe,
  type GitBuildInfo,
} from "@openscout/runtime/system-probes";
import {
  localConfigHome,
} from "@openscout/runtime/local-config";
import {
  readOpenScoutSettings,
  writeOpenScoutSettings,
} from "@openscout/runtime/setup";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";
import {
  resolveOpenScoutWebRoutes,
  serializeOpenScoutWebBootstrap,
} from "../shared/runtime-config.js";
import { mountChatRoutes } from "./routes/chat.ts";
import { mountKnowledgeRoutes } from "./routes/knowledge.ts";
import {
  expandHomePath,
} from "./local-paths.ts";
import { mountFileRoutes } from "./routes/files.ts";
import {
  loadPairingState,
} from "./pairing-state.ts";
import { mountPairingRoutes } from "./routes/pairing.ts";
import {
  CreateOpenScoutWebServerOptions,
} from "./web-server-options.ts";
import {
  defaultCaptureTmuxPane,
} from "./tmux-pane-capture.ts";
import {
  buildOperatorAttentionState,
  configureHerdrContinuation,
} from "./core/attention/operator-attention-state.ts";
import { mountAttentionRoutes } from "./routes/attention.ts";
import { mountTerminalRoutes } from "./routes/terminals.ts";
import { mountAgentRoutes } from "./routes/agents.ts";
import {
  buildHudRunnerOptions,
} from "./hud-runner-options.ts";
import { mountFleetRoutes } from "./routes/fleet.ts";
import { mountWorkRoutes } from "./routes/work.ts";
import { mountMeshOpsRoutes } from "./routes/mesh-ops.ts";
import { mountRoleRoutes } from "./routes/roles.ts";
import { mountFlightRoutes } from "./routes/flights.ts";
import { mountConversationRoutes } from "./routes/conversations.ts";
import { mountMeshRoutes } from "./routes/mesh.ts";
import { mountLocalHttpsRoutes } from "./routes/local-https.ts";
import { mountOnboardingRoutes } from "./routes/onboarding.ts";
import { mountSoloProRoutes } from "./routes/solo-pro.ts";
import { mountScoutbotThreadRoutes } from "./routes/scoutbot-threads.ts";
import { mountBlobRoutes } from "./routes/blobs.ts";
import { mountSendRoutes } from "./routes/send.ts";
import { mountBrokerRoutes } from "./routes/broker.ts";
import { mountSessionRoutes } from "./routes/sessions.ts";
import { mountStreamRoutes } from "./routes/stream.ts";


export {
  withNodeCoveredRoster,
} from "./agent-roster.ts";


export type {
  TerminalRelayDestroyRequest,
  TerminalSurfaceControlRequest,
} from "./terminal-requests.ts";


export type {
  TerminalRunRequest,
  TmuxPanePeekRequest,
  TmuxPanePeekCapture,
  CreateOpenScoutWebServerOptions,
} from "./web-server-options.ts";

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map((candidate) => candidate.trim())
      .filter(Boolean)
    : [];
}

function isHttpsWebRequest(c: Context, publicOrigin: string | undefined): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto === "https") return true;

  try {
    if (new URL(c.req.url).protocol === "https:") return true;
  } catch {
    // Fall through to the configured public origin.
  }

  if (!publicOrigin) return false;
  try {
    return new URL(publicOrigin).protocol === "https:";
  } catch {
    return publicOrigin.trim().toLowerCase().startsWith("https://");
  }
}

function installHttpsEdgeSecurityHeaders(app: Hono, publicOrigin: string | undefined): void {
  app.use("*", async (c, next) => {
    await next();
    if (!isHttpsWebRequest(c, publicOrigin)) return;
    c.header("Content-Security-Policy", "upgrade-insecure-requests; block-all-mixed-content");
  });
}

export type { ScoutWebAssetMode } from "./server-core.ts";


export type OpenScoutWebServer = {
  app: Hono;
  warmupCaches: () => Promise<void>;
  /**
   * Start the Scoutbot runner that answers broker DMs. Clients that post to
   * the broker directly (the phone) never touch a Scoutbot web route, so the
   * lazy start alone left them unanswered after every web restart.
   */
  startScoutbotRunner: () => Promise<void>;
  stop: () => Promise<void>;
  /**
   * Resolve a `*.portalHost` peer doorway host: a dialable upstream, a known
   * peer with no live route, or null when the host is not a known Scout peer.
   * The Bun.serve layer uses this to bridge WebSocket upgrades to the peer's
   * web server.
   */
  resolvePortalPeerUpstream: (
    requestHost: string,
  ) => Promise<ScoutPortalPeerResolution>;
};

type OpenScoutBuildInfo = {
  version: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  mode: "dev" | "production";
  server: {
    engine: "bun" | "node";
    engineVersion: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
};

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseProcessNumber(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveBundledStaticClientRoot(
  moduleUrl: string | URL = import.meta.url,
): string {
  return resolve(dirname(fileURLToPath(moduleUrl.toString())), "client");
}

function normalizeRequestHost(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .split(":")[0]
    ?.replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase() ?? "";
}

function resolveObservedPath(
  targetPath: string,
  cwd: string | null | undefined,
): string | null {
  const expanded = expandHomePath(targetPath.trim());
  if (!expanded) {
    return null;
  }
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  if (!cwd?.trim()) {
    return null;
  }
  return resolve(expandHomePath(cwd.trim()), expanded);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

let cachedWebPackageVersion: string | null | undefined;

function readWebPackageVersion(): string | null {
  if (cachedWebPackageVersion !== undefined) {
    return cachedWebPackageVersion;
  }
  try {
    const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    cachedWebPackageVersion = typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    cachedWebPackageVersion = null;
  }
  return cachedWebPackageVersion;
}

function openScoutBuildInfoFromGit(value: GitBuildInfo | null): OpenScoutBuildInfo {
  const bunVersion = process.versions.bun;
  return {
    version: readWebPackageVersion(),
    branch: value?.branch ?? value?.bootBranch ?? null,
    commit: value?.commit ?? null,
    dirty: value?.dirty ?? null,
    mode: process.env.NODE_ENV === "production" ? "production" : "dev",
    server: {
      engine: bunVersion ? "bun" : "node",
      engineVersion: bunVersion ?? process.versions.node,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

function loadOpenScoutBuildInfo(currentDirectory: string): OpenScoutBuildInfo {
  return openScoutBuildInfoFromGit(gitBuildInfoProbe.for(currentDirectory).read().value);
}

async function warmOpenScoutBuildInfo(currentDirectory: string): Promise<OpenScoutBuildInfo> {
  const snapshot = await gitBuildInfoProbe.for(currentDirectory).fresh({ maxAgeMs: 60_000 });
  return openScoutBuildInfoFromGit(snapshot.value);
}

async function refreshOpenScoutBuildInfo(currentDirectory: string): Promise<OpenScoutBuildInfo> {
  const probe = gitBuildInfoProbe.for(currentDirectory);
  probe.invalidate("operator requested build refresh");
  const snapshot = await probe.fresh({ maxAgeMs: 0 });
  return openScoutBuildInfoFromGit(snapshot.value);
}

async function resolveOpenScoutBuildInfo(currentDirectory: string, refresh: boolean): Promise<OpenScoutBuildInfo> {
  if (refresh) return refreshOpenScoutBuildInfo(currentDirectory);
  const cached = gitBuildInfoProbe.for(currentDirectory).read();
  if (cached.value) return openScoutBuildInfoFromGit(cached.value);
  return warmOpenScoutBuildInfo(currentDirectory);
}


/* ── scout.local portal peers ── */

export type ScoutPortalPeer = {
  /** What the row links to — the doorway host, or the machine name unlinked. */
  label: string;
  href: string | null;
  detail: string;
};

/**
 * The doorway page does not wait on a cold roster scan. `/v1/machines` is
 * cached broker-side, but a cold pass holds an mDNS browse open for ~2.5s —
 * beyond that the doorway renders this machine alone and the roster is warm
 * for the next visit.
 */
const SCOUT_PORTAL_PEER_TIMEOUT_MS = 3_500;

function isScoutEnabledMachine(machine: MachineRecord): boolean {
  return !machine.isSelf
    && (Boolean(machine.scoutNodeId)
      || machine.capabilities.some((capability) => capability.startsWith("scout-")));
}

function bracketIPv6(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

const SCOUT_DOORWAY_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The portal host or any of its subdomains — always a doorway, never a route. */
/**
 * Doorway labels this node serves itself rather than proxying to a peer.
 *
 * `chat.scout.local` is the Scout Chat space. Reserving the label keeps peer
 * routing intact for every other name while guaranteeing the chat host always
 * means this node's chat surface.
 */
export const RESERVED_SCOUT_SERVICE_LABELS: readonly string[] = ["chat"];

export function isReservedScoutServiceHost(host: string, portalHost: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return RESERVED_SCOUT_SERVICE_LABELS.some(
    (label) => normalized === `${label}.${portalHost}`,
  );
}

function isScoutDoorwayHost(host: string, portalHost: string): boolean {
  return host === portalHost || host.endsWith(`.${portalHost}`);
}

/**
 * Every `*.${portalHost}` doorway name evidence says a machine answers to.
 * The advertised `webHost` is authoritative; the derived names let peers
 * running older builds still be found by their hostname. The mDNS mesh
 * advert's `openscout-<keyid>.local` instance is a key fingerprint, not a
 * doorway name, so it is deliberately skipped.
 */
function portalPeerDoorwayHosts(machine: MachineRecord, portalHost: string): string[] {
  const hosts = new Set<string>();
  const addName = (value: string | null | undefined) => {
    const short = normalizeMachineHostName(value);
    if (SCOUT_DOORWAY_LABEL_PATTERN.test(short) && !short.startsWith("openscout-")) {
      hosts.add(`${short}.${portalHost}`);
    }
  };
  for (const item of machine.evidence) {
    if (item.kind === "scout") {
      const webHost = item.webHost?.trim().replace(/\.$/, "").toLowerCase();
      if (webHost && webHost !== portalHost && webHost.endsWith(`.${portalHost}`)) {
        hosts.add(webHost);
      }
      addName(item.hostName);
      addName(item.nodeName);
    } else if (item.kind === "tailnet") {
      addName(item.hostName);
      addName(item.dnsName);
    } else if (item.kind === "lan") {
      addName(item.hostName);
      addName(item.instanceName);
    }
  }
  // A peer never answers to a reserved service label, however it is named.
  return [...hosts].filter((host) => !isReservedScoutServiceHost(host, portalHost));
}

type ScoutPortalLink = {
  href: string;
  label: string;
  via: "lan" | "tailnet" | "mesh";
};

export type ScoutPortalPeerUpstream = {
  /** Base URL to dial — always an address, never a `*.scout.local` name. */
  base: string;
  via: "lan" | "tailnet" | "mesh";
  /**
   * True when `base` is a bare address route: the request keeps the doorway
   * name as its upstream Host — it is the peer's own advertised name, which
   * its web server already trusts. Advertised webUrl upstreams keep their own
   * host instead, so a front door's vhost routing still works.
   */
  preserveDoorwayHost: boolean;
};

/**
 * What a `*.portalHost` request host resolves to: a peer to proxy to, a peer
 * we know but cannot currently dial (never fall through to the local app —
 * silently serving this machine under a peer's name is the failure the
 * doorway exists to prevent), or nothing we recognize.
 */
export type ScoutPortalPeerResolution =
  | { kind: "proxy"; upstream: ScoutPortalPeerUpstream }
  | { kind: "offline"; label: string }
  | null;

/**
 * The address a machine can actually be dialed on: an advertised non-loopback
 * webUrl, a LAN address (the local edge answers port 80 for all of a
 * machine's own interface addresses), or a tailnet name/address. Never a
 * `*.scout.local` doorway name and never loopback — both resolve back to
 * this machine.
 */
function portalMachineUpstream(
  machine: MachineRecord,
  portalHost: string,
): ScoutPortalPeerUpstream | null {
  for (const item of machine.evidence) {
    if (item.kind !== "scout" || !item.webUrl) continue;
    try {
      const url = new URL(item.webUrl);
      const host = url.hostname.replace(/\.$/, "").toLowerCase();
      // Nodes today advertise their own loopback (http://127.0.0.1:43120),
      // which reaches nobody — but a non-loopback webUrl is the node's own
      // word for its doorway and always wins when present. A doorway-named
      // webUrl is not a route: the name resolves to this machine's loopback
      // and dialing it would proxy in a circle.
      if (!isLoopbackScoutAddress(host) && !isScoutDoorwayHost(host, portalHost)) {
        return { base: url.origin, via: "mesh", preserveDoorwayHost: false };
      }
    } catch {
      // A malformed advertised URL is the peer's problem; keep looking.
    }
  }

  const lanRoute = machine.routes.find((route) => route.kind === "lan");
  if (lanRoute) {
    return { base: `http://${bracketIPv6(lanRoute.host)}`, via: "lan", preserveDoorwayHost: true };
  }

  // MagicDNS names read better than CGNAT literals; both reach the edge.
  const tailnetHost = machine.routes.find(
    (route) => route.kind === "tailnet" && isIP(route.host) === 0,
  )?.host ?? machine.routes.find((route) => route.kind === "tailnet")?.host;
  if (tailnetHost) {
    return { base: `http://${bracketIPv6(tailnetHost)}`, via: "tailnet", preserveDoorwayHost: true };
  }

  return null;
}

/**
 * What the portal links to for a peer. On this LAN a `*.scout.local` doorway
 * name is the preferred link: it resolves to loopback wherever the peer's
 * mDNS advert reaches, and the local edge proxies it to the peer's live
 * route — so the name survives address changes. Without a doorway name the
 * link is the raw route; without any route the peer is listed, not linked.
 *
 * `portSuffix` is the incoming request's port — through the edge that is :80
 * (empty), but a dev server on :43120 answers `foo.scout.local:43120`
 * directly, so doorway links carry it. Raw-address links do not: their port
 * belongs to the *peer's* edge.
 */
function portalMachineLink(
  machine: MachineRecord,
  portalHost: string,
  portSuffix: string,
): ScoutPortalLink | null {
  const upstream = portalMachineUpstream(machine, portalHost);
  if (upstream?.via === "mesh") {
    return { href: `${upstream.base}/`, label: new URL(upstream.base).host, via: "mesh" };
  }

  // A `webHost` that is not a `*.portalHost` name is a real DNS doorway —
  // link it verbatim rather than routing through the local edge.
  for (const item of machine.evidence) {
    if (item.kind !== "scout") continue;
    const webHost = item.webHost?.trim().replace(/\.$/, "").toLowerCase();
    if (webHost && webHost !== portalHost && !webHost.endsWith(`.${portalHost}`)) {
      return { href: `http://${webHost}/`, label: webHost, via: "mesh" };
    }
  }

  if (!upstream) return null;

  // Any dialable route can carry a doorway name — the local edge proxies it —
  // so the stable name beats a raw LAN IP or MagicDNS name for links too.
  const doorway = portalPeerDoorwayHosts(machine, portalHost)
    .find((host) => host.endsWith(`.${portalHost}`));
  if (doorway) {
    return { href: `http://${doorway}${portSuffix}/`, label: doorway, via: upstream.via };
  }
  return { href: `${upstream.base}/`, label: new URL(upstream.base).host, via: upstream.via };
}

function scoutPortalPeerViews(
  machines: readonly MachineRecord[],
  portalHost: string,
  portSuffix: string,
): ScoutPortalPeer[] {
  const peers: ScoutPortalPeer[] = [];
  for (const machine of machines) {
    if (!isScoutEnabledMachine(machine)) continue;
    const link = portalMachineLink(machine, portalHost, portSuffix);
    const presence = machinePresence(machine);
    const name = machineLabel(machine);
    const parts = link ? [link.via === "lan" ? "LAN" : link.via === "tailnet" ? "Tailnet" : "Mesh", presence] : ["registered", presence];
    // When the row's label is a bare address the derived name is the only
    // human handle — keep it in the sub line rather than losing it.
    if (link && isIP(link.label) !== 0 && name && isIP(name) === 0 && name !== link.label) {
      parts.push(name);
    }
    peers.push({
      label: link?.label ?? name,
      href: link?.href ?? null,
      detail: parts.join(" · "),
    });
  }
  return peers;
}

async function loadScoutPortalPeers(
  options: CreateOpenScoutWebServerOptions,
  portalHost: string,
  portSuffix: string,
): Promise<ScoutPortalPeer[]> {
  const read = options.portalMachines ?? (async () => (await loadMachines()).machines);
  const machines = await Promise.race([
    read(),
    new Promise<null>((resolve) => setTimeout(resolve, SCOUT_PORTAL_PEER_TIMEOUT_MS, null)),
  ]);
  return machines ? scoutPortalPeerViews(machines, portalHost, portSuffix) : [];
}

const SCOUT_PEER_PROXY_STRIP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Forward one request to a peer doorway's dialable route. The peer enforces
 * its own auth; this is a pipe, not a credential. The doorway name travels as
 * the upstream Host on address routes (it is the peer's own advertised name),
 * which keeps the browser's Origin same-origin on the far side.
 */
async function proxyScoutPortalPeerRequest(
  c: Context,
  upstream: ScoutPortalPeerUpstream,
  requestHost: string,
  peerAddress: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const incoming = new URL(c.req.url);
  const upstreamUrl = new URL(`${incoming.pathname}${incoming.search}`, upstream.base);
  const headers = new Headers(c.req.raw.headers);
  for (const name of SCOUT_PEER_PROXY_STRIP_HEADERS) headers.delete(name);
  headers.delete("content-length");
  if (upstream.preserveDoorwayHost) {
    headers.set("host", requestHost);
  } else {
    headers.delete("host");
    if (headers.has("origin")) headers.set("origin", upstream.base);
    const referer = headers.get("referer");
    if (referer) {
      try {
        const ref = new URL(referer);
        headers.set("referer", `${upstream.base}${ref.pathname}${ref.search}${ref.hash}`);
      } catch {
        headers.delete("referer");
      }
    }
  }
  const forwardedFor = [c.req.header("x-forwarded-for"), peerAddress]
    .filter(Boolean)
    .join(", ");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  headers.set("x-forwarded-proto", incoming.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-host", c.req.header("host") ?? requestHost);

  const method = c.req.method.toUpperCase();
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    (init as { duplex?: string }).duplex = "half";
    init.body = c.req.raw.body;
  }
  const response = await fetchImpl(upstreamUrl, init);
  const outHeaders = new Headers(response.headers);
  for (const name of [...SCOUT_PEER_PROXY_STRIP_HEADERS, "content-length", "content-encoding"]) {
    outHeaders.delete(name);
  }
  // Keep redirects inside the doorway when the upstream points at itself.
  const location = outHeaders.get("location");
  if (location) {
    try {
      const target = new URL(location, upstream.base);
      if (target.origin === new URL(upstream.base).origin) {
        target.protocol = incoming.protocol;
        target.host = incoming.host;
        outHeaders.set("location", target.toString());
      }
    } catch { /* leave the upstream's Location untouched */ }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

function renderScoutLocalPortal(input: {
  requestUrl: string;
  portalHost: string;
  nodeHost: string;
  peers: ScoutPortalPeer[];
}): string {
  const url = new URL(input.requestUrl);
  const port = url.port ? `:${url.port}` : "";
  const nodeUrl = `${url.protocol}//${input.nodeHost}${port}/`;
  const nodeHost = escapeHtml(input.nodeHost);
  const portalHost = escapeHtml(input.portalHost);
  const escapedNodeUrl = escapeHtml(nodeUrl);
  const peerRows = input.peers
    .map((peer, index) => {
      const delay = Math.min(250 + index * 45, 880);
      const inner = `
        <span class="node__id">
          <span class="node__host">${escapeHtml(peer.label)}</span>
          <span class="node__sub">${escapeHtml(peer.detail)}</span>
        </span>
        ${peer.href ? `<span class="node__open" aria-hidden="true">Open</span>` : ""}`;
      return peer.href
        ? `        <a class="node rise" style="animation-delay: ${delay}ms" href="${escapeHtml(peer.href)}">${inner}\n        </a>`
        : `        <div class="node node--off rise" style="animation-delay: ${delay}ms">${inner}\n        </div>`;
    })
    .join("\n");
  // The mesh recedes behind one quiet label; the count keeps the label honest.
  const peersBlock = input.peers.length > 0
    ? `      <div class="peers">
        <div class="peers__label rise" style="animation-delay: 210ms">Elsewhere · ${input.peers.length}</div>
${peerRows}
      </div>`
    : "";
  const trustDelay = Math.min(300 + input.peers.length * 45, 940);
  // Quiet ledger doorway (design study: design/portal-studies/scout-local-quiet-ledger.html).
  // One identity cluster, one live wavefront instrument, one ledger line per
  // node, one trust line. No accent hue: ink plus stepped warm greys only.
  // Keep this page self-contained (inline CSS/JS only) — it is served before
  // the SPA shell and must not depend on client assets.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Scout Local</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0a0a09;
        --ink: #f1ece1;
        --ink-2: #a49d90;
        --ink-3: #6f6960;
        --edge: #23221f;
        --edge-2: #3d3a34;
        --hover: color-mix(in srgb, var(--ink) 3.5%, transparent);
        --t0: #2e2b27;
        --t1: #474339;
        --t2: #6b6558;
        --t3: #968e7f;
        --t4: #d5cdbd;
        --sans: "Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      }
      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --bg: #f3f1ea;
          --ink: #171914;
          --ink-2: #5f5d52;
          --ink-3: #6b685c;
          --edge: #dcd9cb;
          --edge-2: #b9b5a4;
          --t0: #d2cec2;
          --t1: #a6a08d;
          --t2: #757061;
          --t3: #49463d;
          --t4: #1f211b;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        align-content: center;
        justify-items: stretch;
        padding: 40px 32px;
        background: var(--bg);
        color: var(--ink);
        font-family: var(--sans);
        -webkit-font-smoothing: antialiased;
      }
      main { width: 100%; max-width: 720px; min-width: 0; margin-inline: auto; }
      @keyframes settle {
        from { opacity: 0; transform: translateY(10px); }
      }
      .rise { animation: settle 640ms cubic-bezier(0.16, 1, 0.3, 1) both; }
      .rise-2 { animation-delay: 90ms; }
      .rise-3 { animation-delay: 170ms; }
      @media (prefers-reduced-motion: reduce) {
        .rise { animation: none; }
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 32px 48px;
        align-items: center;
        margin-bottom: 48px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 26px;
      }
      .sigil { display: block; color: var(--ink-2); }
      .host {
        font-family: var(--mono);
        font-size: 12px;
        letter-spacing: 0.02em;
        color: var(--ink-2);
      }
      h1 {
        margin: 0 0 14px;
        font-size: clamp(36px, 4.6vw, 46px);
        font-weight: 560;
        letter-spacing: -0.03em;
        line-height: 1.05;
      }
      .lede {
        margin: 0;
        max-width: 44ch;
        font-size: 15px;
        line-height: 1.6;
        color: var(--ink-2);
      }
      .field {
        display: block;
        position: relative;
        color: inherit;
        text-decoration: none;
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        -webkit-mask-image: radial-gradient(ellipse 70% 72% at 50% 50%, #000 55%, transparent 100%);
        mask-image: radial-gradient(ellipse 70% 72% at 50% 50%, #000 55%, transparent 100%);
      }
      .field:focus-visible {
        outline: 1px solid var(--ink-2);
        outline-offset: 6px;
      }
      .field__layer {
        margin: 0;
        font-family: var(--mono);
        font-size: 10px;
        line-height: 1.1;
        white-space: pre;
        letter-spacing: 0;
      }
      .field__layer + .field__layer { position: absolute; inset: 0; }
      .field__layer[data-t="0"] { color: var(--t0); }
      .field__layer[data-t="1"] { color: var(--t1); }
      .field__layer[data-t="2"] { color: var(--t2); }
      .field__layer[data-t="3"] { color: var(--t3); }
      .field__layer[data-t="4"] { color: var(--t4); }
      .node {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        padding: 18px 6px;
        border-top: 1px solid var(--edge);
        border-bottom: 1px solid var(--edge);
        text-decoration: none;
        color: inherit;
        transition: background-color 140ms ease;
      }
      .node:hover { background: var(--hover); }
      .node:focus-visible {
        outline: 1px solid var(--ink-2);
        outline-offset: 3px;
      }
      .node--off:hover { background: none; }
      /* This machine leads: one eyebrow, a stronger rule, a size step up. */
      .node--self {
        padding-block: 22px;
        border-top-color: var(--edge-2);
        border-bottom-color: var(--edge-2);
      }
      .node__eyebrow {
        font-family: var(--mono);
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ink-3);
      }
      .node--self .node__host { font-size: 16px; }
      .node--self .node__open { color: var(--ink-2); }
      /* The rest of the mesh: same ledger grammar, one notch quieter. The
         Open affordance waits for hover/focus instead of reading per row. */
      .peers { margin-top: 38px; }
      .peers__label {
        padding: 0 6px 2px;
        font-family: var(--mono);
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ink-3);
      }
      .peers .node {
        padding-block: 13px;
        border-bottom: none;
      }
      .peers .node:last-child { border-bottom: 1px solid var(--edge); }
      .peers .node__host { color: var(--ink-2); font-size: 13px; }
      .peers .node:hover .node__host,
      .peers .node:focus-visible .node__host { color: var(--ink); }
      .peers .node--off .node__host { color: var(--ink-3); }
      .peers .node__open { opacity: 0; transition: color 140ms ease, opacity 140ms ease; }
      .peers .node:hover .node__open,
      .peers .node:focus-visible .node__open { opacity: 1; }
      .node__id { display: grid; gap: 4px; min-width: 0; }
      .node__host {
        font-family: var(--mono);
        font-size: 14px;
        letter-spacing: -0.01em;
        color: var(--ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .node__sub { font-size: 12px; color: var(--ink-3); }
      .node__open {
        flex: none;
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ink-3);
        transition: color 140ms ease;
      }
      .node:hover .node__open,
      .node:focus-visible .node__open { color: var(--ink); }
      .trust {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 14px;
        margin-top: 20px;
        padding-inline: 6px;
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0.03em;
        color: var(--ink-3);
      }
      .trust a {
        color: var(--ink-2);
        text-decoration: none;
        border-bottom: 1px solid transparent;
        transition: color 140ms ease, border-color 140ms ease;
      }
      .trust a:hover,
      .trust a:focus-visible { color: var(--ink); border-bottom-color: var(--edge-2); }
      .trust .sep { color: var(--edge-2); }
      .trust .note { margin-left: auto; }
      @media (max-width: 680px) {
        .hero { grid-template-columns: minmax(0, 1fr); gap: 28px; margin-bottom: 36px; }
        .field { justify-self: start; }
        h1 { font-size: 32px; }
        .trust .note { margin-left: 0; flex-basis: 100%; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="hero rise">
        <div>
          <div class="brand">
            <span class="sigil" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
                <polygon points="16,4.8 26.2,10.7 26.2,21.9 16,27.8 5.8,21.9 5.8,10.7" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" fill="currentColor" fill-opacity="0.06"/>
                <path d="M16 4.8v23M5.8 10.7 16 16.6 26.2 10.7" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" opacity="0.42"/>
                <polygon points="16,11 21.1,14 21.1,19.6 16,22.6 10.9,19.6 10.9,14" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" fill="currentColor" fill-opacity="0.14" opacity="0.9"/>
              </svg>
            </span>
            <span class="host">${portalHost}</span>
          </div>
          <h1>Scout local</h1>
          <p class="lede">Registered machines on this local Scout mesh. Open a node to inspect agents, sessions, activity, and settings.</p>
        </div>
        <a class="field" href="${escapedNodeUrl}" aria-label="Open ${nodeHost}" title="Open ${nodeHost}">
          <pre class="field__layer" data-t="0" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="1" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="2" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="3" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="4" aria-hidden="true"></pre>
        </a>
      </div>
      <a class="node node--self rise rise-2" href="${escapedNodeUrl}">
        <span class="node__id">
          <span class="node__eyebrow">This machine</span>
          <span class="node__host">${nodeHost}</span>
        </span>
        <span class="node__open">Open</span>
      </a>
${peersBlock}
      <div class="trust rise" style="animation-delay: ${trustDelay}ms">
        <a href="https://openscout.app/docs" target="_blank" rel="noopener noreferrer">Docs</a>
        <span class="sep" aria-hidden="true">/</span>
        <a href="https://github.com/oscout/scout" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="note">served by this machine’s Scout broker</span>
      </div>
    </main>
    <script>
      // Instrument field — pointer-aware wavefronts. Rings emanate on a
      // 6.5s period with a 17s angular phase wobble; one density value
      // drives a 2-step glyph dither and a 5-step tone ramp. The epicenter
      // eases toward the pointer (capped, so it leans rather than jumps),
      // pointer movement sheds decaying ripples, and without a pointer the
      // epicenter wanders a slow lissajous — never a fixed circle. Block
      // glyphs are avoided: they tile seamlessly and collapse into bars.
      // Reduced motion gets the still frame; ?t=<s> pins a phase for
      // review, ?px=0..1&py=0..1 pins a synthetic pointer.
      (function () {
        var W = 42, H = 21;
        var CX = (W - 1) / 2, CY = (H - 1) / 2;
        var ASPECT = 0.545;
        var GLYPH = ["·", "░"];
        var GCUT = [0.12, 0.45];
        var TCUT = [0.24, 0.42, 0.6, 0.8];
        var TONES = 5;
        var TAU = Math.PI * 2;
        var STILL_T = 2.6;
        var LEAN = 0.34;
        var RIPPLE_LIFE = 1.6;

        var field = document.querySelector(".field");
        var layers = [].slice.call(document.querySelectorAll(".field__layer"));
        if (!field || layers.length !== TONES) return;

        var N = W * H;
        var G = new Float32Array(N);
        for (var y = 0; y < H; y++) {
          for (var x = 0; x < W; x++) {
            var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
            G[y * W + x] = (n - Math.floor(n)) * 2 - 1;
          }
        }

        var STRIDE = W + 1;
        var bufs = [];
        for (var b = 0; b < TONES; b++) {
          var buf = new Array(H * STRIDE);
          for (var j = 0; j < buf.length; j++) buf[j] = " ";
          for (var r = 0; r < H; r++) buf[r * STRIDE + W] = "\\n";
          bufs.push(buf);
        }

        var ox = 0, oy = 0;
        var tx = 0, ty = 0;
        var pointerT = -1e9;
        var ripples = [];
        var lastRippleT = -1e9, lastRippleX = 0, lastRippleY = 0;
        var start = -1;

        function fieldClock() {
          return STILL_T + (start < 0 ? 0 : (performance.now() - start) / 1000);
        }

        function onPointerMove(e) {
          var rect = field.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return;
          var px = ((e.clientX - rect.left) / rect.width) * W - CX;
          var py = ((e.clientY - rect.top) / rect.height) * H - CY;
          tx = Math.max(-CX, Math.min(CX, px)) * LEAN;
          ty = Math.max(-CY, Math.min(CY, py)) * LEAN;
          pointerT = fieldClock();
          var moved = Math.abs(px - lastRippleX) + Math.abs(py - lastRippleY);
          if (pointerT - lastRippleT > 0.14 && (moved > 2.5 || pointerT - lastRippleT > 0.6)) {
            ripples.push({
              x: Math.max(-CX, Math.min(CX, px)),
              y: Math.max(-CY, Math.min(CY, py)),
              t0: pointerT,
              amp: 0.5,
            });
            if (ripples.length > 4) ripples.shift();
            lastRippleT = pointerT;
            lastRippleX = px;
            lastRippleY = py;
          }
        }

        function render(t) {
          if (t - pointerT > 2.5) {
            tx = Math.sin(t * 0.19) * CX * 0.22;
            ty = Math.cos(t * 0.14) * CY * 0.22;
          }
          ox += (tx - ox) * 0.07;
          oy += (ty - oy) * 0.07;
          var cx = CX + ox, cy = CY + oy;

          var p1 = (t * TAU) / 6.5;
          var p2 = (t * TAU) / 17;
          for (var y = 0; y < H; y++) {
            var o = y * STRIDE;
            for (var x = 0; x < W; x++) {
              var i = y * W + x;
              var ax = ((x - cx) * ASPECT) / CY;
              var ay = (y - cy) / CY;
              var r = Math.sqrt(ax * ax + ay * ay);
              var a = Math.atan2(ay, ax);
              var e = Math.exp(-Math.pow(r / 0.9, 3.2));
              var u = r * 11 - p1 + 0.35 * Math.sin(a * 2 + p2);
              var c = 0.5 + 0.5 * Math.cos(u);
              var rings = c * c * c * Math.sqrt(c);
              var d = e * (0.16 + 0.78 * rings) + G[i] * 0.03;
              for (var k = 0; k < ripples.length; k++) {
                var rp = ripples[k];
                var age = t - rp.t0;
                if (age < 0 || age > RIPPLE_LIFE) continue;
                var rx = ((x - (CX + rp.x)) * ASPECT) / CY;
                var ry = (y - (CY + rp.y)) / CY;
                var rd = Math.sqrt(rx * rx + ry * ry);
                var wave = Math.cos(rd * 9 - age * 8);
                if (wave > 0) d += wave * Math.exp(-rd * 1.9) * Math.exp(-age * 2.2) * rp.amp;
              }

              var glyph = d >= GCUT[1] ? GLYPH[1] : d >= GCUT[0] ? GLYPH[0] : " ";
              var tone =
                d >= TCUT[3] ? 4 : d >= TCUT[2] ? 3 : d >= TCUT[1] ? 2 : d >= TCUT[0] ? 1 : 0;

              for (var m = 0; m < TONES; m++) bufs[m][o + x] = m === tone ? glyph : " ";
            }
          }
          for (var s = 0; s < TONES; s++) layers[s].textContent = bufs[s].join("");
        }

        var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
        var raf = 0, last = -1;
        var STEP = 1000 / 24;

        function loop(ts) {
          raf = requestAnimationFrame(loop);
          if (start < 0) start = ts;
          if (last >= 0 && ts - last < STEP) return;
          last = ts;
          render(STILL_T + (ts - start) / 1000);
        }
        function stop() {
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
        }
        function play() {
          if (reduce.matches || document.hidden || raf) return;
          last = -1;
          raf = requestAnimationFrame(loop);
        }

        render(STILL_T);

        var search = window.location.search;
        var pinned = /[?&]t=(-?[\\d.]+)/.exec(search);
        var pinP = /[?&]px=([\\d.]+)/.exec(search);
        var pinQ = /[?&]py=([\\d.]+)/.exec(search);
        if (pinned) {
          var pt = parseFloat(pinned[1]);
          if (pinP) {
            var fx = parseFloat(pinP[1]) * W - CX;
            var fy = (pinQ ? parseFloat(pinQ[1]) : 0.5) * H - CY;
            ox = tx = Math.max(-CX, Math.min(CX, fx)) * LEAN;
            oy = ty = Math.max(-CY, Math.min(CY, fy)) * LEAN;
            ripples.push({ x: fx, y: fy, t0: pt - 0.4, amp: 0.5 });
          }
          render(pt);
        } else {
          if (!reduce.matches) {
            window.addEventListener("pointermove", onPointerMove, { passive: true });
          }
          play();
          document.addEventListener("visibilitychange", function () {
            if (document.hidden) stop(); else play();
          });
          if (reduce.addEventListener) reduce.addEventListener("change", onMotionPreferenceChange);
          else if (reduce.addListener) reduce.addListener(onMotionPreferenceChange);
        }

        function onMotionPreferenceChange() {
          stop();
          if (reduce.matches) render(STILL_T);
          else {
            window.addEventListener("pointermove", onPointerMove, { passive: true });
            play();
          }
        }
      })();
    </script>
  </body>
</html>`;
}

function resolveSourceStaticClientRoot(
  moduleUrl: string | URL = import.meta.url,
): string {
  return resolve(dirname(fileURLToPath(moduleUrl.toString())), "../dist/client");
}

function resolveStaticRoot(staticRoot: string | undefined): string {
  const configured = staticRoot?.trim();
  if (configured) {
    return configured;
  }

  const bundled = resolveBundledStaticClientRoot(import.meta.url);
  if (existsSync(resolve(bundled, "index.html"))) {
    return bundled;
  }

  return resolveSourceStaticClientRoot(import.meta.url);
}

type HudRunnerEffortOption = {
  id: string;
  label: string;
  description: string;
  harnesses: string[];
};

function readOpenScoutHostInfoFile(): unknown | null {
  try {
    return JSON.parse(readFileSync(resolveOpenScoutSupportPaths().hostInfoPath, "utf8"));
  } catch {
    return null;
  }
}

function fallbackOpenScoutHostInfo(
  options: CreateOpenScoutWebServerOptions,
  currentDirectory: string,
) {
  const webUrl = options.publicOrigin
    ?? (options.webPort ? `http://127.0.0.1:${options.webPort}` : undefined);
  return {
    schemaVersion: 1,
    source: "openscout-web",
    updatedAtMs: Date.now(),
    currentDirectory,
    brokerUrl: resolveScoutBrokerUrl(),
    ...(webUrl ? { webUrl } : {}),
    ...(options.webPort ? { ports: { web: options.webPort } } : {}),
    advertisedHost: options.advertisedHost,
    portalHost: options.portalHost,
    publicOrigin: options.publicOrigin,
  };
}

export async function createOpenScoutWebServer(
  options: CreateOpenScoutWebServerOptions,
): Promise<OpenScoutWebServer> {
  configureHerdrContinuation(options.herdrContinuation);
  const chatSendLimiter = new ChatSendLimiter();
  const chatPresence = new ChatPresence();
  const shellTtl = options.shellStateCacheTtlMs ?? 15_000;
  const currentDirectory = options.currentDirectory;
  const lanAccessScope = options.lanAccessScope ?? resolveScoutWebLanAccessScope(process.env);

  // Approval-gated LAN pairing: a phone tapping an idle Mac registers a request
  // here; the Mac approves it before pair mode starts and the payload is served.
  // Shared per-Mac, not per-process: the pairing identity is shared by every
  // local instance, so the requests made against it have to be too. See
  // pairing-pair-requests.ts.
  const pendingPairRequests = createPendingPairRequestStore({
    statePath: pairRequestStatePath(localConfigHome()),
  });
  // Always-on discovery beacon so idle Macs still appear in the iOS "On your
  // network" list. Stands down only when the controller has its own LAN advert.
  const lanPairBeacon = options.backgroundServices === false
    ? null
    : startScoutPairLanBeacon(async () => {
        try {
          return (await loadPairingState(currentDirectory, false)).lanDiscoveryAdvertised;
        } catch {
          return false;
        }
      }, { webPort: options.webPort });
  const routes = resolveOpenScoutWebRoutes(process.env);
  if (options.backgroundServices !== false) {
    startGlobalHeuristicsWatcher();
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    const peerAddress = (options.resolvePeerAddress ?? resolveScoutRequestPeerAddress)(c);
    if (!isScoutWebRequestAllowedFromPeer(c.req.raw, peerAddress, lanAccessScope)) {
      return c.text("Not Found", 404);
    }
    await next();
  });

  // `<peer>.scout.local` resolves to this machine's loopback for every LAN
  // browser — each node's mDNS advert says 127.0.0.1. When the host names a
  // roster peer the doorway means "that machine's Scout": proxy to its live
  // route so the name is true everywhere it resolves. Same-Mac only — a LAN
  // client crafting the Host header must not turn this edge into a relay.
  const readPortalMachineRoster = coalesce(
    async () => options.portalMachines
      ? options.portalMachines()
      : (await loadMachines()).machines,
    5_000,
  );
  const resolvePortalPeerUpstream = async (
    requestHost: string,
  ): Promise<ScoutPortalPeerResolution> => {
    const portalHost = options.portalHost?.trim().toLowerCase();
    const nodeHost = options.advertisedHost?.trim().toLowerCase();
    if (
      !portalHost
      || requestHost === portalHost
      || (nodeHost && requestHost === nodeHost)
      || !requestHost.endsWith(`.${portalHost}`)
    ) {
      return null;
    }
    // Reserved service labels are this node's own surfaces, not peer doorways.
    // The check sits ahead of the roster lookup on purpose: a machine that
    // happens to be named `chat` must not be able to shadow `chat.scout.local`
    // by joining the mesh.
    if (isReservedScoutServiceHost(requestHost, portalHost)) return null;
    const machines = await readPortalMachineRoster().catch(() => null);
    if (!machines) return null;
    const machine = machines.find((candidate) =>
      isScoutEnabledMachine(candidate)
      && portalPeerDoorwayHosts(candidate, portalHost).includes(requestHost));
    if (!machine) return null;
    const upstream = portalMachineUpstream(machine, portalHost);
    return upstream
      ? { kind: "proxy", upstream }
      : { kind: "offline", label: machineLabel(machine) };
  };
  app.use("*", async (c, next) => {
    const requestHost = normalizeRequestHost(c.req.header("host"));
    const peerAddress = (options.resolvePeerAddress ?? resolveScoutRequestPeerAddress)(c);
    if (!isSameMacScoutRequest(c.req.raw, peerAddress)) return next();
    const peer = await resolvePortalPeerUpstream(requestHost).catch(() => null);
    if (!peer) return next();
    if (peer.kind === "offline") {
      return c.text(`${peer.label} is not reachable right now.`, 503);
    }
    return proxyScoutPortalPeerRequest(
      c,
      peer.upstream,
      requestHost,
      peerAddress,
      options.portalFetch ?? fetch,
    );
  });
  installHttpsEdgeSecurityHeaders(app, options.publicOrigin);
  const shellStateCache = createCachedSnapshot<OpenScoutWebShellState>(
    loadOpenScoutWebShellState,
    shellTtl,
  );
  const readRunnerOptions = (
    scope: ScoutRuntimeCapabilityCatalog["scope"],
    projectRoot?: string,
    force = false,
  ) => buildHudRunnerOptions(currentDirectory, { scope, projectRoot, force });
  const tailRuntime: WebTailRuntime = {
    getTailDiscovery,
    refreshTailDiscovery,
    readRecentTranscriptEvents,
    snapshotRecentEvents,
    ...options.tailRuntime,
  };
  const scoutbot = await createScoutbotWebServices({
    currentDirectory,
    tailRuntime,
    loadOperatorAttention: (directory) => buildOperatorAttentionState(
      directory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    ),
    loadBuildInfo: loadOpenScoutBuildInfo,
    invokeCodex: options.scoutbotAssistant?.invokeCodex,
    agentAvailable: options.scoutbotAssistant?.agentAvailable,
    scoutbot: options.scoutbot,
  });

  // Credentials for people admitted by a channel invitation. Separate from the
  // operator session authority on purpose: a teammate must never hold the
  // operator's token, and this grant cannot reach beyond the channels they
  // joined.
  // Derived from the host's API token, never equal to it: a member cookie must
  // survive a restart without ever being replayable as an operator credential.
  // With no token configured there is nothing to derive from, and the authority
  // falls back to memory only rather than signing with a guessable key.
  const channelMemberSessions = createChannelMemberSessionAuthority({
    signingSecret: options.authToken ?? null,
    leaseDirectory: join(localConfigHome(), "channel-member-leases"),
  });
  // Two ways to carry the same grant. A browser has the cookie; an HTTP client
  // that joined over the API has a bearer token, because expecting a
  // no-install agent to keep a cookie jar is how the credential gets dropped.
  // Both are validated by signature, so neither can be forged into the other,
  // and an operator bearer arriving here simply fails member validation.
  const readChannelMemberGrant = (request: Request): ChannelMemberGrant | null =>
    channelMemberSessions.validate(cookieValue(request, CHANNEL_MEMBER_COOKIE))
    ?? channelMemberSessions.validate(
      channelMemberBearerToken(request.headers.get("authorization")),
    );

  installScoutApiMiddleware(app, "openscout-web api", {
    trustedHosts: options.trustedHosts,
    trustedOrigins: options.trustedOrigins,
    authToken: options.authToken,
    sessions: options.sessions,
    resolvePeerAddress: options.resolvePeerAddress,
    memberAccess: (request, method, path) => channelMemberMayAccess({
      grant: readChannelMemberGrant(request),
      method,
      path,
    }),
  });

  // Native host requests travel over the broker mesh transport. Resolve only
  // inventory identities, never caller-supplied URLs, and never fall back locally.
  app.use("/api/hosts/:machineId/*", async (c) => {
    const peerAddress = (options.resolvePeerAddress ?? resolveScoutRequestPeerAddress)(c);
    if (!isSameMacScoutRequest(c.req.raw, peerAddress)) return c.json({ error: "Host routing requires this Mac" }, 403);
    const machineId = c.req.param("machineId");
    const machines = await readPortalMachineRoster().catch(() => null);
    const machine = machines?.find((candidate) => candidate.id === machineId);
    if (!machine || machine.isSelf) return c.json({ error: "Destination host is unavailable" }, 404);
    const prefix = `/api/hosts/${encodeURIComponent(machineId)}/`;
    const path = new URL(c.req.url).pathname.slice(prefix.length);
    // This transport belongs to the native launch and read APIs, not arbitrary
    // web pages or nested host forwarding.
    if (!/^api\/(sessions|runner\/options|blobs|flights|comms|conversations|agents|messages|send)(\/|$)/.test(path)) {
      return c.json({ error: "Unsupported destination operation" }, 400);
    }
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && !(method === "POST" && /^(api\/(sessions|blobs|send)|api\/conversations\/[^/]+\/read-cursor)$/.test(path))) {
      return c.json({ error: "Unsupported destination operation" }, 405);
    }
    if (!machine.capabilities.includes("scout-web") || !machine.capabilities.includes("scout-broker")) {
      return c.json({ error: "This host cannot start Scout work" }, 409);
    }
    if (!machine.scoutNodeId || machinePresence(machine) === "offline") return c.json({ error: `${machineLabel(machine)} is not reachable. Your draft has been kept.` }, 503);
    try {
      const result = await (options.hostWebRequest ?? requestScoutHostWeb)({
        nodeId: machine.scoutNodeId, path: `/${path}${new URL(c.req.url).search}`,
        method: method as "GET" | "POST",
        ...(method === "POST" ? { body: await c.req.json() } : {}),
      });
      if (result.binary) {
        c.header("content-type", result.binary.contentType);
        c.header("cache-control", "private, no-store");
        return c.body(Buffer.from(result.binary.data, "base64"), result.status as never);
      }
      return c.json(result.body as never, result.status as never);
    } catch {
      return c.json({ error: `${machineLabel(machine)} could not be reached. Retry when it is available.` }, 502);
    }
  });

  // Server-rendered operator login for browsers that no auto-issuance path
  // covers — a Tailscale or LAN client reaching this host by address or name.
  app.get(SCOUT_WEB_LOGIN_PAGE_PATH, (c) => {
    c.header("cache-control", "no-store");
    return c.html(renderScoutWebLoginPage(routes.bootstrapScriptPath));
  });

  mountScoutDeckSurfaceRoutes(app, {
    currentDirectory,
    hostName: options.advertisedHost?.trim() || "This Mac",
  });

  mountRepoDiffRoutes(app, {
    currentDirectory,
    repoDiffSnapshot: options.repoDiffSnapshot,
    repoPullRequests: options.repoPullRequests,
  });

  mountScoutbotRoutes(app, scoutbot, { currentDirectory });

  app.get(routes.bootstrapScriptPath, (c) =>
    new Response(serializeOpenScoutWebBootstrap(process.env), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    }),
  );
  app.get("/.host-info", (c) => {
    c.header("cache-control", "no-store");
    return c.json(readOpenScoutHostInfoFile() ?? fallbackOpenScoutHostInfo(options, currentDirectory));
  });
  // Basic (npm) or full (installed with `scout web install`, or a source
  // build). Native shells open only the surfaces the served client has.
  const webClient = options.assetMode === "vite-proxy" ? "full" : readWebClientProfile(resolveStaticRoot(options.staticRoot));
  app.get(routes.healthPath, (c) =>
    c.json({
      ok: true,
      surface: "openscout-web",
      webClient,
      currentDirectory,
      brokerUrl: resolveScoutBrokerUrl(),
      advertisedHost: options.advertisedHost,
      portalHost: options.portalHost,
      publicOrigin: options.publicOrigin,
    }),
  );
  app.get("/api/build", async (c) => {
    return c.json(await resolveOpenScoutBuildInfo(currentDirectory, c.req.query("refresh") === "1"));
  });

  mountKnowledgeRoutes(app, { currentDirectory });

  mountFileRoutes(app, { currentDirectory, options });
  app.use("/", async (c, next) => {
    const portalHost = options.portalHost?.trim().toLowerCase();
    const nodeHost = options.advertisedHost?.trim().toLowerCase();
    const requestHost = normalizeRequestHost(c.req.header("host"));
    if (portalHost && nodeHost && requestHost === portalHost && portalHost !== nodeHost) {
      const port = new URL(c.req.url).port;
      const portSuffix = port ? `:${port}` : "";
      const peers = await loadScoutPortalPeers(options, portalHost, portSuffix).catch(() => []);
      return new Response(
        renderScoutLocalPortal({
          requestUrl: c.req.url,
          portalHost,
          nodeHost,
          peers,
        }),
        {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
    }
    return next();
  });
  app.get(routes.terminalRelayHealthPath, async (c) => {
    const ok = await (options.terminalRelayHealthcheck?.() ?? Promise.resolve(false));
    return c.json(
      {
        ok,
        surface: "openscout-terminal-relay",
      },
      ok ? 200 : 503,
    );
  });

  mountAttentionRoutes(app, { currentDirectory, options, shellStateCache });

  mountPairingRoutes(app, { currentDirectory, options, pendingPairRequests, shellStateCache });

  app.get("/api/shell-state", async (c) => c.json(await shellStateCache.get()));
  app.get("/api/shell-state/refresh", async (c) =>
    c.json(await shellStateCache.refresh()),
  );
  // The roster SQL behind /api/agents costs about a second of synchronous
  // event-loop block per read, and several surfaces poll it. A short coalesce
  // per distinct (limit, detail, attention) shape means a polling burst pays
  // for one read; the key space is bounded (limit is clamped to 100) and
  // capped besides. The DB layer stays untouched — this is route-level only.
  // One probe per node per web server, however many viewers are watching. See
  // core/mesh/node-state.ts for why this cache is web-server-owned rather than
  // broker-owned.
  const meshNodeStateStore = createMeshNodeStateStore();

  mountBrokerRoutes(app, { currentDirectory, scoutbot });

  mountFleetRoutes(app);

  mountWorkRoutes(app, { currentDirectory });

  mountMeshOpsRoutes(app);

  mountRoleRoutes(app);

  mountFlightRoutes(app);

  mountConversationRoutes(app, { currentDirectory });

  const { chatServiceHost, channelEventStreams } = mountChatRoutes(app, { options, readChannelMemberGrant, channelMemberSessions, chatPresence, currentDirectory, chatSendLimiter });

  mountSessionRoutes(app, { scoutbot });

  mountMeshRoutes(app, { meshNodeStateStore });

  mountLocalHttpsRoutes(app, { options });

  mountOnboardingRoutes(app, {
    currentDirectory,
  });

  {
    // A packaged build knows its Scout version (and so which full client
    // `scout web install` would put beside it); a source checkout doesn't.
    const bundled = resolveBundledStaticClientRoot(import.meta.url);
    mountSoloProRoutes(app, {
      scoutVersion: existsSync(resolve(bundled, "index.html")) ? readBundledScoutVersion(dirname(bundled)) : null,
      served: {
        profile: webClient,
        root: options.assetMode === "vite-proxy" ? null : resolveStaticRoot(options.staticRoot),
      },
    });
  }

  mountTerminalRoutes(app, { options, routes });

  mountAgentRoutes(app, { currentDirectory, readRunnerOptions, options, shellStateCache, tailRuntime });

  mountScoutbotThreadRoutes(app, { scoutbot, readRunnerOptions, currentDirectory });

  mountBlobRoutes(app, { options });

  mountSendRoutes(app, { currentDirectory, scoutbot });

  const ambientVoice = createAmbientVoiceController({
    startSession: () => createScoutVoiceSession({
      clientId: "openscout-ambient",
      surface: "ambient",
      continuous: true,
    }),
    cancelSession: cancelScoutVoiceSession,
    micBusy: hasActiveScoutVoiceDictation,
    hostSpeaking: isScoutVoiceHostSpeaking,
    respond: async (body) => (await scoutbot.assistant.respond({ body, usageMode: "local" })).reply.body,
    speak: async (text) => {
      await synthesizeScoutSpeech({ text, playback: "host", originAppId: "openscout-ambient" });
    },
    askAgent: async (ask) => {
      const result = await askScoutQuestion({
        senderId: resolveOperatorName().trim() || "operator",
        targetLabel: ask.targetLabel,
        ...(ask.targetAgentId ? { targetAgentId: ask.targetAgentId } : {}),
        body: ask.body,
        ...(ask.channel ? { channel: ask.channel } : {}),
        currentDirectory,
      });
      if (!result.usedBroker) throw new Error("broker unreachable");
      if (result.unresolvedTarget) throw new Error(`could not route ask to ${result.unresolvedTarget}`);
    },
  });
  setScoutVoiceAmbientListener(ambientVoice.listener);

  mountScoutVoiceRoutes(app, {
    ambientVoice,
    usage: scoutbot.usage,
    resolveOpenAIApiKey: scoutbot.resolveOpenAIApiKey,
    readRealtimeVoiceEnabled: async () => (
      await readOpenScoutSettings({ currentDirectory })
    ).voice.realtimeEnabled,
    writeRealtimeVoiceEnabled: async (enabled) => (
      await writeOpenScoutSettings({ voice: { realtimeEnabled: enabled } }, { currentDirectory })
    ).voice.realtimeEnabled,
    realtimeVoiceEnvironment: process.env,
    readVoicePlayback: async () => (
      await readOpenScoutSettings({ currentDirectory })
    ).voice.playback,
    writeVoicePlayback: async (playback) => (
      await writeOpenScoutSettings({ voice: { playback } }, { currentDirectory })
    ).voice.playback,
    voiceEnvironment: process.env,
  });

  // Dev-only: serve generated Scoutbot FX fixtures for /dev/scoutbot-fx lab.
  // Fixtures are produced by packages/web/scripts/generate-scoutbot-fx-fixtures.mjs
  // and live in packages/web/dev/scoutbot-fx-fixtures/ (gitignored).
  if (process.env.NODE_ENV !== "production") {
    const fixturesRoot = join(process.cwd(), "dev", "scoutbot-fx-fixtures");

    app.get("/api/dev/scoutbot-fx/fixtures", (c) => {
      if (!existsSync(fixturesRoot)) {
        return c.json({ fixtures: [], generatedAt: null, available: false });
      }
      const manifestPath = join(fixturesRoot, "manifest.json");
      if (!existsSync(manifestPath)) {
        return c.json({ fixtures: [], generatedAt: null, available: true, note: "manifest missing — re-run the generator script" });
      }
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          generatedAt?: string;
          fixtures?: unknown;
        };
        return c.json({
          available: true,
          generatedAt: parsed.generatedAt ?? null,
          fixtures: Array.isArray(parsed.fixtures) ? parsed.fixtures : [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "manifest read failed";
        return c.json({ error: message }, 500);
      }
    });

    app.get("/api/dev/scoutbot-fx/audio/:name", (c) => {
      const raw = c.req.param("name");
      // Disallow anything that could escape the fixtures dir.
      if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
        return c.json({ error: "invalid fixture name" }, 400);
      }
      if (!/^[a-zA-Z0-9._-]+\.wav$/.test(raw)) {
        return c.json({ error: "invalid fixture name" }, 400);
      }
      const filePath = join(fixturesRoot, raw);
      if (!existsSync(filePath)) {
        return c.json({ error: "fixture not found" }, 404);
      }
      const body = readFileSync(filePath);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "content-length": String(body.length),
          "cache-control": "no-store",
        },
      });
    });
  }

  mountStreamRoutes(app);

  app.all("/api/*", (c) => c.json({ error: `unknown api route: ${c.req.path}` }, 404));

  /**
   * The reserved chat name opens chat, not the operator shell.
   *
   * `chat.<portalHost>` is advertised as this node's chat entry point, so its
   * root has to land on the chat surface; serving the shell there would make
   * the advertised name a lie for everyone who typed it. Only `/` is
   * redirected -- every other path on that host still resolves normally, so an
   * invitation link keeps working on the name it was issued under.
   *
   * It sits ahead of the asset handler because that one answers `/` with the
   * SPA for every host.
   */
  app.get("/", (c, next) => {
    const requestHost = (c.req.header("host") ?? "").split(":")[0]?.trim().toLowerCase() ?? "";
    if (!requestHost || requestHost !== chatServiceHost()) return next();
    return c.redirect("/chat", 302);
  });

  await registerScoutWebAssets(app, {
    assetMode: options.assetMode,
    staticRoot: resolveStaticRoot(options.staticRoot),
    viteDevUrl: options.viteDevUrl,
    defaultViteUrl: "http://127.0.0.1:43122",
  });

  const warmupCaches = () =>
    Promise.allSettled([
      warmOpenScoutBuildInfo(currentDirectory),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          const message =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          console.error(
            "[openscout-web api] initial cache warmup failed:",
            message,
          );
        }
      }
    });

  const stop = async () => {
    ambientVoice.setEnabled(false);
    setScoutVoiceAmbientListener(null);
    await channelEventStreams.stop();
    lanPairBeacon?.stop();
    pendingPairRequests.dispose();
    await scoutbot.stopRunner();
    scoutbot.closeUsage?.();
  };

  const startScoutbotRunner = async () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const runner = await scoutbot.waitForRunner();
      if (!runner || !runner.inert) return;
      await new Promise((resolve) => setTimeout(resolve, 15_000).unref?.());
    }
    console.warn("[scoutbot] runner still inert after 20 attempts; broker DMs will go unanswered");
  };

  return { app, warmupCaches, startScoutbotRunner, stop, resolvePortalPeerUpstream };
}
