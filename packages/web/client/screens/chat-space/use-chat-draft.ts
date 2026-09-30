import { useRef, useSyncExternalStore } from "react";
import { chatLocalKey, createChatLocalStore, EMPTY_CHAT_DRAFT, parseChatDraft, type ChatLocalScope } from "./chat-local-state.ts";

export function useChatDraft(scope: ChatLocalScope | null, threadId?: string | null) {
  const key = scope ? chatLocalKey("draft", scope, threadId) : null;
  // Preserve in-memory drafts across room switches even when browser storage
  // is unavailable. Stores from another identity are never selected by key.
  const stores = useRef(new Map<string | null, ReturnType<typeof createChatLocalStore<typeof EMPTY_CHAT_DRAFT>>>());
  let store = stores.current.get(key);
  if (!store) {
    store = createChatLocalStore(key, EMPTY_CHAT_DRAFT, parseChatDraft);
    stores.current.set(key, store);
  }
  const draft = useSyncExternalStore(store.subscribe, store.read, () => EMPTY_CHAT_DRAFT);
  return { draft, store };
}
