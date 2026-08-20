// Pairing relay — lightweight WebSocket forwarder.
//
// The relay knows nothing about Pairing primitives, adapters, or sessions.
// It maintains "rooms" identified by a room ID. Each room has one bridge
// and any number of phone clients. Client sockets are individually addressed
// toward the bridge so it can maintain a separate Noise transport per device.
//
// All payloads are opaque — the relay forwards them verbatim.  When E2E
// encryption is added, the relay sees only ciphertext.

import type { ServerWebSocket } from "bun";

interface Room {
  bridge: ServerWebSocket<SocketData> | null;
  clients: Map<string, ServerWebSocket<SocketData>>;
  /** Grace timer — keeps the room alive briefly after the bridge disconnects. */
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface SocketData {
  roomId: string;
  role: "bridge" | "client";
  clientId?: string;
}

interface RelayEnvelope {
  phase: "relay";
  event: "message" | "close";
  clientId: string;
  payload?: string;
  code?: number;
  reason?: string;
}

const BRIDGE_ABSENCE_GRACE_MS = 30_000;
const ROOM_IDLE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export interface RelayOptions {
  tls?: {
    cert: string;  // path to .crt file
    key: string;   // path to .key file
  };
}

export function startRelay(port: number, options: RelayOptions = {}): { stop: () => void } {
  const rooms = new Map<string, Room>();
  // Index: bridge public key → room ID (for resolve lookups).
  const roomByBridgeKey = new Map<string, string>();

  const server = Bun.serve<SocketData>({
    port,
    hostname: "0.0.0.0",
    ...(options.tls
      ? {
          tls: {
            cert: Bun.file(options.tls.cert),
            key: Bun.file(options.tls.key),
          },
        }
      : {}),
    fetch(req, server) {
      const url = new URL(req.url);

      // -- HTTP resolve endpoint ----------------------------------------------
      // POST /resolve  { "bridgePublicKey": "hex..." }
      // Returns { "room": "uuid" } if the bridge is currently connected.
      // This lets the phone find the bridge's current room after a bridge restart.
      if (url.pathname === "/resolve" && req.method === "POST") {
        return handleResolve(req, roomByBridgeKey, rooms);
      }

      // -- HTTP health endpoint -----------------------------------------------
      // GET /healthz?bridgePublicKey=hex...
      // Returns relay reachability plus best-effort bridge presence for the key.
      if (url.pathname === "/healthz" && req.method === "GET") {
        return handleHealthz(url, roomByBridgeKey, rooms);
      }

      // -- WebSocket upgrade --------------------------------------------------
      const roomId = url.searchParams.get("room");
      const role = url.searchParams.get("role") as "bridge" | "client" | null;
      const bridgeKey = url.searchParams.get("key"); // bridge sends its public key

      if (!roomId || !role || !["bridge", "client"].includes(role)) {
        return new Response("Missing ?room=ID&role=bridge|client", { status: 400 });
      }

      // Register bridge public key → room mapping before upgrade.
      if (role === "bridge" && bridgeKey) {
        roomByBridgeKey.set(bridgeKey, roomId);
      }

      const upgraded = server.upgrade(req, {
        data: role === "client"
          ? { roomId, role, clientId: crypto.randomUUID() }
          : { roomId, role },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
    },

    websocket: {
      open(ws) {
        const { roomId, role } = ws.data;
        let room = rooms.get(roomId);

        if (!room) {
          room = { bridge: null, clients: new Map() };
          rooms.set(roomId, room);
        }

        // Clear any pending cleanup — someone joined.
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        if (role === "bridge") {
          if (room.bridge) {
            // Replace stale bridge connection.
            room.bridge.close(4001, "Replaced by new bridge");
          }
          room.bridge = ws;
          console.log(`[relay] bridge joined room ${roomId}`);
        } else {
          if (!ws.data.clientId) {
            ws.close(4000, "Missing client id");
            return;
          }
          room.clients.set(ws.data.clientId, ws);
          console.log(`[relay] client joined room ${roomId} (${room.clients.size} clients)`);
        }
      },

      message(ws, data) {
        const { roomId, role } = ws.data;
        const room = rooms.get(roomId);
        if (!room) return;

        if (role === "bridge") {
          const envelope = parseRelayEnvelope(data);
          if (!envelope) return;

          if (envelope.event === "close") {
            room.clients.get(envelope.clientId)?.close(
              envelope.code ?? 1000,
              envelope.reason ?? "Bridge requested close",
            );
            return;
          }

          if (!envelope.payload) return;
          room.clients.get(envelope.clientId)?.send(envelope.payload);
        } else {
          const clientId = ws.data.clientId;
          if (!clientId || room.clients.get(clientId) !== ws) {
            return;
          }
          room.bridge?.send(JSON.stringify({
            phase: "relay",
            event: "message",
            clientId,
            payload: relayPayload(data),
          } satisfies RelayEnvelope));
        }
      },

      close(ws) {
        const { roomId, role } = ws.data;
        const room = rooms.get(roomId);
        if (!room) return;

        if (role === "bridge") {
          if (room.bridge === ws) {
            room.bridge = null;
            console.log(`[relay] bridge left room ${roomId}`);

            // Grace period — keep room alive for reconnect.
            room.cleanupTimer = setTimeout(() => {
              // Notify clients that the bridge is gone.
              for (const client of room.clients.values()) {
                client.close(4004, "Bridge absent");
              }
              // Clean up bridge key index.
              for (const [key, rid] of roomByBridgeKey) {
                if (rid === roomId) roomByBridgeKey.delete(key);
              }
              rooms.delete(roomId);
              console.log(`[relay] room ${roomId} cleaned up (bridge absent)`);
            }, BRIDGE_ABSENCE_GRACE_MS);
          }
        } else {
          const clientId = ws.data.clientId;
          if (clientId && room.clients.get(clientId) === ws) {
            room.clients.delete(clientId);
            console.log(`[relay] client left room ${roomId} (${room.clients.size} clients)`);
            room.bridge?.send(JSON.stringify({
              phase: "relay",
              event: "close",
              clientId,
            } satisfies RelayEnvelope));
          }

          // If room is empty (no bridge, no clients), schedule cleanup.
          if (!room.bridge && room.clients.size === 0) {
            room.cleanupTimer = setTimeout(() => {
              for (const [key, rid] of roomByBridgeKey) {
                if (rid === roomId) roomByBridgeKey.delete(key);
              }
              rooms.delete(roomId);
              console.log(`[relay] room ${roomId} cleaned up (idle)`);
            }, ROOM_IDLE_TIMEOUT_MS);
          }
        }
      },
    },
  });

  const scheme = options.tls ? "wss" : "ws";
  console.log(`[relay] listening on ${scheme}://localhost:${port}`);
  console.log(`[relay] resolve endpoint: ${scheme}://localhost:${port}/resolve`);

  return {
    stop() {
      // Clean up all rooms.
      for (const [, room] of rooms) {
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        room.bridge?.close(1001, "Relay shutting down");
        for (const client of room.clients.values()) {
          client.close(1001, "Relay shutting down");
        }
      }
      rooms.clear();
      roomByBridgeKey.clear();
      server.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Resolve handler — phone looks up bridge's current room by public key
// ---------------------------------------------------------------------------

async function handleResolve(
  req: Request,
  roomByBridgeKey: Map<string, string>,
  rooms: Map<string, Room>,
): Promise<Response> {
  try {
    const body = await req.json() as { bridgePublicKey?: string };
    const key = body.bridgePublicKey;

    if (!key || typeof key !== "string") {
      return Response.json({ error: "missing bridgePublicKey" }, { status: 400 });
    }

    const roomId = roomByBridgeKey.get(key);
    if (!roomId) {
      return Response.json({ error: "bridge not found" }, { status: 404 });
    }

    // Verify the bridge is actually connected in that room.
    const room = rooms.get(roomId);
    if (!room?.bridge) {
      return Response.json({ error: "bridge not connected" }, { status: 404 });
    }

    console.log(`[relay] resolved bridge ${key.slice(0, 12)}... → room ${roomId}`);
    return Response.json({ room: roomId });
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
}

function handleHealthz(
  url: URL,
  roomByBridgeKey: Map<string, string>,
  rooms: Map<string, Room>,
): Response {
  const bridgePublicKey = url.searchParams.get("bridgePublicKey")?.trim() || null;
  const roomId = bridgePublicKey ? roomByBridgeKey.get(bridgePublicKey) ?? null : null;
  const room = roomId ? rooms.get(roomId) ?? null : null;
  const bridgeConnected = Boolean(room?.bridge);

  return Response.json({
    ok: true,
    ts: Date.now(),
    bridgePublicKey,
    bridgeConnected,
    roomId: bridgeConnected ? roomId : null,
  });
}

function relayPayload(data: string | Buffer<ArrayBufferLike> | Uint8Array): string {
  if (typeof data === "string") {
    return data;
  }
  return new TextDecoder().decode(data);
}

function parseRelayEnvelope(data: string | Buffer<ArrayBufferLike> | Uint8Array): RelayEnvelope | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as Partial<RelayEnvelope>;
    if (parsed.phase !== "relay" || typeof parsed.clientId !== "string") {
      return null;
    }
    if (parsed.event !== "message" && parsed.event !== "close") {
      return null;
    }
    return {
      phase: "relay",
      event: parsed.event,
      clientId: parsed.clientId,
      payload: typeof parsed.payload === "string" ? parsed.payload : undefined,
      code: typeof parsed.code === "number" ? parsed.code : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}
