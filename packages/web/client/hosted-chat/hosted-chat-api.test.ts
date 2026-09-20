/**
 * The hosted adapter, which is the whole of the difference between hosted Chat
 * and local Chat. What is asserted here is the contract with the Worker in
 * `apps/hosted-chat/src`: slugs become space ids, writes carry CSRF, a rotated
 * token is recovered exactly once, and a capability the Worker does not have
 * refuses rather than returning a convincing empty result.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ChatApiError } from "../screens/chat-space/chat-api.ts";
import { HOSTED_CHAT_CAPABILITIES, createHostedChatApi } from "./hosted-chat-api.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];

const SPACE_ID = "a".repeat(32);
const OTHER_ID = "b".repeat(32);

type Responder = (call: RecordedCall) => Response;

function stubFetch(responder: Responder): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit & { body?: string }) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null,
    };
    calls.push(call);
    return Promise.resolve(responder(call));
  }) as typeof fetch;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The three reads `bootstrap()` composes, plus whatever the test adds. */
function hostedWorker(extra: Responder = () => json({ error: "not_found" }, 404)): Responder {
  return (call) => {
    const path = call.url.split("?")[0]!;
    if (path === "/api/auth/session") {
      return json({
        authenticated: true,
        account: { id: "gh-1", displayName: "Alex" },
        csrfToken: "csrf-1",
      });
    }
    if (path === "/api/chat/spaces" && call.method === "GET") {
      return json({
        spaces: [
          { id: SPACE_ID, slug: "work", title: "Work" },
          { id: OTHER_ID, slug: "personal", title: "Personal" },
        ],
      });
    }
    if (path === `/api/chat/spaces/${SPACE_ID}` && call.method === "GET") {
      return json({ channels: [{ id: "channel-one", title: "general" }] });
    }
    return extra(call);
  };
}

function urls(): string[] {
  return calls.map((call) => call.url);
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("hosted bootstrap", () => {
  test("composes the session, the space list and the selected space", async () => {
    stubFetch(hostedWorker());
    const found = await createHostedChatApi().bootstrap();

    expect(urls()).toEqual([
      "/api/auth/session",
      "/api/chat/spaces",
      `/api/chat/spaces/${SPACE_ID}`,
    ]);
    expect(found.viewer).toEqual({ actorId: "gh-1", displayName: "Alex", isOperator: true });
    expect(found.space).toBe("work");
    expect(found.channels.map((channel) => channel.id)).toEqual(["channel-one"]);
    // Only the opened space has a counted set of channels; the others are not
    // claimed to be empty.
    expect(found.spaces?.map((space) => space.channelCount)).toEqual([1, undefined]);
  });

  test("opens the asked-for space rather than the first one", async () => {
    stubFetch(hostedWorker((call) =>
      call.url === `/api/chat/spaces/${OTHER_ID}`
        ? json({ channels: [{ id: "channel-two", title: "general" }] })
        : json({ error: "not_found" }, 404)));

    const found = await createHostedChatApi().bootstrap({ space: "personal" });
    expect(found.space).toBe("personal");
    expect(urls().at(-1)).toBe(`/api/chat/spaces/${OTHER_ID}`);
  });

  test("a signed-out session is a sign-in prompt, not an empty room", async () => {
    stubFetch(() => json({ authenticated: false }));
    const error = await createHostedChatApi().bootstrap().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).status).toBe(401);
    expect((error as ChatApiError).reason).toBe("owner_sign_in_required");
    // It stopped at the session; no space read was attempted while signed out.
    expect(urls()).toEqual(["/api/auth/session"]);
  });

  test("no spaces is a real answer, not a failure", async () => {
    stubFetch((call) =>
      call.url === "/api/auth/session"
        ? json({ authenticated: true, account: { id: "gh-1", displayName: "Alex" }, csrfToken: "c" })
        : json({ spaces: [] }));

    const found = await createHostedChatApi().bootstrap();
    expect(found.spaces).toEqual([]);
    expect(found.channels).toEqual([]);
    expect(found.space).toBeUndefined();
  });
});

