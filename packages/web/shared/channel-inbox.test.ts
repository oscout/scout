import { describe, expect, test } from "bun:test";
import { filterChannelInbox, holdChannelInbox, inboxWaitSeconds, type InboxMessage } from "./channel-inbox.ts";
import { pageChannelPoll } from "../server/core/conversations/channel-polling.ts";

const message = (id: string, actorId: string, extra: Partial<InboxMessage> = {}) => ({ id, actorId, channelId: "room", createdAt: Number(id) || 1, ...extra });
describe("participant inbox", () => {
  test("explicit reasons, nested threads, no own messages or text inference", () => {
    const history = [message("1", "me"), message("2", "other", { replyToMessageId: "1" }),
      message("3", "other", { replyToMessageId: "2", mentions: [{ actorId: "me" }] }),
      message("4", "me", { mentions: [{ actorId: "me" }] }), message("5", "other"), message("6", "other"), message("7", "other")];
    const result = filterChannelInbox(history, history, "me", [{ messageId: "6", responsibility: { actorId: "me" } }], new Set(["7"]));
    expect(result.messages.map(row => row.id)).toEqual(["2", "3", "6", "7"]);
    expect(result.reasons).toEqual({ "2": ["thread", "reply"], "3": ["mention", "thread"], "6": ["question"], "7": ["question"] });
  });
  test("posting in someone else's thread subscribes to siblings", () => {
    const history = [message("1", "other"), message("2", "me", { replyToMessageId: "1" }), message("3", "third", { replyToMessageId: "1" })];
    expect(filterChannelInbox(history.slice(2), history, "me").reasons).toEqual({ "3": ["thread"] });
  });
  test("cursor crosses unfiltered traffic and staleness is preserved", () => {
    const history = [message("1", "other"), message("2", "other"), message("3", "other", { mentions: [{ actorId: "me" }] })];
    const first = pageChannelPoll({ channelId: "room", events: history, limit: 2, completeness: "suffix" });
    expect(filterChannelInbox(first.events, history, "me").messages).toHaveLength(0);
    const next = pageChannelPoll({ channelId: "room", events: history, cursor: first.nextCursor, completeness: "suffix" });
    expect(filterChannelInbox(next.events, history, "me").messages.map(row => row.id)).toEqual(["3"]);
    expect(() => pageChannelPoll({ channelId: "room", events: history.slice(2), cursor: first.nextCursor, completeness: "suffix" })).toThrow("no longer covered");
  });
  test("validates wait", () => {
    expect(inboxWaitSeconds(undefined)).toBe(0);
    expect(inboxWaitSeconds("25")).toBe(25);
    for (const value of ["NaN", "Infinity", "-1", "26"]) expect(() => inboxWaitSeconds(value)).toThrow();
  });
  test("hold returns early on a matching item, after skipping traffic", async () => {
    let reads = 0;
    const response = holdChannelInbox(new Request("https://example.test"), { messages: [], nextCursor: "a", hasMore: true }, 20, async cursor => {
      reads++;
      expect(cursor).toBe(reads === 1 ? "a" : "b");
      return reads === 1 ? { messages: [], nextCursor: "b", hasMore: true } : { messages: ["mention"], nextCursor: "c", hasMore: false };
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: ["mention"], nextCursor: "c", hasMore: false });
    expect(reads).toBe(2);
  });
  test("slow reader receives whitespace within 5s, even with a stalled reload", async () => {
    const abort = new AbortController();
    const response = holdChannelInbox(new Request("https://example.test", { signal: abort.signal }), { messages: [], nextCursor: null, hasMore: true }, 10, () => new Promise(() => {}));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(" ");
    await Bun.sleep(4500);
    const before = Date.now();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(" ");
    expect(Date.now() - before).toBeLessThan(500);
    await reader.cancel();
  }, 7000);
  test("timeout is valid whitespace-prefixed JSON; cancellation stops rechecks", async () => {
    const page = { messages: [], nextCursor: "a", hasMore: false };
    const response = holdChannelInbox(new Request("https://example.test"), page, 0.01, async () => page);
    expect(await response.json()).toEqual(page);
    let reads = 0;
    const cancelled = holdChannelInbox(new Request("https://example.test"), page, 20, async () => { reads++; return page; });
    await cancelled.body!.cancel();
    await Bun.sleep(10);
    expect(reads).toBe(0);
  });
});

test("hold deadline still completes when a recheck stalls", async () => {
  const page = { messages: [], nextCursor: "saved", hasMore: true };
  const response = holdChannelInbox(new Request("https://example.test"), page, 0.02, () => new Promise(() => {}));
  expect(await response.json()).toEqual(page);
});
