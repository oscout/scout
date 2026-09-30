/**
 * Shareable conversation-message links.
 *
 * Message ids already look like `msg-…`. Older copy-link / DOM code prefixed
 * another `msg-`, which produced `#msg-msg-…` anchors and `/embed/thread?…`
 * URLs when the thread was open inside the native host. Permalinks must:
 *   1. use a clean product path (`/c/{conversationId}`), never `/embed/…`
 *   2. use the message id once as the hash (`#msg-…`)
 */

const EMBED_QUERY_KEYS = [
  "embed",
  "profile",
  "theme",
  "themeVars",
  "treatment",
  "_nav",
] as const;

/** Hash / DOM id for a message. Accepts bare ids too. */
export function messagePermalinkAnchor(messageId: string): string {
  const id = messageId.trim();
  if (!id) return "";
  return id.startsWith("msg-") ? id : `msg-${id}`;
}

/**
 * Parse `#msg-…` into the message id. Accepts legacy doubled `#msg-msg-…`
 * hashes produced by older copy-link code.
 */
export function messageIdFromPermalinkHash(
  hash: string | null | undefined,
): string | null {
  const raw = hash?.trim().replace(/^#/, "") ?? "";
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  while (id.startsWith("msg-msg-")) {
    id = id.slice("msg-".length);
  }
  if (!id.startsWith("msg-")) return null;
  return id;
}

/**
 * Absolute shareable URL for a conversation message.
 * Never copies the current embed location (themeVars / profile / treatment).
 */
export function conversationMessagePermalink(input: {
  origin: string;
  conversationId: string;
  messageId: string;
  /** Product path; defaults to `/c/{conversationId}`. */
  path?: string;
}): string {
  const path = input.path
    ?? `/c/${encodeURIComponent(input.conversationId)}`;
  const url = new URL(path, input.origin);
  for (const key of EMBED_QUERY_KEYS) {
    url.searchParams.delete(key);
  }
  const anchor = messagePermalinkAnchor(input.messageId);
  url.hash = anchor;
  return url.toString();
}
