import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";

import { tlsSpkiFingerprintFromCertificateDer } from "./node-tls-identity.js";

/**
 * Mesh trust cone P1.5 §11.4: the client-side pinned TLS path for peer calls.
 *
 * The pin is SHA-256 of the peer certificate's SubjectPublicKeyInfo DER — not
 * of the certificate — so routine cert re-issuance from a retained key never
 * moves it (§11.7). A connection is only handed to the HTTP client once the
 * served key matches the pin; a mismatch, a missing peer certificate, or any
 * TLS failure is a typed `PeerTlsPinError` and never degrades to plaintext.
 *
 * ## Runtime split (observed, not assumed — §11.4's Bun caveat is real)
 *
 * The deployed broker runs under Bun (`#!/usr/bin/env bun`), so both runtimes
 * are supported and each is validated on the runtime it serves:
 *
 * - **Node** — the §11.4 canonical shape: a `https.Agent` whose
 *   `createConnection` opens `tls.connect`, waits for `secureConnect`, reads
 *   `socket.getPeerCertificate().raw`, checks the pin, and only then hands the
 *   *same* socket to the HTTP client. One connection, no window.
 *
 * - **Bun** — `node:tls` client sockets are non-functional for this purpose:
 *   `getPeerCertificate()` returns `{}` and `getPeerX509Certificate()`
 *   `undefined` on a fully established connection, `getProtocol()` returns
 *   null, no application data flows over the socket, and `node:https` ignores
 *   a custom agent's `createConnection` (ECONNREFUSED). `fetch`'s
 *   `tls.checkServerIdentity` hook is never invoked at all — exactly the
 *   unreliability §11.4 refuses to depend on. What Bun *does* expose is
 *   `Bun.connect`'s TLS socket, whose `getPeerCertificate()` carries a real
 *   `raw` DER, and `fetch`'s `tls.ca`, which strictly enforces the supplied
 *   trust anchor (a server presenting any other certificate is refused).
 *
 *   So the Bun path is §11.4's documented fallback in anchor form: probe the
 *   peer with `Bun.connect`, check the pin against the observed certificate,
 *   then issue the request with that *exact* certificate as the sole trust
 *   anchor. The request handshake is therefore validated against the pinned
 *   key by Bun's TLS stack itself rather than by application code after the
 *   fact — there is no time-of-check/time-of-use window, because a server
 *   that does not hold the pinned private key cannot complete the request
 *   handshake at all.
 *
 * Hostname verification is disabled on both paths: certificates are
 * self-signed with informational SANs and peers are usually reached by IP.
 * The peer's identity is its keyId (verified from the signed card) and its
 * TLS key (this pin) — never a DNS name. Redirects are never followed.
 */

/** Validated connections are cached per {origin, expectedKeyId, pin}. */
export const PINNED_SESSION_TTL_MS = 5 * 60 * 1_000;
export const PINNED_CONNECT_TIMEOUT_MS = 5_000;

/**
 * The peer's served TLS key does not match the pin (or no peer certificate
 * could be obtained). Sibling of `PeerCardVerificationError`: fail closed.
 */
export class PeerTlsPinError extends Error {
  override readonly name = "PeerTlsPinError";
  constructor(
    message: string,
    readonly origin: string,
    readonly expectedFingerprint: string,
    readonly observedFingerprint?: string,
  ) {
    super(message);
  }
}

export type PinnedPeer = {
  /** 64 lowercase hex: SHA-256 of the peer's SubjectPublicKeyInfo DER */
  spkiFingerprint: string;
  /** the identity keyId this channel is bound to; part of the session key */
  expectedKeyId?: string;
};

export type PinnedHttpsClientDeps = {
  now?: () => number;
  sessionTtlMs?: number;
  connectTimeoutMs?: number;
  /** test seam: fires once per TLS handshake that actually reaches the peer */
  onHandshake?: (origin: string) => void;
};

