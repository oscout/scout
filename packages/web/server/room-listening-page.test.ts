import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SQLiteControlPlaneStore } from "../../runtime/src/sqlite-store.js";
import { roomListeningPage } from "./room-listening-page.ts";
const homes: string[] = [];
afterEach(async () => { for (const p of homes.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "room-http-page-")); homes.push(home);
  const path = join(home, "test.sqlite"), writer = new SQLiteControlPlaneStore(path);
  writer.upsertNode({ id: "node", meshId: "mesh", name: "Test", registeredAt: Date.now(), advertiseScope: "local" });
  for (const id of ["reader", "person"]) writer.upsertActor({ id, kind: "person", displayName: id });
  const room = { id: "room", kind: "channel" as const, title: "Room", participantIds: ["reader"], authorityNodeId: "node", visibility: "workspace" as const, shareMode: "shared" as const };
  writer.upsertConversation(room); writer.upsertConversation({ ...room, id: "private" });
  const db = new Database(path, { readonly: true });
  const input = { channelId: "room", actorId: "reader", epoch: "fixture", secret: "secret" };
  const post = (id: string, extra: any = {}) => writer.recordMessage({ id, actorId: "person", conversationId: "room", originNodeId: "node", body: id,
    createdAt: 1800000000000, class: "agent", visibility: "workspace", policy: "durable", ...extra });
  return { writer, db, input, post, room, close() { db.close(); writer.close(); } };
}
test("room API starts at high-water; no-new pass does only tail and anchor point checks", async () => {
  const h = await fixture();
  try {
    for (let i=0;i<500;i++) h.post(`old${i}`);
    const first = roomListeningPage(h.db, h.input); expect(first.messages).toEqual([]);
    const queries: string[] = [];
    const observed = { query: (sql: string) => { queries.push(sql); return h.db.query(sql); } } as Pick<Database, "query">;
    const empty = roomListeningPage(observed, { ...h.input, cursor: first.nextCursor });
    expect(empty.nextCursor).toBe(first.nextCursor); expect(queries).toHaveLength(3);
    expect(queries.some(q => /payload_json|FROM messages|rowid>/.test(q))).toBe(false);
    h.post("equal-time"); h.post("backdated", { createdAt: 1 });
    expect(roomListeningPage(h.db, { ...h.input, cursor: first.nextCursor }).messages.map(m => m.id)).toEqual(["equal-time", "backdated"]);
    expect(JSON.stringify(h.db.query("EXPLAIN QUERY PLAN SELECT seq FROM thread_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 100").all("room", 500))).toContain("INDEX");
    expect(h.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'chat_listening_%'").all()).toEqual([]);
  } finally { h.close(); }
});
test("bounded pages advance across unrelated traffic without revealing it; nesting and structured mentions survive", async () => {
  const h = await fixture();
  try {
    h.post("root", { actorId: "reader" });
    h.writer.upsertConversation({ ...h.room, id: "thread", kind: "thread", parentConversationId: "room", messageId: "root" });
    const start = roomListeningPage(h.db, h.input);
    h.post("private-secret", { conversationId: "private" });
    h.post("parent", { conversationId: "thread", mentions: [{ actorId: "reader" }] });
    h.post("nested", { conversationId: "thread", replyToMessageId: "parent" });
    for (let i=0;i<110;i++) h.post(`new${i}`);
    const page = roomListeningPage(h.db, { ...h.input, cursor: start.nextCursor });
    expect(page.hasMore).toBe(true); expect(page.messages).toHaveLength(100);
    expect(JSON.stringify(page)).not.toContain("private-secret");
    expect(page.messages[0]).toMatchObject({ id: "parent", threadRootId: "root", replyActorId: "reader", mentions: [{ actorId: "reader" }] });
    expect(page.messages[1].threadRootId).toBe("root");
    const rest = roomListeningPage(h.db, { ...h.input, cursor: page.nextCursor }); expect(rest.messages).toHaveLength(12);
    expect(rest.hasMore).toBe(false);
  } finally { h.close(); }
});
test("opaque cursors reject wrong authority, member, room, tampering, source replacement and missing positions", async () => {
  const h = await fixture();
  try {
    h.post("one"); const first = roomListeningPage(h.db, h.input);
    for (const patch of [{ secret: "other" }, { actorId: "other" }, { channelId: "other" }, { epoch: "replaced" }]) {
      expect(() => roomListeningPage(h.db, { ...h.input, ...patch, cursor: first.nextCursor })).toThrow("source_history_gap");
    }
    expect(() => roomListeningPage(h.db, { ...h.input, cursor: "invalid" })).toThrow();
    h.post("two"); h.post("three"); h.writer.writerDb.query("DELETE FROM thread_events WHERE rowid=2").run();
    expect(() => roomListeningPage(h.db, { ...h.input, cursor: first.nextCursor })).toThrow("source_history_gap");
  } finally { h.close(); }
});
test("current audience/body is authoritative; an ancestry budget never drops later new messages", async () => {
  const h = await fixture();
  try {
    h.post("root"); let parent = "root";
    for (let i=0;i<31;i++) { const id = `ancestor${i}`; h.post(id, { replyToMessageId: parent }); parent = id; }
    const first = roomListeningPage(h.db, h.input);
    for (let i=0;i<100;i++) h.post(`reply${i}`, { replyToMessageId: parent });
    const page = roomListeningPage(h.db, { ...h.input, cursor: first.nextCursor }); expect(page.messages).toHaveLength(100);
    expect(page.messages.at(-1).threadRootId).toBeNull();
    const start = page.nextCursor; h.post("hidden", { audience: { visibleTo: ["person"] } });
    h.post("edited"); h.writer.writerDb.query("UPDATE messages SET body='current' WHERE id='edited'").run();
    const final = roomListeningPage(h.db, { ...h.input, cursor: start });
    expect(final.messages.map(m => m.id)).toEqual(["edited"]); expect(final.messages[0].body).toBe("current");
  } finally { h.close(); }
});

test("R2: byte-budgeted HTTP pages drain UTF-8/JSON expansion and a huge body without advancing past omitted events", async () => {
  const { createServer } = await import("node:http");
  const { createRoomHttpSource } = await import("../../runtime/src/room-listening-http-source.ts");
  const { BrokerChatListening } = await import("../../runtime/src/broker-chat-listening.ts");
  const { ROOM_LISTENING_RESPONSE_BYTES } = await import("@openscout/protocol");
  const h = await fixture(), sizes: number[] = [];
  const grant = { actorId: "reader", space: "home", expiresAt: Date.now() + 600_000 };
  const server = createServer((request, response) => {
    const query = new URL(request.url!, "http://localhost").searchParams;
    const page = roomListeningPage(h.db, { ...h.input, cursor: query.get("cursor") ?? undefined, limit: Number(query.get("limit") ?? 100) });
    const json = JSON.stringify({ ...page, membership: grant }); sizes.push(Buffer.byteLength(json));
    response.setHeader("content-type", "application/json"); response.end(json);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  expect([43110,43112,43120,43122]).not.toContain(port);
  const home = await mkdtemp(join(tmpdir(), "room-bytes-")); homes.push(home);
  const service = new BrokerChatListening({ path: join(home, "state.json"), source: createRoomHttpSource(), isDurableAgent: () => true });
  try {
    const sub = await service.enroll("reader", { origin: `http://127.0.0.1:${port}`, channelId: "room", space: "home", actorId: "reader", token: "fixture-only" }, "operator");
    for (let i=0;i<100;i++) h.post(`utf8-${i}`, { body: "界".repeat(16000) });
    h.post("huge", { body: "\u0000".repeat(2_000_000) });
    h.post("after-huge");
    for (let i=0;i<5 && service.status("reader")[0]!.ingestedCount < 102;i++) await service.tick();
    expect(service.status("reader")[0]!.ingestedCount).toBe(102);
    expect(sizes.every(size => size < ROOM_LISTENING_RESPONSE_BYTES)).toBe(true);
    const received: any[] = [];
    while (service.status("reader")[0]!.unreadCount) {
      const batch = await service.catchUp("reader", sub.id, 100); received.push(...batch.messages);
      await service.ack("reader", sub.id, batch.ack!);
    }
    expect(received.map(m => m.id)).toEqual([...Array.from({ length: 100 }, (_, i) => `utf8-${i}`), "huge", "after-huge"]);
    expect(received.find(m => m.id === "huge").body.length).toBeLessThan(16000); // Source truncation, not catch-up's own length cap.
    expect(received.find(m => m.id === "huge")).toMatchObject({ bodyTruncated: true, reply: { messageId: "huge", channelId: "room" } });
    const baseline = roomListeningPage(h.db, h.input); h.post("limited-one"); h.post("limited-two");
    const limited = roomListeningPage(h.db, { ...h.input, cursor: baseline.nextCursor, limit: 1 });
    expect(limited.messages.map(m => m.id)).toEqual(["limited-one"]); expect(limited.hasMore).toBe(true);
    expect(roomListeningPage(h.db, { ...h.input, cursor: limited.nextCursor }).messages.map(m => m.id)).toEqual(["limited-two"]);
  } finally { await service.stop(); await new Promise<void>(r => server.close(() => r())); h.close(); }
});


test("R1: unrelated deletion beyond and at the saved anchor never invalidates the room frontier", async () => {
  for (const atAnchor of [false, true]) {
    const h = await fixture();
    try {
      h.post("anchor");
      if (atAnchor) h.post("unrelated", { conversationId: "private" });
      const start = roomListeningPage(h.db, h.input);
      if (!atAnchor) h.post("unrelated", { conversationId: "private" });
      h.post("wanted"); h.writer.conversations.delete("private");
      expect(roomListeningPage(h.db, { ...h.input, cursor: start.nextCursor }).messages.map(m => m.id)).toEqual(["wanted"]);
      h.writer.writerDb.exec("VACUUM");
      expect(roomListeningPage(h.db, { ...h.input, cursor: start.nextCursor }).messages.map(m => m.id)).toEqual(["wanted"]);
    } finally { h.close(); }
  }
});

test("room-scoped seq detects real missing room/child events and removal of a saved thread", async () => {
  for (const missing of ["anchor", "interior", "thread"]) {
    const h = await fixture();
    try {
      h.writer.upsertConversation({ ...h.room, id: "thread", kind: "thread", parentConversationId: "room" });
      h.post("root"); h.post("child", { conversationId: "thread" });
      const start = roomListeningPage(h.db, h.input);
      h.post("two", { conversationId: "thread" }); h.post("three", { conversationId: "thread" });
      if (missing === "thread") h.writer.conversations.delete("thread");
      else h.writer.writerDb.query("DELETE FROM thread_events WHERE conversation_id='thread' AND seq=?").run(missing === "anchor" ? 1 : 2);
      expect(() => roomListeningPage(h.db, { ...h.input, cursor: start.nextCursor })).toThrow("source_history_gap");
    } finally { h.close(); }
  }
});

test("new threads join the stable vector from seq zero; exact 100/101 pages retain all message IDs", async () => {
  const h = await fixture();
  try {
    const start = roomListeningPage(h.db, h.input);
    h.writer.upsertConversation({ ...h.room, id: "thread", kind: "thread", parentConversationId: "room" });
    for (let i=0;i<100;i++) h.post(`message${i}`, { conversationId: i % 2 ? "thread" : "room" });
    const page = roomListeningPage(h.db, { ...h.input, cursor: start.nextCursor });
    expect(page.messages).toHaveLength(100); expect(page.hasMore).toBe(false);
    h.post("message100");
    const replay = roomListeningPage(h.db, { ...h.input, cursor: start.nextCursor });
    expect(replay.hasMore).toBe(true);
    expect(roomListeningPage(h.db, { ...h.input, cursor: replay.nextCursor }).messages.map(m => m.id)).toEqual(["message100"]);
  } finally { h.close(); }
});

test("v1 cursors migrate via stable anchor or last ingested room message; unavailable anchors conservatively replay", async () => {
  const { createCipheriv, createHash, randomBytes } = await import("node:crypto");
  for (const recovery of ["anchor", "ingested", "replay"] as const) {
    const h = await fixture();
    try {
      h.post("old"); h.post("ingested"); h.post("other", { conversationId: "private" });
      const last: any = h.db.query("SELECT rowid AS position,id FROM thread_events ORDER BY rowid DESC LIMIT 1").get();
      const key = createHash("sha256").update(`room-listening.v1\0${h.input.secret}`).digest();
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`${h.input.channelId}\0${h.input.actorId}`));
      const data = Buffer.concat([cipher.update(JSON.stringify({ epoch: h.input.epoch, after: last.position, anchor: last.id })), cipher.final()]);
      const cursor = `room.v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
      h.post("wanted");
      if (recovery !== "anchor") h.writer.conversations.delete("private");
      const page = roomListeningPage(h.db, { ...h.input, cursor, ...(recovery === "ingested" ? { afterMessageId: "ingested" } : {}) });
      expect(page.nextCursor).toStartWith("room.v2."); expect(page.cursorMigrated).toBe(true);
      expect(page.messages.map(m => m.id)).toEqual(recovery === "replay" ? ["old", "ingested", "wanted"] : ["wanted"]);
      expect(roomListeningPage(h.db, { ...h.input, cursor: page.nextCursor }).messages).toEqual([]);
      expect(() => roomListeningPage(h.db, { ...h.input, actorId: "person", cursor })).toThrow("source_history_gap");
    } finally { h.close(); }
  }
});
