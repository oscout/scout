import { join } from "node:path";
import { expect, test, mock } from "bun:test";
import {
  isolatedTestHome, loadScoutBrokerContextOptions, stubs, createChannelMemberSessionAuthority, createOpenScoutWebServer,
  makeStaticRoot, installWebServerTestHooks, loadWebServerUnderTest,
  sendScoutConversationMessageCalls, sendScoutConversationSteerCalls,
} from "../web-server-test-harness.ts";
const listeningReads: any[] = [];
let listeningFailure = false;
mock.module("../room-listening-page.ts", () => ({
  RoomListeningPageError: class extends Error {},
  readLocalRoomListeningPage: (input: any) => { if (listeningFailure) throw new Error("isolated source failure"); listeningReads.push(input); return { protocol: "room-listening.v1", channelId: input.channelId, messages: [], nextCursor: input.cursor ?? "opaque", hasMore: false }; },
}));
await loadWebServerUnderTest();
installWebServerTestHooks();
const channelId = "chn-0123456789abcdef0123456789abcdef";
const actorId = "apia-listening-test";
const secret = "isolated-listening-test-secret";
async function fixture() {
  listeningFailure = false;
  stubs.scoutBrokerContextResult = {
    baseUrl: "http://broker.test", node: { id: "node-test" }, snapshot: {
      conversations: { [channelId]: { id: channelId, kind: "channel", title: "Listening", participantIds: [actorId],
        visibility: "workspace", shareMode: "shared", authorityNodeId: "node-test", metadata: {} } },
      actors: { [actorId]: { id: actorId, kind: "person", displayName: "Reader" } },
      agents: {}, endpoints: {}, messages: {}, flights: {},
    },
  } as never;
  stubs.queryConversationDefinitionByIdImpl = (id: string) => (stubs.scoutBrokerContextResult as any)?.snapshot.conversations[id] ?? null;
  const server = await createOpenScoutWebServer({ currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot(),
    advertisedHost: "m1.scout.local", portalHost: "scout.local", authToken: secret, resolvePeerAddress: () => "127.0.0.1" });
  const authority = createChannelMemberSessionAuthority({ signingSecret: secret });
  const grant = authority.mint({ actorId, displayName: "Reader", channelId, participation: "api" });
  const read = (token: string, query = "") => server.app.request(`http://localhost/api/channels/${channelId}/listening-membership${query}`, { headers: { authorization: `Bearer ${token}` } });
  return { server, authority, grant, read };
}
test("listening custody proof returns channel, actor, space, node and expiry without posting/dispatching", async () => {
  const h = await fixture(), response = await h.read(h.grant.token);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const proof = await response.json() as any;
  expect(proof).toMatchObject({ actorId, channelId, nodeId: "node-test", space: "home" });
  expect(proof.expiresAt).toBeNumber();
  expect(JSON.stringify(proof)).not.toContain(h.grant.token);
  expect(sendScoutConversationMessageCalls).toHaveLength(0);
  expect(sendScoutConversationSteerCalls).toHaveLength(0);
});
test("custody proof rejects operator bearer, expired member, removed membership and wrong space", async () => {
  const h = await fixture();
  expect((await h.read(secret)).status).toBe(401);
  const expired = h.authority.mint({ actorId, displayName: "Reader", channelId, nowMs: 1 });
  expect((await h.read(expired.token)).status).not.toBe(200);
  expect((await h.read(h.grant.token, "?space=elsewhere")).status).not.toBe(200);
  (stubs.scoutBrokerContextResult as any).snapshot.conversations[channelId].participantIds = [];
  expect((await h.read(h.grant.token)).status).not.toBe(200);
});

test("listening proof reads only fresh roster metadata, never message history", async () => {
  const h = await fixture();
  Object.defineProperty((stubs.scoutBrokerContextResult as any).snapshot, "messages", { get() { throw new Error("history accessed"); } });
  loadScoutBrokerContextOptions.length = 0;
  expect((await h.read(h.grant.token)).status).toBe(200);
  expect(loadScoutBrokerContextOptions).toHaveLength(0);
});

