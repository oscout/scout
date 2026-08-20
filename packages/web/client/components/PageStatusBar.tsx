import "./page-status-bar.css";
import { useEffect, useRef, useState } from "react";
import { usePageStatusState, type PageStatusHover } from "../lib/page-status.ts";

const FADE_OUT_MS = 220;

type Displayed = {
  hover: PageStatusHover | null;
  content: string | null;
};

export function PageStatusBar() {
  const live = usePageStatusState();
  const hasLive = Boolean(live.hover || live.content);

  const [displayed, setDisplayed] = useState<Displayed | null>(
    hasLive ? { hover: live.hover, content: live.content } : null,
  );
  const [phase, setPhase] = useState<"enter" | "show" | "leave" | "hidden">(
    hasLive ? "enter" : "hidden",
  );
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hasLive) {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      setDisplayed({ hover: live.hover, content: live.content });
      setPhase((prev) => (prev === "show" ? "show" : "enter"));
      const id = requestAnimationFrame(() => setPhase("show"));
      return () => cancelAnimationFrame(id);
    }
    setPhase("leave");
    leaveTimer.current = setTimeout(() => {
      setPhase("hidden");
      setDisplayed(null);
      leaveTimer.current = null;
    }, FADE_OUT_MS);
    return () => {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
    };
  }, [hasLive, live.hover, live.content]);

  if (phase === "hidden" || !displayed) return null;

  const hoverLabel = displayed.hover?.label ?? displayed.hover?.route ?? null;
  const hoverRoute = displayed.hover?.label && displayed.hover?.route ? displayed.hover.route : null;

  return (
    <div
      className={`s-page-status s-page-status--${phase}`}
      role="status"
      aria-live="polite"
    >
      <div className="s-page-status-left">
        {hoverLabel && (
          <>
            <span className="s-page-status-arrow" aria-hidden>→</span>
            <span className="s-page-status-target">{hoverLabel}</span>
            {hoverRoute && <span className="s-page-status-route">{hoverRoute}</span>}
          </>
        )}
      </div>
      <div className="s-page-status-right">
        {displayed.content && <span className="s-page-status-content">{displayed.content}</span>}
      </div>
    </div>
  );
}
