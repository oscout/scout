import type { CSSProperties, ReactNode } from "react";

import type { ScopeLaneSpace as LaneSpace } from "./scope-lane-spaces.ts";

export function ScopeLaneSpace({
  space,
  layoutMode,
  widthPx,
  gridSpan,
  children,
}: {
  space: LaneSpace;
  layoutMode: "swim" | "grid";
  widthPx: number;
  /** Grid mode: how many of the four base tracks this slot spans (¼ / ½ / full). */
  gridSpan?: number;
  children: ReactNode;
}) {
  const shellStyle = layoutMode === "swim"
    ? ({ "--scope-lane-width": `${widthPx}px` } as CSSProperties)
    : layoutMode === "grid" && gridSpan
      ? ({ gridColumn: `span ${gridSpan}` } as CSSProperties)
      : undefined;

  return (
    <div
      className={`scope-lane-space${layoutMode === "grid" ? " is-grid" : ""}`}
      style={shellStyle}
      data-split={space.ids.length}
      data-orient={space.orient}
      data-grid-span={layoutMode === "grid" ? gridSpan : undefined}
    >
      <div className="scope-lane-space__lanes">{children}</div>
    </div>
  );
}