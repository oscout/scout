/**
 * Edge chevron rail expand/collapse control (SCO-086).
 *
 * Pure app-owned control shared by the nav sidebar, side rail, and inspector.
 * Imports neither HudsonKit nor shadcn — shell/wrapper owns placement and
 * binding to collapse state.
 *
 * Renders a compact directional control at the rail boundary (callers position
 * it at header height). The SVG keeps the mark optically consistent across
 * platforms instead of depending on a font's ‹ / › glyph metrics.
 */
import type { CSSProperties, MouseEventHandler } from "react";

export type RailToggleSide = "left" | "right";

export function railToggleChevron(
  side: RailToggleSide,
  collapsed: boolean,
): "‹" | "›" {
  // Left rails expand rightward; right rails expand leftward.
  if (side === "left") return collapsed ? "›" : "‹";
  return collapsed ? "‹" : "›";
}

export function railToggleLabel(
  collapsed: boolean,
  panelLabel?: string,
): string {
  const name = panelLabel?.trim() || "panel";
  return collapsed ? `Expand ${name}` : `Collapse ${name}`;
}

export function RailToggle({
  side,
  collapsed,
  label,
  onToggle,
  className = "",
  style,
  onMouseDown,
}: {
  side: RailToggleSide;
  collapsed: boolean;
  /** Panel name used in title/aria-label (e.g. "Sidebar", "Context"). */
  label?: string;
  onToggle: () => void;
  className?: string;
  style?: CSSProperties;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}) {
  const title = railToggleLabel(collapsed, label);
  const chevron = railToggleChevron(side, collapsed);
  const direction = chevron === "›" ? "right" : "left";

  return (
    <button
      type="button"
      data-scout-rail-toggle=""
      data-side={side}
      data-direction={direction}
      data-collapsed={collapsed ? "true" : "false"}
      aria-expanded={!collapsed}
      aria-label={title}
      title={title}
      className={`scout-rail-toggle${className ? ` ${className}` : ""}`}
      style={style}
      onClick={onToggle}
      onMouseDown={onMouseDown}
    >
      <svg
        aria-hidden="true"
        className="scout-rail-toggle-glyph"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path
          d={direction === "right" ? "M6 4.5 9.5 8 6 11.5" : "M10 4.5 6.5 8l3.5 3.5"}
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
