import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

import type { Context, Hono } from "hono";
import { getConnInfo, serveStatic } from "hono/bun";

export type ScoutWebAssetMode = "vite-proxy" | "static";

const LOOPBACK_IPV4_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/;
const FINGERPRINTED_ASSET_PATH_PATTERN = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}(?:\.[^/]+)+$/u;
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const SCOUT_WEB_AUTH_COOKIE = "openscout_web_session";

export function resolveScoutWebBindHost(env: NodeJS.ProcessEnv): string {
  const host = env.OPENSCOUT_WEB_HOST?.trim()
    || env.SCOUT_WEB_HOST?.trim()
    || "127.0.0.1";
  const loopback = host === "localhost"
    || host === "::1"
    || LOOPBACK_IPV4_HOST_PATTERN.test(host);
  if (!loopback && env.OPENSCOUT_WEB_ALLOW_LAN?.trim() !== "1") {
    throw new Error(
      `Refusing to bind Scout Web to non-loopback host ${host} without OPENSCOUT_WEB_ALLOW_LAN=1`,
    );
  }
  return host;
}

export type ScoutApiTrustOptions = {
  /**
   * Credential required by privileged HTTP routes. Network identity is never an
   * authorization credential; trusted host/origin/peer checks remain a separate
   * defense-in-depth gate.
   */
  authToken?: string;
  trustedHosts?: string[];
  trustedOrigins?: string[];
  /**
   * Resolve the peer (socket) address of the request. The Host header is
   * client-controlled and cannot be used to prove a request is local; the socket
   * peer address can. Overridable for tests; defaults to the Bun connection info
   * and returns undefined when the peer is unavailable (e.g. the Hono test
   * harness, which has no socket).
   */
  resolvePeerAddress?: (c: Context) => string | undefined;
};

