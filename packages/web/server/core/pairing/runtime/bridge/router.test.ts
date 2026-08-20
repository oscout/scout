import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Bridge } from "./bridge.ts";
import { bridgeRouter } from "./router.ts";
import { revokeArtifactPresentation } from "./artifact-presentation.ts";

function createBridgeStub() {
  const replayCalls: string[] = [];
  const currentSeqCalls: string[] = [];
  const oldestBufferedSeqCalls: string[] = [];

  const bridge = {
    getSessionSummaries() {
      return [
        {
          sessionId: "older-session",
          name: "Older",
          adapterType: "codex",
          status: "active",
          turnCount: 1,
          currentTurnStatus: null,
          startedAt: 100,
          lastActivityAt: 100,
        },
        {
          sessionId: "latest-session",
          name: "Latest",
          adapterType: "codex",
          status: "active",
          turnCount: 2,
          currentTurnStatus: null,
          startedAt: 200,
          lastActivityAt: 200,
        },
      ];
    },
    listSessions() {
      return [{ sessionId: "older-session" }, { sessionId: "latest-session" }];
    },
    replay(sessionId: string, afterSeq: number) {
      replayCalls.push(sessionId);
      return [{ seq: afterSeq + 1, event: { event: `replay:${sessionId}` }, timestamp: 1_000 }] as const;
    },
    currentSeq(sessionId: string) {
      currentSeqCalls.push(sessionId);
      return sessionId === "latest-session" ? 42 : 7;
    },
    oldestBufferedSeq(sessionId: string) {
      oldestBufferedSeqCalls.push(sessionId);
      return sessionId === "latest-session" ? 9 : 3;
    },
  } as unknown as Bridge;

  return {
    bridge,
    replayCalls,
    currentSeqCalls,
    oldestBufferedSeqCalls,
  };
}

