import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { createScoutMcpServer } from "./scout-mcp.ts";

export interface McpBridgeBoundEnvelope {
  v: 1;
  kind: "mcp_request" | "mcp_cancel";
  id: string;
  agent?: string;
  payload?: string;
}

export interface McpWorkerBoundEnvelope {
  v: 1;
  kind: "mcp_response" | "mcp_accepted" | "mcp_error" | "mcp_notify" | "bridge_ping";
  id: string;
  agent?: string;
  payload?: string;
  status?: number;
  message?: string;
}

export const SCOUT_MCP_CORE_TOOLS = [
  "whoami",
  "ask",
  "messages_send",
  "messages_reply",
  "messages_inbox",
  "messages_channel",
  "broker_feed",
  "tail_events",
  "work_update",
  "notify_operator",
  "consult_operator",
  "current_reply_context",
  "invocations_get",
  "invocations_wait",
  "labels_brief",
  "labels_feed",
  "agents_search",
  "agents_resolve",
] as const;

export function parseBridgeBoundEnvelope(data: unknown): McpBridgeBoundEnvelope | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Partial<McpBridgeBoundEnvelope>;
    if (parsed.v !== 1 || typeof parsed.id !== "string") return null;
    if (parsed.kind !== "mcp_request" && parsed.kind !== "mcp_cancel") return null;
    return {
      v: 1,
      kind: parsed.kind,
      id: parsed.id,
      agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
      payload: typeof parsed.payload === "string" ? parsed.payload : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Server-side MCP Transport fed by relay envelopes instead of a socket the
 * SDK owns. Each inbound JSON-RPC request is tagged with its relay envelope
 * id so the eventual response can be routed back to the exact HTTP request
 * waiting at the Worker.
 */
export class MeshRelayServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private emitEnvelope: (envelope: McpWorkerBoundEnvelope) => void = () => {};
  private readonly envelopeIdByRequestId = new Map<string | number, string>();

  bindEmitter(emit: (envelope: McpWorkerBoundEnvelope) => void): void {
    this.emitEnvelope = emit;
  }

  async start(): Promise<void> {}

  deliver(envelope: McpBridgeBoundEnvelope): void {
    if (envelope.kind === "mcp_cancel") {
      for (const [requestId, envelopeId] of this.envelopeIdByRequestId) {
        if (envelopeId === envelope.id) {
          this.envelopeIdByRequestId.delete(requestId);
        }
      }
      return;
    }

    if (!envelope.payload) {
      this.emitEnvelope({ v: 1, kind: "mcp_error", id: envelope.id, status: 400, message: "empty payload" });
      return;
    }

    let message: JSONRPCMessage;
    try {
      message = JSON.parse(envelope.payload) as JSONRPCMessage;
    } catch {
      this.emitEnvelope({ v: 1, kind: "mcp_error", id: envelope.id, status: 400, message: "invalid JSON-RPC payload" });
      return;
    }

    const record = message as { id?: string | number; method?: string };
    const isRequest = record.method !== undefined && record.id !== undefined;
    if (isRequest && record.id !== undefined) {
      this.envelopeIdByRequestId.set(record.id, envelope.id);
    } else {
      this.emitEnvelope({ v: 1, kind: "mcp_accepted", id: envelope.id });
    }

    try {
      this.onmessage?.(message);
    } catch (error) {
      if (isRequest && record.id !== undefined) {
        this.envelopeIdByRequestId.delete(record.id);
      }
      this.emitEnvelope({
        v: 1,
        kind: "mcp_error",
        id: envelope.id,
        status: 500,
        message: error instanceof Error ? error.message : "handler failure",
      });
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const record = message as { id?: string | number; method?: string };
    if (record.id === undefined) {
      // Server-initiated notification: route to the relay's push stream so
      // a GET SSE listener (2025-era transport) receives it.
      this.emitEnvelope({
        v: 1,
        kind: "mcp_notify",
        id: crypto.randomUUID(),
        payload: JSON.stringify(message),
      });
      return;
    }
    const envelopeId = this.envelopeIdByRequestId.get(record.id);
    if (!envelopeId) {
      if (record.method !== undefined) {
        // Server-initiated request (sampling/elicitation): unsupported here.
        this.onerror?.(new Error(`mesh bridge cannot deliver server-initiated request ${String(record.method)}`));
      }
      return;
    }
    this.envelopeIdByRequestId.delete(record.id);
    this.emitEnvelope({
      v: 1,
      kind: "mcp_response",
      id: envelopeId,
      payload: JSON.stringify(message),
    });
  }

  async close(): Promise<void> {
    this.envelopeIdByRequestId.clear();
    this.onclose?.();
  }
}

export interface ScoutMeshMcpBridgeOptions {
  relayUrl: string;
  token: string;
  /** Fallback identity for envelopes that carry no agent (dev/back-compat). */
  senderId: string;
  currentDirectory: string;
  toolNames: string[];
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface ScoutMeshMcpBridgeHandle {
  close(): Promise<void>;
}

export interface ScoutMeshBridgeConfigFile {
  relayUrl: string;
  token?: string;
  tokenKeychainService?: string;
  sender?: string;
  node?: string;
  tools?: string[] | "core";
  dir?: string;
}

export function readKeychainSecret(service: string): string | null {
  const result = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"]);
  if (result.exitCode !== 0) return null;
  const value = result.stdout.toString().trim();
  return value || null;
}

export function resolveBridgeTokenFromConfig(config: ScoutMeshBridgeConfigFile): string | null {
  if (config.token?.trim()) return config.token.trim();
  if (config.tokenKeychainService?.trim()) {
    return readKeychainSecret(config.tokenKeychainService.trim());
  }
  return null;
}

const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_IDENTITY_INSTANCES = 16;
// The relay's Durable Object can lose the socket without a close frame
// reaching either side (idle eviction, NAT drop). Pings keep the tunnel
// non-idle; a silent relay past the stale window forces a reconnect.
const BRIDGE_PING_INTERVAL_MS = 20_000;
const BRIDGE_STALE_MS = 60_000;

export function resolveBridgeWebSocketUrl(relayUrl: string, token: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (!url.pathname.endsWith("/bridge")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/bridge`;
  }
  if (!url.searchParams.get("access_token")) {
    url.searchParams.set("access_token", token);
  }
  return url.toString();
}

export async function startScoutMeshMcpBridge(
  options: ScoutMeshMcpBridgeOptions,
): Promise<ScoutMeshMcpBridgeHandle> {
  const log = options.log ?? (() => {});
  const allowedTools = new Set(options.toolNames);

  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const sendRaw = (envelope: McpWorkerBoundEnvelope) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
    } else {
      log(`bridge: dropped ${envelope.kind} for ${envelope.id} (socket not open)`);
    }
  };

  // One MCP server instance per remote agent identity: the identity from
  // the envelope is pinned as the Scout sender for every call that
  // instance serves, and its notifications route back to that identity's
  // push stream.
  const instances = new Map<string, { server: { close(): Promise<void> }; transport: MeshRelayServerTransport }>();
  const getOrCreateInstance = async (agent: string) => {
    const existing = instances.get(agent);
    if (existing) return existing;
    if (instances.size >= MAX_IDENTITY_INSTANCES) {
      return null;
    }
    const transport = new MeshRelayServerTransport();
    transport.bindEmitter((envelope) => {
      sendRaw(envelope.kind === "mcp_notify" ? { ...envelope, agent } : envelope);
    });
    const server = createScoutMcpServer({
      defaultCurrentDirectory: options.currentDirectory,
      env: {
        ...(options.env ?? process.env),
        OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1",
      },
      dependencies: {
        resolveSenderId: async () => agent,
      },
      toolFilter: (name) => allowedTools.has(name),
    });
    await server.connect(transport);
    const instance = { server, transport };
    instances.set(agent, instance);
    log(`bridge: serving identity ${agent} (${instances.size} active)`);
    return instance;
  };

  const wsUrl = resolveBridgeWebSocketUrl(options.relayUrl, options.token);

  const scheduleReconnect = () => {
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * 2 ** attempt)
      + Math.floor(Math.random() * 500);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
    return delay;
  };

  const connect = () => {
    if (closed) return;
    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${options.token}` },
    } as unknown as string[]);
    socket = ws;
    let lastFrameAt = Date.now();
    let openedAt = Date.now();
    let abandoned = false;
    let pingCount = 0;

    const forceReconnect = (reason: string) => {
      if (closed || abandoned) return;
      abandoned = true;
      clearInterval(heartbeat);
      if (socket === ws) socket = null;
      try {
        ws.close(4002, "bridge reconnect");
      } catch {
        // Half-open sockets may refuse a close handshake; reconnect regardless.
      }
      const delay = scheduleReconnect();
      log(`bridge: ${reason}; reconnecting in ${Math.round(delay / 1000)}s`);
    };

    const heartbeat = setInterval(() => {
      if (closed || abandoned || socket !== ws) {
        clearInterval(heartbeat);
        return;
      }
      if (Date.now() - lastFrameAt > BRIDGE_STALE_MS) {
        forceReconnect(`relay silent for ${Math.round(BRIDGE_STALE_MS / 1000)}s`);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      // Byte-for-byte constant so the relay's WebSocket auto-response can
      // answer without waking the hibernated Durable Object (mcp-relay.ts
      // mirrors this literal).
      ws.send("{\"v\":1,\"kind\":\"bridge_ping\",\"id\":\"hb\"}");
      pingCount += 1;
      // Pongs only prove SOME relay instance holds this socket — during a
      // Worker deploy the old Durable Object can linger and keep answering
      // while new requests route to a fresh instance with no bridge. Ask the
      // routable instance over HTTPS whether it actually sees a bridge.
      if (pingCount % 3 === 0 && Date.now() - openedAt > 45_000) {
        void fetch(`${new URL(options.relayUrl).origin}/healthz`, {
          headers: { authorization: `Bearer ${options.token}` },
        }).then(async (res) => {
          if (!res.ok || closed || abandoned || socket !== ws) return;
          const health = await res.json() as { bridgeConnected?: boolean };
          if (health.bridgeConnected === false) {
            forceReconnect("relay no longer routes to this bridge socket");
          }
        }).catch(() => {
          // Transient healthz failures are not evidence of a dead socket.
        });
      }
    }, BRIDGE_PING_INTERVAL_MS);

    ws.addEventListener("open", () => {
      attempt = 0;
      lastFrameAt = Date.now();
      openedAt = Date.now();
      log(`bridge: connected to relay (tools: ${options.toolNames.join(", ")}; fallback identity ${options.senderId})`);
    });
    ws.addEventListener("message", (event) => {
      lastFrameAt = Date.now();
      const envelope = parseBridgeBoundEnvelope(
        typeof event.data === "string" ? event.data : "",
      );
      if (!envelope) return;
      const agent = envelope.agent?.trim() || options.senderId;
      void getOrCreateInstance(agent).then((instance) => {
        if (!instance) {
          if (envelope.kind === "mcp_request") {
            sendRaw({
              v: 1,
              kind: "mcp_error",
              id: envelope.id,
              status: 503,
              message: "bridge identity capacity reached",
            });
          }
          return;
        }
        instance.transport.deliver(envelope);
      }).catch((error) => {
        if (envelope.kind === "mcp_request") {
          sendRaw({
            v: 1,
            kind: "mcp_error",
            id: envelope.id,
            status: 500,
            message: error instanceof Error ? error.message : "instance failure",
          });
        }
      });
    });
    ws.addEventListener("close", (event) => {
      clearInterval(heartbeat);
      if (abandoned || socket !== ws) return;
      socket = null;
      if (closed) return;
      const delay = scheduleReconnect();
      log(`bridge: relay connection closed (${event.code}); reconnecting in ${Math.round(delay / 1000)}s`);
    });
    ws.addEventListener("error", () => {
      // The paired close event drives reconnection.
    });
  };

  connect();

  return {
    close: async () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close(1000, "bridge shutting down");
      socket = null;
      for (const [, instance] of instances) {
        await instance.server.close().catch(() => {});
      }
      instances.clear();
    },
  };
}