function constantTimeTokenMatch(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function isAuthenticatedScoutRequest(
  request: Request,
  expectedToken: string | undefined,
): boolean {
  const token = expectedToken?.trim();
  if (!token) return false;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;
  return constantTimeTokenMatch(bearer, token)
    || constantTimeTokenMatch(cookieValue(request, SCOUT_WEB_AUTH_COOKIE), token);
}

export function scoutWebAuthCookie(token: string, secure: boolean): string {
  return [
    `${SCOUT_WEB_AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function localInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address);
}

/**
 * Decide whether the bootstrap request came from this Mac.
 *
 * The local Caddy edge reaches Scout Web over loopback and records the browser's
 * address in X-Forwarded-For. A same-Mac browser using `*.scout.local` therefore
 * looks proxied even though it is local. Accept that one-hop shape only when the
 * forwarded address is loopback or one of this machine's own interface
 * addresses. Multi-hop chains and the standardized Forwarded header remain
 * ineligible so a LAN client cannot smuggle a local-looking address through the
 * edge.
 */
export function shouldIssueLocalScoutWebCredential(
  request: Request,
  peerAddress?: string,
  ownAddresses: readonly string[] = localInterfaceAddresses(),
): boolean {
  if (!peerAddress || !isLoopbackScoutAddress(peerAddress)) return false;
  if (request.headers.has("forwarded")) return false;

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return true;
  if (forwardedFor.includes(",")) return false;
  const clientAddress = normalizeIpAddress(forwardedFor);
  if (!clientAddress) return false;
  return isLoopbackScoutAddress(clientAddress)
    || ownAddresses.some((address) => normalizeIpAddress(address) === clientAddress);
}

function normalizeIpAddress(address: string): string | null {
  const normalized = normalizeHostname(address);
  const unmapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return isIP(unmapped) ? unmapped : null;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isTrustedLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "0.0.0.0"
    || normalized === "::1"
    || LOOPBACK_IPV4_HOST_PATTERN.test(normalized);
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return null;
  }
}

function trustedHostSet(options: ScoutApiTrustOptions): Set<string> {
  return new Set(
    (options.trustedHosts ?? [])
      .map(normalizeHostname)
      .filter(Boolean),
  );
}

function trustedOriginSet(options: ScoutApiTrustOptions): Set<string> {
  return new Set(
    (options.trustedOrigins ?? [])
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin)),
  );
}

function isTrustedApiHostname(hostname: string, options: ScoutApiTrustOptions): boolean {
  return isTrustedLoopbackHostname(hostname) || trustedHostSet(options).has(normalizeHostname(hostname));
}

export function isLoopbackScoutAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized === "::1" || normalized === "localhost") {
    return true;
  }
  // Unwrap IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1).
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return LOOPBACK_IPV4_HOST_PATTERN.test(mapped);
}

function defaultPeerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

export function isTrustedScoutApiRequest(
  request: Request,
  options: ScoutApiTrustOptions = {},
  peerAddress?: string,
): boolean {
  const requestUrl = new URL(request.url);
  const hostname = normalizeHostname(requestUrl.hostname);
  const hostIsLoopbackName = isTrustedLoopbackHostname(hostname);
  const hostIsTrustedName = trustedHostSet(options).has(hostname);
  if (!hostIsLoopbackName && !hostIsTrustedName) {
    return false;
  }

  // A request presenting a loopback Host (localhost / 127.x / 0.0.0.0) is only
  // trusted when it actually originates from a loopback peer. Otherwise a LAN
  // client can send `Host: localhost` to a 0.0.0.0-bound port and pass this gate
  // with no Origin / Sec-Fetch-Site headers. The socket peer address is
  // authoritative because the client cannot forge it. When the peer is unknown
  // (the Hono test harness has no socket) we fall back to the header check;
  // production requests always carry a peer address.
  if (hostIsLoopbackName && !hostIsTrustedName) {
    const peer = peerAddress;
    if (peer !== undefined && !isLoopbackScoutAddress(peer)) {
      return false;
    }
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (
        !isTrustedApiHostname(originUrl.hostname, options)
        || (
          originUrl.origin !== requestUrl.origin
          && !trustedOriginSet(options).has(originUrl.origin.toLowerCase())
        )
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") {
    return false;
  }

  return true;
}

/**
 * Whether a WebSocket upgrade may be accepted, given its Origin and the request
 * host. Browsers always send Origin on WS handshakes, so this blocks a malicious
 * page (drive-by) from opening privileged proxy sockets (terminal / tail /
 * events) in the user's browser. Non-browser clients send no Origin and are
 * allowed through — the WS transport itself is not same-origin-protected by the
 * browser, so this is the drive-by defense, not a network-position gate.
 */
export function isTrustedWebSocketOrigin(
  origin: string | null | undefined,
  requestHost: string,
  options: ScoutApiTrustOptions = {},
): boolean {
  if (!origin) {
    return true;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.host.toLowerCase() === requestHost.toLowerCase()) {
    return true;
  }
  return (
    isTrustedApiHostname(originUrl.hostname, options)
    || trustedOriginSet(options).has(originUrl.origin.toLowerCase())
  );
}

export function isAuthorizedScoutWebSocketRequest(
  request: Request,
  expectedToken: string | undefined,
  options: ScoutApiTrustOptions = {},
  peerAddress?: string,
): boolean {
  const url = new URL(request.url);
  return isTrustedScoutApiRequest(request, options, peerAddress)
    && isTrustedWebSocketOrigin(request.headers.get("origin"), url.host, options)
    && isAuthenticatedScoutRequest(request, expectedToken);
}

export function coalesce<T>(fn: () => Promise<T>, ttlMs = 2000): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  let cached: { value: T; expiresAt: number } | null = null;

  return () => {
    if (cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.value);
    }
    if (inflight) {
      return inflight;
    }

    inflight = fn()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        inflight = null;
        return value;
      })
      .catch((error) => {
        inflight = null;
        throw error;
      });

    return inflight;
  };
}

export function createCachedSnapshot<T>(load: () => Promise<T>, ttlMs: number) {
  let inflight: Promise<T> | null = null;
  let cached: { value: T; expiresAt: number } | null = null;

  const refresh = async () => {
    if (inflight) {
      return inflight;
    }

    inflight = load()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        inflight = null;
        return value;
      })
      .catch((error) => {
        inflight = null;
        throw error;
      });

    return inflight;
  };

  const get = async (options?: { force?: boolean }) => {
    const force = options?.force ?? false;
    if (!force && cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }

    if (!force && cached && inflight) {
      return cached.value;
    }

    if (!force && inflight) {
      return inflight;
    }

    return refresh();
  };

  const invalidate = () => {
    cached = null;
  };

  return {
    get,
    refresh,
    invalidate,
    peek: () => cached?.value ?? null,
  };
}

export function installScoutApiMiddleware(
  app: Hono,
  label = "api",
  options: ScoutApiTrustOptions = {},
): void {
  app.use("/api/*", async (c, next) => {
    const peerAddress = (options.resolvePeerAddress ?? defaultPeerAddress)(c);
    if (!isTrustedScoutApiRequest(c.req.raw, options, peerAddress)) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (options.authToken !== undefined && !isAuthenticatedScoutRequest(c.req.raw, options.authToken)) {
      c.header("WWW-Authenticate", 'Bearer realm="OpenScout Web"');
      return c.json({ error: "unauthorized" }, 401);
    }

    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");

    try {
      await next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${label}] ${c.req.method} ${c.req.path} failed:`, message);
      return c.json({ error: message }, 500);
    }
  });
}