export type PinnedHttpsClient = {
  /** Fetch over a connection whose served TLS key matches `peer.spkiFingerprint`. */
  fetch(url: string, peer: PinnedPeer, init?: RequestInit): Promise<Response>;
  /**
   * Fetch an `https:` URL with chain validation disabled — for the signed node
   * card probe of a peer we hold **no** pin for yet (§11.4 resolution order 2,
   * and the same reasoning that makes pre-pin enrollment safe): the card is
   * authenticated by its Ed25519 signature and its keyId, not by the channel,
   * and every mesh certificate is self-signed so no chain can validate. The
   * pin the card attests then governs every subsequent request, so a MITM that
   * relays a genuine card cannot complete the pinned handshake that follows.
   *
   * Never used for a peer that already has a pin — that peer's card probe goes
   * over `fetch` above.
   */
  probeFetch(url: string, init?: RequestInit): Promise<Response>;
  /** Drop cached sessions for an origin (all pins) — used by pin-mismatch recovery. */
  invalidate(origin: string): void;
  close(): void;
};

const RUNTIME_IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function sessionKey(origin: string, peer: PinnedPeer): string {
  return `${origin}\u0000${peer.expectedKeyId ?? ""}\u0000${peer.spkiFingerprint}`;
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function defaultPort(url: URL): number {
  return url.port ? Number(url.port) : 443;
}

function certificateDerToPem(der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function requestBodyBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(body));
  }
  throw new TypeError("pinned peer requests accept only string/Buffer/TypedArray bodies");
}

