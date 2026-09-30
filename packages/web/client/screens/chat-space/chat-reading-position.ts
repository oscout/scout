export interface ChatReadingPosition {
  messageId: string | null;
  offset: number;
  scrollTop: number;
  atLatest: boolean;
}

export function parseChatReadingPosition(value: unknown): ChatReadingPosition | null {
  if (!value || typeof value !== "object") return null;
  const position = value as Partial<ChatReadingPosition>;
  if (typeof position.atLatest !== "boolean"
    || typeof position.scrollTop !== "number" || !Number.isFinite(position.scrollTop) || position.scrollTop < 0
    || typeof position.offset !== "number" || !Number.isFinite(position.offset)
    || (position.messageId !== null && typeof position.messageId !== "string")) return null;
  return position as ChatReadingPosition;
}

export function isAtChatTail(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= 48;
}

export function captureChatReadingPosition(scroller: HTMLElement): ChatReadingPosition {
  const top = scroller.getBoundingClientRect().top;
  const anchor = Array.from(scroller.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((node) => node.getBoundingClientRect().bottom > top);
  return {
    messageId: anchor?.dataset.messageId ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    scrollTop: scroller.scrollTop,
    atLatest: isAtChatTail(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight),
  };
}

export function restoreChatReadingPosition(scroller: HTMLElement, position: ChatReadingPosition | null) {
  if (!position || position.atLatest) {
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  const anchor = Array.from(scroller.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((node) => node.dataset.messageId === position.messageId);
  scroller.scrollTop = anchor
    ? scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offset
    : position.scrollTop;
}
