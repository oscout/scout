import type { ChatListeningFeed } from "./test-support/chat-listening-source.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageRecord } from "@openscout/protocol";
import { BrokerChatListening, ChatListeningError, type ListeningMembership } from "./broker-chat-listening.js";
import { createLocalChatListeningSource, listeningThreadRoot } from "./test-support/chat-listening-source.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";
import { localChatOrigin, verifyLocalChatMembership } from "./test-support/chat-listening-membership.js";
import { createServer } from "node:http";
import { createListeningSessionObserver } from "./broker-chat-listening-binding.js";
import { handleChatListeningRoute } from "./broker-chat-listening-routes.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const member: ListeningMembership = { origin: "http://127.0.0.1:1", channelId: "room", space: "home", actorId: "apia-test", token: "private-token" };
function message(id: string, extra: Partial<MessageRecord> = {}): MessageRecord {
  return { id, conversationId: "room", actorId: "person", body: id, createdAt: 1_800_000_000_000,
    originNodeId: "node", class: "agent", visibility: "workspace", policy: "durable", ...extra } as MessageRecord;
}
async function harness() {
  const home = await mkdtemp(join(tmpdir(), "scout-listening-test-")); homes.push(home);
  const snapshot = createRuntimeRegistrySnapshot();
  snapshot.conversations.room = { id: "room", kind: "channel", title: "Test", participantIds: [member.actorId], authorityNodeId: "node", visibility: "workspace", shareMode: "shared" } as any;
  let allowed = true, agentExists = true;
  const fixtureExpiresAt = Date.now() + 60_000;
  const events: { seq: number; message: MessageRecord; update: boolean }[] = [];
  snapshot.messages = new Proxy(snapshot.messages, { set(target, id: string, value) {
    const update = Object.hasOwn(target, id); target[id] = value;
    if (value.conversationId === "room" || snapshot.conversations[value.conversationId]?.parentConversationId === "room") events.push({ seq: events.length + 1, message: value, update });
    return true;
  } });
  const counts = { page: 0, lookup: 0 };
  const feed: ChatListeningFeed = { checkpoint: () => ({ epoch: "test", seq: events.length }),
    page: (_room, after, limit) => { counts.page++; return events.filter(e => e.seq > after).slice(0, limit); },
    message: id => { counts.lookup++; return snapshot.messages[id]; } };
  const source = createLocalChatListeningSource({ conversation: id => snapshot.conversations[id], nodeId: "node", feed: () => feed, verify: async () => {
    if (!allowed) throw new ChatListeningError("membership_denied");
    return { actorId: member.actorId, channelId: "room", space: "home", nodeId: "node", expiresAt: fixtureExpiresAt };
  } });
  const options = { sourceKind: "local-changes-v2" as const, path: join(home, "private", "state.json"), source, isDurableAgent: (id: string) => agentExists && id === "durable" };
  const store = new BrokerChatListening(options); await store.load();
  return { home, snapshot, store, source, options, counts, feed, deny: () => { allowed = false; }, allow: () => { allowed = true; }, retire: () => { agentExists = false; } };
}

