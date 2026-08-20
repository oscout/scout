import { afterEach, describe, expect, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

describe("pairing service", () => {
  test("reuses an active runtime snapshot and reports its current broker-visible state", async () => {
    const startPairingRuntime = mock(async () => {
      throw new Error("startPairingRuntime should not run for an active snapshot");
    });

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
          room: "room-1",
          publicKey: "local-public-key",
          expiresAt: Date.now() + 60_000,
          qrArt: "qr art",
          qrValue: "{\"room\":\"room-1\"}",
        },
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
      }),
      renderQRCode: () => "unused",
      resolvedPairingConfig: () => ({
        relay: "wss://relay.test",
        secure: true,
        port: 43130,
        workspaceRoot: "/workspace",
        sessions: [{ id: "session-1" }, { id: "session-2" }],
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
    const session = await startScoutPairingSession({
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(session.relayUrl).toBe("wss://relay.test");
    expect(session.managedRelay).toBe(false);
    expect(startPairingRuntime.mock.calls).toHaveLength(0);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({
      type: "pairing_ready",
      relay: "wss://relay.test",
      identityFingerprint: "localfprint1234",
      trustedPeerCount: 3,
      config: expect.objectContaining({
        relay: "wss://relay.test",
        workspaceRoot: "/workspace",
        sessionCount: 2,
        port: 43130,
      }),
    }));
    expect(events[1]).toEqual({
      type: "status",
      status: "paired",
      detail: "Secure peer connected (abcd1234...)",
    });

    await session.stop();
    expect(events[2]).toEqual({
      type: "status",
      status: "closed",
      detail: "Scout pair view closed.",
    });
  });

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

  test("queues reconnect lifecycle updates until the QR payload is ready, then flushes them in order", async () => {
    const runtimeStop = mock(async () => undefined);
    const relayStop = mock(() => undefined);

    const startPairingRuntime = mock(async ({ relayEvents }: { relayEvents?: Record<string, (detail?: any) => void> }) => {
      relayEvents?.onConnecting?.();
      relayEvents?.onReconnectScheduled?.({ delayMs: 4_000 });
      relayEvents?.onConnected?.({ room: "room-1" });
      return {
        qrPayload: {
          v: 1,
          relay: "ws://managed",
          room: "room-1",
          publicKey: "local-public-key",
          expiresAt: Date.now() + 120_000,
        },
        stop: runtimeStop,
      };
    });

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
      isProcessRunning: () => false,
      readPairingRuntimeSnapshot: () => null,
      renderQRCode: () => "rendered qr",
      resolvedPairingConfig: () => ({
        relay: null,
        secure: true,
        port: 43130,
        workspaceRoot: "/workspace",
        sessions: [{ id: "session-1" }],
      }),
      startPairingRuntime,
      startManagedRelay: () => ({
        relayUrl: "ws://managed",
        stop: relayStop,
      }),
      trustedPeerCount: () => 5,
      loadOrCreateIdentity: () => ({
        publicKey: new Uint8Array([0xaa, 0xbb, 0xcc]),
      }),
      bytesToHex: () => "aabbccddeeff0011",
      PAIRING_QR_TTL_MS: 300_000,
    }));

    const { startScoutPairingSession } = await import("./service.ts");
    const events: any[] = [];
    const session = await startScoutPairingSession({
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(session.relayUrl).toBe("ws://managed");
    expect(session.managedRelay).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["pairing_ready", "status", "status", "status"]);
    expect(events[0]).toEqual(expect.objectContaining({
      type: "pairing_ready",
      relay: "ws://managed",
      qrArt: "rendered qr",
      identityFingerprint: "aabbccddeeff0011",
      trustedPeerCount: 5,
    }));
    expect(events[1]).toEqual({
      type: "status",
      status: "connecting",
      detail: "Connecting to ws://managed",
    });
    expect(events[2]).toEqual({
      type: "status",
      status: "connecting",
      detail: "Connection lost. Retrying in 4s.",
    });
    expect(events[3]).toEqual({
      type: "status",
      status: "connected",
      detail: "Relay room room-1 is ready",
    });

    await session.stop();
    expect(events[4]).toEqual({
      type: "status",
      status: "closed",
      detail: "Scout pair mode stopped.",
    });
    expect(runtimeStop.mock.calls).toHaveLength(1);
    expect(relayStop.mock.calls).toHaveLength(1);
  });

  test("emits an error and cleans up runtime resources when startup never produces a QR payload", async () => {
    const runtimeStop = mock(async () => undefined);
    const relayStop = mock(() => undefined);

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
      isProcessRunning: () => false,
      readPairingRuntimeSnapshot: () => null,
      renderQRCode: () => "unused",
      resolvedPairingConfig: () => ({
        relay: null,
        secure: true,
        port: 43130,
        workspaceRoot: null,
        sessions: [],
      }),
      startPairingRuntime: async () => ({
        qrPayload: null,
        stop: runtimeStop,
      }),
      startManagedRelay: () => ({
        relayUrl: "ws://managed",
        stop: relayStop,
      }),
      trustedPeerCount: () => 0,
      loadOrCreateIdentity: () => ({
        publicKey: new Uint8Array([1, 2, 3]),
      }),
      bytesToHex: () => "0102030405060708",
      PAIRING_QR_TTL_MS: 300_000,
    }));

    const { startScoutPairingSession } = await import("./service.ts");
    const events: any[] = [];

    await expect(startScoutPairingSession({
      onEvent: (event) => {
        events.push(event);
      },
    })).rejects.toThrow("Scout did not produce a pairing QR payload.");

    expect(events).toEqual([
      {
        type: "status",
        status: "error",
        detail: "Scout did not produce a pairing QR payload.",
      },
    ]);
    expect(runtimeStop.mock.calls).toHaveLength(1);
    expect(relayStop.mock.calls).toHaveLength(1);
  });
});
