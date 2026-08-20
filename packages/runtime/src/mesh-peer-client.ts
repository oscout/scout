import {
  loadOrCreateNodeIdentity,
  verifySignedNodeCard,
  type NodeIdentity,
  type SignedNodeCard,
} from "./node-identity.js";
import { signPeerRequest } from "./mesh-peer-auth.js";
import {
  PeerTlsPinError,
  createPinnedHttpsClient,
  type PinnedHttpsClient,
} from "./mesh-pinned-https-client.js";

/**
 * Mesh trust cone (docs/proposals/mesh-trust-cone.md): the broker's own mesh
 * senders must authenticate with signed requests before the ingress gate can
 * be enforced. This is the shared outbound client for broker→broker HTTP.
 *
 * For each peer base URL it fetches the peer's signed node card from the
 * public `GET /v1/node` endpoint, verifies it, caches the peer key ID with a
 * short TTL, and signs requests destined to that key ID. Peers that present
 * no card (older builds still returning a bare NodeDefinition, 404, or an
 * unreachable probe) are sent unsigned requests — today's behavior — so
 * mixed-version meshes keep working during rollout. A card-shaped payload
 * that fails verification is treated as a potential MITM and refused.
 *
 * P1.5 (§11.4) adds the trust-resolution seam. Callers supply what they expect
 * of a base URL — `expectedPeerKeyId` (from `trusted_peers`, or an mDNS TXT
 * `kid` hint) and `expectedPeerTlsPin` (the durable
 * `trusted_peers.tls_spki_fingerprint`) — and this client enforces it:
 *
 * 1. **Enrolled + pinned** — the card probe *and* the signed request go over
 *    the pinned TLS connector. A `http:` base URL for a pinned peer, or a card
 *    that stops advertising TLS, is a downgrade and is refused.
 * 2. **Card-advertised TLS** — an `https:` peer with no durable pin is pinned
 *    against its own verified card's `tls.spkiFingerprint`, and a later
 *    tls-absent card from that base URL is refused.
 * 3. **Never enrolled, no card TLS** — plain HTTP, today's behavior. §11.8 is
 *    explicit that there is no downgrade defense for a peer never seen over
 *    TLS; the SAS handshake is the mitigation at enrollment.
 *
 * An expected peer never takes the legacy unsigned path, redirects are never
 * followed, and no pin is ever adopted from the wire.
 */

export const MESH_PEER_CARD_PATH = "/v1/node";
export const PEER_CARD_CACHE_TTL_MS = 5 * 60 * 1_000;
export const PEER_CARD_MISS_CACHE_TTL_MS = 60 * 1_000;
export const PEER_CARD_FETCH_TIMEOUT_MS = 2_000;

/** The peer presented a node card but it failed verification; refuse to send. */
export class PeerCardVerificationError extends Error {
  override readonly name = "PeerCardVerificationError";
  constructor(
    message: string,
    readonly baseUrl: string,
  ) {
    super(message);
  }
}

/**
 * §11.4/§11.8: a peer that has presented TLS must never be accepted on plain
 * HTTP, or with a card that has stopped attesting a TLS key, again.
 */
export class PeerTlsDowngradeError extends Error {
  override readonly name = "PeerTlsDowngradeError";
  constructor(
    message: string,
    readonly baseUrl: string,
  ) {
    super(message);
  }
}

export { PeerTlsPinError };