export function createPinnedHttpsClient(deps: PinnedHttpsClientDeps = {}): PinnedHttpsClient {
  const now = deps.now ?? (() => Date.now());
  const sessionTtlMs = deps.sessionTtlMs ?? PINNED_SESSION_TTL_MS;
  const connectTimeoutMs = deps.connectTimeoutMs ?? PINNED_CONNECT_TIMEOUT_MS;

  /** Bun path: the verified peer certificate, reused as the trust anchor. */
  const bunSessions = new Map<string, { certificatePem: string; expiresAt: number }>();
  /** Node path: keep-alive agents whose connector enforces the pin. */
  const nodeAgents = new Map<string, { agent: HttpsAgent; expiresAt: number }>();

  function dropSessions(origin: string): void {
    const prefix = `${origin}\u0000`;
    for (const key of [...bunSessions.keys()]) {
      if (key.startsWith(prefix)) {
        bunSessions.delete(key);
      }
    }
    for (const [key, entry] of [...nodeAgents.entries()]) {
      if (key.startsWith(prefix)) {
        entry.agent.destroy();
        nodeAgents.delete(key);
      }
    }
  }

  /**
   * Bun: open a TLS connection and read the peer's certificate DER. The chain
   * is deliberately not validated here (`rejectUnauthorized: false`) — the pin
   * is the authority, and every peer certificate is self-signed.
   */
  async function bunPeerCertificateDer(host: string, port: number, origin: string): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const finish = (result: { der?: Buffer; error?: unknown }): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (result.der) {
          resolve(result.der);
        } else {
          reject(result.error ?? new Error("TLS handshake produced no peer certificate"));
        }
      };
      const timer = setTimeout(
        () => finish({ error: new Error(`TLS handshake to ${origin} timed out after ${connectTimeoutMs}ms`) }),
        connectTimeoutMs,
      );
      Bun.connect({
        hostname: host,
        port,
        tls: { rejectUnauthorized: false },
        socket: {
          open: () => {},
          data: () => {},
          handshake: (socket, _success, _authorizationError) => {
            // `_success`/`_authorizationError` report chain validation, which is
            // always "self signed certificate" here and is not what authorizes
            // the peer. The served key is.
            deps.onHandshake?.(origin);
            let der: Buffer | undefined;
            try {
              const raw = socket.getPeerCertificate()?.raw;
              der = raw ? Buffer.from(raw) : undefined;
            } catch {
              der = undefined;
            }
            socket.end();
            finish(der ? { der } : { error: new Error(`peer ${origin} presented no TLS certificate`) });
          },
          error: (_socket, error) => finish({ error }),
          close: () => finish({ error: new Error(`connection to ${origin} closed before the TLS handshake`) }),
        },
      }).catch((error: unknown) => finish({ error }));
    });
  }

  async function bunAnchorPem(url: URL, peer: PinnedPeer): Promise<string> {
    const origin = originOf(url);
    const key = sessionKey(origin, peer);
    const cached = bunSessions.get(key);
    if (cached && cached.expiresAt > now()) {
      return cached.certificatePem;
    }
    bunSessions.delete(key);

    let der: Buffer;
    try {
      der = await bunPeerCertificateDer(url.hostname, defaultPort(url), origin);
    } catch (error) {
      throw new PeerTlsPinError(
        `pinned TLS connection to ${origin} failed: ${(error as Error).message ?? String(error)}`,
        origin,
        peer.spkiFingerprint,
      );
    }

    const observed = tlsSpkiFingerprintFromCertificateDer(der);
    if (observed !== peer.spkiFingerprint) {
      throw new PeerTlsPinError(
        `peer ${origin} served TLS key ${observed} but ${peer.spkiFingerprint} is pinned; refusing to send`,
        origin,
        peer.spkiFingerprint,
        observed,
      );
    }
    const certificatePem = certificateDerToPem(der);
    bunSessions.set(key, { certificatePem, expiresAt: now() + sessionTtlMs });
    return certificatePem;
  }

  async function bunFetch(url: URL, peer: PinnedPeer, init: RequestInit): Promise<Response> {
    const origin = originOf(url);
    const anchor = await bunAnchorPem(url, peer);
    try {
      return await fetch(url, {
        ...init,
        redirect: init.redirect ?? "error",
        tls: {
          // The pinned certificate is the *only* trust anchor for this request,
          // so Bun's own handshake refuses any server that cannot prove the
          // pinned key. Hostname verification stays off (§11.4).
          ca: anchor,
          checkServerIdentity: () => undefined,
        },
      } satisfies BunFetchRequestInit);
    } catch (error) {
      // A handshake failure here means the peer stopped proving the pinned key
      // between the probe and the request. Drop the session and fail closed.
      dropSessions(origin);
      throw new PeerTlsPinError(
        `pinned request to ${origin} failed against the pinned TLS key: ${(error as Error).message ?? String(error)}`,
        origin,
        peer.spkiFingerprint,
      );
    }
  }

  /**
   * Node: §11.4's canonical connector. `createConnection` opens the TLS socket,
   * checks the pin on `secureConnect`, and only then hands that same socket to
   * the HTTP client — `checkServerIdentity` under `rejectUnauthorized: false`
   * is deliberately not used, because Node may skip it for certificates that
   * fail CA validation, which is every certificate here.
   */
  function nodePinnedAgent(origin: string, peer: PinnedPeer): HttpsAgent {
    const key = sessionKey(origin, peer);
    const cached = nodeAgents.get(key);
    if (cached && cached.expiresAt > now()) {
      return cached.agent;
    }
    cached?.agent.destroy();
    nodeAgents.delete(key);

    const agent = new HttpsAgent({ keepAlive: true, maxSockets: 4 });
    // Returns nothing on purpose: `http.Agent.createSocket` treats a returned
    // socket as immediately ready (`if (newSocket) oncreate(null, newSocket)`),
    // which would hand the connection to the HTTP client *before* the pin is
    // checked and swallow the later refusal. The socket is delivered only
    // through `callback`, after `secureConnect` proves the pinned key.
    const createConnection = (
      options: ConnectionOptions,
      callback: (error: Error | null, socket?: Socket) => void,
    ): void => {
      const socket = tlsConnect({
        ...options,
        servername: undefined,
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
      });
      socket.once("secureConnect", () => {
        deps.onHandshake?.(origin);
        const raw = socket.getPeerCertificate(false)?.raw;
        if (!raw) {
          socket.destroy();
          callback(new PeerTlsPinError(
            `peer ${origin} presented no TLS certificate; refusing to send`,
            origin,
            peer.spkiFingerprint,
          ));
          return;
        }
        const observed = tlsSpkiFingerprintFromCertificateDer(Buffer.from(raw));
        if (observed !== peer.spkiFingerprint) {
          socket.destroy();
          dropSessions(origin);
          callback(new PeerTlsPinError(
            `peer ${origin} served TLS key ${observed} but ${peer.spkiFingerprint} is pinned; refusing to send`,
            origin,
            peer.spkiFingerprint,
            observed,
          ));
          return;
        }
        callback(null, socket);
      });
      socket.once("error", (error: Error) => callback(error));
    };
    (agent as unknown as { createConnection: typeof createConnection }).createConnection = createConnection;
    nodeAgents.set(key, { agent, expiresAt: now() + sessionTtlMs });
    return agent;
  }

  async function nodeFetch(
    url: URL,
    init: RequestInit,
    transport: { agent?: HttpsAgent; rejectUnauthorized?: boolean },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const body = requestBodyBuffer(init.body);
    if (body && !headers.has("content-length")) {
      headers.set("content-length", String(body.byteLength));
    }
    const outgoing: Record<string, string> = {};
    headers.forEach((value, name) => {
      outgoing[name] = value;
    });

    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: url.hostname,
          port: defaultPort(url),
          path: `${url.pathname}${url.search}`,
          method: (init.method ?? "GET").toUpperCase(),
          headers: outgoing,
          agent: transport.agent,
          rejectUnauthorized: transport.rejectUnauthorized ?? false,
          // https.request never follows redirects, which is what §11.4 wants:
          // a redirect must not move a pinned, keyId-bound request elsewhere.
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) {
                  responseHeaders.append(name, item);
                }
              } else if (typeof value === "string") {
                responseHeaders.set(name, value);
              }
            }
            const status = response.statusCode ?? 502;
            resolve(new Response(
              status === 204 || status === 304 ? null : Buffer.concat(chunks),
              { status, statusText: response.statusMessage, headers: responseHeaders },
            ));
          });
        },
      );
      const signal = init.signal ?? undefined;
      const onAbort = (): void => {
        request.destroy(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          request.once("close", () => signal.removeEventListener("abort", onAbort));
        }
      }
      request.once("error", reject);
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }

  return {
    async fetch(url, peer, init = {}) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        throw new PeerTlsPinError(
          `refusing to use the pinned client for non-https URL ${url}`,
          originOf(parsed),
          peer.spkiFingerprint,
        );
      }
      if (!/^[0-9a-f]{64}$/.test(peer.spkiFingerprint)) {
        throw new PeerTlsPinError(
          `malformed TLS pin for ${url}; expected 64 lowercase hex chars`,
          originOf(parsed),
          peer.spkiFingerprint,
        );
      }
      return RUNTIME_IS_BUN
        ? bunFetch(parsed, peer, init)
        : nodeFetch(parsed, init, { agent: nodePinnedAgent(originOf(parsed), peer) });
    },
    async probeFetch(url, init = {}) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        throw new TypeError(`probeFetch is for https URLs only; got ${url}`);
      }
      const probeInit: RequestInit = { ...init, redirect: init.redirect ?? "error" };
      if (!RUNTIME_IS_BUN) {
        return nodeFetch(parsed, probeInit, { rejectUnauthorized: false });
      }
      return fetch(parsed, {
        ...probeInit,
        tls: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
      } satisfies BunFetchRequestInit);
    },
    invalidate(origin) {
      dropSessions(origin);
    },
    close() {
      bunSessions.clear();
      for (const entry of nodeAgents.values()) {
        entry.agent.destroy();
      }
      nodeAgents.clear();
    },
  };
}

/** Shared default connector for the mesh peer client. */
export const pinnedHttpsClient: PinnedHttpsClient = createPinnedHttpsClient();
