import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CHAT_HISTORY_PAGE_LIMIT,
  INITIAL_CHAT_HISTORY_LIMIT,
  MAX_CACHED_MESSAGES_PER_CHAT,
  RECENT_CHAT_PRELOAD_LIMIT,
  canLoadEarlierConversationMessages,
  clearConversationTailCache,
  hasCachedConversationHistory,
  loadConversationHistory,
  loadEarlierConversationMessages,
  loadConversationTail,
  preloadRecentConversationTails,
  readCachedConversationTail,
  writeCachedConversationTail,
} from "./chat-cache.ts";
import { clearApiGetCache } from "./api.ts";
import {
  compareMessagesAsc,
  encodeMessageHistoryCursor,
  parseMessageHistoryCursor,
} from "../../shared/message-pagination.ts";
import type { Message, SessionEntry } from "./types.ts";

function message(id: string, conversationId: string, createdAt: number): Message {
  return {
    id,
    conversationId,
    actorName: "Operator",
    body: id,
    createdAt,
    class: "operator",
  };
}

/**
 * A faithful stand-in for either server path: it holds a transcript in the one
 * shared total order and answers a page strictly before the cursor position.
 * Nothing here looks the anchor up by id, which is exactly the property that
 * lets paging survive a deleted cursor.
 */
function fixtureServer(transcript: Message[]): {
  fetch: typeof fetch;
  requests: URL[];
  remove: (messageId: string) => void;
} {
  let ordered = [...transcript].sort(compareMessagesAsc);
  const requests: URL[] = [];
  const handler = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(url);
    const limit = Number(url.searchParams.get("limit") ?? "80");
    const cursor = parseMessageHistoryCursor(url.searchParams.get("beforeMessageId"));
    const boundary = cursor && cursor.kind === "position"
      ? ordered.findIndex((entry) => compareMessagesAsc(entry, cursor) >= 0)
      : ordered.length;
    const end = boundary < 0 ? ordered.length : boundary;
    return new Response(JSON.stringify(ordered.slice(Math.max(0, end - limit), end)));
  }) as unknown as typeof fetch;
  return {
    fetch: handler,
    requests,
    remove: (messageId: string) => {
      ordered = ordered.filter((entry) => entry.id !== messageId);
    },
  };
}

function conversation(id: string): SessionEntry {
  return {
    id,
    kind: "direct",
    title: id,
    participantIds: [],
    agentId: null,
    agentName: null,
    harness: null,
    harnessSessionId: null,
    harnessLogPath: null,
    currentBranch: null,
    preview: null,
    messageCount: 0,
    lastMessageAt: null,
    workspaceRoot: null,
  };
}

