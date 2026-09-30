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
  test("joined people remain people and do not receive space-owner controls", async () => {
    const base = hostedWorker(call => call.url.includes("/members?") ? json({ members: [
      { actorId: "gh-1", displayName: "Alex", kind: "person", participation: "teammate", revoked: 0 },
    ] }) : json({ error: "not_found" }, 404));
    stubFetch(call => call.url === `/api/chat/spaces/${SPACE_ID}` ? json({ isOwner: false, channels: [{ id: "channel-one", title: "General" }] }) : base(call));
    const api = createHostedChatApi();
    expect((await api.bootstrap({ space: "work" })).viewer.isOperator).toBe(false);
    const member = (await api.members("channel-one", "work")).members[0]!;
    expect(member.kind).toBe("person");
    expect(member.participation).toBeUndefined();
    expect(member.reception.summary).toBe("Member");
  });

  test("message corrections preserve revision metadata and send a CSRF-protected scoped command", async () => {
    const metadata = { chatCorrection: { revision: 2, deletedAt: 1234, changedBy: "owner" } };
    stubFetch(hostedWorker(call => call.url.includes("/corrections?") ? json({ ok: true, message: {
      id: "m-1", actorId: "owner", body: "", createdAt: 100, replyToMessageId: "root", metadata,
    } }) : json({ error: "not_found" }, 404)));
    const api = createHostedChatApi();
    await api.bootstrap({ space: "work" });
    const result = await api.correctMessage!("channel-one", "m-1", { expectedRevision: 1, deleted: true }, "work");
    expect(result.message).toMatchObject({ id: "m-1", body: "", replyToMessageId: "root", metadata });
    const write = calls.find(call => call.url.includes("/corrections?"))!;
    expect(write.url).toBe(`/api/channels/channel-one/corrections?space=${SPACE_ID}`);
    expect(write.headers["x-csrf-token"]).toBe("csrf-1");
    expect(write.body).toEqual({ messageId: "m-1", change: { expectedRevision: 1, deleted: true } });
  });

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
            actorName: "Former teammate",
            mentions: [{ actorId: "gh-1", label: "Alex" }],
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
    expect(feed.messages[0]?.actorName).toBe("Former teammate");
    expect(feed.messages[0]?.mentions).toEqual([{ actorId: "gh-1", label: "Alex" }]);
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
    expect(members.authoritative).toBe(true);
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
    await api.postMessage("channel-one", { requestId: "req-1", body: "hi", space: "work", mentionActorIds: ["person-alex"] });

    const post = calls.at(-1)!;
    expect(post.url).toBe(`/api/channels/channel-one/messages?space=${SPACE_ID}`);
    expect(post.method).toBe("POST");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.headers["x-csrf-token"]).toBe("csrf-1");
    expect(post.body).toEqual({ requestId: "req-1", body: "hi", mentionActorIds: ["person-alex"] });
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
    expect(HOSTED_CHAT_CAPABILITIES.inviteList).toBe(true);
    expect(HOSTED_CHAT_CAPABILITIES.inviteRevoke).toBe(true);
    expect(HOSTED_CHAT_CAPABILITIES.liveStream).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.memberDetail).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.reactions).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.attachments).toBe(true);
    expect(HOSTED_CHAT_CAPABILITIES.namedFirstChannel).toBe(false);
    expect(HOSTED_CHAT_CAPABILITIES.inviteKinds).toEqual(["teammate", "api"]);
    expect(HOSTED_CHAT_CAPABILITIES.signIn.startPath).toBe("/auth/github/start");
    expect(HOSTED_CHAT_CAPABILITIES.signIn.returnToParam).toBe("return_to");
  });
});


describe("hosted personal read state", () => {
  test("maps the space and authenticates acknowledgements without supplying an actor or sequence", async () => {
    const state = { channelId: "channel-one", actorId: "gh-1", lanes: [] };
    stubFetch(hostedWorker(call => call.url.includes("/read-state?")
      ? json(call.method === "GET" ? state : { ok: true }) : json({}, 404)));
    const api = createHostedChatApi();
    await api.bootstrap();
    expect(HOSTED_CHAT_CAPABILITIES.readState).toBe(true);
    expect(await api.readState!("channel-one", "work")).toEqual(state);
    await api.markRead!("channel-one", { messageId: "reply", rootMessageId: "root", space: "work" });
    const acknowledgement = calls.at(-1)!;
    expect(acknowledgement.url).toBe(`/api/channels/channel-one/read-state?space=${SPACE_ID}`);
    expect(acknowledgement.body).toEqual({ messageId: "reply", rootMessageId: "root" });
    expect(acknowledgement.headers["x-csrf-token"]).toBe("csrf-1");
  });
});


