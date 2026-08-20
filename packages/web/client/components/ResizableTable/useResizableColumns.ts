import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Resizable-column state for an HTML table (or any element where each column
 * accepts an explicit pixel width). Pairs with a small drag-handle element
 * inside each <th>; see `getResizeHandleProps`.
 *
 * Widths are kept in component state, persisted to `localStorage` under
 * `storageKey`, and clamped to per-column min/max during drag.
 */

export type ResizableColumnSpec<K extends string = string> = {
  key: K;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
};

export type UseResizableColumnsOptions<K extends string = string> = {
  /** localStorage key for persisted widths. Omit to skip persistence. */
  storageKey?: string;
  columns: ResizableColumnSpec<K>[];
};

const DEFAULT_MIN = 48;
const DEFAULT_MAX = 720;

function readPersisted(key: string | undefined): Record<string, number> | null {
  if (!key) return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function writePersisted(key: string | undefined, widths: Record<string, number>): void {
  if (!key) return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    /* quota or disabled — ignore */
  }
}

export function useResizableColumns<K extends string = string>({
  storageKey,
  columns,
}: UseResizableColumnsOptions<K>) {
  const initial = useMemo<Record<string, number>>(() => {
    const persisted = readPersisted(storageKey) ?? {};
    const out: Record<string, number> = {};
    for (const col of columns) out[col.key] = persisted[col.key] ?? col.defaultWidth;
    return out;
  }, [storageKey, columns]);

  const [widths, setWidths] = useState<Record<string, number>>(initial);

  // If new columns appear after first render, fold their defaults in without
  // wiping user-resized values for existing keys.
  useEffect(() => {
    setWidths((prev) => {
      let mutated = false;
      const next = { ...prev };
      for (const col of columns) {
        if (next[col.key] == null) {
          next[col.key] = col.defaultWidth;
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
  }, [columns]);

  const specByKey = useMemo(() => {
    const map = new Map<string, ResizableColumnSpec<K>>();
    for (const col of columns) map.set(col.key, col);
    return map;
  }, [columns]);

  const dragRef = useRef<{
    key: string;
    startX: number;
    startWidth: number;
    min: number;
    max: number;
  } | null>(null);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const next = Math.min(drag.max, Math.max(drag.min, drag.startWidth + delta));
    setWidths((prev) => (prev[drag.key] === next ? prev : { ...prev, [drag.key]: next }));
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    setWidths((current) => {
      writePersisted(storageKey, current);
      return current;
    });
  }, [onPointerMove, storageKey]);

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  const getColumnProps = useCallback(
    (key: K): { style: CSSProperties; "data-resize-key": string } => {
      const w = widths[key];
      const spec = specByKey.get(key);
      const min = spec?.minWidth ?? DEFAULT_MIN;
      const max = spec?.maxWidth ?? DEFAULT_MAX;
      return {
        style: { width: w, minWidth: min, maxWidth: max },
        "data-resize-key": key,
      };
    },
    [widths, specByKey],
  );

  const getResizeHandleProps = useCallback(
    (key: K) => {
      const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const spec = specByKey.get(key);
        const min = spec?.minWidth ?? DEFAULT_MIN;
        const max = spec?.maxWidth ?? DEFAULT_MAX;
        const startWidth = widths[key] ?? spec?.defaultWidth ?? min;
        dragRef.current = {
          key,
          startX: event.clientX,
          startWidth,
          min,
          max,
        };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
      };

      const onDoubleClick = (event: ReactPointerEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const spec = specByKey.get(key);
        if (!spec) return;
        setWidths((prev) => {
          const next = { ...prev, [key]: spec.defaultWidth };
          writePersisted(storageKey, next);
          return next;
        });
      };

      const onClick = (event: ReactPointerEvent<HTMLElement>) => {
        // Prevent clicks on the handle from bubbling to the <th> (which often
        // owns sort-on-click). Drag uses pointerdown — the click that follows
        // a drag would still fire without this.
        event.stopPropagation();
      };

      return {
        onPointerDown,
        onClick,
        onDoubleClick,
        role: "separator" as const,
        "aria-orientation": "vertical" as const,
        "aria-label": "Resize column",
        className: "s-resize-handle",
      };
    },
    [widths, specByKey, onPointerMove, onPointerUp, storageKey],
  );

  const resetAll = useCallback(() => {
    setWidths(() => {
      const next: Record<string, number> = {};
      for (const col of columns) next[col.key] = col.defaultWidth;
      writePersisted(storageKey, next);
      return next;
    });
  }, [columns, storageKey]);

  return { widths, getColumnProps, getResizeHandleProps, resetAll };
}
