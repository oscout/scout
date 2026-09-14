/**
 * The per-machine menu on the Network page.
 *
 * Same actions however you reach them: right-click the row, press the ⋯
 * button, or press Shift+F10 / the context-menu key with the row focused. A
 * pointer-only menu would leave the keyboard with no way to refresh a node,
 * so the button is always rendered and always focusable rather than appearing
 * on hover.
 *
 * The open menu is portalled to the document body and positioned in viewport
 * coordinates. The map draws its racks inside a CSS transform, and a transform
 * makes itself the containing block for `position: fixed` descendants — a menu
 * left inside the rack would be offset by the current pan and clipped by the
 * zoom. Anchored in the body, one menu behaves the same on the rail and on the
 * map at any zoom.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";

import type { NodeMenuAction } from "./node-actions.ts";

export type NodeMenuHandle = {
  /** Open at a pointer position, e.g. from a row's context-menu event. */
  openAt: (point: { x: number; y: number }) => void;
  /** Open anchored to the button, e.g. from the keyboard. */
  open: () => void;
  close: () => void;
};

type NodeMenuProps = {
  /** Names the machine in the button's accessible label. */
  machineLabel: string;
  actions: NodeMenuAction[];
  /** Extra class for the trigger, so each surface can place it. */
  className?: string;
};

export const NodeMenu = forwardRef<NodeMenuHandle, NodeMenuProps>(function NodeMenu(
  { machineLabel, actions, className },
  ref,
) {
  const [open, setOpen] = useState(false);
  /** Viewport point the menu is anchored to; null until it is placed. */
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Focus goes back where it came from on close; losing it to the page body is
  // how a keyboard user gets stranded.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setAnchor(null);
    setPlacement(null);
    if (!restoreFocus) return;
    const target = restoreFocusRef.current ?? triggerRef.current;
    target?.focus();
  }, []);

  const openMenu = useCallback((at: { x: number; y: number } | null) => {
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // Opened from the keyboard or the button: anchor under the trigger itself.
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchor(at ?? (rect ? { x: rect.left, y: rect.bottom + 2 } : { x: 16, y: 16 }));
    setPlacement(null);
    setOpen(true);
  }, []);

  useImperativeHandle(ref, () => ({
    openAt: (at) => openMenu(at),
    open: () => openMenu(null),
    close: () => close(false),
  }), [close, openMenu]);

  // Place after mount, once the menu's real size is known: clamp to the
  // viewport, and flip above the anchor rather than running off the bottom.
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const left = Math.min(Math.max(margin, anchor.x), maxLeft);
    const fitsBelow = anchor.y + rect.height + margin <= window.innerHeight;
    const top = fitsBelow
      ? anchor.y
      : Math.max(margin, anchor.y - rect.height - (anchor.y > window.innerHeight / 2 ? 4 : 0));
    setPlacement({ left, top });
  }, [anchor, open]);

  useEffect(() => {
    if (!open) return;
    // Focus the first item that can actually be used; a disabled one is not
    // focusable, and focusing nothing strands the keyboard in the menu.
    const first = itemRefs.current.find((item) => item && !item.disabled);
    (first ?? itemRefs.current[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target ?? null)) return;
      if (triggerRef.current?.contains(target ?? null)) return;
      close(false);
    };
    const onWindowBlur = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [close, open]);

  const moveFocus = (from: number, delta: number) => {
    const count = actions.length;
    if (count === 0) return;
    // Step over disabled items rather than landing on one and appearing stuck.
    for (let step = 1; step <= count; step += 1) {
      const candidate = itemRefs.current[(from + delta * step + count * step) % count];
      if (candidate && !candidate.disabled) { candidate.focus(); return; }
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>, index: number) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(index, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(index, -1);
        break;
      case "Home":
        event.preventDefault();
        itemRefs.current[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        itemRefs.current[actions.length - 1]?.focus();
        break;
      case "Tab":
        // Tabbing out is a dismissal, and the browser should keep the move.
        close(false);
        break;
      default:
        break;
    }
  };

  const runAction = (action: NodeMenuAction) => {
    if (action.disabled) return;
    close();
    void action.run();
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`mesh-node-menu-btn${className ? ` ${className}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${machineLabel}`}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          if (open) close(false);
          else openMenu(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openMenu(null);
          }
        }}
      >
        <span aria-hidden>⋯</span>
      </button>

      {open && typeof document !== "undefined" && createPortal((
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${machineLabel} actions`}
          className="mesh-node-menu"
          style={{
            position: "fixed",
            left: placement?.left ?? anchor?.x ?? 0,
            top: placement?.top ?? anchor?.y ?? 0,
            // Hidden for the one frame it takes to measure, so it never paints
            // in the wrong place first.
            visibility: placement ? "visible" : "hidden",
          }}
        >
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              ref={(element) => { itemRefs.current[index] = element; }}
              className="mesh-node-menu-item"
              title={action.hint}
              disabled={action.disabled}
              aria-disabled={action.disabled}
              onClick={(event) => {
                event.stopPropagation();
                runAction(action);
              }}
              onKeyDown={(event) => onMenuKeyDown(event, index)}
            >
              <span className="mesh-node-menu-item-label">{action.label}</span>
              {action.hint && <span className="mesh-node-menu-item-hint">{action.hint}</span>}
            </button>
          ))}
        </div>
      ), document.body)}
    </>
  );
});

/**
 * Row-level wiring: right-click, and the keyboard equivalents a right-click
 * has (Shift+F10 everywhere, the dedicated context-menu key where there is
 * one). Returned as props so every row spreads the same behaviour.
 */
export function nodeMenuRowProps(menu: { current: NodeMenuHandle | null }) {
  return {
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      menu.current?.openAt({ x: event.clientX, y: event.clientY });
    },
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        event.stopPropagation();
        menu.current?.open();
      }
    },
  };
}
