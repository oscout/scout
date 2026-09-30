import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";

import { json } from "./broker-http-helpers.js";
import {
  PEER_AUTH_HEADERS,
  verifyPeerRequest,
  type PeerAuthLookup,
  type PeerAuthPrincipal,
  type PeerNonceClaim,
  type PeerRequestHeaders,
} from "./mesh-peer-auth.js";
import {
  grantSatisfiesRouteTier,
  meshRouteTierFor,
} from "./mesh-route-matrix.js";
import type {
  RuntimeGuestAuthPrincipal,
  RuntimeHttpHeaders,
  RuntimeHttpRequestLike,
  RuntimeRequestTransportContext,
  RuntimeTransportKind,
} from "./portable-types.js";

/**
 * Mesh trust cone ingress gate (docs/proposals/mesh-trust-cone.md §4, "Ingress
 * is the server, not the dispatcher"). Runs at the server edge of both the TCP
 * and unix-socket HTTP servers, and covers the /trpc WebSocket upgrade, which
 * bypasses the HTTP router.
 *
 * - unix-socket / genuine loopback (from the socket address, never headers):
 *   trusted local, allow unauthenticated — today's behavior.
 * - remote: `public` routes pass; everything else requires a verified peer
 *   signature, an enrolled non-revoked grant, a fresh nonce, and a grant tier
 *   that satisfies the route matrix tier.
 *
 * Rollout: `verify-warn` (default) performs full verification, logs failures,
 * and allows the request; `enforce` denies. OPENSCOUT_MESH_GATE=enforce.
 */

export type MeshGateMode = "verify-warn" | "enforce";

export const MESH_GATE_MODE_ENV = "OPENSCOUT_MESH_GATE";

/** Bodies are buffered for signature verification; beyond this we cannot verify. */
const MAX_VERIFIABLE_BODY_BYTES = 16 * 1024 * 1024;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function resolveMeshGateMode(env: Record<string, string | undefined>): MeshGateMode {
  return env[MESH_GATE_MODE_ENV] === "enforce" ? "enforce" : "verify-warn";
}

/**
 * Classify a connection from its socket remote address. Unix-socket
 * connections have no remote address; loopback is exactly the loopback
 * literals (Host/forwarding headers are attacker-controlled and never used).
 */
export function classifyMeshTransport(remoteAddress: string | undefined | null): RuntimeTransportKind {
  if (!remoteAddress) {
    return "unix-socket";
  }
  return LOOPBACK_ADDRESSES.has(remoteAddress) ? "loopback" : "remote";
}

export type MeshIngressDecision =
  | { action: "allow"; principal?: PeerAuthPrincipal; guest?: RuntimeGuestAuthPrincipal }
  | { action: "deny"; status: number; reason: string; hard?: true };

/**
 * Guest key lookup (docs/proposals/scout-tailscale.md): only active
 * `guest_grants`, never `trusted_peers`. Guests are checked on the `guest`
 * route tier alone and hold no peer tier.
 */
export type GuestAuthLookup = (keyId: string) =>
  | { publicKey: string; grantId: string }
  | undefined;

/** Guest nonces share the durable claim table under a separate namespace. */
export function guestNonceClaim(base: PeerNonceClaim): PeerNonceClaim {
  return { claim: (keyId, nonce, now) => base.claim(`guest:${keyId}`, nonce, now) };
}

/**
 * Guest-tier decision. Unlike peer tiers this applies on every transport
 * (loopback included) and is never softened by verify-warn: the handler
 * needs a verified principal, and there is no unauthenticated guest mode.
 */
