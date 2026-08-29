/**
 * Operator-local visibility preferences for resolved conversation failures.
 *
 * Dismissing a failure acknowledges the attention state; it never deletes the
 * broker-owned message or flight. Keeping the hidden ids in this browser
 * profile prevents a cleared notice from returning after a native web-view
 * reload.
 */

const STORAGE_KEY = "scout:conversations:failure-dismissals:v1";
const MAX_CONVERSATIONS = 64;
const MAX_FAILURES_PER_CONVERSATION = 100;

type StoredDismissals = Record<string, string[]>;

let memoryDismissals: StoredDismissals = {};

function loadAll(): StoredDismissals {
  try {
    if (typeof localStorage !== "undefined") {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
      if (isStoredDismissals(parsed)) {
        memoryDismissals = clone(parsed);
      }
    }
  } catch {
    // Fall through to the in-process copy when storage is unavailable.
  }
  return clone(memoryDismissals);
}

function saveAll(next: StoredDismissals): void {
  memoryDismissals = clone(next);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // The current app session still keeps the dismissal in memory.
  }
}

export function loadDismissedConversationFailureIds(conversationId: string): Set<string> {
  return new Set(loadAll()[conversationId] ?? []);
}

export function dismissConversationFailure(conversationId: string, messageId: string): Set<string> {
  const all = loadAll();
  const ids = (all[conversationId] ?? []).filter((id) => id !== messageId);
  ids.push(messageId);
  all[conversationId] = ids.slice(-MAX_FAILURES_PER_CONVERSATION);

  const conversationIds = Object.keys(all);
  for (const staleId of conversationIds.slice(0, Math.max(0, conversationIds.length - MAX_CONVERSATIONS))) {
    delete all[staleId];
  }

  saveAll(all);
  return new Set(all[conversationId]);
}

function clone(value: StoredDismissals): StoredDismissals {
  return Object.fromEntries(Object.entries(value).map(([id, messageIds]) => [id, [...messageIds]]));
}

function isStoredDismissals(value: unknown): value is StoredDismissals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((messageIds) =>
    Array.isArray(messageIds) && messageIds.every((id) => typeof id === "string" && id.length > 0)
  );
}

export const __test = {
  STORAGE_KEY,
  reset(): void {
    memoryDismissals = {};
  },
};
