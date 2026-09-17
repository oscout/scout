import { describe, expect, test } from "bun:test";
import {
  CHANNEL_NATURAL_KEY_METADATA,
  CHANNEL_SPACE_SLUG_METADATA,
  namedChannelNaturalKey,
  spaceNaturalKey,
  spacedChannelNaturalKey,
  stableChannelId,
  type ConversationDefinition,
} from "@openscout/protocol";

import {
  CHAT_SPACE_SURFACE_METADATA,
  CHAT_SPACE_SURFACE_VALUE,
  chatChannelSpaceDecision,
  chatSpaceChannels,
  chatSpaceRosterAddition,
  createChatSpace,
  findChatSpaceRecord,
  listChatSpaces,
  memberVisibleSpaceSlugs,
  resolveChatSpaceSelection,
} from "./chat-spaces.ts";

/** A channel exactly as `ensureChatSpaceChannel` writes one. */
function channel(spaceSlug: string, name: string): ConversationDefinition {
  const naturalKey = spacedChannelNaturalKey(spaceSlug, name);
  return {
    id: stableChannelId(naturalKey),
    kind: "channel",
    title: name,
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-1",
    participantIds: ["operator"],
    metadata: {
      [CHANNEL_NATURAL_KEY_METADATA]: naturalKey,
      [CHANNEL_SPACE_SLUG_METADATA]: spaceSlug,
    },
  } as ConversationDefinition;
}

/** A channel written before spaces existed: no marker, legacy key. */
function legacyChannel(name: string): ConversationDefinition {
  const naturalKey = namedChannelNaturalKey(name);
  return {
    id: stableChannelId(naturalKey),
    kind: "channel",
    title: name,
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-1",
    participantIds: ["operator"],
    metadata: { [CHANNEL_NATURAL_KEY_METADATA]: naturalKey },
  } as ConversationDefinition;
}

function spaceRecord(slug: string, title: string): ConversationDefinition {
  const naturalKey = spaceNaturalKey(slug);
  return {
    id: stableChannelId(naturalKey),
    kind: "system",
    title,
    visibility: "system",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator"],
    metadata: {
      [CHANNEL_NATURAL_KEY_METADATA]: naturalKey,
      [CHANNEL_SPACE_SLUG_METADATA]: slug,
      [CHAT_SPACE_SURFACE_METADATA]: CHAT_SPACE_SURFACE_VALUE,
    },
  } as ConversationDefinition;
}

function snapshot(...records: ConversationDefinition[]): Record<string, ConversationDefinition> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

