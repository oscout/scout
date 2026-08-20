import { useCallback, useEffect, useRef } from "react";

export {
  isEditableTarget,
  isModalShortcutContext,
  isTerminalFocusShortcut,
  isTerminalInputTarget,
  nextListIndex,
} from "./keyboard-nav-core.ts";

import { isEditableTarget } from "./keyboard-nav-core.ts";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function useFocusTrap<T extends HTMLElement>(active: boolean = true) {
  const ref = useRef<T | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (!node) return;
    const first = node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? node).focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [active]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (!active) return;
    if (e.key !== "Tab") return;
    const node = ref.current;
    if (!node) return;
    const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) {
      e.preventDefault();
      node.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (current === first || !node.contains(current)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (current === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [active]);

  return { ref, onKeyDown };
}

function listButtons(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll<HTMLElement>(
      [
        ":scope > button:not([disabled])",
        ":scope > [role='button']:not([aria-disabled='true'])",
        ":scope > * > button[data-list-primary]:not([disabled])",
      ].join(", "),
    ),
  );
}

function rovingFocus(items: HTMLElement[], next: number) {
  items.forEach((el, i) => {
    el.tabIndex = i === next ? 0 : -1;
  });
  items[next]?.focus();
}

export function useListArrowNav() {
  return useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const isDown = e.key === "ArrowDown" || e.key === "j";
    const isUp = e.key === "ArrowUp" || e.key === "k";
    const isHome = e.key === "Home" || (e.key === "g" && !e.shiftKey && !e.metaKey && !e.ctrlKey);
    const isEnd = e.key === "End" || e.key === "G";
    if (!isDown && !isUp && !isHome && !isEnd) return;
    const items = listButtons(e.currentTarget);
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = items.findIndex((el) => el === active);
    let next: number;
    if (isDown) next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
    else if (isUp) next = idx < 0 ? items.length - 1 : Math.max(0, idx - 1);
    else if (isHome) next = 0;
    else next = items.length - 1;
    e.preventDefault();
    rovingFocus(items, next);
  }, []);
}

export function rovingTabIndex(active: boolean, hasAnyActive: boolean, isFirst: boolean): 0 | -1 {
  if (active) return 0;
  if (!hasAnyActive && isFirst) return 0;
  return -1;
}

export function usePaneNav() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
      if (isEditableTarget(e.target)) return;
      const target = e.target as HTMLElement | null;
      const order = ["left", "center", "right"] as const;
      const dir = e.key === "]" ? 1 : -1;
      const currentIdx = order.findIndex((name) => {
        const el = document.querySelector(`[data-pane="${name}"]`);
        return el ? el.contains(target as Node) : false;
      });
      const start = currentIdx < 0 ? (dir > 0 ? -1 : order.length) : currentIdx;
      for (let i = start + dir; i >= 0 && i < order.length; i += dir) {
        const pane = document.querySelector<HTMLElement>(`[data-pane="${order[i]}"]`);
        if (!pane) continue;
        const focusable = pane.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable) {
          e.preventDefault();
          focusable.focus();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function useSlashToFocus(getInput: () => HTMLInputElement | null) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      if (isEditableTarget(e.target)) return;
      const input = getInput();
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [getInput]);
}

export function makeSearchHandoff(getList: () => HTMLElement | null) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown") return;
    const list = getList();
    if (!list) return;
    const items = listButtons(list);
    if (items.length === 0) return;
    const current = items.findIndex((el) => el.tabIndex === 0);
    const target = current >= 0 ? current : 0;
    e.preventDefault();
    rovingFocus(items, target);
  };
}
