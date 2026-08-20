import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import {
  MESH_MDNS_KEY_ID_DIGEST_HEX_CHARS,
  MESH_MDNS_PROTOCOL_VERSION,
  MESH_MDNS_SERVICE_TYPE,
  MeshMdnsService,
  buildDarwinDnsSdRegisterArgs,
  buildMeshMdnsTxt,
  createDarwinMdnsResponder,
  meshMdnsEnabled,
  meshMdnsKeyIdDigest,
  normalizeAdvertisement,
  selectMdnsResponderForPlatform,
  wireMeshMdns,
  type MdnsAdvertisement,
  type MdnsPublishOptions,
  type MdnsResponder,
} from "./mesh-mdns-service.js";

const OWN_KEY_ID = "a".repeat(64);
const PEER_KEY_ID = "b".repeat(64);

function createFakeResponder() {
  const published: MdnsPublishOptions[] = [];
  const listeners: Record<"up" | "down", Array<(service: MdnsAdvertisement) => void>> = {
    up: [],
    down: [],
  };
  const counts = { unpublishAll: 0, destroy: 0, browserStop: 0 };
  const responder: MdnsResponder = {
    publish(options) {
      published.push(options);
      return { stop() {} };
    },
    unpublishAll() {
      counts.unpublishAll += 1;
    },
    find(_options, onup) {
      if (onup) listeners.up.push(onup);
      return {
        on(event, listener) {
          listeners[event].push(listener);
        },
        stop() {
          counts.browserStop += 1;
        },
      };
    },
    destroy() {
      counts.destroy += 1;
    },
  };
  function emit(event: "up" | "down", advertisement: MdnsAdvertisement) {
    for (const listener of listeners[event]) listener(advertisement);
  }
  return { responder, published, counts, emit };
}

function peerAdvertisement(input: Partial<MdnsAdvertisement> = {}): MdnsAdvertisement {
  return {
    name: `OpenScout Node ${PEER_KEY_ID.slice(0, 8)}`,
    host: "peer.local",
    port: 43111,
    addresses: ["192.168.1.42"],
    txt: { v: "1", kid: PEER_KEY_ID.slice(0, 32), port: "43111" },
    ...input,
  };
}

function createFakeDarwinRuntime() {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: { argv0?: string; stdio?: unknown };
  }> = [];
  const children: Array<EventEmitter & {
    killed: boolean;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
  }> = [];
  const processEvents = new EventEmitter();
  const fakeSpawn = ((
    command: string,
    args: readonly string[],
    options: { argv0?: string; stdio?: unknown },
  ) => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal?: string) {
        expect(signal).toBe("SIGTERM");
        this.killed = true;
        return true;
      },
    });
    calls.push({ command, args, options });
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  return {
    calls,
    children,
    fakeSpawn,
    processEvents,
    processExitEvents: processEvents as unknown as Pick<NodeJS.Process, "once" | "off">,
  };
}

describe("buildMeshMdnsTxt", () => {
  test("produces the compact record: v, kid digest, port — nothing else", () => {
    const txt = buildMeshMdnsTxt({ keyId: OWN_KEY_ID, port: 43120 });
    expect(Object.keys(txt).sort()).toEqual(["kid", "port", "v"]);
    expect(txt.v).toBe(String(MESH_MDNS_PROTOCOL_VERSION));
    expect(txt.kid).toBe("a".repeat(MESH_MDNS_KEY_ID_DIGEST_HEX_CHARS));
    expect(txt.kid).toMatch(/^[0-9a-f]{32}$/);
    expect(txt.port).toBe("43120");
    // Compactness guard: the whole record stays far under TXT limits.
    expect(JSON.stringify(txt).length).toBeLessThan(100);
  });

  test("adds tls=1 without bumping v=", () => {
    const plain = buildMeshMdnsTxt({ keyId: OWN_KEY_ID, port: 43120 });
    const withTls = buildMeshMdnsTxt({ keyId: OWN_KEY_ID, port: 43120, tls: true });
    expect(withTls.v).toBe(plain.v);
    expect(withTls.tls).toBe("1");
    expect(plain.tls).toBeUndefined();
  });

  test("honors an explicit protocol version", () => {
    expect(buildMeshMdnsTxt({ keyId: OWN_KEY_ID, port: 1, protocolVersion: 7 }).v).toBe("7");
  });

  test("rejects a malformed key ID and an invalid port", () => {
    expect(() => buildMeshMdnsTxt({ keyId: "xyz", port: 43120 })).toThrow();
    expect(() => buildMeshMdnsTxt({ keyId: OWN_KEY_ID, port: 0 })).toThrow();
    expect(() => buildMeshMdnsTxt({ keyId: OWN_KEY_ID, port: 70_000 })).toThrow();
  });
});

