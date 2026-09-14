import { useCallback, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { type MenuItem, useContextMenu } from "../../components/ContextMenu.tsx";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { type TerminalInputSurface, terminalAppOwnsMouse } from "./terminal-input-modes.ts";

/**
 * Terminal input that needs the xterm instance rather than the DOM.
 *
 * Two things only the instance can answer: what is selected (xterm paints its
 * own selection under `user-select: none`, so the browser selection over a
 * terminal is always empty) and whether the program inside owns the mouse.
 */
export function useTerminalInputSurface() {
  const terminalRef = useRef<TerminalInputSurface | null>(null);

  const handleTerminalReady = useCallback((terminal: unknown) => {
    terminalRef.current = (terminal ?? null) as TerminalInputSurface | null;
  }, []);

  const readSelection = useCallback((): string => {
    try {
      return terminalRef.current?.getSelection?.() ?? "";
    } catch {
      return "";
    }
  }, []);

  const copySelection = useCallback(() => {
    const selection = readSelection();
    if (selection) void copyTextToClipboard(selection);
  }, [readSelection]);

  /**
   * Paste through xterm when we can: it wraps the text in bracketed-paste
   * markers for apps that asked for them, so a multi-line paste arrives as one
   * paste instead of a run of Enter presses. `send` is the relay fallback.
   */
  const pasteText = useCallback((text: string, send: (data: string) => void) => {
    const terminal = terminalRef.current;
    if (typeof terminal?.paste === "function") {
      terminal.paste(text);
      return;
    }
    send(text);
  }, []);

  const pasteClipboardText = useCallback((send: (data: string) => void) => {
    if (!navigator.clipboard?.readText) return;
    void navigator.clipboard.readText()
      .then((text) => {
        if (text) pasteText(text, send);
      })
      .catch(() => {});
  }, [pasteText]);

  /**
   * Whether this right-click belongs to the app inside. Callers suppress the
   * browser menu either way; this only decides whether Scout's menu opens.
   * Shift forces Scout's menu — the escape hatch iTerm and VS Code both use.
   */
  const rightClickBelongsToApp = useCallback((event: ReactMouseEvent): boolean => {
    return !event.shiftKey && terminalAppOwnsMouse(terminalRef.current);
  }, []);

  /**
   * ⌘C (and Ctrl+Shift+C) copy the terminal selection. Plain Ctrl+C is never
   * touched: that is the interrupt, and the app has to keep receiving it.
   */
  const handleCopyShortcut = useCallback((event: ReactKeyboardEvent) => {
    if (event.key.toLowerCase() !== "c") return;
    const copyChord = (event.metaKey && !event.ctrlKey && !event.altKey)
      || (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey);
    if (!copyChord) return;
    const selection = readSelection();
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    void copyTextToClipboard(selection);
  }, [readSelection]);

  return {
    copySelection,
    handleCopyShortcut,
    handleTerminalReady,
    pasteClipboardText,
    pasteText,
    readSelection,
    rightClickBelongsToApp,
  };
}

/**
 * Copy/paste/focus right-click for the terminal surfaces that carry no session
 * chrome (the ad-hoc route terminal and the fresh workspace tile). Without it
 * those two showed the browser's own menu over whatever the app was drawing.
 */
export function useTerminalSurfaceMenu(options: {
  focusTerminal: () => void;
  readOnly?: boolean;
  sendInput: (data: string) => void;
}) {
  const { focusTerminal, readOnly = false, sendInput } = options;
  const surface = useTerminalInputSurface();
  const showContextMenu = useContextMenu();
  const { copySelection, pasteClipboardText, readSelection, rightClickBelongsToApp } = surface;

  const handleContextMenu = useCallback((event: ReactMouseEvent) => {
    // Suppress the browser menu in both branches: over a terminal it is never
    // the menu anyone wants, and it covers whatever the app just drew.
    event.preventDefault();
    if (rightClickBelongsToApp(event)) return;
    const selection = readSelection();
    const items: MenuItem[] = [];
    if (selection.trim()) {
      items.push({ kind: "action", label: "Copy Selection", shortcut: "⌘C", onSelect: copySelection });
    }
    if (!readOnly) {
      items.push({ kind: "action", label: "Paste", shortcut: "⌘V", onSelect: () => pasteClipboardText(sendInput) });
    }
    if (items.length > 0) items.push({ kind: "separator" });
    items.push({ kind: "action", label: "Focus Terminal", onSelect: focusTerminal });
    showContextMenu(event, items);
  }, [
    copySelection,
    focusTerminal,
    pasteClipboardText,
    readOnly,
    readSelection,
    rightClickBelongsToApp,
    sendInput,
    showContextMenu,
  ]);

  return useMemo(() => ({
    handleContextMenu,
    handleCopyShortcut: surface.handleCopyShortcut,
    handleTerminalReady: surface.handleTerminalReady,
  }), [handleContextMenu, surface.handleCopyShortcut, surface.handleTerminalReady]);
}
