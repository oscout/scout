import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { chatHostLocality, currentChatSession, describeChatInvite, parseChatInvite, renderChatInviteInfo, runChatCommand } from "./chat.ts";

const originalFetch = globalThis.fetch;
const directories: string[] = [];
let originalExitCode = process.exitCode;
beforeEach(() => { originalExitCode = process.exitCode; });
afterEach(async () => { process.exitCode = originalExitCode ?? 0; globalThis.fetch = originalFetch; for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

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
  test("info reads a local invitation without redeeming it and identifies the local service", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: any, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ channel: { id: "chn-1", title: "Something", memberCount: 2 }, invite: { kind: "agent", state: "active", expiresAt: Date.UTC(2026, 8, 24), createdByActorId: "art" }, space: { slug: "home", title: "Home" } }));
    }) as typeof fetch;
    const info = await describeChatInvite("http://scout.local/invite/tok123/agent.md", { fetcher, resolve: async () => ["127.0.0.1"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://scout.local/api/invites/tok123");
    expect(requests[0]!.init.method).toBe("GET");
    expect(info).toMatchObject({ channel: "Something", space: "Home", locality: "this-machine", memberCount: 2, joined: false });
    expect(renderChatInviteInfo(info)).toContain("this machine (loopback). Posts are sent to a service on this machine.");
  });
  test("info uses the hosted preview route and flags unencrypted network hosts", async () => {
    const token = `hi_${"a".repeat(32)}_${"b".repeat(64)}`;
    const requests: string[] = [];
    const fetcher = (async (url: any) => { requests.push(String(url)); return new Response(JSON.stringify({ kind: "agent", channelTitle: "ops", space: { title: "Team" }, expiresAt: null })); }) as typeof fetch;
    const info = await describeChatInvite(`http://chat.example/invite/${token}/agent.md`, { fetcher, resolve: async () => ["203.0.113.4"] });
    expect(requests).toEqual([`http://chat.example/api/invites/${token}/preview`]);
    expect(info.locality).toBe("network");
    expect(renderChatInviteInfo(info)).toContain("over plain HTTP (not encrypted)");
  });
  test("host locality resolves names instead of trusting them", async () => {
    expect(await chatHostLocality("localhost")).toBe("this-machine");
    expect(await chatHostLocality("[::1]")).toBe("this-machine");
    expect(await chatHostLocality("10.0.0.2")).toBe("network");
    expect(await chatHostLocality("scout.local", async () => ["127.0.0.1"])).toBe("this-machine");
    expect(await chatHostLocality("studio.local", async () => ["192.168.1.9"])).toBe("network");
    expect(await chatHostLocality("gone.local", async () => { throw new Error("ENOTFOUND"); })).toBe("unknown");
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

describe("joining starts at the present", () => {
  test("join seeds watch from poll.since, read is readable, and a quiet watch exits 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "scout-chat-cli-test-")); directories.push(root);
    const output: string[] = [];
    const text = createScoutCommandContext({ cwd: "/project", env: { OPENSCOUT_CHAT_HOME: root }, stdout: line => output.push(line) });
    const requests: string[] = [];
    globalThis.fetch = (async (url: any) => {
      requests.push(String(url));
      if (String(url).endsWith("/participate")) return new Response(JSON.stringify({ ok: true, actorId: "apia-me", conversationId: "chn-1", channelTitle: "general", space: { id: "s1", slug: "s1", title: "Team room" }, credential: { token: "t" }, poll: { url: "/p", since: "cursor-at-join" } }));
      if (String(url).includes("/feed?")) return new Response(JSON.stringify({ messages: [{ id: "m-1", actorName: "Ada", body: "Welcome\nsecond line", createdAt: Date.UTC(2026, 8, 30, 19, 5) }, { id: "m-2", actorName: "Bot", body: "ok", createdAt: Date.UTC(2026, 8, 30, 19, 6), replyToMessageId: "m-1" }], reachesStart: true }));
      return new Response(JSON.stringify({ messages: [], nextCursor: "cursor-at-join", hasMore: false, recommendedPollIntervalMs: 1000 }));
    }) as typeof fetch;
    await runChatCommand(text, ["join", "https://chat.example/invite/tok/agent.md", "--name", "probe"]);
    expect(requests.filter(url => url.includes("/poll?"))).toHaveLength(0);
    expect(output.join("\n")).toContain("Joined #general in Team room.");
    output.length = 0;
    await runChatCommand(text, ["read"]);
    expect(output.join("\n")).toContain("#general in Team room — 2 recent messages, from the start");
    expect(output.join("\n")).toContain("2026-09-30 19:05Z  Ada  [m-1]\n  Welcome\n  second line");
    expect(output.join("\n")).toContain("↳ in thread m-1");
    const previous = process.exitCode;
    try {
      await runChatCommand(text, ["watch", "--once", "--for", "1s"]);
      expect(process.exitCode).toBe(2);
    } finally { process.exitCode = previous; }
    expect(requests.at(-1)).toContain("cursor=cursor-at-join");
  });
});

describe("participant inbox CLI", () => {
  test("wait retries failures and empty pages, saves cursor, exits 0 only on items", async () => {
    const { waitForChatInbox } = await import("./chat.ts");
    let now = 0, reads = 0;
    const accepted: string[] = [], emitted: unknown[] = [];
    const code = await waitForChatInbox({ deadline: 10_000, now: () => now, sleep: async ms => { now += ms; },
      read: async () => { reads++; if (reads === 1) throw new Error("offline"); return { messages: reads === 3 ? ["mention"] : [], nextCursor: String(reads), hasMore: false }; },
      accept: async page => { accepted.push(page.nextCursor!); }, emit: page => emitted.push(page),
    });
    expect(code).toBe(0); expect(reads).toBe(3); expect(accepted).toEqual(["2", "3"]); expect(emitted).toHaveLength(1);
  });
  test("deadline after network errors or empty responses exits 2, never emits", async () => {
    const { waitForChatInbox } = await import("./chat.ts");
    for (const fail of [true, false]) {
      let now = 0;
      const code = await waitForChatInbox({ deadline: 3000, now: () => now, sleep: async ms => { now += ms; },
        read: async () => { if (fail) throw new Error("offline"); return { messages: [], nextCursor: null, hasMore: false }; },
        accept: async () => {}, emit: () => { throw new Error("must not emit"); },
      });
      expect(code).toBe(2); expect(now).toBe(3000);
    }
  });
  test("mentions resolve explicit ids and unique names, not ambiguous names", async () => {
    const { resolveChatMentions } = await import("./chat.ts");
    const members = [{ actorId: "a", displayName: "Muse" }, { actorId: "b", displayName: "Twin" }, { actorId: "c", displayName: "Twin" }];
    expect(resolveChatMentions(["@muse", "a"], members)).toEqual(["a"]);
    expect(() => resolveChatMentions(["@Twin"], members)).toThrow();
    expect(() => resolveChatMentions(["missing"], members)).toThrow();
  });
});

test("CLI inbox wiring persists separate cursors, emits counts, and sends explicit mentions", async () => {
  const root = await mkdtemp(join(tmpdir(), "scout-inbox-cli-test-")); directories.push(root);
  const output: string[] = [];
  const context = createScoutCommandContext({ cwd: "/inbox-project", env: { OPENSCOUT_CHAT_HOME: root }, stdout: line => output.push(line), outputMode: "json" });
  const calls: URL[] = []; const bodies: any[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname.endsWith("/participate")) return Response.json({ ok: true, conversationId: "room", actorId: "me", credential: { token: "private-token" } });
    if (url.pathname.endsWith("/members")) return Response.json({ members: [{ actorId: "muse", displayName: "Muse" }] });
    if (url.pathname.endsWith("/messages")) { bodies.push(JSON.parse(String(init.body))); return Response.json({ message: { id: "posted" } }); }
    expect(url.pathname.endsWith("/inbox")).toBe(true);
    return Response.json({ messages: [{ id: "mention", actorId: "muse", body: "private-content" }], reasons: { mention: ["mention"] }, nextCursor: "inbox-cursor", hasMore: false });
  }) as typeof fetch;
  await runChatCommand(context, ["join", "https://chat.example/invite/abc/api.md"]);
  await runChatCommand(context, ["say", "hi", "--mention", "@Muse"]);
  await runChatCommand(context, ["reply", "root", "yes", "--mention", "muse"]);
  expect(bodies.map(body => body.mentionActorIds)).toEqual([["muse"], ["muse"]]);
  expect(bodies[1].replyToMessageId).toBe("root");
  output.length = 0;
  const previous = process.exitCode;
  try {
    await runChatCommand(context, ["wait", "--count-only"]);
    expect(process.exitCode).toBe(0);
    expect(output.map(line => JSON.parse(line))).toEqual([{ count: 1 }]);
    expect(calls.at(-1)!.searchParams.get("wait")).toBe("20");
    await runChatCommand(context, ["watch", "--mentions", "--once"]);
    expect(calls.at(-1)!.searchParams.get("cursor")).toBe("inbox-cursor");
    const scope = (await readdir(root))[0]!;
    expect((await readdir(join(root, scope))).filter(file => file.startsWith("cursor-inbox-"))).toHaveLength(1);
  } finally { process.exitCode = previous; }
});

