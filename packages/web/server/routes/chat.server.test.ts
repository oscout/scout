import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CHANNEL_NATURAL_KEY_METADATA,
  CHANNEL_SPACE_SLUG_METADATA,
  namedChannelNaturalKey,
  spaceNaturalKey,
  spacedChannelNaturalKey,
  stableChannelId,
} from "@openscout/protocol";
import { encodeChannelPollCursor } from "../core/conversations/channel-polling.ts";
import {
  stubs,
  CHANNEL_MEMBER_COOKIE,
  channelMemberCookie,
  chatMarkReadCalls,
  chatReadCursors,
  createChannelMemberSessionAuthority,
  createOpenScoutWebServer,
  decidePairingApprovalCalls,
  interruptPairingCalls,
  makePairingState,
  makeStaticRoot,
  queryRecentMessagesCalls,
  questionHistoryCalls,
  sendScoutConversationMessageCalls,
  sendScoutConversationSteerCalls,
  sendScoutMessageReactionCalls,
  upsertScoutConversationCalls,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("channel invitations over HTTP", () => {
  const CHANNEL_ID = "chn-0123456789abcdef0123456789abcdef";
  const NOW = 1_800_000_000_000;
  // Raw token in the fixture, with the digest the broker actually stores. The
  // record never holds the token itself, so the test has to hash it the same
  // way production does.
  const TOKEN = "vx3k9dqm-portable-invite";
  const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

  const seedInvitedChannel = (overrides?: Record<string, unknown>) => {
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        conversations: {
          [CHANNEL_ID]: {
            id: CHANNEL_ID,
            kind: "channel",
            title: "release-train",
            topic: "Coordination for the openscout release train.",
            participantIds: ["person-art", "agent-kepler"],
            metadata: {
              channelInvites: [
                {
                  id: "cinv-1",
                  channelId: CHANNEL_ID,
                  scope: "channel_participation",
                  tokenHash: TOKEN_HASH,
                  tokenHint: "vx3k",
                  createdAt: NOW - 1000,
                  createdByActorId: "person-art",
                  expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
                  maxRedemptions: null,
                  route: {
                    authorityNodeId: "node-1",
                    host: "chat.scout.local",
                    baseUrl: "http://chat.scout.local",
                    reachability: "unknown",
                    caveat: "chat.scout.local resolves to 127.0.0.1 on every machine.",
                  },
                  redemptions: [
                    {
                      id: "crdm-1",
                      actorId: "agent-kepler",
                      agentId: "agent-kepler",
                      sessionId: "sess.kepler",
                      redeemedAt: NOW - 500,
                    },
                  ],
                  ...(overrides ?? {}),
                },
              ],
            },
          },
        },
        actors: {
          "person-art": { id: "person-art", kind: "person", displayName: "Art" },
          "agent-kepler": { id: "agent-kepler", kind: "agent", displayName: "Kepler" },
        },
        agents: {
          "agent-kepler": {
            id: "agent-kepler",
            kind: "agent",
            displayName: "Kepler",
            authorityNodeId: "node-1",
            ownerId: "person-art",
          },
        },
        endpoints: {},
      },
    };
  };

  const makeServer = async () => createOpenScoutWebServer({
    currentDirectory: "/tmp/openscout",
    assetMode: "static",
    staticRoot: makeStaticRoot(),
    advertisedHost: "m1.scout.local",
    portalHost: "scout.local",
    resolvePeerAddress: () => "127.0.0.1",
  });

  test("describing an invitation is a pure read that never joins anyone", async () => {
    seedInvitedChannel();
    const server = await makeServer();

    const response = await server.app.request(`http://localhost/api/invites/${TOKEN}`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;

    expect(body.channel.title).toBe("release-train");
    expect(body.invite.state).toBe("active");
    // Membership is untouched by reading the link.
    expect(body.channel.memberCount).toBe(2);
    // The digest is the stored secret material; it must not travel to a client.
    expect(JSON.stringify(body)).not.toContain(TOKEN_HASH);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  test("an unknown token is refused without revealing whether the channel exists", async () => {
    seedInvitedChannel();
    const server = await makeServer();

    const response = await server.app.request(
      "http://localhost/api/invites/definitely-not-a-real-invite-token",
    );
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("This invitation link is not valid.");
    expect(body.error).not.toContain("release-train");
  });

  test("the agent document is self-sufficient and carries no stored digest", async () => {
    seedInvitedChannel();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/invite/${TOKEN}/agent.md`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    // The document embeds a live capability; shared caches must not keep it.
    expect(response.headers.get("cache-control")).toBe("no-store");

    const markdown = await response.text();
    expect(markdown).toContain("release-train");
    expect(markdown).toContain(CHANNEL_ID);
    // The four things an agent handed only this document needs.
    expect(markdown.toLowerCase()).toContain("redeem");
    expect(markdown.toLowerCase()).toContain("retry");
    expect(markdown).toContain("Membership is not reception");
    expect(markdown).not.toContain(TOKEN_HASH);
  });

  test("removed members stay out of the complete roster despite retained messages", async () => {
    seedInvitedChannel();
    const snapshot = (stubs.scoutBrokerContextResult as any).snapshot;
    snapshot.conversations[CHANNEL_ID].participantIds = ["person-art"];
    snapshot.conversations[CHANNEL_ID].metadata.channelMemberRemovals = {
      "agent-kepler": { removedAt: NOW, removedByActorId: "operator", blockedInviteIds: ["cinv-1"] },
    };
    snapshot.messages = { old: { id: "old", actorId: "agent-kepler", conversationId: CHANNEL_ID, body: "Retained history" } };
    const server = await makeServer();
    const response = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/members`);
    const body = await response.json() as any;
    expect(body.authoritative).toBe(true);
    expect(body.members.map((member: any) => member.actorId)).toEqual(["person-art"]);
    expect(snapshot.messages.old.body).toBe("Retained history");
  });

  test("member removal derives operator authority and rejects extra identity fields", async () => {
    seedInvitedChannel();
    const writes: any[] = [];
    globalThis.fetch = (async (_input: any, init: any) => {
      writes.push(JSON.parse(init.body));
      return Response.json({ ok: true, participantIds: ["person-art"] });
    }) as typeof fetch;
    const server = await makeServer();
    const url = `http://localhost/api/channels/${CHANNEL_ID}/members/revoke`;
    const post = (body: any) => server.app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ actorId: "agent-kepler", removedByActorId: "someone-else" })).status).toBe(400);
    expect(writes).toHaveLength(0);
    expect((await post({ actorId: "agent-kepler" })).status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "channel.member.remove", actorId: "agent-kepler", removedByActorId: "operator", channelId: CHANNEL_ID });
  });

  test("members report reception from evidence, not from membership", async () => {
    seedInvitedChannel();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/members`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { members: Array<Record<string, any>> };

    expect(body.members).toHaveLength(2);
    const kepler = body.members.find((member) => member.actorId === "agent-kepler");
    // Redeemed, in the roster, and with no endpoint at all: being a member is
    // not evidence that anything is listening.
    expect(kepler?.reception.listening).toBe(false);
    expect(kepler?.reception.state).not.toBe("ready_to_receive");
    expect(kepler?.reception.detail).toBeTruthy();
    // Ownership is what lets the UI say "Art's Kepler".
    expect(kepler?.owner).toEqual({ actorId: "person-art", displayName: "Art" });
  });

  test("a revoked invitation is refused and says so", async () => {
    seedInvitedChannel({ revokedAt: NOW - 100, revokedByActorId: "person-art" });
    const server = await makeServer();

    const describe = await server.app.request(`http://localhost/api/invites/${TOKEN}`);
    const body = await describe.json() as Record<string, any>;
    expect(body.invite.state).toBe("revoked");

    const redeem = await server.app.request(
      `http://localhost/api/invites/${TOKEN}/redeem`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorId: "agent-newcomer", sessionId: "sess.new" }),
      },
    );
    // Gone for good, not "try again".
    expect(redeem.status).toBe(410);
  });

  test("redeeming without an identity is refused before any broker write", async () => {
    seedInvitedChannel();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/invites/${TOKEN}/redeem`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sess.anonymous" }),
      },
    );
    expect(response.status).toBe(403);
    const body = await response.json() as { reason?: string };
    expect(body.reason).toBe("missing_identity");
  });

  test("listing invitations exposes hints, never digests", async () => {
    seedInvitedChannel();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/invites`,
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).toContain("vx3k");
    expect(raw).not.toContain(TOKEN_HASH);
  });
});

