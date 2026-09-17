/**
 * Chat spaces: named, independent room-sets that contain channels.
 *
 * A space is stored as a broker conversation with `kind: "system"`, so it is
 * canonical, durable, journaled and renameable through the routes that already
 * exist -- and invisible to every surface that lists conversations, because all
 * three of them (the SQLite projection, `/api/conversations`, and the mobile
 * bridge) filter `system` out before rendering. No new broker table, no new
 * broker route, no snapshot field.
 *
 * The important property is that a space is *not* what separates two channels.
 * The natural key is: `spacedChannelNaturalKey` puts the slug inside the key,
 * so two spaces holding `#general` are two records with two ids and two feeds
 * all the way down to the projection store. This module only reads and writes
 * the record that names the space; it is never the thing keeping the rooms
 * apart.
 *
 * Everything here is a pure function of a broker snapshot plus one writer, so
 * the resolution rules are testable without a broker.
 */

import {
  CHANNEL_NATURAL_KEY_METADATA,
  CHANNEL_SPACE_SLUG_METADATA,
  DEFAULT_CHAT_SPACE_SLUG,
  channelSpaceSlug,
  chatSpaceSlugFromTitle,
  isChatSpaceRecord,
  normalizeChatSpaceSlug,
  spaceNaturalKey,
  stableChannelId,
  type ConversationDefinition,
} from "@openscout/protocol";

/**
 * Marker for a conversation this surface owns.
 *
 * Belt to the `kind: "system"` braces. Every read site that hides spaces today
 * hides them by kind, which is enough -- but a future system conversation that
 * some surface decides to render would drag spaces onto the screen with it,
 * and this is the field that read site can filter on instead.
 */
export const CHAT_SPACE_SURFACE_METADATA = "surface";
export const CHAT_SPACE_SURFACE_VALUE = "chat-space";

/** The title shown for the default space, which has no record of its own. */
export const DEFAULT_CHAT_SPACE_TITLE = "Home";

export interface ChatSpaceView {
  slug: string;
  title: string;
  /** The space record's conversation id, or null for the derived default. */
  conversationId: string | null;
  /** True for the space every pre-space channel already lives in. */
  isDefault: boolean;
  channelCount: number;
}

type ConversationMap = Record<string, ConversationDefinition | undefined>;

function conversationValues(conversations: ConversationMap | undefined): ConversationDefinition[] {
  return Object.values(conversations ?? {}).filter(
    (candidate): candidate is ConversationDefinition => Boolean(candidate),
  );
}

/**
 * The conversation record for one space, if it has been created.
 *
 * The default space deliberately has none: it is the set of channels that
 * predate spaces, and minting a record for it would be a migration with
 * nothing to migrate. `null` here means "the default space", not "missing".
 */
export function findChatSpaceRecord(
  conversations: ConversationMap | undefined,
  slug: string,
): ConversationDefinition | null {
  const normalized = normalizeChatSpaceSlug(slug);
  if (!normalized) return null;
  const expectedId = stableChannelId(spaceNaturalKey(normalized));
  const direct = conversations?.[expectedId];
  if (direct && isChatSpaceRecord(direct)) return direct;
  // A record minted before the stable id converged -- or by another node --
  // still counts. Identity is the natural key; the id is derived from it.
  return conversationValues(conversations).find(
    (candidate) => isChatSpaceRecord(candidate) && channelSpaceSlug(candidate) === normalized,
  ) ?? null;
}

/**
 * Every space on this node, default first.
 *
 * The default space is always listed even when no record names it, because its
 * channels are always there. Listing it conditionally would make Home appear
 * and disappear as the last channel in it was created or renamed.
 */
