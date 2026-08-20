import { useEffect, useRef, useState } from "react";
import {
  MOTION_EXIT_MS,
  type OverlayPhase,
  nextOverlayPhase,
} from "./overlay-phase.ts";

/** React bindings for the overlay phase machine.
 *
 * The machine itself lives in `overlay-phase.ts`, with no React import, so it
 * can be unit-tested without a renderer. This module is only the wiring:
 * mounting, the unmount timer, and the Reduced Motion read.
 *
 * Re-exported so call sites have one import for the whole motion system. */
export {
  MOTION_ENTER_MS,
  MOTION_EXIT_MS,
  MOTION_QUICK_MS,
  type OverlayEvent,
  type OverlayPhase,
  nextOverlayPhase,
} from "./overlay-phase.ts";

/** True when the operator has asked the system to keep motion to a minimum.
 *
 * The stylesheet already neutralises every animation and transition through one
 * global `prefers-reduced-motion` switch. This hook exists for the part CSS
 * cannot reach: the unmount timer. Without it a dismissed overlay would sit
 * invisible-but-mounted for the exit duration, which reads as lag. */
export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Keeps an overlay mounted through its exit.
 *
 * `rendered` says whether to put the element in the tree at all; `phase` is what
 * the CSS keys off. Under Reduced Motion the exit is instant, so the element
 * leaves on the same tick the operator dismissed it. */
export function useOverlayPresence(open: boolean, exitMs: number = MOTION_EXIT_MS) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<OverlayPhase>(open ? "open" : "closed");

  useEffect(() => {
    if (open) {
      setPhase((current) => nextOverlayPhase(current, "open"));
      return;
    }
    let cancelled = false;
    setPhase((current) => nextOverlayPhase(current, "close"));
    const finish = () => {
      if (!cancelled) setPhase((current) => nextOverlayPhase(current, "exit-finished"));
    };
    if (reduced || exitMs <= 0) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, exitMs);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, exitMs, reduced]);

  return { phase, rendered: phase !== "closed", closing: phase === "closing" };
}

/** Holds the last non-empty value for as long as the overlay is on screen.
 *
 * An overlay that animates out still has to draw something during its exit, but
 * the state that produced it (the focused message id, say) is already gone — the
 * dismissal is what cleared it. This remembers what was there so the exit shows
 * the thing being dismissed rather than blanking a frame before it. */
export function useRetainedValue<T>(value: T | null | undefined, rendered: boolean): T | null {
  const held = useRef<T | null>(value ?? null);
  if (value != null) held.current = value;
  else if (!rendered) held.current = null;
  return value ?? held.current;
}
