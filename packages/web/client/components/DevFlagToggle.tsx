import "./dev-flag-toggle.css";

import { Flag } from "lucide-react";

import { isScoutDevToolsAvailable, useScoutDevFlagControls } from "../lib/use-scout-dev-flags.ts";
import type { ScoutFlagBundle } from "../lib/scout-flags.ts";

const BUNDLE_LABELS: Record<ScoutFlagBundle, string> = {
  "light-prod": "lean",
  "max-pro": "max",
  "scope-instrument": "scope",
};

export function DevFlagToggle({
  onOpenPanel,
}: {
  onOpenPanel: () => void;
}) {
  const { activeBundle, toggleBundle } = useScoutDevFlagControls();

  if (!isScoutDevToolsAvailable()) {
    return null;
  }

  return (
    <div className="scout-dev-flag">
      <button
        type="button"
        className="chip chip--mono chip--caps chip--sm chip--warning"
        title={`Experience bundle: ${activeBundle}. Click to flip lean/max.`}
        onClick={toggleBundle}
      >
        {BUNDLE_LABELS[activeBundle]}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm btn--icon"
        title="Open feature flags"
        aria-label="Open feature flags"
        onClick={onOpenPanel}
      >
        <Flag size={11} strokeWidth={1.8} />
      </button>
    </div>
  );
}
