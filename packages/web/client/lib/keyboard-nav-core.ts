const EDITABLE_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='combobox']",
  "[role='searchbox']",
  "[role='spinbutton']",
  "[role='textbox']",
].join(",");

const TERMINAL_INPUT_SELECTOR = [
  ".xterm",
  ".xterm-helper-textarea",
  "[data-scout-terminal-input='true']",
].join(",");

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as {
    closest?: (selector: string) => unknown;
    isContentEditable?: boolean;
    parentElement?: { closest?: (selector: string) => unknown } | null;
    tagName?: string;
  } | null;
  if (!el) return false;
  const tagName = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
  if (el.isContentEditable === true) return true;
  if (typeof el.closest === "function" && el.closest(EDITABLE_TARGET_SELECTOR)) return true;
  return typeof el.parentElement?.closest === "function" && Boolean(el.parentElement.closest(EDITABLE_TARGET_SELECTOR));
}

/** A focused terminal owns every key combination, including app shortcuts. */
export function isTerminalInputTarget(target: EventTarget | null): boolean {
  const el = target as {
    closest?: (selector: string) => unknown;
    parentElement?: { closest?: (selector: string) => unknown } | null;
  } | null;
  if (!el) return false;
  if (typeof el.closest === "function" && el.closest(TERMINAL_INPUT_SELECTOR)) return true;
  return typeof el.parentElement?.closest === "function"
    && Boolean(el.parentElement.closest(TERMINAL_INPUT_SELECTOR));
}

export function isTerminalFocusShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): boolean {
  return (event.metaKey || event.ctrlKey)
    && event.shiftKey
    && !event.altKey
    && event.key.toLowerCase() === "b";
}

/** Skip global/list shortcuts while typing or a modal owns focus. */
export function isModalShortcutContext(): boolean {
  return Boolean(
    document.querySelector(".kb-help-backdrop")
    || document.querySelector("[data-command-palette-open='true']")
    || document.querySelector("[role='dialog'][aria-modal='true']"),
  );
}

export function nextListIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, current + delta));
}