describe("the Scout Chat surface over HTTP", () => {
  const CHANNEL_ID = "chn-0123456789abcdef0123456789abcdef";
  const THREAD_ID = "chn-aaaabbbbccccddddeeeeffff00001111";
  const NOW = 1_800_000_000_000;

  const seedChatChannel = () => {
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        // A real snapshot always carries these maps; the chat feed reads both.
        messages: {
          "m-root": {
            id: "m-root", conversationId: CHANNEL_ID, actorId: "person-art",
            originNodeId: "node-1", class: "agent", body: "cut the tag?",
            visibility: "workspace", policy: "durable", createdAt: NOW - 400,
          },
          "m-reply": {
            id: "m-reply", conversationId: THREAD_ID, actorId: "agent-kepler",
            originNodeId: "node-1", class: "agent", body: "on it",
            visibility: "workspace", policy: "durable", createdAt: NOW - 300,
          },
        },
        conversations: {
          [CHANNEL_ID]: {
            id: CHANNEL_ID,
            kind: "channel",
            title: "release-train",
            visibility: "workspace",
            shareMode: "shared",
            authorityNodeId: "node-1",
            participantIds: ["person-art", "agent-kepler", "agent-vega"],
            metadata: {
              channelInvites: [
                {
                  id: "cinv-1",
                  channelId: CHANNEL_ID,
                  scope: "channel_participation",
                  tokenHash: "d1ge57",
                  tokenHint: "vx3k",
                  createdAt: NOW - 1000,
                  createdByActorId: "person-art",
                  expiresAt: null,
                  maxRedemptions: null,
                  route: {
                    authorityNodeId: "node-1",
                    host: "chat.scout.local",
                    baseUrl: "http://chat.scout.local",
                    reachability: "unknown",
                  },
                  // Kepler redeemed from a concrete session. Vega is in the
                  // room but never redeemed, so nothing attaches it here.
                  redemptions: [
                    {
                      id: "crdm-1",
                      actorId: "agent-kepler",
                      agentId: "agent-kepler",
                      sessionId: "sess.kepler",
                      redeemedAt: NOW - 500,
                    },
                  ],
                },
              ],
            },
          },
          [THREAD_ID]: {
            id: THREAD_ID,
            kind: "thread",
            title: "Re: cut the tag",
            visibility: "workspace",
            shareMode: "shared",
            authorityNodeId: "node-1",
            parentConversationId: CHANNEL_ID,
            messageId: "m-root",
            participantIds: ["person-art", "agent-kepler"],
          },
        },
        actors: {
          "person-art": { id: "person-art", kind: "person", displayName: "Art" },
          "agent-kepler": { id: "agent-kepler", kind: "agent", displayName: "Kepler" },
          "agent-vega": { id: "agent-vega", kind: "agent", displayName: "Vega" },
        },
        agents: {
          "agent-kepler": {
            id: "agent-kepler", kind: "agent", displayName: "Kepler",
            authorityNodeId: "node-1", ownerId: "person-art",
          },
          "agent-vega": {
            id: "agent-vega", kind: "agent", displayName: "Vega",
            authorityNodeId: "node-1", ownerId: "person-art",
          },
        },
        endpoints: {
          "ep-kepler": {
            id: "ep-kepler",
            agentId: "agent-kepler",
            state: "idle",
            transport: "codex_app_server",
            sessionId: "sess.kepler",
            metadata: { lastSeenAt: NOW },
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "person-art",
            targetAgentId: "agent-kepler",
            state: "running",
            metadata: { conversationId: CHANNEL_ID },
          },
          "flt-elsewhere": {
            id: "flt-elsewhere",
            invocationId: "inv-2",
            requesterId: "person-art",
            targetAgentId: "agent-vega",
            state: "running",
            metadata: { conversationId: "chn-99999999999999999999999999999999" },
          },
        },
        invocations: {
          "inv-1": { id: "inv-1", conversationId: CHANNEL_ID, messageId: "m-root" },
          "inv-2": {
            id: "inv-2",
            conversationId: "chn-99999999999999999999999999999999",
            messageId: "m-other",
          },
        },
      },
    };
  };

  const makeServer = async () => createOpenScoutWebServer({
    currentDirectory: "/tmp/openscout",
    assetMode: "static",
    staticRoot: makeStaticRoot(),
    advertisedHost: "m1.scout.local",
    portalHost: "scout.local",
    resolvePeerAddress: () => "127.0.0.1",
  });

  test("bootstrap names the viewer and the channels they can see", async () => {
    seedChatChannel();
    const server = await makeServer();

    const response = await server.app.request("http://localhost/api/chat/bootstrap");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.viewer.isOperator).toBe(true);
    // Only channels. A thread is a conversation underneath one, not a room in
    // its own right, and listing it would double the sidebar.
    expect(body.channels.map((channel: { id: string }) => channel.id)).toEqual([CHANNEL_ID]);
  });

  test("chat cancellation delegates to the broker and preserves an active refusal", async () => {
    seedChatChannel();
    const server = await makeServer();
    const cancel = (flight: string) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks/${flight}/cancel`, { method: "POST" });
    expect((await cancel("flt-elsewhere")).status).toBe(404);
    expect(chatMarkReadCalls).toHaveLength(0);
    const refused = await cancel("flt-1");
    expect(refused.status).toBe(409);
    expect((stubs.scoutBrokerContextResult as any).snapshot.flights["flt-1"].state).toBe("running");
    (stubs.scoutBrokerContextResult as any).snapshot.flights["flt-1"].state = "queued";
    const accepted = await cancel("flt-1");
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as any).request.state).toBe("cancelled");
    expect(chatMarkReadCalls).toEqual([{ kind: "cancel", flightId: "flt-1" }, { kind: "cancel", flightId: "flt-1" }]);
  });

  test("tracked asks expose recorded outcomes and preserve the canonical lifecycle", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    const snapshot = (stubs.scoutBrokerContextResult as any).snapshot;
    Object.assign(snapshot.flights["flt-1"], { state: "completed", summary: "Verified the release", output: "result ".repeat(700), completedAt: NOW });
    const server = await makeServer();
    const response = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/feed`);
    const request = (await response.json() as any).requests[0];
    expect(request).toMatchObject({ state: "completed", requesterActorId: "person-art", requesterName: "Art", summary: "Verified the release", completedAt: NOW, outputTruncated: true });
    expect(request.output).toHaveLength(4000);
    expect(request.outputUrl).toBe(`/api/channels/${CHANNEL_ID}/asks/flt-1/output`);
    const full = await server.app.request(`http://localhost${request.outputUrl}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toContain("text/plain");
    expect(full.headers.get("cache-control")).toBe("no-store");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await full.text()).toBe("result ".repeat(700));
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks/flt-elsewhere/output`)).status).toBe(404);
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks/missing/output`)).status).toBe(404);
    Object.assign(snapshot.flights["flt-1"], { state: "failed", error: "Harness exited before completion" });
    const failed = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/feed`);
    expect((await failed.json() as any).requests[0]).toMatchObject({ state: "failed", error: "Harness exited before completion" });
  });

  test("question history reads retained answers with scoped pagination and honest failures", async () => {
    seedChatChannel();
    stubs.questionHistoryRecords = Array.from({ length: 52 }, (_, index) => ({ id: `q-${String(index).padStart(2, "0")}`, kind: "question", title: `Resolved ${index}`, state: index % 2 ? "declined" : "closed", createdAt: 1, updatedAt: 2, conversationId: index === 51 ? THREAD_ID : CHANNEL_ID, createdById: "person-art", answer: `Retained answer ${index}` }));
    stubs.questionHistoryRecords.push({ ...stubs.questionHistoryRecords[0], id: "hidden", conversationId: "elsewhere" });
    const server = await makeServer();
    const path = `http://localhost/api/channels/${CHANNEL_ID}/questions/history`;
    const response = await server.app.request(path);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = await response.json() as any;
    expect(first.questions).toHaveLength(50);
    expect(first.questions[0]).toMatchObject({ settled: true, answer: "Retained answer 0", actions: [] });
    const second = await (await server.app.request(`${path}?cursor=${first.nextCursor}`)).json() as any;
    expect(second.questions.map((q: any) => q.recordId)).toEqual(["q-50", "q-51"]);
    expect(questionHistoryCalls.at(-1)).toMatchObject({ channelId: CHANNEL_ID, after: { createdAt: 1, id: "q-49" } });
    expect((await server.app.request(`${path}?cursor=bad`)).status).toBe(400);
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/questions?cursor=${first.nextCursor}`)).status).toBe(400);
    const beforeMissing = questionHistoryCalls.length;
    expect((await server.app.request("http://localhost/api/channels/chn-ffffffffffffffffffffffffffffffff/questions/history")).status).toBe(404);
    expect(questionHistoryCalls).toHaveLength(beforeMissing);
    stubs.questionHistoryFailure = true;
    expect((await server.app.request(path)).status).toBe(503);
  });

  test("Chat activity derives identity and preserves inactive sequence ordering", async () => {
    seedChatChannel();
    const server = await makeServer();
    const post = (change: Record<string, unknown> = {}) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/presence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "tab", sequence: 1, active: true, typing: true, ...change }) });
    expect((await post({ actorId: "forged" })).status).toBe(400);
    expect((await post({ body: "never send draft text" })).status).toBe(400);
    expect((await post({ sequence: -1 })).status).toBe(400);
    const response = await post();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as any).people).toMatchObject([{ actorId: "operator", typing: [{ threadId: null }] }]);
    expect((await (await post({ sequence: 3, active: false, typing: false })).json() as any).people).toEqual([]);
    expect((await (await post({ sequence: 2 })).json() as any).people).toEqual([]);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
  });

  test("channel question inbox discovers old questions independently of feed messages", async () => {
    seedChatChannel();
    const snapshot = (stubs.scoutBrokerContextResult as any).snapshot;
    snapshot.collaborationRecords = Object.fromEntries(Array.from({ length: 52 }, (_, index) => [`q-${String(index).padStart(2, "0")}`, {
      id: `q-${String(index).padStart(2, "0")}`, kind: "question", state: "open", title: `Question ${index}`, createdAt: 1, updatedAt: 1,
      conversationId: index === 51 ? THREAD_ID : CHANNEL_ID, createdById: "agent-kepler", nextMoveOwnerId: "operator",
    }]));
    snapshot.collaborationRecords.other = { ...snapshot.collaborationRecords["q-00"], id: "other", conversationId: "elsewhere" };
    const server = await makeServer();
    const first = await (await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/questions`)).json() as any;
    const bootstrap = await (await server.app.request("http://localhost/api/chat/bootstrap")).json() as any;
    expect(bootstrap.questionCounts).toEqual({ [CHANNEL_ID]: 52 });
    expect(first.questions).toHaveLength(50);
    expect(first.questions[0]).toMatchObject({ recordId: "q-00", updatedAt: 1, actions: ["answer"] });
    const next = await (await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/questions?cursor=${first.nextCursor}`)).json() as any;
    expect(next.questions.map((question: any) => question.recordId)).toEqual(["q-50", "q-51"]);
    expect(next.nextCursor).toBeNull();
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/questions?cursor=invalid`)).status).toBe(400);
  });

  test("question responses derive identity from the session and refuse identity fields", async () => {
    seedChatChannel();
    const server = await makeServer();
    const path = `http://localhost/api/channels/${CHANNEL_ID}/questions/question-1/respond`;
    const post = (body: unknown) => server.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ action: "close", expectedUpdatedAt: 1, actorId: "somebody-else" })).status).toBe(400);
    expect(chatMarkReadCalls).toHaveLength(0);
    const response = await post({ action: "close", expectedUpdatedAt: 1 });
    expect(response.status).toBe(200);
    expect(chatMarkReadCalls[0]).toMatchObject({ kind: "question-response", channelId: CHANNEL_ID, questionId: "question-1", actorId: "operator", isOperator: true, change: { action: "close", expectedUpdatedAt: 1 } });
    expect((await response.json() as any).responsibility).toMatchObject({ state: "closed", actions: [], settled: true });
  });

  test("tracked asks preserve channel-scoped collaboration responsibility after completion", async () => {
    seedChatChannel();
    const snapshot = (stubs.scoutBrokerContextResult as any).snapshot;
    snapshot.invocations["inv-1"].collaborationRecordId = "question-1";
    snapshot.flights["flt-1"].state = "completed";
    snapshot.collaborationRecords = { "question-1": { id: "question-1", kind: "question", state: "answered", title: "Approve the answer", conversationId: CHANNEL_ID, nextMoveOwnerId: "person-art", answer: "Proposed answer" } };
    const server = await makeServer();
    const read = async () => (await (await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/feed`)).json() as any).requests[0];
    expect(await read()).toMatchObject({ state: "completed", responsibility: { state: "answered", actorId: "person-art", actorName: "Art", settled: false } });
    snapshot.collaborationRecords["question-1"].conversationId = "another-channel";
    expect((await read()).responsibility).toBeUndefined();
  });

  test("Chat execution controls require the observed associated turn and acknowledge only submission", async () => {
    seedChatChannel();
    const nodeId = (stubs.scoutBrokerContextResult as any).node.id;
    stubs.queryFlightsResult = [{ id: "execution-flight", conversationId: CHANNEL_ID, state: "running", agentId: "agent-kepler", sessions: [{ sessionId: "session", nodeId, startedAt: 100, lastAcknowledgedAt: 101 }] }];
    stubs.pairingSessionSnapshotsResult = [{ session: { id: "session", name: "Execution", adapterType: "test", status: "active" }, currentTurnId: "turn", turns: [{ id: "turn", status: "streaming", startedAt: 110, blocks: [] }] }];
    const server = await makeServer();
    const path = `http://localhost/api/channels/${CHANNEL_ID}/asks/execution-flight/execution`;
    const post = (change: Record<string, unknown> = {}) => server.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "session", turnId: "turn", ...change }) });
    expect(await (await server.app.request(path)).json()).toMatchObject({ available: true, turnId: "turn", interruptible: true });
    expect((await post({ actorId: "other" })).status).toBe(400);
    expect((await post({ turnId: "old" })).status).toBe(409);
    expect(interruptPairingCalls).toHaveLength(0);
    expect(await (await post()).json()).toEqual({ ok: true, status: "submitted" });
    expect(interruptPairingCalls).toEqual([{ sessionId: "session", turnId: "turn" }]);
    expect(stubs.queryFlightsResult[0]!.state).toBe("running");
    stubs.interruptPairingFailure = true;
    expect((await post()).status).toBe(502);
    stubs.pairingSessionSnapshotsResult[0]!.turns[0]!.status = "interrupted";
    stubs.pairingSessionSnapshotsResult[0]!.currentTurnId = undefined;
    expect(await (await server.app.request(path)).json()).toMatchObject({ status: "interrupted", interruptible: false });
    expect((await post()).status).toBe(409);
    expect(interruptPairingCalls).toHaveLength(2);
    stubs.pairingSessionSnapshotsResult = [];
    expect((await post()).status).toBe(503);
    stubs.queryFlightsResult.push({ ...stubs.queryFlightsResult[0]!, id: "competing", conversationId: "other-channel" });
    expect(await (await server.app.request(path)).json()).toEqual({ available: false });
    expect((await post()).status).toBe(409);
    stubs.queryFlightsResult[0]!.conversationId = "elsewhere";
    expect((await post()).status).toBe(404);
  });

  test("Chat approval reads use a current local session and fresh bridge state", async () => {
    seedChatChannel();
    const localNodeId = (stubs.scoutBrokerContextResult as any).node.id;
    stubs.queryFlightsResult = [{ id: "approval-flight", conversationId: CHANNEL_ID, state: "waiting", agentId: "agent-kepler", sessions: [{ sessionId: "approval-session", nodeId: localNodeId, startedAt: 100, lastAcknowledgedAt: 101 }] }];
    const approval = { sessionId: "approval-session", turnId: "turn", blockId: "block", version: 1, turnStartedAt: 110, actionStatus: "awaiting_approval" };
    stubs.pairingStateResult = makePairingState({ isRunning: true, pendingApprovals: [approval, { ...approval, turnStartedAt: 99 }] });
    const server = await makeServer();
    const path = `http://localhost/api/channels/${CHANNEL_ID}/asks/approval-flight/approvals`;
    const response = await server.app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ available: true, sessionId: "approval-session", approvals: [approval] });
    expect(stubs.refreshPairingStateCalls).toBeGreaterThan(0);
    stubs.pairingStateResult = makePairingState({ isRunning: false });
    expect((await server.app.request(path)).status).toBe(503);
    stubs.queryFlightsResult[0]!.conversationId = "elsewhere";
    expect((await server.app.request(path)).status).toBe(404);
  });

  test("Chat approval decisions require the exact fresh tuple and acknowledge only submission", async () => {
    seedChatChannel();
    const nodeId = (stubs.scoutBrokerContextResult as any).node.id;
    stubs.queryFlightsResult = [{ id: "decision-flight", conversationId: CHANNEL_ID, state: "waiting", agentId: "agent-kepler", sessions: [{ sessionId: "session", nodeId, startedAt: 100, lastAcknowledgedAt: 101 }] }];
    const approval = { sessionId: "session", turnId: "turn", blockId: "block", version: 2, turnStartedAt: 110, actionStatus: "awaiting_approval" };
    stubs.pairingStateResult = makePairingState({ isRunning: true, pendingApprovals: [approval] });
    const server = await makeServer();
    const decide = (change: Record<string, unknown>) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks/decision-flight/approvals/decide`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "session", turnId: "turn", blockId: "block", version: 2, decision: "approve", ...change }),
    });
    expect((await decide({ version: 1 })).status).toBe(409);
    expect((await decide({ sessionId: "other" })).status).toBe(409);
    expect((await decide({ actorId: "operator" })).status).toBe(400);
    expect((await decide({ decision: "yes" })).status).toBe(400);
    expect(decidePairingApprovalCalls).toHaveLength(0);
    const response = await decide({ decision: "deny", reason: "Needs review" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "submitted", decision: "deny" });
    expect(decidePairingApprovalCalls).toEqual([{ sessionId: "session", turnId: "turn", blockId: "block", version: 2, decision: "deny", reason: "Needs review" }]);
    stubs.decidePairingApprovalFailure = true;
    expect((await decide({})).status).toBe(502);
    stubs.pairingStateResult = makePairingState({ isRunning: false });
    expect((await decide({})).status).toBe(503);
    stubs.pairingStateResult = makePairingState({ isRunning: true, pendingApprovals: [] });
    expect((await decide({})).status).toBe(409);
    stubs.queryFlightsResult[0]!.conversationId = "other-channel";
    expect((await decide({})).status).toBe(404);
    expect(decidePairingApprovalCalls).toHaveLength(2);
  });

  test("full outcomes remain readable after flight retention and are served as inert text", async () => {
    seedChatChannel();
    stubs.queryFlightsResult = [{ id: "retained-outcome", conversationId: CHANNEL_ID, state: "completed", agentId: "agent-kepler" }];
    stubs.queryFlightRecordByIdResult = { id: "retained-outcome", output: "<script>alert('raw')</script>\n" + "complete ".repeat(900) };
    const server = await makeServer();
    const response = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks/retained-outcome/output`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(stubs.queryFlightRecordByIdResult.output as string);
    stubs.queryFlightRecordByIdResult = null;
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks/retained-outcome/output`)).status).toBe(404);
  });

  test("chat burst limits reject posts and asks before broker dispatch", async () => {
    seedChatChannel();
    stubs.sendScoutMessageResult = { usedBroker: true, messageId: "limited", invokedTargets: [], unresolvedTargets: [] };
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const server = await makeServer();
      const post = (index: number, ask = false) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/${ask ? "asks" : "messages"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: `burst-${index}`, body: "Keep this draft", ...(ask ? { targetActorId: "agent-kepler" } : {}) }),
      });
      for (let index = 0; index < 20; index++) expect((await post(index)).status).toBe(200);
      for (const ask of [false, true]) {
        const rejected = await post(21, ask);
        expect(rejected.status).toBe(429);
        expect(rejected.headers.get("retry-after")).toBe("1");
        expect((await rejected.json() as any).error).toContain("sending too quickly");
      }
      expect(sendScoutConversationMessageCalls).toHaveLength(20);
      expect(sendScoutConversationSteerCalls).toHaveLength(0);
    } finally { Date.now = realNow; }
  });

  test("chat posts validate explicit mention recipients without routing agents", async () => {
    seedChatChannel();
    stubs.sendScoutMessageResult = { usedBroker: true, messageId: "mentioned", invokedTargets: [], unresolvedTargets: [] };
    const server = await makeServer();
    const post = (mentionActorIds: unknown) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "mention-1", body: "Review this", mentionActorIds }),
    });
    expect((await post(["not-in-channel"])).status).toBe(409);
    expect((await post("agent-kepler")).status).toBe(400);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    const response = await post(["agent-kepler", "agent-kepler"]);
    expect(response.status).toBe(200);
    expect(sendScoutConversationMessageCalls.at(-1)).toMatchObject({ attentionMentions: [{ actorId: "agent-kepler", label: "Kepler" }], notifyParticipantAgents: false, resolveMentionsFromBody: false });
    expect((await response.json() as any).message.mentions).toEqual([{ actorId: "agent-kepler", label: "Kepler" }]);
  });

  test("chat feed retains canonical mentions without resolving body text", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    (stubs.scoutBrokerContextResult as any).snapshot.messages["m-root"].mentions = [{ actorId: "operator", label: "Operator" }];
    const server = await makeServer();
    const response = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/feed`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.messages.find((message: any) => message.id === "m-root").mentions).toEqual([{ actorId: "operator", label: "Operator" }]);
  });

  test("chat read state is scoped to the authenticated viewer and separates threads", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    chatReadCursors[CHANNEL_ID] = [{ actorId: "other-person", lastReadMessageId: "m-root" }];
    const server = await makeServer();
    const response = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/read-state`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.actorId).toBe("operator");
    expect(body.lanes.find((lane: any) => lane.rootMessageId === null).lastReadMessageId).toBeNull();
    expect(body.lanes.find((lane: any) => lane.rootMessageId === "m-root").latestMessageId).toBe("m-reply");
  });

  test("search scopes root and reply history to the authenticated channel", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    const server = await makeServer();
    const response = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/search?q=on%20it`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.messages.some((message: any) => message.id === "m-reply")).toBe(true);
    expect(body.messages.some((message: any) => message.id === "m-other")).toBe(false);
    const lastQuery = queryRecentMessagesCalls.at(-1)!;
    expect(lastQuery.search).toBe("on it");
    expect(lastQuery.conversationIds).toContain(CHANNEL_ID);
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/search?q=`)).status).toBe(400);
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/search?q=on%20it&cursor=not-a-position`)).status).toBe(400);
  });

  test("pages durable thread context with a stable reply boundary", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    const snapshot = (stubs.scoutBrokerContextResult as any).snapshot;
    delete snapshot.messages["m-reply"];
    for (let i = 0; i < 115; i++) {
      snapshot.messages[`paged-${i}`] = { id: `paged-${i}`, conversationId: THREAD_ID, actorId: "agent-kepler", originNodeId: "node-1", class: "agent", body: `Reply ${i}`, visibility: "workspace", policy: "durable", createdAt: NOW + i };
    }
    const server = await makeServer();
    const path = `http://localhost/api/channels/${CHANNEL_ID}/messages/paged-0/context`;
    const first = await (await server.app.request(path)).json() as any;
    expect(first.messages).toHaveLength(102);
    expect(first.nextCursor).toBeTypeOf("string");
    const next = await (await server.app.request(`${path}?cursor=${encodeURIComponent(first.nextCursor)}`)).json() as any;
    expect(next.messages).toHaveLength(16);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.messages, ...next.messages].map((message: any) => message.id)).size).toBe(116);
    expect((await server.app.request(`${path}?cursor=not-a-position`)).status).toBe(400);
  });

  test("message context includes old durable roots and rejects unrelated messages", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [{ id: "old-root", conversationId: CHANNEL_ID, actorId: "operator", body: "From durable history", createdAt: 1, class: "operator" }];
    const server = await makeServer();
    const get = (id: string) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/messages/${id}/context`);
    const old = await get("old-root");
    expect(old.status).toBe(200);
    expect((await old.json() as any).messages[0].body).toBe("From durable history");
    const reply = await get("m-reply");
    expect(reply.status).toBe(200);
    expect((await reply.json() as any).rootMessageId).toBe("m-root");
    expect((await get("m-other")).status).toBe(404);
    expect((await get("missing")).status).toBe(404);
  });

  test("chat corrections derive author and moderation authority from the credential", async () => {
    seedChatChannel();
    const server = await makeServer();
    const post = (body: unknown) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/corrections`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const change = { expectedRevision: 0, body: "Corrected" };
    expect((await post({ messageId: "m-root", change })).status).toBe(200);
    expect(chatMarkReadCalls[0]).toEqual({ kind: "correction", conversationId: CHANNEL_ID, messageId: "m-root", actorId: "operator", canModerate: true, change });
    expect((await post({ messageId: "m-root", change, canModerate: true })).status).toBe(400);
    expect((await post({ messageId: "m-root", change: { ...change, actorId: "other" } })).status).toBe(400);
  });

  test("chat shared pins derive attribution and validate root and reply channel membership", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    const server = await makeServer();
    const post = (body: unknown) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/pins`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post({ messageId: "m-root", pinned: true })).status).toBe(200);
    expect((await post({ messageId: "m-reply", pinned: true })).status).toBe(200);
    expect((await post({ messageId: "m-other", pinned: true })).status).toBe(400);
    expect((await post({ messageId: "missing", pinned: true })).status).toBe(400);
    expect((await post({ messageId: "m-root", pinned: true, pinnedBy: "other" })).status).toBe(400);
    expect((await post({ messageId: "expired", pinned: false })).status).toBe(200);
    expect(chatMarkReadCalls).toHaveLength(3);
    expect(chatMarkReadCalls[0]).toEqual({ kind: "pins", conversationId: CHANNEL_ID, actorId: "operator", change: { messageId: "m-root", pinned: true } });
  });

  test("chat attention changes use authenticated identity and validate channel roots", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    const server = await makeServer();
    const post = (body: unknown) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/attention`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post({ notificationMode: "muted" })).status).toBe(200);
    expect((await post({ threadId: "m-root", following: true })).status).toBe(200);
    expect(chatMarkReadCalls).toEqual([
      { kind: "preferences", conversationId: CHANNEL_ID, actorId: "operator", change: { notificationMode: "muted" } },
      { kind: "preferences", conversationId: CHANNEL_ID, actorId: "operator", change: { threadId: "m-root", following: true } },
    ]);
    expect((await post({ notificationMode: "all", actorId: "another-person" })).status).toBe(400);
    expect((await post({ threadId: "m-other", following: true })).status).toBe(400);
    expect((await post({ threadId: "m-reply", following: true })).status).toBe(400);
    expect(chatMarkReadCalls).toHaveLength(2);
    expect((await post({ threadId: "expired-root", following: false })).status).toBe(200);
    expect((await post({ messageId: "m-root", saved: true })).status).toBe(200);
    expect((await post({ messageId: "m-reply", saved: true })).status).toBe(200);
    expect((await post({ messageId: "m-other", saved: true })).status).toBe(400);
    expect((await post({ messageId: "missing", saved: true })).status).toBe(400);
    expect((await post({ messageId: "expired-message", saved: false })).status).toBe(200);
    expect(chatMarkReadCalls.at(-1)).toEqual({ kind: "preferences", conversationId: CHANNEL_ID, actorId: "operator", change: { messageId: "expired-message", saved: false } });
  });

  test("chat read writes ignore forged actors and require a message in the selected lane", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    const server = await makeServer();
    const post = (body: unknown) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/read-state`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post({ messageId: "m-root", actorId: "somebody-else", lastReadAt: 9999999999999 })).status).toBe(200);
    expect(chatMarkReadCalls).toEqual([{ conversationId: CHANNEL_ID, actorId: "operator", lastReadMessageId: "m-root", metadata: { source: "scout-chat" } }]);
    expect((await post({ messageId: "m-reply" })).status).toBe(400);
    expect((await post({ messageId: "m-other" })).status).toBe(400);
    expect((await post({ messageId: "m-reply", rootMessageId: "unrelated-root" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(chatMarkReadCalls).toHaveLength(1);
    expect((await post({ messageId: "m-reply", rootMessageId: "m-root" })).status).toBe(200);
    expect(chatMarkReadCalls).toHaveLength(2);
  });

  test("the feed folds thread replies onto the message they answer", async () => {
    seedChatChannel();
    stubs.queryRecentMessagesResult = [];
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/feed`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    // One tracked request, from the flight in this channel. The flight in
    // another conversation is not this room's business.
    expect(body.requests).toEqual([
      { messageId: "m-root", flightId: "flt-1", state: "running", targetActorId: "agent-kepler", targetName: "Kepler", requesterActorId: "person-art", requesterName: "Art" },
    ]);

    // The reply lives in a thread conversation underneath the channel. The feed
    // hands the client one flat list anchored by `replyToMessageId`, so it never
    // has to know that threads are separate conversations.
    const byId = new Map(body.messages.map((message: { id: string }) => [message.id, message]));
    expect(byId.get("m-root")?.replyToMessageId).toBeNull();
    expect(byId.get("m-reply")?.replyToMessageId).toBe("m-root");
    // Every message reports the root channel, whichever conversation holds it.
    expect(body.messages.every((message: { channelId: string }) => message.channelId === CHANNEL_ID))
      .toBe(true);
  });

  test("feed merges the broker window with durable history", async () => {
    seedChatChannel();
    const snapshot = (stubs.scoutBrokerContextResult as {
      snapshot: {
        messages: Record<string, unknown>;
        conversations: Record<string, unknown>;
      };
    }).snapshot;
    // The durable-read stub answers every conversationId with the same rows,
    // so the thread stays out of this fixture -- its read would fold the same
    // rows into the feed a second time as replies.
    delete snapshot.conversations[THREAD_ID];
    // The broker window holds only the newest rows. A1 has already rolled out
    // of it and lives only in SQLite, where the overlapping B2 is a stale copy.
    snapshot.messages = {
      "m-b2": {
        id: "m-b2", conversationId: CHANNEL_ID, actorId: "person-art",
        originNodeId: "node-1", class: "agent", body: "fresh",
        visibility: "workspace", policy: "durable", createdAt: NOW - 200,
      },
      "m-b3": {
        id: "m-b3", conversationId: CHANNEL_ID, actorId: "agent-kepler",
        originNodeId: "node-1", class: "agent", body: "newest",
        visibility: "workspace", policy: "durable", createdAt: NOW - 100,
      },
    };
    // The durable projection pages newest-first.
    stubs.queryRecentMessagesResult = [
      {
        id: "m-b2", conversationId: CHANNEL_ID, actorId: "person-art", actorName: "Art",
        body: "stale", createdAt: NOW - 200, class: "agent", metadata: null,
        replyToMessageId: null, threadConversationId: null,
      },
      {
        id: "m-a1", conversationId: CHANNEL_ID, actorId: "person-art", actorName: "Art",
        body: "oldest", createdAt: NOW - 300, class: "agent", metadata: null,
        replyToMessageId: null, threadConversationId: null,
      },
    ];
    const server = await makeServer();
    const feed = async (limit: number) => {
      const response = await server.app.request(
        `http://localhost/api/channels/${CHANNEL_ID}/feed?limit=${limit}`,
      );
      expect(response.status).toBe(200);
      return await response.json() as { messages: Array<{ id: string; body: string }> };
    };

    // A1 returns from SQLite, the shared m-b2 resolves to the broker's fresher
    // copy, and m-b3 was never in SQLite at all.
    const merged = await feed(50);
    expect(merged.messages.map((message) => message.id)).toEqual(["m-a1", "m-b2", "m-b3"]);
    expect(merged.messages[1].body).toBe("fresh");

    // The newest `limit` rows of the merge survive, not just a source's page.
    const truncated = await feed(2);
    expect(truncated.messages.map((message) => message.id)).toEqual(["m-b2", "m-b3"]);

    // A broker that cannot answer the transcript read leaves the durable rows
    // untouched.
    stubs.conversationsScopeBrokerContextResult = null;
    const fallback = await feed(50);
    expect(fallback.messages.map((message) => message.id)).toEqual(["m-a1", "m-b2"]);
    expect(fallback.messages[1].body).toBe("stale");
  });

  test("a plain post reaches the room without asking anyone for work", async () => {
    seedChatChannel();
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: CHANNEL_ID,
      messageId: "m-posted",
      invokedTargets: [],
      unresolvedTargets: [],
    };
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-1", body: "@kepler said the tag is cut" }),
      },
    );
    expect(response.status).toBe(200);
    const call = sendScoutConversationMessageCalls.at(-1)!;
    expect(call.notifyParticipantAgents).toBe(false);
    // The body is payload. Quoting a name must not notify or wake that agent,
    // which is the whole difference between a room and a dispatcher.
    expect(call.resolveMentionsFromBody).toBe(false);
    expect(call.clientMessageId).toBe("req-1");
  });

  test("reactions add and remove through the broker and GET is 405", async () => {
    seedChatChannel();
    const server = await makeServer();

    const denied = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/reactions`,
    );
    expect(denied.status).toBe(405);

    const invalid = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/reactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "m-root", emoji: "not-an-emoji", requestId: "r1" }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ reason: "invalid_emoji" });

    const claimed = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/reactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "m-root", emoji: "👍", actorId: "spoof" }),
      },
    );
    expect(claimed.status).toBe(400);
    expect(await claimed.json()).toMatchObject({ reason: "identity_not_accepted" });

    const added = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/reactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "m-root", emoji: "👍", requestId: "r1" }),
      },
    );
    expect(added.status).toBe(200);
    expect(sendScoutMessageReactionCalls.at(-1)).toMatchObject({
      channelId: CHANNEL_ID,
      messageId: "m-root",
      emoji: "👍",
    });
    expect(sendScoutMessageReactionCalls.at(-1)?.remove).toBeUndefined();

    const removed = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/reactions/remove`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "m-root", emoji: "👍", requestId: "r2" }),
      },
    );
    expect(removed.status).toBe(200);
    expect(sendScoutMessageReactionCalls.at(-1)?.remove).toBe(true);
  });

  test("an ask routes to the redeemed session and to nobody else", async () => {
    seedChatChannel();
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: CHANNEL_ID,
      messageId: "m-asked",
      flights: [{ id: "flt-new", invocationId: "inv-new", state: "queued" }],
      invokedTargets: ["agent-kepler"],
      unresolvedTargets: [],
    };
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/asks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attachments: [{ id: "ask-file", mediaType: "text/markdown", fileName: "review.md", url: "https://example.com/review.md" }],
          requestId: "req-2",
          body: "cut the tag, and cc @vega when it lands",
          targetActorId: "agent-kepler",
          mentionActorIds: ["agent-vega", "person-art"],
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;

    const call = sendScoutConversationSteerCalls.at(-1)!;
    expect(call.attachments).toEqual([expect.objectContaining({ id: "ask-file", fileName: "review.md" })]);
    expect(body.message.attachments).toEqual(call.attachments);
    expect(call.targetParticipantIds).toEqual(["agent-kepler"]);
    expect(call.attentionMentions).toEqual([{ actorId: "agent-vega", label: "Vega" }, { actorId: "person-art", label: "Art" }]);
    expect(body.message.mentions.map((mention: any) => mention.actorId)).toEqual(["agent-kepler", "agent-vega", "person-art"]);
    // The session comes from the redemption, not from the request and not from
    // a fresh launch.
    expect(call.execution).toEqual({ session: "existing", targetSessionId: "sess.kepler" });
    // "@vega" in the text is prose. One selected actor is the whole address.
    expect(call.resolveMentionsFromBody).toBe(false);

    expect(body.request.flightId).toBe("flt-new");
    expect(body.request.targetActorId).toBe("agent-kepler");
    // Readiness, never a receipt.
    expect(body.request.note).toContain("Queued");
    expect(body.request.note).not.toContain("Delivered");
    expect(body.request.reception.state).toBe("ready_to_receive");
  });

  test("combined asks reject malformed and departed mention recipients before dispatch", async () => {
    seedChatChannel();
    const server = await makeServer();
    const send = (mentionActorIds: unknown) => server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Review", targetActorId: "agent-kepler", mentionActorIds }),
    });
    expect((await send("agent-vega")).status).toBe(400);
    expect((await send(["departed-person"])).status).toBe(409);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
  });

  test("asking an agent that never redeemed is refused, not quietly queued", async () => {
    seedChatChannel();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/asks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-3", body: "ping", targetActorId: "agent-vega" }),
      },
    );
    // Vega is in the room but nothing attaches a session to it here. Creating a
    // request anyway would show a pending row that can never be delivered.
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, any>;
    expect(body.reason).toBe("no_attached_session");
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
  });

  test("an ask for an agent outside the channel never reaches it", async () => {
    seedChatChannel();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/asks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-4", body: "ping", targetActorId: "agent-outsider" }),
      },
    );
    expect(response.status).toBe(409);
    expect((await response.json() as Record<string, any>).reason).toBe("not_a_member");
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
  });

  test("the reserved chat name opens chat, and only at its root", async () => {
    seedChatChannel();
    const server = await makeServer();

    // `chat.scout.local` is advertised as this node's chat entry point, so its
    // root has to land on chat rather than on the operator shell.
    const root = await server.app.request("http://localhost/", {
      headers: { host: "chat.scout.local" },
    });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/chat");

    // Only the root. An invitation link issued under that name must keep
    // working on it.
    const invite = await server.app.request("http://localhost/api/chat/bootstrap", {
      headers: { host: "chat.scout.local" },
    });
    expect(invite.status).toBe(200);

    // And no other host is redirected.
    const shell = await server.app.request("http://localhost/", {
      headers: { host: "m1.scout.local" },
    });
    expect(shell.status).not.toBe(302);
  });

  test("creating a channel converges on one record for one name", async () => {
    seedChatChannel();
    const server = await makeServer();

    const response = await server.app.request("http://localhost/api/chat/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "design-review" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.conversation.kind).toBe("channel");
    expect(body.conversation.participantIds).toEqual(["operator"]);
    expect(body.existed).toBe(false);

    // A title with no name is not a channel.
    const empty = await server.app.request("http://localhost/api/chat/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("who the member cookie says you are", () => {
  const CHANNEL_ID = "chn-0123456789abcdef0123456789abcdef";
  const OPERATOR_TOKEN = "member-identity-operator-token";
  const MAYA = "person-maya-identity";
  const NOW = 1_800_000_000_000;

  const seedChannel = (participantIds: string[]) => {
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        messages: {},
        conversations: {
          [CHANNEL_ID]: {
            id: CHANNEL_ID,
            kind: "channel",
            title: "release-train",
            visibility: "workspace",
            shareMode: "shared",
            authorityNodeId: "node-1",
            participantIds,
            metadata: { channelInvites: [] },
          },
        },
        actors: {}, agents: {}, endpoints: {}, flights: {},
      },
    } as never;
  };

  const makeServer = async () => createOpenScoutWebServer({
    currentDirectory: "/tmp/openscout",
    assetMode: "static",
    staticRoot: makeStaticRoot(),
    advertisedHost: "m1.scout.local",
    portalHost: "scout.local",
    authToken: OPERATOR_TOKEN,
    resolvePeerAddress: () => "127.0.0.1",
  });

  /**
   * The cookie a member is really holding. Minting it outside the server is
   * the point: grants are signed rather than stored, so this is the same path
   * a teammate takes when their cookie outlives the process that issued it.
   */
  const memberCookie = () => {
    const { token } = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN })
      .mint({ actorId: MAYA, displayName: "Maya", channelId: CHANNEL_ID, nowMs: NOW });
    return { cookie: channelMemberCookie(token, false).split(";")[0]! };
  };

  test("members cannot read or decide host session approvals", async () => {
    seedChannel([MAYA]);
    const server = await makeServer();
    const base = `http://localhost/api/channels/${CHANNEL_ID}/asks/flight/approvals`;
    expect((await server.app.request(base, { headers: memberCookie() })).status).toBe(403);
    expect((await server.app.request(`${base}/decide`, { method: "POST", headers: { ...memberCookie(), "content-type": "application/json" }, body: JSON.stringify({ sessionId: "session", turnId: "turn", blockId: "block", version: 1, decision: "approve" }) })).status).toBe(401);
    expect(decidePairingApprovalCalls).toHaveLength(0);
    const execution = `http://localhost/api/channels/${CHANNEL_ID}/asks/flight/execution`;
    expect((await server.app.request(execution, { headers: memberCookie() })).status).toBe(403);
    expect((await server.app.request(execution, { method: "POST", headers: { ...memberCookie(), "content-type": "application/json" }, body: JSON.stringify({ sessionId: "session", turnId: "turn" }) })).status).toBe(401);
    expect(interruptPairingCalls).toHaveLength(0);
    const history = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/questions/history`, { headers: memberCookie() });
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({ questions: [], nextCursor: null });
    const presence = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/presence`, { method: "POST", headers: { ...memberCookie(), "content-type": "application/json" }, body: JSON.stringify({ clientId: "member-tab", sequence: 1, active: true, typing: false }) });
    expect(presence.status).toBe(200);
    expect((await presence.json() as any).people).toMatchObject([{ actorId: MAYA, name: "Maya", typing: [] }]);

  });

  test("a member is named along with the room they are actually in", async () => {
    seedChannel(["person-art", MAYA]);
    const server = await makeServer();

    const response = await server.app.request("http://localhost/api/member/me", {
      headers: memberCookie(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { member: Record<string, unknown> };
    expect(body.member.actorId).toBe(MAYA);
    expect(body.member.displayName).toBe("Maya");
    expect(body.member.channelIds).toEqual([CHANNEL_ID]);
  });

  test("a removed member keeps their identity and loses the room", async () => {
    // Removal lives only in the roster. The cookie is signed, unexpired, and
    // still names the channel -- echoing it back is what sent a removed
    // teammate to "Open room" and then straight back to the invitation page.
    seedChannel(["person-art"]);
    const server = await makeServer();

    const response = await server.app.request("http://localhost/api/member/me", {
      headers: memberCookie(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { member: Record<string, unknown> };
    expect(body.member.actorId).toBe(MAYA);
    expect(body.member.displayName).toBe("Maya");
    expect(body.member.channelIds).toEqual([]);
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/asks/any-flight/output`, {
      headers: memberCookie(),
    })).status).toBe(403);
  });

  test("being invited back restores the room on the same cookie", async () => {
    seedChannel(["person-art"]);
    const server = await makeServer();
    const held = memberCookie();

    expect(((await (await server.app.request("http://localhost/api/member/me", {
      headers: held,
    })).json()) as { member: { channelIds: string[] } }).member.channelIds).toEqual([]);

    seedChannel(["person-art", MAYA]);
    expect(((await (await server.app.request("http://localhost/api/member/me", {
      headers: held,
    })).json()) as { member: { channelIds: string[] } }).member.channelIds).toEqual([CHANNEL_ID]);
  });

  test("an unreadable roster says so instead of signing a member out", async () => {
    seedChannel(["person-art", MAYA]);
    const server = await makeServer();
    const held = memberCookie();
    stubs.scoutBrokerContextResult = null;

    // Reporting no channels here would be a claim of removal the server cannot
    // support. The surface already treats a failed identity read as simply not
    // recognising the visitor, which is the honest outcome.
    const response = await server.app.request("http://localhost/api/member/me", {
      headers: held,
    });
    expect(response.status).toBe(502);
  });

  test("without a credential there is nothing to answer", async () => {
    seedChannel(["person-art", MAYA]);
    const server = await makeServer();
    expect((await server.app.request("http://localhost/api/member/me")).status).toBe(401);
  });
});

describe("lightweight API participation over HTTP", () => {
  const CHANNEL_ID = "chn-0123456789abcdef0123456789abcdef";
  const OTHER_CHANNEL_ID = "chn-fedcba9876543210fedcba9876543210";
  const NOW = 1_800_000_000_000;
  const OPERATOR_TOKEN = "operator-token-for-api-participation";
  const TOKEN = "vx3k9dqm-no-install-invite";
  const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

  const brokerWrites: Array<{ url: string; body: any }> = [];

  const seedChannel = (inviteOverrides?: Record<string, unknown>) => {
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        messages: {
          "m-root": {
            id: "m-root", conversationId: CHANNEL_ID, actorId: "person-art",
            originNodeId: "node-1", class: "agent", body: "cut the tag?",
            visibility: "workspace", policy: "durable", createdAt: NOW - 400,
          },
          "m-second": {
            id: "m-second", conversationId: CHANNEL_ID, actorId: "person-art",
            originNodeId: "node-1", class: "agent", body: "any objections?",
            visibility: "workspace", policy: "durable", createdAt: NOW - 300,
          },
        },
        conversations: {
          [CHANNEL_ID]: {
            id: CHANNEL_ID,
            kind: "channel",
            title: "release-train",
            topic: "Coordination for the openscout release train.",
            visibility: "workspace",
            shareMode: "shared",
            authorityNodeId: "node-1",
            participantIds: ["person-art"],
            metadata: {
              channelInvites: [
                {
                  id: "cinv-1",
                  channelId: CHANNEL_ID,
                  scope: "channel_participation",
                  tokenHash: TOKEN_HASH,
                  tokenHint: "vx3k",
                  createdAt: NOW - 1000,
                  createdByActorId: "person-art",
                  expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
                  maxRedemptions: null,
                  route: {
                    authorityNodeId: "node-1",
                    host: "chat.scout.local",
                    baseUrl: "http://chat.scout.local",
                    reachability: "unknown",
                  },
                  redemptions: [],
                  ...(inviteOverrides ?? {}),
                },
              ],
            },
          },
          [OTHER_CHANNEL_ID]: {
            id: OTHER_CHANNEL_ID,
            kind: "channel",
            title: "private-room",
            visibility: "workspace",
            shareMode: "shared",
            authorityNodeId: "node-1",
            participantIds: ["person-art"],
          },
        },
        actors: {
          "person-art": { id: "person-art", kind: "person", displayName: "Art" },
        },
        agents: {},
        endpoints: {},
        flights: {},
        invocations: {},
      },
    };
  };

  /**
   * A broker that accepts the two writes this flow makes, and applies the one
   * consequence the rest of the flow depends on: a redeemed participant is on
   * the roster. Without that the next request is refused as a removed member,
   * which is exactly right and would hide whether the join worked at all.
   */
  const stubBroker = (options?: { alreadyRedeemed?: boolean }) => {
    brokerWrites.length = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      brokerWrites.push({ url, body });
      if (url.includes("/v1/actors")) {
        // The broker stores the actor, so the snapshot the next read sees has
        // it. Skipping this would leave the roster naming a participant with
        // no record, which is a different bug than the one under test.
        (stubs.scoutBrokerContextResult as any).snapshot.actors[body.id] = body;
        return Response.json({ ok: true });
      }
      if (url.includes("/v1/commands") && body?.kind === "channel.invite.redeem") {
        const actorId = body.request.actorId as string;
        const conversation = (stubs.scoutBrokerContextResult as any).snapshot
          .conversations[CHANNEL_ID];
        if (!conversation.participantIds.includes(actorId)) {
          conversation.participantIds.push(actorId);
        }
        const invite = conversation.metadata.channelInvites[0];
        const redemption = {
          id: "crdm-1",
          actorId,
          redeemedAt: NOW,
        };
        if (!options?.alreadyRedeemed) invite.redemptions.push(redemption);
        return Response.json({
          ok: true,
          invite: { ...invite, redemptionCount: invite.redemptions.length },
          redemption,
          alreadyRedeemed: Boolean(options?.alreadyRedeemed),
          participantIds: conversation.participantIds,
          conversationId: CHANNEL_ID,
        });
      }
      return Response.json({ ok: false, error: `unexpected broker call: ${url}` }, { status: 500 });
    }) as typeof fetch;
  };

  const makeServer = async () => createOpenScoutWebServer({
    currentDirectory: "/tmp/openscout",
    assetMode: "static",
    staticRoot: makeStaticRoot(),
    authToken: OPERATOR_TOKEN,
    advertisedHost: "m1.scout.local",
    portalHost: "scout.local",
    resolvePeerAddress: () => "127.0.0.1",
  });

  const participate = async (
    server: { app: { request: (url: string, init?: any) => Promise<Response> } },
    body: Record<string, unknown> = { participantKey: "key-1", displayName: "release-bot" },
  ) => server.app.request(`http://localhost/api/invites/${TOKEN}/participate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  test("an agent with nothing installed joins, posts, and polls", async () => {
    seedChannel();
    stubBroker();
    stubs.queryRecentMessagesResult = [];
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: CHANNEL_ID,
      messageId: "m-posted",
      invokedTargets: [],
      unresolvedTargets: [],
    };
    const server = await makeServer();

    // 1. Join. No identity is sent and none is assumed.
    const joined = await participate(server);
    expect(joined.status).toBe(200);
    const join = await joined.json() as Record<string, any>;
    expect(join.ok).toBe(true);
    expect(join.participation).toBe("api");
    expect(join.actorId.startsWith("apia-")).toBe(true);
    expect(join.conversationId).toBe(CHANNEL_ID);
    // The one thing this mode must never overstate.
    expect(join.attached).toBe(false);
    expect(join.credential.scheme).toBe("Bearer");
    expect(typeof join.credential.token).toBe("string");

    const auth = { authorization: `Bearer ${join.credential.token}` };

    // 2. Post. It reaches the room and invokes nobody.
    const posted = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-1", body: "reading the room" }),
      },
    );
    expect(posted.status).toBe(200);
    const postCall = sendScoutConversationMessageCalls.at(-1)!;
    // The sender is derived from the credential, never from the body.
    expect(postCall.senderId).toBe(join.actorId);
    expect(postCall.notifyParticipantAgents).toBe(false);
    expect(postCall.resolveMentionsFromBody).toBe(false);

    // 3. Poll. First call needs no cursor and answers with the retained window.
    const first = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll`,
      { headers: auth },
    );
    expect(first.status).toBe(200);
    const page = await first.json() as Record<string, any>;
    expect(page.messages.map((message: { id: string }) => message.id)).toEqual([
      "m-root",
      "m-second",
    ]);
    expect(page.hasMore).toBe(false);
    expect(typeof page.recommendedPollIntervalMs).toBe("number");

    // 4. Poll again from the cursor: nothing new, and the position holds.
    const second = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll?cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers: auth },
    );
    expect(second.status).toBe(200);
    const caughtUp = await second.json() as Record<string, any>;
    expect(caughtUp.messages).toEqual([]);
    expect(caughtUp.nextCursor).toBe(page.nextCursor);

    // 5. A message arrives; the next poll returns exactly it.
    (stubs.scoutBrokerContextResult as any).snapshot.messages["m-third"] = {
      id: "m-third", conversationId: CHANNEL_ID, actorId: "person-art",
      originNodeId: "node-1", class: "agent", body: "shipping now",
      visibility: "workspace", policy: "durable", createdAt: NOW - 100,
    };
    const third = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll?cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers: auth },
    );
    const delta = await third.json() as Record<string, any>;
    expect(delta.messages.map((message: { id: string }) => message.id)).toEqual(["m-third"]);
  });

  test("invited members cannot publish host file pointers through any spelling", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const joined = await (await participate(server)).json() as { credential: { token: string } };
    const callsBefore = sendScoutConversationMessageCalls.length;
    for (const attachment of [
      { localPath: "/tmp/openscout/private.txt" },
      { metadata: { localPath: "/tmp/openscout/private.txt" } },
      { blobKey: "local:/tmp/openscout/private.txt" },
      { blobKey: "  local:/tmp/openscout/private.txt  " },
    ]) {
      const response = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${joined.credential.token}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "file", attachments: [attachment] }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "local file attachments require operator authority" });
    }
    const rawUrl = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${joined.credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "file", attachments: [{ mediaType: "text/html", url: "/api/file/raw/tmp/private.html" }] }),
    });
    expect(rawUrl.status).toBe(403);
    expect(sendScoutConversationMessageCalls).toHaveLength(callsBefore);
  });

  test("a cursor the retained window no longer covers fails rather than skipping", async () => {
    seedChannel();
    stubBroker();
    stubs.queryRecentMessagesResult = [];
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;
    const auth = { authorization: `Bearer ${join.credential.token}` };

    const page = await (await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll`,
      { headers: auth },
    )).json() as Record<string, any>;

    // History rolls: everything the cursor named is gone from the window, and
    // only newer messages remain. Serving those would lose the middle.
    (stubs.scoutBrokerContextResult as any).snapshot.messages = {
      "m-later": {
        id: "m-later", conversationId: CHANNEL_ID, actorId: "person-art",
        originNodeId: "node-1", class: "agent", body: "much later",
        visibility: "workspace", policy: "durable", createdAt: NOW + 5_000,
      },
    };

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll?cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers: auth },
    );
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, any>;
    expect(body.reason).toBe("stale");
    // And it says what to do instead of implying a retry will work.
    expect(body.error).toContain("feed");
  });

  test("a malformed cursor is named, never answered with an empty page", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll?cursor=1783915198766%7Cmsg-1`,
      { headers: { authorization: `Bearer ${join.credential.token}` } },
    );
    // A chat-history cursor is a different grammar, and reading it as
    // end-of-history is how a poller silently stops seeing the room.
    expect(response.status).toBe(400);
    expect((await response.json() as Record<string, any>).reason).toBe("malformed");
  });

  test("the join refuses to be told who is joining", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();

    const response = await participate(server, { actorId: "person-art" });
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, any>;
    expect(body.reason).toBe("identity_not_accepted");
    // Nothing was written: an impersonation attempt must not leave a redemption.
    expect(brokerWrites).toEqual([]);
  });

  test("a session id is refused rather than quietly attached", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();

    const response = await participate(server, { sessionId: "sess.kepler" });
    expect(response.status).toBe(400);
    expect((await response.json() as Record<string, any>).reason)
      .toBe("identity_not_accepted");
    expect(brokerWrites).toEqual([]);
  });

  test("the same key replayed resumes the same participant", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();

    const first = await participate(server);
    const firstBody = await first.json() as Record<string, any>;

    // The broker recognises the actor and reports the original redemption
    // rather than consuming a second use.
    stubBroker({ alreadyRedeemed: true });
    const again = await participate(server);
    const againBody = await again.json() as Record<string, any>;

    expect(againBody.actorId).toBe(firstBody.actorId);
    expect(againBody.alreadyMember).toBe(true);
  });

  test("a different key is a different participant", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();

    const first = await participate(server, { participantKey: "key-1" });
    const second = await participate(server, { participantKey: "key-2" });
    expect((await first.json() as Record<string, any>).actorId)
      .not.toBe((await second.json() as Record<string, any>).actorId);
  });

  test("a revoked invitation refuses participation and says it is gone", async () => {
    seedChannel({ revokedAt: NOW - 100, revokedByActorId: "person-art" });
    stubBroker();
    const server = await makeServer();

    const response = await participate(server);
    expect(response.status).toBe(410);
    // Refused before any write, so no participant identity is left behind.
    expect(brokerWrites).toEqual([]);
  });

  test("an expired invitation refuses participation", async () => {
    seedChannel({ expiresAt: Date.now() - 1000 });
    stubBroker();
    const server = await makeServer();

    expect((await participate(server)).status).toBe(410);
    expect(brokerWrites).toEqual([]);
  });

  test("a single-use invitation is spent, not reusable by a second participant", async () => {
    seedChannel({
      maxRedemptions: 1,
      redemptions: [{ id: "crdm-0", actorId: "apia-someone-else", redeemedAt: NOW - 50 }],
    });
    stubBroker();
    const server = await makeServer();

    const response = await participate(server, { participantKey: "a-new-key" });
    expect(response.status).toBe(410);
    expect((await response.json() as Record<string, any>).reason).toBe("exhausted");
    expect(brokerWrites).toEqual([]);
  });

  test("the credential opens the channel it joined and nothing else", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;
    const auth = { authorization: `Bearer ${join.credential.token}` };

    expect((await server.app.request(
      `http://localhost/api/channels/${OTHER_CHANNEL_ID}/poll`,
      { headers: auth },
    )).status).toBe(401);
    // Nor does it reach the operator's control plane.
    expect((await server.app.request("http://localhost/api/agents", { headers: auth })).status)
      .toBe(401);
  });

  test("a cursor from another channel is refused rather than answered", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;
    const auth = { authorization: `Bearer ${join.credential.token}` };

    const foreign = encodeChannelPollCursor({
      channelId: OTHER_CHANNEL_ID,
      createdAt: NOW - 400,
      id: "m-root",
    });
    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll?cursor=${encodeURIComponent(foreign)}`,
      { headers: auth },
    );
    expect(response.status).toBe(400);
    expect((await response.json() as Record<string, any>).reason).toBe("wrong_channel");
  });

  test("addressing an API participant refuses instead of launching anything", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;

    sendScoutConversationSteerCalls.length = 0;
    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/asks`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "req-ask",
          body: "can you cut the tag?",
          targetActorId: join.actorId,
        }),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, any>;
    expect(body.reason).toBe("api_participant");
    // The guarantee this test exists for: nothing was dispatched, and no fresh
    // session was started to receive it.
    expect(sendScoutConversationSteerCalls).toEqual([]);
  });

  test("a member credential cannot remove another member and loses access after removal", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const join = await (await participate(server)).json() as any;
    const auth = { authorization: `Bearer ${join.credential.token}` };
    const attempt = await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/members/revoke`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actorId: "person-art" }),
    });
    expect([401, 403]).toContain(attempt.status);
    const channel = (stubs.scoutBrokerContextResult as any).snapshot.conversations[CHANNEL_ID];
    channel.participantIds = channel.participantIds.filter((id: string) => id !== join.actorId);
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/members`, { headers: auth })).status).toBe(403);
    expect((await server.app.request(`http://localhost/api/channels/${CHANNEL_ID}/poll`, { headers: auth })).status).toBe(403);
  });

  test("the roster declares which members participate over the API", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;

    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/members`,
      { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } },
    );
    const body = await response.json() as { members: Array<Record<string, any>> };
    const participant = body.members.find((member) => member.actorId === join.actorId);
    expect(participant?.participation).toBe("api");
    // Membership is not reception, and a polling member is not listening.
    expect(participant?.reception.listening).toBe(false);
  });

  test("the no-install document is self-sufficient and carries no digest", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();

    const response = await server.app.request(`http://localhost/invite/${TOKEN}/api.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const markdown = await response.text();
    expect(markdown).toContain(CHANNEL_ID);
    expect(markdown).toContain("/participate");
    expect(markdown).toContain("/poll");
    expect(markdown).not.toContain(TOKEN_HASH);
    // The session-bound document points here for a reader with no session.
    const agentDoc = await (await server.app.request(
      `http://localhost/invite/${TOKEN}/agent.md`,
    )).text();
    expect(agentDoc).toContain("api.md");
  });
  test("a cursor older than a truncated read fails rather than skipping the middle", async () => {
    seedChannel();
    stubBroker();
    stubs.queryRecentMessagesResult = [];
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;
    const auth = { authorization: `Bearer ${join.credential.token}` };

    // Each conversation is read as its own newest slice. Here the root
    // transcript is longer than one read, and a thread under it carries a
    // message older than everything that read can still reach -- so the merged
    // array's oldest row is the thread's, several hundred root messages *after*
    // the root read stopped. That is a hole in the middle, not a suffix, and a
    // cursor pointing into it must be refused rather than paged across.
    const snapshot = (stubs.scoutBrokerContextResult as any).snapshot;
    const THREAD_ID = "chn-aaaabbbbccccddddeeeeffff00001111";
    snapshot.conversations[THREAD_ID] = {
      id: THREAD_ID,
      kind: "thread",
      parentConversationId: CHANNEL_ID,
      title: "cut the tag?",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: "node-1",
      participantIds: ["person-art"],
      messageId: "m-root-000",
    };
    snapshot.messages = {
      "m-thread-old": {
        id: "m-thread-old", conversationId: THREAD_ID, actorId: "person-art",
        originNodeId: "node-1", class: "agent", body: "older than the root read",
        visibility: "workspace", policy: "durable", createdAt: NOW - 200_000,
      },
    };
    for (let index = 0; index < 420; index += 1) {
      const id = `m-root-${String(index).padStart(3, "0")}`;
      snapshot.messages[id] = {
        id, conversationId: CHANNEL_ID, actorId: "person-art",
        originNodeId: "node-1", class: "agent", body: `root ${index}`,
        visibility: "workspace", policy: "durable", createdAt: NOW - 100_000 + index,
      };
    }

    // A position among the root messages the read left behind.
    const cursor = encodeChannelPollCursor({
      channelId: CHANNEL_ID,
      createdAt: NOW - 100_000 + 5,
      id: "m-root-005",
    });
    const response = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll?cursor=${encodeURIComponent(cursor)}`,
      { headers: auth },
    );
    expect(response.status).toBe(409);
    expect((await response.json() as Record<string, any>).reason).toBe("stale");
  });

  test("a participant reads a human reply and answers it", async () => {
    seedChannel();
    stubBroker();
    stubs.queryRecentMessagesResult = [];
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: CHANNEL_ID,
      messageId: "m-participant-hello",
      invokedTargets: [],
      unresolvedTargets: [],
    };
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;
    const auth = { authorization: `Bearer ${join.credential.token}` };

    // Drain to the present, the way a joining participant does.
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const response = await server.app.request(
        `http://localhost/api/channels/${CHANNEL_ID}/poll${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: auth },
      );
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }

    // Say hello.
    expect((await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-hello", body: "hello from an HTTP client" }),
      },
    )).status).toBe(200);

    // A person answers in the room.
    (stubs.scoutBrokerContextResult as any).snapshot.messages["m-human-reply"] = {
      id: "m-human-reply", conversationId: CHANNEL_ID, actorId: "person-art",
      originNodeId: "node-1", class: "agent", body: "welcome -- can you see this?",
      visibility: "workspace", policy: "durable", createdAt: NOW - 50,
      replyToMessageId: "m-participant-hello",
    };

    // The next poll carries exactly that reply, attributed to the person.
    const next = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/poll?cursor=${encodeURIComponent(cursor!)}`,
      { headers: auth },
    );
    const page = await next.json() as Record<string, any>;
    const reply = page.messages.find((message: { id: string }) => message.id === "m-human-reply");
    expect(reply).toBeTruthy();
    expect(reply.actorId).toBe("person-art");

    // And the participant answers under it.
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: CHANNEL_ID,
      messageId: "m-participant-answer",
      invokedTargets: [],
      unresolvedTargets: [],
    };
    const answered = await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "req-answer",
          body: "I can. Polling every two seconds.",
          replyToMessageId: "m-human-reply",
        }),
      },
    );
    expect(answered.status).toBe(200);
    const answerCall = sendScoutConversationMessageCalls.at(-1)!;
    expect(answerCall.senderId).toBe(join.actorId);
    expect(answerCall.replyToMessageId).toBe("m-human-reply");
    // Answering is a post. Nothing was invoked by it.
    expect(sendScoutConversationSteerCalls).toEqual([]);
  });
  test("an expired invitation still renews an existing participant's credential", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();

    const first = await (await participate(server)).json() as Record<string, any>;

    // The invitation lapses. A credential expires long before the room does, so
    // the participant must be able to come back for a fresh one -- and the
    // redemption they already hold is what says they may. A *new* joiner is
    // still refused (covered above); revocation is the switch that stops both.
    const invite = (stubs.scoutBrokerContextResult as any).snapshot
      .conversations[CHANNEL_ID].metadata.channelInvites[0];
    invite.expiresAt = Date.now() - 1000;
    stubBroker({ alreadyRedeemed: true });
    (stubs.scoutBrokerContextResult as any).snapshot.conversations[CHANNEL_ID]
      .metadata.channelInvites[0] = invite;

    const again = await participate(server);
    expect(again.status).toBe(200);
    const renewed = await again.json() as Record<string, any>;
    expect(renewed.actorId).toBe(first.actorId);
    expect(renewed.alreadyMember).toBe(true);
    expect(typeof renewed.credential.token).toBe("string");
  });
  test("the credential cannot mint invitations or dispatch work", async () => {
    seedChannel();
    stubBroker();
    const server = await makeServer();
    const join = await (await participate(server)).json() as Record<string, any>;
    const auth = { authorization: `Bearer ${join.credential.token}` };

    // The sharp one. A joiner able to issue further invitations would defeat
    // the `maxRedemptions` of the invitation that admitted it.
    expect((await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/invites`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ scope: "channel_participation" }),
      },
    )).status).toBe(401);

    // And addressing an agent dispatches tracked work to somebody else's
    // session, which the no-install document does not promise either.
    sendScoutConversationSteerCalls.length = 0;
    expect((await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/asks`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "req-ask-out",
          body: "cut the tag",
          targetActorId: "person-art",
        }),
      },
    )).status).toBe(401);
    expect(sendScoutConversationSteerCalls).toEqual([]);

    // Posting, which is what it *was* granted, still works.
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: CHANNEL_ID,
      messageId: "m-still-posts",
      invokedTargets: [],
      unresolvedTargets: [],
    };
    expect((await server.app.request(
      `http://localhost/api/channels/${CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-post", body: "still here" }),
      },
    )).status).toBe(200);
  });
});

