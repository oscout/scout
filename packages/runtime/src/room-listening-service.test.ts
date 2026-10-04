import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createRoomListeningHttpServer, createRoomListeningService } from "./room-listening-service.js";

const homes: string[] = [];
afterEach(async () => { for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true }); });
const membership = { origin: "http://127.0.0.1:1", channelId: "room", space: "home", actorId: "reader", token: "private" };
const grant = { ...membership, nodeId: "node", expiresAt: Date.now() + 600_000 };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "scout-standalone-listening-")); homes.push(home);
  const messages: any[] = []; let online = true;
  const source = createServer((request, response) => {
    if (!online) { response.writeHead(503); response.end(); return; }
    if (request.headers.authorization !== "Bearer private") { response.writeHead(403); response.end(); return; }
    const query = new URL(request.url!, "http://localhost").searchParams;
    const after = query.has("cursor") ? Number(query.get("cursor")) : messages.length;
    const page = messages.slice(after, after + 100);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ protocol: "room-listening.v1", channelId: "room", membership: grant,
      messages: page, nextCursor: String(after + page.length), hasMore: after + page.length < messages.length }));
  });
  await new Promise<void>(r => source.listen(0, "127.0.0.1", r));
  const member = { ...membership, origin: `http://127.0.0.1:${(source.address() as AddressInfo).port}` };
  const post = (id: string) => messages.push({ id, actorId: "sender", body: id, createdAt: 1_800_000_000_000, mentions: [{ actorId: "reader" }] });
  const options = { controlHome: home, brokerUrl: "http://127.0.0.1:1",
    fetcher: (async () => { throw Error("No broker needed for session-bound room HTTP ingestion"); }) as typeof fetch,
    herdr: (async () => ({ running: true, workspaces: [{ tabs: [{ panes: [{ paneId: "w1:p1", terminalId: "term", agentSession: { kind: "id", agent: "claude", value: "native" } }] }] }] })) as any };
  return { home, post, options, member, offline: () => { online = false; }, online: () => { online = true; },
    close: () => new Promise<void>(r => source.close(() => r())) };
}

test("standalone service uses only room HTTP, preserves session custody across restart and serves one-shot HTTP", async () => {
  const h = await fixture();
  const service = createRoomListeningService(h.options); await service.load();
  const server = createRoomListeningHttpServer(service);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (operation: string, body: object) => {
    const response = await fetch(`${origin}/v1/chat-listening/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); return response.json() as any;
  };
  try {
    const sub = await call("enroll", { agentId: "session:native", membership: h.member,
      binding: { mode: "session", sessionId: "native", herdrSession: "scout", pane: "w1:p1", harness: "claude" } });
    expect(sub.binding).toMatchObject({ facing: "operator", terminalId: "term" });
    h.post("new"); await service.tick();
    const batch = await call("catch-up", { agentId: "session:native", subscriptionId: sub.id });
    expect(batch.messages[0].id).toBe("new"); expect(batch.ack).toBeString();
    const restarted = createRoomListeningService(h.options); await restarted.load();
    expect(await restarted.catchUp("session:native", sub.id)).toEqual(batch);
    await call("ack", { agentId: "session:native", subscriptionId: sub.id, receipt: batch.ack });
    expect((await call("status", { agentId: "session:native" }))[0].unreadCount).toBe(0);
    const health = await fetch(`${origin}/health`); expect((await health.json() as any).service).toBe("room-listening");
    expect((await fetch(`${origin}/v1/snapshot`)).status).toBe(404);
    expect((await fetch(`${origin}/health`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${origin}/health`, { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await fetch(`${origin}/health`, { headers: { "x-openscout-forwarded-node-id": "remote" } })).status).toBe(403);
    expect(JSON.stringify(await call("status", { agentId: "session:native" }))).not.toContain("private");
  } finally { await service.stop(); await new Promise<void>(r => server.close(() => r())); await h.close(); }
});