export type MeshPeerFetch = (
  baseUrl: string,
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export type MeshPeerClientDeps = {
  /** defaults to loadOrCreateNodeIdentity on the standard support path, lazily */
  loadIdentity?: () => NodeIdentity;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cardCacheTtlMs?: number;
  cardMissCacheTtlMs?: number;
  cardFetchTimeoutMs?: number;
  log?: (message: string) => void;
  /**
   * §11.4 trust resolution: the identity keyId this base URL must prove before
   * anything is sent. Supplied by the resolver that owns the `trusted_peers`
   * lookup (or the mDNS TXT `kid`, which is a hint to verify, never identity).
   */
  expectedPeerKeyId?: (baseUrl: string) => string | undefined;
  /**
   * §11.2 durable TLS pin (`trusted_peers.tls_spki_fingerprint`) for this base
   * URL. Sibling of `expectedPeerKeyId`; the same resolver owns both, and it
   * is the only writer of pins.
   */
  expectedPeerTlsPin?: (baseUrl: string) => string | undefined;
  /** injectable pinned connector, stubbed in tests exactly as `fetchImpl` is */
  pinnedClient?: PinnedHttpsClient;
};

type PeerCardCacheEntry =
  | { kind: "card"; keyId: string; tlsSpkiFingerprint?: string; expiresAt: number }
  | { kind: "legacy"; expiresAt: number };

/** What the resolver expects of one base URL for the duration of one call. */
type PeerExpectation = {
  baseUrl: string;
  expectedKeyId?: string;
  durablePin?: string;
  isHttps: boolean;
};

/** The resolved outcome: whom we are talking to, and over which pinned key. */
type PeerResolution = {
  keyId?: string;
  pin?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/**
 * §11.9 correction 1: the router answers `/v1/node` with
 * `{ ...node, card, gateMode }`, so the card lives one level down. Older
 * builds (and the P1 tests) returned the card at the top level. Accept both,
 * otherwise every real peer is misclassified as legacy and sent unsigned.
 */
function unwrapCardEnvelope(body: unknown): unknown {
  if (body && typeof body === "object" && "card" in body) {
    const inner = (body as { card?: unknown }).card;
    if (inner !== undefined && inner !== null) {
      return inner;
    }
  }
  return body;
}

/** A verified SignedNodeCard has these fields; a legacy NodeDefinition does not. */
function isCardShaped(value: unknown): value is SignedNodeCard {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.publicKey === "string"
    && typeof candidate.keyId === "string"
    && typeof candidate.fingerprint === "string"
    && typeof candidate.signature === "string";
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) {
    return undefined;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(present);
  }
  return present[0];
}

export function createMeshPeerFetch(deps: MeshPeerClientDeps = {}): MeshPeerFetch {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cardCacheTtlMs = deps.cardCacheTtlMs ?? PEER_CARD_CACHE_TTL_MS;
  const cardMissCacheTtlMs = deps.cardMissCacheTtlMs ?? PEER_CARD_MISS_CACHE_TTL_MS;
  const cardFetchTimeoutMs = deps.cardFetchTimeoutMs ?? PEER_CARD_FETCH_TIMEOUT_MS;
  const log = deps.log ?? ((message: string) => console.debug(`[openscout-runtime] ${message}`));

  const pinned = deps.pinnedClient ?? createPinnedHttpsClient({ now });

  const cardCache = new Map<string, PeerCardCacheEntry>();
  /**
   * §11.4 rule 2: a base URL that has advertised TLS may not go back to a
   * tls-absent card. The spec scopes this "for the cache TTL", but a card is
   * only ever re-fetched *after* its cache entry expires — so a memory with
   * the same TTL is always already expired at exactly the moment a refreshed
   * card could drop `tls`, and the guard would never fire. It is therefore
   * held for the life of the client: strictly stronger, and what §11.4 rule 1
   * means by "a peer that once presented TLS must never silently revert".
   * Legitimately dropping TLS is a re-enrollment event, not a card refresh.
   */
  const tlsAdvertised = new Map<string, string>();
  const legacyLogged = new Set<string>();
  let identity: NodeIdentity | undefined;

  function localIdentity(): NodeIdentity {
    identity ??= (deps.loadIdentity ?? loadOrCreateNodeIdentity)();
    return identity;
  }

  function noteLegacyPeer(baseUrl: string): void {
    if (legacyLogged.has(baseUrl)) {
      return;
    }
    legacyLogged.add(baseUrl);
    log(`peer ${baseUrl} presents no signed node card; sending unsigned requests (pre-trust-cone build)`);
  }

  /**
   * The legacy unsigned/plaintext path is only for never-seen, pre-trust-cone
   * peers (§11.4 rule 3). An expected peer that presents no card is refused.
   */
  function fallBackToLegacy(expectation: PeerExpectation, why: string): PeerResolution {
    const { baseUrl, expectedKeyId, durablePin } = expectation;
    if (durablePin || tlsAdvertised.has(baseUrl)) {
      // A peer we hold a pin for must never resolve to the unpinned path, not
      // even transiently: an unreachable card probe is a failure, not a
      // discovery that the peer is a pre-trust-cone build.
      cardCache.delete(baseUrl);
      throw new PeerTlsDowngradeError(
        `peer ${baseUrl} is pinned to a TLS key but ${why}; refusing the unpinned path`,
        baseUrl,
      );
    }
    if (expectedKeyId) {
      cardCache.delete(baseUrl);
      throw new PeerCardVerificationError(
        `peer ${baseUrl} is expected to prove key ${expectedKeyId} but ${why}; refusing the legacy unsigned path`,
        baseUrl,
      );
    }
    cardCache.set(baseUrl, { kind: "legacy", expiresAt: now() + cardMissCacheTtlMs });
    noteLegacyPeer(baseUrl);
    return {};
  }

  /**
   * Card probe. A peer we already hold a pin for is probed over the pinned
   * channel. A peer we hold no pin for is probed over an unauthenticated TLS
   * connection when its base URL is `https:` — every mesh certificate is
   * self-signed, so no chain can validate, and the card is authenticated by
   * its signature and keyId rather than by the channel. Whatever pin that card
   * attests then governs every request that follows.
   */
  async function fetchCard(
    expectation: PeerExpectation,
    pin: string | undefined,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const url = `${expectation.baseUrl}${MESH_PEER_CARD_PATH}`;
    const init: RequestInit = {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: combineSignals([callerSignal, AbortSignal.timeout(cardFetchTimeoutMs)]),
    };
    if (!expectation.isHttps) {
      return fetchImpl(url, init);
    }
    if (pin) {
      return pinned.fetch(url, { spkiFingerprint: pin, expectedKeyId: expectation.expectedKeyId }, init);
    }
    return pinned.probeFetch(url, init);
  }

  async function resolvePeer(
    expectation: PeerExpectation,
    callerSignal?: AbortSignal,
  ): Promise<PeerResolution> {
    const { baseUrl, expectedKeyId, durablePin } = expectation;
    const cached = cardCache.get(baseUrl);
    if (cached && cached.expiresAt > now()) {
      if (cached.kind === "legacy") {
        return fallBackToLegacy(expectation, "it presents no signed node card");
      }
      if (expectedKeyId && cached.keyId !== expectedKeyId) {
        cardCache.delete(baseUrl);
        throw new PeerCardVerificationError(
          `peer ${baseUrl} presented a card for key ${cached.keyId} but ${expectedKeyId} was expected; refusing to send`,
          baseUrl,
        );
      }
      return { keyId: cached.keyId, pin: durablePin ?? cached.tlsSpkiFingerprint };
    }

    let response: Response;
    try {
      response = await fetchCard(expectation, durablePin, callerSignal);
    } catch (error) {
      // A pinned probe that fails the pin is a refusal, never a legacy peer.
      if (error instanceof PeerTlsPinError || error instanceof PeerTlsDowngradeError) {
        throw error;
      }
      return fallBackToLegacy(expectation, "its node card could not be fetched");
    }

    if (!response.ok) {
      return fallBackToLegacy(expectation, `its node card endpoint answered ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fallBackToLegacy(expectation, "its node card was not JSON");
    }

    const card = unwrapCardEnvelope(body);
    if (!isCardShaped(card)) {
      return fallBackToLegacy(expectation, "it returned a legacy (non-card) node payload");
    }

    if (!verifySignedNodeCard(card, now())) {
      cardCache.delete(baseUrl);
      throw new PeerCardVerificationError(
        `peer ${baseUrl} presented a node card that failed verification; refusing to send`,
        baseUrl,
      );
    }

    // §11.4: the card's keyId must equal what we expect before anything is sent.
    if (expectedKeyId && card.keyId !== expectedKeyId) {
      cardCache.delete(baseUrl);
      throw new PeerCardVerificationError(
        `peer ${baseUrl} presented a card for key ${card.keyId} but ${expectedKeyId} was expected; refusing to send`,
        baseUrl,
      );
    }

    const cardPin = card.tls?.spkiFingerprint;
    const previouslyAdvertised = tlsAdvertised.get(baseUrl);
    if (durablePin) {
      // §11.2/§11.4: a durable pin is never cleared or silently replaced.
      if (!cardPin) {
        cardCache.delete(baseUrl);
        throw new PeerTlsDowngradeError(
          `peer ${baseUrl} holds a durable TLS pin but its card no longer attests a TLS key; refusing to send`,
          baseUrl,
        );
      }
      if (cardPin !== durablePin) {
        cardCache.delete(baseUrl);
        throw new PeerTlsPinError(
          `peer ${baseUrl} attests TLS key ${cardPin} but ${durablePin} is pinned; a TLS-key change is a deliberate re-enrollment event — revoke and re-enroll this peer`,
          baseUrl,
          durablePin,
          cardPin,
        );
      }
    } else if (!cardPin && previouslyAdvertised) {
      cardCache.delete(baseUrl);
      throw new PeerTlsDowngradeError(
        `peer ${baseUrl} advertised TLS key ${previouslyAdvertised} and now presents a card without one; refusing to send`,
        baseUrl,
      );
    }

    if (cardPin) {
      tlsAdvertised.set(baseUrl, cardPin);
    }

    const expiresAt = Math.min(now() + cardCacheTtlMs, card.expiresAt);
    cardCache.set(baseUrl, {
      kind: "card",
      keyId: card.keyId,
      tlsSpkiFingerprint: cardPin,
      expiresAt,
    });
    return { keyId: card.keyId, pin: durablePin ?? cardPin };
  }

  return async (baseUrl, path, init = {}) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const url = `${normalized}${path}`;
    const method = (init.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const signingPath = parsed.pathname + parsed.search;
    const expectation: PeerExpectation = {
      baseUrl: normalized,
      expectedKeyId: deps.expectedPeerKeyId?.(normalized),
      durablePin: deps.expectedPeerTlsPin?.(normalized),
      isHttps: parsed.protocol === "https:",
    };

    // §11.4 rule 1: a pinned peer is never reachable over plaintext again.
    if (expectation.durablePin && !expectation.isHttps) {
      throw new PeerTlsDowngradeError(
        `peer ${normalized} holds a durable TLS pin; refusing to send over ${parsed.protocol}//`,
        normalized,
      );
    }

    const send = async (resolution: PeerResolution): Promise<Response> => {
      // Redirects must never move a pinned, keyId-bound request to another origin.
      const requestInit: RequestInit = { ...init, redirect: init.redirect ?? "error" };
      if (!resolution.keyId) {
        return fetchImpl(url, requestInit);
      }
      const body = typeof init.body === "string" || Buffer.isBuffer(init.body)
        ? init.body
        : undefined;
      const authHeaders = signPeerRequest(localIdentity(), {
        method,
        path: signingPath,
        body,
        destinationKeyId: resolution.keyId,
      });
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(authHeaders)) {
        headers.set(name, value);
      }
      const signed: RequestInit = { ...requestInit, headers };
      if (resolution.pin && expectation.isHttps) {
        return pinned.fetch(
          url,
          { spkiFingerprint: resolution.pin, expectedKeyId: resolution.keyId },
          signed,
        );
      }
      return fetchImpl(url, signed);
    };

    const resolution = await resolvePeer(expectation, init.signal ?? undefined);
    try {
      return await send(resolution);
    } catch (error) {
      if (!(error instanceof PeerTlsPinError) || !resolution.pin) {
        throw error;
      }
      // §11.4 pin-mismatch recovery: drop the cached card and session, re-fetch
      // the card once over the pinned path, retry once, then fail closed. A
      // genuine mismatch means the TLS *key* changed, which routine renewal
      // never does — so it is handled as a deliberate re-enrollment event and
      // never as a silent pin update from the wire.
      cardCache.delete(normalized);
      pinned.invalidate(new URL(normalized).origin);
      try {
        const recovered = await resolvePeer(expectation, init.signal ?? undefined);
        return await send(recovered);
      } catch (retryError) {
        if (retryError instanceof PeerTlsPinError || retryError instanceof PeerTlsDowngradeError) {
          throw new PeerTlsPinError(
            `peer ${normalized} still does not prove the pinned TLS key after one re-fetch and retry (${retryError.message}); refusing to send — revoke and re-enroll this peer deliberately`,
            normalized,
            resolution.pin,
            error.observedFingerprint,
          );
        }
        throw retryError;
      }
    }
  };
}

/** Shared default client: this node's on-disk identity, global fetch. */
export const meshPeerFetch: MeshPeerFetch = createMeshPeerFetch();
