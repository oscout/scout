export type ComposeShortcutEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
  };
};

export function isComposerSendShortcut(
  event: ComposeShortcutEvent,
  sendOnEnter = false,
): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    (sendOnEnter || Boolean(event.metaKey || event.ctrlKey)) &&
    !event.nativeEvent?.isComposing
  );
}
