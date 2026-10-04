import { ROOM_LISTENING_RESPONSE_BYTES } from "@openscout/protocol";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ChatListeningError, type ChatListeningSource, type ListeningMembership, type ListeningMessage } from "./broker-chat-listening.js";

const sourceConflictCodes = new Set(["source_history_gap", "source_cursor_capacity", "source_invalid_message"]);
function conflictBody(body: any): { error: string } | null {
  return typeof body?.error === "string" && sourceConflictCodes.has(body.error) ? { error: body.error } : null;
}

export type RoomHttpResponse = { status: number; body: any };
export type RoomHttpGet = (membership: ListeningMembership, resource: string, query?: Record<string, string>) => Promise<RoomHttpResponse>;
/** Explicitly enrolled authority only. No redirects, cookies, credential forwarding
 * to a different origin, insecure TLS override, or response-body error logging. */
export const getRoomHttp: RoomHttpGet = async (member, resource, query = {}) => {
  const origin = new URL(member.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new ChatListeningError("invalid_origin");
  const url = new URL(`/api/channels/${encodeURIComponent(member.channelId)}/${resource}`, origin);
  url.searchParams.set("space", member.space);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Promise((resolve, reject) => {
    const fail = () => reject(new ChatListeningError("source_unavailable"));
    const local = ["scout.local", "localhost"].includes(url.hostname);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: { authorization: `Bearer ${member.token}` }, signal: AbortSignal.timeout(resource.startsWith("messages/") ? 1500 : 8000),
      ...(local ? { lookup: (_host: string, options: any, callback: any) => options.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4) } : {}),
    }, response => {
      const status = response.statusCode ?? 503;
      if (status !== 200 && status !== 409) { response.resume(); resolve({ status, body: null }); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > (status === 409 ? 1024 : ROOM_LISTENING_RESPONSE_BYTES)) {
          if (status === 409) resolve({ status, body: null }); else fail();
          response.destroy();
        } else chunks.push(Buffer.from(chunk));
      });
      response.on("error", fail);
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ status, body: status === 409 ? conflictBody(body) : body });
        } catch {
          if (status === 409) resolve({ status, body: null });
          else reject(new ChatListeningError("source_invalid_response"));
        }
      });
    });
    request.on("error", fail); request.end();
  });
};
function requirePage(result: RoomHttpResponse): any {
  if (result.status !== 200) throw new ChatListeningError([401, 403].includes(result.status) ? "membership_denied"
    : result.status === 409 ? conflictBody(result.body)?.error ?? "source_history_gap" : result.status === 429 ? "source_rate_limited" : "source_unavailable");
  const page = result.body;
  if (!page || !Array.isArray(page.messages) || page.messages.length > 100 || typeof page.nextCursor !== "string" || page.nextCursor.length > 16384) throw new ChatListeningError("source_invalid_response");
  return page;
}
/** Portable HTTP-only ingestion: local/mesh rooms expose listening; hosted Chat
 * already has indexed feed/poll cursors. No source SQLite or broker dependency. */
export function createRoomHttpSource(get: RoomHttpGet = getRoomHttp): ChatListeningSource {
  return { async read(member, saved, owner, recovery) {
    let mode: "listening" | "hosted" = "listening", cursor: string | undefined;
    if (saved !== null) {
      let decoded: any; try { decoded = JSON.parse(saved); } catch { throw new ChatListeningError("source_cursor_invalid"); }
      if (decoded.v !== 3) throw new ChatListeningError("source_cursor_upgrade_required");
      if (!["listening", "hosted"].includes(decoded.mode) || typeof decoded.cursor !== "string") throw new ChatListeningError("source_cursor_invalid");
      mode = decoded.mode; cursor = decoded.cursor;
    }
    let result = await get(member, mode === "hosted" ? "poll" : "listening", { ...(cursor ? { cursor } : {}), ...(mode === "listening" && cursor?.startsWith("room.v1.") && recovery?.afterMessageId ? { afterMessageId: recovery.afterMessageId } : {}), limit: "100", observe: "1" });
    if (saved === null && result.status === 404) {
      // Only hosted's retained, monotonic hchat cursor is a supported fallback.
      // Never silently fall back to local's lossy newest-window polling.
      result = await get(member, "feed", { limit: "1" });
      const feed = requirePage(result);
      if (!feed.nextCursor.startsWith("hchat.v1.") || feed.observerSupported !== true) throw new ChatListeningError("room_api_upgrade_required");
      mode = "hosted";
    }
    const page = requirePage(result);
    if (mode === "hosted" && page.observerSupported !== true) throw new ChatListeningError("room_api_upgrade_required");
    if (page.channelId !== member.channelId) throw new ChatListeningError("source_invalid_response");
    if (mode === "listening" && (page.protocol !== "room-listening.v1" || page.membership?.actorId !== member.actorId
      || page.membership?.space !== member.space || !Number.isFinite(page.membership?.expiresAt) || page.membership.expiresAt <= Date.now())) throw new ChatListeningError("membership_denied");
    if (mode === "hosted" && page.credentialExpiresAt !== undefined &&
      (!Number.isFinite(page.credentialExpiresAt) || page.credentialExpiresAt <= Date.now())) throw new ChatListeningError("membership_denied");
    if (saved !== null && page.hasMore && page.nextCursor === cursor) throw new ChatListeningError("source_cursor_stalled");
    const identities = new Set([member.actorId, owner]);
    const byId = new Map<string, any>();
    for (const message of page.messages) {
      if (!message || typeof message.id !== "string" || typeof message.actorId !== "string" || typeof message.body !== "string" || !Number.isFinite(message.createdAt)) throw new ChatListeningError("source_invalid_response");
      byId.set(message.id, message);
    }
    let contextBudget = 4;
    const messages: ListeningMessage[] = [];
    for (const m of saved === null ? [] : page.messages) {
      let root: string | null = typeof m.threadRootId === "string" ? m.threadRootId : m.replyToMessageId ? null : m.id;
      let replyActor = m.replyActorId ?? byId.get(m.replyToMessageId)?.actorId;
      if (mode === "hosted" && m.replyToMessageId && contextBudget-- > 0) {
        const context = await get(member, `messages/${encodeURIComponent(m.id)}/context`).catch(() => ({ status: 503, body: null }));
        if (context.status === 200 && Array.isArray(context.body?.messages)) {
          root = typeof context.body.rootMessageId === "string" ? context.body.rootMessageId : null;
          replyActor = context.body.messages.find((p: any) => p.id === m.replyToMessageId)?.actorId;
        }
      }
      messages.push({ id: m.id, actorId: m.actorId, body: m.body, createdAt: m.createdAt,
        ...(m.bodyTruncated === true ? { bodyTruncated: true } : {}),
        replyToMessageId: m.replyToMessageId ?? undefined, threadRootId: root,
        relevance: identities.has(m.actorId) ? null : Array.isArray(m.mentions) && m.mentions.some((mention: any) => identities.has(mention.actorId)) ? "mention"
          : replyActor && identities.has(replyActor) ? "direct-reply" : null });
    }
    return { cursor: JSON.stringify({ v: 3, mode, cursor: page.nextCursor }), messages, hasMore: page.hasMore === true,
      // Older hosted deployments omit this field; never invent an expiry.
      expiresAt: mode === "listening" ? page.membership.expiresAt
        : page.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER };
  } };
}
