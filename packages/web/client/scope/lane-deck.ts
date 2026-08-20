import type { AgentLaneHorizonKey } from "../screens/ops/agent-lanes-model.ts";
import {
  createLaneDeck,
  deserializeLaneDeck,
  saveLaneDeck,
  type AgentLaneWidthTier,
  type LaneDeckProfileDefaults,
  type LaneDeckState,
} from "../screens/ops/lane-deck.ts";

/** Scope instrument lane-deck storage partition — owned by scope/, not scout profiles. */
export const SCOPE_LANE_DECK_PROFILE = "scope.lanes" as const;

export const SCOPE_LANE_DECK_DEFAULTS: LaneDeckProfileDefaults = {
  defaultLaneWidth: "md",
  showAutoLanes: true,
  defaultHorizon: "30m",
};

const LANE_DECK_STORAGE_PREFIX = "openscout:lane-deck:v1";

export function createScopeLaneDeck(defaultWidth?: AgentLaneWidthTier): LaneDeckState {
  return createLaneDeck(SCOPE_LANE_DECK_PROFILE, defaultWidth, SCOPE_LANE_DECK_DEFAULTS);
}

export function loadScopeLaneDeck(fallbackWidth?: AgentLaneWidthTier): LaneDeckState {
  const widthFallback = fallbackWidth ?? SCOPE_LANE_DECK_DEFAULTS.defaultLaneWidth;
  try {
    const raw = localStorage.getItem(`${LANE_DECK_STORAGE_PREFIX}:${SCOPE_LANE_DECK_PROFILE}`);
    if (!raw) return createScopeLaneDeck(widthFallback);
    return deserializeLaneDeck(
      JSON.parse(raw),
      SCOPE_LANE_DECK_PROFILE,
      widthFallback,
      SCOPE_LANE_DECK_DEFAULTS,
    );
  } catch {
    return createScopeLaneDeck(widthFallback);
  }
}

export function saveScopeLaneDeck(deck: LaneDeckState): void {
  saveLaneDeck(deck);
}

export type { AgentLaneHorizonKey };