/**
 * Bounded forward pagination over a channel's message events.
 *
 * Routes load a window of already-projected messages and call `pageChannelPoll`.
 * This module does not read the broker, SQLite, or HTTP. It does not launch
 * work. A poll page is a read of what the caller supplied.
 *
 * Order is the same total order as chat-history paging: ascending
 * `(createdAt, id)` with code-point id ties (`compareMessagesAsc`). A page
 * that used locale order would mint a cursor the next poll read differently
 * and skip or repeat equal-timestamp events forever.
 *
 * The cursor is opaque, versioned, and bound to one channel. A history cursor
 * (`<createdAt>|<id>`) is malformed here on purpose: it has no channel and no
 * version, so it cannot be honoured safely.
 *
 * Completeness is a caller assertion, not something this module can prove.
 * `suffix` means the oldest supplied event is the earliest retained position;
 * a cursor from before that window is stale rather than a silent skip.
 * `complete` means the array is the full set this poll is defined over, so a
 * cursor older than the oldest event is "before start" rather than a hole.
 * Interior gaps in the array cannot be detected and will be skipped.
 */

import { compareMessagesAsc } from "../../../shared/message-pagination.ts";

export const CHANNEL_POLL_CURSOR_PREFIX = "chpoll.v1.";
export const DEFAULT_CHANNEL_POLL_LIMIT = 50;
export const MAX_CHANNEL_POLL_LIMIT = 100;
export const CHANNEL_POLL_INTERVAL_CATCH_UP_MS = 250;
export const CHANNEL_POLL_INTERVAL_CAUGHT_UP_MS = 2000;

export type ChannelPollCompleteness = "complete" | "suffix";

export type ChannelPollCursorFailure = "malformed" | "wrong_channel" | "stale";

/**
 * Paging key for one event. Existing web projections (`ScoutConversationMessage`,
 * `WebMessage`) already carry `id`, `createdAt`, and `conversationId`. Poll-native
 * events may use `channelId` instead; when both are present, `channelId` wins.
 */
export type ChannelPollEventKey = {
  id: string;
  createdAt: number;
  channelId?: string;
  conversationId?: string;
};

/**
 * Canonical poll event: the web message projection with the channel binding
 * named `channelId`. Extra projection fields (attachments, threadSummary)
 * pass through `pageChannelPoll` when present on the input rows.
 */
export type ChannelPollEvent = {
  id: string;
  channelId: string;
  createdAt: number;
  actorId: string;
  actorName: string;
  body: string;
  class: string;
  metadata: Record<string, unknown> | null;
  replyToMessageId: string | null;
  threadConversationId: string | null;
};

export type ChannelPollCursor = {
  version: 1;
  channelId: string;
  createdAt: number;
  id: string;
};

export type ChannelPollPage<T extends ChannelPollEventKey = ChannelPollEvent> = {
  events: T[];
  /** Opaque `chpoll.v1.` cursor to pass on the next poll, or null when none can be minted. */
  nextCursor: string | null;
  /** True when the supplied window still has events after this page. */
  hasMore: boolean;
  recommendedPollIntervalMs: number;
};

export class ChannelPollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelPollError";
  }
}

export class ChannelPollCursorError extends ChannelPollError {
  readonly reason: ChannelPollCursorFailure;
  readonly cursor: string;
  readonly expectedChannelId: string | null;

  constructor(
    reason: ChannelPollCursorFailure,
    cursor: string,
    expectedChannelId: string | null = null,
  ) {
    super(cursorErrorMessage(reason, expectedChannelId));
    this.name = "ChannelPollCursorError";
    this.reason = reason;
    this.cursor = cursor;
    this.expectedChannelId = expectedChannelId;
  }
}

function cursorErrorMessage(
  reason: ChannelPollCursorFailure,
  expectedChannelId: string | null,
): string {
  switch (reason) {
    case "malformed":
      return "channel poll cursor is not a valid chpoll.v1 cursor";
    case "wrong_channel":
      return expectedChannelId
        ? `channel poll cursor was issued for a different channel than ${expectedChannelId}`
        : "channel poll cursor was issued for a different channel";
    case "stale":
      return expectedChannelId
        ? `channel poll cursor is no longer covered by the retained window for ${expectedChannelId}`
        : "channel poll cursor is no longer covered by the retained window";
  }
}

export function clampChannelPollLimit(
  limit: unknown,
  fallback: number = DEFAULT_CHANNEL_POLL_LIMIT,
): number {
  const requested = typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : Math.floor(fallback);
  return Math.min(MAX_CHANNEL_POLL_LIMIT, Math.max(1, requested));
}

