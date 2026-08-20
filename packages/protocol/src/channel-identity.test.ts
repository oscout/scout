import { describe, expect, test } from "bun:test";

import {
  CHAT_ID_PREFIX,
  LEGACY_CHAT_ID_PREFIX,
  LEGACY_CHANNEL_ID_PREFIX,
  conversationNaturalKey,
  conversationsWithNaturalKey,
  isOpaqueChannelId,
  mintChannelId,
  namedChannelNaturalKey,
  preferredConversationWithNaturalKey,
  stableChannelId,
} from "./channel-identity";

describe("channel identity", () => {
  test("mints chn-prefixed opaque ids without UUID punctuation", () => {
    const id = mintChannelId(() => "FF3A45D0-76DE-4614-995C-530D455FFC48");

    expect(id).toBe("chn-ff3a45d076de4614995c530d455ffc48");
    expect(id.startsWith(CHAT_ID_PREFIX)).toBe(true);
    expect(isOpaqueChannelId(id)).toBe(true);
  });

  test("mints a stable opaque id from a channel natural key", () => {
    const first = stableChannelId(namedChannelNaturalKey("Engineering-CI"));
    const second = stableChannelId(namedChannelNaturalKey("engineering-ci"));

    expect(first).toBe(second);
    expect(first).toMatch(/^chn-[0-9a-f]{32}$/);
    expect(first).not.toBe(stableChannelId(namedChannelNaturalKey("release")));
  });

  test("accepts legacy chat and c-dot ids while rejecting structural ids", () => {
    expect(isOpaqueChannelId(`${LEGACY_CHAT_ID_PREFIX}ff3a45d076de4614995c530d455ffc48`)).toBe(true);
    expect(isOpaqueChannelId(`${LEGACY_CHANNEL_ID_PREFIX}ff3a45d0-76de-4614-995c-530d455ffc48`)).toBe(true);
    expect(isOpaqueChannelId("dm.operator.agent")).toBe(false);
    expect(isOpaqueChannelId("channel.ops")).toBe(false);
  });

  test("recognizes structural named-channel aliases without natural-key metadata", () => {
    expect(conversationNaturalKey({
      id: "channel.huddle-v1",
      kind: "channel",
      metadata: { channel: "huddle-v1" },
    })).toBe(namedChannelNaturalKey("huddle-v1"));
    expect(conversationNaturalKey({
      id: "channel.huddle-v1",
      kind: "channel",
    })).toBe(namedChannelNaturalKey("huddle-v1"));
  });

  test("prefers the stable opaque record over legacy and random opaque duplicates", () => {
    const naturalKey = namedChannelNaturalKey("huddle-v1");
    const legacy = { id: "channel.huddle-v1", kind: "channel", metadata: { channel: "huddle-v1" } };
    const randomOpaque = { id: "chn-ffffffffffffffffffffffffffffffff", kind: "channel", metadata: { naturalKey } };
    const stable = { id: stableChannelId(naturalKey), kind: "channel", metadata: { naturalKey } };

    expect(conversationsWithNaturalKey([legacy, randomOpaque, stable], naturalKey).map((entry) => entry.id)).toEqual([
      stable.id,
      randomOpaque.id,
      legacy.id,
    ]);
    expect(preferredConversationWithNaturalKey([legacy, stable], naturalKey)?.id).toBe(stable.id);
  });
});