export function evaluateGuestIngress(input: {
  method: string;
  requestTarget: string;
  headers: PeerRequestHeaders;
  body?: Buffer | string;
  destinationKeyId: string;
  bootedAt: number;
  lookupGuest?: GuestAuthLookup;
  nonceClaim: PeerNonceClaim;
  now?: number;
}): MeshIngressDecision {
  const lookupGuest = input.lookupGuest;
  if (!lookupGuest) {
    return { action: "deny", status: 503, reason: "guest access is unavailable on this broker" };
  }
  let grantId: string | undefined;
  const verified = verifyPeerRequest({
    method: input.method,
    path: input.requestTarget,
    body: input.body,
    headers: input.headers,
    destinationKeyId: input.destinationKeyId,
    lookupPeer: (keyId) => {
      const guest = lookupGuest(keyId);
      if (!guest) return undefined;
      grantId = guest.grantId;
      // The tier is a placeholder required by the shared verifier; guest
      // principals never flow into peer tier checks.
      return { publicKey: guest.publicKey, tier: "observe" };
    },
    nonceClaim: guestNonceClaim(input.nonceClaim),
    bootedAt: input.bootedAt,
    now: input.now,
  });
  if (!verified.ok || !grantId) {
    return { action: "deny", status: 401, reason: verified.ok ? "guest grant missing" : verified.reason.replace(/^peer /, "guest ") };
  }
  return { action: "allow", guest: { keyId: verified.principal.keyId, grantId } };
}

export type MeshIngressVerifyInput = {
  transport: RuntimeTransportKind;
  method: string;
  /** pathname only — route tier lookup */
  pathname: string;
  /** path + query exactly as received — covered by the peer signature */
  requestTarget: string;
  headers: PeerRequestHeaders;
  body?: Buffer | string;
  destinationKeyId: string;
  bootedAt: number;
  lookupPeer: PeerAuthLookup;
  lookupGuest?: GuestAuthLookup;
  nonceClaim: PeerNonceClaim;
  now?: number;
};

/** Pure gate decision; transport classification and mode application live outside. */
export function evaluateMeshIngress(input: MeshIngressVerifyInput): MeshIngressDecision {
  const routeTier = meshRouteTierFor(input.method, input.pathname);
  if (routeTier === "guest") {
    return evaluateGuestIngress({ ...input });
  }
  // A known guest key is never a peer and never unauthenticated: it is denied
  // on every other route, on every transport, and verify-warn cannot soften it.
  if (input.headers.peer && input.lookupGuest?.(input.headers.peer)) {
    return { action: "deny", status: 403, reason: "guest keys may only call guest routes", hard: true };
  }
  if (input.transport !== "remote") {
    return { action: "allow" };
  }
  if (routeTier === "public") {
    return { action: "allow" };
  }
  if (routeTier === "local") {
    return { action: "deny", status: 403, reason: "route is local-only" };
  }
  const verified = verifyPeerRequest({
    method: input.method,
    path: input.requestTarget,
    body: input.body,
    headers: input.headers,
    destinationKeyId: input.destinationKeyId,
    lookupPeer: input.lookupPeer,
    nonceClaim: input.nonceClaim,
    bootedAt: input.bootedAt,
    now: input.now,
  });
  if (!verified.ok) {
    return { action: "deny", status: 401, reason: verified.reason };
  }
  if (!grantSatisfiesRouteTier(verified.principal.tier, routeTier)) {
    return {
      action: "deny",
      status: 403,
      reason: `grant tier ${verified.principal.tier} does not satisfy ${routeTier} route`,
    };
  }
  return { action: "allow", principal: verified.principal };
}

export type MeshGateLogger = {
  warn: (message: string, detail?: unknown) => void;
};

/** What the caller should log for one recorded denial, in order. */
export type DenialThrottleAction =
  | { kind: "signature"; suppressed: number }
  | { kind: "aggregate"; suppressedSignatures: number };

const MAX_DENIAL_BUCKETS = 512;
const DENIAL_BUCKET_EXPIRY_MS = 5 * 60_000;
const MAX_DENIAL_LINES_PER_WINDOW = 20;
const MAX_DENIAL_KEY_ID_CHARS = 64;
const MAX_DENIAL_ROUTE_CHARS = 128;

