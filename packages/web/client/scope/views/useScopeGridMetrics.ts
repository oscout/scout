import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyGridLayoutToContainer,
  fitGridLayout,
  GRID_CELL_MIN,
  type ScopeGridLayout,
} from "./scope-grid-layout.ts";

export type { ScopeGridLayout } from "./scope-grid-layout.ts";
export { fitGridLayout } from "./scope-grid-layout.ts";

export function useScopeGridMetrics(
  enabled: boolean,
  laneCount: number,
  targetCell = GRID_CELL_MIN,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initial = fitGridLayout(GRID_CELL_MIN, Math.max(laneCount, 1), targetCell);
  const [layout, setLayout] = useState<ScopeGridLayout>(initial);

  const applyMetrics = useCallback(() => {
    const container = containerRef.current;
    if (!container || !enabled || laneCount <= 0) return false;

    const width = container.clientWidth;
    if (!width) return false;

    const next = fitGridLayout(width, laneCount, targetCell);
    setLayout((previous) => (
      previous.columnCount === next.columnCount && previous.cellWidth === next.cellWidth
        ? previous
        : next
    ));
    applyGridLayoutToContainer(container, next);
    return true;
  }, [enabled, laneCount, targetCell]);

  useEffect(() => {
    if (!enabled) return;

    let raf = 0;
    let observer: ResizeObserver | null = null;

    const setup = () => {
      const container = containerRef.current;
      if (!container) return;

      let attempts = 0;
      const measure = () => {
        if (applyMetrics() || attempts >= 12) return;
        attempts += 1;
        raf = requestAnimationFrame(measure);
      };

      measure();
      observer = new ResizeObserver(() => {
        applyMetrics();
      });
      observer.observe(container);
    };

    setup();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [applyMetrics, enabled]);

  return {
    containerRef,
    columnCount: layout.columnCount,
    cellWidth: layout.cellWidth,
  };
}