import { afterEach, expect, test } from "bun:test";
import { createScoutPairingBridgeClient } from "./pairing.ts";
import { startBridgeServerTRPC } from "./core/pairing/runtime/bridge/server-trpc.ts";
import type { Bridge } from "./core/pairing/runtime/bridge/bridge.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

test("status clients request no event stream and release the connection", async () => {
  let eventSubscriptions = 0;
  const bridge = {
    listSessions: () => [],
    getSessionSummaries: () => [],
    onEvent: () => { eventSubscriptions++; return () => {}; },
  } as unknown as Bridge;
  // The bridge helper does not expose its chosen ephemeral port.
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const server = startBridgeServerTRPC({ bridge, port, secure: false });
  cleanup.push(() => server.stop());
  for (let i = 0; i < 10; i++) {
    const client = await createScoutPairingBridgeClient(port);
    try {
      const result = await client.query<{ sessions: unknown[] }>("bridgeStatus");
      expect(result.sessions).toEqual([]);
    } finally { client.close(); }
  }
  expect(eventSubscriptions).toBe(0);
});

test("a timed-out handshake closes even when the server accepts it late", async () => {
  let live = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req, server) {
      await Bun.sleep(1800);
      return server.upgrade(req) ? undefined : new Response("closed", { status: 400 });
    },
    websocket: {
      open() { live++; },
      close() { live--; },
      message() {},
    },
  });
  cleanup.push(() => server.stop(true));
  await expect(createScoutPairingBridgeClient(server.port!)).rejects.toThrow("Timed out connecting");
  await Bun.sleep(500);
  expect(live).toBe(0);
  expect(server.pendingWebSockets).toBe(0);
});

test("connection refusal rejects without waiting for the connection timeout", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  await expect(createScoutPairingBridgeClient(port)).rejects.toThrow("Unable to connect");
});

function startLimitedBridge(connectionLimits: Parameters<typeof startBridgeServerTRPC>[0]["connectionLimits"]) {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const bridge = { listSessions: () => [], getSessionSummaries: () => [] } as unknown as Bridge;
  const server = startBridgeServerTRPC({ bridge, port, connectionLimits });
  cleanup.push(() => server.stop());
  return port;
}

async function openStatusSocket(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}?events=0`);
  cleanup.push(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("connection failed"));
  });
  return socket;
}

test("server expires abandoned status sockets even if clients never close them", async () => {
  const port = startLimitedBridge({ queryLifetimeMs: 50, closeGraceMs: 50 });
  const socket = await openStatusSocket(port);
  const closed = await new Promise<CloseEvent>((resolve) => { socket.onclose = resolve; });
  expect(closed.code).toBe(1008);
  expect(closed.reason).toBe("Status connection expired");
  let connections = 1;
  const deadline = Date.now() + 500;
  while (connections && Date.now() < deadline) {
    await Bun.sleep(10);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { connections: number };
    connections = health.connections;
  }
  expect(connections).toBe(0);
});

test("connection admission is bounded and recovers after a client disconnects", async () => {
  const port = startLimitedBridge({ maxConnections: 2 });
  const a = await openStatusSocket(port);
  await openStatusSocket(port);
  const denied = new WebSocket(`ws://127.0.0.1:${port}?events=0`);
  cleanup.push(() => denied.close());
  const accepted = await new Promise<boolean>((resolve) => {
    denied.onopen = () => resolve(true);
    denied.onerror = () => resolve(false);
  });
  expect(accepted).toBe(false);
  await new Promise<void>((resolve) => { a.onclose = () => resolve(); a.close(); });
  const replacement = await openStatusSocket(port);
  expect(replacement.readyState).toBe(WebSocket.OPEN);
});

test("concurrent snapshot polls use one connection and later polls refresh", async () => {
  const { loadScoutPairingSessionSnapshots } = await import("./pairing.ts");
  let connections = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response(); },
    websocket: {
      open() { connections++; },
      message(ws, raw) {
        const req = JSON.parse(String(raw));
        ws.send(JSON.stringify({ id: req.id, result: { type: "data", data: { sessions: [] } } }));
      },
    },
  });
  cleanup.push(() => server.stop(true));
  await Promise.all(Array.from({ length: 100 }, () => loadScoutPairingSessionSnapshots(server.port!)));
  expect(connections).toBe(1);
  await loadScoutPairingSessionSnapshots(server.port!);
  expect(connections).toBe(2);
});

test("incomplete secure handshakes cannot retain a connection indefinitely", async () => {
  const { generateKeyPair } = await import("./core/pairing/runtime/security/index.ts");
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const server = startBridgeServerTRPC({
    bridge: {} as Bridge, port, secure: true, identity: generateKeyPair(),
    connectionLimits: { handshakeTimeoutMs: 50 },
  });
  cleanup.push(() => server.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  cleanup.push(() => socket.close());
  const closed = await new Promise<CloseEvent>((resolve) => { socket.onclose = resolve; });
  expect(closed.code).toBe(1008);
  expect(closed.reason).toBe("Handshake timed out");
});

test("expired clients cannot hold a slot by ignoring the close handshake", async () => {
  const { connect } = await import("node:net");
  const port = startLimitedBridge({ queryLifetimeMs: 30, closeGraceMs: 30 });
  const socket = connect(port, "127.0.0.1");
  cleanup.push(() => socket.destroy());
  let upgraded = false;
  await new Promise<void>((resolve, reject) => {
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("expired socket retained")); });
    socket.on("error", reject);
    socket.on("data", (data) => {
      if (data.toString().includes("101 Switching Protocols")) upgraded = true;
      // Deliberately never acknowledge the server's WebSocket close frame.
    });
    socket.on("close", () => resolve());
    socket.on("connect", () => socket.write(
      `GET /?events=0 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ));
  });
  expect(upgraded).toBe(true);
});