function normalizeDenialKeyId(keyId: string | undefined): string {
  return (keyId ?? "").slice(0, MAX_DENIAL_KEY_ID_CHARS);
}

/** Segments that look like generated ids, not route structure. */
function isIdLikePathSegment(segment: string): boolean {
  if (!segment) {
    return false;
  }
  if (/^\d+$/.test(segment)) {
    return true;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return true;
  }
  return segment.length >= 16 && /\d/.test(segment);
}

function normalizeDenialRoute(method: string, pathname: string): string {
  const collapsed = pathname
    .split("/")
    .map((segment) => (isIdLikePathSegment(segment) ? ":id" : segment))
    .join("/");
  return `${method.toUpperCase()} ${collapsed}`.slice(0, MAX_DENIAL_ROUTE_CHARS);
}

/**
 * Rate-limits repeated gate denials per signature key: the first occurrence
 * logs immediately, repeats are counted silently, and the next denial after
 * the interval emits one rolled-up line carrying the suppressed count. A peer
 * retrying against a broker that will never admit it produces one warn per
 * minute instead of one per request — the broker's stderr log has no rotation.
 *
 * The throttle itself is bounded so a hostile peer cannot grow it by varying
 * the signature: key components are normalized (id-like path segments collapse
 * to `:id`), buckets are LRU-capped and expire after 5 minutes, and at most
 * `MAX_DENIAL_LINES_PER_WINDOW` signature lines may emit per interval across
 * all buckets — first-seen and recurring emissions share the allowance, and
 * whatever arrives after it is spent reports as one aggregate line when the
 * next window opens.
 */
export class DenialThrottle {
  private readonly buckets = new Map<string, { lastEmitAt: number; suppressed: number }>();
  private windowStart = 0;
  private linesThisWindow = 0;
  private overflowSignatures = 0;

