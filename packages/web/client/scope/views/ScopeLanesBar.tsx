import { AGENT_LANE_HORIZON_OPTIONS, type AgentLaneHorizonKey } from "../../screens/ops/agent-lanes-model.ts";
import type { AgentLaneWidthTier } from "../../screens/ops/lane-deck.ts";
import { ScopeLaneWidthControls } from "./ScopeLaneWidthControls.tsx";
import type { ScopeLaneLayoutMode } from "./useScopeLaneLayout.ts";

const LAYOUT_OPTIONS: Array<{ key: ScopeLaneLayoutMode; label: string }> = [
  { key: "swim", label: "swim" },
  { key: "grid", label: "grid" },
  { key: "floor", label: "floor" },
];

export function ScopeLanesBar({
  liveCount,
  horizon,
  horizonLabel,
  layoutMode,
  laneWidth,
  onHorizonChange,
  onLayoutChange,
  onLaneWidthChange,
}: {
  liveCount: number;
  horizon: AgentLaneHorizonKey;
  horizonLabel: string;
  layoutMode: ScopeLaneLayoutMode;
  laneWidth: AgentLaneWidthTier;
  onHorizonChange: (horizon: AgentLaneHorizonKey) => void;
  onLayoutChange: (layout: ScopeLaneLayoutMode) => void;
  onLaneWidthChange: (width: AgentLaneWidthTier) => void;
}) {
  const floorMode = layoutMode === "floor";

  return (
    <header className="scope-lanes-bar">
      <div className="scope-lanes-bar__summary">
        <span className="scope-lanes-bar__count">{liveCount} lane{liveCount === 1 ? "" : "s"}</span>
        <span className="scope-lanes-bar__window">
          {floorMode ? "past 30m · lanes 4h" : `window ${horizonLabel}`}
        </span>
      </div>
      <div className="scope-lanes-bar__controls">
        <div className="scope-lanes-bar__layouts" role="group" aria-label="Lane layout">
          {LAYOUT_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`scope-lanes-bar__layout${layoutMode === option.key ? " is-on" : ""}`}
              aria-pressed={layoutMode === option.key}
              onClick={() => onLayoutChange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {floorMode ? null : (
          <>
            <ScopeLaneWidthControls
              value={laneWidth}
              defaultValue={laneWidth}
              onChange={onLaneWidthChange}
              label="Default column width"
              variant={layoutMode === "grid" ? "grid" : "tier"}
            />
            <div className="scope-lanes-bar__horizons" role="group" aria-label="Activity window">
              {AGENT_LANE_HORIZON_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={`scope-lanes-bar__horizon${horizon === option.key ? " is-on" : ""}`}
                  aria-pressed={horizon === option.key}
                  onClick={() => onHorizonChange(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </header>
  );
}