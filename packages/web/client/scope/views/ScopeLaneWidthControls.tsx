import type { AgentLaneWidthTier } from "../../screens/ops/lane-deck.ts";

const WIDTH_OPTIONS: AgentLaneWidthTier[] = ["sm", "md", "lg"];

const GRID_LABELS: Record<AgentLaneWidthTier, string> = {
  sm: "¼",
  md: "½",
  lg: "full",
};

const GRID_TITLES: Record<AgentLaneWidthTier, string> = {
  sm: "Quarter row",
  md: "Half row",
  lg: "Full row",
};

export type ScopeLaneWidthVariant = "tier" | "grid";

export function ScopeLaneWidthControls({
  value,
  defaultValue,
  onChange,
  compact = false,
  label = "Lane width",
  variant = "tier",
}: {
  value: AgentLaneWidthTier | number | undefined;
  defaultValue: AgentLaneWidthTier;
  onChange: (width: AgentLaneWidthTier) => void;
  compact?: boolean;
  label?: string;
  variant?: ScopeLaneWidthVariant;
}) {
  const activeTier = typeof value === "string" ? value : defaultValue;
  const gridMode = variant === "grid";

  return (
    <div
      className={`scope-lane-width${compact ? " is-compact" : ""}${gridMode ? " is-grid" : ""}`}
      role="group"
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {WIDTH_OPTIONS.map((tier) => (
        <button
          key={tier}
          type="button"
          className={`scope-lane-width__btn${activeTier === tier ? " is-on" : ""}`}
          aria-pressed={activeTier === tier}
          title={gridMode ? GRID_TITLES[tier] : `${tier.toUpperCase()} column width`}
          onClick={() => onChange(tier)}
        >
          {gridMode ? GRID_LABELS[tier] : tier}
        </button>
      ))}
    </div>
  );
}