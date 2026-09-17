import { describe, expect, test } from "bun:test";

import {
  CHAT_ID_PREFIX,
  DEFAULT_CHAT_SPACE_SLUG,
  LEGACY_CHAT_ID_PREFIX,
  LEGACY_CHANNEL_ID_PREFIX,
  channelSpaceSlug,
  chatSpaceSlugFromTitle,
  conversationNaturalKey,
  conversationsWithNaturalKey,
  isChatSpaceRecord,
  isOpaqueChannelId,
  mintChannelId,
  namedChannelNaturalKey,
  normalizeChatSpaceSlug,
  preferredConversationWithNaturalKey,
  spaceNaturalKey,
  spacedChannelNaturalKey,
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

describe("chat spaces", () => {
  // T1. The no-migration promise, asserted as bytes rather than as intent: the
  // default space must produce the *exact* string today's code produces, or
  // every channel that exists re-mints to a new id and loses its feed.
  test("the default space is byte-identical to the legacy key", () => {
    for (const name of ["general", "Release-Train", "  spaced  ", "", "a/b", "ops@2"]) {
      expect(spacedChannelNaturalKey(DEFAULT_CHAT_SPACE_SLUG, name))
        .toBe(namedChannelNaturalKey(name));
      expect(stableChannelId(spacedChannelNaturalKey(DEFAULT_CHAT_SPACE_SLUG, name)))
        .toBe(stableChannelId(namedChannelNaturalKey(name)));
    }
  });

  // T2. Two spaces each holding `#general` must be two records, not one. This
  // is the constraint the projection store enforces by grouping on the natural
  // key, so distinct keys here are what keep the two feeds apart downstream.
  test("the same channel name in two spaces is two identities", () => {
    const work = spacedChannelNaturalKey("work", "general");
    const personal = spacedChannelNaturalKey("personal", "general");
    const legacy = namedChannelNaturalKey("general");

    expect(work).toBe("channel:work/general");
    expect(personal).toBe("channel:personal/general");
    expect(new Set([work, personal, legacy]).size).toBe(3);
    expect(new Set([work, personal, legacy].map(stableChannelId)).size).toBe(3);
  });

  // A channel name containing a slash must not be able to forge a space
  // boundary. `encodeIdentityPart` percent-encodes it, so `work/secret` as a
  // *name* stays inside whatever space it was created in.
  test("a slash in a channel name cannot forge a space boundary", () => {
    expect(spacedChannelNaturalKey(DEFAULT_CHAT_SPACE_SLUG, "work/secret"))
      .toBe("channel:work%2Fsecret");
    expect(channelSpaceSlug({
      id: "chn-1",
      kind: "channel",
      metadata: { naturalKey: "channel:work%2Fsecret" },
    })).toBe(DEFAULT_CHAT_SPACE_SLUG);
  });

  // T3. A record written before spaces existed resolves to the default space
  // by derivation, never by backfill.
  test("a legacy channel with no marker reads as the default space", () => {
    expect(channelSpaceSlug({
      id: "chn-1",
      kind: "channel",
      metadata: { naturalKey: namedChannelNaturalKey("general") },
    })).toBe(DEFAULT_CHAT_SPACE_SLUG);
    // No metadata at all, only the structural alias.
    expect(channelSpaceSlug({ id: "channel.general", kind: "channel" }))
      .toBe(DEFAULT_CHAT_SPACE_SLUG);
    // Nothing identifiable whatsoever still resolves, and resolves to home.
    expect(channelSpaceSlug({ id: "chn-2", kind: "channel" })).toBe(DEFAULT_CHAT_SPACE_SLUG);
  });

  test("an explicit marker wins over the natural key", () => {
    expect(channelSpaceSlug({
      id: "chn-3",
      kind: "channel",
      metadata: { naturalKey: "channel:work/general", spaceSlug: "work" },
    })).toBe("work");
    // Derivable without the marker too, so a record written by an older writer
    // that minted the spaced key still lands in the right space.
    expect(channelSpaceSlug({
      id: "chn-3",
      kind: "channel",
      metadata: { naturalKey: "channel:work/general" },
    })).toBe("work");
  });

  test("slugs are read strictly and minted leniently", () => {
    expect(normalizeChatSpaceSlug(" Work ")).toBe("work");
    expect(normalizeChatSpaceSlug("work-2")).toBe("work-2");
    // Refused rather than repaired: a rewritten slug resolves to a space the
    // caller did not name.
    expect(normalizeChatSpaceSlug("work/secret")).toBeNull();
    expect(normalizeChatSpaceSlug("work space")).toBeNull();
    expect(normalizeChatSpaceSlug("-work")).toBeNull();
    expect(normalizeChatSpaceSlug("work-")).toBeNull();
    expect(normalizeChatSpaceSlug("")).toBeNull();
    expect(normalizeChatSpaceSlug("w".repeat(33))).toBeNull();

    // Minting from a title is the one place rewriting is correct.
    expect(chatSpaceSlugFromTitle("Work")).toBe("work");
    expect(chatSpaceSlugFromTitle("Art's Personal Room")).toBe("art-s-personal-room");
    expect(chatSpaceSlugFromTitle("  ")).toBeNull();
    expect(chatSpaceSlugFromTitle("!!!")).toBeNull();
  });

  test("a space record is recognized only when both markers agree", () => {
    const record = {
      id: stableChannelId(spaceNaturalKey("work")),
      kind: "system",
      metadata: { naturalKey: spaceNaturalKey("work"), spaceSlug: "work" },
    };
    expect(spaceNaturalKey("work")).toBe("space:work");
    expect(isChatSpaceRecord(record)).toBe(true);
    expect(channelSpaceSlug(record)).toBe("work");

    // A channel is not a space, and neither is some other system record.
    expect(isChatSpaceRecord({
      id: "chn-4",
      kind: "channel",
      metadata: { naturalKey: "channel:work/general" },
    })).toBe(false);
    expect(isChatSpaceRecord({
      id: "chn-5",
      kind: "system",
      metadata: { naturalKey: "system:announcements" },
    })).toBe(false);
  });

  test("space records converge on one id for one slug", () => {
    expect(stableChannelId(spaceNaturalKey("work")))
      .toBe(stableChannelId(spaceNaturalKey("Work")));
    expect(stableChannelId(spaceNaturalKey("work")))
      .not.toBe(stableChannelId(spaceNaturalKey("personal")));
  });
});