describe("slug to space id", () => {
  test("reads address the space by id, with the slug kept out of the wire", async () => {
    stubFetch(hostedWorker((call) =>
      call.url.startsWith("/api/channels/channel-one/feed")
        ? json({ messages: [{
            id: "m1",
            channelId: "channel-one",
            actorId: "gh-1",
            body: "hello",
            createdAt: 5,
            replyToMessageId: null,
          }] })
        : json({ error: "not_found" }, 404)));

    const api = createHostedChatApi();
    await api.bootstrap();
    const feed = await api.feed("channel-one", "work");

    expect(urls().at(-1)).toBe(`/api/channels/channel-one/feed?space=${SPACE_ID}`);
    expect(feed.messages.map((message) => message.id)).toEqual(["m1"]);
    // The Worker has no asks, so the surface is told there are none rather than
    // being handed a shape it would draw request state from.
    expect(feed.requests).toEqual([]);
  });

  test("an unknown selector fails here instead of being sent as a guess", async () => {
    stubFetch(hostedWorker());
    const api = createHostedChatApi();
    await api.bootstrap();
    const before = calls.length;

    const error = await api.feed("channel-one", "not-a-space").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).reason).toBe("space_not_found");
    expect(calls.length).toBe(before);
  });

  test("a space id passes through, so a deep link resolves before any list", async () => {
    stubFetch(hostedWorker((call) =>
      call.url.startsWith(`/api/channels/c1/members`)
        ? json({ members: [
            { actorId: "agent-1", displayName: "Agent", expiresAt: 10, revoked: 0 },
            { actorId: "agent-2", displayName: "Gone", expiresAt: 10, revoked: 1 },
          ] })
        : json({ error: "not_found" }, 404)));

    const members = await createHostedChatApi().members("c1", SPACE_ID);
    expect(urls().at(-1)).toBe(`/api/channels/c1/members?space=${SPACE_ID}`);
    // A revoked membership is somebody who left, not a member with a flag on.
    expect(members.members.map((member) => member.actorId)).toEqual(["agent-1"]);
  });
});

describe("writes", () => {
  test("carry JSON and the CSRF token the Worker demands", async () => {
    stubFetch(hostedWorker((call) =>
      call.method === "POST"
        ? json({ message: {
            id: "m2",
            channelId: "channel-one",
            actorId: "gh-1",
            body: "hi",
            createdAt: 6,
            replyToMessageId: null,
          } })
        : json({ error: "not_found" }, 404)));

    const api = createHostedChatApi();
    await api.bootstrap();
    await api.postMessage("channel-one", { requestId: "req-1", body: "hi", space: "work" });

    const post = calls.at(-1)!;
    expect(post.url).toBe(`/api/channels/channel-one/messages?space=${SPACE_ID}`);
    expect(post.method).toBe("POST");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.headers["x-csrf-token"]).toBe("csrf-1");
    expect(post.body).toEqual({ requestId: "req-1", body: "hi" });
  });

  test("a rotated token is recovered once, and the retry replays the same body", async () => {
    // The Worker's current token. The adapter caches whatever the session said
    // last; rotating this behind its back is what a rotated session looks like.
    let serverToken = "csrf-1";
    let denials = 0;
    stubFetch((call) => {
      const path = call.url.split("?")[0]!;
      if (path === "/api/auth/session") {
        return json({
          authenticated: true,
          account: { id: "gh-1", displayName: "Alex" },
          csrfToken: serverToken,
        });
      }
      if (call.method === "POST" && path.endsWith("/messages")) {
        if (call.headers["x-csrf-token"] !== serverToken) {
          denials += 1;
          return json({ error: "csrf_denied", reason: "csrf_denied" }, 403);
        }
        return json({ message: {
          id: "m3",
          channelId: "c1",
          actorId: "gh-1",
          body: call.body!.body as string,
          createdAt: 7,
          replyToMessageId: null,
        } });
      }
      return json({ error: "not_found" }, 404);
    });

    const api = createHostedChatApi();
    // The first write has no cached token, so it reads the session first and is
    // never denied. Rotating afterwards is what puts a stale token on the wire.
    const first = await api.postMessage("c1", { requestId: "r1", body: "one", space: SPACE_ID });
    expect(first.message.id).toBe("m3");
    expect(denials).toBe(0);

    serverToken = "csrf-2";
    const second = await api.postMessage("c1", { requestId: "r2", body: "two", space: SPACE_ID });
    expect(second.message.body).toBe("two");
    expect(denials).toBe(1);
    // Denied post, session re-read, replay — and the replay carries the same
    // body under the new token, so the message is not lost to the rotation.
    const replay = calls.at(-1)!;
    expect(replay.body).toEqual({ requestId: "r2", body: "two" });
    expect(replay.headers["x-csrf-token"]).toBe("csrf-2");
  });

  test("a permission refusal is not retried", async () => {
    stubFetch(hostedWorker((call) =>
      call.method === "POST"
        ? json({ error: "channel_access_denied", reason: "channel_access_denied" }, 403)
        : json({ error: "not_found" }, 404)));

    const api = createHostedChatApi();
    await api.bootstrap();
    const before = calls.length;
    const error = await api
      .postMessage("channel-one", { requestId: "r", body: "no", space: "work" })
      .catch((cause: unknown) => cause);

    expect((error as ChatApiError).status).toBe(403);
    expect(calls.length - before).toBe(1);
  });
});