describe("listening accumulator persistence", () => {
  test("authoritative initial frontier skips old history, catches empty-room and backdated/equal-time posts", async () => {
    const h = await harness(); h.snapshot.messages.old = message("old", { createdAt: 100 });
    const status = await h.store.enroll("durable", member, "operator");
    expect(status.unreadCount).toBe(0);
    h.snapshot.messages.new = message("new", { createdAt: 0, mentions: [{ actorId: member.actorId }] });
    h.snapshot.messages.equal = message("equal", { createdAt: 100 });
    await h.store.tick();
    const batch = await h.store.catchUp("durable", status.id);
    expect(batch.messages.map(m => m.id)).toEqual(["new", "equal"]);
    expect(h.store.status("durable")[0]?.pendingCount).toBe(1);
    expect(h.store.hasIdentityReference("durable")).toBe(true);
    expect(h.store.hasIdentityReference(member.actorId)).toBe(true);
    expect(h.store.hasIdentityReference("unrelated")).toBe(false);
    expect(batch.messages[0]?.reply).toMatchObject({ channelId: "room", messageId: "new", threadRootId: "new" });
  });
  test("restart and repeated ingestion dedupe; receipt replay and explicit ack are independent of source frontier", async () => {
    const h = await harness(), s = await h.store.enroll("durable", member, "operator");
    h.snapshot.messages.a = message("a"); h.snapshot.messages.b = message("b"); await h.store.tick(); await h.store.tick();
    const batch = await h.store.catchUp("durable", s.id, 1);
    expect(batch.messages).toHaveLength(1); expect(batch.hasMore).toBe(true);
    expect(h.store.status("durable")[0]?.readPosition).toBe(0);
    const restarted = new BrokerChatListening(h.options); await restarted.load();
    expect(restarted.status("durable")[0]?.connection).toBe("disconnected");
    expect(await restarted.catchUp("durable", s.id, 100)).toEqual(batch);
    await restarted.ack("durable", s.id, batch.ack!); await restarted.ack("durable", s.id, batch.ack!);
    expect((await restarted.catchUp("durable", s.id)).messages.map(m => m.id)).toEqual(["b"]);
    await restarted.tick(); expect(restarted.status("durable")[0]?.ingestedCount).toBe(2);
  });
  test("mentions only plus direct replies; nested thread root follows full ancestry, not participated thread", async () => {
    const h = await harness();
    h.snapshot.messages.root = message("root", { actorId: member.actorId });
    h.snapshot.messages.parent = message("parent", { replyToMessageId: "root" });
    h.snapshot.conversations.thread = { ...h.snapshot.conversations.room!, id: "thread", kind: "thread", parentConversationId: "room" };
    const s = await h.store.enroll("durable", member, "operator");
    h.snapshot.messages.direct = message("direct", { replyToMessageId: "root" });
    h.snapshot.messages.nested = message("nested", { conversationId: "thread", replyToMessageId: "parent" });
    h.snapshot.messages.text = message("text", { body: "@apia-test do something" });
    h.snapshot.messages.self = message("self", { actorId: member.actorId, mentions: [{ actorId: member.actorId }] });
    await h.store.tick(); const batch = await h.store.catchUp("durable", s.id);
    expect(batch.messages.find(m => m.id === "direct")?.relevance).toBe("direct-reply");
    expect(batch.messages.find(m => m.id === "nested")).toMatchObject({ relevance: null, threadRootId: "root" });
    expect(batch.messages.find(m => m.id === "text")?.relevance).toBeNull();
    expect(batch.messages.find(m => m.id === "self")?.relevance).toBeNull();
    expect(h.store.status("durable")[0]?.pendingCount).toBe(1);
  });
  test("missing/cyclic ancestry is unknown; unrelated conversation is never ingested", async () => {
    const a = message("a", { replyToMessageId: "b" }), b = message("b", { replyToMessageId: "a" });
    expect(listeningThreadRoot(a, new Map([["a", a], ["b", b]]))).toBeNull();
    expect(listeningThreadRoot(a, new Map())).toBeNull();
    const h = await harness(), s = await h.store.enroll("durable", member, "operator");
    h.snapshot.messages.secret = message("secret", { conversationId: "private" }); await h.store.tick();
    expect((await h.store.catchUp("durable", s.id)).messages).toEqual([]);
  });
  test("revocation stops frontier; reauthorization catches missed posts; inactive policy and private custody survive", async () => {
    const h = await harness(), s = await h.store.enroll("durable", member, "operator");
    h.deny(); h.snapshot.messages.a = message("a"); await h.store.tick();
    expect(h.store.status("durable")[0]).toMatchObject({ membership: "denied", connection: "membership_denied", unreadCount: 0 });
    h.allow(); await h.store.tick();
    expect(h.store.status("durable")[0]?.unreadCount).toBe(1);
    expect(s.policy).toMatchObject({ awake: "queue", idle: "hold", mode: "catch-up", active: false, revision: 1, author: "operator" });
    expect(JSON.stringify(h.store.status("durable"))).not.toContain(member.token);
    expect((await stat(h.options.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(h.home, "private"))).mode & 0o777).toBe(0o700);
    expect(await readFile(h.options.path, "utf8")).toContain(member.token);
  });
  test("enrollment retry/refresh retains frontier; mismatched agent and ack fail closed", async () => {
    const h = await harness();
    await expect(h.store.enroll("session-transient", member, "operator")).rejects.toThrow("durable_agent_required");
    const s = await h.store.enroll("durable", member, "operator"); h.snapshot.messages.a = message("a");
    const again = await h.store.enroll("durable", { ...member, token: "new-token" }, "operator");
    expect(again.id).toBe(s.id); expect(again.unreadCount).toBe(1);
    await expect(h.store.ack("durable", s.id, "guessed")).rejects.toThrow("invalid_ack");
    await expect(h.store.catchUp("other", s.id)).rejects.toThrow("unknown_subscription");
    await expect(h.store.catchUp("durable", s.id, 101)).rejects.toThrow("invalid_limit");
    h.retire(); await h.store.tick(); expect(h.store.status("durable")[0]?.connection).toBe("identity_unavailable");
  });
  test("unenroll deletes credential and stops reads while preserving catch-up", async () => {
    const h = await harness(), s = await h.store.enroll("durable", member, "operator");
    h.snapshot.messages.a = message("a"); await h.store.tick(); await h.store.unenroll("durable", s.id);
    h.snapshot.messages.b = message("b"); await h.store.tick();
    expect(h.store.status("durable")[0]).toMatchObject({ membership: "withdrawn", connection: "stopped", unreadCount: 1 });
    expect(await readFile(h.options.path, "utf8")).not.toContain(member.token);
    expect((await h.store.catchUp("durable", s.id)).messages.map(m => m.id)).toEqual(["a"]);
  });
  test("bounded 100-message source pages drain without advancing read position", async () => {
    const h = await harness(), s = await h.store.enroll("durable", member, "operator");
    for (let i = 0; i < 205; i++) h.snapshot.messages[`m${i}`] = message(`m${i}`);
    await h.store.tick(); expect(h.store.status("durable")[0]?.unreadCount).toBe(100);
    await h.store.tick(); await h.store.tick();
    expect(h.store.status("durable")[0]).toMatchObject({ unreadCount: 205, readPosition: 0 });
    expect((await h.store.catchUp("durable", s.id, 100)).messages.length).toBeLessThanOrEqual(100);
  });
  test("source failure preserves cursor and pending receipt, sanitized status only", async () => {
    const h = await harness(), s = await h.store.enroll("durable", member, "operator");
    h.snapshot.messages.a = message("a"); await h.store.tick();
    const batch = await h.store.catchUp("durable", s.id);
    h.options.source = { read: async () => { throw new Error(`secret ${member.token}`); } };
    const restarted = new BrokerChatListening(h.options); await restarted.load(); await restarted.tick();
    expect(restarted.status("durable")[0]?.connection).toBe("source_unavailable");
    expect(await restarted.catchUp("durable", s.id)).toEqual(batch);
  });
});

