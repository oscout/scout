import { describe, expect, test } from "bun:test";

import { chatMessageHref } from "./chat-address.ts";

describe("chatMessageHref", () => {
  test("pins channel and message on the local query address", () => {
    expect(
      chatMessageHref("http://chat.scout.local/chat?channel=chn-old", {
        channelId: "chn-1",
        messageId: "m-42",
      }),
    ).toBe("http://chat.scout.local/chat?channel=chn-1&message=m-42");
  });

  test("keeps a non-default space", () => {
    expect(
      chatMessageHref("http://chat.scout.local/chat", {
        channelId: "chn-1",
        messageId: "m-9",
        space: "work",
      }),
    ).toBe("http://chat.scout.local/chat?channel=chn-1&message=m-9&space=work");
  });
});
