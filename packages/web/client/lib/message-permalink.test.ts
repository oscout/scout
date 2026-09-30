import { describe, expect, test } from "bun:test";

import {
  conversationMessagePermalink,
  messageIdFromPermalinkHash,
  messagePermalinkAnchor,
} from "./message-permalink.ts";

describe("messagePermalinkAnchor", () => {
  test("keeps an id that already starts with msg-", () => {
    expect(messagePermalinkAnchor("msg-muijcr9p-f1ks07")).toBe(
      "msg-muijcr9p-f1ks07",
    );
  });

  test("prefixes bare ids once", () => {
    expect(messagePermalinkAnchor("ask")).toBe("msg-ask");
  });
});

describe("messageIdFromPermalinkHash", () => {
  test("accepts a single-prefix hash", () => {
    expect(messageIdFromPermalinkHash("#msg-muijcr9p-f1ks07")).toBe(
      "msg-muijcr9p-f1ks07",
    );
  });

  test("collapses legacy doubled msg- prefixes", () => {
    expect(messageIdFromPermalinkHash("#msg-msg-muijcr9p-f1ks07")).toBe(
      "msg-muijcr9p-f1ks07",
    );
  });

  test("rejects non-message hashes", () => {
    expect(messageIdFromPermalinkHash("#section")).toBeNull();
    expect(messageIdFromPermalinkHash("")).toBeNull();
  });
});

describe("conversationMessagePermalink", () => {
  test("builds a clean /c/ URL with a single msg hash", () => {
    expect(
      conversationMessagePermalink({
        origin: "http://127.0.0.1:43120",
        conversationId: "chn-7c429c1ca7e942cf919e8bb3e6f5b0e2",
        messageId: "msg-muijcr9p-f1ks07",
      }),
    ).toBe(
      "http://127.0.0.1:43120/c/chn-7c429c1ca7e942cf919e8bb3e6f5b0e2#msg-muijcr9p-f1ks07",
    );
  });

  test("strips embed chrome query params from a supplied path", () => {
    expect(
      conversationMessagePermalink({
        origin: "http://127.0.0.1:43120",
        conversationId: "chn-1",
        messageId: "msg-1",
        path:
          "/embed/thread?theme=dark&themeVars=x&embed=app&profile=macos.thread&conversationId=chn-1&treatment=ledger",
      }),
    ).toBe(
      "http://127.0.0.1:43120/embed/thread?conversationId=chn-1#msg-1",
    );
  });

  test("preferred callers pass a product path so embed never remains", () => {
    expect(
      conversationMessagePermalink({
        origin: "http://127.0.0.1:43120",
        conversationId: "chn-1",
        messageId: "msg-1",
        path: "/c/chn-1",
      }),
    ).toBe("http://127.0.0.1:43120/c/chn-1#msg-1");
  });
});
