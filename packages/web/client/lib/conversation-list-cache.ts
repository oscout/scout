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
  if (inflight) {
    // Coalesce: a forced reload during an active fetch queues exactly one
    // trailing refetch instead of racing a duplicate multi-MB request.
    if (options.force) pendingForce = true;
    return inflight;
  }

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
      if (pendingForce) {
        pendingForce = false;
        void loadConversationList({ force: true }).catch(() => null);
      }
    });

  inflight = run;
  return run;
}

const REFRESH_DEBOUNCE_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingForce = false;

/**
 * Debounced forced refresh for broker-event storms: a burst of
 * message.posted events collapses into one refetch per debounce window.
 */
export function scheduleConversationListRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void loadConversationList({ force: true }).catch(() => null);
  }, REFRESH_DEBOUNCE_MS);
}

/** Test helper */
export function __resetConversationListCache() {
  cache = null;
  inflight = null;
  lastError = null;
  pendingForce = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}