test("wait surfaces stale/revoked grants rather than silently skipping or waiting forever", async () => {
  const { waitForChatInbox, ChatHttpError } = await import("./chat.ts");
  for (const status of [401, 403, 409]) {
    await expect(waitForChatInbox({ deadline: Infinity,
      read: async () => { throw new ChatHttpError("grant or cursor invalid", status); },
      accept: async () => { throw new Error("must not advance"); }, emit: () => { throw new Error("must not wake"); },
    })).rejects.toThrow("grant or cursor invalid");
  }
});

test("wait emits before advancing cursor; output failure leaves wake replayable", async () => {
  const { waitForChatInbox } = await import("./chat.ts");
  const order: string[] = [];
  const page = { messages: ["mention"], nextCursor: "advanced", hasMore: false };
  expect(await waitForChatInbox({ deadline: Infinity, read: async () => page,
    emit: () => { order.push("emit"); }, accept: async () => { order.push("persist"); },
  })).toBe(0);
  expect(order).toEqual(["emit", "persist"]);
  order.length = 0;
  await expect(waitForChatInbox({ deadline: Infinity, read: async () => page,
    emit: () => { throw new Error("broken output"); }, accept: async () => { order.push("persist"); },
  })).rejects.toThrow("broken output");
  expect(order).toEqual([]);
});
