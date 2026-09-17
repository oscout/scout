import { describe, expect, test } from "bun:test";

import { compareMessageIds, encodeMessageHistoryCursor } from "../../../shared/message-pagination.ts";
import {
  CHANNEL_POLL_CURSOR_PREFIX,
  CHANNEL_POLL_INTERVAL_CATCH_UP_MS,
  CHANNEL_POLL_INTERVAL_CAUGHT_UP_MS,
  ChannelPollCursorError,
  ChannelPollError,
  DEFAULT_CHANNEL_POLL_LIMIT,
  MAX_CHANNEL_POLL_LIMIT,
  channelPollEventFromProjection,
  clampChannelPollLimit,
  decodeChannelPollCursor,
  encodeChannelPollCursor,
  pageChannelPoll,
  type ChannelPollEvent,
} from "./channel-polling.ts";

const CHANNEL = "chn-0123456789abcdef0123456789abcdef";
const OTHER_CHANNEL = "chn-fedcba9876543210fedcba9876543210";
const NOW = 1_800_000_000_000;

/**
 * Same three id families as the history-order fixture: at one timestamp they
 * sort `!` < `0` < `_` in SQLite BINARY / code-point order, and the other way
 * under localeCompare.
 */
const TIED_IDS = ["msg-_000", "msg-!000", "msg-0000"] as const;

function event(
  overrides: Partial<ChannelPollEvent> & Pick<ChannelPollEvent, "id">,
): ChannelPollEvent {
  return {
    channelId: CHANNEL,
    createdAt: NOW,
    actorId: "actor-1",
    actorName: "Art",
    body: overrides.id,
    class: "agent",
    metadata: null,
    replyToMessageId: null,
    threadConversationId: null,
    ...overrides,
  };
}

function page(input: Parameters<typeof pageChannelPoll<ChannelPollEvent>>[0]) {
  return pageChannelPoll(input);
}

describe("channel poll limit", () => {
  test("caps every caller at the same page size", () => {
    expect(clampChannelPollLimit(1_000)).toBe(MAX_CHANNEL_POLL_LIMIT);
    expect(clampChannelPollLimit(101)).toBe(MAX_CHANNEL_POLL_LIMIT);
    expect(clampChannelPollLimit(50)).toBe(50);
    expect(clampChannelPollLimit(1)).toBe(1);
  });

  test("falls back for a missing or nonsensical limit", () => {
    expect(clampChannelPollLimit(undefined)).toBe(DEFAULT_CHANNEL_POLL_LIMIT);
    expect(clampChannelPollLimit(0)).toBe(DEFAULT_CHANNEL_POLL_LIMIT);
    expect(clampChannelPollLimit(-5)).toBe(DEFAULT_CHANNEL_POLL_LIMIT);
    expect(clampChannelPollLimit(Number.NaN)).toBe(DEFAULT_CHANNEL_POLL_LIMIT);
    expect(clampChannelPollLimit("80")).toBe(DEFAULT_CHANNEL_POLL_LIMIT);
    expect(clampChannelPollLimit(undefined, 25)).toBe(25);
  });
});

