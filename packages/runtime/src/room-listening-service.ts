import { createServer } from "node:http";
import { join } from "node:path";
import { BrokerChatListening, ChatListeningError } from "./broker-chat-listening.js";
import { createRoomHttpSource, type RoomHttpGet } from "./room-listening-http-source.js";
import { createListeningSessionObserver, endpointListeningFacing } from "./broker-chat-listening-binding.js";
import { handleChatListeningRoute } from "./broker-chat-listening-routes.js";
import { readHerdrTopology } from "./system-probes/herdr.js";

/** All polling, credential custody and state serialization run in this process,
 * not in the comms broker. Room content always comes from its HTTP authority.
 * Local binding metadata uses message-free broker APIs, never direct SQLite. */
export function createRoomListeningService(options: {
  controlHome: string; brokerUrl: string;
  fetcher?: typeof fetch; roomGet?: RoomHttpGet; herdr?: typeof readHerdrTopology;
}) {
  const broker = new URL(options.brokerUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(broker.hostname) || broker.username || broker.password
    || !["http:", "https:"].includes(broker.protocol)) throw new Error("Listening requires a loopback broker health URL");
  // Pin localhost; no resolver or redirected peer may choose the node identity.
  if (broker.hostname === "localhost") broker.hostname = "127.0.0.1";
  async function nodeId() {
    const response = await (options.fetcher ?? fetch)(new URL("/health", broker), { redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new ChatListeningError("source_unavailable");
    const health = await response.json() as { nodeId?: unknown };
    if (typeof health.nodeId !== "string" || !health.nodeId) throw new ChatListeningError("source_unavailable");
    return health.nodeId;
  }
  async function registry(): Promise<any> {
    const response = await (options.fetcher ?? fetch)(new URL("/v1/snapshot?scope=agents", broker), { redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new ChatListeningError("identity_unavailable");
    return response.json();
  }
  async function endpoints(endpointId?: string): Promise<import("@openscout/protocol").AgentEndpoint[]> {
    const url = new URL("/v1/endpoints", broker);
    if (endpointId) url.searchParams.set("endpointId", endpointId);
    const response = await (options.fetcher ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new ChatListeningError("identity_unavailable");
    const value = await response.json() as { endpoints?: unknown };
    if (!Array.isArray(value.endpoints)) throw new ChatListeningError("identity_unavailable");
    return value.endpoints;
  }
  const herdr = options.herdr ?? readHerdrTopology;
  return new BrokerChatListening({
    path: join(options.controlHome, "chat-listening", "state.json"), sourceKind: "room-http-v1",
    isDurableAgent: async id => {
      try {
        const state = await registry();
        return state.agents?.[id]?.kind === "agent" && state.agents?.[id]?.metadata?.cardless !== true && !id.startsWith("session-");
      } catch { return undefined; } // Unknown liveness never ends delegated room ingestion.
    },
    deriveFacing: async id => {
      const localNode = await nodeId();
      const live = (await endpoints())
        .filter(e => e.agentId === id && e.nodeId === localNode && ["idle", "active", "working", "waiting"].includes(e.state));
      return live.length === 1 ? endpointListeningFacing(live[0]!) : undefined;
    },
    observeSession: async binding => {
      if (binding.herdrSession && binding.pane) return createListeningSessionObserver({ herdr, nodeId: "", endpoints: () => [] })(binding);
      try {
        const localNode = await nodeId(), observedEndpoints = await endpoints(binding.endpointId);
        return await createListeningSessionObserver({ herdr, nodeId: localNode,
          endpoints: () => observedEndpoints,
        })(binding);
      } catch { return { availability: "unknown" }; }
    },
    source: createRoomHttpSource(options.roomGet),
  });
}

/** Separate loopback server. No broker router registration or forwarding. */
export function createRoomListeningHttpServer(service: BrokerChatListening, ready: () => boolean = () => true) {
  return createServer(async (request, response) => {
    try {
      const host = new URL(`http://${request.headers.host ?? "invalid"}`).hostname;
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host) || request.headers.origin
        || request.headers["x-openscout-forwarded-node-id"]) {
        response.writeHead(403); response.end(); return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health" && request.method === "GET") {
        response.writeHead(ready() ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "room-listening", ready: ready(), pid: process.pid })); return;
      }
      if (!ready()) { response.writeHead(503); response.end(); return; }
      if (!await handleChatListeningRoute(request, response, url, service, "operator")) { response.writeHead(404); response.end(); }
    } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
  });
}
