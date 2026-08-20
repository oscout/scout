import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useOptionalFlag } from "hudsonkit/flags";
import { useScout } from "../Provider.tsx";
import { resolveRightPane } from "../../screens/resolve-panes.tsx";
import { ScoutbotPanel } from "../scoutbot/ScoutbotPanel.tsx";
import { BrokerRight } from "../../screens/broker/right.tsx";
import { OpsRight } from "../../screens/ops/inspector-panel.tsx";
import { usePersistentBoolean, usePersistentNumber } from "../../lib/persistent-state.ts";
import { VerticalResizeHandle } from "./VerticalResizeHandle.tsx";
import type { Route } from "../../lib/types.ts";

const SCOUTBOT_MIN_HEIGHT = 260;
const SCOUTBOT_MAX_HEIGHT_RATIO = 0.7;
const SCOUTBOT_DEFAULT_HEIGHT = 260;

function clampScoutbotHeight(value: number, inspectorHeight: number) {
  const max = Math.max(SCOUTBOT_MIN_HEIGHT, Math.floor(inspectorHeight * SCOUTBOT_MAX_HEIGHT_RATIO));
  return Math.min(max, Math.max(SCOUTBOT_MIN_HEIGHT, Math.round(value)));
}

export function ScoutInspector() {
  const scoutbotEnabled = useOptionalFlag("surface.scoutbot", true);
  const { route, navigate, agents, selectedBrokerAttempt, clearBrokerAttempt } = useScout();
  const [scoutbotCollapsed] = usePersistentBoolean("openscout.scoutbot.collapsed", true);
  const [scoutbotHeight, setScoutbotHeight] = usePersistentNumber("openscout.scoutbot.height", SCOUTBOT_DEFAULT_HEIGHT);
  const containerRef = useRef<HTMLDivElement>(null);
  const [inspectorHeight, setInspectorHeight] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setInspectorHeight(el.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setInspectorHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (inspectorHeight <= 0) return;
    const next = clampScoutbotHeight(scoutbotHeight, inspectorHeight);
    if (next !== scoutbotHeight) {
      setScoutbotHeight(next);
    }
  }, [inspectorHeight, scoutbotHeight, setScoutbotHeight]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const startY = event.clientY;
      const startHeight = scoutbotHeight;
      const containerHeight = containerRef.current?.getBoundingClientRect().height ?? inspectorHeight;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY;
        setScoutbotHeight(clampScoutbotHeight(startHeight - delta, containerHeight));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };

      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [inspectorHeight, scoutbotHeight, setScoutbotHeight],
  );

  let content: ReactNode = null;
  const scoutbotAsInspector = scoutbotEnabled && route.view === "ops" && route.mode === "lanes";

  if (scoutbotAsInspector) {
    content = <ScoutbotPanel forceExpanded fill />;
  } else {
    switch (route.view) {
      case "ops":
        content = (
          <OpsRight
            mode={route.mode ?? "mission"}
            agents={agents}
            navigate={navigate}
            returnRoute={route}
          />
        );
        break;
      case "broker":
        content = (
          <BrokerRight
            selectedAttempt={selectedBrokerAttempt}
            navigate={navigate}
            onClose={clearBrokerAttempt}
          />
        );
        break;
      default:
        content = resolveRightPane(route, navigate);
    }
  }

  const clampedScoutbotHeight = inspectorHeight > 0
    ? clampScoutbotHeight(scoutbotHeight, inspectorHeight)
    : scoutbotHeight;
  // Dispatch owns its own bottom-anchored forwarding composer. Mounting the
  // global Scout panel here would create a second competing composer.
  const showScoutbot = scoutbotEnabled && route.view !== "broker";

  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        {content}
      </div>
      {showScoutbot && !scoutbotAsInspector && !scoutbotCollapsed && <VerticalResizeHandle onResizeStart={handleResizeStart} />}
      {showScoutbot && !scoutbotAsInspector && <ScoutbotPanel height={scoutbotCollapsed ? undefined : clampedScoutbotHeight} />}
    </div>
  );
}