describe("channel poll cursor", () => {
  test("round-trips a position through encode and decode", () => {
    const encoded = encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: 1_783_915_198_766,
      id: "msg-0450",
    });
    expect(encoded.startsWith(CHANNEL_POLL_CURSOR_PREFIX)).toBe(true);
    expect(encoded.includes(CHANNEL)).toBe(false);
    expect(encoded.includes("msg-0450")).toBe(false);
    expect(decodeChannelPollCursor(encoded)).toEqual({
      version: 1,
      channelId: CHANNEL,
      createdAt: 1_783_915_198_766,
      id: "msg-0450",
    });
  });

  test("keeps ids that contain JSON metacharacters intact", () => {
    const encoded = encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: 42,
      id: 'msg|"with"\\pipes',
    });
    expect(decodeChannelPollCursor(encoded).id).toBe('msg|"with"\\pipes');
  });

  test("treats blank as no cursor and anything else unreadable as malformed", () => {
    const events = [event({ id: "msg-1" })];
    expect(page({
      channelId: CHANNEL,
      events,
      cursor: null,
      completeness: "complete",
    }).events.map((row) => row.id)).toEqual(["msg-1"]);
    expect(page({
      channelId: CHANNEL,
      events,
      cursor: "  ",
      completeness: "complete",
    }).events.map((row) => row.id)).toEqual(["msg-1"]);
  });

  test("refuses malformed cursors instead of reading them as end of feed", () => {
    const events = [event({ id: "msg-1" })];
    const history = encodeMessageHistoryCursor({ createdAt: NOW, id: "msg-1" });
    const badPayload = `${CHANNEL_POLL_CURSOR_PREFIX}${Buffer.from("{}", "utf8").toString("base64url")}`;
    const unknownVersion = `chpoll.v2.${Buffer.from(
      JSON.stringify({ ch: CHANNEL, id: "msg-1", t: NOW }),
      "utf8",
    ).toString("base64url")}`;
    const padded = `${encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: NOW,
      id: "msg-1",
    })}=`;
    const malformed = [
      "not-a-cursor",
      history,
      `${CHANNEL_POLL_CURSOR_PREFIX}`,
      `${CHANNEL_POLL_CURSOR_PREFIX}%%%`,
      unknownVersion,
      badPayload,
      padded,
      `${CHANNEL_POLL_CURSOR_PREFIX}${Buffer.from("[]", "utf8").toString("base64url")}`,
      `${CHANNEL_POLL_CURSOR_PREFIX}${Buffer.from(
        JSON.stringify({ ch: CHANNEL, id: "msg-1", t: "1" }),
        "utf8",
      ).toString("base64url")}`,
      `${CHANNEL_POLL_CURSOR_PREFIX}${Buffer.from(
        JSON.stringify({ ch: CHANNEL, id: "msg-1", t: -1 }),
        "utf8",
      ).toString("base64url")}`,
      `${CHANNEL_POLL_CURSOR_PREFIX}${Buffer.from(
        JSON.stringify({ ch: "", id: "msg-1", t: NOW }),
        "utf8",
      ).toString("base64url")}`,
    ];

    for (const cursor of malformed) {
      expect(() => page({
        channelId: CHANNEL,
        events,
        cursor,
        completeness: "complete",
      })).toThrow(ChannelPollCursorError);
    }

    try {
      decodeChannelPollCursor(history);
      throw new Error("expected a ChannelPollCursorError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ChannelPollCursorError);
      expect((cause as ChannelPollCursorError).reason).toBe("malformed");
    }
  });
});

describe("equal-timestamp paging", () => {
  test("breaks tied timestamps by code point so a page never repeats or skips", () => {
    const locale = [...TIED_IDS].sort((left, right) => left.localeCompare(right));
    const binary = [...TIED_IDS].sort(compareMessageIds);
    expect(locale).not.toEqual(binary);
    expect(binary).toEqual(["msg-!000", "msg-0000", "msg-_000"]);

    const events = TIED_IDS.map((id) => event({ id, createdAt: NOW }));
    const first = page({
      channelId: CHANNEL,
      events,
      limit: 2,
      completeness: "complete",
    });
    expect(first.events.map((row) => row.id)).toEqual(["msg-!000", "msg-0000"]);
    expect(first.hasMore).toBe(true);
    expect(first.recommendedPollIntervalMs).toBe(CHANNEL_POLL_INTERVAL_CATCH_UP_MS);
    expect(first.nextCursor).toBeString();

    const second = page({
      channelId: CHANNEL,
      events,
      cursor: first.nextCursor,
      limit: 2,
      completeness: "complete",
    });
    expect(second.events.map((row) => row.id)).toEqual(["msg-_000"]);
    expect(second.hasMore).toBe(false);
    expect(second.recommendedPollIntervalMs).toBe(CHANNEL_POLL_INTERVAL_CAUGHT_UP_MS);

    const caughtUp = page({
      channelId: CHANNEL,
      events,
      cursor: second.nextCursor,
      limit: 2,
      completeness: "complete",
    });
    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.nextCursor).toBe(second.nextCursor);
  });

  test("a locale-ordered cursor would skip the BINARY-oldest tied id", () => {
    const events = TIED_IDS.map((id) => event({ id, createdAt: NOW }));
    const localeOldest = [...TIED_IDS].sort((left, right) => left.localeCompare(right))[0]!;
    expect(localeOldest).toBe("msg-_000");
    const skipped = page({
      channelId: CHANNEL,
      events,
      cursor: encodeChannelPollCursor({
        channelId: CHANNEL,
        createdAt: NOW,
        id: localeOldest,
      }),
      completeness: "complete",
    });
    expect(skipped.events.map((row) => row.id)).toEqual([]);
  });
});

