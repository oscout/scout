import { ChatApiError, type ChatApi } from "../../../client/screens/chat-space/chat-api.ts";

/** Test-only HTTP boundary for the real hosted adapter. Worker authentication
 * and SQLite durability are tested separately in the real workerd integration.
 * This fixture deliberately cannot reach a real channel or sign-in service. */
export function installHostedFixtureWire(api: ChatApi) {
  const original = window.fetch.bind(window);
  const spaceId = "a".repeat(32);
  const blobKey = `scout.test.chat-workspace.blobs.${new URLSearchParams(location.search).get("scenario") ?? "default"}`;
  const blobs = JSON.parse(localStorage.getItem(blobKey) ?? "{}") as Record<string, Record<string, { id: string; mediaType: string; fileName?: string; url?: string }>>;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (!url.pathname.startsWith("/api/")) return original(input, init);
    const respond = (data: unknown, status = 200) => Response.json(data, { status });
    try {
      if (url.pathname === "/api/auth/session") {
        const { viewer } = await api.bootstrap();
        return respond({ authenticated: true, account: { id: viewer.actorId, displayName: viewer.displayName }, csrfToken: "fixture-csrf" });
      }
      if (init?.method === "POST" && new Headers(init.headers).get("x-csrf-token") !== "fixture-csrf") return respond({ reason: "csrf_denied" }, 403);
      if (url.pathname === "/api/chat/spaces") return respond({ spaces: [{ id: spaceId, slug: "home", title: "Hosted fixture" }] });
      if (url.pathname === `/api/chat/spaces/${spaceId}`) return respond({ channels: (await api.bootstrap()).channels, isOwner: (await api.bootstrap()).viewer.isOperator });
      const contextMatch = /^\/api\/channels\/([^/]+)\/messages\/([^/]+)\/context$/.exec(url.pathname);
      if (contextMatch) return respond(await api.messageContext!(contextMatch[1]!, decodeURIComponent(contextMatch[2]!), undefined, url.searchParams.get("cursor")));
      const match = /^\/api\/channels\/([^/]+)\/(blobs|presence|corrections|pins|search|attention|read-state|feed|members\/revoke|members|messages|invites\/revoke|invites)$/.exec(url.pathname);
      if (!match || url.searchParams.get("space") !== spaceId) return respond({ reason: "not_found" }, 404);
      const [, channel, resource] = match;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (resource === "blobs") {
        const bytes = Uint8Array.from(atob(body.data), value => value.charCodeAt(0));
        const file = new File([bytes], body.fileName, { type: body.mediaType });
        const attachment = (await api.uploadAttachments!(channel!, [file]))[0]!;
        (blobs[channel!] ??= {})[attachment.id] = attachment;
        localStorage.setItem(blobKey, JSON.stringify(blobs));
        return respond({ attachment });
      }
      if (resource === "invites") return respond(await api.invites(channel!));
      if (resource === "invites/revoke") return respond(await api.revokeInvite(channel!, body.inviteId, ""));
      if (resource === "members/revoke") return respond(await api.removeMember!(channel!, body.actorId));
      if (resource === "search") return respond(await api.searchMessages!(channel!, url.searchParams.get("q") ?? "", url.searchParams.get("cursor")));
      if (resource === "corrections") return respond(await api.correctMessage!(channel!, body.messageId, body.change));
      if (resource === "pins") return respond(await api.updatePins!(channel!, body));
      if (resource === "attention") return respond(await api.updateAttention!(channel!, body));
      if (resource === "presence") return respond(await api.presence!(channel!, body));
      if (resource === "read-state") {
        if (init?.method === "POST") return respond(await api.markRead!(channel!, body));
        const state = await api.readState!(channel!);
        return respond(state);
      }
      if (resource === "feed") return respond(await api.feed(channel!));
      if (resource === "messages") {
        const attachments = body.attachments?.map(({ id }: { id: string }) => {
          const attachment = blobs[channel!]?.[id];
          if (!attachment) throw new ChatApiError("Attachment missing", 404, "blob_not_found");
          return attachment;
        });
        return respond(await api.postMessage(channel!, { ...body, attachments }));
      }
      const { members } = await api.members(channel!);
      return respond({ members: members.map(member => ({ actorId: member.actorId, displayName: member.displayName, kind: member.kind, expiresAt: Date.now() + 3600000, revoked: 0 })) });
    } catch (error) {
      return respond({ reason: error instanceof ChatApiError ? error.reason ?? error.message : "fixture_failure" }, error instanceof ChatApiError && error.status > 0 ? error.status : 503);
    }
  };
}
