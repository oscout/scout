import { mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createBrokerHttpRouter,
  type BrokerHttpRouterDeps,
} from "./broker-http-router.js";
import {
  PEER_AUTH_HEADERS,
  PeerNonceCache,
  sha256Hex,
  peerRequestSigningPayload,
  verifyPeerRequest,
} from "./mesh-peer-auth.js";
import {
  PeerCardVerificationError,
  PeerTlsDowngradeError,
  PeerTlsPinError,
  createMeshPeerFetch,
  type MeshPeerClientDeps,
} from "./mesh-peer-client.js";
import {
  createPinnedHttpsClient,
  type PinnedHttpsClient,
  type PinnedPeer,
} from "./mesh-pinned-https-client.js";
import {
  buildSignedNodeCard,
  loadOrCreateNodeIdentity,
  nodeKeyId,
  verifyNodeSignature,
  type NodeIdentity,
  type SignedNodeCard,
} from "./node-identity.js";
import { loadOrCreateTlsIdentity, type NodeTlsIdentity } from "./node-tls-identity.js";

const servers = new Set<ReturnType<typeof Bun.serve>>();

afterEach(() => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.clear();
});

function freshIdentity(): NodeIdentity {
  return loadOrCreateNodeIdentity(mkdtempSync(join(tmpdir(), "openscout-peer-client-test-")));
}

function peerCard(identity: NodeIdentity, now?: number, tls?: { spkiFingerprint: string }): SignedNodeCard {
  return buildSignedNodeCard(identity, {
    nodeId: "peer-node",
    label: "Peer",
    version: "0.0.0-test",
    capabilities: ["broker"],
    endpoints: [],
    tls,
  }, now);
}

/**
 * §11.1 specifies Ed25519 TLS keys, but Bun's TLS stack cannot serve or verify
 * an Ed25519 leaf certificate, so the live-TLS fixtures here are `ec-p256`.
 * See `mesh-pinned-https-client.test.ts` for the full note.
 */
async function freshTlsIdentity(): Promise<NodeTlsIdentity> {
  return loadOrCreateTlsIdentity(
    mkdtempSync(join(tmpdir(), "openscout-peer-client-tls-test-")),
    { algorithm: "ec-p256" },
  );
}

type CapturedRequest = {
  method: string;
  path: string;
  headers: Headers;
  body: string;
};

/** Minimal ServerResponse stand-in for driving the real router in-process. */
class FakeRouterResponse extends EventEmitter {
  body = "";
  status: number | undefined;

  writeHead(status: number): void {
    this.status = status;
  }

  write(chunk: string): void {
    this.body += chunk;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
  }
}

function startPeerServer(input: {
  card?: SignedNodeCard | unknown;
  cardStatus?: number;
  onCardRequest?: () => void;
  postResponse?: Response;
}): { baseUrl: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/node") {
        input.onCardRequest?.();
        if (input.cardStatus && input.cardStatus !== 200) {
          return new Response(null, { status: input.cardStatus });
        }
        // The real broker envelope (broker-http-router.ts GET /v1/node):
        // node fields with the signed card nested under `card`, plus gateMode.
        return Response.json({
          id: "peer-node",
          meshId: "openscout",
          name: "Peer",
          card: input.card ?? null,
          gateMode: "verify-warn",
        });
      }
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers,
        body: await request.text(),
      });
      return input.postResponse ?? Response.json({ ok: true });
    },
  });
  servers.add(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, requests };
}

/** Same shape as `startPeerServer`, but behind a real TLS listener. */
function startTlsPeerServer(input: {
  tlsIdentity: NodeTlsIdentity;
  /** static card, or a provider when the test rotates it mid-run */
  card?: SignedNodeCard | unknown | (() => unknown);
  cardStatus?: number;
  onCardRequest?: () => void;
}): { baseUrl: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    tls: {
      key: input.tlsIdentity.keyPair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      cert: input.tlsIdentity.certificatePem,
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/node") {
        input.onCardRequest?.();
        if (input.cardStatus && input.cardStatus !== 200) {
          return new Response(null, { status: input.cardStatus });
        }
        const card = typeof input.card === "function"
          ? (input.card as () => unknown)()
          : input.card;
        return Response.json(card ?? null);
      }
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers,
        body: await request.text(),
      });
      return Response.json({ ok: true });
    },
  });
  servers.add(server);
  return { baseUrl: `https://127.0.0.1:${server.port}`, requests };
}