describe("chat tail cache", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearApiGetCache();
    clearConversationTailCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearApiGetCache();
    clearConversationTailCache();
  });

  test("reuses a completed tail request until a refresh is requested", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify([
        message(`msg-${calls}`, "chat-1", calls),
      ]));
    }) as unknown as typeof fetch;

    await expect(loadConversationTail("chat-1")).resolves.toHaveLength(1);
    await expect(loadConversationTail("chat-1")).resolves.toHaveLength(1);
    expect(calls).toBe(1);

    await expect(loadConversationTail("chat-1", { refresh: true })).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });

  test("hydrates older history once and later merges only the refreshed tail", async () => {
    const requestedLimits: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const limit = url.searchParams.get("limit") ?? "missing";
      requestedLimits.push(limit);
      const messages = limit === String(INITIAL_CHAT_HISTORY_LIMIT)
        ? [message("msg-old", "chat-1", 1), message("msg-current", "chat-1", 2)]
        : [message("msg-new", "chat-1", 3)];
      return new Response(JSON.stringify(messages));
    }) as unknown as typeof fetch;

    await loadConversationHistory("chat-1");
    await loadConversationHistory("chat-1");
    await loadConversationTail("chat-1", { refresh: true });

    expect(requestedLimits).toEqual([
      String(INITIAL_CHAT_HISTORY_LIMIT),
      "80",
    ]);
    expect(hasCachedConversationHistory("chat-1")).toBe(true);
    expect(readCachedConversationTail("chat-1")?.map((item) => item.id)).toEqual([
      "msg-old",
      "msg-current",
      "msg-new",
    ]);
  });

  test("loads an earlier page before the oldest cached message and stops at history end", async () => {
    const initial = Array.from(
      { length: INITIAL_CHAT_HISTORY_LIMIT },
      (_, index) => message(`msg-${index + 100}`, "chat-1", index + 100),
    );
    const earlier = [
      message("msg-98", "chat-1", 98),
      message("msg-99", "chat-1", 99),
    ];
    const requested: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      requested.push(url);
      return new Response(JSON.stringify(
        url.searchParams.has("beforeMessageId") ? earlier : initial,
      ));
    }) as unknown as typeof fetch;

    await loadConversationHistory("chat-1");
    expect(canLoadEarlierConversationMessages("chat-1")).toBe(true);

    await loadEarlierConversationMessages("chat-1");

    expect(requested[1]?.searchParams.get("limit")).toBe(String(CHAT_HISTORY_PAGE_LIMIT));
    // The cursor carries the position, not just the anchor's name.
    expect(requested[1]?.searchParams.get("beforeMessageId")).toBe("100|msg-100");
    expect(readCachedConversationTail("chat-1")?.slice(0, 3).map((item) => item.id)).toEqual([
      "msg-98",
      "msg-99",
      "msg-100",
    ]);
    expect(canLoadEarlierConversationMessages("chat-1")).toBe(false);
  });

  test("keeps reaching older history after the cursor message is deleted", async () => {
    const transcript = Array.from(
      { length: 450 },
      (_, index) => message(`msg-${String(index + 1).padStart(4, "0")}`, "chat-1", index + 1),
    );
    const server = fixtureServer(transcript);
    globalThis.fetch = server.fetch;

    await loadConversationHistory("chat-1");
    const initial = readCachedConversationTail("chat-1") ?? [];
    expect(initial).toHaveLength(INITIAL_CHAT_HISTORY_LIMIT);
    expect(initial[0]?.id).toBe("msg-0151");

    // The anchor the next page hangs off vanishes between clicks.
    server.remove("msg-0151");

    const afterEarlier = await loadEarlierConversationMessages("chat-1");

    // Before the fix the server answered [] here, the cache flipped
    // historyExhausted, and msg-0001..msg-0150 became unreachable.
    expect(server.requests[1]?.searchParams.get("beforeMessageId")).toBe("151|msg-0151");
    expect(afterEarlier).toHaveLength(INITIAL_CHAT_HISTORY_LIMIT + CHAT_HISTORY_PAGE_LIMIT);
    expect(afterEarlier[0]?.id).toBe("msg-0051");
    expect(canLoadEarlierConversationMessages("chat-1")).toBe(true);
  });

  test("advances past tied timestamps instead of re-requesting the same cursor", async () => {
    // The reviewer's fixture: 400 messages at one timestamp across three id
    // families whose relative order differs between binary and locale collation.
    const transcript = [
      ...Array.from({ length: 100 }, (_, index) =>
        message(`msg-!${String(index).padStart(3, "0")}`, "chat-1", 1_000)),
      ...Array.from({ length: 150 }, (_, index) =>
        message(`msg-0${String(index).padStart(3, "0")}`, "chat-1", 1_000)),
      ...Array.from({ length: 150 }, (_, index) =>
        message(`msg-_${String(index).padStart(3, "0")}`, "chat-1", 1_000)),
    ];
    const server = fixtureServer(transcript);
    globalThis.fetch = server.fetch;

    await loadConversationHistory("chat-1");
    const initial = readCachedConversationTail("chat-1") ?? [];
    expect(initial).toHaveLength(INITIAL_CHAT_HISTORY_LIMIT);
    expect(initial[0]?.id).toBe("msg-0000");

    // Locale order would have nominated a "msg-_" row as the oldest on screen —
    // a cursor the server reads as *newer*, so the page it answers with is one
    // the cache already holds and the cursor never moves.
    const localeOldest = [...initial].sort((left, right) => left.id.localeCompare(right.id))[0]!;
    expect(localeOldest.id.startsWith("msg-_")).toBe(true);

    const afterEarlier = await loadEarlierConversationMessages("chat-1");

    expect(server.requests[1]?.searchParams.get("beforeMessageId"))
      .toBe(encodeMessageHistoryCursor(initial[0]!));
    expect(afterEarlier).toHaveLength(400);
    expect(afterEarlier[0]?.id).toBe("msg-!000");

    // The cursor moved, so the next probe reaches the true start of history and
    // terminates. Under the old locale pick this second request repeated the
    // first cursor and the button stayed enabled forever.
    await loadEarlierConversationMessages("chat-1");
    expect(server.requests[2]?.searchParams.get("beforeMessageId"))
      .toBe(encodeMessageHistoryCursor(afterEarlier[0]!));
    expect(server.requests[2]?.searchParams.get("beforeMessageId"))
      .not.toBe(server.requests[1]?.searchParams.get("beforeMessageId"));
    expect(readCachedConversationTail("chat-1")).toHaveLength(400);
    expect(canLoadEarlierConversationMessages("chat-1")).toBe(false);
  });

  test("keeps only the bounded cached history in stable order", () => {
    const messages = Array.from(
      { length: MAX_CACHED_MESSAGES_PER_CHAT + 5 },
      (_, index) => message(`msg-${String(index).padStart(3, "0")}`, "chat-1", index),
    ).reverse();

    const cached = writeCachedConversationTail("chat-1", messages);

    expect(cached).toHaveLength(MAX_CACHED_MESSAGES_PER_CHAT);
    expect(cached[0]?.createdAt).toBe(5);
    expect(cached.at(-1)?.createdAt).toBe(MAX_CACHED_MESSAGES_PER_CHAT + 4);
  });

  test("preloads only ten recent chats with bounded concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const url = new URL(String(input), "http://localhost");
      const conversationId = url.searchParams.get("conversationId") ?? "missing";
      requested.push(conversationId);
      await Promise.resolve();
      active--;
      return new Response(JSON.stringify([message(`msg-${conversationId}`, conversationId, 1)]));
    }) as unknown as typeof fetch;

    const conversations = Array.from(
      { length: RECENT_CHAT_PRELOAD_LIMIT + 3 },
      (_, index) => conversation(`chat-${index}`),
    );
    await preloadRecentConversationTails(conversations);

    expect(requested).toHaveLength(RECENT_CHAT_PRELOAD_LIMIT);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(readCachedConversationTail("chat-0")).toHaveLength(1);
    expect(readCachedConversationTail(`chat-${RECENT_CHAT_PRELOAD_LIMIT}`)).toBeNull();
  });
});
