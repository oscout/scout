import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { currentChatSession, parseChatInvite, runChatCommand } from "./chat.ts";

const originalFetch = globalThis.fetch;
const directories: string[] = [];
afterEach(async () => { globalThis.fetch = originalFetch; for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("Chat invitation safety", () => {
  test("recognizes the running Grok session", () => {
    expect(currentChatSession({ GROK_SESSION_ID: "grok-current" })).toBe("grok-current");
  });
  test("accepts document links but refuses credential-bearing and unrelated URLs", () => {
    expect(parseChatInvite("https://chat.example/invite/abc/api.md").polling).toBe(true);
    expect(parseChatInvite("https://chat.example/invite/abc/agent.md").polling).toBe(false);
    expect(() => parseChatInvite("https://user:secret@chat.example/invite/abc")).toThrow();
    expect(() => parseChatInvite("file:///invite/abc")).toThrow();
    expect(() => parseChatInvite("https://chat.example/other")).toThrow();
  });
  test("persists retry identity before join; scopes requests and never prints credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "scout-chat-cli-test-")); directories.push(root);
    const output: string[] = [];
    const context = createScoutCommandContext({ cwd: "/project", env: { OPENSCOUT_CHAT_HOME: root }, stdout: line => output.push(line), outputMode: "json" });
    const requests: { url: string; init: RequestInit }[] = [];
    let first = true;
    globalThis.fetch = (async (url: any, init: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/participate")) {
        const scope = (await readdir(root))[0]!;
        const saved = JSON.parse(await readFile(join(root, scope, "membership.json"), "utf8"));
        const body = JSON.parse(init.body as string);
        expect(Object.values(saved.attempts)).toContain(body.participantKey);
        if (first) { first = false; throw new Error("connection interrupted"); }
        return new Response(JSON.stringify({ ok: true, actorId: "apia-test", conversationId: "chn-test", channelTitle: "general", space: { slug: "work" }, credential: { token: "private-token" } }));
      }
      if (String(url).includes("/poll?")) return new Response(JSON.stringify({ messages: [{ id: "incoming-one", body: "Hi" }], nextCursor: "cursor-one", recommendedPollIntervalMs: 3000 }));
      return new Response(JSON.stringify({ message: { id: "message-one" } }));
    }) as typeof fetch;
    const args = ["join", "https://chat.example/invite/test/agent.md"];
    await expect(runChatCommand(context, args)).rejects.toThrow("Chat connection failed");
    await runChatCommand(context, args);
    expect(JSON.parse(requests[0]!.init.body as string).participantKey).toBe(JSON.parse(requests[1]!.init.body as string).participantKey);
    await runChatCommand(context, ["reply", "parent-one", "Hello", "--request-id", "retry-one"]);
    const post = requests.at(-1)!;
    expect(post.url).toBe("https://chat.example/api/channels/chn-test/messages?space=work");
    expect(post.init.redirect).toBe("error");
    expect(new Headers(post.init.headers).get("authorization")).toBe("Bearer private-token");
    expect(JSON.parse(post.init.body as string)).toEqual({ requestId: "retry-one", body: "Hello", replyToMessageId: "parent-one" });
    const scope = (await readdir(root))[0]!;
    expect((await stat(join(root, scope, "membership.json"))).mode & 0o777).toBe(0o600);
    expect(output.join("\n")).not.toContain("private-token");
    output.length = 0;
    await runChatCommand(context, ["watch", "--for", "1s"]);
    expect(output).toEqual([JSON.stringify({ id: "incoming-one", body: "Hi" })]);
    await runChatCommand(context, ["watch", "--for", "1s"]);
    expect(requests.at(-1)!.url).toContain("cursor=cursor-one");
    output.length = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      messages: [
        { id: "own", actorId: "apia-test", body: "My greeting" },
        { id: "question", actorId: "operator", body: "Hello?", largeMetadata: "omit this" },
      ], nextCursor: "cursor-two", recommendedPollIntervalMs: 30000,
    }))) as unknown as typeof fetch;
    // A long watch must return promptly when a message arrives, without replaying our own post.
    await runChatCommand(context, ["watch", "--once", "--compact", "--for", "60m"]);
    expect(output.map(line => JSON.parse(line))).toEqual([{ id: "question", actorId: "operator", body: "Hello?" }]);
    const cursorFiles = (await readdir(join(root, scope))).filter(name => name.startsWith("cursor-"));
    expect(JSON.parse(await readFile(join(root, scope, cursorFiles[0]!), "utf8")).cursor).toBe("cursor-two");
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("cursor=")) return new Response(JSON.stringify({ reason: "stale" }), { status: 409 });
      return new Response(JSON.stringify({ messages: [{ id: "retained", actorId: "operator", body: "Newer message" }], nextCursor: "cursor-three" }));
    }) as typeof fetch;
    await expect(runChatCommand(context, ["watch", "--once", "--for", "1s"])).rejects.toThrow("watch --reset-cursor");
    expect(JSON.parse(await readFile(join(root, scope, cursorFiles[0]!), "utf8")).cursor).toBe("cursor-two");
    output.length = 0;
    await runChatCommand(context, ["watch", "--once", "--reset-cursor", "--for", "1s"]);
    expect(JSON.parse(output[0]!).id).toBe("retained");
    output.length = 0;
    globalThis.fetch = (async (url: any, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, replayed: false }));
    }) as typeof fetch;
    await runChatCommand(context, ["react", "incoming-one", "👍", "--request-id", "react-one"]);
    const react = requests.at(-1)!;
    expect(react.url).toBe("https://chat.example/api/channels/chn-test/reactions?space=work");
    expect(JSON.parse(react.init.body as string)).toEqual({
      requestId: "react-one",
      messageId: "incoming-one",
      emoji: "👍",
    });
    await runChatCommand(context, ["unreact", "incoming-one", "👍", "--request-id", "unreact-one"]);
    expect(requests.at(-1)!.url).toBe("https://chat.example/api/channels/chn-test/reactions/remove?space=work");
    expect(JSON.parse(await readFile(join(root, scope, cursorFiles[0]!), "utf8")).cursor).toBe("cursor-three");
  });
});