test("search safely encodes query and cursor while keeping the selected space", async () => {
  stubFetch(hostedWorker(call => call.url.includes("/search?") ? json({ messages: [], nextCursor: null }) : json({}, 404)));
  const api = createHostedChatApi();
  await api.bootstrap();
  await api.searchMessages!("channel-one", "100% & shipping", "cursor+value", "work");
  const url = new URL(calls.at(-1)!.url, "https://fixture.test");
  expect(url.searchParams.get("q")).toBe("100% & shipping");
  expect(url.searchParams.get("cursor")).toBe("cursor+value");
  expect(url.searchParams.get("space")).toBe(SPACE_ID);
});


describe("hosted human invitations", () => {
  test("previews without consuming, then joins with session CSRF and no chosen identity", async () => {
    stubFetch(hostedWorker(call => call.url.endsWith("/preview")
      ? json({ kind: "teammate", channelId: "c1", channelTitle: "general", space: { id: SPACE_ID, title: "Work" }, expiresAt: 123, alreadyMember: false })
      : call.url.endsWith("/join") ? json({ ok: true, actorId: "gh-1", conversationId: "c1", space: { id: SPACE_ID, slug: "work", title: "Work" } }) : json({}, 404)));
    const api = createHostedChatApi();
    expect((await api.previewHumanInvitation("token")).kind).toBe("teammate");
    expect(calls.map(call => call.method)).toEqual(["GET"]);
    const joined = await api.acceptHumanInvitation("token");
    expect(joined.space.slug).toBe("work");
    const write = calls.find(call => call.method === "POST")!;
    expect(write.url).toBe("/api/invites/token/join");
    expect(write.body).toEqual({});
    expect(write.headers["x-csrf-token"]).toBe("csrf-1");
  });
});


test("member removal targets one channel and carries only the target identity with session CSRF", async () => {
  stubFetch(hostedWorker(call => call.url.includes("/members/revoke?") ? json({ ok: true }) : json({}, 404)));
  const api = createHostedChatApi();
  await api.bootstrap({ space: "work" });
  await api.removeMember!("channel-one", "person-two", "work");
  const sent = calls.find(call => call.url.includes("/members/revoke?"))!;
  expect(sent.url).toBe(`/api/channels/channel-one/members/revoke?space=${SPACE_ID}`);
  expect(sent.body).toEqual({ actorId: "person-two" });
  expect(sent.headers["x-csrf-token"]).toBe("csrf-1");
  expect(HOSTED_CHAT_CAPABILITIES.memberRemove).toBe(true);
});


test("invitation management uses non-secret IDs and server-side authorship", async () => {
  const invite = { id: "hash-id", kind: "teammate", state: "active" };
  stubFetch(hostedWorker(call => call.method === "POST"
    ? json({ ok: true, invite: { ...invite, state: "revoked" } }) : json({ invites: [invite] })));
  const api = createHostedChatApi();
  await api.bootstrap({ space: "work" });
  expect((await api.invites("channel-one", "work")).invites[0]?.kind).toBe("teammate");
  expect((await api.revokeInvite("channel-one", "hash-id", "forged-author", "work")).invite.state).toBe("revoked");
  const write = calls.find(call => call.method === "POST")!;
  expect(write.url).toBe(`/api/channels/channel-one/invites/revoke?space=${SPACE_ID}`);
  expect(write.body).toEqual({ inviteId: "hash-id" });
  expect(write.headers["x-csrf-token"]).toBe("csrf-1");
});

test("hosted presence uses authenticated CSRF writes with no draft payload", async () => {
  stubFetch(hostedWorker(() => json({ people: [] })));
  const api = createHostedChatApi();
  const beat = { clientId: "tab", sequence: 1, active: true, typing: true, threadId: "root" };
  await api.bootstrap();
  await api.presence!("channel-one", beat, "work");
  const call = calls.find(call => call.url.includes("/presence?"))!;
  expect(call.url).toBe(`/api/channels/channel-one/presence?space=${SPACE_ID}`);
  expect(call.method).toBe("POST");
  expect(call.headers["x-csrf-token"]).toBeTruthy();
  expect(call.body).toEqual(beat);
});
