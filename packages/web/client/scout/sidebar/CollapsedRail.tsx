/**
 * OpenScout-owned collapsed rail wrapper (SCO-086).
 *
 * HudsonKit SidePanel collapses to a 0-width floating button — not a rail.
 * Sidebar chrome needs a real ~48px collapsed strip that hosts the shared
 * RailToggle (+ optional minimal glyph). Distinct from HIDDEN (0px, no rail).
 */
import type { CSSProperties, ReactNode } from "react";
import { RailToggle, type RailToggleSide } from "../../components/RailToggle.tsx";
import { RAIL_COLLAPSED_WIDTH, RAIL_TOGGLE_HEADER_TOP } from "./sidebar-collapse-state.ts";

export function CollapsedRail({
  side,
  title,
  onToggle,
  /** Distance from the viewport edge this rail attaches to (px). */
  edgeOffset = 0,
  top = 0,
  width = RAIL_COLLAPSED_WIDTH,
  glyph,
  /** Scrollable content under the toggle (e.g. chat avatar stack). */
  body,
  style,
  className = "",
}: {
  side: RailToggleSide;
  title: string;
  onToggle: () => void;
  edgeOffset?: number;
  top?: number;
  width?: number;
  /** Optional minimal state glyph below the toggle. */
  glyph?: ReactNode;
  body?: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <aside
      data-scout-collapsed-rail=""
      data-side={side}
      data-pane={side === "left" ? "side-rail-collapsed" : "inspector-collapsed"}
      className={`scout-collapsed-rail${className ? ` ${className}` : ""}${body ? " scout-collapsed-rail--rich" : ""}`}
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
    >
      {/* SCO-087 (review fix): center the chevron ON the rail's boundary line
          (its inner edge — right edge for a left rail, left edge for a right
          rail) so collapsed matches the expanded-state band, instead of
          flex-centering it ~24px inside the 48px strip. The vertical offset is
          the SHARED band constant, so this chevron lands on exactly the same
          baseline as the shell's sidebar-edge chevron next to it. */}
      <RailToggle
        side={side}
        collapsed
        label={title}
        onToggle={onToggle}
        className="scout-collapsed-rail-toggle"
        style={{
          position: "absolute",
          top: RAIL_TOGGLE_HEADER_TOP,
          zIndex: 46,
          ...(side === "left"
            ? { right: 0, transform: "translateX(50%)" }
            : { left: 0, transform: "translateX(-50%)" }),
        }}
      />
      {body ? (
        <div className="scout-collapsed-rail-body">
          {body}
        </div>
      ) : glyph ? (
        <div
          className="scout-collapsed-rail-glyph"
          aria-hidden="true"
          style={{ marginTop: 40 }}
        >
          {glyph}
        </div>
      ) : null}
    </aside>
  );
}
