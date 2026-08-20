import { isEditableTarget } from "./keyboard-nav-core.ts";

export const NEW_CHAT_SHORTCUT_LABEL = "C";
export const NEW_CHAT_SHORTCUT_KEYS = ["C"] as const;
export const NEW_CHAT_LEGACY_SHORTCUT_KEYS = ["⌘", "⌥", "N"] as const;
export const NEW_TASK_ACTION_LABEL = "New task";

type NewChatShortcutEvent = {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
};

function isNKey(event: NewChatShortcutEvent): boolean {
  return event.key.toLowerCase() === "n" || event.code === "KeyN";
}

function isCKey(event: NewChatShortcutEvent): boolean {
  return event.key.toLowerCase() === "c" || event.code === "KeyC";
}

export function isNewChatShortcut(event: NewChatShortcutEvent): boolean {
  if (isEditableTarget(event.target ?? null)) return false;
  return (
    (
      isCKey(event) &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) ||
    (
      isNKey(event) &&
      Boolean(event.metaKey || event.ctrlKey) &&
      Boolean(event.altKey) &&
      !event.shiftKey
    )
  );
}