describe("the space record", () => {
  test("a space is a system conversation keyed by its slug", async () => {
    const written: ConversationDefinition[] = [];
    const outcome = await createChatSpace({
      title: "Work",
      authorityNodeId: "node-1",
      participantIds: ["operator", "operator"],
      conversations: {},
      upsert: async (conversation) => { written.push(conversation); },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.space.slug).toBe("work");
    expect(outcome.space.title).toBe("Work");
    expect(written).toHaveLength(1);
    // `system` is what keeps it out of every conversation list; the natural key
    // is what says it is a space and not some other system record.
    expect(written[0]!.kind).toBe("system");
    expect(written[0]!.metadata?.[CHANNEL_NATURAL_KEY_METADATA]).toBe("space:work");
    expect(written[0]!.metadata?.[CHAT_SPACE_SURFACE_METADATA]).toBe(CHAT_SPACE_SURFACE_VALUE);
    // Two operators racing on the same name converge on one record.
    expect(written[0]!.id).toBe(stableChannelId(spaceNaturalKey("work")));
    expect(written[0]!.participantIds).toEqual(["operator"]);
  });

  test("the default space cannot be re-created, and an unusable name is refused", async () => {
    const refusedDefault = await createChatSpace({
      title: "Home",
      authorityNodeId: "node-1",
      participantIds: ["operator"],
      conversations: {},
      upsert: async () => { throw new Error("must not write"); },
    });
    // `home` already names every channel that predates spaces. Minting a record
    // for it would be a migration with nothing to migrate.
    expect(refusedDefault).toMatchObject({ ok: false, status: 409 });

    const refusedName = await createChatSpace({
      title: "———",
      authorityNodeId: "node-1",
      participantIds: ["operator"],
      conversations: {},
      upsert: async () => { throw new Error("must not write"); },
    });
    expect(refusedName).toMatchObject({ ok: false, status: 400 });
  });

  test("creating a space that exists returns it instead of writing a second one", async () => {
    const existing = spaceRecord("work", "Work");
    const outcome = await createChatSpace({
      title: "Work",
      authorityNodeId: "node-1",
      participantIds: ["operator"],
      conversations: snapshot(existing, channel("work", "general")),
      upsert: async () => { throw new Error("must not write"); },
    });
    expect(outcome).toMatchObject({ ok: true, existed: true });
    if (!outcome.ok) return;
    expect(outcome.space.conversationId).toBe(existing.id);
    expect(outcome.space.channelCount).toBe(1);
  });

  test("a space record is found by slug, and nothing else is mistaken for one", () => {
    const conversations = snapshot(spaceRecord("work", "Work"), channel("work", "general"));
    expect(findChatSpaceRecord(conversations, "work")?.title).toBe("Work");
    expect(findChatSpaceRecord(conversations, "personal")).toBeNull();
    // The default space has no record of its own, and that is not a gap.
    expect(findChatSpaceRecord(conversations, "home")).toBeNull();
  });
});

describe("listing spaces and their rooms", () => {
  const conversations = snapshot(
    legacyChannel("release-train"),
    channel("work", "general"),
    channel("work", "design"),
    channel("personal", "general"),
    spaceRecord("work", "Work"),
    spaceRecord("personal", "Personal"),
  );

  test("the default space is always listed, first, and named Home", () => {
    const spaces = listChatSpaces(conversations);
    expect(spaces.map((space) => space.slug)).toEqual(["home", "personal", "work"]);
    expect(spaces[0]).toMatchObject({
      slug: "home",
      title: "Home",
      conversationId: null,
      isDefault: true,
      channelCount: 1,
    });
    expect(spaces.find((space) => space.slug === "work")?.channelCount).toBe(2);
  });

  test("the same channel name in two spaces is two rooms, not one", () => {
    // The whole boundary rests on this: `#general` in `work` and `#general` in
    // `personal` are different ids, so they are different feeds, different
    // rosters and different invitations all the way down.
    const work = chatSpaceChannels(conversations, "work").map((room) => room.id);
    const personal = chatSpaceChannels(conversations, "personal").map((room) => room.id);
    expect(work).toHaveLength(2);
    expect(personal).toHaveLength(1);
    expect(work).not.toContain(personal[0]!);
  });

  test("a legacy channel is a default-space channel without being rewritten", () => {
    const home = chatSpaceChannels(conversations, "home");
    expect(home.map((room) => room.title)).toEqual(["release-train"]);
    // The id it has is the id it always had.
    expect(home[0]!.id).toBe(stableChannelId(namedChannelNaturalKey("release-train")));
    // And no marker was needed to place it.
    expect(home[0]!.metadata?.[CHANNEL_SPACE_SLUG_METADATA]).toBeUndefined();
  });

  test("a member sees the spaces their own channels put them in, and no others", () => {
    const mine = new Set([channel("work", "design").id]);
    expect([...memberVisibleSpaceSlugs(conversations, mine)]).toEqual(["work"]);

    const spaces = listChatSpaces(conversations, { visibleChannelIds: mine });
    expect(spaces.find((space) => space.slug === "work")?.channelCount).toBe(1);
    // Personal still appears in this raw listing -- the route filters it by
    // `memberVisibleSpaceSlugs` -- but it must carry no count, or the count
    // itself becomes a directory of rooms you are not in.
    expect(spaces.find((space) => space.slug === "personal")?.channelCount).toBe(0);
  });

  test("a channel whose space record has not arrived is still shown", () => {
    // A snapshot read between the two writes, or a peer that forwarded the
    // channel first. Hiding the room behind a missing label is worse than
    // showing it under its slug.
    const partial = snapshot(channel("ops", "incidents"));
    const spaces = listChatSpaces(partial);
    expect(spaces.map((space) => space.slug)).toEqual(["home", "ops"]);
    expect(spaces[1]).toMatchObject({ slug: "ops", title: "ops", conversationId: null });
  });

  test("a record claiming the default slug cannot rename Home out from under it", () => {
    const hostile = {
      ...spaceRecord("work", "Not Home"),
      metadata: {
        [CHANNEL_NATURAL_KEY_METADATA]: "space:home",
        [CHANNEL_SPACE_SLUG_METADATA]: "home",
      },
    } as ConversationDefinition;
    const spaces = listChatSpaces(snapshot(hostile, legacyChannel("release-train")));
    expect(spaces.find((space) => space.slug === "home")?.title).toBe("Home");
  });
});

describe("space membership is derived from channel membership", () => {
  test("a joiner is added to the space roster once", () => {
    const conversations = snapshot(spaceRecord("work", "Work"));
    const first = chatSpaceRosterAddition({ conversations, spaceSlug: "work", actorId: "agent-kepler" });
    expect(first?.participantIds).toEqual(["operator", "agent-kepler"]);

    // Already there: nothing to write, so no broker round trip.
    expect(chatSpaceRosterAddition({
      conversations: snapshot(first!),
      spaceSlug: "work",
      actorId: "agent-kepler",
    })).toBeNull();

    // The default space has no record to write to, and needs none.
    expect(chatSpaceRosterAddition({
      conversations,
      spaceSlug: "home",
      actorId: "agent-kepler",
    })).toBeNull();
  });
});

describe("a space selector can narrow a request or fail it, never widen it", () => {
  test("an explicit slug wins, and a malformed one is refused rather than repaired", () => {
    expect(resolveChatSpaceSelection({ requested: "work", grantSpaceSlug: "personal" }))
      .toEqual({ ok: true, slug: "work", explicit: true });
    // Repairing `work/secret` into `worksecret` would resolve the request to a
    // space the caller did not name.
    expect(resolveChatSpaceSelection({ requested: "work/secret" }))
      .toMatchObject({ ok: false, status: 400 });
    expect(resolveChatSpaceSelection({ requested: "Work Space" }))
      .toMatchObject({ ok: false, status: 400 });
  });

  test("an absent selector resolves to the caller's own space, then to the default", () => {
    // A bearer token handed a bare poll URL must not 404 against `home`.
    expect(resolveChatSpaceSelection({ grantSpaceSlug: "work" }))
      .toEqual({ ok: true, slug: "work", explicit: false });
    // And with no credential at all, the narrowest answer -- never "all spaces".
    expect(resolveChatSpaceSelection({}))
      .toEqual({ ok: true, slug: "home", explicit: false });
    expect(resolveChatSpaceSelection({ requested: "  ", grantSpaceSlug: null }))
      .toEqual({ ok: true, slug: "home", explicit: false });
  });

  test("a channel outside the selected space is not found, not forbidden", () => {
    expect(chatChannelSpaceDecision({
      channelSpaceSlug: "work",
      selectedSpaceSlug: "work",
      grantSpaceSlug: "work",
    })).toBeNull();

    // Selector mismatch: the operator asked for `work` and named a `personal`
    // room by id.
    expect(chatChannelSpaceDecision({
      channelSpaceSlug: "personal",
      selectedSpaceSlug: "work",
      grantSpaceSlug: null,
    })).toEqual({ status: 404, error: "channel not found" });

    // Credential mismatch, with a selector that agrees with the channel. This
    // is the condition that holds when the selector is forged or copied.
    expect(chatChannelSpaceDecision({
      channelSpaceSlug: "personal",
      selectedSpaceSlug: "personal",
      grantSpaceSlug: "work",
    })).toEqual({ status: 404, error: "channel not found" });

    // 404 rather than 403 throughout: a different status for "exists, but not
    // yours" would turn the boundary into a directory of the rooms you are not
    // in.
    expect(chatChannelSpaceDecision({
      channelSpaceSlug: "home",
      selectedSpaceSlug: "home",
      grantSpaceSlug: undefined,
    })).toBeNull();
  });
});
