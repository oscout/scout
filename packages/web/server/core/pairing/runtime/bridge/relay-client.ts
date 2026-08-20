// Relay client — connects the bridge OUTBOUND to a relay server.
//
// This lets phones and tablets reach the bridge when they're not on the same
// LAN. The bridge connects to the relay as the "bridge" role, and each mobile
// device connects as a "client". The relay assigns each client socket a relay
// id, and the bridge keeps a distinct Noise transport per relay client so
// reconnects or multiple devices cannot corrupt one another's cipher state.
//
// The bridge is the Noise "responder" — the phone initiates the handshake
// because it scanned the QR code containing the bridge's public key.

import type { Bridge } from "./bridge.ts";
import { handleRPC } from "./server.ts";
import { bridgeRouter } from "./router.ts";
import { callTRPCProcedure, getErrorShape, TRPCError } from "@trpc/server";
import { log } from "./log.ts";
import {
  watchScoutMessages,
  type ScoutBrokerConversationLifecycleRecord,
  type ScoutBrokerMessageRecord,
} from "../../../broker/service.ts";
import {
  SecureTransport,
  type SocketLike,
  type KeyPair,
  type QRPayload,
  createQRPayload,
  bytesToHex,
} from "../security/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelayClientOptions {
  /** Enable Noise encryption on the relay connection. Default: true. */
  secure?: boolean;
  /** Relay URL advertised to phones. Defaults to the URL used by the bridge. */
  publicRelayUrl?: string;
  /** Additional relay URLs phones should try after the advertised primary. */
  fallbackRelayUrls?: string[];
  /** Shared QR payload when one bridge joins multiple relay servers. */
  qrPayload?: QRPayload;
  /** Optional lifecycle callbacks for status surfaces. */
  events?: RelayEventHandlers;
}

export interface RelayConnection {
  /** QR payload for the phone to scan — contains relay URL, room ID, bridge public key. */
  qrPayload: QRPayload;
  /** Disconnect from the relay and stop reconnecting. */
  disconnect: () => void;
}

export interface RelayEventHandlers {
  onConnecting?: (detail: { relayUrl: string; room: string }) => void;
  onConnected?: (detail: { relayUrl: string; room: string }) => void;
  onPaired?: (detail: { relayUrl: string; room: string; remotePublicKey: Uint8Array }) => void;
  onError?: (detail: { relayUrl: string; room: string; error: Error }) => void;
  onClosed?: (detail: { relayUrl: string; room: string; code: number; reason: string }) => void;
  onReconnectScheduled?: (detail: { relayUrl: string; room: string; delayMs: number }) => void;
}

interface RelayEnvelope {
  phase: "relay";
  event: "message" | "close";
  clientId: string;
  payload?: string;
  code?: number;
  reason?: string;
}

