import { useCallback, useEffect, useRef, useState } from "react";

import {
  AGENT_LANE_HORIZON_OPTIONS,
  type AgentLane,
  type AgentLaneHorizonKey,
} from "../../screens/ops/agent-lanes-model.ts";
import { isEditableTarget, isModalShortcutContext, nextListIndex } from "../../lib/keyboard-nav-core.ts";
import type { ObserveEvent } from "../../lib/types.ts";

type UseScopeLanesKeyboardInput = {
  lanes: AgentLane[];
  onOpenTrace: (lane: AgentLane, event?: ObserveEvent) => void;
  onHorizonChange: (horizon: AgentLaneHorizonKey) => void;
};

export function useScopeLanesKeyboard({
  lanes,
  onOpenTrace,
  onHorizonChange,
}: UseScopeLanesKeyboardInput) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const laneRefs = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    if (focusedIndex < 0) return;
    if (focusedIndex >= lanes.length) {
      setFocusedIndex(lanes.length - 1);
      return;
    }
    const lane = lanes[focusedIndex];
    if (!lane) return;
    const node = laneRefs.current.get(lane.id);
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
    node?.focus();
  }, [focusedIndex, lanes]);

  const registerLaneRef = useCallback((laneId: string, node: HTMLElement | null) => {
    if (node) laneRefs.current.set(laneId, node);
    else laneRefs.current.delete(laneId);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!document.querySelector(".scope-lanes")) return;
      if (isEditableTarget(event.target) || isModalShortcutContext()) return;
      if (lanes.length === 0) return;

      const horizonIndex = Number(event.key) - 1;
      if (
        !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && horizonIndex >= 0
        && horizonIndex < AGENT_LANE_HORIZON_OPTIONS.length
      ) {
        event.preventDefault();
        onHorizonChange(AGENT_LANE_HORIZON_OPTIONS[horizonIndex]!.key);
        return;
      }

      if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setFocusedIndex((current) => nextListIndex(current, lanes.length, 1));
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setFocusedIndex((current) => nextListIndex(current, lanes.length, -1));
        return;
      }
      if (event.key === "Home" || (event.key === "g" && !event.shiftKey)) {
        event.preventDefault();
        setFocusedIndex(0);
        return;
      }
      if (event.key === "End" || event.key === "G") {
        event.preventDefault();
        setFocusedIndex(lanes.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        const index = focusedIndex < 0 ? 0 : focusedIndex;
        const lane = lanes[index];
        if (!lane) return;
        event.preventDefault();
        setFocusedIndex(index);
        onOpenTrace(lane, lane.observe?.events?.at(-1));
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedIndex, lanes, onHorizonChange, onOpenTrace]);

  const getLaneFocusProps = useCallback((index: number, laneId: string) => ({
    "data-cursor": focusedIndex === index ? true : undefined,
    tabIndex: focusedIndex === index ? 0 as const : -1 as const,
    ref: (node: HTMLElement | null) => registerLaneRef(laneId, node),
    onFocus: () => setFocusedIndex(index),
  }), [focusedIndex, registerLaneRef]);

  return { focusedIndex, getLaneFocusProps };
}