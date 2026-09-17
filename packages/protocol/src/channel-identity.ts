import type { MetadataMap, ScoutId } from "./common.js";

export type ConversationIdentityRecord = {
  id: ScoutId;
  kind: string;
  metadata?: MetadataMap;
};

export const CHANNEL_ID_PREFIX = "chn-";
export const CHAT_ID_PREFIX = CHANNEL_ID_PREFIX;
export const LEGACY_CHAT_ID_PREFIX = "chat_";
export const LEGACY_CHANNEL_ID_PREFIX = "c.";
export const CHANNEL_NATURAL_KEY_METADATA = "naturalKey";

export function mintChannelId(randomUuid: () => string): ScoutId {
  return `${CHAT_ID_PREFIX}${randomUuid().toLowerCase().replace(/-/g, "")}`;
}

/**
 * Mint the opaque id for a named/system channel from its canonical identity.
 * Every concurrent creator therefore arrives at the same broker record even
 * when each caller began from a stale snapshot.
 */
export function stableChannelId(naturalKey: string): ScoutId {
  const normalized = naturalKey.trim().toLowerCase();
  const hash = (seed: bigint): string => {
    let value = seed;
    for (let index = 0; index < normalized.length; index += 1) {
      value ^= BigInt(normalized.charCodeAt(index));
      value = BigInt.asUintN(64, value * 0x100000001b3n);
    }
    return value.toString(16).padStart(16, "0");
  };
  return `${CHAT_ID_PREFIX}${hash(0xcbf29ce484222325n)}${hash(0x84222325cbf29ce4n)}`;
}

export function isOpaqueChannelId(value: string | null | undefined): value is ScoutId {
  if (typeof value !== "string") return false;
  return (
    value.startsWith(CHAT_ID_PREFIX) && value.length > CHAT_ID_PREFIX.length
  ) || (
    value.startsWith(LEGACY_CHAT_ID_PREFIX)
    && value.length > LEGACY_CHAT_ID_PREFIX.length
  ) || (
    value.startsWith(LEGACY_CHANNEL_ID_PREFIX)
    && value.length > LEGACY_CHANNEL_ID_PREFIX.length
  );
}

export function directChannelNaturalKey(participantIds: ScoutId[]): string {
  return `direct:${stableIdentityParts(participantIds).join(",")}`;
}

export function namedChannelNaturalKey(channel: string): string {
  return `channel:${encodeIdentityPart(channel.trim().toLowerCase() || "shared")}`;
}

export function systemChannelNaturalKey(name: string): string {
  return `system:${encodeIdentityPart(name.trim().toLowerCase() || "system")}`;
}

/* -- spaces ---------------------------------------------------------------- */

/**
 * The space every channel that predates spaces belongs to.
 *
 * It is not a migration target; it is the name of what already exists. A
 * channel with no space marker *is* a default-space channel, decided at read
 * time by {@link channelSpaceSlug}, so no record is ever rewritten to acquire
 * one.
 */
export const DEFAULT_CHAT_SPACE_SLUG = "home";

/** Metadata key carrying a channel's (or a space record's) space slug. */
export const CHANNEL_SPACE_SLUG_METADATA = "spaceSlug";

/** Natural-key prefix for the conversation record that *is* a space. */
export const SPACE_NATURAL_KEY_PREFIX = "space:";

/**
 * Slugs are the durable half of a space's identity, so they are deliberately
 * boring: lowercase, digits and single-width hyphens, never leading or
 * trailing punctuation. The human-readable half is the conversation `title`,
 * which is free-form and renameable; the slug never changes once minted
 * because it is mixed into every channel id in the space.
 */
const CHAT_SPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isChatSpaceSlug(value: string | null | undefined): value is string {
  return typeof value === "string" && CHAT_SPACE_SLUG_PATTERN.test(value);
}

/**
 * Read a slug from untrusted input, or return `null`.
 *
 * Lowercasing and trimming are accepted because they cannot change which space
 * is meant. Anything else -- a space character, a slash, a percent escape --
 * is refused rather than repaired: silently rewriting `work/secret` into
 * `worksecret` would resolve a request to a space the caller did not name.
 */
export function normalizeChatSpaceSlug(value: string | null | undefined): string | null {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isChatSpaceSlug(candidate) ? candidate : null;
}

/**
 * Derive a slug from a human title, for creation only.
 *
 * This one *does* rewrite, because the title is prose the operator typed and
 * the slug is an identifier we are minting from it. It is never used to
 * interpret a slug that arrived on a request.
 */
export function chatSpaceSlugFromTitle(title: string): string | null {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return isChatSpaceSlug(slug) ? slug : null;
}

/** The natural key of the conversation record that carries a space. */
export function spaceNaturalKey(spaceSlug: string): string {
  return `${SPACE_NATURAL_KEY_PREFIX}${encodeIdentityPart(
    spaceSlug.trim().toLowerCase() || DEFAULT_CHAT_SPACE_SLUG,
  )}`;
}

/**
 * The natural key of a named channel *inside a space*.
 *
 * The default space returns the byte-identical legacy string, which is what
 * keeps every channel that exists today on the exact id it already has:
 * `stableChannelId` is a pure function of this key, so an unchanged key is an
 * unchanged id, an unchanged feed, and unchanged invitations. Nothing is
 * migrated because nothing moves.
 *
 * `/` is the separator because {@link encodeIdentityPart} percent-encodes it,
 * so a channel whose *name* contains a slash encodes to `%2F` and can never be
 * mistaken for the space boundary. A legacy key and a spaced key are therefore
 * distinguishable by inspection, in both directions.
 */
