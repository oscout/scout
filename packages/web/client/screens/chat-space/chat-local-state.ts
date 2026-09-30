import type { MessageMention } from "@openscout/protocol";
/** Browser-owned continuity, scoped to the authenticated person and room.
 * These records are not broker read receipts or shared notification state.
 */
export interface ChatLocalScope {
  actorId: string;
  space: string;
  channelId: string;
}

export interface ChatDraft {
  body: string;
  targetActorId: string | null;
  mentions?: MessageMention[];
}

export const EMPTY_CHAT_DRAFT: ChatDraft = Object.freeze({ body: "", targetActorId: null });

export function chatLocalKey(kind: string, scope: ChatLocalScope, threadId?: string | null): string {
  return `openscout.chat.${kind}.v1:${JSON.stringify([scope.actorId, scope.space, scope.channelId, threadId ?? null])}`;
}

export function parseChatDraft(value: unknown): ChatDraft {
  if (!value || typeof value !== "object") return EMPTY_CHAT_DRAFT;
  const draft = value as Partial<ChatDraft>;
  if (typeof draft.body !== "string") return EMPTY_CHAT_DRAFT;
  return {
    body: draft.body,
    targetActorId: typeof draft.targetActorId === "string" ? draft.targetActorId : null,
    ...(Array.isArray(draft.mentions) ? { mentions: draft.mentions.filter(mention =>
      mention && typeof mention.actorId === "string" && mention.actorId.trim() && mention.actorId.length <= 256
      && (mention.label === undefined || typeof mention.label === "string")).slice(0, 20) } : {}),
  };
}

export type ChatStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserChatStorage(): ChatStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

/** One key per composer avoids overwriting unrelated drafts from another tab.
 * Reads are cached for React's external-store contract. Failed storage retains
 * the current tab's work, including after later edits, without blocking typing.
 */
export function createChatLocalStore<T>(
  key: string | null,
  empty: T,
  parse: (value: unknown) => T,
  storage: ChatStorage | null = browserChatStorage(),
) {
  let raw: string | null | undefined;
  let value = empty;
  let storageFailed = false;
  const listeners = new Set<() => void>();
  const read = (): T => {
    if (!key || !storage || storageFailed) return value;
    try {
      const next = storage.getItem(key);
      if (next !== raw) {
        raw = next;
        try { value = next === null ? empty : parse(JSON.parse(next)); }
        catch { value = empty; }
      }
    } catch { storageFailed = true; }
    return value;
  };
  const write = (next: T) => {
    if (!key) return;
    value = next;
    raw = next === empty ? null : JSON.stringify(next);
    try {
      if (raw === null) storage?.removeItem(key);
      else storage?.setItem(key, raw);
    } catch { storageFailed = true; }
    for (const notify of listeners) notify();
  };
  return {
    key,
    read,
    write,
    update(update: (current: T) => T) { write(update(read())); },
    /** An acknowledgement may arrive after the person has typed a new draft. */
    clearIfUnchanged(expected: T) {
      if (read() === expected) write(empty);
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      const onStorage = (event: StorageEvent) => {
        if (event.key === key || event.key === null) notify();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(notify);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
  };
}