export function listChatSpaces(
  conversations: ConversationMap | undefined,
  options: { visibleChannelIds?: ReadonlySet<string> | null } = {},
): ChatSpaceView[] {
  const all = conversationValues(conversations);
  const visible = options.visibleChannelIds ?? null;

  const channelCounts = new Map<string, number>();
  for (const conversation of all) {
    if (conversation.kind !== "channel") continue;
    if (visible && !visible.has(conversation.id)) continue;
    const slug = channelSpaceSlug(conversation);
    channelCounts.set(slug, (channelCounts.get(slug) ?? 0) + 1);
  }

  const views = new Map<string, ChatSpaceView>();
  views.set(DEFAULT_CHAT_SPACE_SLUG, {
    slug: DEFAULT_CHAT_SPACE_SLUG,
    title: DEFAULT_CHAT_SPACE_TITLE,
    conversationId: null,
    isDefault: true,
    channelCount: channelCounts.get(DEFAULT_CHAT_SPACE_SLUG) ?? 0,
  });

  for (const conversation of all) {
    if (!isChatSpaceRecord(conversation)) continue;
    const slug = channelSpaceSlug(conversation);
    if (slug === DEFAULT_CHAT_SPACE_SLUG) {
      // A record claiming the default slug does not get to rename Home out
      // from under the channels that were there before it.
      continue;
    }
    views.set(slug, {
      slug,
      title: conversation.title.trim() || slug,
      conversationId: conversation.id,
      isDefault: false,
      channelCount: channelCounts.get(slug) ?? 0,
    });
  }

  // A channel can name a space whose record has not arrived yet -- a snapshot
  // read between the two writes, or a peer that forwarded the channel first.
  // Showing the room is better than hiding it behind a missing label.
  for (const slug of channelCounts.keys()) {
    if (views.has(slug)) continue;
    views.set(slug, {
      slug,
      title: slug,
      conversationId: null,
      isDefault: false,
      channelCount: channelCounts.get(slug) ?? 0,
    });
  }

  return [...views.values()].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return left.title.localeCompare(right.title);
  });
}

/** The channels of one space, out of a snapshot's conversations. */
export function chatSpaceChannels(
  conversations: ConversationMap | undefined,
  slug: string,
): ConversationDefinition[] {
  const normalized = normalizeChatSpaceSlug(slug) ?? DEFAULT_CHAT_SPACE_SLUG;
  return conversationValues(conversations)
    .filter((conversation) => conversation.kind === "channel")
    .filter((conversation) => channelSpaceSlug(conversation) === normalized);
}

/**
 * Which spaces a member can see at all.
 *
 * Derived from the channels they are actually in, never from a request. A
 * member with one channel sees one space; they cannot enumerate the others and
 * cannot learn that they exist.
 */
export function memberVisibleSpaceSlugs(
  conversations: ConversationMap | undefined,
  channelIds: Iterable<string>,
): Set<string> {
  const slugs = new Set<string>();
  for (const channelId of channelIds) {
    const conversation = conversations?.[channelId];
    if (!conversation || conversation.kind !== "channel") continue;
    slugs.add(channelSpaceSlug(conversation));
  }
  return slugs;
}

export type ChatSpaceCreateOutcome =
  | { ok: true; space: ChatSpaceView; conversation: ConversationDefinition | null; existed: boolean }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Create a space, or return the one that already carries this slug.
 *
 * The id is minted from the slug, so two operators racing on the same name
 * converge on one record exactly as named channels already do. The slug is
 * derived from the title once and then immutable: it is mixed into every
 * channel id in the space, so changing it would orphan every room. The title
 * is the part that renames.
 */
export async function createChatSpace(input: {
  title: string;
  slug?: string | null;
  authorityNodeId: string;
  participantIds: string[];
  conversations: ConversationMap | undefined;
  upsert: (conversation: ConversationDefinition) => Promise<unknown>;
}): Promise<ChatSpaceCreateOutcome> {
  const title = input.title.trim();
  if (!title) return { ok: false, status: 400, error: "A space needs a name." };

  const requested = input.slug?.trim() ? normalizeChatSpaceSlug(input.slug) : chatSpaceSlugFromTitle(title);
  if (!requested) {
    return {
      ok: false,
      status: 400,
      error: "That name has no usable slug. Use letters or numbers.",
    };
  }
  if (requested === DEFAULT_CHAT_SPACE_SLUG) {
    return {
      ok: false,
      status: 409,
      error: `"${DEFAULT_CHAT_SPACE_SLUG}" is the space your existing channels are already in.`,
    };
  }

  const existing = findChatSpaceRecord(input.conversations, requested);
  if (existing) {
    return {
      ok: true,
      existed: true,
      conversation: existing,
      space: {
        slug: requested,
        title: existing.title.trim() || requested,
        conversationId: existing.id,
        isDefault: false,
        channelCount: chatSpaceChannels(input.conversations, requested).length,
      },
    };
  }

  const naturalKey = spaceNaturalKey(requested);
  const conversation: ConversationDefinition = {
    id: stableChannelId(naturalKey),
    kind: "system",
    title,
    // `system` on both axes: the record is infrastructure for this surface, not
    // a room anybody is in, and the visibility scope says so to every reader
    // that asks the snapshot rather than this module.
    visibility: "system",
    shareMode: "local",
    authorityNodeId: input.authorityNodeId,
    participantIds: [...new Set(input.participantIds)],
    metadata: {
      [CHANNEL_NATURAL_KEY_METADATA]: naturalKey,
      [CHANNEL_SPACE_SLUG_METADATA]: requested,
      [CHAT_SPACE_SURFACE_METADATA]: CHAT_SPACE_SURFACE_VALUE,
    },
  };

  await input.upsert(conversation);

  return {
    ok: true,
    existed: false,
    conversation,
    space: {
      slug: requested,
      title,
      conversationId: conversation.id,
      isDefault: false,
      channelCount: 0,
    },
  };
}