function makeClient(local: NodeIdentity, deps: Partial<MeshPeerClientDeps> = {}) {
  return createMeshPeerFetch({ loadIdentity: () => local, ...deps });
}

/** A counting `fetchImpl` that proves nothing was ever put on the wire. */
function countingFetch(): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    impl: ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return fetch(input as RequestInfo, init);
    }) as typeof fetch,
  };
}

function postJson(client: ReturnType<typeof makeClient>, baseUrl: string, path: string, payload: unknown) {
  return client(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
}

describe("mesh peer client", () => {
  test("signs the request when the peer presents a valid node card", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const card = peerCard(peer);
    const { baseUrl, requests } = startPeerServer({ card });

    const response = await postJson(makeClient(local), baseUrl, "/v1/mesh/messages", { hello: "mesh" });

    expect(response.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const received = requests[0]!;
    expect(received.method).toBe("POST");
    expect(received.path).toBe("/v1/mesh/messages");

    const signature = received.headers.get(PEER_AUTH_HEADERS.signature);
    const ts = received.headers.get(PEER_AUTH_HEADERS.ts);
    const nonce = received.headers.get(PEER_AUTH_HEADERS.nonce);
    expect(received.headers.get(PEER_AUTH_HEADERS.peer)).toBe(nodeKeyId(local.publicKey));
    expect(signature).toBeTruthy();
    expect(ts).toBeTruthy();
    expect(nonce).toBeTruthy();

    // Signature verifies against the sender's public key with the peer's key
    // ID bound as the destination.
    const payload = peerRequestSigningPayload({
      method: "POST",
      path: "/v1/mesh/messages",
      bodySha256Hex: sha256Hex(received.body),
      destinationKeyId: card.keyId,
      ts: Number(ts),
      nonce: nonce!,
    });
    expect(verifyNodeSignature(local.publicKey, payload, signature!)).toBe(true);

    // End-to-end through the ingress verifier: accepted for the addressed
    // peer, rejected when verified under a different destination.
    const base = {
      method: "POST",
      path: "/v1/mesh/messages",
      body: received.body,
      headers: {
        peer: received.headers.get(PEER_AUTH_HEADERS.peer) ?? undefined,
        ts: ts ?? undefined,
        nonce: nonce ?? undefined,
        signature: signature ?? undefined,
      },
      lookupPeer: () => ({ publicKey: local.publicKey, tier: "control" as const }),
      nonceClaim: new PeerNonceCache(),
      bootedAt: Date.now() - 60_000,
    };
    expect(verifyPeerRequest({ ...base, destinationKeyId: card.keyId })).toEqual({
      ok: true,
      principal: { keyId: nodeKeyId(local.publicKey), tier: "control" },
    });
    const wrongDestination = verifyPeerRequest({ ...base, destinationKeyId: "f".repeat(64) });
    expect(wrongDestination.ok).toBe(false);
  });

  test("sends unsigned when the peer has no card endpoint (404), logging once per peer", async () => {
    const local = freshIdentity();
    const logs: string[] = [];
    let cardProbes = 0;
    const { baseUrl, requests } = startPeerServer({
      cardStatus: 404,
      onCardRequest: () => { cardProbes += 1; },
    });
    const client = makeClient(local, { log: (message) => logs.push(message) });

    await postJson(client, baseUrl, "/v1/mesh/messages", { n: 1 });
    await postJson(client, baseUrl, "/v1/mesh/messages", { n: 2 });

    expect(requests).toHaveLength(2);
    for (const received of requests) {
      expect(received.headers.get(PEER_AUTH_HEADERS.signature)).toBeNull();
      expect(received.headers.get(PEER_AUTH_HEADERS.peer)).toBeNull();
    }
    // The miss is cached: one probe, one debug log, across both requests.
    expect(cardProbes).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("unsigned");
  });

  test("sends unsigned when the peer returns a legacy (non-card) node payload", async () => {
    const local = freshIdentity();
    // No `card` field in the envelope at all — a pre-trust-cone build.
    const { baseUrl, requests } = startPeerServer({});

    await postJson(makeClient(local, { log: () => {} }), baseUrl, "/v1/snapshot", {});

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get(PEER_AUTH_HEADERS.signature)).toBeNull();
  });

  test("caches the verified peer key ID until the TTL elapses", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    let clock = 1_700_000_000_000;
    const card = peerCard(peer, clock);
    let cardProbes = 0;
    const { baseUrl, requests } = startPeerServer({
      card,
      onCardRequest: () => { cardProbes += 1; },
    });
    const client = makeClient(local, {
      now: () => clock,
      cardCacheTtlMs: 5 * 60 * 1_000,
    });

    await postJson(client, baseUrl, "/v1/mesh/messages", { n: 1 });
    await postJson(client, baseUrl, "/v1/mesh/messages", { n: 2 });
    expect(cardProbes).toBe(1);
    expect(requests.every((request) => request.headers.get(PEER_AUTH_HEADERS.signature))).toBe(true);

    clock += 5 * 60 * 1_000 + 1;
    await postJson(client, baseUrl, "/v1/mesh/messages", { n: 3 });
    expect(cardProbes).toBe(2);
    expect(requests).toHaveLength(3);
  });

  test("refuses to send when the peer card fails verification", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tampered = { ...peerCard(peer), label: "forged-label" };
    const { baseUrl, requests } = startPeerServer({ card: tampered });

    await expect(
      postJson(makeClient(local), baseUrl, "/v1/mesh/messages", { hello: "mesh" }),
    ).rejects.toBeInstanceOf(PeerCardVerificationError);
    expect(requests).toHaveLength(0);
  });

  test("reads the card out of the router's { ...node, card } envelope", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const card = peerCard(peer);
    // §11.9 correction 1: the real router answers with the node definition
    // plus a nested card, not a top-level card (startPeerServer serves that
    // envelope; the router-level regression test below proves the shape).
    const { baseUrl, requests } = startPeerServer({ card });

    await postJson(makeClient(local), baseUrl, "/v1/mesh/messages", { hello: "mesh" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get(PEER_AUTH_HEADERS.peer)).toBe(nodeKeyId(local.publicKey));
  });
  test("still accepts a hypothetical bare top-level card body", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const card = peerCard(peer);
    const sent: Headers[] = [];
    const client = createMeshPeerFetch({
      loadIdentity: () => local,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (new URL(url).pathname === "/v1/node") {
          return Response.json(card);
        }
        sent.push(new Headers(init?.headers));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });

    const response = await client("http://peer.test", "/v1/mesh/messages", {
      method: "POST",
      body: JSON.stringify({ hello: "mesh" }),
    });

    expect(response.ok).toBe(true);
    expect(sent[0]!.get(PEER_AUTH_HEADERS.signature)).toBeTruthy();
  });

  describe("expectedPeerKeyId pinning (enrolled peers)", () => {
    test("signs when the presented card key ID matches the pinned key ID", async () => {
      const local = freshIdentity();
      const peer = freshIdentity();
      const card = peerCard(peer);
      const { baseUrl, requests } = startPeerServer({ card });
      const client = makeClient(local, { expectedPeerKeyId: () => card.keyId });

      await postJson(client, baseUrl, "/v1/mesh/messages", { hello: "mesh" });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get(PEER_AUTH_HEADERS.signature)).toBeTruthy();
    });

    test("throws when the presented card key ID does not match the pin", async () => {
      const local = freshIdentity();
      const peer = freshIdentity();
      const { baseUrl, requests } = startPeerServer({ card: peerCard(peer) });
      const client = makeClient(local, { expectedPeerKeyId: () => "f".repeat(64) });

      await expect(
        postJson(client, baseUrl, "/v1/mesh/messages", { hello: "mesh" }),
      ).rejects.toBeInstanceOf(PeerCardVerificationError);
      expect(requests).toHaveLength(0);
    });

    test("throws instead of sending unsigned when a pinned peer presents no card", async () => {
      const local = freshIdentity();
      const { baseUrl, requests } = startPeerServer({});
      const client = makeClient(local, {
        expectedPeerKeyId: () => "f".repeat(64),
        log: () => {},
      });

      await expect(
        postJson(client, baseUrl, "/v1/mesh/messages", { hello: "mesh" }),
      ).rejects.toBeInstanceOf(PeerCardVerificationError);
      expect(requests).toHaveLength(0);
    });

    test("throws instead of sending unsigned when a pinned peer's card probe fails", async () => {
      const local = freshIdentity();
      const { baseUrl, requests } = startPeerServer({ cardStatus: 404 });
      const client = makeClient(local, {
        expectedPeerKeyId: () => "f".repeat(64),
        log: () => {},
      });

      await expect(
        postJson(client, baseUrl, "/v1/mesh/messages", { hello: "mesh" }),
      ).rejects.toBeInstanceOf(PeerCardVerificationError);
      expect(requests).toHaveLength(0);
    });
  });

  test("parses the real broker router's GET /v1/node envelope (nested card regression)", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const card = peerCard(peer);
    const node = {
      id: "peer-node",
      meshId: "openscout",
      name: "Peer",
      endpoints: [],
      lastSeenAt: 1,
    };
    // The real router handler, with only the deps GET /v1/node touches.
    const routed = createBrokerHttpRouter({
      host: "127.0.0.1",
      port: 43110,
      nodeId: "peer-node",
      meshId: "openscout",
      operatorActorId: "operator",
      brokerService: { readNode: async () => node },
      meshTrust: {
        enrollment: {},
        rateLimiter: {},
        nodeCard: () => card,
        gateMode: () => "verify-warn",
        persistGrant: () => true,
        peers: null,
      },
    } as unknown as BrokerHttpRouterDeps);

    const request = new PassThrough() as PassThrough & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    request.headers = { host: "peer.test" };
    request.method = "GET";
    request.url = "/v1/node";
    const response = new FakeRouterResponse();
    const settled = routed(request as never, response as never);
    request.end();
    await settled;

    expect(response.status).toBe(200);
    const envelope = JSON.parse(response.body) as Record<string, unknown>;
    // The regression: the card rides nested under `card`, never top-level.
    expect(envelope.card).toMatchObject({ keyId: card.keyId });
    expect(envelope.publicKey).toBeUndefined();

    // Feed the router's actual JSON through the client's parse path: a real
    // peer must be classified as carded (signed), not legacy.
    const sent: Headers[] = [];
    const client = createMeshPeerFetch({
      loadIdentity: () => local,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (new URL(url).pathname === "/v1/node") {
          return new Response(response.body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        sent.push(new Headers(init?.headers));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });

    const result = await client("http://peer.test", "/v1/mesh/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "mesh" }),
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const headers = sent[0]!;
    expect(headers.get(PEER_AUTH_HEADERS.peer)).toBe(nodeKeyId(local.publicKey));
    const signature = headers.get(PEER_AUTH_HEADERS.signature);
    expect(signature).toBeTruthy();
    const payload = peerRequestSigningPayload({
      method: "POST",
      path: "/v1/mesh/messages",
      bodySha256Hex: sha256Hex(JSON.stringify({ hello: "mesh" })),
      destinationKeyId: card.keyId,
      ts: Number(headers.get(PEER_AUTH_HEADERS.ts)),
      nonce: headers.get(PEER_AUTH_HEADERS.nonce)!,
    });
    expect(verifyNodeSignature(local.publicKey, payload, signature!)).toBe(true);
  });
});
describe("mesh peer client — pinned TLS (§11.4)", () => {
  test("pins the card probe and the signed request for an enrolled, pinned peer", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tls = await freshTlsIdentity();
    const card = peerCard(peer, undefined, { spkiFingerprint: tls.spkiFingerprint });
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: tls, card });

    const response = await postJson(
      makeClient(local, {
        expectedPeerKeyId: () => card.keyId,
        expectedPeerTlsPin: () => tls.spkiFingerprint,
      }),
      baseUrl,
      "/v1/mesh/messages",
      { hello: "mesh" },
    );

    expect(response.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const received = requests[0]!;
    expect(received.headers.get(PEER_AUTH_HEADERS.peer)).toBe(nodeKeyId(local.publicKey));
    const signature = received.headers.get(PEER_AUTH_HEADERS.signature);
    expect(signature).toBeTruthy();
    const payload = peerRequestSigningPayload({
      method: "POST",
      path: "/v1/mesh/messages",
      bodySha256Hex: sha256Hex(received.body),
      destinationKeyId: card.keyId,
      ts: Number(received.headers.get(PEER_AUTH_HEADERS.ts)),
      nonce: received.headers.get(PEER_AUTH_HEADERS.nonce)!,
    });
    expect(verifyNodeSignature(local.publicKey, payload, signature!)).toBe(true);
  });

  test("refuses a pinned peer reached over plain http, without touching the network", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tls = await freshTlsIdentity();
    const { baseUrl, requests } = startPeerServer({
      card: peerCard(peer, undefined, { spkiFingerprint: tls.spkiFingerprint }),
    });
    const spy = countingFetch();

    await expect(
      postJson(
        makeClient(local, {
          fetchImpl: spy.impl,
          expectedPeerTlsPin: () => tls.spkiFingerprint,
        }),
        baseUrl,
        "/v1/mesh/messages",
        { hello: "mesh" },
      ),
    ).rejects.toBeInstanceOf(PeerTlsDowngradeError);
    // Not even the card probe goes out over plaintext for a pinned peer.
    expect(spy.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("refuses a pinned peer whose card stops attesting a TLS key", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tls = await freshTlsIdentity();
    // Card is valid and signed, but tls-absent — §11.2's never-clear rule means
    // the durable pin stands and this is a downgrade.
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: tls, card: peerCard(peer) });

    await expect(
      postJson(
        makeClient(local, {
          expectedPeerKeyId: () => nodeKeyId(peer.publicKey),
          expectedPeerTlsPin: () => tls.spkiFingerprint,
        }),
        baseUrl,
        "/v1/mesh/messages",
        { hello: "mesh" },
      ),
    ).rejects.toBeInstanceOf(PeerTlsDowngradeError);
    expect(requests).toHaveLength(0);
  });

  test("refuses when the card's keyId is not the expected keyId over the pinned channel", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tls = await freshTlsIdentity();
    const card = peerCard(peer, undefined, { spkiFingerprint: tls.spkiFingerprint });
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: tls, card });

    let thrown: unknown;
    try {
      await postJson(
        makeClient(local, {
          expectedPeerKeyId: () => "b".repeat(64),
          expectedPeerTlsPin: () => tls.spkiFingerprint,
        }),
        baseUrl,
        "/v1/mesh/messages",
        { hello: "mesh" },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PeerCardVerificationError);
    expect((thrown as Error).message).toContain(card.keyId);
    expect(requests).toHaveLength(0);
  });

  test("refuses when the peer serves a TLS key other than the durable pin", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const served = await freshTlsIdentity();
    const pinned = await freshTlsIdentity();
    // The card attests the pinned key, but the listener serves a different one.
    const card = peerCard(peer, undefined, { spkiFingerprint: pinned.spkiFingerprint });
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: served, card });

    await expect(
      postJson(
        makeClient(local, {
          expectedPeerKeyId: () => card.keyId,
          expectedPeerTlsPin: () => pinned.spkiFingerprint,
        }),
        baseUrl,
        "/v1/mesh/messages",
        { hello: "mesh" },
      ),
    ).rejects.toBeInstanceOf(PeerTlsPinError);
    expect(requests).toHaveLength(0);
  });

  test("pins an https peer against its own card when there is no durable pin", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tls = await freshTlsIdentity();
    const card = peerCard(peer, undefined, { spkiFingerprint: tls.spkiFingerprint });
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: tls, card });

    const response = await postJson(makeClient(local), baseUrl, "/v1/mesh/messages", { n: 1 });

    expect(response.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get(PEER_AUTH_HEADERS.signature)).toBeTruthy();
  });

  test("refuses when a card-advertised fingerprint is not the key the peer serves", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const served = await freshTlsIdentity();
    const attested = await freshTlsIdentity();
    // No durable pin: the pin comes from the card, and the card's attestation
    // must still match what the listener proves.
    const card = peerCard(peer, undefined, { spkiFingerprint: attested.spkiFingerprint });
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: served, card });

    await expect(
      postJson(makeClient(local), baseUrl, "/v1/mesh/messages", { n: 1 }),
    ).rejects.toBeInstanceOf(PeerTlsPinError);
    expect(requests).toHaveLength(0);
  });

  test("refuses a card that drops TLS after previously advertising it", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tls = await freshTlsIdentity();
    let clock = 1_700_000_000_000;
    let card: SignedNodeCard = peerCard(peer, clock, { spkiFingerprint: tls.spkiFingerprint });
    const { baseUrl, requests } = startTlsPeerServer({
      tlsIdentity: tls,
      card: () => card,
    });
    const client = makeClient(local, { now: () => clock, cardCacheTtlMs: 60_000 });

    await postJson(client, baseUrl, "/v1/mesh/messages", { n: 1 });
    expect(requests).toHaveLength(1);

    // The cached card expires, and the refreshed card drops `tls`. A peer that
    // once advertised TLS never silently reverts (§11.4 rule 1/2).
    clock += 60_001;
    card = peerCard(peer, clock);
    await expect(
      postJson(client, baseUrl, "/v1/mesh/messages", { n: 2 }),
    ).rejects.toBeInstanceOf(PeerTlsDowngradeError);
    expect(requests).toHaveLength(1);
  });

  test("a pinned peer never falls back to the unpinned path when its card probe fails", async () => {
    const local = freshIdentity();
    const tls = await freshTlsIdentity();
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: tls, cardStatus: 503 });

    await expect(
      postJson(
        makeClient(local, {
          log: () => {},
          expectedPeerTlsPin: () => tls.spkiFingerprint,
        }),
        baseUrl,
        "/v1/mesh/messages",
        { n: 1 },
      ),
    ).rejects.toBeInstanceOf(PeerTlsDowngradeError);
    expect(requests).toHaveLength(0);
  });

  test("an expected peer never falls back to the legacy unsigned path", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const { baseUrl, requests } = startPeerServer({ cardStatus: 404 });

    await expect(
      postJson(
        makeClient(local, {
          log: () => {},
          expectedPeerKeyId: () => nodeKeyId(peer.publicKey),
        }),
        baseUrl,
        "/v1/mesh/messages",
        { n: 1 },
      ),
    ).rejects.toBeInstanceOf(PeerCardVerificationError);
    expect(requests).toHaveLength(0);
  });

  test("an unpinned, never-enrolled peer still gets today's plain http path", async () => {
    const local = freshIdentity();
    const { baseUrl, requests } = startPeerServer({ cardStatus: 404 });

    const response = await postJson(
      makeClient(local, {
        log: () => {},
        expectedPeerKeyId: () => undefined,
        expectedPeerTlsPin: () => undefined,
      }),
      baseUrl,
      "/v1/mesh/messages",
      { n: 1 },
    );

    expect(response.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get(PEER_AUTH_HEADERS.signature)).toBeNull();
  });

  test("pin mismatch recovery re-fetches the card, retries once, then fails closed", async () => {
    const local = freshIdentity();
    const peer = freshIdentity();
    const tls = await freshTlsIdentity();
    const card = peerCard(peer, undefined, { spkiFingerprint: tls.spkiFingerprint });
    const { baseUrl, requests } = startTlsPeerServer({ tlsIdentity: tls, card });

    // The card probe keeps succeeding (the peer still attests the pinned key);
    // only the signed request refuses, which is the compromise/DR shape.
    const attempts: string[] = [];
    const real = createPinnedHttpsClient();
    const stub: PinnedHttpsClient = {
      fetch(url, expected: PinnedPeer, init) {
        attempts.push(url);
        if (url.endsWith("/v1/node")) {
          return real.fetch(url, expected, init);
        }
        return Promise.reject(new PeerTlsPinError(
          "served key does not match the pin",
          new URL(url).origin,
          expected.spkiFingerprint,
          "c".repeat(64),
        ));
      },
      invalidate: () => real.invalidate(new URL(baseUrl).origin),
      close: () => real.close(),
    };

    let thrown: unknown;
    try {
      await postJson(
        makeClient(local, {
          pinnedClient: stub,
          expectedPeerKeyId: () => card.keyId,
          expectedPeerTlsPin: () => tls.spkiFingerprint,
        }),
        baseUrl,
        "/v1/mesh/messages",
        { hello: "mesh" },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PeerTlsPinError);
    expect((thrown as Error).message).toContain("revoke and re-enroll this peer deliberately");
    // Exactly one recovery round: probe, request, re-probe, retry.
    expect(attempts.filter((url) => url.endsWith("/v1/node"))).toHaveLength(2);
    expect(attempts.filter((url) => url.endsWith("/v1/mesh/messages"))).toHaveLength(2);
    expect(requests).toHaveLength(0);
    real.close();
  });
});
