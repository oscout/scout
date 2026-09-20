import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ChatApiError, chatApi } from "./chat-api.ts";

interface RecordedCall {
  url: string;
  init: (RequestInit & { body?: string }) | undefined;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];

type Responder = (call: RecordedCall) => Response | Promise<Response>;

function stubFetch(responder: Responder): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit & { body?: string }) => {
    const call: RecordedCall = { url: String(input), init };
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

function lastCall(): RecordedCall {
  const call = calls[calls.length - 1];
  if (!call) throw new Error("no request was made");
  return call;
}

function sentBody(): Record<string, unknown> {
  const body = lastCall().init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON body");
  return JSON.parse(body) as Record<string, unknown>;
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("transport", () => {
  test("every request carries the member cookie and skips the cache", async () => {
    stubFetch(() => json({ viewer: { actorId: "a", displayName: "A", isOperator: true }, channels: [] }));
    await chatApi.bootstrap();

    const call = lastCall();
    expect(call.url).toBe("/api/chat/bootstrap");
    expect(call.init?.credentials).toBe("include");
    expect(call.init?.cache).toBe("no-store");
    expect(headersOf(call).accept).toBe("application/json");
    // No body, so no content-type is claimed.
    expect(headersOf(call)["content-type"]).toBeUndefined();
    expect(call.init?.method).toBeUndefined();
  });

  test("a body request declares JSON", async () => {
    stubFetch(() => json({ message: { id: "m1" } }));
    await chatApi.postMessage("conv-1", {
      requestId: "req-1",
      body: "hi",
      attachments: [{ id: "att-1", mediaType: "image/png", fileName: "shot.png", url: "/api/blobs/att-1" }],
    });

    const call = lastCall();
    expect(call.init?.method).toBe("POST");
    expect(headersOf(call)["content-type"]).toBe("application/json");
    expect(sentBody().attachments).toEqual([
      { id: "att-1", mediaType: "image/png", fileName: "shot.png", url: "/api/blobs/att-1" },
    ]);
  });

  test("reactions POST add and remove, never a toggle", async () => {
    stubFetch(() => json({ ok: true, replayed: false }));
    await chatApi.addReaction("chn-1", { messageId: "m1", emoji: "👍", requestId: "r1" });
    expect(lastCall().url).toBe("/api/channels/chn-1/reactions");
    expect(sentBody()).toEqual({ messageId: "m1", emoji: "👍", requestId: "r1" });

    stubFetch(() => json({ ok: true, replayed: true }));
    await chatApi.removeReaction("chn-1", { messageId: "m1", emoji: "👍", requestId: "r2", space: "work" });
    expect(lastCall().url).toBe("/api/channels/chn-1/reactions/remove?space=work");
  });

  test("opaque ids are encoded into the path", async () => {
    stubFetch(() => json({ messages: [], requests: [] }));
    await chatApi.feed("conv/one two");
    expect(lastCall().url).toBe("/api/channels/conv%2Fone%20two/feed");

    stubFetch(() => json({ channel: {}, invite: {} }));
    await chatApi.invitePreview("tok/en");
    expect(lastCall().url).toBe("/api/invites/tok%2Fen");
  });

  test("a 200 with an empty body is an empty payload, not a parse crash", async () => {
    stubFetch(() => new Response("", { status: 200 }));
    await expect(chatApi.me()).resolves.toEqual({} as never);
  });
});

describe("errors", () => {
  test("401 is 'not a member', and keeps the server's words", async () => {
    stubFetch(() => json({ error: "Sign in to continue", reason: "no_member_cookie" }, 401));
    const error = (await chatApi.bootstrap().catch((thrown: unknown) => thrown)) as ChatApiError;

    expect(error).toBeInstanceOf(ChatApiError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Sign in to continue");
    expect(error.reason).toBe("no_member_cookie");
    expect(error.isUnauthenticated).toBe(true);
    expect(error.isOffline).toBe(false);
  });

  test("403 is also an identity problem, not a broken surface", async () => {
    stubFetch(() => json({ error: "Not your channel" }, 403));
    const error = (await chatApi.feed("conv-1").catch((thrown: unknown) => thrown)) as ChatApiError;
    expect(error.isUnauthenticated).toBe(true);
    expect(error.reason).toBeNull();
  });

  test("a non-JSON failure still names the call", async () => {
    stubFetch(() => new Response("<html>502</html>", { status: 502 }));
    const error = (await chatApi
      .postAsk("conv-1", { requestId: "req-1", body: "go", targetActorId: "actor-codex" })
      .catch((thrown: unknown) => thrown)) as ChatApiError;

    expect(error.status).toBe(502);
    expect(error.message).toBe("POST /api/channels/conv-1/asks failed (502)");
  });

  test("a transport failure is status 0, which the surface reads as disconnected", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const error = (await chatApi.feed("conv-1").catch((thrown: unknown) => thrown)) as ChatApiError;

    expect(error.status).toBe(0);
    expect(error.isOffline).toBe(true);
    expect(error.isUnauthenticated).toBe(false);
    expect(error.message).toBe("Failed to fetch");
  });
});

describe("posting", () => {
  test("a plain post carries its request id and nothing that invokes an agent", async () => {
    stubFetch(() => json({ message: { id: "m1" } }));
    await chatApi.postMessage("conv-1", { requestId: "req-1", body: "morning" });

    expect(lastCall().url).toBe("/api/channels/conv-1/messages");
    expect(sentBody()).toEqual({ requestId: "req-1", body: "morning" });
  });

  test("a thread reply anchors to its root", async () => {
    stubFetch(() => json({ message: { id: "m2" } }));
    await chatApi.postMessage("conv-1", {
      requestId: "req-2",
      body: "in thread",
      replyToMessageId: "m1",
    });
    expect(sentBody()).toEqual({ requestId: "req-2", body: "in thread", replyToMessageId: "m1" });
  });

  test("an ask names an explicitly selected actor", async () => {
    stubFetch(() => json({ message: { id: "m3" }, request: { messageId: "m3" } }));
    await chatApi.postAsk("conv-1", {
      requestId: "req-3",
      body: "check the build",
      targetActorId: "actor-codex",
    });

    expect(lastCall().url).toBe("/api/channels/conv-1/asks");
    expect(sentBody()).toEqual({
      requestId: "req-3",
      body: "check the build",
      targetActorId: "actor-codex",
    });
  });

  test("an empty topic is omitted rather than sent blank", async () => {
    stubFetch(() => json({ conversation: { id: "conv-2" } }));
    await chatApi.createChannel({ title: "design", topic: "   " });
    expect(sentBody()).toEqual({ title: "design" });

    await chatApi.createChannel({ title: "design", topic: " chat invites " });
    expect(sentBody()).toEqual({ title: "design", topic: "chat invites" });
  });
});

describe("invitations", () => {
  test("an agent invitation is single-use and bound to its issuer", async () => {
    stubFetch(() => json({ invite: {}, token: "tok", inviteUrl: "u", agentInstructionsUrl: "a" }));
    await chatApi.createInvite("conv-1", {
      kind: "agent",
      createdByActorId: "actor-maya",
      inviteeDisplayName: "Maya",
      inviteeActorId: "actor-maya",
    });

    expect(lastCall().url).toBe("/api/channels/conv-1/invites");
    expect(sentBody()).toEqual({
      createdByActorId: "actor-maya",
      maxRedemptions: 1,
      invitee: { displayName: "Maya", actorId: "actor-maya" },
    });
  });

  test("a teammate invitation stays multi-use", async () => {
    stubFetch(() => json({ invite: {}, token: "tok", inviteUrl: "u", agentInstructionsUrl: "a" }));
    await chatApi.createInvite("conv-1", {
      kind: "teammate",
      createdByActorId: "actor-maya",
      expiresInMs: 604_800_000,
    });
    expect(sentBody()).toEqual({
      createdByActorId: "actor-maya",
      maxRedemptions: null,
      expiresInMs: 604_800_000,
    });
  });

  test("opening an invitation link reads; only join mutates", async () => {
    stubFetch(() => json({ channel: {}, invite: {} }));
    await chatApi.invitePreview("tok");
    expect(lastCall().init?.method).toBeUndefined();

    stubFetch(() => json({ ok: true, conversationId: "conv-1" }));
    await chatApi.joinInvite("tok", "Sam");
    expect(lastCall().url).toBe("/api/invites/tok/join");
    expect(lastCall().init?.method).toBe("POST");
    expect(sentBody()).toEqual({ displayName: "Sam" });
  });

  test("revoking names who revoked it", async () => {
    stubFetch(() => json({ ok: true, invite: {} }));
    await chatApi.revokeInvite("conv-1", "inv-1", "actor-maya");
    expect(lastCall().url).toBe("/api/channels/conv-1/invites/inv-1/revoke");
    expect(sentBody()).toEqual({ revokedByActorId: "actor-maya" });
  });
});

describe("automatic local sign-in", () => {
  test("a fresh local browser bootstraps its cookie and retries the identity read once", async () => {
    let identityReads = 0;
    stubFetch(({ url }) => {
      if (url === "/api/bootstrap.js") return new Response("// bootstrap");
      return ++identityReads === 1 ? json({ error: "unauthorized" }, 401)
        : json({ viewer: { isOperator: true }, channels: [] });
    });
    expect((await chatApi.bootstrap()).viewer.isOperator).toBe(true);
    expect(calls.map(call => call.url)).toEqual([
      "/api/chat/bootstrap", "/api/bootstrap.js", "/api/chat/bootstrap",
    ]);
  });

  test("a remote browser retains the sign-in gate when bootstrap refuses issuance", async () => {
    stubFetch(() => json({ error: "unauthorized" }, 401));
    await expect(chatApi.bootstrap()).rejects.toMatchObject({ status: 401 });
    expect(calls.map(call => call.url)).toEqual(["/api/chat/bootstrap", "/api/bootstrap.js"]);
  });

  test("recovery is bounded even if bootstrap succeeds without a usable cookie", async () => {
    stubFetch(({ url }) => url === "/api/bootstrap.js" ? new Response("") : json({}, 401));
    await expect(chatApi.bootstrap()).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(3);
  });

  test("an invited member keeps their existing identity without operator bootstrap", async () => {
    stubFetch(() => json({ viewer: { actorId: "member", isOperator: false }, channels: [] }));
    expect((await chatApi.bootstrap()).viewer.isOperator).toBe(false);
    expect(calls.map(call => call.url)).toEqual(["/api/chat/bootstrap"]);
  });

  test("permission denials and writes do not trigger sign-in or replay", async () => {
    stubFetch(() => json({}, 403));
    await expect(chatApi.bootstrap()).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
    calls = [];
    stubFetch(() => json({}, 401));
    await expect(chatApi.postMessage("room", { requestId: "r", body: "hi" })).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });
});


describe("explicit sign-out", () => {
  test("the signed-out gate never refreshes the local cookie", async () => {
    stubFetch(() => json({}, 401));
    await expect(chatApi.bootstrap({ recoverSession: false })).rejects.toMatchObject({ status: 401 });
    expect(calls.map(call => call.url)).toEqual(["/api/chat/bootstrap"]);
  });
  test("logout failure is reported without an automatic auth retry", async () => {
    stubFetch(() => json({ error: "Unavailable" }, 503));
    await expect(chatApi.signOut()).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
    expect(lastCall().url).toBe("/api/logout");
    expect(lastCall().init?.method).toBe("POST");
  });
});
