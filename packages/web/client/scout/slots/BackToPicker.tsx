import { useMemo } from "react";
import type { Route } from "../../lib/types.ts";
import {
  readReturnToFromState,
  shouldUseHistoryBack,
  useBrowserLocation,
} from "../../lib/router.ts";
import type { NavReturnSlot } from "../../lib/nav-return.ts";
import "./back-to-picker.css";

type Props = {
  slot: NavReturnSlot;
  /** Where to go when no returnTo was set (or when the user opens the detail directly). */
  fallback: Route;
  navigate: (route: Route) => void;
  /** Optional class so individual screens can tweak placement. */
  className?: string;
  /** Optional label override; otherwise derived from the destination. */
  label?: string;
};

function defaultLabel(route: Route): string {
  switch (route.view) {
    case "mesh":
      return "Back to mesh";
    case "ops":
      return "Back to ops";
    case "agents-v2":
      return route.agentId ? "Registry" : "All agents";
    case "messages":
      return "Back to conversations";
    case "conversation":
      return "Back to conversation";
    case "inbox":
      return "Back to inbox";
    case "sessions":
      return "Back to sessions";
    case "terminal":
      return "Terminal Control";
    case "work":
      return "Back to work";
    case "broker":
      return "Back to broker";
    case "activity":
      return "Back to activity";
    default:
      return "Back";
  }
}

export function BackToPicker({ slot: _slot, fallback, navigate, className, label }: Props) {
  // Slot is retained for call-site compatibility; returnTo now lives on the
  // history entry (SCO-082 Phase B) rather than a per-slot sessionStorage map.
  void _slot;
  const location = useBrowserLocation();
  const returnTo = useMemo(
    () => readReturnToFromState(location.state),
    [location.state],
  );
  const target: Route = returnTo ?? fallback;
  const resolvedLabel = label ?? defaultLabel(target);
  const useHistory = shouldUseHistoryBack(location.state) && Boolean(returnTo);

  return (
    <button
      type="button"
      className={`s-back-pill${className ? ` ${className}` : ""}`}
      onClick={() => {
        if (useHistory && typeof window !== "undefined" && window.history.length > 1) {
          window.history.back();
          return;
        }
        navigate(target);
      }}
    >
      <span aria-hidden className="s-back-pill-glyph">←</span>
      <span>{resolvedLabel}</span>
    </button>
  );
}