export async function registerScoutWebAssets(
  app: Hono,
  options: {
    assetMode: ScoutWebAssetMode;
    staticRoot: string;
    viteDevUrl?: string;
    defaultViteUrl: string;
  },
): Promise<void> {
  const viteUrl = options.viteDevUrl?.trim() || options.defaultViteUrl;

  if (options.assetMode === "vite-proxy") {
    app.all("/*", async (c) => {
      const target = new URL(c.req.path, viteUrl);
      target.search = new URL(c.req.url).search;
      const headers = new Headers(c.req.header());
      headers.delete("host");
      try {
        const response = await fetch(target.toString(), {
          method: c.req.method,
          headers,
          body:
            c.req.method !== "GET" && c.req.method !== "HEAD"
              ? c.req.raw.body
              : undefined,
        });
        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[openscout-web] vite proxy failed for ${target.toString()}: ${message}`);
        return c.text("Vite dev server unavailable", 502);
      }
    });
    return;
  }

  app.use("/*", serveStatic({
    root: options.staticRoot,
    onFound: (path, c) => {
      if (FINGERPRINTED_ASSET_PATH_PATTERN.test(c.req.path)) {
        c.header("cache-control", IMMUTABLE_ASSET_CACHE_CONTROL);
      } else if (path.endsWith(".html")) {
        c.header("cache-control", "no-store");
      }
    },
  }));
  app.get("/assets/*", (c) => c.notFound());
  app.get("/*", serveStatic({
    root: options.staticRoot,
    path: "index.html",
    onFound: (_path, c) => {
      c.header("cache-control", "no-store");
    },
  }));
}

export async function relayEventStream(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const requestHeaders = new Headers(init?.headers);
  if (!requestHeaders.has("accept")) {
    requestHeaders.set("accept", "text/event-stream");
  }

  const upstream = await fetch(url, {
    ...init,
    headers: requestHeaders,
  });

  if (!upstream.ok || !upstream.body) {
    const contentType = upstream.headers.get("content-type") ?? "text/plain; charset=utf-8";
    const message = await upstream.text().catch(() => "Event stream unavailable");
    return new Response(message || "Event stream unavailable", {
      status: upstream.status || 502,
      statusText: upstream.statusText,
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache, no-transform",
      },
    });
  }

  const responseHeaders = new Headers();
  responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  responseHeaders.set("cache-control", upstream.headers.get("cache-control") ?? "no-cache, no-transform");
  responseHeaders.set("connection", "keep-alive");
  responseHeaders.set("x-accel-buffering", "no");

  const reader = upstream.body.getReader();
  const clientSignal = init?.signal;
  const abortUpstream = () => {
    void reader.cancel().catch(() => {});
  };
  clientSignal?.addEventListener("abort", abortUpstream, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              controller.enqueue(value);
            }
          }
          controller.close();
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            controller.close();
            return;
          }
          controller.error(error);
        } finally {
          clientSignal?.removeEventListener("abort", abortUpstream);
          try {
            reader.releaseLock();
          } catch {
            // Reader may already be released after cancellation.
          }
        }
      };

      void pump();
    },
    cancel(reason) {
      clientSignal?.removeEventListener("abort", abortUpstream);
      return reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
