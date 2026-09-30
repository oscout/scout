import { describe, expect, test } from "bun:test";
import {
  stubs,
  createOpenScoutWebServer,
  makePairingState,
  makeStaticRoot,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: pairing routes", () => {
  test("requires and atomically consumes approval for direct LAN pairing", async () => {
    const qrValue = JSON.stringify({
      v: 1,
      relay: "ws://192.168.18.14:43131",
      room: "room-approved",
      publicKey: "b".repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    stubs.pairingStateResult = makePairingState({
      pairing: {
        relay: "ws://192.168.18.14:43131",
        room: "room-approved",
        publicKey: "b".repeat(64),
        expiresAt: Date.now() + 60_000,
        qrArt: "",
        qrValue,
      },
    });
    let peerAddress = "192.168.18.201";
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      lanAccessScope: "pairing",
      resolvePeerAddress: () => peerAddress,
    });

    const knock = await server.app.request("http://localhost/pair?route=lan", {
      headers: {
        accept: "application/json",
        "x-forwarded-for": "198.51.100.77",
      },
      redirect: "manual",
    });
    expect(knock.status).toBe(202);
    expect(knock.headers.get("location")).toBeNull();
    expect(stubs.getPairingStateCalls).toBeGreaterThan(0);
    expect(stubs.refreshPairingStateCalls).toBe(0);
    const { token } = await knock.json() as { token: string };

    const pendingPoll = await server.app.request(`http://localhost/pair?route=lan&token=${token}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    expect(pendingPoll.status).toBe(202);
    await expect(pendingPoll.json()).resolves.toMatchObject({ status: "pending", token });

    peerAddress = "127.0.0.1";
    const listed = await server.app.request("http://localhost/api/pairing/requests");
    const listedBody = await listed.json() as {
      requests: Array<{ token: string; requesterIp: string | null }>;
    };
    expect(listedBody.requests.find((request) => request.token === token)?.requesterIp)
      .toBe("192.168.18.201");
    const approval = await server.app.request(`http://localhost/api/pairing/requests/${token}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(approval.status).toBe(200);

    peerAddress = "192.168.18.201";
    const delivered = await server.app.request(`http://localhost/pair?route=lan&token=${token}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    expect(delivered.status).toBe(302);
    expect(delivered.headers.get("location"))
      .toBe(`scout://pair?payload=${encodeURIComponent(qrValue)}`);

    const replay = await server.app.request(`http://localhost/pair?route=lan&token=${token}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    expect(replay.status).toBe(410);
    await server.stop();
  });

  test("keeps denied LAN sources denied without minting another request", async () => {
    stubs.pairingStateResult = makePairingState({ pairing: null });
    let peerAddress = "192.168.18.202";
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      lanAccessScope: "pairing",
      resolvePeerAddress: () => peerAddress,
    });

    const knock = await server.app.request("http://localhost/pair", {
      headers: { accept: "application/json" },
    });
    const { token } = await knock.json() as { token: string };
    peerAddress = "127.0.0.1";
    const denial = await server.app.request(`http://localhost/api/pairing/requests/${token}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(denial.status).toBe(200);

    peerAddress = "192.168.18.202";
    const retry = await server.app.request("http://localhost/pair", {
      headers: { accept: "application/json" },
    });
    expect(retry.status).toBe(403);
    await expect(retry.json()).resolves.toEqual({ status: "denied", token });
    await server.stop();
  });

  test("does not let a loopback reverse proxy bypass LAN approval", async () => {
    stubs.pairingStateResult = makePairingState({ pairing: { qrValue: "proxied-live-secret" } });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      lanAccessScope: "pairing",
      resolvePeerAddress: () => "127.0.0.1",
    });

    const response = await server.app.request("http://localhost/pair", {
      headers: {
        accept: "application/json",
        // A trusted edge appends the authoritative peer at the right. The
        // caller-controlled first hop must not become the dedupe identity.
        "x-forwarded-for": "198.51.100.77, 192.168.18.204",
      },
      redirect: "manual",
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBeNull();
    const { token } = await response.json() as { token: string };
    const listed = await server.app.request("http://localhost/api/pairing/requests");
    const body = await listed.json() as {
      requests: Array<{ token: string; requesterIp: string | null }>;
    };
    expect(body.requests.find((request) => request.token === token)?.requesterIp)
      .toBe("192.168.18.204");
    await server.stop();
  });

  test("GET /pair does not require an operator credential and records the client app", async () => {
    stubs.pairingStateResult = makePairingState({ pairing: null });
    let peerAddress = "192.168.18.211";
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      resolvePeerAddress: () => peerAddress,
    });

    const response = await server.app.request("http://localhost/pair?route=lan", {
      headers: {
        accept: "application/json",
        "x-scout-client": "scout-ios",
        "x-scout-device-name": "Arts iPhone",
      },
    });

    expect(response.status).toBe(202);
    const body = await response.json() as { status: string; token: string };
    expect(body.status).toBe("pending");
    expect(body.token).toBeTruthy();

    peerAddress = "127.0.0.1";
    const listed = await server.app.request("http://localhost/api/pairing/requests");
    expect(listed.status).toBe(200);
    const payload = await listed.json() as {
      requests: Array<{ requesterApp?: string; requesterLabel?: string }>;
    };
    expect(payload.requests[0]?.requesterApp).toBe("scout-ios");
    expect(payload.requests[0]?.requesterLabel).toBe("Arts iPhone");
  });
});