describe("cross-channel rejection", () => {
  test("refuses a cursor minted for another channel", () => {
    const cursor = encodeChannelPollCursor({
      channelId: OTHER_CHANNEL,
      createdAt: NOW,
      id: "msg-1",
    });
    try {
      page({
        channelId: CHANNEL,
        events: [event({ id: "msg-1" }), event({ id: "msg-other", channelId: OTHER_CHANNEL })],
        cursor,
        completeness: "complete",
      });
      throw new Error("expected a ChannelPollCursorError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ChannelPollCursorError);
      expect((cause as ChannelPollCursorError).reason).toBe("wrong_channel");
      expect((cause as ChannelPollCursorError).expectedChannelId).toBe(CHANNEL);
      expect((cause as ChannelPollCursorError).cursor).toBe(cursor);
    }
  });

  test("pages only the requested channel when the input is mixed", () => {
    const result = page({
      channelId: CHANNEL,
      events: [
        event({ id: "msg-a", createdAt: NOW }),
        event({ id: "msg-b", channelId: OTHER_CHANNEL, createdAt: NOW + 1 }),
        event({ id: "msg-c", createdAt: NOW + 2 }),
      ],
      completeness: "complete",
    });
    expect(result.events.map((row) => row.id)).toEqual(["msg-a", "msg-c"]);
  });
});

describe("empty pages", () => {
  test("a complete empty channel is silence, not a cursor error", () => {
    const result = page({
      channelId: CHANNEL,
      events: [],
      completeness: "complete",
    });
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
    expect(result.recommendedPollIntervalMs).toBe(CHANNEL_POLL_INTERVAL_CAUGHT_UP_MS);
  });

  test("a complete empty channel with a cursor echoes it", () => {
    const cursor = encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: NOW,
      id: "msg-gone",
    });
    const result = page({
      channelId: CHANNEL,
      events: [],
      cursor,
      completeness: "complete",
    });
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBe(cursor);
    expect(result.hasMore).toBe(false);
  });

  test("caught-up polls stay empty until a newer event arrives", () => {
    const events = [
      event({ id: "msg-1", createdAt: NOW }),
      event({ id: "msg-2", createdAt: NOW + 1 }),
    ];
    const first = page({
      channelId: CHANNEL,
      events,
      completeness: "complete",
    });
    const idle = page({
      channelId: CHANNEL,
      events,
      cursor: first.nextCursor,
      completeness: "complete",
    });
    expect(idle.events).toEqual([]);
    expect(idle.nextCursor).toBe(first.nextCursor);

    const newer = page({
      channelId: CHANNEL,
      events: [...events, event({ id: "msg-3", createdAt: NOW + 2 })],
      cursor: idle.nextCursor,
      completeness: "complete",
    });
    expect(newer.events.map((row) => row.id)).toEqual(["msg-3"]);
  });
});

