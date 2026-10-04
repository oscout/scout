import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { runChatCommand, renderChatHelp } from "./chat.ts";
import { chatListeningRequest } from "./chat-listening.ts";
const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(async () => { globalThis.fetch = originalFetch; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scout-listening-cli-")); dirs.push(root);
  const outputs: string[] = [], requests: { url: string; body: any }[] = [];
  const context = createScoutCommandContext({ cwd: "/tmp/first", env: { OPENSCOUT_CHAT_HOME: root, OPENSCOUT_LISTENING_URL: "http://127.0.0.1:1" }, stdout: text => outputs.push(text), outputMode: "json" });
  globalThis.fetch = (async (url: any, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(String(url).includes("/participate")
      ? { ok: true, conversationId: "room", actorId: "apia", credential: { token: "secret" }, space: { slug: "home" } }
      : { id: "sub", messages: [], ack: "receipt" }));
  }) as typeof fetch;
  return { root, outputs, requests, context };
}
test("enroll explicitly transfers joined membership to chosen durable identity without starting a watch", async () => {
  const h = await fixture();
  await runChatCommand(h.context, ["join", "http://scout.local/invite/token"]);
  await runChatCommand(h.context, ["enroll", "--agent", "durable"]);
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]).toMatchObject({ url: "http://127.0.0.1:1/v1/chat-listening/enroll", body: { agentId: "durable", membership: { actorId: "apia", token: "secret" } } });
  expect(h.outputs.join("\n")).not.toContain("secret");
});
test("catch-up, ack, status and unenroll are one-shot and independent of cwd/session membership files", async () => {
  const h = await fixture(); h.context.cwd = "/tmp/changed"; h.context.env.CODEX_THREAD_ID = "new-session";
  await runChatCommand(h.context, ["catch-up", "sub", "--agent", "durable", "--limit", "5"]);
  await runChatCommand(h.context, ["ack", "sub", "receipt", "--agent", "durable"]);
  await runChatCommand(h.context, ["status", "--agent", "durable"]);
  await runChatCommand(h.context, ["unenroll", "sub", "--agent", "durable"]);
  expect(h.requests).toHaveLength(4);
  expect(h.requests[0]?.body).toEqual({ agentId: "durable", subscriptionId: "sub", limit: 5 });
  expect(h.requests[1]?.body).toEqual({ agentId: "durable", subscriptionId: "sub", receipt: "receipt" });
  expect(await readdir(h.root)).toEqual([]);
});
test("explicit agent and valid local endpoint required; errors cannot echo credentials", async () => {
  const h = await fixture();
  await expect(runChatCommand(h.context, ["catch-up", "sub"])).rejects.toThrow("--agent");
  await expect(runChatCommand(h.context, ["enroll"])).rejects.toThrow("Usage");
  h.context.env.OPENSCOUT_LISTENING_URL = "https://hosted.example";
  await expect(chatListeningRequest(h.context, "enroll", {})).rejects.toThrow("loopback");
  h.context.env.OPENSCOUT_LISTENING_URL = "http://127.0.0.1:1";
  await expect(chatListeningRequest(h.context, "enroll", {}, (async () => new Response(JSON.stringify({ error: "credential secret = token" }), { status: 403 })) as unknown as typeof fetch)).rejects.toThrow("request_failed");
  expect(h.requests).toHaveLength(0);
});
test("help documents consent, one-shot catch-up and explicit acknowledgement", () => {
  expect(renderChatHelp()).toContain("enroll --agent");
  expect(renderChatHelp()).toContain("does not mark read");
  expect(renderChatHelp()).toContain("No watch,");
});

test("session enrollment and subsequent one-shot reads use explicit native identity and facing", async () => {
  const h = await fixture();
  await runChatCommand(h.context, ["join", "http://scout.local/invite/token"]);
  await runChatCommand(h.context, ["enroll", "--binding", "session", "--session", "native", "--herdr-session", "scout", "--pane", "w1:p1", "--harness", "claude", "--facing", "operator"]);
  expect(h.requests[1]?.body).toMatchObject({ agentId: "session:native", binding: { mode: "session", sessionId: "native", facing: "operator", herdrSession: "scout", pane: "w1:p1", harness: "claude" } });
  h.context.cwd = "/tmp/another";
  await runChatCommand(h.context, ["status", "--session", "native"]);
  expect(h.requests[2]?.body.agentId).toBe("session:native");
});

test("listening endpoint is independent of broker routing and has its own local port override", async () => {
  const h = await fixture(); delete h.context.env.OPENSCOUT_LISTENING_URL;
  h.context.env.OPENSCOUT_BROKER_URL = "http://127.0.0.1:9";
  await chatListeningRequest(h.context, "status", { agentId: "durable" });
  expect(h.requests[0]?.url).toBe("http://127.0.0.1:43112/v1/chat-listening/status");
  h.context.env.OPENSCOUT_LISTENING_PORT = "43113";
  await chatListeningRequest(h.context, "status", { agentId: "durable" });
  expect(h.requests[1]?.url).toBe("http://127.0.0.1:43113/v1/chat-listening/status");
});