describe("space deletion", () => {
  test("posts the Worker's delete route and forgets the slug", async () => {
    stubFetch(hostedWorker((call) =>
      call.url === `/api/chat/spaces/${SPACE_ID}/delete` && call.method === "POST"
        ? json({ deleted: true })
        : json({ error: "not_found" }, 404)));

    const api = createHostedChatApi();
    await api.bootstrap();
    expect(await api.deleteSpace!("work")).toEqual({ deleted: true });

    const deletion = calls.at(-1)!;
    expect(deletion.url).toBe(`/api/chat/spaces/${SPACE_ID}/delete`);
    expect(deletion.headers["x-csrf-token"]).toBe("csrf-1");
    // The slug no longer resolves, so a stale address cannot address the space
    // that was just deleted.
    await expect(api.feed("channel-one", "work")).rejects.toThrow(/not one of yours/);
  });

  test("the capability is declared, so the surface offers the control", () => {
    expect(HOSTED_CHAT_CAPABILITIES.spaceDelete).toBe(true);
    expect(createHostedChatApi().deleteSpace).toBeTypeOf("function");
  });
});

describe("capabilities the Worker does not have", () => {
  test("refuse in place rather than returning an empty result", async () => {
    stubFetch(hostedWorker());
    const api = createHostedChatApi();

    const refusals: (() => Promise<unknown>)[] = [
      () => api.postAsk("c1", { requestId: "r", body: "b", targetActorId: "agent-1" }),
      () => api.invites("c1"),
      () => api.revokeInvite("c1", "invite-1", "gh-1"),
      () => api.invitePreview("tok"),
      () => api.joinInvite("tok", "Agent"),
      () => api.me(),
      () => api.addReaction("c1", { messageId: "m1", emoji: "👍", requestId: "r" }),
      () => api.removeReaction("c1", { messageId: "m1", emoji: "👍", requestId: "r" }),
    ];
    for (const call of refusals) {
      const error = await call().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ChatApiError);
      expect((error as ChatApiError).status).toBe(501);
      expect((error as ChatApiError).reason).toBe("capability_unsupported");
    }
    // Not one of them touched the network.
    expect(calls).toEqual([]);
  });

  test("the declaration matches what is actually implemented", () => {
    expect(HOSTED_CHAT_CAPABILITIES.asks).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.inviteList).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.inviteRevoke).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.liveStream).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.memberDetail).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.reactions).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.attachments).toBe(true);
    expect(HOSTED_CHAT_CAPABILITIES.namedFirstChannel).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.inviteKinds).toEqual(["api"]);
    expect(HOSTED_CHAT_CAPABILITIES.signIn.startPath).toBe("/auth/github/start");
    expect(HOSTED_CHAT_CAPABILITIES.signIn.returnToParam).toBe("return_to");
  });
});
