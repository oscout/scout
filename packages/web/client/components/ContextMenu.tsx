import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem =
  | { kind: "action"; label: string; shortcut?: string; onSelect: () => void }
  | { kind: "separator" };

type Position = { x: number; y: number };

type ContextMenuState = {
  position: Position;
  items: MenuItem[];
} | null;

const ContextMenuContext = {
  current: null as ContextMenuState,
  setMenu: null as ((state: ContextMenuState) => void) | null,
};

export function useContextMenu() {
  return useCallback((event: React.MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    ContextMenuContext.setMenu?.({
      position: { x: event.clientX, y: event.clientY },
      items,
    });
  }, []);
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  ContextMenuContext.setMenu = setMenu;

  const close = useCallback(() => {
    setMenu(null);
  }, []);

  useEffect(() => {
    if (!menu) return;

    const onClickOutside = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onWheel = () => close();
    const onContextMenu = (e: MouseEvent) => {
      if (!e.defaultPrevented) {
        close();
      }
    };

    window.addEventListener("mousedown", onClickOutside, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, true);
    window.addEventListener("contextmenu", onContextMenu);

    return () => {
      window.removeEventListener("mousedown", onClickOutside, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [menu, close]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = menu.position.x;
    let y = menu.position.y;

    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
  }, [menu]);

  return (
    <>
      {children}
      {menu && (
        <div
          ref={menuRef}
          className="s-context-menu"
          style={{ left: menu.position.x, top: menu.position.y, visibility: "hidden" }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.items.map((item, i) =>
            item.kind === "separator" ? (
              <div key={i} className="s-context-menu-sep" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                className="s-context-menu-item"
                role="menuitem"
                onClick={() => {
                  item.onSelect();
                  close();
                }}
              >
                <span className="s-context-menu-label">{item.label}</span>
                {item.shortcut && (
                  <span className="s-context-menu-shortcut">{item.shortcut}</span>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </>
  );
}