describe("stale suffix windows", () => {
  test("fails a cursor from before the retained suffix instead of skipping the hole", () => {
    const cursor = encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: NOW,
      id: "msg-1",
    });
    const retained = [
      event({ id: "msg-5", createdAt: NOW + 40 }),
      event({ id: "msg-6", createdAt: NOW + 50 }),
    ];
    try {
      page({
        channelId: CHANNEL,
        events: retained,
        cursor,
        completeness: "suffix",
      });
      throw new Error("expected a ChannelPollCursorError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ChannelPollCursorError);
      expect((cause as ChannelPollCursorError).reason).toBe("stale");
    }
  });

  test("fails a suffix poll that has a cursor and no retained events", () => {
    const cursor = encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: NOW,
      id: "msg-1",
    });
    expect(() => page({
      channelId: CHANNEL,
      events: [],
      cursor,
      completeness: "suffix",
    })).toThrow(ChannelPollCursorError);
  });

  test("a complete window treats a cursor older than the oldest event as before start", () => {
    const cursor = encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: NOW - 1_000,
      id: "msg-0",
    });
    const result = page({
      channelId: CHANNEL,
      events: [event({ id: "msg-1", createdAt: NOW })],
      cursor,
      completeness: "complete",
    });
    expect(result.events.map((row) => row.id)).toEqual(["msg-1"]);
  });

  test("pages by position when the cursor message itself is gone from a covering suffix", () => {
    const cursor = encodeChannelPollCursor({
      channelId: CHANNEL,
      createdAt: NOW + 20,
      id: "msg-deleted",
    });
    const result = page({
      channelId: CHANNEL,
      events: [
        event({ id: "msg-1", createdAt: NOW }),
        event({ id: "msg-3", createdAt: NOW + 30 }),
      ],
      cursor,
      completeness: "suffix",
    });
    expect(result.events.map((row) => row.id)).toEqual(["msg-3"]);
  });
});

describe("page bounds", () => {
  test("never returns more events than the clamped limit", () => {
    const events = Array.from({ length: MAX_CHANNEL_POLL_LIMIT + 25 }, (_, index) => (
      event({ id: `msg-${String(index).padStart(4, "0")}`, createdAt: NOW + index })
    ));
    const result = page({
      channelId: CHANNEL,
      events,
      limit: 1_000,
      completeness: "complete",
    });
    expect(result.events).toHaveLength(MAX_CHANNEL_POLL_LIMIT);
    expect(result.hasMore).toBe(true);
    expect(result.events[0]?.id).toBe("msg-0000");
    expect(result.events.at(-1)?.id).toBe(`msg-${String(MAX_CHANNEL_POLL_LIMIT - 1).padStart(4, "0")}`);
  });

  test("an omitted limit uses the default, not the maximum", () => {
    const events = Array.from({ length: DEFAULT_CHANNEL_POLL_LIMIT + 10 }, (_, index) => (
      event({ id: `msg-${index}`, createdAt: NOW + index })
    ));
    const result = page({
      channelId: CHANNEL,
      events,
      completeness: "complete",
    });
    expect(result.events).toHaveLength(DEFAULT_CHANNEL_POLL_LIMIT);
    expect(result.hasMore).toBe(true);
  });
});

describe("projection mapping", () => {
  test("pages existing conversationId projection rows without a rename", () => {
    const projected = {
      id: "msg-1",
      conversationId: CHANNEL,
      createdAt: NOW,
      actorId: "actor-1",
      actorName: "Art",
      body: "hello",
      class: "agent",
      metadata: null,
      replyToMessageId: null,
      threadConversationId: null,
    };
    const result = pageChannelPoll({
      channelId: CHANNEL,
      events: [projected],
      completeness: "complete",
    });
    expect(result.events).toEqual([projected]);
    expect(channelPollEventFromProjection(projected)).toEqual({
      id: "msg-1",
      channelId: CHANNEL,
      createdAt: NOW,
      actorId: "actor-1",
      actorName: "Art",
      body: "hello",
      class: "agent",
      metadata: null,
      replyToMessageId: null,
      threadConversationId: null,
    });
  });

  test("rejects an empty channel id rather than paging a mixed window", () => {
    expect(() => page({
      channelId: "  ",
      events: [event({ id: "msg-1" })],
      completeness: "complete",
    })).toThrow(ChannelPollError);
  });
});
