import { api } from "./api.ts";
import {
  compareMessagesAsc,
  encodeMessageHistoryCursor,
} from "../../shared/message-pagination.ts";
import type { Message, SessionEntry } from "./types.ts";

export const RECENT_CHAT_PRELOAD_LIMIT = 10;
export const CHAT_TAIL_LIMIT = 80;
export const INITIAL_CHAT_HISTORY_LIMIT = 300;
export const CHAT_HISTORY_PAGE_LIMIT = 100;
export const MAX_CACHED_MESSAGES_PER_CHAT = 2_000;

const MAX_CACHED_CHAT_TAILS = RECENT_CHAT_PRELOAD_LIMIT;
const PREFETCH_CONCURRENCY = 2;

type CachedTail = {
  messages: Message[];
  historyLoaded: boolean;
  historyExhausted: boolean;
  touchedAt: number;
};

const tails = new Map<string, CachedTail>();
const inFlightTails = new Map<string, Promise<Message[]>>();
let touchSequence = 0;

function normalizedConversationId(conversationId: string): string {
  return conversationId.trim();
}

function sortAndDedupeMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  // The shared total order, not localeCompare: the cache's first row becomes
  // the cursor the server pages from, so a different tie-break here means the
  // server answers with rows this cache already holds and paging never advances.
  return [...byId.values()].sort(compareMessagesAsc);
}

function evictLeastRecentlyUsedTail(): void {
  if (tails.size <= MAX_CACHED_CHAT_TAILS) return;
  let oldestId: string | null = null;
  let oldestTouch = Number.POSITIVE_INFINITY;
  for (const [conversationId, entry] of tails) {
    if (entry.touchedAt < oldestTouch) {
      oldestId = conversationId;
      oldestTouch = entry.touchedAt;
    }
  }
  if (oldestId) tails.delete(oldestId);
}

export function readCachedConversationTail(
  conversationId: string,
): Message[] | null {
  const id = normalizedConversationId(conversationId);
  const entry = tails.get(id);
  if (!entry) return null;
  entry.touchedAt = ++touchSequence;
  return entry.messages;
}

export function writeCachedConversationTail(
  conversationId: string,
  messages: Message[],
  options: { historyLoaded?: boolean; historyExhausted?: boolean } = {},
): Message[] {
  const id = normalizedConversationId(conversationId);
  if (!id) return [];
  const previous = tails.get(id);
  const normalized = sortAndDedupeMessages(messages).slice(
    -MAX_CACHED_MESSAGES_PER_CHAT,
  );
  tails.set(id, {
    messages: normalized,
    historyLoaded: options.historyLoaded ?? previous?.historyLoaded ?? false,
    historyExhausted: options.historyExhausted ?? previous?.historyExhausted ?? false,
    touchedAt: ++touchSequence,
  });
  evictLeastRecentlyUsedTail();
  return normalized;
}

export function mergeCachedConversationTail(
  conversationId: string,
  messages: Message[],
): Message[] {
  const current = readCachedConversationTail(conversationId) ?? [];
  return writeCachedConversationTail(conversationId, [...current, ...messages]);
}

export function newestCachedConversationMessageAt(
  conversationId: string,
): number | null {
  return readCachedConversationTail(conversationId)?.at(-1)?.createdAt ?? null;
}

export function hasCachedConversationHistory(conversationId: string): boolean {
  return tails.get(normalizedConversationId(conversationId))?.historyLoaded ?? false;
}

export function canLoadEarlierConversationMessages(conversationId: string): boolean {
  const entry = tails.get(normalizedConversationId(conversationId));
  return Boolean(
    entry
    && entry.historyLoaded
    && !entry.historyExhausted
    && entry.messages.length > 0
    && entry.messages.length < MAX_CACHED_MESSAGES_PER_CHAT
  );
}