describe("chat spaces scope what a request can reach", () => {
  const OPERATOR_TOKEN = "chat-spaces-operator-token";
  const NOW = 1_800_000_000_000;
  const TOKEN = "vx3k9dqm-personal-invite";
  const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
  const MAYA = "person-maya-spaces";

  // Ids are derived exactly as the server derives them, so a drift in the
  // natural-key grammar fails here rather than silently splitting a room.
  const LEGACY_CHANNEL = stableChannelId(namedChannelNaturalKey("release-train"));
  const WORK_GENERAL = stableChannelId(spacedChannelNaturalKey("work", "general"));
  const PERSONAL_GENERAL = stableChannelId(spacedChannelNaturalKey("personal", "general"));

  const spacedChannel = (space: string, name: string, extra: Record<string, unknown> = {}) => {
    const naturalKey = spacedChannelNaturalKey(space, name);
    return {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: name,
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: "node-1",
      participantIds: ["operator", MAYA],
      metadata: {
        [CHANNEL_NATURAL_KEY_METADATA]: naturalKey,
        [CHANNEL_SPACE_SLUG_METADATA]: space,
        channelInvites: [],
        ...extra,
      },
    };
  };

  const spaceRecord = (slug: string, title: string) => {
    const naturalKey = spaceNaturalKey(slug);
    return {
      id: stableChannelId(naturalKey),
      kind: "system",
      title,
      visibility: "system",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator"],
      metadata: {
        [CHANNEL_NATURAL_KEY_METADATA]: naturalKey,
        [CHANNEL_SPACE_SLUG_METADATA]: slug,
        surface: "chat-space",
      },
    };
  };

  const seedSpaces = () => {
    const legacyKey = namedChannelNaturalKey("release-train");
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        messages: {},
        conversations: {
          // A channel from before spaces existed: no marker, legacy key, and
          // the id it has always had.
          [LEGACY_CHANNEL]: {
            id: LEGACY_CHANNEL,
            kind: "channel",
            title: "release-train",
            visibility: "workspace",
            shareMode: "shared",
            authorityNodeId: "node-1",
            participantIds: ["operator", MAYA],
            metadata: {
              [CHANNEL_NATURAL_KEY_METADATA]: legacyKey,
              channelInvites: [],
            },
          },
          [WORK_GENERAL]: spacedChannel("work", "general"),
          [PERSONAL_GENERAL]: spacedChannel("personal", "general", {
            channelInvites: [
              {
                id: "cinv-personal",
                channelId: PERSONAL_GENERAL,
                scope: "channel_participation",
                tokenHash: TOKEN_HASH,
                tokenHint: "vx3k",
                createdAt: NOW - 1000,
                createdByActorId: "operator",
                expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
                maxRedemptions: null,
                route: {
                  authorityNodeId: "node-1",
                  host: "chat.scout.local",
                  baseUrl: "http://chat.scout.local",
                  reachability: "unknown",
                  caveat: "chat.scout.local resolves to 127.0.0.1 on every machine.",
                },
                redemptions: [],
              },
            ],
          }),
          [stableChannelId(spaceNaturalKey("work"))]: spaceRecord("work", "Work"),
          [stableChannelId(spaceNaturalKey("personal"))]: spaceRecord("personal", "Personal"),
        },
        actors: {
          operator: { id: "operator", kind: "person", displayName: "Art" },
          [MAYA]: { id: MAYA, kind: "person", displayName: "Maya" },
        },
        agents: {}, endpoints: {}, flights: {}, invocations: {},
      },
    } as never;
  };

  const makeServer = async () => createOpenScoutWebServer({
    currentDirectory: "/tmp/openscout",
    assetMode: "static",
    staticRoot: makeStaticRoot(),
    advertisedHost: "m1.scout.local",
    portalHost: "scout.local",
    authToken: OPERATOR_TOKEN,
    resolvePeerAddress: () => "127.0.0.1",
  });

  const asOperator = { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } };

  /**
   * The broker's write side, for the two routes that actually join somebody.
   * Redemption has to land in the seeded snapshot, or the next read would see
   * a roster naming a participant with no record -- a different bug than the
   * one under test.
   */
  const stubBrokerWrites = () => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.includes("/v1/actors")) {
        (stubs.scoutBrokerContextResult as any).snapshot.actors[body.id] = body;
        return Response.json({ ok: true });
      }
      if (url.includes("/v1/commands") && body?.kind === "channel.invite.redeem") {
        const actorId = body.request.actorId as string;
        const conversation = (stubs.scoutBrokerContextResult as any).snapshot
          .conversations[PERSONAL_GENERAL];
        if (!conversation.participantIds.includes(actorId)) {
          conversation.participantIds.push(actorId);
        }
        const invite = conversation.metadata.channelInvites[0];
        const redemption = { id: "crdm-personal", actorId, redeemedAt: NOW };
        invite.redemptions.push(redemption);
        return Response.json({
          ok: true,
          invite: { ...invite, redemptionCount: invite.redemptions.length },
          redemption,
          alreadyRedeemed: false,
          participantIds: conversation.participantIds,
          conversationId: PERSONAL_GENERAL,
        });
      }
      return Response.json({ ok: false, error: `unexpected broker call: ${url}` }, { status: 500 });
    }) as typeof fetch;
  };

  /** A member credential bound to one channel in one space. */
  const memberToken = (channelId: string, spaceSlug: string | null) =>
    createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN }).mint({
      actorId: MAYA,
      displayName: "Maya",
      channelId,
      nowMs: NOW,
      ...(spaceSlug ? { spaceSlug } : {}),
    }).token;

  const asMember = (token: string) => ({
    headers: { cookie: channelMemberCookie(token, false).split(";")[0]! },
  });

  test("the operator in one space cannot reach a room in another, by any route", async () => {
    seedSpaces();
    const server = await makeServer();

    // Every channel read and write goes through one resolver, so the boundary
    // is the same on all of them. A laxer second path to the same conversation
    // is how a namespace turns into a suggestion.
    const reads = ["feed", "poll", "events", "members", "invites"];
    for (const suffix of reads) {
      const response = await server.app.request(
        `http://localhost/api/channels/${PERSONAL_GENERAL}/${suffix}?space=work`,
        asOperator,
      );
      expect([suffix, response.status]).toEqual([suffix, 404]);
      // 404, not 403: "exists, but not in the space you named" would make the
      // refusal a directory of the rooms you are not in.
      expect([suffix, (await response.json() as { error: string }).error])
        .toEqual([suffix, "channel not found"]);
    }

    for (const suffix of ["messages", "asks", "invites"]) {
      const response = await server.app.request(
        `http://localhost/api/channels/${PERSONAL_GENERAL}/${suffix}?space=work`,
        {
          method: "POST",
          headers: { ...asOperator.headers, "content-type": "application/json" },
          body: JSON.stringify({ requestId: "req-x", body: "hello", targetActorId: "operator" }),
        },
      );
      expect([suffix, response.status]).toEqual([suffix, 404]);
    }
    // Nothing was written on the way to the refusal.
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
  });

  test("the same room is reachable when the selector names its own space", async () => {
    seedSpaces();
    const server = await makeServer();

    const named = await server.app.request(
      `http://localhost/api/channels/${PERSONAL_GENERAL}/members?space=personal`,
      asOperator,
    );
    expect(named.status).toBe(200);

    // And an absent selector is the default space, which is what keeps every
    // URL that predates spaces working unchanged.
    const legacy = await server.app.request(
      `http://localhost/api/channels/${LEGACY_CHANNEL}/members`,
      asOperator,
    );
    expect(legacy.status).toBe(200);

    // A default-space URL cannot reach a spaced room, even with the right id.
    const bare = await server.app.request(
      `http://localhost/api/channels/${WORK_GENERAL}/members`,
      asOperator,
    );
    expect(bare.status).toBe(404);
  });

  test("a malformed space is refused rather than repaired into another one", async () => {
    seedSpaces();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/channels/${WORK_GENERAL}/feed?space=work%2Fsecret`,
      asOperator,
    );
    // Falling back to the default on a typo would quietly serve a different
    // room and call it success.
    expect(response.status).toBe(400);
  });

  test("the header is another spelling of the selector, and no more", async () => {
    seedSpaces();
    const server = await makeServer();

    // An HTTP client handed a bare endpoint can select with a header...
    const selected = await server.app.request(
      `http://localhost/api/channels/${WORK_GENERAL}/members`,
      { headers: { ...asOperator.headers, "x-scout-space": "work" } },
    );
    expect(selected.status).toBe(200);

    // ...but a member credential bound to `work` is not widened by a header
    // naming `personal`. The credential decides; the selector only narrows.
    const token = memberToken(WORK_GENERAL, "work");
    const forged = await server.app.request(
      `http://localhost/api/channels/${PERSONAL_GENERAL}/members`,
      {
        headers: {
          ...asMember(token).headers,
          "x-scout-space": "personal",
        },
      },
    );
    expect(forged.status).not.toBe(200);
  });

  test("bootstrap answers for one space, and lists only the spaces you are in", async () => {
    seedSpaces();
    const server = await makeServer();

    const work = await server.app.request(
      "http://localhost/api/chat/bootstrap?space=work",
      asOperator,
    );
    expect(work.status).toBe(200);
    const workBody = await work.json() as Record<string, any>;
    expect(workBody.space).toBe("work");
    expect(workBody.channels.map((channel: { id: string }) => channel.id)).toEqual([WORK_GENERAL]);
    // The space record itself is never a room. It is `kind: "system"`, which is
    // what keeps it out of every conversation list in the product.
    expect(JSON.stringify(workBody.channels)).not.toContain(stableChannelId(spaceNaturalKey("work")));
    expect(workBody.spaces.map((space: { slug: string }) => space.slug))
      .toEqual(["home", "personal", "work"]);

    // The default space is what an absent selector means, and it holds exactly
    // the channels that predate spaces.
    const home = await server.app.request("http://localhost/api/chat/bootstrap", asOperator);
    const homeBody = await home.json() as Record<string, any>;
    expect(homeBody.space).toBe("home");
    expect(homeBody.channels.map((channel: { id: string }) => channel.id)).toEqual([LEGACY_CHANNEL]);

    // A member sees their own space and is not told the others exist.
    const token = memberToken(WORK_GENERAL, "work");
    const member = await server.app.request(
      "http://localhost/api/chat/bootstrap",
      asMember(token),
    );
    expect(member.status).toBe(200);
    const memberBody = await member.json() as Record<string, any>;
    expect(memberBody.viewer.isOperator).toBe(false);
    expect(memberBody.space).toBe("work");
    expect(memberBody.channels.map((channel: { id: string }) => channel.id)).toEqual([WORK_GENERAL]);
    expect(memberBody.spaces.map((space: { slug: string }) => space.slug)).toEqual(["work"]);
    expect(JSON.stringify(memberBody)).not.toContain("Personal");
  });

  test("a legacy channel keeps its exact id and stays in the default space", async () => {
    seedSpaces();
    const server = await makeServer();

    // The id is a pure function of the natural key, and the default space's key
    // is byte-identical to the one that existed before spaces. Nothing moved,
    // so nothing had to be migrated.
    expect(LEGACY_CHANNEL).toBe(stableChannelId("channel:release-train"));
    expect(spacedChannelNaturalKey("home", "release-train")).toBe("channel:release-train");

    const feed = await server.app.request(
      `http://localhost/api/channels/${LEGACY_CHANNEL}/members`,
      asOperator,
    );
    expect(feed.status).toBe(200);

    // A credential minted before `spaceSlug` existed still reaches it.
    const legacyToken = memberToken(LEGACY_CHANNEL, null);
    const asLegacyMember = await server.app.request(
      `http://localhost/api/channels/${LEGACY_CHANNEL}/members`,
      asMember(legacyToken),
    );
    expect(asLegacyMember.status).toBe(200);
    // And it is not a key to a space that did not exist when it was issued.
    const intoWork = await server.app.request(
      `http://localhost/api/channels/${WORK_GENERAL}/members?space=work`,
      asMember(legacyToken),
    );
    expect(intoWork.status).not.toBe(200);
  });

  test("listing spaces tells a member about their own, and the host about all", async () => {
    seedSpaces();
    const server = await makeServer();

    const operator = await server.app.request("http://localhost/api/chat/spaces", asOperator);
    expect(operator.status).toBe(200);
    expect(((await operator.json()) as Record<string, any>).spaces
      .map((space: { slug: string }) => space.slug)).toEqual(["home", "personal", "work"]);

    const token = memberToken(PERSONAL_GENERAL, "personal");
    const member = await server.app.request("http://localhost/api/chat/spaces", asMember(token));
    expect(member.status).toBe(200);
    const body = await member.json() as Record<string, any>;
    expect(body.spaces.map((space: { slug: string }) => space.slug)).toEqual(["personal"]);
    expect(JSON.stringify(body)).not.toContain("Work");
  });

  test("only the host carves out a new space, and it never lands empty", async () => {
    seedSpaces();
    const server = await makeServer();

    const token = memberToken(WORK_GENERAL, "work");
    const refused = await server.app.request("http://localhost/api/chat/spaces", {
      method: "POST",
      headers: { ...asMember(token).headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "Widened" }),
    });
    // A scoped credential joins rooms; it does not carve out namespaces.
    expect([401, 403]).toContain(refused.status);

    upsertScoutConversationCalls.length = 0;
    const created = await server.app.request("http://localhost/api/chat/spaces", {
      method: "POST",
      headers: { ...asOperator.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "Ops", channel: "incidents" }),
    });
    expect(created.status).toBe(200);
    const body = await created.json() as Record<string, any>;
    expect(body.space.slug).toBe("ops");
    expect(body.space.title).toBe("Ops");
    // The first channel is created with the space: a space with no room in it
    // is a dead end the operator has to notice and fix.
    expect(body.channel.title).toBe("incidents");
    expect(body.channel.id).toBe(stableChannelId(spacedChannelNaturalKey("ops", "incidents")));
    expect(body.channel.metadata[CHANNEL_SPACE_SLUG_METADATA]).toBe("ops");

    // Two writes: the space record, then its first room.
    expect(upsertScoutConversationCalls.map((call) => call.kind)).toEqual(["system", "channel"]);

    // And the name that already means "everything that existed before spaces"
    // cannot be claimed.
    const conflict = await server.app.request("http://localhost/api/chat/spaces", {
      method: "POST",
      headers: { ...asOperator.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "Home" }),
    });
    expect(conflict.status).toBe(409);
  });

  test("a channel is created into the space the request names", async () => {
    seedSpaces();
    const server = await makeServer();

    const created = await server.app.request("http://localhost/api/chat/channels?space=work", {
      method: "POST",
      headers: { ...asOperator.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "design-review" }),
    });
    expect(created.status).toBe(200);
    const body = await created.json() as Record<string, any>;
    expect(body.space).toBe("work");
    expect(body.conversation.id)
      .toBe(stableChannelId(spacedChannelNaturalKey("work", "design-review")));

    // The same name in the default space is a different room, all the way down
    // to the id -- which is what makes two spaces two feeds rather than one
    // shared one.
    const home = await server.app.request("http://localhost/api/chat/channels", {
      method: "POST",
      headers: { ...asOperator.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "design-review" }),
    });
    const homeBody = await home.json() as Record<string, any>;
    expect(homeBody.space).toBe("home");
    expect(homeBody.conversation.id).not.toBe(body.conversation.id);
    expect(homeBody.conversation.id).toBe(stableChannelId("channel:design-review"));
  });

  test("redeeming into a second space mints a second credential, not a wider one", async () => {
    seedSpaces();
    stubBrokerWrites();
    const server = await makeServer();

    // Maya is already holding a `work` credential when she opens a `personal`
    // invitation. Widening the held grant would turn one cookie into a key for
    // both spaces.
    const workToken = memberToken(WORK_GENERAL, "work");
    const response = await server.app.request(
      `http://localhost/api/invites/${TOKEN}/redeem`,
      {
        method: "POST",
        headers: {
          ...asMember(workToken).headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ actorId: MAYA, displayName: "Maya", sessionId: "sess.maya" }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.space).toEqual({ slug: "personal", title: "Personal" });

    const issued = response.headers.get("set-cookie") ?? "";
    expect(issued).toContain(`${CHANNEL_MEMBER_COOKIE}=`);
    const issuedToken = decodeURIComponent(
      issued.split(`${CHANNEL_MEMBER_COOKIE}=`)[1]!.split(";")[0]!,
    );
    expect(issuedToken).not.toBe(workToken);

    // The new credential is bound to `personal` and names only that channel.
    const reader = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const fresh = reader.validate(issuedToken);
    expect(fresh?.spaceSlug).toBe("personal");
    expect(fresh?.channelIds).toEqual([PERSONAL_GENERAL]);
    expect(fresh?.channelIds).not.toContain(WORK_GENERAL);

    // And the credential she was already holding is untouched -- neither
    // revoked as the price of refusing to widen it, nor extended.
    const held = reader.validate(workToken);
    expect(held?.spaceSlug).toBe("work");
    expect(held?.channelIds).toEqual([WORK_GENERAL]);
  });

  test("a returned poll URL carries the space it was issued for", async () => {
    seedSpaces();
    stubBrokerWrites();
    const server = await makeServer();

    const response = await server.app.request(
      `http://localhost/api/invites/${TOKEN}/participate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "release-bot" }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.space).toEqual({ slug: "personal", title: "Personal" });
    // A bare poll URL would 404 against the default space. The one we hand out
    // has to be the one that works.
    expect(body.poll.url).toBe(`/api/channels/${PERSONAL_GENERAL}/poll?space=personal`);
  });

  test("the invitation document and api.md carry working space context", async () => {
    seedSpaces();
    const server = await makeServer();

    const preview = await server.app.request(`http://localhost/api/invites/${TOKEN}`);
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as Record<string, any>).space)
      .toEqual({ slug: "personal", title: "Personal" });

    const api = await server.app.request(`http://localhost/invite/${TOKEN}/api.md`);
    expect(api.status).toBe(200);
    const markdown = await api.text();
    // Every URL in the document is one a client can paste.
    expect(markdown).toContain(`/api/channels/${PERSONAL_GENERAL}/poll?space=personal`);
    expect(markdown).toContain("space=personal");
    // And it says what the selector is, so nobody reads it as the credential.
    expect(markdown.toLowerCase()).toContain("selector");
  });
});
