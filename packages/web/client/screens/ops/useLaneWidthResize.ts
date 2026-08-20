import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  AGENT_LANE_WIDTH_MAX,
  AGENT_LANE_WIDTH_MIN,
  snapLaneWidthPx,
  type AgentLaneWidthTier,
} from "./lane-deck.ts";

type ResizeCommit = (laneId: string, width: AgentLaneWidthTier | number) => void;

export function useLaneWidthResize(onCommit: ResizeCommit) {
  const [resizingLaneId, setResizingLaneId] = useState<string | null>(null);
  const startRef = useRef<{ laneId: string; x: number; width: number }>({
    laneId: "",
    x: 0,
    width: 512,
  });
  const latestWidthRef = useRef<number>(512);

  const beginResize = useCallback((
    laneId: string,
    event: ReactPointerEvent<HTMLDivElement>,
    currentWidthPx: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = { laneId, x: event.clientX, width: currentWidthPx };
    latestWidthRef.current = currentWidthPx;
    setResizingLaneId(laneId);
    document.body.classList.add("s-agent-lanes--resizing-width");
  }, []);

  const endResize = useCallback(() => {
    setResizingLaneId((active) => {
      if (active) {
        document.body.classList.remove("s-agent-lanes--resizing-width");
        const snapped = snapLaneWidthPx(latestWidthRef.current);
        onCommit(startRef.current.laneId, snapped.tier ?? snapped.px);
      }
      return null;
    });
  }, [onCommit]);

  useEffect(() => {
    if (!resizingLaneId) return;

    const onMove = (event: PointerEvent) => {
      const delta = event.clientX - startRef.current.x;
      latestWidthRef.current = Math.min(
        AGENT_LANE_WIDTH_MAX,
        Math.max(AGENT_LANE_WIDTH_MIN, startRef.current.width + delta),
      );
      const lane = document.querySelector<HTMLElement>(`[data-lane-id="${startRef.current.laneId}"]`);
      if (lane) lane.style.setProperty("--lane-width", `${latestWidthRef.current}px`);
    };

    const onUp = () => endResize();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [endResize, resizingLaneId]);

  const resetLaneWidth = useCallback((laneId: string, fallback: AgentLaneWidthTier) => {
    onCommit(laneId, fallback);
    const lane = document.querySelector<HTMLElement>(`[data-lane-id="${laneId}"]`);
    lane?.style.removeProperty("--lane-width");
  }, [onCommit]);

  return { beginResize, resetLaneWidth, resizingLaneId };
}