export async function loadConversationTail(
  conversationId: string,
  options: { refresh?: boolean } = {},
): Promise<Message[]> {
  const id = normalizedConversationId(conversationId);
  if (!id) return [];

  const cached = readCachedConversationTail(id);
  if (cached && !options.refresh) return cached;

  const existing = inFlightTails.get(id);
  if (existing) return existing;

  const request = api<Message[]>(
    `/api/messages?conversationId=${encodeURIComponent(id)}&limit=${CHAT_TAIL_LIMIT}`,
  ).then((messages) => mergeCachedConversationTail(id, messages));
  inFlightTails.set(id, request);
  try {
    return await request;
  } finally {
    inFlightTails.delete(id);
  }
}

export async function loadConversationHistory(
  conversationId: string,
): Promise<Message[]> {
  const id = normalizedConversationId(conversationId);
  if (!id) return [];
  if (hasCachedConversationHistory(id)) {
    return readCachedConversationTail(id) ?? [];
  }

  const requestKey = `${id}:history`;
  const existing = inFlightTails.get(requestKey);
  if (existing) return existing;

  const request = api<Message[]>(
    `/api/messages?conversationId=${encodeURIComponent(id)}&limit=${INITIAL_CHAT_HISTORY_LIMIT}`,
  ).then((messages) => writeCachedConversationTail(
    id,
    [...(readCachedConversationTail(id) ?? []), ...messages],
    {
      historyLoaded: true,
      historyExhausted: messages.length < INITIAL_CHAT_HISTORY_LIMIT,
    },
  ));
  inFlightTails.set(requestKey, request);
  try {
    return await request;
  } finally {
    inFlightTails.delete(requestKey);
  }
}

export async function loadEarlierConversationMessages(
  conversationId: string,
): Promise<Message[]> {
  const id = normalizedConversationId(conversationId);
  if (!id) return [];
  if (!hasCachedConversationHistory(id)) {
    return loadConversationHistory(id);
  }
  if (!canLoadEarlierConversationMessages(id)) {
    return readCachedConversationTail(id) ?? [];
  }

  const current = readCachedConversationTail(id) ?? [];
  const oldest = current[0];
  if (!oldest) return current;
  // Send the position, not the name: the anchor message can be deleted between
  // pages and the next page still has to land in the same place.
  const cursor = encodeMessageHistoryCursor(oldest);

  const requestKey = `${id}:before:${cursor}`;
  const existing = inFlightTails.get(requestKey);
  if (existing) return existing;

  const request = api<Message[]>(
    `/api/messages?conversationId=${encodeURIComponent(id)}&limit=${CHAT_HISTORY_PAGE_LIMIT}&beforeMessageId=${encodeURIComponent(cursor)}`,
  ).then((messages) => writeCachedConversationTail(
    id,
    [...messages, ...(readCachedConversationTail(id) ?? [])],
    {
      historyLoaded: true,
      historyExhausted: messages.length < CHAT_HISTORY_PAGE_LIMIT,
    },
  ));
  inFlightTails.set(requestKey, request);
  try {
    return await request;
  } finally {
    inFlightTails.delete(requestKey);
  }
}

export async function preloadRecentConversationTails(
  conversations: SessionEntry[],
): Promise<void> {
  const ids = [...new Set(
    conversations
      .slice(0, RECENT_CHAT_PRELOAD_LIMIT)
      .map((conversation) => normalizedConversationId(conversation.id))
      .filter(Boolean),
  )].filter((conversationId) => readCachedConversationTail(conversationId) === null);

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(PREFETCH_CONCURRENCY, ids.length) },
    async () => {
      while (cursor < ids.length) {
        const conversationId = ids[cursor++];
        if (!conversationId) continue;
        await loadConversationTail(conversationId).catch(() => null);
      }
    },
  );
  await Promise.all(workers);
}

export function clearConversationTailCache(): void {
  tails.clear();
  inFlightTails.clear();
  touchSequence = 0;
}