describe("meshMdnsKeyIdDigest", () => {
  test("takes the first 16 bytes as hex", () => {
    expect(meshMdnsKeyIdDigest(OWN_KEY_ID)).toBe("a".repeat(32));
    expect(meshMdnsKeyIdDigest("AB".repeat(32))).toBe("ab".repeat(16));
  });
});

describe("Darwin mDNS registration", () => {
  const publishOptions: MdnsPublishOptions = {
    name: "OpenScout Node aaaaaaaa",
    host: `openscout-${"a".repeat(32)}.local`,
    type: MESH_MDNS_SERVICE_TYPE,
    protocol: "tcp",
    port: 43120,
    txt: { v: "1", kid: "a".repeat(32), port: "43120", tls: "1" },
  };

  test("builds a native dns-sd registration without claiming a host record", () => {
    const args = buildDarwinDnsSdRegisterArgs(publishOptions);
    expect(args).toEqual([
      "-R",
      "OpenScout Node aaaaaaaa",
      "_openscout._tcp",
      "local.",
      "43120",
      "v=1",
      `kid=${"a".repeat(32)}`,
      "port=43120",
      "tls=1",
    ]);
    expect(args).not.toContain(publishOptions.host);
  });

  test("publishes through dns-sd, delegates browsing, and terminates registrations", () => {
    const fake = createFakeResponder();
    const runtime = createFakeDarwinRuntime();
    const responder = createDarwinMdnsResponder(
      fake.responder,
      runtime.fakeSpawn,
      { warn() {} },
      runtime.processExitEvents,
    );

    const first = responder.publish(publishOptions);
    responder.publish({ ...publishOptions, name: "OpenScout Node bbbbbbbb" });
    responder.find({ type: MESH_MDNS_SERVICE_TYPE, protocol: "tcp" });

    expect(fake.published).toHaveLength(0);
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[0]).toEqual({
      command: "/usr/bin/dns-sd",
      args: buildDarwinDnsSdRegisterArgs(publishOptions),
      options: {
        argv0: "openscout-mesh-mdns",
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    let stopped = 0;
    first.stop(() => stopped += 1);
    first.stop();
    expect(stopped).toBe(1);
    expect(runtime.children[0]?.killed).toBe(true);
    expect(runtime.children[1]?.killed).toBe(false);

    expect(runtime.processEvents.listenerCount("exit")).toBe(1);
    runtime.processEvents.emit("exit");
    expect(runtime.children[1]?.killed).toBe(true);
    responder.destroy();
    expect(fake.counts.destroy).toBe(1);
    expect(runtime.processEvents.listenerCount("exit")).toBe(0);
  });

  test("reports native registration failure and clears advertising health", () => {
    const fake = createFakeResponder();
    const runtime = createFakeDarwinRuntime();
    const warnings: string[] = [];
    const service = new MeshMdnsService({
      responderFactory: () => createDarwinMdnsResponder(
        fake.responder,
        runtime.fakeSpawn,
        { warn: (message) => warnings.push(String(message)) },
        runtime.processExitEvents,
      ),
    });

    service.start({ port: 43120, keyId: OWN_KEY_ID });
    expect(service.isAdvertising).toBe(true);
    runtime.children[0]?.stdout.write("registration name conflict");
    runtime.children[0]?.emit("exit", 42, null);

    expect(service.isAdvertising).toBe(false);
    expect(warnings).toEqual([
      "[mesh-mdns] native registration failed: exit 42: registration name conflict",
    ]);
    service.stop();
  });

  test("selects native registration only on Darwin", () => {
    const darwinFake = createFakeResponder();
    const runtime = createFakeDarwinRuntime();
    const darwin = selectMdnsResponderForPlatform(
      darwinFake.responder,
      "darwin",
      runtime.fakeSpawn,
      { warn() {} },
      runtime.processExitEvents,
    );
    darwin.publish(publishOptions);
    expect(runtime.calls).toHaveLength(1);
    expect(darwinFake.published).toHaveLength(0);
    darwin.destroy();

    const linuxFake = createFakeResponder();
    const linux = selectMdnsResponderForPlatform(
      linuxFake.responder,
      "linux",
      runtime.fakeSpawn,
      { warn() {} },
      runtime.processExitEvents,
    );
    expect(linux).toBe(linuxFake.responder);
    linux.publish(publishOptions);
    expect(linuxFake.published).toHaveLength(1);
  });
});

describe("MeshMdnsService", () => {
  test("start publishes _openscout._tcp with the compact TXT", () => {
    const fake = createFakeResponder();
    const service = new MeshMdnsService({ responderFactory: () => fake.responder });
    service.start({ port: 43120, keyId: OWN_KEY_ID });
    expect(fake.published).toHaveLength(1);
    const advert = fake.published[0];
    expect(advert.type).toBe(MESH_MDNS_SERVICE_TYPE);
    expect(advert.protocol).toBe("tcp");
    expect(advert.port).toBe(43120);
    expect(advert.host).toBe(`openscout-${"a".repeat(32)}.local`);
    expect(advert.txt).toEqual({ v: "1", kid: "a".repeat(32), port: "43120" });
    service.stop();
  });

  test("start/stop are idempotent", () => {
    const fake = createFakeResponder();
    const service = new MeshMdnsService({ responderFactory: () => fake.responder });
    service.start({ port: 43120, keyId: OWN_KEY_ID });
    service.start({ port: 43120, keyId: OWN_KEY_ID });
    expect(fake.published).toHaveLength(1);
    service.startBrowse();
    service.startBrowse();
    service.stop();
    service.stop();
    expect(fake.counts.unpublishAll).toBe(1);
    expect(fake.counts.destroy).toBe(1);
    expect(fake.counts.browserStop).toBe(1);
  });

  test("browse reports discovered peers and excludes self by kid digest", () => {
    const fake = createFakeResponder();
    const service = new MeshMdnsService({ responderFactory: () => fake.responder });
    service.start({ port: 43120, keyId: OWN_KEY_ID });
    const found: string[] = [];
    const lost: string[] = [];
    service.startBrowse({
      onPeerFound: (peer) => found.push(peer.kid ?? "?"),
      onPeerLost: (peer) => lost.push(peer.kid ?? "?"),
    });

    fake.emit("up", peerAdvertisement());
    // Own advert (same kid digest) must not surface as a peer.
    fake.emit("up", peerAdvertisement({
      name: "OpenScout Node aaaaaaaa",
      txt: { v: "1", kid: OWN_KEY_ID.slice(0, 32), port: "43120" },
    }));
    // Uppercase kid still matches self.
    fake.emit("up", peerAdvertisement({
      txt: { v: "1", kid: OWN_KEY_ID.slice(0, 32).toUpperCase(), port: "43120" },
    }));
    fake.emit("down", peerAdvertisement());

    expect(found).toEqual([PEER_KEY_ID.slice(0, 32)]);
    expect(lost).toEqual([PEER_KEY_ID.slice(0, 32)]);
    service.stop();
  });

  test("browse reports peer host, port, kid, and txt", () => {
    const fake = createFakeResponder();
    const service = new MeshMdnsService({ responderFactory: () => fake.responder });
    service.start({ port: 43120, keyId: OWN_KEY_ID });
    let seen: unknown = null;
    service.startBrowse({ onPeerFound: (peer) => (seen = peer) });
    fake.emit("up", peerAdvertisement());
    expect(seen).toMatchObject({
      host: "peer.local",
      addresses: ["192.168.1.42"],
      port: 43111,
      kid: PEER_KEY_ID.slice(0, 32),
      protocolVersion: "1",
      txt: { v: "1", kid: PEER_KEY_ID.slice(0, 32), port: "43111" },
    });
    service.stop();
  });
});

describe("normalizeAdvertisement", () => {
  test("coerces TXT values to strings and rejects malformed kids", () => {
    const peer = normalizeAdvertisement({
      txt: { v: "1", kid: "not-hex", port: 43120, raw: Buffer.from("buf") },
    });
    expect(peer.kid).toBeNull();
    expect(peer.txt.port).toBe("43120");
    expect(peer.txt.raw).toBe("buf");
  });
});

describe("wireMeshMdns", () => {
  const logger = { log() {}, warn() {} };

  test("advertises and browses when the broker is dialable off-loopback", () => {
    const fake = createFakeResponder();
    const service = wireMeshMdns({
      host: "0.0.0.0",
      port: 43120,
      keyId: OWN_KEY_ID,
      env: {},
      responderFactory: () => fake.responder,
      logger,
    });
    expect(service).not.toBeNull();
    expect(fake.published).toHaveLength(1);
    service?.stop();
    expect(fake.counts.destroy).toBe(1);
  });

  test("stands down for a loopback-bound broker", () => {
    const fake = createFakeResponder();
    const service = wireMeshMdns({
      host: "127.0.0.1",
      port: 43120,
      keyId: OWN_KEY_ID,
      env: {},
      responderFactory: () => fake.responder,
      logger,
    });
    expect(service).toBeNull();
    expect(fake.published).toHaveLength(0);
  });

  test("stands down when OPENSCOUT_MDNS_ENABLED=0", () => {
    const fake = createFakeResponder();
    const service = wireMeshMdns({
      host: "0.0.0.0",
      port: 43120,
      keyId: OWN_KEY_ID,
      env: { OPENSCOUT_MDNS_ENABLED: "0" },
      responderFactory: () => fake.responder,
      logger,
    });
    expect(service).toBeNull();
    expect(fake.published).toHaveLength(0);
  });

  test("stops a native registration if browse startup fails", () => {
    const fake = createFakeResponder();
    fake.responder.find = () => {
      throw new Error("browse failed");
    };

    expect(() => wireMeshMdns({
      host: "192.168.1.42",
      port: 43120,
      keyId: OWN_KEY_ID,
      env: {},
      responderFactory: () => fake.responder,
      logger,
    })).toThrow("browse failed");
    expect(fake.counts.unpublishAll).toBe(1);
    expect(fake.counts.destroy).toBe(1);
  });
});

describe("meshMdnsEnabled", () => {
  test("defaults on; off for 0/false/off", () => {
    expect(meshMdnsEnabled({})).toBe(true);
    expect(meshMdnsEnabled({ OPENSCOUT_MDNS_ENABLED: "1" })).toBe(true);
    expect(meshMdnsEnabled({ OPENSCOUT_MDNS_ENABLED: "0" })).toBe(false);
    expect(meshMdnsEnabled({ OPENSCOUT_MDNS_ENABLED: "false" })).toBe(false);
    expect(meshMdnsEnabled({ OPENSCOUT_MDNS_ENABLED: "OFF" })).toBe(false);
  });
});

// Live loopback round-trip through the real bonjour-service responder. Off by
// default: mDNS on CI hosts is flaky; run explicitly with
// OPENSCOUT_TEST_MDNS_LIVE=1 bun test src/mesh-mdns-service.test.ts.
const LIVE = process.env.OPENSCOUT_TEST_MDNS_LIVE === "1";
const liveDescribe = LIVE ? describe : describe.skip;
liveDescribe("live mDNS round-trip", () => {
  test("publish on localhost is discovered by a browsing service", async () => {
    const advertiser = new MeshMdnsService();
    const browser = new MeshMdnsService();
    try {
      advertiser.start({ port: 43999, keyId: OWN_KEY_ID });
      const peer = await new Promise<{ kid: string | null; port: number | null }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for mDNS discovery")), 15_000);
        browser.startBrowse({
          onPeerFound: (p) => {
            if (p.kid !== OWN_KEY_ID.slice(0, 32)) return;
            clearTimeout(timeout);
            resolve(p);
          },
        });
      });
      expect(peer.kid).toBe(OWN_KEY_ID.slice(0, 32));
      expect(peer.port).toBe(43999);
    } finally {
      advertiser.stop();
      browser.stop();
    }
  }, 20_000);
});
