import { useEffect, useRef } from "react";

/** A poll that pauses with the tab and never overlaps itself. */
export function usePoll(run: () => Promise<void>, intervalMs: number, enabled: boolean) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let busy = false;
    const tick = () => {
      if (cancelled || busy) return;
      if (typeof document !== "undefined" && document.hidden) return;
      busy = true;
      void runRef.current().finally(() => {
        busy = false;
      });
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs]);
}
