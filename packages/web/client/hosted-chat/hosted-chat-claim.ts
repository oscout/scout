/**
 * Reserving a space name from the signed-out door.
 *
 * The door lets a visitor type the address they want (`<host>/<name>`) before
 * they have an account. Nothing is held while they are away at GitHub: the
 * name rides the sign-in return address as `?claim=<name>`, and on the way
 * back the page asks the Worker to create the space at exactly that slug. The
 * Worker's directory is the only authority on whether it is free; this file
 * only refuses names the Worker would refuse anyway, so the door can say so
 * before the round trip instead of after it.
 */

/**
 * The Worker's reserved first path segments (`apps/hosted-chat/src/paths.ts`,
 * `RESERVED_CHAT_PATHS`). A copy, because the client bundle does not import
 * Worker source; `hosted-chat-claim.test.ts` pins the two together.
 */
export const RESERVED_SPACE_NAMES: ReadonlySet<string> = new Set([
  "api", "auth", "admin", "settings", "login", "logout", "signup", "invite", "join", "health",
  "support", "openscout", "scout", "assets", "images", "fonts", "static", "uploads", "media", "c", "cdn-cgi",
  "privacy", "terms", "legal", "security", "status", "pricing", "docs", "about", "help", "contact", "export", "trust", "dpa",
  "subprocessors", "well-known",
]);

/** `normalizeChatSlug` in `apps/hosted-chat/src/directory.ts`. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export const CLAIM_PARAM = "claim";

export type ClaimCheck =
  | { ok: true; slug: string }
  | { ok: false; reason: "empty" | "short" | "long" | "shape" | "reserved" };

/**
 * What a person typed, folded to the slug it would become: lowercased, spaces
 * and underscores to hyphens. Anything else that is not a slug character is
 * left in place so `checkSpaceName` can say why it is refused rather than
 * silently reserving a different name than the one they typed.
 */
export function foldSpaceName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function checkSpaceName(value: string): ClaimCheck {
  const slug = foldSpaceName(value);
  if (!slug) return { ok: false, reason: "empty" };
  if (slug.length < 3) return { ok: false, reason: "short" };
  if (slug.length > 40) return { ok: false, reason: "long" };
  if (!SLUG.test(slug)) return { ok: false, reason: "shape" };
  if (RESERVED_SPACE_NAMES.has(slug)) return { ok: false, reason: "reserved" };
  return { ok: true, slug };
}

export const CLAIM_REFUSALS: Record<Exclude<ClaimCheck, { ok: true }>["reason"], string> = {
  empty: "Type the name you want.",
  short: "Use at least 3 characters.",
  long: "Use at most 40 characters.",
  shape: "Use letters, numbers and hyphens, starting and ending with a letter or number.",
  reserved: "That name is kept for Scout itself. Choose another.",
};

/** Where sign-in returns a visitor who is reserving `slug`. */
export function claimReturnTo(slug: string): string {
  return `/?${CLAIM_PARAM}=${encodeURIComponent(slug)}`;
}

/** The name a returning visitor asked for, if the address carries a valid one. */
export function claimFromSearch(search: string): string | null {
  const asked = new URLSearchParams(search).get(CLAIM_PARAM);
  if (!asked) return null;
  const check = checkSpaceName(asked);
  return check.ok ? check.slug : null;
}
