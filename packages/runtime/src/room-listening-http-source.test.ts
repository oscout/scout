import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { createRoomHttpSource, getRoomHttp, type RoomHttpGet } from "./room-listening-http-source.js";
const member = { origin: "https://room.other-node.test", channelId: "room", space: "space", actorId: "reader", token: "secret" };
const grant = { actorId: "reader", space: "space", expiresAt: Date.now() + 60_000 };
const message = (id: string, extra = {}) => ({ id, actorId: "person", body: id, createdAt: 1, ...extra });
test("HTTP source keeps authority cursor, mention/direct-reply relevance and initial high-water without importing history", async () => {
  const requests: any[] = [];
  const get: RoomHttpGet = async (m, resource, query) => {
    requests.push({ m, resource, query });
    return { status: 200, body: { protocol: "room-listening.v1", channelId: "room", membership: grant,
      nextCursor: query?.cursor ? "next" : "initial", messages: query?.cursor ? [message("mention", { mentions: [{ actorId: "reader" }] }), message("direct", { replyActorId: "reader", threadRootId: "root", replyToMessageId: "parent" }), message("own", { actorId: "reader", mentions: [{ actorId: "reader" }] })] : [message("old")] } };
  };
  const source = createRoomHttpSource(get), initial = await source.read(member, null, "durable");
  expect(initial.messages).toEqual([]); const page = await source.read(member, initial.cursor, "durable");
  expect(requests[1]).toMatchObject({ m: member, resource: "listening", query: { cursor: "initial", limit: "100" } });
  expect(page.messages.map(m => m.relevance)).toEqual(["mention", "direct-reply", null]);
  expect(page.messages[1]!.threadRootId).toBe("root");
});
test("hosted API fallback uses authoritative feed high-water then its existing monotonic poll and context APIs", async () => {
  const calls: string[] = [];
  const get: RoomHttpGet = async (_m, resource, query) => {
    calls.push(resource);
    if (resource === "listening") return { status: 404, body: null };
    if (resource === "feed") return { status: 200, body: { channelId: "room", observerSupported: true, messages: [message("old")], nextCursor: "hchat.v1.start" } };
    if (resource === "poll") {
      expect(query?.cursor).toBe("hchat.v1.start");
      return { status: 200, body: { channelId: "room", observerSupported: true, messages: [message("reply", { replyToMessageId: "parent" })], nextCursor: "hchat.v1.next" } };
    }
    return { status: 200, body: { rootMessageId: "root", messages: [message("parent", { actorId: "reader" })] } };
  };
  const source = createRoomHttpSource(get), initial = await source.read(member, null, "durable");
  expect(initial.messages).toEqual([]);
  const page = await source.read(member, initial.cursor, "durable");
  expect(page.messages[0]).toMatchObject({ id: "reply", relevance: "direct-reply", threadRootId: "root" });
  expect(calls).toEqual(["listening", "feed", "poll", "messages/reply/context"]);
});
test("offline, denied, stale, wrong identity, oversized page and incompatible cursors fail without advancing", async () => {
  for (const [status, code] of [[503, "source_unavailable"], [403, "membership_denied"], [409, "source_history_gap"], [429, "source_rate_limited"]] as const) {
    await expect(createRoomHttpSource(async () => ({ status, body: null })).read(member, null, "a")).rejects.toThrow(code);
  }
  const source = createRoomHttpSource(async () => ({ status: 200, body: { protocol: "room-listening.v1", channelId: "room", membership: { ...grant, actorId: "other" }, messages: [], nextCursor: "n" } }));
  await expect(source.read(member, null, "a")).rejects.toThrow("membership_denied");
  for (const v of [1, 2]) await expect(source.read(member, JSON.stringify({ v }), "a")).rejects.toThrow("source_cursor_upgrade_required");
  await expect(createRoomHttpSource(async () => ({ status: 200, body: { messages: Array(101).fill(message("a")), nextCursor: "n" } })).read(member, null, "a")).rejects.toThrow("source_invalid_response");
  const fallback = createRoomHttpSource(async (_m, resource) => ({ status: resource === "listening" ? 404 : 200, body: { messages: [], nextCursor: "lossy-local-cursor" } }));
  await expect(fallback.read(member, null, "a")).rejects.toThrow("room_api_upgrade_required");
});
test("room transport sends only that authority's credential, preserves space/cursor, and never follows redirects", async () => {
  let requests = 0, auth = "", url = "";
  const server = createServer((req, res) => {
    requests++; auth = String(req.headers.authorization); url = req.url!;
    if (req.url?.includes("redirect")) { res.writeHead(302, { location: "/secret-target" }); res.end(); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ messages: [], nextCursor: "next" })); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://localhost:${(server.address() as any).port}`;
    expect((await getRoomHttp({ ...member, origin }, "listening", { cursor: "opaque+value" })).status).toBe(200);
    expect(auth).toBe("Bearer secret"); expect(new URL(url, origin).searchParams.get("cursor")).toBe("opaque+value");
    expect(new URL(url, origin).searchParams.get("space")).toBe("space");
    expect((await getRoomHttp({ ...member, origin }, "redirect")).status).toBe(302); expect(requests).toBe(2);
    await expect(getRoomHttp({ ...member, origin: "http://user:pass@localhost" }, "listening")).rejects.toThrow("invalid_origin");
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test("hosted and local reads propagate the authority's current expiry, including quiet polls", async () => {
  let expiry = Date.now() + 43_200_000;
  for (const mode of ["hosted", "listening"] as const) {
    const source = createRoomHttpSource(async (_member, resource) => mode === "hosted" && resource === "listening"
      ? { status: 404, body: null }
      : { status: 200, body: { channelId: "room", observerSupported: true, protocol: "room-listening.v1",
        membership: { ...grant, expiresAt: expiry }, credentialExpiresAt: expiry, messages: [], nextCursor: mode === "hosted" ? "hchat.v1.0" : "opaque" } });
    const first = await source.read(member, null, "reader");
    expect(first.expiresAt).toBe(expiry);
    expiry += 60_000;
    const next = await source.read(member, first.cursor, "reader");
    expect(next.expiresAt).toBe(expiry);
    expect(next.cursor).toBe(first.cursor);
    expect(next.messages).toEqual([]);
  }
});


test("an explicitly expired hosted credential response is never presented as unknown/unlimited", async () => {
  const source = createRoomHttpSource(async (_member, resource) => resource === "listening" ? { status: 404, body: null }
    : { status: 200, body: { channelId: "room", observerSupported: true, credentialExpiresAt: 0,
      messages: [], nextCursor: "hchat.v1.0" } });
  await expect(source.read(member, null, "reader")).rejects.toThrow("membership_denied");
});


test("v1 migration forwards only the trusted last-ingested message hint and adopts the v2 cursor", async () => {
  let query: Record<string, string> | undefined;
  const source = createRoomHttpSource(async (_m, _resource, q) => {
    query = q;
    return { status: 200, body: { protocol: "room-listening.v1", channelId: "room", membership: grant,
      nextCursor: "room.v2.upgraded", messages: [], cursorMigrated: true } };
  });
  const page = await source.read(member, JSON.stringify({ v: 3, mode: "listening", cursor: "room.v1.old" }), "reader", { afterMessageId: "last-ingested" });
  expect(query?.afterMessageId).toBe("last-ingested");
  expect(JSON.parse(page.cursor).cursor).toBe("room.v2.upgraded");
  await source.read(member, page.cursor, "reader", { afterMessageId: "last-ingested" });
  expect(query?.afterMessageId).toBeUndefined();
});

test("room conflicts preserve only bounded known error codes through real HTTP", async () => {
  let body: unknown = { error: "source_cursor_capacity", secret: "must not leave transport" };
  const server = createServer((_req, res) => { res.writeHead(409); res.end(JSON.stringify(body)); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const local = { ...member, origin: `http://localhost:${(server.address() as any).port}` };
  try {
    for (const code of ["source_history_gap", "source_cursor_capacity", "source_invalid_message"]) {
      body = { error: code, secret: "must not leave transport" };
      expect(await getRoomHttp(local, "listening")).toEqual({ status: 409, body: { error: code } });
      await expect(createRoomHttpSource().read(local, null, "reader")).rejects.toThrow(code);
    }
    for (const error of ["arbitrary secret", "x".repeat(2000)]) {
      body = { error };
      expect(await getRoomHttp(local, "listening")).toEqual({ status: 409, body: null });
    }
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
