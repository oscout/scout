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
  | { action: "allow"; principal?: PeerAuthPrincipal }
  | { action: "deny"; status: number; reason: string };

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
  nonceClaim: PeerNonceClaim;
  now?: number;
};

/** Pure gate decision; transport classification and mode application live outside. */
export function evaluateMeshIngress(input: MeshIngressVerifyInput): MeshIngressDecision {
  if (input.transport !== "remote") {
    return { action: "allow" };
  }
  const routeTier = meshRouteTierFor(input.method, input.pathname);
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

/**
 * Apply the rollout mode to a decision: `verify-warn` logs the failure at warn
 * level (with keyId/route/reason) and converts the deny into an allow;
 * `enforce` logs and keeps the deny.
 */
export function applyMeshGateMode(
  decision: MeshIngressDecision,
  context: {
    mode: MeshGateMode;
    method: string;
    pathname: string;
    keyId?: string | undefined;
    logger: MeshGateLogger;
  },
): MeshIngressDecision {
  if (decision.action === "allow") {
    return decision;
  }
  const peer = context.keyId ? ` peer=${context.keyId}` : "";
  const route = `${context.method.toUpperCase()} ${context.pathname}`;
  if (context.mode === "verify-warn") {
    context.logger.warn(
      `[openscout-runtime] mesh gate verify-warn: would deny ${route}${peer} — ${decision.reason}`,
    );
    return { action: "allow" };
  }
  context.logger.warn(
    `[openscout-runtime] mesh gate enforce: denied ${route}${peer} — ${decision.reason}`,
  );
  return decision;
}

export type MeshIngressGateDeps = {
  mode: MeshGateMode;
  destinationKeyId: string;
  /** process boot time; timestamps before it (minus grace) are rejected */
  bootedAt: number;
  lookupPeer: PeerAuthLookup;
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
  const logger = deps.logger ?? { warn: (message: string, detail?: unknown) => console.warn(message, detail) };

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
        nonceClaim: deps.nonceClaim,
      }),
      {
        mode: effectiveMode(input.transport),
        method: input.method,
        pathname: input.pathname,
        keyId: input.headers.peer,
        logger,
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
          { mode: effectiveMode(transport), method, pathname: url.pathname, keyId: headers.peer, logger },
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
      const decision = decide({
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