interface RelayPeerState {
  clientId: string;
  transport: SecureTransport;
  deviceId?: string;
  trustedPeer?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const LEGACY_CLIENT_ID = "__legacy__";

function mobileConversationChangedEvent(message: ScoutBrokerMessageRecord) {
  const rawClientMessageId = message.metadata?.clientMessageId;
  const clientMessageId = typeof rawClientMessageId === "string" && rawClientMessageId.trim().length > 0
    ? rawClientMessageId.trim()
    : null;
  return {
    event: "mobile:conversation:changed" as const,
    conversationId: message.conversationId,
    messageId: message.id,
    clientMessageId,
  };
}

function mobileConversationLifecycleEvent(lifecycle: ScoutBrokerConversationLifecycleRecord) {
  return {
    event: "mobile:conversation:lifecycle" as const,
    conversationId: lifecycle.conversationId,
    messageId: lifecycle.messageId ?? null,
    clientMessageId: lifecycle.clientMessageId ?? null,
    invocationId: lifecycle.invocationId ?? null,
    flightId: lifecycle.flightId ?? null,
    targetAgentId: lifecycle.targetAgentId ?? null,
    lifecycleState: lifecycle.state,
    summary: lifecycle.summary ?? null,
    error: lifecycle.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect the bridge to a relay server for remote mobile access.
 *
 * Returns a QR payload (to display / encode for the phone) and a disconnect
 * function. The connection auto-reconnects with exponential backoff.
 */
export function connectToRelay(
  relayUrl: string,
  identity: KeyPair,
  bridge: Bridge,
  options: RelayClientOptions = {},
): RelayConnection {
  const { secure = true, events } = options;
  const eventRelayUrl = options.publicRelayUrl?.trim() || relayUrl;
  const qrPayload = options.qrPayload
    ?? createQRPayload(identity.publicKey, eventRelayUrl, options.fallbackRelayUrls);

  let ws: WebSocket | null = null;
  let eventUnsub: (() => void) | null = null;
  let brokerWatchAbort: AbortController | null = null;
  let stopped = false;
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const securePeers = new Map<string, RelayPeerState>();
  const plaintextClients = new Set<string>();

  function connect(): void {
    if (stopped) return;

    const bridgeKeyHex = bytesToHex(identity.publicKey);
    const url = buildRelayUrl(relayUrl, qrPayload.room, bridgeKeyHex);
    console.log(`[relay-client] connecting to relay (room: ${qrPayload.room})`);
    events?.onConnecting?.({ relayUrl: eventRelayUrl, room: qrPayload.room });

    ws = new WebSocket(url, relayWebSocketOptions(relayUrl) as never);

    ws.addEventListener("open", () => {
      console.log(`[relay-client] connected to relay (room: ${qrPayload.room})`);
      backoff = INITIAL_BACKOFF_MS;
      events?.onConnected?.({ relayUrl: eventRelayUrl, room: qrPayload.room });
    });

    ws.addEventListener("message", (event) => {
      handleRelaySocketMessage(event.data);
    });

    ws.addEventListener("close", (event) => {
      console.log(`[relay-client] disconnected (code: ${event.code}, reason: ${event.reason})`);
      events?.onClosed?.({
        relayUrl: eventRelayUrl,
        room: qrPayload.room,
        code: event.code,
        reason: event.reason,
      });
      cleanup();
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      const error = new Error("Relay websocket error");
      console.error("[relay-client] connection error");
      events?.onError?.({ relayUrl: eventRelayUrl, room: qrPayload.room, error });
      // The close event will fire after this, triggering reconnect.
    });
  }

  function handleRelaySocketMessage(raw: unknown): void {
    const envelope = parseRelayEnvelope(raw);

    if (!secure) {
      handlePlaintextRelayMessage(envelope, raw);
      return;
    }

    if (!envelope) {
      const payload = asStringPayload(raw);
      if (!payload) return;
      routeSecurePayload(LEGACY_CLIENT_ID, payload);
      return;
    }

    if (envelope.event === "close") {
      teardownSecurePeer(envelope.clientId);
      return;
    }

    if (!envelope.payload) {
      return;
    }

    routeSecurePayload(envelope.clientId, envelope.payload);
  }

  function routeSecurePayload(clientId: string, payload: string): void {
    let peer = securePeers.get(clientId);
    const handshakePattern = detectHandshakePattern(payload);

    if (handshakePattern && (!peer || peer.transport.isReady())) {
      teardownSecurePeer(clientId);
      peer = createSecurePeer(clientId, handshakePattern);
    }

    peer?.transport.receive(payload);
  }

  function createSecurePeer(clientId: string, pattern?: "XX" | "IK"): RelayPeerState | undefined {
    if (!ws) return undefined;

    const peer: RelayPeerState = {
      clientId,
      transport: undefined as unknown as SecureTransport,
      deviceId: undefined,
      trustedPeer: false,
    };

    const socketAdapter: SocketLike = {
      send: (data) => {
        sendRelayMessage(clientId, data);
      },
    };

    const transport = new SecureTransport(
      socketAdapter,
      "responder",
      identity,
      {
        onReady: (remotePublicKey, readyInfo) => {
          const pubHex = bytesToHex(remotePublicKey);
          peer.deviceId = pubHex.slice(0, 16);
          peer.trustedPeer = readyInfo.trustedPeer;
          replaceOlderPeerForSameDevice(peer);
          ensureBridgeEventSubscription();
          ensureBrokerMessageSubscription();
          console.log(
            `[relay-client] secure handshake complete (peer: ${pubHex.slice(0, 12)}..., trusted: ${peer.trustedPeer}, device: ${peer.deviceId}, client: ${clientId})`,
          );
          events?.onPaired?.({ relayUrl: eventRelayUrl, room: qrPayload.room, remotePublicKey });
          sendExistingSessions((json) => {
            if (peer.transport.isReady()) {
              peer.transport.send(json);
            }
          });
        },

        onMessage: (message) => {
          handleIncomingRPC(peer, message);
        },

        onError: (err) => {
          console.error("[relay-client] secure transport error:", err.message);
          log.error("trns:cry", `decrypt failed for ${clientId} — resetting handshake: ${err.message}`);
          events?.onError?.({ relayUrl: eventRelayUrl, room: qrPayload.room, error: err });
          sendRelayClose(clientId, 4002, "Transport reset");
          teardownSecurePeer(clientId);
        },

        onClose: () => {
          teardownSecurePeer(clientId);
        },
      },
      pattern ? { pattern } : undefined,
    );

    peer.transport = transport;
    securePeers.set(clientId, peer);
    return peer;
  }

  function replaceOlderPeerForSameDevice(peer: RelayPeerState): void {
    if (!peer.deviceId) return;

    for (const [otherClientId, otherPeer] of securePeers) {
      if (otherClientId === peer.clientId || otherPeer.deviceId !== peer.deviceId) {
        continue;
      }
      sendRelayClose(otherClientId, 4001, "Replaced by newer connection");
      teardownSecurePeer(otherClientId);
    }
  }

  function teardownSecurePeer(clientId: string): void {
    if (!securePeers.has(clientId)) {
      return;
    }
    securePeers.delete(clientId);
    maybeReleaseMobileSubscriptions();
  }

  function handlePlaintextRelayMessage(envelope: RelayEnvelope | null, raw: unknown): void {
    if (envelope?.event === "close") {
      plaintextClients.delete(envelope.clientId);
      maybeReleaseMobileSubscriptions();
      return;
    }

    const clientId = envelope?.clientId ?? LEGACY_CLIENT_ID;
    const payload = envelope?.payload ?? asStringPayload(raw);
    if (!payload) return;

    const isNewClient = !plaintextClients.has(clientId);
    plaintextClients.add(clientId);
    ensureBridgeEventSubscription();
    ensureBrokerMessageSubscription();

    if (isNewClient) {
      sendExistingSessions((json) => sendRelayMessage(clientId, json));
    }

    handlePlaintextMessage(clientId, payload);
  }

  function ensureBridgeEventSubscription(): void {
    if (eventUnsub) return;

    eventUnsub = bridge.onEvent((sequenced) => {
      const json = JSON.stringify({
        seq: sequenced.seq,
        event: sequenced.event,
      });

      broadcastToMobileClients(json);
    });
  }

  function ensureBrokerMessageSubscription(): void {
    if (brokerWatchAbort) return;

    const abort = new AbortController();
    brokerWatchAbort = abort;
    void watchScoutMessages({
      allConversations: true,
      signal: abort.signal,
      onMessage(message) {
        broadcastToMobileClients(JSON.stringify(mobileConversationChangedEvent(message)));
      },
      onLifecycle(lifecycle) {
        broadcastToMobileClients(JSON.stringify(mobileConversationLifecycleEvent(lifecycle)));
      },
    }).catch((error) => {
      if (abort.signal.aborted) return;
      log.warn(
        "broker",
        "Broker message invalidation stream ended unexpectedly",
        { error: error instanceof Error ? error.message : String(error) },
      );
      if (brokerWatchAbort === abort) brokerWatchAbort = null;
    });
  }

  function maybeReleaseMobileSubscriptions(): void {
    if (secure ? securePeers.size > 0 : plaintextClients.size > 0) {
      return;
    }

    eventUnsub?.();
    eventUnsub = null;
    brokerWatchAbort?.abort();
    brokerWatchAbort = null;
  }

  function broadcastToMobileClients(json: string): void {
    if (secure) {
      for (const peer of securePeers.values()) {
        if (peer.transport.isReady()) {
          peer.transport.send(json);
        }
      }
      return;
    }

    for (const clientId of plaintextClients) {
      sendRelayMessage(clientId, json);
    }
  }

  function sendExistingSessions(send: (json: string) => void): void {
    for (const session of bridge.listSessions()) {
      send(JSON.stringify({
        seq: 0,
        event: { event: "session:update", session },
      }));
    }
  }

  async function dispatchTRPC(
    req: any,
    send: (json: string) => void,
    context: { deviceId?: string; secureTransport?: boolean; trustedPeer?: boolean } = {},
  ): Promise<void> {
    const { id, method, params } = req;
    const type = method as "query" | "mutation";
    const path = params?.path;
    const input = params?.input;

    if (!path) {
      send(JSON.stringify({ id, jsonrpc: "2.0", error: { code: -32600, message: "Missing path in params" } }));
      return;
    }

    try {
      const ctx = { bridge, cwd: process.cwd(), ...context };
      const result = await callTRPCProcedure({
        router: bridgeRouter,
        path,
        getRawInput: () => Promise.resolve(input),
        ctx,
        type,
        signal: AbortSignal.timeout(30_000),
        batchIndex: 0,
      });
      send(JSON.stringify({ id, jsonrpc: "2.0", result: { type: "data", data: result } }));
    } catch (cause) {
      const errMsg = cause instanceof Error ? cause.message : String(cause);
      log.error("rpc:err", `✗ ${path} — ${errMsg}`);
      const error = cause instanceof TRPCError ? cause : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause });
      send(JSON.stringify({
        id,
        jsonrpc: "2.0",
        error: getErrorShape({
          config: bridgeRouter._def._config,
          error,
          type,
          path,
          input,
          ctx: undefined,
        }),
      }));
    }
  }

  function handlePlaintextMessage(clientId: string, raw: string): void {
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      sendRelayMessage(clientId, JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    const send = (json: string) => {
      sendRelayMessage(clientId, json);
    };

    if (isTRPCMessage(req)) {
      void dispatchTRPC(req, send);
    } else {
      void handleRPC(bridge, req, undefined).then((res) => send(JSON.stringify(res)));
    }
  }

  function handleIncomingRPC(peer: RelayPeerState, message: string): void {
    let req;
    try {
      req = JSON.parse(message);
    } catch {
      if (peer.transport.isReady()) {
        peer.transport.send(
          JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }),
        );
      }
      return;
    }

    const send = (json: string) => {
      if (peer.transport.isReady()) {
        peer.transport.send(json);
      }
    };

    if (isTRPCMessage(req)) {
      void dispatchTRPC(req, send, {
        deviceId: peer.deviceId,
        secureTransport: true,
        trustedPeer: peer.trustedPeer,
      });
    } else {
      void handleRPC(bridge, req, {
        deviceId: peer.deviceId,
        secureTransport: true,
        trustedPeer: peer.trustedPeer,
      }).then((res) => send(JSON.stringify(res)));
    }
  }

