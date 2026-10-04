// Legacy membership-transport fixture retained for store regression tests.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ChatListeningError, type ListeningMembership } from "../broker-chat-listening.js";
import type { ListeningGrant } from "./chat-listening-source.js";

/** Only this-machine endpoints. Pin named local hosts to loopback at connect
 * time (no DNS rebinding); no redirects, cookies, retries, or raw errors. */
export function localChatOrigin(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash
    || !["127.0.0.1", "[::1]", "localhost", "scout.local"].includes(url.hostname)) throw new ChatListeningError("local_room_required");
  return url;
}
export async function verifyLocalChatMembership(membership: ListeningMembership): Promise<ListeningGrant> {
  const origin = localChatOrigin(membership.origin);
  const url = new URL(`/api/channels/${encodeURIComponent(membership.channelId)}/listening-membership?space=${encodeURIComponent(membership.space)}`, origin);
  return new Promise((resolve, reject) => {
    const fail = (code: string) => reject(new ChatListeningError(code));
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: { authorization: `Bearer ${membership.token}` },
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      },
      signal: AbortSignal.timeout(5000),
    }, response => {
      if (response.statusCode !== 200) {
        response.resume(); fail([401, 403, 404].includes(response.statusCode ?? 0) ? "membership_denied" : "source_unavailable"); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) { response.destroy(); fail("source_invalid_response"); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on("error", () => fail("source_unavailable"));
      response.on("end", () => {
        try {
          const grant = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!grant || typeof grant.actorId !== "string" || typeof grant.nodeId !== "string" || !Number.isFinite(grant.expiresAt)) throw new Error();
          resolve(grant);
        } catch { fail("source_invalid_response"); }
      });
    });
    request.on("error", () => fail("source_unavailable"));
    request.end();
  });
}
