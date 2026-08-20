import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  PeerTlsPinError,
  createPinnedHttpsClient,
} from "./mesh-pinned-https-client.js";
import {
  loadOrCreateTlsIdentity,
  tlsSpkiFingerprintFromCertificateDer,
  type NodeTlsIdentity,
} from "./node-tls-identity.js";

/**
 * Live crypto, live TLS: every fixture here is a real self-signed certificate
 * issued by chunk B's `loadOrCreateTlsIdentity`, served by a real listener.
 *
 * The identities are `ec-p256`, not §11.1's Ed25519, because Bun's TLS stack
 * (BoringSSL) cannot serve *or* verify an Ed25519 leaf certificate — a Bun
 * listener holding one never completes a handshake, from a Bun or a Node
 * client, while Node↔Node with the same certificate succeeds. The deployed
 * broker runs under Bun, so this is a live P1.5 blocker on §11.1's algorithm
 * choice, reported alongside this chunk.
 */

const servers = new Set<ReturnType<typeof Bun.serve>>();
const clients = new Set<ReturnType<typeof createPinnedHttpsClient>>();

afterEach(() => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.clear();
  for (const client of clients) {
    client.close();
  }
  clients.clear();
});

async function freshTlsIdentity(): Promise<NodeTlsIdentity> {
  return loadOrCreateTlsIdentity(
    mkdtempSync(join(tmpdir(), "openscout-pinned-tls-test-")),
    { algorithm: "ec-p256" },
  );
}

type CapturedRequest = { method: string; path: string; headers: Headers; body: string };

function startTlsPeer(
  identity: NodeTlsIdentity,
  handler?: (request: Request) => Response,
): { baseUrl: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    tls: {
      key: identity.keyPair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      cert: identity.certificatePem,
    },
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers,
        body: await request.text(),
      });
      return handler?.(request) ?? Response.json({ ok: true, path: url.pathname });
    },
  });
  servers.add(server);
  return { baseUrl: `https://127.0.0.1:${server.port}`, requests };
}

function makeClient(deps: Parameters<typeof createPinnedHttpsClient>[0] = {}) {
  const client = createPinnedHttpsClient(deps);
  clients.add(client);
  return client;
}

