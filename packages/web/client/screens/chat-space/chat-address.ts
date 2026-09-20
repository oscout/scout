/**
 * Where the surface keeps "which space, which channel" in the address bar.
 *
 * The shared surface never parses `window.location` itself, because the two
 * deployments do not spell an address the same way. Local Scout writes both
 * selectors into the query string so that every link to a room that predates
 * spaces is exactly the link it has always been. Hosted Chat gives a space its
 * own path — `/c/<slug>` — because the space is the thing an account owns and
 * shares, and a path is what people paste.
 *
 * Both are the same grammar seen through one interface: read what is on screen
 * now, write what should be. Nothing else in `screens/chat-space/` knows the
 * difference.
 */

const CHANNEL_QUERY_KEY = "channel";
const SPACE_QUERY_KEY = "space";
const MESSAGE_QUERY_KEY = "message";

export interface ChatAddressState {
  /**
   * The selected space, or `null` for "whichever one the server answers for".
   * An absent selector is not the same as naming the default: it is a request
   * the server gets to resolve.
   */
  space: string | null;
  channelId: string | null;
  /** A turn in this channel — a root or a thread reply. */
  messageId: string | null;
}

export interface ChatAddress {
  read(): ChatAddressState;
  write(next: ChatAddressState, replace: boolean): void;
}

/**
 * Local Scout: `?space=<slug>&channel=<id>`.
 *
 * The default space is written as an *absent* parameter rather than as
 * `?space=home`, which is what keeps every request this client has ever made
 * byte-identical for the channels that predate spaces — including the ones a
 * member's credential was minted against.
 */
export function createQueryChatAddress(defaultSpace: string): ChatAddress {
  return {
    read() {
      if (typeof window === "undefined") return { space: null, channelId: null, messageId: null };
      const params = new URLSearchParams(window.location.search);
      return {
        space: params.get(SPACE_QUERY_KEY)?.trim() || null,
        channelId: params.get(CHANNEL_QUERY_KEY)?.trim() || null,
        messageId: params.get(MESSAGE_QUERY_KEY)?.trim() || null,
      };
    },
    write(next, replace) {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (next.channelId) url.searchParams.set(CHANNEL_QUERY_KEY, next.channelId);
      else url.searchParams.delete(CHANNEL_QUERY_KEY);
      if (next.space && next.space !== defaultSpace) {
        url.searchParams.set(SPACE_QUERY_KEY, next.space);
      } else {
        url.searchParams.delete(SPACE_QUERY_KEY);
      }
      if (next.messageId) url.searchParams.set(MESSAGE_QUERY_KEY, next.messageId);
      else url.searchParams.delete(MESSAGE_QUERY_KEY);
      const target = `${url.pathname}${url.search}`;
      if (replace) window.history.replaceState(null, "", target);
      else window.history.pushState(null, "", target);
    },
  };
}

/**
 * Hosted Chat: `/c/<slug>?channel=<id>`, with `/` meaning "no space chosen yet".
 *
 * The slug is the shareable half of the address, so it gets the path. The
 * channel stays a query parameter: it is a position inside a space, not a
 * separate thing to link to from outside.
 */
export function createPathChatAddress(prefix = "/c"): ChatAddress {
  const pattern = new RegExp(`^${prefix}/([a-z0-9][a-z0-9-]*)/?$`);
  return {
    read() {
      if (typeof window === "undefined") return { space: null, channelId: null, messageId: null };
      const matched = pattern.exec(window.location.pathname);
      const params = new URLSearchParams(window.location.search);
      return {
        space: matched?.[1] ?? null,
        channelId: params.get(CHANNEL_QUERY_KEY)?.trim() || null,
        messageId: params.get(MESSAGE_QUERY_KEY)?.trim() || null,
      };
    },
    write(next, replace) {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      url.pathname = next.space ? `${prefix}/${encodeURIComponent(next.space)}` : "/";
      if (next.channelId) url.searchParams.set(CHANNEL_QUERY_KEY, next.channelId);
      else url.searchParams.delete(CHANNEL_QUERY_KEY);
      if (next.messageId) url.searchParams.set(MESSAGE_QUERY_KEY, next.messageId);
      else url.searchParams.delete(MESSAGE_QUERY_KEY);
      const target = `${url.pathname}${url.search}`;
      if (replace) window.history.replaceState(null, "", target);
      else window.history.pushState(null, "", target);
    },
  };
}

/** Absolute URL for a turn, keeping the current origin and address spelling. */
export function chatMessageHref(
  href: string,
  input: { channelId: string; messageId: string; space?: string | null; defaultSpace?: string },
): string {
  const url = new URL(href);
  url.searchParams.set(CHANNEL_QUERY_KEY, input.channelId);
  url.searchParams.set(MESSAGE_QUERY_KEY, input.messageId);
  if (input.space && input.space !== (input.defaultSpace ?? "home")) {
    url.searchParams.set(SPACE_QUERY_KEY, input.space);
  }
  return url.toString();
}