  function isTRPCMessage(req: any): boolean {
    return req.jsonrpc === "2.0" && ["query", "mutation", "subscription", "subscription.stop"].includes(req.method);
  }

  function sendRelayMessage(clientId: string, data: string | Uint8Array): void {
    const payload = asStringPayload(data);
    if (!payload || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({
      phase: "relay",
      event: "message",
      clientId,
      payload,
    } satisfies RelayEnvelope));
  }

  function sendRelayClose(clientId: string, code: number, reason: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({
      phase: "relay",
      event: "close",
      clientId,
      code,
      reason,
    } satisfies RelayEnvelope));
  }

  function cleanup(): void {
    eventUnsub?.();
    eventUnsub = null;
    brokerWatchAbort?.abort();
    brokerWatchAbort = null;
    securePeers.clear();
    plaintextClients.clear();
    ws = null;
  }

  function scheduleReconnect(): void {
    if (stopped) return;

    console.log(`[relay-client] reconnecting in ${backoff}ms...`);
    events?.onReconnectScheduled?.({ relayUrl: eventRelayUrl, room: qrPayload.room, delayMs: backoff });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);

    backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  function disconnect(): void {
    stopped = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const activeWs = ws;
    cleanup();
    activeWs?.close(1000, "Bridge disconnecting");
    console.log("[relay-client] disconnected from relay");
  }

  connect();

  return { qrPayload, disconnect };
}

function relayWebSocketOptions(
  relayUrl: string,
): Bun.WebSocketOptions | undefined {
  if (!relayUrl.startsWith("wss://")) {
    return undefined;
  }

  return {
    tls: {
      rejectUnauthorized: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRelayUrl(baseUrl: string, roomId: string, bridgePublicKey?: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("room", roomId);
  url.searchParams.set("role", "bridge");
  if (bridgePublicKey) {
    url.searchParams.set("key", bridgePublicKey);
  }
  return url.toString();
}

function detectHandshakePattern(payload: string): "XX" | "IK" | null {
  try {
    const wire = JSON.parse(payload) as { phase?: string; payload?: string };
    if (wire.phase !== "handshake" || typeof wire.payload !== "string") {
      return null;
    }
    const handshakePayload = Uint8Array.from(atob(wire.payload), (char) => char.charCodeAt(0));
    return handshakePayload.length > 32 ? "IK" : "XX";
  } catch {
    return null;
  }
}

function parseRelayEnvelope(raw: unknown): RelayEnvelope | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RelayEnvelope>;
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

function asStringPayload(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return new TextDecoder().decode(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw));
  }
  return null;
}