describe("pinned https client", () => {
  test("connects and sends when the served SPKI matches the pin", async () => {
    const identity = await freshTlsIdentity();
    const { baseUrl, requests } = startTlsPeer(identity);
    const client = makeClient();

    const response = await client.fetch(`${baseUrl}/v1/node`, {
      spkiFingerprint: identity.spkiFingerprint,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: "/v1/node" });
    expect(requests).toHaveLength(1);
    // The pin is over the SPKI, so it is derivable from the served cert DER.
    expect(tlsSpkiFingerprintFromCertificateDer(identity.certificateDer))
      .toBe(identity.spkiFingerprint);
  });

  test("refuses and sends nothing when the served SPKI does not match the pin", async () => {
    const identity = await freshTlsIdentity();
    const impostor = await freshTlsIdentity();
    const { baseUrl, requests } = startTlsPeer(identity);
    const client = makeClient();

    let thrown: unknown;
    try {
      await client.fetch(`${baseUrl}/v1/mesh/messages`, {
        spkiFingerprint: impostor.spkiFingerprint,
      }, { method: "POST", body: "{}" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PeerTlsPinError);
    const pinError = thrown as PeerTlsPinError;
    expect(pinError.expectedFingerprint).toBe(impostor.spkiFingerprint);
    expect(pinError.observedFingerprint).toBe(identity.spkiFingerprint);
    // Fail closed: the request body never reached the peer.
    expect(requests).toHaveLength(0);
  });

  test("round-trips method, headers and body over the pinned channel", async () => {
    const identity = await freshTlsIdentity();
    const { baseUrl, requests } = startTlsPeer(identity);
    const client = makeClient();

    const response = await client.fetch(`${baseUrl}/v1/mesh/messages?x=1`, {
      spkiFingerprint: identity.spkiFingerprint,
    }, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openscout-peer": "abc" },
      body: JSON.stringify({ hello: "mesh" }),
    });

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    const received = requests[0]!;
    expect(received.method).toBe("POST");
    expect(received.path).toBe("/v1/mesh/messages?x=1");
    expect(received.headers.get("x-openscout-peer")).toBe("abc");
    expect(JSON.parse(received.body)).toEqual({ hello: "mesh" });
  });

  test("reuses a validated session and re-handshakes after the TTL", async () => {
    const identity = await freshTlsIdentity();
    const { baseUrl, requests } = startTlsPeer(identity);
    let clock = 1_700_000_000_000;
    const handshakes: string[] = [];
    const client = makeClient({
      now: () => clock,
      sessionTtlMs: 60_000,
      onHandshake: (origin) => handshakes.push(origin),
    });
    const peer = { spkiFingerprint: identity.spkiFingerprint };

    await client.fetch(`${baseUrl}/a`, peer);
    await client.fetch(`${baseUrl}/b`, peer);
    expect(requests).toHaveLength(2);
    // One pin-validating handshake covers both requests.
    expect(handshakes).toHaveLength(1);

    clock += 60_001;
    await client.fetch(`${baseUrl}/c`, peer);
    expect(requests).toHaveLength(3);
    expect(handshakes).toHaveLength(2);
  });

  test("a pin mismatch destroys the cached session for that origin", async () => {
    const identity = await freshTlsIdentity();
    const impostor = await freshTlsIdentity();
    const { baseUrl } = startTlsPeer(identity);
    const handshakes: string[] = [];
    const client = makeClient({ onHandshake: (origin) => handshakes.push(origin) });

    await client.fetch(`${baseUrl}/a`, { spkiFingerprint: identity.spkiFingerprint });
    expect(handshakes).toHaveLength(1);

    await expect(
      client.fetch(`${baseUrl}/b`, { spkiFingerprint: impostor.spkiFingerprint }),
    ).rejects.toBeInstanceOf(PeerTlsPinError);

    // The good session is untouched by another pin's failure, but the failed
    // pin never caches anything.
    await client.fetch(`${baseUrl}/c`, { spkiFingerprint: identity.spkiFingerprint });
    expect(handshakes).toHaveLength(2);
  });

  test("refuses a plaintext URL and a malformed pin outright", async () => {
    const client = makeClient();
    await expect(
      client.fetch("http://127.0.0.1:1/v1/node", { spkiFingerprint: "a".repeat(64) }),
    ).rejects.toBeInstanceOf(PeerTlsPinError);
    await expect(
      client.fetch("https://127.0.0.1:1/v1/node", { spkiFingerprint: "nope" }),
    ).rejects.toBeInstanceOf(PeerTlsPinError);
  });

  test("does not follow redirects on a pinned request", async () => {
    const identity = await freshTlsIdentity();
    const { baseUrl } = startTlsPeer(identity, () => Response.redirect("https://example.invalid/x", 302));
    const client = makeClient();

    // `redirect: "error"` is the default; a redirect is a rejection, never a
    // silent hop to another origin.
    await expect(
      client.fetch(`${baseUrl}/v1/node`, { spkiFingerprint: identity.spkiFingerprint }),
    ).rejects.toBeTruthy();
  });

  /**
   * §11.4 asks for the wrong-pin-fails-closed conformance to run under *both*
   * runtimes: Bun serves the deployed broker, Node serves
   * `openscout-runtime` invoked through `node ./bin/openscout-runtime.mjs`.
   * The Bun tests above cover the `Bun.connect` anchor path; this one drives
   * the `https.Agent` + `tls.connect` socket-handoff path in a real Node
   * process, so it cannot rot into dead code.
   */
  test("node runtime: same pin match / pin mismatch behaviour via the socket-handoff path", async () => {
    const identity = await freshTlsIdentity();
    const impostor = await freshTlsIdentity();
    const { baseUrl, requests } = startTlsPeer(identity);

    const workDir = mkdtempSync(join(tmpdir(), "openscout-pinned-node-conformance-"));
    const bundlePath = join(workDir, "pinned-client.mjs");
    const build = await Bun.build({
      entrypoints: [new URL("./mesh-pinned-https-client.ts", import.meta.url).pathname],
      target: "node",
      outdir: workDir,
      naming: "pinned-client.mjs",
    });
    expect(build.success).toBe(true);

    const driverPath = join(workDir, "driver.mjs");
    await Bun.write(driverPath, `
import { createPinnedHttpsClient, PeerTlsPinError } from ${JSON.stringify(bundlePath)};
const client = createPinnedHttpsClient();
const result = { runtime: typeof Bun === "undefined" ? "node" : "bun" };
try {
  const ok = await client.fetch(${JSON.stringify(`${baseUrl}/v1/node`)}, { spkiFingerprint: ${JSON.stringify(identity.spkiFingerprint)} });
  result.matchStatus = ok.status;
  result.matchBody = await ok.text();
} catch (error) {
  result.matchError = String(error && error.message);
}
try {
  await client.fetch(${JSON.stringify(`${baseUrl}/v1/mesh/messages`)}, { spkiFingerprint: ${JSON.stringify(impostor.spkiFingerprint)} }, { method: "POST", body: "{}" });
  result.mismatch = "SENT";
} catch (error) {
  result.mismatch = error instanceof PeerTlsPinError ? "PeerTlsPinError" : String(error && error.name);
  result.mismatchObserved = error.observedFingerprint;
}
client.close();
console.log(JSON.stringify(result));
`);

    // Node warns to stderr when NO_COLOR and FORCE_COLOR are both set (the
    // suite may inherit FORCE_COLOR from the invoking terminal). Pin a clean
    // color env so the stderr canary below stays meaningful.
    const childEnv = { ...process.env, NO_COLOR: "1" };
    delete childEnv.FORCE_COLOR;
    const proc = Bun.spawn({ cmd: ["node", driverPath], stdout: "pipe", stderr: "pipe", env: childEnv });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(stderr).toBe("");
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>;

    expect(result.runtime).toBe("node");
    expect(result.matchStatus).toBe(200);
    expect(JSON.parse(result.matchBody as string)).toEqual({ ok: true, path: "/v1/node" });
    expect(result.mismatch).toBe("PeerTlsPinError");
    expect(result.mismatchObserved).toBe(identity.spkiFingerprint);
    // Only the pin-matching request was ever delivered.
    expect(requests.map((request) => request.path)).toEqual(["/v1/node"]);
  });

  test("connection failure to a dead port is a typed pin error, not a plaintext retry", async () => {
    const identity = await freshTlsIdentity();
    const { baseUrl } = startTlsPeer(identity);
    const port = Number(new URL(baseUrl).port);
    for (const server of servers) {
      server.stop(true);
    }
    servers.clear();

    await expect(
      makeClient({ connectTimeoutMs: 1_000 }).fetch(
        `https://127.0.0.1:${port}/v1/node`,
        { spkiFingerprint: identity.spkiFingerprint },
      ),
    ).rejects.toBeInstanceOf(PeerTlsPinError);
  });
});
