/**
 * The chat-history paging contract: one total order over a transcript, the
 * cursor that names a position in that order, and the page bound every source
 * honours.
 *
 * Three implementations page the same transcript and must agree exactly: the
 * SQLite projection (`server/db/messages.ts`), the broker-snapshot projection
 * (`server/core/conversations/service.ts`), and the client cache
 * (`client/lib/chat-cache.ts`). When they disagree about tie-breaks, one side
 * hands the other a cursor it reads differently and the reply is a page of rows
 * the client already has: dedupe absorbs it, the cursor never advances, and the
 * history behind it is unreachable forever. So the order is defined once, here.
 *
 * Order: ascending `(createdAt, id)`. Ids are compared by code point, which is
 * the same order as SQLite's default BINARY (UTF-8 byte) collation on
 * `messages.id`. `localeCompare` must never appear on this path — it is
 * locale-dependent and disagrees with SQLite on punctuation-leading ids.
 *
 * Cursor: `<createdAtMs>|<id>`, e.g. `1783915198766|msg-0450`. It carries the
 * position itself rather than a name to look up, so paging continues correctly
 * even when the anchor message is deleted between pages. A bare id with no
 * separator is accepted as a legacy cursor and resolved by lookup; when that
 * lookup fails the reader is told so (`MessageCursorError`) instead of being
 * handed an empty page that is indistinguishable from end-of-history.
 */

export const MAX_MESSAGE_PAGE_LIMIT = 500;
export const DEFAULT_MESSAGE_PAGE_LIMIT = 80;

const CURSOR_SEPARATOR = "|";

export type MessageOrderKey = {
  createdAt: number;
  id: string;
};

/** Position in the transcript, either carried by the cursor or looked up. */
export type MessageHistoryCursor =
  | { kind: "position"; createdAt: number; id: string }
  | { kind: "legacy"; id: string };

export type MessageCursorFailure = "malformed" | "unknown";

/// A cursor the reader cannot honour. Callers on the HTTP edge turn this into a
/// 400 so a bad cursor is never mistaken for "no older messages".
export class MessageCursorError extends Error {
  readonly reason: MessageCursorFailure;
  readonly cursor: string;

  constructor(reason: MessageCursorFailure, cursor: string) {
    super(
      reason === "malformed"
        ? `beforeMessageId is not a valid history cursor: ${cursor}`
        : `beforeMessageId names a message that is no longer present: ${cursor}`,
    );
    this.name = "MessageCursorError";
    this.reason = reason;
    this.cursor = cursor;
  }
}

/// UTF-16 code units sort surrogates (U+D800-U+DFFF) below U+E000-U+FFFF, while
/// code points — and therefore UTF-8 bytes, and therefore SQLite BINARY — sort
/// them above. Remapping each unit into a gap-free key restores code-point
/// order without allocating.
function codePointOrderKey(unit: number): number {
  if (unit < 0xd800) return unit;
  if (unit < 0xe000) return unit + 0x2000;
  return unit - 0x800;
}

export function compareMessageIds(left: string, right: string): number {
  if (left === right) return 0;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit === rightUnit) continue;
    return codePointOrderKey(leftUnit) < codePointOrderKey(rightUnit) ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function orderedTimestamp(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/// The one total order. Oldest first; ties broken by id in SQLite BINARY order.
export function compareMessagesAsc(left: MessageOrderKey, right: MessageOrderKey): number {
  const leftCreatedAt = orderedTimestamp(left.createdAt);
  const rightCreatedAt = orderedTimestamp(right.createdAt);
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt < rightCreatedAt ? -1 : 1;
  return compareMessageIds(left.id, right.id);
}

export function encodeMessageHistoryCursor(message: MessageOrderKey): string {
  const createdAt = Number.isFinite(message.createdAt)
    ? Math.max(0, Math.trunc(message.createdAt))
    : 0;
  return `${createdAt}${CURSOR_SEPARATOR}${message.id}`;
}

/// `null` means "no cursor requested" (newest page). Throws `MessageCursorError`
/// for a cursor that carries a separator but cannot be read as a position —
/// silently treating that as end-of-history is how history gets stranded.
export function parseMessageHistoryCursor(
  raw: string | null | undefined,
): MessageHistoryCursor | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex < 0) return { kind: "legacy", id: trimmed };

  const createdAtText = trimmed.slice(0, separatorIndex);
  // Ids may themselves contain a separator; only the first one delimits.
  const id = trimmed.slice(separatorIndex + CURSOR_SEPARATOR.length);
  if (!/^\d{1,15}$/u.test(createdAtText) || id.length === 0) {
    throw new MessageCursorError("malformed", trimmed);
  }
  const createdAt = Number.parseInt(createdAtText, 10);
  if (!Number.isSafeInteger(createdAt)) {
    throw new MessageCursorError("malformed", trimmed);
  }
  return { kind: "position", createdAt, id };
}

/// Every source clamps identically, so a caller cannot pick a bigger page by
/// picking a different backing store.
export function clampMessagePageLimit(
  limit: unknown,
  fallback: number = DEFAULT_MESSAGE_PAGE_LIMIT,
): number {
  const requested = typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : Math.floor(fallback);
  return Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.max(1, requested));
}
