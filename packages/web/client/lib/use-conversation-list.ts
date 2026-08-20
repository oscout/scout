import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { friendlyApiError } from "./api-errors.ts";
import {
  getCachedConversations,
  getConversationListError,
  getConversationListSnapshot,
  loadConversationList,
  subscribeConversationList,
} from "./conversation-list-cache.ts";
import { useBrokerEvents } from "./sse.ts";

/**
 * Shared conversation list for ChatLeft + collapsed chip strip.
 * First subscriber loads; collapse/expand reuses the warm cache.
 */
export function useConversationList() {
  const sessions = useSyncExternalStore(
    subscribeConversationList,
    getConversationListSnapshot,
    getConversationListSnapshot,
  );
  const [loading, setLoading] = useState(() => getCachedConversations() == null);
  const [loadError, setLoadError] = useState<string | null>(() => getConversationListError());

  const reload = useCallback(async (force = false) => {
    const hadCache = getCachedConversations() != null;
    if (!hadCache) setLoading(true);
    try {
      await loadConversationList({ force });
      setLoadError(null);
    } catch (cause) {
      setLoadError(friendlyApiError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(false);
  }, [reload]);

  useBrokerEvents((event) => {
    if (event.kind === "message.posted" || event.kind === "conversation.upserted") {
      void reload(true);
    }
  });

  return { sessions, loading, loadError, reload };
}
