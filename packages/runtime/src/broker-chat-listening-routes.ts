import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { json, readRequestBody } from "./broker-http-helpers.js";
import { BrokerChatListening, ChatListeningError, type ListeningMembership, type ListeningBinding } from "./broker-chat-listening.js";

/** Standalone listening-service machine-local trust boundary. Never
 * reachable by a forwarded peer, guest, or hosted channel-member credential. */
export async function handleChatListeningRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike,
  url: URL, service: BrokerChatListening | undefined, operatorActorId: string): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/chat-listening/")) return false;
  if (request.transportContext?.transport === "remote" || request.headers["x-openscout-forwarded-node-id"]) {
    json(response, 403, { error: "machine_local_only" }); return true;
  }
  if (!service) { json(response, 503, { error: "listening_unavailable" }); return true; }
  if (request.method !== "POST") { json(response, 405, { error: "post_required" }); return true; }
  try {
    const input = await readRequestBody<Record<string, unknown>>(request, { maxBytes: 16384, requireJsonContentType: true });
    if (!input || typeof input.agentId !== "string" || !input.agentId.trim()) throw new ChatListeningError("agent_required");
    const agentId = input.agentId;
    const command = url.pathname.slice("/v1/chat-listening/".length);
    let result: unknown;
    if (command === "enroll") result = await service.enroll(agentId, input.membership as ListeningMembership, operatorActorId, input.binding as Partial<ListeningBinding> | undefined);
    else if (command === "status") result = service.status(agentId);
    else if (command === "catch-up" && typeof input.subscriptionId === "string") result = await service.catchUp(agentId, input.subscriptionId, input.limit === undefined ? 50 : Number(input.limit));
    else if (command === "ack" && typeof input.subscriptionId === "string" && typeof input.receipt === "string") result = await service.ack(agentId, input.subscriptionId, input.receipt);
    else if (command === "unenroll" && typeof input.subscriptionId === "string") result = await service.unenroll(agentId, input.subscriptionId);
    else throw new ChatListeningError("invalid_command");
    json(response, 200, result);
  } catch (error) {
    json(response, error instanceof ChatListeningError ? 400 : 503, { error: error instanceof ChatListeningError ? error.code : "listening_unavailable" });
  }
  return true;
}
