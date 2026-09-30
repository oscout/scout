import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { chatLocalKey, createChatLocalStore, type ChatLocalScope } from "./chat-local-state.ts";
import { captureChatReadingPosition, isAtChatTail, parseChatReadingPosition, restoreChatReadingPosition, type ChatReadingPosition } from "./chat-reading-position.ts";

/** The position of this browser's viewport, not a shared read receipt. Track
 * whether the reader was following BEFORE the feed grows: measuring after a
 * long incoming message incorrectly makes a tail-following reader look away.
 */
export function useChatReadingPosition({ scope, ready, messageIds, focusMessageId, initialUnreadMessageId, scroller, content }: {
  scope: ChatLocalScope | null;
  ready: boolean;
  messageIds: string[];
  focusMessageId: string | null;
  initialUnreadMessageId?: string | null;
  scroller: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
}) {
  const key = scope ? chatLocalKey("reading", scope) : null;
  const store = useMemo(() => createChatLocalStore<ChatReadingPosition | null>(key, null, parseChatReadingPosition), [key]);
  const activeKey = useRef<string | null>(null);
  const following = useRef(true);
  const previousIds = useRef(new Set<string>());
  const [away, setAway] = useState(false);
  const [newCount, setNewCount] = useState(0);

  const remember = useCallback(() => {
    const node = scroller.current;
    if (!node || !ready || !key || activeKey.current !== key) return;
    const position = captureChatReadingPosition(node);
    following.current = position.atLatest;
    setAway(!position.atLatest);
    if (position.atLatest) setNewCount(0);
    store.write(position);
  }, [key, ready, scroller, store]);

  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node || activeKey.current !== key) return;
    // Follow state is cheap and immediate; layout scans and synchronous storage
    // writes happen after a scroll burst, not on every animation frame.
    following.current = isAtChatTail(node.scrollTop, node.scrollHeight, node.clientHeight);
    setAway(!following.current);
    if (following.current) setNewCount(0);
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { scrollTimer.current = null; remember(); }, 150);
  }, [key, remember, scroller]);
  useLayoutEffect(() => () => {
    if (scrollTimer.current) { remember(); clearTimeout(scrollTimer.current); }
    scrollTimer.current = null;
  }, [remember]);

  const jumpToLatest = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    following.current = true;
    node.scrollTop = node.scrollHeight;
    remember();
  }, [remember, scroller]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!key || !ready || !node) return;
    if (activeKey.current !== key) {
      activeKey.current = key;
      const saved = store.read();
      const unreadAnchor = !focusMessageId && (!saved || saved.atLatest) && initialUnreadMessageId
        ? Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]")).find((item) => item.dataset.messageId === initialUnreadMessageId)
        : undefined;
      // An explicit message link outranks remembered viewport state.
      following.current = !focusMessageId && !unreadAnchor && (!saved || saved.atLatest);
      if (unreadAnchor) node.scrollTop += unreadAnchor.getBoundingClientRect().top - node.getBoundingClientRect().top;
      else if (!focusMessageId) restoreChatReadingPosition(node, saved);
      if (unreadAnchor) following.current = isAtChatTail(node.scrollTop, node.scrollHeight, node.clientHeight);
      setAway(!following.current);
      setNewCount(0);
      previousIds.current = new Set(messageIds);
      return;
    }
    const added = messageIds.filter((id) => !previousIds.current.has(id)).length;
    previousIds.current = new Set(messageIds);
    if (following.current) node.scrollTop = node.scrollHeight;
    else if (added) setNewCount((count) => count + added);
  }, [key, ready, messageIds, focusMessageId, initialUnreadMessageId, scroller, store]);

  useEffect(() => {
    if (!ready || !key || activeKey.current !== key) return;
    const node = content.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [key, ready, content, scroller]);

  useEffect(() => {
    window.addEventListener("pagehide", remember);
    return () => window.removeEventListener("pagehide", remember);
  }, [remember]);

  return { onScroll, jumpToLatest, away, newCount };
}
