import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MESSAGE_PAGE_LIMIT,
  MAX_MESSAGE_PAGE_LIMIT,
  MessageCursorError,
  clampMessagePageLimit,
  compareMessageIds,
  compareMessagesAsc,
  encodeMessageHistoryCursor,
  parseMessageHistoryCursor,
} from "../../shared/message-pagination.ts";

/**
 * The reviewer's tie-break fixture: three id families at one timestamp whose
 * relative order differs between SQLite's BINARY collation ("!" 0x21 < "0" 0x30
 * < "_" 0x5F) and ICU locale collation, which sorts punctuation first and puts
 * "_" ahead of everything.
 */
const TIED_IDS = ["msg-_000", "msg-!000", "msg-0000"];

describe("message history total order", () => {
  test("orders tied ids by code point, the way SQLite BINARY does", () => {
    const sorted = [...TIED_IDS].sort(compareMessageIds);
    expect(sorted).toEqual(["msg-!000", "msg-0000", "msg-_000"]);
  });

  test("rejects the locale order that produced the eternal duplicate page", () => {
    const locale = [...TIED_IDS].sort((left, right) => left.localeCompare(right));
    const shared = [...TIED_IDS].sort(compareMessageIds);
    // Pin the disagreement itself: if these ever coincide, this fixture has
    // stopped guarding the defect and needs replacing, not deleting.
    expect(locale).not.toEqual(shared);
    expect(locale[0]).toBe("msg-_000");
    expect(shared[0]).toBe("msg-!000");
  });

  test("sorts by createdAt first and only then by id", () => {
    const ordered = [
      { createdAt: 20, id: "msg-a" },
      { createdAt: 10, id: "msg-z" },
      { createdAt: 10, id: "msg-b" },
    ].sort(compareMessagesAsc);
    expect(ordered.map((entry) => entry.id)).toEqual(["msg-b", "msg-z", "msg-a"]);
  });

  test("keeps surrogate-pair ids above the rest of the BMP, matching UTF-8 bytes", () => {
    expect(compareMessageIds("msg-\u{1F600}", "msg-￿")).toBe(1);
    expect(compareMessageIds("msg-￿", "msg-\u{1F600}")).toBe(-1);
    expect(compareMessageIds("msg-a", "msg-a")).toBe(0);
    expect(compareMessageIds("msg-a", "msg-ab")).toBe(-1);
  });
});

describe("message history cursor", () => {
  test("round-trips a position through encode and parse", () => {
    const encoded = encodeMessageHistoryCursor({ createdAt: 1_783_915_198_766, id: "msg-0450" });
    expect(encoded).toBe("1783915198766|msg-0450");
    expect(parseMessageHistoryCursor(encoded)).toEqual({
      kind: "position",
      createdAt: 1_783_915_198_766,
      id: "msg-0450",
    });
  });

  test("keeps ids that contain the separator intact", () => {
    const encoded = encodeMessageHistoryCursor({ createdAt: 42, id: "msg|with|pipes" });
    expect(parseMessageHistoryCursor(encoded)).toEqual({
      kind: "position",
      createdAt: 42,
      id: "msg|with|pipes",
    });
  });

  test("reads a bare id as a legacy cursor and a blank value as no cursor", () => {
    expect(parseMessageHistoryCursor("msg-0450")).toEqual({ kind: "legacy", id: "msg-0450" });
    expect(parseMessageHistoryCursor("  ")).toBeNull();
    expect(parseMessageHistoryCursor(undefined)).toBeNull();
    expect(parseMessageHistoryCursor(null)).toBeNull();
  });

  test("refuses a malformed cursor instead of reading it as end of history", () => {
    for (const raw of ["abc|msg-1", "|msg-1", "12.5|msg-1", "1783915198766|", "-1|msg-1"]) {
      expect(() => parseMessageHistoryCursor(raw)).toThrow(MessageCursorError);
    }
    try {
      parseMessageHistoryCursor("abc|msg-1");
      throw new Error("expected a MessageCursorError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(MessageCursorError);
      expect((cause as MessageCursorError).reason).toBe("malformed");
    }
  });

  test("normalizes a non-finite createdAt rather than emitting an unparseable cursor", () => {
    const encoded = encodeMessageHistoryCursor({ createdAt: Number.NaN, id: "msg-1" });
    expect(encoded).toBe("0|msg-1");
    expect(parseMessageHistoryCursor(encoded)).toEqual({
      kind: "position",
      createdAt: 0,
      id: "msg-1",
    });
  });
});

describe("message page limit", () => {
  test("caps every source at the same page size", () => {
    expect(clampMessagePageLimit(1_000)).toBe(MAX_MESSAGE_PAGE_LIMIT);
    expect(clampMessagePageLimit(600)).toBe(MAX_MESSAGE_PAGE_LIMIT);
    expect(clampMessagePageLimit(100)).toBe(100);
  });

  test("falls back for a missing or nonsensical limit", () => {
    expect(clampMessagePageLimit(undefined)).toBe(DEFAULT_MESSAGE_PAGE_LIMIT);
    expect(clampMessagePageLimit(0)).toBe(DEFAULT_MESSAGE_PAGE_LIMIT);
    expect(clampMessagePageLimit(-5)).toBe(DEFAULT_MESSAGE_PAGE_LIMIT);
    expect(clampMessagePageLimit(Number.NaN)).toBe(DEFAULT_MESSAGE_PAGE_LIMIT);
    expect(clampMessagePageLimit("300")).toBe(DEFAULT_MESSAGE_PAGE_LIMIT);
    expect(clampMessagePageLimit(undefined, 300)).toBe(300);
  });
});
