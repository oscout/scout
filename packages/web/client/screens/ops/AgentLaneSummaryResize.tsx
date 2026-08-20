import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export const LANE_SUMMARY_HEIGHT_STORAGE_KEY = "openscout:agent-lanes-cockpit-height";
const LEGACY_SUMMARY_HEIGHT_STORAGE_KEY = "openscout:agent-lanes-summary-height";
/** Cockpit overlay: status screen + tools/vitals row (below the pinned header). */
export const LANE_SUMMARY_HEIGHT_MIN = 48;
/** Hard ceiling — enough for status + pills + token dials, not much beyond. */
export const LANE_SUMMARY_HEIGHT_MAX = 220;
export const LANE_SUMMARY_HEIGHT_DEFAULT = 120;
/** Above this, unwrap status + reveal the token dial grid. */
export const LANE_COCKPIT_STATS_HEIGHT = 112;
/** Below this, clamp the status to a single glance line. */
export const LANE_COCKPIT_COMPACT_HEIGHT = 80;
/** Trace keeps at least this much vertical room while resizing. */
const LANE_TRACE_RESERVE_PX = 200;
/** Header + handle slack reserved from the lane column height. */
const LANE_COCKPIT_CHROME_RESERVE_PX = 112;

export function cockpitHeightMaxForLane(lane: HTMLElement | null): number {
  if (!lane) return LANE_SUMMARY_HEIGHT_MAX;
  const laneHeight = lane.getBoundingClientRect().height;
  const dynamic = Math.floor(
    laneHeight - LANE_COCKPIT_CHROME_RESERVE_PX - LANE_TRACE_RESERVE_PX,
  );
  return Math.max(
    LANE_SUMMARY_HEIGHT_MIN,
    Math.min(LANE_SUMMARY_HEIGHT_MAX, dynamic),
  );
}

export function cockpitHeightTier(
  height: number | null,
): "auto" | "compact" | "default" | "stats" {
  if (height === null) return "auto";
  if (height < LANE_COCKPIT_COMPACT_HEIGHT) return "compact";
  if (height < LANE_COCKPIT_STATS_HEIGHT) return "default";
  return "stats";
}

export function readStoredLaneSummaryHeight(): number | null {
  try {
    const raw = sessionStorage.getItem(LANE_SUMMARY_HEIGHT_STORAGE_KEY)
      ?? sessionStorage.getItem(LEGACY_SUMMARY_HEIGHT_STORAGE_KEY);
    if (!raw || raw === "auto") return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(LANE_SUMMARY_HEIGHT_MAX, Math.max(LANE_SUMMARY_HEIGHT_MIN, parsed));
  } catch {
    return null;
  }
}

export function writeStoredLaneSummaryHeight(height: number | null): void {
  try {
    if (height === null) {
      sessionStorage.setItem(LANE_SUMMARY_HEIGHT_STORAGE_KEY, "auto");
      return;
    }
    sessionStorage.setItem(LANE_SUMMARY_HEIGHT_STORAGE_KEY, String(Math.round(height)));
  } catch {
    // ignore storage failures
  }
}

export function useLaneSummaryResize(
  setSummaryHeight: (height: number | null) => void,
) {
  const [resizing, setResizing] = useState(false);
  const startRef = useRef<{ y: number; h: number; max: number }>({
    y: 0,
    h: LANE_SUMMARY_HEIGHT_DEFAULT,
    max: LANE_SUMMARY_HEIGHT_MAX,
  });
  const latestHeightRef = useRef<number | null>(null);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>, currentHeight: number | null) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const lane = event.currentTarget.closest(".s-agent-lane") as HTMLElement | null;
    const cockpit = lane?.querySelector<HTMLElement>(".s-agent-lane-cockpit");
    const measured = cockpit?.getBoundingClientRect().height ?? LANE_SUMMARY_HEIGHT_DEFAULT;
    const base = currentHeight ?? measured;
    const max = cockpitHeightMaxForLane(lane);

    startRef.current = { y: event.clientY, h: base, max };
    latestHeightRef.current = base;
    setResizing(true);
    document.body.classList.add("s-agent-lanes--resizing-summary");
  }, []);

  const endResize = useCallback(() => {
    setResizing((active) => {
      if (active) {
        document.body.classList.remove("s-agent-lanes--resizing-summary");
        writeStoredLaneSummaryHeight(latestHeightRef.current);
      }
      return false;
    });
  }, []);

  useEffect(() => {
    if (!resizing) return;

    const onMove = (event: PointerEvent) => {
      const delta = event.clientY - startRef.current.y;
      const next = Math.min(
        startRef.current.max,
        Math.max(LANE_SUMMARY_HEIGHT_MIN, startRef.current.h + delta),
      );
      latestHeightRef.current = next;
      setSummaryHeight(next);
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
  }, [endResize, resizing, setSummaryHeight]);

  const resetSummaryHeight = useCallback(() => {
    latestHeightRef.current = null;
    setSummaryHeight(null);
    writeStoredLaneSummaryHeight(null);
  }, [setSummaryHeight]);

  return { beginResize, resetSummaryHeight, resizing };
}

export function AgentLaneCockpitPane({
  cockpitHeight,
  children,
}: {
  cockpitHeight: number | null;
  children: ReactNode;
}) {
  const sized = cockpitHeight !== null;
  const tier = cockpitHeightTier(cockpitHeight);
  return (
    <div
      className={`s-agent-lane-cockpit${
        sized ? ` s-agent-lane-cockpit--sized s-agent-lane-cockpit--${tier}` : ""
      }`}
      style={sized ? { height: cockpitHeight, maxHeight: cockpitHeight } : undefined}
    >
      {children}
    </div>
  );
}

export function AgentLaneSummaryResizeHandle({
  onResizeStart,
  onReset,
  active,
}: {
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onReset: () => void;
  active?: boolean;
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize tools panel"
      title="Drag to resize tools panel · double-click to reset"
      aria-valuemin={LANE_SUMMARY_HEIGHT_MIN}
      aria-valuemax={LANE_SUMMARY_HEIGHT_MAX}
      className={`s-agent-lane-split${active ? " s-agent-lane-split--active" : ""}`}
      onPointerDown={onResizeStart}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReset();
      }}
    />
  );
}