/**
 * Add an actor to a space's roster.
 *
 * Space membership is derived rather than invited: redeeming an invitation
 * into a channel puts you in that channel's space. Returns `null` when there
 * is nothing to write -- the default space has no record, and an actor already
 * on the roster is not a change worth a broker round trip.
 */
export function chatSpaceRosterAddition(input: {
  conversations: ConversationMap | undefined;
  spaceSlug: string;
  actorId: string;
}): ConversationDefinition | null {
  const slug = normalizeChatSpaceSlug(input.spaceSlug);
  if (!slug || slug === DEFAULT_CHAT_SPACE_SLUG) return null;
  const record = findChatSpaceRecord(input.conversations, slug);
  if (!record) return null;
  const actorId = input.actorId.trim();
  if (!actorId || record.participantIds.includes(actorId)) return null;
  return { ...record, participantIds: [...record.participantIds, actorId] };
}

/* -- which space a request is about ---------------------------------------- */

/**
 * The header and query parameter that *select* a space.
 *
 * Selectors, never authorization. Neither one can widen what a request may
 * reach: the credential decides that, and the selector can only narrow it to
 * one space or fail. A request that names a space it has no claim on gets the
 * same 404 an unknown channel gets, so the selector cannot be used as an
 * oracle either.
 */
export const CHAT_SPACE_HEADER = "x-scout-space";
export const CHAT_SPACE_QUERY_KEY = "space";

export type ChatSpaceSelection =
  | { ok: true; slug: string; explicit: boolean }
  | { ok: false; status: 400; error: string };

/**
 * Decide which space a request is about.
 *
 * Three sources in priority order, and the order is the whole design:
 *
 *  1. What the caller explicitly named. A malformed slug is refused rather
 *     than repaired -- falling back to the default on a typo would quietly
 *     serve the wrong room and call it success.
 *  2. The space the caller's credential is already bound to. This is not the
 *     credential granting itself a space: it already holds the channel, and
 *     using its own space as the default is what keeps a bearer token that was
 *     handed a bare poll URL from 404ing against the default space.
 *  3. The default space, which is exactly the set of channels that existed
 *     before spaces did. Defaulting to *the narrowest* answer rather than to
 *     "all spaces" is what makes an absent selector safe.
 */
export function resolveChatSpaceSelection(input: {
  requested?: string | null;
  grantSpaceSlug?: string | null;
}): ChatSpaceSelection {
  const raw = input.requested?.trim();
  if (raw) {
    const slug = normalizeChatSpaceSlug(raw);
    if (!slug) {
      return { ok: false, status: 400, error: "That is not a valid space name." };
    }
    return { ok: true, slug, explicit: true };
  }
  const granted = normalizeChatSpaceSlug(input.grantSpaceSlug);
  if (granted) return { ok: true, slug: granted, explicit: false };
  return { ok: true, slug: DEFAULT_CHAT_SPACE_SLUG, explicit: false };
}

/**
 * Whether this request may act on a channel in this space.
 *
 * Two independent conditions, and both are refusals rather than filters:
 *
 *  - the selected space must be the channel's space, which is what makes a
 *    channel in another space unreachable *by id* even when the client
 *    hand-crafts the request; and
 *  - a member credential bound to one space may never act on a channel in
 *    another, whatever the request selected. This is the condition that holds
 *    when the selector is absent, forged, or copied from somewhere else.
 *
 * Both answer 404, the same shape an unknown channel gets. A different status
 * for "exists, but not yours" would turn this into a directory of the spaces
 * you are not in.
 */
export function chatChannelSpaceDecision(input: {
  channelSpaceSlug: string;
  selectedSpaceSlug: string;
  grantSpaceSlug?: string | null;
}): { status: 404; error: string } | null {
  const denied = { status: 404 as const, error: "channel not found" };
  if (input.channelSpaceSlug !== input.selectedSpaceSlug) return denied;
  const granted = normalizeChatSpaceSlug(input.grantSpaceSlug) ?? DEFAULT_CHAT_SPACE_SLUG;
  if (input.grantSpaceSlug !== undefined && input.grantSpaceSlug !== null
    && granted !== input.channelSpaceSlug) {
    return denied;
  }
  return null;
}