export function spacedChannelNaturalKey(spaceSlug: string, channel: string): string {
  const slug = normalizeChatSpaceSlug(spaceSlug) ?? DEFAULT_CHAT_SPACE_SLUG;
  const name = encodeIdentityPart(channel.trim().toLowerCase() || "shared");
  return slug === DEFAULT_CHAT_SPACE_SLUG
    ? namedChannelNaturalKey(channel)
    : `channel:${slug}/${name}`;
}

/**
 * Which space a conversation belongs to.
 *
 * Read in priority order: the explicit marker, then the natural key, then the
 * default. The fallback is not a guess -- a record with no marker was written
 * before spaces existed, and the default space is precisely the set of things
 * that existed before spaces. That is why this can be derived at read time
 * instead of backfilled.
 */
export function channelSpaceSlug(conversation: ConversationIdentityRecord): string {
  const declared = normalizeChatSpaceSlug(
    conversation.metadata?.[CHANNEL_SPACE_SLUG_METADATA] as string | undefined,
  );
  if (declared) return declared;

  const naturalKey = conversationNaturalKey(conversation);
  return chatSpaceSlugFromNaturalKey(naturalKey) ?? DEFAULT_CHAT_SPACE_SLUG;
}

/**
 * The space named inside a natural key, or `null` when the key names none.
 *
 * `null` is distinct from `"home"`: it means this key carries no space at all
 * (a direct message, a system record, a legacy channel), and the caller
 * decides what that means. Only {@link channelSpaceSlug} turns it into the
 * default.
 */
export function chatSpaceSlugFromNaturalKey(
  naturalKey: string | null | undefined,
): string | null {
  const key = naturalKey?.trim();
  if (!key) return null;
  if (key.startsWith(SPACE_NATURAL_KEY_PREFIX)) {
    return normalizeChatSpaceSlug(
      decodeURIComponent(key.slice(SPACE_NATURAL_KEY_PREFIX.length)),
    );
  }
  if (!key.startsWith("channel:")) return null;
  const rest = key.slice("channel:".length);
  const boundary = rest.indexOf("/");
  // No separator is a legacy key, and a legacy key is a default-space key.
  if (boundary < 0) return DEFAULT_CHAT_SPACE_SLUG;
  return normalizeChatSpaceSlug(rest.slice(0, boundary));
}

/**
 * Whether a conversation record is a space rather than a room.
 *
 * Two independent markers have to agree. `kind: "system"` is what keeps the
 * record out of every conversation list; the natural-key prefix is what says
 * it is a *space* and not some other system record. Requiring both means a
 * future system conversation cannot be mistaken for a space, and a channel
 * cannot be mistaken for one either.
 */
export function isChatSpaceRecord(conversation: ConversationIdentityRecord): boolean {
  if (conversation.kind !== "system") return false;
  const naturalKey = channelNaturalKeyFromMetadata(conversation.metadata);
  return Boolean(naturalKey?.startsWith(SPACE_NATURAL_KEY_PREFIX));
}

export function channelNaturalKeyFromMetadata(
  metadata: MetadataMap | undefined,
): string | null {
  const value = metadata?.[CHANNEL_NATURAL_KEY_METADATA];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read the semantic identity of a conversation, including the structural ids
 * written by Scout versions that predate `metadata.naturalKey`.
 *
 * Structural ids remain read-only compatibility aliases. New writes must use
 * an opaque id and persist the natural key in metadata.
 */
export function conversationNaturalKey(
  conversation: ConversationIdentityRecord,
): string | null {
  const explicit = channelNaturalKeyFromMetadata(conversation.metadata);
  if (explicit) {
    return explicit;
  }

  if (conversation.kind !== "channel" && conversation.kind !== "system") {
    return null;
  }

  const metadataChannel = conversation.metadata?.channel;
  const legacyChannel = conversation.id.startsWith("channel.")
    ? conversation.id.slice("channel.".length)
    : null;
  const channel = typeof metadataChannel === "string" && metadataChannel.trim()
    ? metadataChannel.trim()
    : legacyChannel?.trim() || null;
  if (!channel) {
    return null;
  }

  return conversation.kind === "system"
    ? systemChannelNaturalKey(channel)
    : namedChannelNaturalKey(channel);
}

/**
 * Return every record for one semantic conversation in deterministic priority
 * order: the stable named-channel id, another opaque id, then structural
 * compatibility aliases. This prevents snapshot insertion order from choosing
 * which chat receives a write.
 */
export function conversationsWithNaturalKey<T extends ConversationIdentityRecord>(
  conversations: Iterable<T>,
  naturalKey: string,
): T[] {
  const normalizedNaturalKey = naturalKey.trim();
  const stableId = normalizedNaturalKey.startsWith("channel:")
    || normalizedNaturalKey.startsWith("system:")
    ? stableChannelId(normalizedNaturalKey)
    : null;
  const priority = (conversation: T): number => {
    if (stableId && conversation.id === stableId) return 0;
    if (isOpaqueChannelId(conversation.id)) return 1;
    return 2;
  };

  return [...conversations]
    .filter((conversation) => conversationNaturalKey(conversation) === normalizedNaturalKey)
    .sort((left, right) => priority(left) - priority(right) || left.id.localeCompare(right.id));
}

export function preferredConversationWithNaturalKey<T extends ConversationIdentityRecord>(
  conversations: Iterable<T>,
  naturalKey: string,
): T | undefined {
  return conversationsWithNaturalKey(conversations, naturalKey)[0];
}

function stableIdentityParts(values: ScoutId[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort()
    .map(encodeIdentityPart);
}

function encodeIdentityPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