  constructor(
    private readonly intervalMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Current bucket count — exposed for tests asserting the bound. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Record one denial and return the lines to emit for it: possibly empty
   * (suppressed), a signature line (first-seen or interval rollup), and/or the
   * per-window aggregate line reporting how many distinct signatures were
   * suppressed entirely during the window that just closed.
   */
  record(input: { keyId?: string | undefined; method: string; pathname: string; reason: string }): DenialThrottleAction[] {
    const now = this.now();
    const actions: DenialThrottleAction[] = [];

    if (now - this.windowStart >= this.intervalMs) {
      if (this.overflowSignatures > 0) {
        actions.push({ kind: "aggregate", suppressedSignatures: this.overflowSignatures });
      }
      this.windowStart = now;
      this.linesThisWindow = 0;
      this.overflowSignatures = 0;
    }

    const key = `${normalizeDenialKeyId(input.keyId)}\u0000${normalizeDenialRoute(input.method, input.pathname)}\u0000${input.reason}`;
    const existing = this.buckets.get(key);
    if (existing && now - existing.lastEmitAt < DENIAL_BUCKET_EXPIRY_MS) {
      if (now - existing.lastEmitAt < this.intervalMs) {
        existing.suppressed += 1;
        this.buckets.delete(key);
        this.buckets.set(key, existing);
        return actions;
      }
      // Interval elapsed: this established signature re-earns its line,
      // carrying the suppressed repeat count — subject to the same per-window
      // line allowance as first-seen emissions.
      const suppressed = existing.suppressed;
      existing.lastEmitAt = now;
      existing.suppressed = 0;
      this.buckets.delete(key);
      this.buckets.set(key, existing);
      if (this.linesThisWindow < MAX_DENIAL_LINES_PER_WINDOW) {
        this.linesThisWindow += 1;
        actions.push({ kind: "signature", suppressed });
      } else {
        this.overflowSignatures += 1;
      }
      return actions;
    }
    if (existing) {
      this.buckets.delete(key);
    }

    // First-seen signature. Expired buckets are swept lazily on insert, then
    // the eldest live bucket is evicted to keep the map bounded.
    this.sweepExpired(now);
    while (this.buckets.size >= MAX_DENIAL_BUCKETS) {
      const eldest = this.buckets.keys().next().value;
      if (eldest === undefined) {
        break;
      }
      this.buckets.delete(eldest);
    }
    this.buckets.set(key, { lastEmitAt: now, suppressed: 0 });

    if (this.linesThisWindow < MAX_DENIAL_LINES_PER_WINDOW) {
      this.linesThisWindow += 1;
      actions.push({ kind: "signature", suppressed: 0 });
    } else {
      this.overflowSignatures += 1;
    }
    return actions;
  }

  private sweepExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastEmitAt >= DENIAL_BUCKET_EXPIRY_MS) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Apply the rollout mode to a decision: `verify-warn` logs the failure at warn
 * level (with keyId/route/reason) and converts the deny into an allow;
 * `enforce` logs and keeps the deny. Repeated denials of the same
 * (keyId, route, reason) signature are throttled by `context.throttle` when
 * provided.
 */
export function applyMeshGateMode(
  decision: MeshIngressDecision,
  context: {
    mode: MeshGateMode;
    method: string;
    pathname: string;
    keyId?: string | undefined;
    logger: MeshGateLogger;
    throttle?: DenialThrottle;
  },
): MeshIngressDecision {
  if (decision.action === "allow") {
    return decision;
  }
  const peer = context.keyId ? ` peer=${context.keyId}` : "";
  const route = `${context.method.toUpperCase()} ${context.pathname}`;
  const actions = context.throttle
    ? context.throttle.record({
      keyId: context.keyId,
      method: context.method,
      pathname: context.pathname,
      reason: decision.reason,
    })
    : [{ kind: "signature" as const, suppressed: 0 }];
  for (const action of actions) {
    if (action.kind === "aggregate") {
      context.logger.warn(
        `[openscout-runtime] mesh gate ${context.mode}: `
          + `… and ${action.suppressedSignatures} more distinct denial signatures suppressed`,
      );
      continue;
    }
    const suffix = action.suppressed > 0
      ? ` (+${action.suppressed} suppressed since last log)`
      : "";
    context.logger.warn(
      context.mode === "verify-warn"
        ? `[openscout-runtime] mesh gate verify-warn: would deny ${route}${peer} — ${decision.reason}${suffix}`
        : `[openscout-runtime] mesh gate enforce: denied ${route}${peer} — ${decision.reason}${suffix}`,
    );
  }
  return context.mode === "verify-warn" && !decision.hard ? { action: "allow" } : decision;
}

export type MeshIngressGateDeps = {
  mode: MeshGateMode;
  destinationKeyId: string;
  /** process boot time; timestamps before it (minus grace) are rejected */
  bootedAt: number;
  lookupPeer: PeerAuthLookup;
  lookupGuest?: GuestAuthLookup;
  nonceClaim: PeerNonceClaim;
  logger?: MeshGateLogger;
  /**
   * §11.6 per-listener enforce: when any non-loopback listener exists, remote
   * requests are always enforce-mode. OPENSCOUT_MESH_GATE cannot soften a live
   * TLS/LAN listener; it remains only for the transitional loopback-only path
   * and tests.
   */
  forceRemoteEnforce?: () => boolean;
};

export type MeshIngressGate = {
  /** Classify the transport for an incoming HTTP request. */
  transportFor(request: IncomingMessage): RuntimeTransportKind;
  /**
   * Gate an HTTP request at server ingress. On allow, `next` receives the
   * request with `transportContext` attached (and, for verified remote
   * requests, the buffered body replayed so the router can re-read it). On
   * enforce-mode deny, the response is written and `next` is not called.
   */
  gateHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    next: (request: RuntimeHttpRequestLike) => void | Promise<void>,
  ): Promise<void>;
  /**
   * Gate a WebSocket upgrade. Returns true to proceed; on enforce-mode deny
   * the socket is answered and destroyed and false is returned.
   */
  gateUpgrade(request: IncomingMessage, socket: Duplex): boolean;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function peerAuthHeadersFrom(headers: RuntimeHttpHeaders): PeerRequestHeaders {
  return {
    peer: headerValue(headers[PEER_AUTH_HEADERS.peer]),
    ts: headerValue(headers[PEER_AUTH_HEADERS.ts]),
    nonce: headerValue(headers[PEER_AUTH_HEADERS.nonce]),
    signature: headerValue(headers[PEER_AUTH_HEADERS.signature]),
  };
}

async function bufferRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.byteLength;
    if (received > MAX_VERIFIABLE_BODY_BYTES) {
      throw new Error("request body too large to verify");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Rebuild a request-like stream that replays the buffered body, so the router
 * can read it exactly as if the gate had never consumed the stream.
 */
function replayBufferedRequest(
  request: IncomingMessage,
  body: Buffer,
  transportContext: RuntimeRequestTransportContext,
): RuntimeHttpRequestLike {
  const stream = Readable.from(body.byteLength > 0 ? [body] : []);
  return Object.assign(stream, {
    method: request.method,
    url: request.url,
    headers: request.headers,
    transportContext,
  }) as unknown as RuntimeHttpRequestLike;
}

export function createMeshIngressGate(deps: MeshIngressGateDeps): MeshIngressGate {
  const logger = deps.logger ?? {
    warn: (message: string, detail?: unknown) =>
      detail === undefined ? console.warn(message) : console.warn(message, detail),
  };
  const denialThrottle = new DenialThrottle();

  function effectiveMode(transport: RuntimeTransportKind): MeshGateMode {
    // §11.6: non-loopback listeners force enforce for remote traffic.
    if (transport === "remote" && deps.forceRemoteEnforce?.()) {
      return "enforce";
    }
    return deps.mode;
  }

  function decide(input: Omit<MeshIngressVerifyInput, "destinationKeyId" | "bootedAt" | "lookupPeer" | "nonceClaim">): MeshIngressDecision {
    return applyMeshGateMode(
      evaluateMeshIngress({
        ...input,
        destinationKeyId: deps.destinationKeyId,
        bootedAt: deps.bootedAt,
        lookupPeer: deps.lookupPeer,
        lookupGuest: deps.lookupGuest,
        nonceClaim: deps.nonceClaim,
      }),
      {
        mode: effectiveMode(input.transport),
        method: input.method,
        pathname: input.pathname,
        keyId: input.headers.peer,
        logger,
        throttle: denialThrottle,
      },
    );
  }

  return {
    transportFor(request: IncomingMessage): RuntimeTransportKind {
      return classifyMeshTransport(request.socket?.remoteAddress);
    },

    async gateHttpRequest(request, response, next) {
      const transport = classifyMeshTransport(request.socket?.remoteAddress);
      const remoteAddress = request.socket?.remoteAddress;
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const headers = peerAuthHeadersFrom(request.headers);
      const routeTier = meshRouteTierFor(method, url.pathname);

      // Guest tier: always verified, on every transport, never verify-warn.
      if (routeTier === "guest") {
        let body: Buffer;
        try {
          body = await bufferRequestBody(request);
        } catch (error) {
          json(response, 413, { error: "payload_too_large", detail: error instanceof Error ? error.message : String(error) });
          return;
        }
        const decision = evaluateGuestIngress({
          method,
          requestTarget: request.url ?? url.pathname,
          headers,
          body,
          destinationKeyId: deps.destinationKeyId,
          bootedAt: deps.bootedAt,
          lookupGuest: deps.lookupGuest,
          nonceClaim: deps.nonceClaim,
        });
        if (decision.action === "deny") {
          logger.warn(`[openscout-runtime] guest gate: denied ${method.toUpperCase()} ${url.pathname} — ${decision.reason}`);
          json(response, decision.status, {
            error: decision.status === 401 ? "unauthorized" : "unavailable",
            detail: decision.reason,
          });
          return;
        }
        await next(replayBufferedRequest(request, body, {
          transport,
          ...(remoteAddress ? { remoteAddress } : {}),
          ...(decision.guest ? { guest: decision.guest } : {}),
        }));
        return;
      }

      if (headers.peer && deps.lookupGuest?.(headers.peer)) {
        request.resume();
        logger.warn(`[openscout-runtime] guest gate: denied ${method.toUpperCase()} ${url.pathname} — guest key on a non-guest route`);
        json(response, 403, { error: "forbidden", detail: "guest keys may only call guest routes" });
        return;
      }

      // Local transports and remote public routes pass through untouched —
      // the router reads the body stream itself, exactly as before the gate.
      if (transport !== "remote" || routeTier === "public") {
        const context: RuntimeRequestTransportContext = {
          transport,
          ...(remoteAddress ? { remoteAddress } : {}),
        };
        (request as RuntimeHttpRequestLike).transportContext = context;
        await next(request as RuntimeHttpRequestLike);
        return;
      }

      if (routeTier === "local") {
        const decision = decide({ transport, method, pathname: url.pathname, requestTarget: request.url ?? url.pathname, headers });
        if (decision.action === "deny") {
          request.resume();
          json(response, decision.status, { error: "forbidden", detail: decision.reason });
          return;
        }
        // verify-warn: logged above, fall through unauthenticated.
        (request as RuntimeHttpRequestLike).transportContext = {
          transport,
          ...(remoteAddress ? { remoteAddress } : {}),
        };
        await next(request as RuntimeHttpRequestLike);
        return;
      }

      // observe/control: buffer the body so the signature can cover its exact
      // bytes, then replay it for the router.
      let body: Buffer;
      try {
        body = await bufferRequestBody(request);
      } catch (error) {
        const decision = applyMeshGateMode(
          { action: "deny", status: 413, reason: error instanceof Error ? error.message : String(error) },
          { mode: effectiveMode(transport), method, pathname: url.pathname, keyId: headers.peer, logger, throttle: denialThrottle },
        );
        if (decision.action === "deny") {
          json(response, decision.status, { error: "payload_too_large", detail: decision.reason });
          return;
        }
        (request as RuntimeHttpRequestLike).transportContext = {
          transport,
          ...(remoteAddress ? { remoteAddress } : {}),
        };
        await next(request as RuntimeHttpRequestLike);
        return;
      }

      const decision = decide({
        transport,
        method,
        pathname: url.pathname,
        requestTarget: request.url ?? url.pathname,
        headers,
        body,
      });
      if (decision.action === "deny") {
        json(response, decision.status, {
          error: decision.status === 401 ? "unauthorized" : "forbidden",
          detail: decision.reason,
        });
        return;
      }
      const context: RuntimeRequestTransportContext = {
        transport,
        ...(remoteAddress ? { remoteAddress } : {}),
        ...(decision.principal ? { peer: decision.principal } : {}),
      };
      await next(replayBufferedRequest(request, body, context));
    },

    gateUpgrade(request, socket) {
      const remoteAddress = (socket as { remoteAddress?: string }).remoteAddress;
      const transport = classifyMeshTransport(remoteAddress);
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const headers = peerAuthHeadersFrom(request.headers);
      const decision: MeshIngressDecision = meshRouteTierFor(method, url.pathname) === "guest"
        ? { action: "deny", status: 403, reason: "guest routes do not upgrade" }
        : decide({
          transport,
          method,
          pathname: url.pathname,
          requestTarget: request.url ?? url.pathname,
          headers,
        });
      if (decision.action === "allow") {
        return true;
      }
      const statusText = decision.status === 401 ? "Unauthorized" : "Forbidden";
      socket.write(
        `HTTP/1.1 ${decision.status} ${statusText}\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n` +
          JSON.stringify({ error: statusText.toLowerCase(), detail: decision.reason }),
      );
      socket.destroy();
      return false;
    },
  };
}
