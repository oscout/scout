import { expect, test } from "bun:test";
import type { ChatReadState } from "@openscout/protocol";
import { attentionMessageCount, viewedThreadReads } from "./chat-attention-model.ts";

test("attention filters leave unread history intact and include followed replies", () => {
  const state: ChatReadState = { actorId: "a", channelId: "c", preferences: { notificationMode: "all", followedThreadIds: ["root"] }, lanes: [
    { rootMessageId: null, latestMessageId: "m2", lastReadMessageId: null, unreadMessageIds: ["m1", "m2"], mentionMessageIds: ["m1"], incomplete: false },
    { rootMessageId: "root", latestMessageId: "r2", lastReadMessageId: null, unreadMessageIds: ["r1", "r2"], mentionMessageIds: ["r1"], incomplete: false },
  ] };
  expect(attentionMessageCount(state)).toBe(4);
  state.preferences!.notificationMode = "mentions";
  expect(attentionMessageCount(state)).toBe(3);
  state.preferences!.followedThreadIds = [];
  expect(attentionMessageCount(state)).toBe(2);
  state.preferences!.notificationMode = "muted";
  expect(attentionMessageCount(state)).toBe(0);
  expect(state.lanes.flatMap(lane => lane.unreadMessageIds)).toEqual(["m1", "m2", "r1", "r2"]);
});

test("viewing a channel reads ambient replies under visible roots, never mentions or the open thread", () => {
  const lane = (rootMessageId: string | null, unread: string[], mentions: string[] = []) => ({ rootMessageId, latestMessageId: unread.at(-1) ?? null, lastReadMessageId: null, unreadMessageIds: unread, mentionMessageIds: mentions, incomplete: false });
  const state: ChatReadState = { actorId: "a", channelId: "c", lanes: [
    lane(null, ["m1"]), lane("seen", ["s1", "s2"]), lane("offscreen", ["o1"]), lane("mentioned", ["x1"], ["x1"]), lane("open", ["p1"]), lane("quiet", []),
  ] };
  expect(viewedThreadReads(state, ["seen", "mentioned", "open", "quiet"], "open")).toEqual([{ rootMessageId: "seen", messageId: "s2" }]);
  expect(viewedThreadReads(undefined, ["seen"])).toEqual([]);
});
