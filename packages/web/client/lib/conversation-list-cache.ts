/**
 * Shared conversation list cache for chat expanded + collapsed rails.
 * Collapse/expand must not cold-fetch /api/conversations again.
 */
import { api } from "./api.ts";
import type { SessionEntry } from "./types.ts";

type Listener = () => void;

let cache: SessionEntry[] | null = null;
let inflight: Promise<SessionEntry[]> | null = null;
let lastError: string | null = null;
const listeners = new Set<Listener>();
const EMPTY_CONVERSATIONS: SessionEntry[] = [];

export function getCachedConversations(): SessionEntry[] | null {
  return cache;
}

/** React external-store snapshots must preserve identity until the store changes. */
export function getConversationListSnapshot(): SessionEntry[] {
  return cache ?? EMPTY_CONVERSATIONS;
}

export function getConversationListError(): string | null {
  return lastError;
}

export function subscribeConversationList(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

export async function loadConversationList(options: { force?: boolean } = {}): Promise<SessionEntry[]> {
  if (cache && !options.force) return cache;
  if (inflight && !options.force) return inflight;

  const run = api<SessionEntry[]>("/api/conversations")
    .then((data) => {
      cache = data;
      lastError = null;
      emit();
      return data;
    })
    .catch((cause) => {
      lastError = cause instanceof Error ? cause.message : String(cause);
      emit();
      throw cause;
    })
    .finally(() => {
      inflight = null;
    });

  inflight = run;
  return run;
}

/** Test helper */
export function __resetConversationListCache() {
  cache = null;
  inflight = null;
  lastError = null;
}
