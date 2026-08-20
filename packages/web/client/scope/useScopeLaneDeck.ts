import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addFilterLane,
  clearPinnedLanes,
  isLanePinned,
  lanePinnedZone,
  pinSessionLane,
  removeSessionPin,
  setDefaultLaneWidth,
  setLaneWidthOverride,
  type AgentLaneWidthTier,
  type LaneDeckState,
  type LaneDeckZone,
} from "../screens/ops/lane-deck.ts";
import { resolveLaneDeckLayout, type LaneDeckLayout } from "../screens/ops/lane-deck-layout.ts";
import { lanePrimaryLabel, type AgentLane } from "../screens/ops/agent-lanes-model.ts";
import {
  loadScopeLaneDeck,
  saveScopeLaneDeck,
  SCOPE_LANE_DECK_PROFILE,
} from "./lane-deck.ts";

export function useScopeLaneDeck(
  defaultWidthTier: AgentLaneWidthTier,
  autoLanes: AgentLane[],
): {
  deck: LaneDeckState;
  layout: LaneDeckLayout;
  pinLane: (lane: AgentLane, zone?: LaneDeckZone) => void;
  unpinLane: (laneId: string) => void;
  setLaneWidth: (laneId: string, width: AgentLaneWidthTier | number) => void;
  setDefaultLaneWidth: (width: AgentLaneWidthTier) => void;
  addHarnessLane: (harness: string, title?: string) => void;
  addAttentionLane: () => void;
  clearPins: () => void;
  isPinned: (laneId: string) => boolean;
  pinnedZone: (laneId: string) => LaneDeckZone | null;
} {
  const [deck, setDeck] = useState<LaneDeckState>(() => loadScopeLaneDeck(defaultWidthTier));

  useEffect(() => {
    setDeck(loadScopeLaneDeck(defaultWidthTier));
  }, [defaultWidthTier]);

  const persist = useCallback((next: LaneDeckState) => {
    saveScopeLaneDeck(next);
    setDeck(next);
  }, []);

  const layout = useMemo(
    () => resolveLaneDeckLayout({ autoLanes, deck, defaultWidthTier }),
    [autoLanes, deck, defaultWidthTier],
  );

  const pinLane = useCallback((lane: AgentLane, zone: LaneDeckZone = "pinned_left") => {
    persist(pinSessionLane(deck, {
      laneId: lane.id,
      title: lanePrimaryLabel(lane.agent, lane.source),
      zone,
      width: deck.laneWidths[lane.id],
    }));
  }, [deck, persist]);

  const unpinLane = useCallback((laneId: string) => {
    persist(removeSessionPin(deck, laneId));
  }, [deck, persist]);

  const setLaneWidth = useCallback((laneId: string, width: AgentLaneWidthTier | number) => {
    persist(setLaneWidthOverride(deck, laneId, width));
  }, [deck, persist]);

  const setDefaultLaneWidthTier = useCallback((width: AgentLaneWidthTier) => {
    persist(setDefaultLaneWidth(deck, width));
  }, [deck, persist]);

  const addHarnessLane = useCallback((harness: string, title?: string) => {
    persist(addFilterLane(deck, {
      kind: "harness",
      title: title ?? `${harness} sessions`,
      harness,
      zone: "pinned_left",
      width: deck.defaultLaneWidth,
    }));
  }, [deck, persist]);

  const addAttentionLane = useCallback(() => {
    persist(addFilterLane(deck, {
      kind: "attention",
      title: "Needs attention",
      zone: "pinned_left",
      width: "sm",
    }));
  }, [deck, persist]);

  const clearPins = useCallback(() => {
    persist(clearPinnedLanes(deck));
  }, [deck, persist]);

  const isPinned = useCallback((laneId: string) => isLanePinned(deck, laneId), [deck]);
  const pinnedZone = useCallback((laneId: string) => lanePinnedZone(deck, laneId), [deck]);

  return {
    deck,
    layout,
    pinLane,
    unpinLane,
    setLaneWidth,
    setDefaultLaneWidth: setDefaultLaneWidthTier,
    addHarnessLane,
    addAttentionLane,
    clearPins,
    isPinned,
    pinnedZone,
  };
}

export { SCOPE_LANE_DECK_PROFILE };