function createCaller(
  bridge: Bridge,
  context: {
    deviceId?: string;
    secureTransport?: boolean;
    trustedPeer?: boolean;
  } = {},
) {
  return bridgeRouter.createCaller({
    bridge,
    cwd: "/tmp/openscout",
    deviceId: context.deviceId,
    secureTransport: context.secureTransport,
    trustedPeer: context.trustedPeer,
  });
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("bridgeRouter sync compatibility", () => {
  test("mobile.artifactPresent scopes a relative host artifact to the session workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-artifact-router-"));
    writeFileSync(join(root, "index.html"), '<img src="shot.png">');
    writeFileSync(join(root, "shot.png"), "fake-png");
    const bridge = {
      getSessionSnapshot(sessionId: string) {
        return sessionId === "session-1"
          ? {
              session: {
                id: sessionId,
                name: "Studio",
                adapterType: "codex",
                status: "active",
                cwd: root,
              },
              turns: [],
            }
          : null;
      },
    } as unknown as Bridge;

    try {
      await expect(createCaller(bridge).mobile.artifactPresent({
        sessionId: "session-1",
        sourcePath: ".",
      })).rejects.toThrow("trusted paired device");

      const grant = await createCaller(bridge, {
        deviceId: "device-1",
        secureTransport: true,
        trustedPeer: true,
      }).mobile.artifactPresent({
        sessionId: "session-1",
        sourcePath: ".",
        title: "Studio rendition",
      });
      expect(grant.title).toBe("Studio rendition");
      expect(grant.path).toContain(`/present/${grant.id}/index.html`);
      expect(grant.port).toBeGreaterThan(0);
      revokeArtifactPresentation(grant.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mobile.endpoints requires the protected encrypted trusted mobile transport", async () => {
    const stub = createBridgeStub();

    await expect(createCaller(stub.bridge).mobile.endpoints()).rejects.toThrow(
      "Endpoint discovery requires an encrypted trusted mobile transport",
    );
  });

  test("mobile.endpoints returns current service coordinates on the protected transport", async () => {
    const previousHome = process.env.OPENSCOUT_HOME;
    const previousBrokerHost = process.env.OPENSCOUT_BROKER_HOST;
    const previousRtcPort = process.env.SCOUT_RTC_PORT;
    const previousFetch = globalThis.fetch;
    process.env.OPENSCOUT_HOME = mkdtempSync(join(tmpdir(), "openscout-router-test-"));
    delete process.env.OPENSCOUT_BROKER_HOST;
    process.env.SCOUT_RTC_PORT = "18090";
    globalThis.fetch = (async () => {
      throw new Error("voice leg unavailable");
    }) as typeof fetch;
    try {
      const stub = createBridgeStub();

      const result = await createCaller(stub.bridge, {
        deviceId: "device-1",
        secureTransport: true,
        trustedPeer: true,
      }).mobile.endpoints();

      expect(result.version).toBe(1);
      expect(result.protected).toBe(true);
      expect(result.transport.deviceId).toBe("device-1");
      expect(result.ports.broker).toBe(43110);
      expect(result.ports.web).toBe(43120);
      expect(result.ports.pairingBridge).toBe(43130);
      expect(result.endpoints.brokerUrl).toBe("http://127.0.0.1:43110");
      expect(result.endpoints.webUrl).toBe("http://127.0.0.1:43120");
      expect(result.endpoints.pairingBridgeUrl).toBe("ws://127.0.0.1:43130");
      expect(result.voice).toEqual({
        available: false,
        port: 18090,
        url: null,
        asr: "unknown",
      });
    } finally {
      restoreEnvironment("OPENSCOUT_HOME", previousHome);
      restoreEnvironment("OPENSCOUT_BROKER_HOST", previousBrokerHost);
      restoreEnvironment("SCOUT_RTC_PORT", previousRtcPort);
      globalThis.fetch = previousFetch;
    }
  });

  test("mobile.endpoints advertises and caches a healthy phone-dialable voice leg", async () => {
    const previousHome = process.env.OPENSCOUT_HOME;
    const previousBrokerHost = process.env.OPENSCOUT_BROKER_HOST;
    const previousHost = process.env.OPENSCOUT_HOST;
    const previousRtcPort = process.env.SCOUT_RTC_PORT;
    const previousFetch = globalThis.fetch;
    process.env.OPENSCOUT_HOME = mkdtempSync(join(tmpdir(), "openscout-router-test-"));
    delete process.env.OPENSCOUT_BROKER_HOST;
    process.env.OPENSCOUT_HOST = "192.0.2.10";
    process.env.SCOUT_RTC_PORT = "18091";
    let fetchCalls = 0;
    globalThis.fetch = (async (_input, init) => {
      fetchCalls += 1;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ ok: true, asr: "up" });
    }) as typeof fetch;
    try {
      const stub = createBridgeStub();
      const caller = createCaller(stub.bridge, {
        deviceId: "device-1",
        secureTransport: true,
        trustedPeer: true,
      });

      const first = await caller.mobile.endpoints();
      const second = await caller.mobile.endpoints();

      expect(first.voice).toEqual({
        available: true,
        port: 18091,
        url: "http://192.0.2.10:18091",
        asr: "up",
      });
      expect(second.voice).toEqual(first.voice);
      expect(fetchCalls).toBe(1);
    } finally {
      restoreEnvironment("OPENSCOUT_HOME", previousHome);
      restoreEnvironment("OPENSCOUT_BROKER_HOST", previousBrokerHost);
      restoreEnvironment("OPENSCOUT_HOST", previousHost);
      restoreEnvironment("SCOUT_RTC_PORT", previousRtcPort);
      globalThis.fetch = previousFetch;
    }
  });

  test("mobile.endpoints keeps a reachable loopback voice leg non-dialable", async () => {
    const previousHome = process.env.OPENSCOUT_HOME;
    const previousBrokerHost = process.env.OPENSCOUT_BROKER_HOST;
    const previousHost = process.env.OPENSCOUT_HOST;
    const previousRtcPort = process.env.SCOUT_RTC_PORT;
    const previousFetch = globalThis.fetch;
    process.env.OPENSCOUT_HOME = mkdtempSync(join(tmpdir(), "openscout-router-test-"));
    delete process.env.OPENSCOUT_BROKER_HOST;
    process.env.OPENSCOUT_HOST = "127.0.0.1";
    process.env.SCOUT_RTC_PORT = "18092";
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    try {
      const result = await createCaller(createBridgeStub().bridge, {
        deviceId: "device-1",
        secureTransport: true,
        trustedPeer: true,
      }).mobile.endpoints();

      expect(result.voice).toEqual({
        available: false,
        port: 18092,
        url: null,
        asr: "unknown",
      });
    } finally {
      restoreEnvironment("OPENSCOUT_HOME", previousHome);
      restoreEnvironment("OPENSCOUT_BROKER_HOST", previousBrokerHost);
      restoreEnvironment("OPENSCOUT_HOST", previousHost);
      restoreEnvironment("SCOUT_RTC_PORT", previousRtcPort);
      globalThis.fetch = previousFetch;
    }
  });

  test("mobile.endpoints reports ASR down without hiding a reachable voice leg", async () => {
    const previousHome = process.env.OPENSCOUT_HOME;
    const previousBrokerHost = process.env.OPENSCOUT_BROKER_HOST;
    const previousHost = process.env.OPENSCOUT_HOST;
    const previousRtcPort = process.env.SCOUT_RTC_PORT;
    const previousFetch = globalThis.fetch;
    process.env.OPENSCOUT_HOME = mkdtempSync(join(tmpdir(), "openscout-router-test-"));
    delete process.env.OPENSCOUT_BROKER_HOST;
    process.env.OPENSCOUT_HOST = "192.0.2.11";
    process.env.SCOUT_RTC_PORT = "18093";
    globalThis.fetch = (async () => Response.json({ ok: true, asr: "down" })) as typeof fetch;
    try {
      const result = await createCaller(createBridgeStub().bridge, {
        deviceId: "device-1",
        secureTransport: true,
        trustedPeer: true,
      }).mobile.endpoints();

      expect(result.voice.available).toBe(true);
      expect(result.voice.asr).toBe("down");
    } finally {
      restoreEnvironment("OPENSCOUT_HOME", previousHome);
      restoreEnvironment("OPENSCOUT_BROKER_HOST", previousBrokerHost);
      restoreEnvironment("OPENSCOUT_HOST", previousHost);
      restoreEnvironment("SCOUT_RTC_PORT", previousRtcPort);
      globalThis.fetch = previousFetch;
    }
  });

  test("mobile.endpoints fails closed when the bounded voice probe times out", async () => {
    const previousHome = process.env.OPENSCOUT_HOME;
    const previousBrokerHost = process.env.OPENSCOUT_BROKER_HOST;
    const previousHost = process.env.OPENSCOUT_HOST;
    const previousRtcPort = process.env.SCOUT_RTC_PORT;
    const previousFetch = globalThis.fetch;
    process.env.OPENSCOUT_HOME = mkdtempSync(join(tmpdir(), "openscout-router-test-"));
    delete process.env.OPENSCOUT_BROKER_HOST;
    process.env.OPENSCOUT_HOST = "192.0.2.12";
    process.env.SCOUT_RTC_PORT = "18094";
    globalThis.fetch = (async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    try {
      const result = await createCaller(createBridgeStub().bridge, {
        deviceId: "device-1",
        secureTransport: true,
        trustedPeer: true,
      }).mobile.endpoints();

      expect(result.voice).toEqual({
        available: false,
        port: 18094,
        url: null,
        asr: "unknown",
      });
    } finally {
      restoreEnvironment("OPENSCOUT_HOME", previousHome);
      restoreEnvironment("OPENSCOUT_BROKER_HOST", previousBrokerHost);
      restoreEnvironment("OPENSCOUT_HOST", previousHost);
      restoreEnvironment("SCOUT_RTC_PORT", previousRtcPort);
      globalThis.fetch = previousFetch;
    }
  });

  test("sync.status falls back to the most recent session when sessionId is omitted", async () => {
    const stub = createBridgeStub();

    const result = await createCaller(stub.bridge).sync.status();

    expect(result).toEqual({
      currentSeq: 42,
      oldestBufferedSeq: 9,
      sessionCount: 2,
    });
    expect(stub.currentSeqCalls).toEqual(["latest-session"]);
    expect(stub.oldestBufferedSeqCalls).toEqual(["latest-session"]);
  });

  test("sync.status returns empty counters when there are no sessions", async () => {
    const bridge = {
      getSessionSummaries() {
        return [];
      },
      listSessions() {
        return [];
      },
    } as unknown as Bridge;

    const result = await createCaller(bridge).sync.status();

    expect(result).toEqual({
      currentSeq: 0,
      oldestBufferedSeq: 0,
      sessionCount: 0,
    });
  });

  test("sync.replay falls back to the most recent session when sessionId is omitted", async () => {
    const stub = createBridgeStub();

    const result = await createCaller(stub.bridge).sync.replay({ lastSeq: 11 });

    expect(result.events).toEqual([
      { seq: 12, event: { event: "replay:latest-session" }, timestamp: 1_000 },
    ]);
    expect(stub.replayCalls).toEqual(["latest-session"]);
  });
});
