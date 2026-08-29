/**
 * OpenScout-owned collapsed rail (SCO-086 + shared slot grid).
 *
 * HudsonKit SidePanel collapses to a 0-width floating button — not a rail.
 * Sidebar chrome needs a real ~48px collapsed strip. Distinct from HIDDEN
 * (0px, no rail).
 *
 * Every collapsed column runs one vertical system:
 *   44px header band → top pad → slot 0, 1, 2… (32px cell + 6px gap)
 *
 * The band is RESERVED here, not drawn here. The column's owner (the shell for
 * the inspector, ScoutSideRail for the context rail) paints ONE toggle into it,
 * at the same coordinates that toggle occupies when the column is open — so
 * collapse happens in place and the header hairline stays unbroken across the
 * window. Expand is therefore not a widget this component owns: the chevron it
 * used to render for bodiless rails, and the section-label pill that doubled as
 * an expander for rich ones, were two different controls in two different places
 * for one action. Double-click on empty chrome still expands.
 */
import type { CSSProperties, ReactNode } from "react";
import { RAIL_COLLAPSED_WIDTH } from "./sidebar-collapse-state.ts";

type RailSide = "left" | "right";

export function CollapsedRail({
  side,
  title,
  onToggle,
  /** Distance from the viewport edge this rail attaches to (px). */
  edgeOffset = 0,
  top = 0,
  width = RAIL_COLLAPSED_WIDTH,
  glyph,
  /** Scrollable content under the band (e.g. chat avatar stack). */
  body,
  style,
  className = "",
}: {
  side: RailSide;
  title: string;
  onToggle: () => void;
  edgeOffset?: number;
  top?: number;
  width?: number;
  /** Optional minimal state glyph when there is no rich body. */
  glyph?: ReactNode;
  body?: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  const rich = Boolean(body);

  return (
    <aside
      data-scout-collapsed-rail=""
      data-side={side}
      data-pane={side === "left" ? "side-rail-collapsed" : "inspector-collapsed"}
      className={[
        "scout-collapsed-rail",
        rich ? "scout-collapsed-rail--rich" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        position: "fixed",
        top,
        bottom: 28,
        width,
        zIndex: 40,
        ...(side === "left" ? { left: edgeOffset } : { right: edgeOffset }),
        ...style,
      }}
      aria-label={`${title} (collapsed)`}
      onDoubleClick={(event) => {
        // Double-click empty chrome expands — classic, and it costs no pixels.
        if ((event.target as HTMLElement).closest("button, a, [role='button']")) return;
        onToggle();
      }}
    >
      <div className="scout-collapsed-rail-body">
        {body ? (
          body
        ) : glyph ? (
          <div className="scout-collapsed-rail-glyph" aria-hidden="true">
            {glyph}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