export function eventChannelId(event: ChannelPollEventKey): string {
  const value = event.channelId ?? event.conversationId ?? "";
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Lift a web message projection row (`conversationId`) into the poll-native
 * shape (`channelId`). Other fields are copied through.
 */
export function channelPollEventFromProjection<T extends { conversationId: string }>(
  message: T,
): Omit<T, "conversationId"> & { channelId: string } {
  const { conversationId, ...rest } = message;
  return { ...rest, channelId: conversationId };
}

export function encodeChannelPollCursor(input: {
  channelId: string;
  createdAt: number;
  id: string;
}): string {
  const channelId = input.channelId.trim();
  const id = input.id.trim();
  if (!channelId || !id) {
    throw new ChannelPollError("channel poll cursor requires a channelId and id");
  }
  const createdAt = Number.isFinite(input.createdAt)
    ? Math.max(0, Math.trunc(input.createdAt))
    : 0;
  const json = JSON.stringify({ ch: channelId, id, t: createdAt }, ["ch", "id", "t"]);
  return `${CHANNEL_POLL_CURSOR_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function decodeChannelPollCursor(raw: string): ChannelPollCursor {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CHANNEL_POLL_CURSOR_PREFIX)) {
    throw new ChannelPollCursorError("malformed", trimmed);
  }
  const encoded = trimmed.slice(CHANNEL_POLL_CURSOR_PREFIX.length);
  if (!encoded || /[^A-Za-z0-9_-]/.test(encoded)) {
    throw new ChannelPollCursorError("malformed", trimmed);
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new ChannelPollCursorError("malformed", trimmed);
  }
  if (!isCursorPayload(parsed)) {
    throw new ChannelPollCursorError("malformed", trimmed);
  }
  return {
    version: 1,
    channelId: parsed.ch,
    createdAt: parsed.t,
    id: parsed.id,
  };
}

export function pageChannelPoll<T extends ChannelPollEventKey>(input: {
  channelId: string;
  events: readonly T[];
  cursor?: string | null;
  limit?: unknown;
  completeness: ChannelPollCompleteness;
}): ChannelPollPage<T> {
  const channelId = input.channelId.trim();
  if (!channelId) {
    throw new ChannelPollError("pageChannelPoll requires a channelId");
  }
  if (input.completeness !== "complete" && input.completeness !== "suffix") {
    throw new ChannelPollError("pageChannelPoll requires completeness complete or suffix");
  }

  const limit = clampChannelPollLimit(input.limit);
  const ordered = uniqueById(
    input.events
      .filter((event) => eventChannelId(event) === channelId)
      .slice()
      .sort((left, right) => compareMessagesAsc(left, right)),
  );

  const cursor = parseOptionalCursor(input.cursor);
  if (cursor && cursor.channelId !== channelId) {
    throw new ChannelPollCursorError("wrong_channel", String(input.cursor).trim(), channelId);
  }

  if (cursor && input.completeness === "suffix") {
    const windowStart = ordered[0];
    if (!windowStart || compareMessagesAsc(cursor, windowStart) < 0) {
      throw new ChannelPollCursorError("stale", String(input.cursor).trim(), channelId);
    }
  }

  const start = cursor
    ? firstIndexAfter(ordered, cursor)
    : 0;
  const events = ordered.slice(start, start + limit);
  const hasMore = start + events.length < ordered.length;
  const last = events.at(-1);
  const nextCursor = last
    ? encodeChannelPollCursor({ channelId, createdAt: last.createdAt, id: last.id })
    : cursor
      ? encodeChannelPollCursor(cursor)
      : null;

  return {
    events,
    nextCursor,
    hasMore,
    recommendedPollIntervalMs: hasMore
      ? CHANNEL_POLL_INTERVAL_CATCH_UP_MS
      : CHANNEL_POLL_INTERVAL_CAUGHT_UP_MS,
  };
}

function parseOptionalCursor(raw: string | null | undefined): ChannelPollCursor | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  return decodeChannelPollCursor(trimmed);
}

function firstIndexAfter<T extends ChannelPollEventKey>(
  ordered: readonly T[],
  cursor: ChannelPollCursor,
): number {
  const index = ordered.findIndex((event) => compareMessagesAsc(event, cursor) > 0);
  return index < 0 ? ordered.length : index;
}

function uniqueById<T extends ChannelPollEventKey>(events: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

function isCursorPayload(value: unknown): value is { ch: string; id: string; t: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("ch") || !keys.includes("id") || !keys.includes("t")) {
    return false;
  }
  const payload = value as { ch: unknown; id: unknown; t: unknown };
  return typeof payload.ch === "string"
    && payload.ch.length > 0
    && typeof payload.id === "string"
    && payload.id.length > 0
    && typeof payload.t === "number"
    && Number.isSafeInteger(payload.t)
    && payload.t >= 0;
}