test("local origin guard rejects hosted, credentials and URL confusion", () => {
  for (const value of ["https://chat.openscout.app", "http://127.0.0.1.evil.test", "http://user:pass@localhost", "http://localhost/path", "file:///tmp/test", "http://192.168.0.1"]) expect(() => localChatOrigin(value)).toThrow();
  expect(localChatOrigin("http://scout.local").hostname).toBe("scout.local");
});

test("HTTP membership proof is bounded, credential authenticated and never follows redirects", async () => {
  let received = "";
  const server = createServer((req, res) => {
    received = String(req.headers.authorization);
    if (req.url?.includes("denied")) { res.writeHead(403); res.end(); }
    else if (req.url?.includes("redirect")) { res.writeHead(302, { location: "http://example.com" }); res.end(); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ actorId: member.actorId, nodeId: "node", channelId: "room", space: "home", expiresAt: Date.now() + 10000 })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://localhost:${(server.address() as any).port}`;
    expect((await verifyLocalChatMembership({ ...member, origin })).actorId).toBe(member.actorId);
    expect(received).toBe(`Bearer ${member.token}`);
    await expect(verifyLocalChatMembership({ ...member, origin, channelId: "denied" })).rejects.toThrow("membership_denied");
    await expect(verifyLocalChatMembership({ ...member, origin, channelId: "redirect" })).rejects.toThrow("source_unavailable");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("service route integrates enroll/status/catch-up/ack and blocks remote custody", async () => {
  const h = await harness();
  const server = createServer((req, res) => { void handleChatListeningRoute(req as any, res as any, new URL(req.url!, "http://local"), h.store, "operator"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/chat-listening/`;
  const post = (command: string, data: object, headers = {}) => fetch(url + command, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ agentId: "durable", ...data }) });
  try {
    expect((await post("enroll", { membership: member }, { "x-openscout-forwarded-node-id": "peer" })).status).toBe(403);
    const s = await (await post("enroll", { membership: member })).json() as any;
    h.snapshot.messages.a = message("a", { mentions: [{ actorId: member.actorId }] }); await h.store.tick();
    const batch = await (await post("catch-up", { subscriptionId: s.id })).json() as any;
    expect(batch.messages).toHaveLength(1); expect(batch.ack).toBeString();
    expect((await post("ack", { subscriptionId: s.id, receipt: batch.ack })).status).toBe(200);
    const status = await (await post("status", {})).json() as any;
    expect(status[0].pendingCount).toBe(0); expect(JSON.stringify(status)).not.toContain(member.token);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("no-new pass makes zero page/parent queries and no history traversal or state write", async () => {
  const h = await harness(); for (let i=0;i<2000;i++) h.snapshot.messages[`m${i}`] = message(`m${i}`);
  await h.store.enroll("durable", member, "operator");
  const before = (await stat(h.options.path)).mtimeMs;
  h.snapshot.messages = new Proxy({}, { ownKeys() { throw Error("full scan forbidden"); }, get() { throw Error("history access forbidden"); } });
  await h.store.tick(); await h.store.tick();
  expect(h.counts).toEqual({ page: 0, lookup: 0 }); expect((await stat(h.options.path)).mtimeMs).toBe(before);
  await expect(stat(`${h.options.path}.events`)).rejects.toThrow();
});

test("failed atomic persistence cannot consume source frontier or acknowledge an unseen batch", async () => {
  const h = await harness(), s = await h.store.enroll("durable", member, "operator");
  h.snapshot.messages.a = message("a");
  const directory = join(h.home, "private"), saved = join(h.home, "saved");
  await rename(directory, saved); await writeFile(directory, "block writes");
  await h.store.tick();
  expect(h.store.status("durable")[0]).toMatchObject({ unreadCount: 0, connection: "source_unavailable" });
  await rm(directory); await rename(saved, directory);
  await h.store.tick();
  const batch = await h.store.catchUp("durable", s.id);
  expect(batch.messages.map(m => m.id)).toEqual(["a"]);
  await rename(directory, saved); await writeFile(directory, "block writes");
  await expect(h.store.ack("durable", s.id, batch.ack!)).rejects.toThrow();
  expect(h.store.status("durable")[0]?.readPosition).toBe(0);
  await rm(directory); await rename(saved, directory);
  await h.store.ack("durable", s.id, batch.ack!);
  expect(h.store.status("durable")[0]?.readPosition).toBe(1);
});

test("corrections refresh retained content without duplicate positions or resurfacing baseline messages", async () => {
  const h = await harness(); h.snapshot.messages.old = message("old");
  const s = await h.store.enroll("durable", member, "operator");
  h.snapshot.messages.a = message("a", { body: "first" }); await h.store.tick();
  h.snapshot.messages.a = message("a", { body: "corrected" }); h.snapshot.messages.old = message("old", { body: "old edit" });
  await h.store.tick();
  const batch = await h.store.catchUp("durable", s.id);
  expect(batch.messages).toHaveLength(1); expect(batch.messages[0]?.body).toBe("corrected");
  await h.store.ack("durable", s.id, batch.ack!);
  h.snapshot.messages.a = message("a", { body: "" }); await h.store.tick();
  expect(h.store.status("durable")[0]).toMatchObject({ unreadCount: 0, ingestedCount: 1 });
});

test("thread anchor fallback, durable identity mentions and audience exclusions", async () => {
  const h = await harness(); h.snapshot.messages.root = message("root");
  h.snapshot.conversations.thread = { ...h.snapshot.conversations.room!, id: "thread", kind: "thread", parentConversationId: "room", messageId: "root" };
  const s = await h.store.enroll("durable", member, "operator");
  h.snapshot.messages.a = message("a", { conversationId: "thread", mentions: [{ actorId: "durable" }] });
  h.snapshot.messages.private = message("private", { audience: { visibleTo: ["someone-else"] } });
  await h.store.tick(); const batch = await h.store.catchUp("durable", s.id);
  expect(batch.messages).toMatchObject([{ id: "a", threadRootId: "root", relevance: "mention" }]);
  expect(batch.messages).toHaveLength(1);
});

test("bounded catch-up truncates oversized bodies, retains full source content privately", async () => {
  const h = await harness(), s = await h.store.enroll("durable", member, "operator");
  h.snapshot.messages.big = message("big", { body: "x".repeat(100_000) }); await h.store.tick();
  const batch = await h.store.catchUp("durable", s.id);
  expect(batch.messages[0]?.body.length).toBe(16000); expect(batch.messages[0]?.bodyTruncated).toBe(true);
  expect((await readFile(h.options.path, "utf8")) + (await readFile(`${h.options.path}.events`, "utf8"))).toContain("x".repeat(100_000));
});

test("exact session enrollment, explicit facing, unknown evidence and permanent confirmed-end boundary survive restart", async () => {
  const h = await harness();
  let availability: "available" | "unknown" | "unavailable" = "available";
  const options = { ...h.options, observeSession: async () => ({ availability, facing: "operator" as const, terminalId: "t" }) };
  const store = new BrokerChatListening(options); await store.load();
  const owner = "session:native", request = { mode: "session" as const, sessionId: "native", herdrSession: "scout", pane: "w1:p1" };
  const enrolled = await store.enroll(owner, member, "operator", request);
  expect(enrolled.binding).toMatchObject({ mode: "session", sessionId: "native", facing: "operator", facingSource: "derived", state: "active", terminalId: "t" });
  h.snapshot.messages.a = message("a"); availability = "unknown"; await store.tick();
  expect(store.status(owner)[0]).toMatchObject({ bindingAvailability: "unknown", unreadCount: 1 });
  availability = "available"; await store.tick(); expect(store.status(owner)[0]?.unreadCount).toBe(1);
  const refreshed = await store.enroll(owner, member, "operator", { ...request, facing: "background" });
  expect(refreshed.binding).toMatchObject({ facing: "background", facingSource: "explicit", revision: 2 });
  availability = "unavailable"; await store.tick();
  expect(store.status(owner)[0]?.binding).toMatchObject({ state: "ended" });
  const restarted = new BrokerChatListening(options); await restarted.load();
  availability = "available"; h.snapshot.messages.b = message("b"); await restarted.tick();
  expect(restarted.status(owner)[0]?.unreadCount).toBe(2);
  expect((await restarted.catchUp(owner, enrolled.id)).messages.map(m => m.id)).toEqual(["a", "b"]);
  await expect(restarted.enroll(owner, member, "operator", request)).rejects.toThrow("binding_ended_reconcile_required");
});

test("session enrollment fails closed without a live proof; malformed binding never persists", async () => {
  const h = await harness();
  await expect(h.store.enroll("session:native", member, "operator", { mode: "session", sessionId: "native" })).rejects.toThrow("session_proof_required");
  await expect(h.store.enroll("durable", member, "operator", { facing: "invalid" as any })).rejects.toThrow("invalid_facing");
  expect(h.store.status("session:native")).toEqual([]);
});

test("incremental delta survives restart and torn trailing write; sequence checkpoint avoids double replay", async () => {
  const h = await harness(), enrolled = await h.store.enroll("durable", member, "operator");
  h.snapshot.messages.a = message("a"); await h.store.tick();
  await writeFile(`${h.options.path}.events`, '{"partial":', { flag: "a" });
  const resumed = new BrokerChatListening(h.options); await resumed.load();
  expect(resumed.status("durable")[0]?.unreadCount).toBe(1);
  const batch = await resumed.catchUp("durable", enrolled.id); await resumed.ack("durable", enrolled.id, batch.ack!);
  const again = new BrokerChatListening(h.options); await again.load();
  expect(again.status("durable")[0]).toMatchObject({ ingestedCount: 1, readPosition: 1 });
});

test("old full-history cursors and replaced source epochs fail closed rather than skipping a gap", async () => {
  const h = await harness();
  await expect(h.source.read(member, JSON.stringify({ v: 1, channel: "room", versions: [] }), "durable")).rejects.toThrow("source_cursor_upgrade_required");
  await expect(h.source.read(member, JSON.stringify({ v: 2, channel: "room", epoch: "replaced", seq: 0 }), "durable")).rejects.toThrow("source_history_changed");
});

test("quiet renewal updates durable expiry/status without advancing source or catch-up positions", async () => {
  const home = await mkdtemp(join(tmpdir(), "scout-listening-renewal-")); homes.push(home);
  let expiresAt = Date.now() + 43_200_000;
  const options = { path: join(home, "state.json"), isDurableAgent: () => true,
    source: { read: async () => ({ cursor: "unchanged", messages: [], expiresAt }) } };
  const listening = new BrokerChatListening(options); await listening.load();
  await listening.enroll("durable", member, "operator");
  expiresAt += 60_000;
  await listening.tick();
  expect(listening.status("durable")[0]).toMatchObject({ expiresAt, pendingCount: 0, readPosition: 0, ingestedCount: 0 });
  const record = await readFile(`${options.path}.events`, "utf8");
  await listening.tick();
  expect(await readFile(`${options.path}.events`, "utf8")).toBe(record);
  const restarted = new BrokerChatListening(options); await restarted.load();
  expect(restarted.status("durable")[0]?.expiresAt).toBe(expiresAt);
});

test("pinned endpoint reuse ends the saved binding across restart and rejects refresh", async () => {
  const h = await harness();
  const endpoint: any = { id: "pinned", nodeId: "node", sessionId: "native", state: "idle", harness: "claude" };
  const options = { ...h.options, observeSession: createListeningSessionObserver({ nodeId: "node", endpoints: () => [endpoint], herdr: async () => { throw Error(); } }) };
  const store = new BrokerChatListening(options); await store.load();
  const request = { mode: "session" as const, sessionId: "native", harness: "claude" };
  await store.enroll("session:native", member, "operator", request);
  expect(store.status("session:native")[0]?.binding.endpointId).toBe("pinned");
  endpoint.sessionId = "replacement"; await store.tick();
  expect(store.status("session:native")[0]?.binding.state).toBe("ended");
  const restarted = new BrokerChatListening(options); await restarted.load();
  endpoint.sessionId = "native"; await restarted.tick();
  expect(restarted.status("session:native")[0]?.binding.state).toBe("ended");
  await expect(restarted.enroll("session:native", member, "operator", request)).rejects.toThrow("binding_ended_reconcile_required");
});

test("source capacity failure reports its code without advancing the saved frontier", async () => {
  const h = await harness(); let blocked = false;
  const options = { ...h.options, source: { read: async (...args: Parameters<typeof h.source.read>) => {
    if (blocked) throw new ChatListeningError("source_cursor_capacity");
    return h.source.read(...args);
  } } };
  const store = new BrokerChatListening(options); await store.load();
  const enrolled = await store.enroll("durable", member, "operator");
  const before = await readFile(h.options.path, "utf8");
  h.snapshot.messages.new = message("new"); blocked = true; await store.tick();
  expect(store.status("durable")[0]).toMatchObject({ connection: "source_cursor_capacity", ingestedCount: 0, readPosition: 0 });
  expect(await readFile(h.options.path, "utf8")).toBe(before);
  blocked = false; await store.tick();
  expect((await store.catchUp("durable", enrolled.id)).messages.map(m => m.id)).toEqual(["new"]);
});