test("boot reload and room recovery fetch saved cursor even without broker/database", async () => {
  const h = await fixture();
  const service = createRoomListeningService(h.options);
  try {
    await service.load(); const sub = await service.enroll("session:native", h.member, "operator", { mode: "session", sessionId: "native", herdrSession: "scout", pane: "w1:p1" });
    h.post("before"); await service.tick(); h.offline(); h.post("after"); await service.tick();
    const batch = await service.catchUp("session:native", sub.id);
    expect(batch.messages.map(m => m.id)).toEqual(["before"]);
    expect(service.status("session:native")[0]!.connection).not.toBe("connected");
    await service.stop(); h.online(); h.post("while-down");
    const restarted = createRoomListeningService(h.options); await restarted.load();
    restarted.start();
    for (let i=0;i<100 && restarted.status("session:native")[0]!.unreadCount !== 3;i++) await new Promise(r => setTimeout(r, 20));
    expect(restarted.status("session:native")[0]!.unreadCount).toBe(3);
    const replay = await restarted.catchUp("session:native", sub.id);
    expect(replay.ack).toBe(batch.ack);
    expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(batch.messages));
    await restarted.stop();
    await expect(stat(join(h.home, "control-plane.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await service.stop(); await h.close(); }
});

test("durable-agent ingestion survives unavailable local identity API without treating it as confirmed removal", async () => {
  const h = await fixture(); let online = true;
  const service = createRoomListeningService({ ...h.options, fetcher: (async (url: any) => {
    if (!online) throw Error("offline");
    return Response.json(String(url).includes("/health") ? { nodeId: "node" }
      : String(url).includes("/v1/endpoints") ? { endpoints: [] } : { agents: { durable: { kind: "agent" } }, actors: { durable: { kind: "agent" } }, endpoints: {} });
  }) as typeof fetch });
  try {
    await service.load(); const sub = await service.enroll("durable", h.member, "operator");
    online = false; h.post("room-still-online"); await service.tick();
    expect(service.status("durable")[0]!.connection).toBe("connected");
    expect((await service.catchUp("durable", sub.id)).messages[0]!.id).toBe("room-still-online");
  } finally { await service.stop(); await h.close(); }
});

test("boot drains multi-page HTTP backlog with bounded passes and dedupes replayed source ids", async () => {
  const h = await fixture(), first = createRoomListeningService(h.options);
  let restarted: ReturnType<typeof createRoomListeningService> | undefined;
  try {
    await first.load(); const sub = await first.enroll("session:native", h.member, "operator", { mode: "session", sessionId: "native", herdrSession: "scout", pane: "w1:p1" });
    await first.stop(); for (let i=0;i<205;i++) h.post(`missed-${i}`); h.post("missed-0");
    restarted = createRoomListeningService(h.options); await restarted.load(); restarted.start();
    for (let i=0;i<150 && restarted.status("session:native")[0]!.unreadCount < 205;i++) await new Promise(r => setTimeout(r, 20));
    expect(restarted.status("session:native")[0]).toMatchObject({ unreadCount: 205, readPosition: 0 });
    expect((await restarted.catchUp("session:native", sub.id, 100)).messages).toHaveLength(100);
  } finally { await first.stop(); await restarted?.stop(); await h.close(); }
});

test("actual isolated child owns its HTTP endpoint, rejects a second store owner, and shuts down cleanly", async () => {
  const home = await mkdtemp(join(tmpdir(), "scout-listener-child-")); homes.push(home);
  const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, "127.0.0.1", r));
  const port = (reserve.address() as AddressInfo).port; await new Promise<void>(r => reserve.close(() => r()));
  const env = { ...process.env, OPENSCOUT_CONTROL_HOME: home, OPENSCOUT_LISTENING_PORT: String(port),
    OPENSCOUT_BROKER_URL: "http://127.0.0.1:1", OPENSCOUT_PARENT_PID: String(process.pid) };
  const entry = new URL("room-listening-daemon.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, [entry], { env, stdio: "ignore" });
  const exit = new Promise<number | null>(r => child.once("exit", r));
  try {
    let health: any;
    for (let i=0;i<100;i++) {
      try { health = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); if (health.ready) break; } catch {}
      await new Promise(r => setTimeout(r, 30));
    }
    expect(health).toMatchObject({ service: "room-listening", pid: child.pid, ready: true });
    expect(await readFile(join(home, "chat-listening/owner.pid"), "utf8")).toBe(String(child.pid));
    const secondPort = createServer(); await new Promise<void>(r => secondPort.listen(0, "127.0.0.1", r));
    const unusedPort = (secondPort.address() as AddressInfo).port; await new Promise<void>(r => secondPort.close(() => r()));
    const duplicate = spawn(process.execPath, [entry], { env: { ...env, OPENSCOUT_LISTENING_PORT: String(unusedPort) }, stdio: "ignore" });
    const duplicateExit = new Promise<number | null>(r => duplicate.once("exit", r));
    const deadline = setTimeout(() => duplicate.kill("SIGKILL"), 2000);
    const duplicateCode = await duplicateExit; clearTimeout(deadline);
    expect(duplicateCode).toBe(1); // Not just a port conflict: distinct endpoint, same canonical store.
    child.kill("SIGTERM"); expect(await exit).toBe(0);
    await expect(stat(join(home, "chat-listening/owner.pid"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await exit; }
}, 10_000);

test("isolated service can reopen its canonical store after owner SIGKILL without PID-lock repair", async () => {
  const home = await mkdtemp(join(tmpdir(), "scout-listener-crash-")); homes.push(home);
  const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, "127.0.0.1", r));
  const port = (reserve.address() as AddressInfo).port; await new Promise<void>(r => reserve.close(() => r()));
  const env = { ...process.env, OPENSCOUT_CONTROL_HOME: home, OPENSCOUT_LISTENING_PORT: String(port),
    OPENSCOUT_BROKER_URL: "http://127.0.0.1:1", OPENSCOUT_PARENT_PID: String(process.pid) };
  for (const signal of ["SIGKILL", "SIGTERM"] as const) {
    const child = spawn(process.execPath, [new URL("room-listening-daemon.ts", import.meta.url).pathname], { env, stdio: "ignore" });
    const exit = new Promise<void>(r => child.once("exit", () => r()));
    try {
      let ready = false;
      for (let i=0;i<100;i++) {
        try { const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any; ready = body.ready && body.pid === child.pid; if (ready) break; } catch {}
        await new Promise(r => setTimeout(r, 20));
      }
      expect(ready).toBe(true);
      child.kill(signal); await exit;
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; }
  }
}, 10_000);

test("session proof reads endpoint inventory, not the agents-only discovery snapshot", async () => {
  const h = await fixture(); const calls: string[] = []; let state = "idle";
  const service = createRoomListeningService({ ...h.options, fetcher: (async (url: any) => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    if (u.pathname === "/health") return Response.json({ nodeId: "node" });
    if (u.pathname === "/v1/endpoints") return Response.json({ endpoints: [{ id: "proof", agentId: "session-native", nodeId: "node", sessionId: "native", harness: "claude", transport: "claude_stream_json", state }] });
    throw Error("No full/agents snapshot is a live endpoint proof");
  }) as typeof fetch });
  try {
    await service.load();
    const sub = await service.enroll("session:native", h.member, "operator", { mode: "session", sessionId: "native", endpointId: "proof", harness: "claude" });
    expect(sub.binding).toMatchObject({ mode: "session", facing: "background", endpointId: "proof", state: "active" });
    expect(calls).toContain("/v1/endpoints?endpointId=proof");
    state = "stopped"; await service.tick();
    expect(service.status("session:native")[0]?.binding.state).toBe("ended");
    expect(calls.some(path => path.includes("snapshot"))).toBe(false);
  } finally { await service.stop(); await h.close(); }
});


test("R3: confirmed broker supersession ends binding; plain offline stays unknown and retired enrollment is refused", async () => {
  const h = await fixture();
  const endpoint: any = { id: "proof", agentId: "session-native", nodeId: "node", sessionId: "native", harness: "claude", transport: "claude_stream_json", state: "idle", metadata: {} };
  const service = createRoomListeningService({ ...h.options, fetcher: (async (url: any) =>
    Response.json(new URL(url).pathname === "/health" ? { nodeId: "node" } : { endpoints: [endpoint] })) as typeof fetch });
  const binding = { mode: "session" as const, sessionId: "native", endpointId: "proof", harness: "claude" };
  try {
    await service.load(); await service.enroll("session:native", h.member, "operator", binding);
    endpoint.state = "offline"; await service.tick();
    expect(service.status("session:native")[0]).toMatchObject({ binding: { state: "active" }, bindingAvailability: "unknown" });
    endpoint.metadata = { staleLocalRegistration: true, replacedByAgentId: "replacement" };
    await service.tick(); expect(service.status("session:native")[0]?.binding.state).toBe("ended");
    await expect(service.enroll("new-owner", h.member, "operator", binding)).rejects.toThrow("session_not_verified_live");
    endpoint.state = "idle"; // A contradictory stale positive state must not count as live proof either.
    await expect(service.enroll("new-owner", h.member, "operator", binding)).rejects.toThrow("session_not_verified_live");
  } finally { await service.stop(); await h.close(); }
});
