/**
 * The address the landing page prints — the room a visitor was heading for,
 * and nothing else.
 *
 * The live location carries more than the room: a native host embedding this
 * page adds presentation parameters (`theme`, `themeVars`, `embed`, `profile`,
 * `_cb`) that the round trip through sign-in needs but a person does not. Only
 * the address grammar survives here; the return-to value the sign-in link
 * carries is a separate string and keeps everything.
 */

import {
  CHANNEL_QUERY_KEY,
  MESSAGE_QUERY_KEY,
  SPACE_QUERY_KEY,
} from "../screens/chat-space/chat-address.ts";

/** Address keys, in the order they are printed. */
const ADDRESS_QUERY_KEYS = [SPACE_QUERY_KEY, CHANNEL_QUERY_KEY, MESSAGE_QUERY_KEY] as const;

/**
 * Front doors, not rooms: an address the page should not promise to return
 * anyone to when nothing narrower is named.
 */
const FRONT_DOORS = new Set(["/", "/chat"]);

export function displayAddress(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  let url: URL;
  try {
    url = /^https?:\/\//i.test(value)
      ? new URL(value)
      : new URL(value, "http://address.invalid");
  } catch {
    return null;
  }
  if (!value.startsWith("/") && !/^https?:\/\//i.test(value)) return null;

  const kept = new URLSearchParams();
  for (const key of ADDRESS_QUERY_KEYS) {
    const entry = url.searchParams.get(key)?.trim();
    if (entry) kept.set(key, entry);
  }

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
  const query = kept.toString();
  if (!query && FRONT_DOORS.has(path)) return null;
  return query ? `${path}?${query}` : path;
}
