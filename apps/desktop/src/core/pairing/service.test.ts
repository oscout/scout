import { afterEach, describe, expect, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

describe("pairing service", () => {
  test("refreshes an expired active runtime pairing payload without starting a second runtime", async () => {
    const startPairingRuntime = mock(async () => {
      throw new Error("startPairingRuntime should not run for an active snapshot");
    });
    const renderQRCode = mock((payload: { expiresAt: number }) => `qr:${payload.expiresAt}`);
    const expiredAt = Date.now() - 60_000;

    mock.module("./runtime/index.ts", () => ({
      pairingPaths: () => ({
        rootDir: "/tmp/pairing",
        configPath: "/tmp/pairing/config.json",
        identityPath: "/tmp/pairing/identity.json",
        trustedPeersPath: "/tmp/pairing/trusted-peers.json",
        logPath: "/tmp/pairing/bridge.log",
        runtimeStatePath: "/tmp/pairing/runtime.json",
        runtimePidPath: "/tmp/pairing/runtime.pid",
      }),
      isProcessRunning: () => true,
      readPairingRuntimeSnapshot: () => ({
        version: 1,
        pid: 123,
        childPid: null,
        status: "paired",
        statusLabel: "Paired",
        statusDetail: "Secure peer connected (abcd1234...)",
        connectedPeerFingerprint: "abcd1234",
        relay: "wss://relay.test",
        secure: true,
        lanDiscoveryAdvertised: false,
        workspaceRoot: "/workspace",
        sessionCount: 2,
        identityFingerprint: "localfprint1234",
        trustedPeerCount: 3,
        pairing: {
          relay: "wss://relay.test",
          fallbackRelays: ["wss://mac.tailnet.ts.net:43131"],
          room: "room-expired",
          publicKey: "local-public-key",
          expiresAt: expiredAt,
          qrArt: "expired qr",
          qrValue: "{\"room\":\"room-expired\"}",
        },
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
      }),
      renderQRCode,
      resolvedPairingConfig: () => ({
        relay: "wss://relay.test",
        secure: true,
        port: 43130,
        workspaceRoot: "/workspace",
        sessions: [],
      }),
      startPairingRuntime,
      startManagedRelay: () => ({
        relayUrl: "ws://managed",
        stop() {},
      }),
      trustedPeerCount: () => 0,
      loadOrCreateIdentity: () => ({
        publicKey: new Uint8Array([1, 2, 3]),
      }),
      bytesToHex: () => "010203",
      PAIRING_QR_TTL_MS: 300_000,
    }));

    const { startScoutPairingSession } = await import("./service.ts");
    const events: any[] = [];
    await startScoutPairingSession({
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(startPairingRuntime.mock.calls).toHaveLength(0);
    expect(events[0]).toEqual(expect.objectContaining({
      type: "pairing_ready",
      qrArt: `qr:${events[0].payload.expiresAt}`,
    }));
    expect(events[0].payload).toEqual(expect.objectContaining({
      relay: "wss://relay.test",
      fallbackRelays: ["wss://mac.tailnet.ts.net:43131"],
      room: "room-expired",
      publicKey: "local-public-key",
    }));
    expect(events[0].payload.expiresAt).toBeGreaterThan(Date.now());
    expect(renderQRCode.mock.calls).toHaveLength(1);
  });
});