test("room HTTP listening endpoint scopes credential, space and opaque cursor without dispatch or snapshot", async () => {
  const h = await fixture(); listeningReads.length = 0; loadScoutBrokerContextOptions.length = 0;
  const read = (token: string) => h.server.app.request(`http://localhost/api/channels/${channelId}/listening?space=home&cursor=opaque`, { headers: { authorization: `Bearer ${token}` } });
  expect((await read(secret)).status).toBe(401);
  expect(listeningReads).toHaveLength(0);
  const response = await read(h.grant.token); expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body).toMatchObject({ protocol: "room-listening.v1", nextCursor: "opaque", membership: { actorId, channelId, space: "home" } });
  expect(listeningReads[0]).toMatchObject({ channelId, actorId, cursor: "opaque" });
  expect(loadScoutBrokerContextOptions).toHaveLength(0);
  expect(JSON.stringify(body)).not.toContain(secret);
  (stubs.scoutBrokerContextResult as any).snapshot.conversations[channelId].participantIds = [];
  expect((await read(h.grant.token)).status).toBe(403); expect(listeningReads).toHaveLength(1);
});

test("successful empty room reads renew the credential and publish durable current expiry; refusals do not", async () => {
  const h = await fixture();
  const issuedAt = Date.now() - 120_000;
  const initial = h.authority.mint({ actorId, displayName: "Reader", channelId, participation: "api", nowMs: issuedAt });
  const url = `http://localhost/api/channels/${channelId}/listening?space=home&cursor=opaque`;
  const headers = { authorization: `Bearer ${initial.token}` };
  const response = await h.server.app.request(url, { headers });
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.messages).toEqual([]);
  expect(body.membership.expiresAt).toBeGreaterThan(initial.grant.expiresAt);
  expect(Number(response.headers.get("x-openscout-member-expires-at"))).toBe(body.membership.expiresAt);
  const second = await h.server.app.request(url, { headers });
  expect((await second.json() as any).membership.expiresAt).toBe(body.membership.expiresAt);

  // A new web authority has no in-memory lease; it must recover from disk.
  const restarted = await createOpenScoutWebServer({ currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot(),
    advertisedHost: "m1.scout.local", portalHost: "scout.local", authToken: secret, resolvePeerAddress: () => "127.0.0.1" });
  const third = await restarted.app.request(url, { headers });
  expect((await third.json() as any).membership.expiresAt).toBe(body.membership.expiresAt);
  const revoked = h.authority.mint({ actorId, displayName: "Reader", channelId, participation: "api", nowMs: issuedAt });
  (stubs.scoutBrokerContextResult as any).snapshot.conversations[channelId].participantIds = [];
  const denied = await h.server.app.request(url, { headers: { authorization: `Bearer ${revoked.token}` } });
  expect(denied.status).toBe(403);
  expect(denied.headers.has("x-openscout-member-expires-at")).toBe(false);
  (stubs.scoutBrokerContextResult as any).snapshot.conversations[channelId].participantIds = [actorId];
  const wrongSpace = await h.server.app.request(url.replace("space=home", "space=elsewhere"), { headers: { authorization: `Bearer ${revoked.token}` } });
  expect(wrongSpace.status).not.toBe(200);
  expect(wrongSpace.headers.has("x-openscout-member-expires-at")).toBe(false);
  listeningFailure = true;
  const failed = await h.server.app.request(url, { headers: { authorization: `Bearer ${revoked.token}` } });
  expect(failed.status).toBe(503);
  listeningFailure = false;
  const durableReader = createChannelMemberSessionAuthority({ signingSecret: secret,
    leaseDirectory: join(isolatedTestHome, ".openscout", "channel-member-leases") });
  expect(durableReader.validate(revoked.token)?.expiresAt).toBe(revoked.grant.expiresAt);
});
