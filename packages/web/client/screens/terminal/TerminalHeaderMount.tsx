import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const SCOUT_TERMINAL_HEADER_SLOT_ID = "scout-terminal-header-slot";

/**
 * Three places in the app's top row belong to the Terminals screen: the rest
 * of the reading line after "Terminals /" (workspace tabs), the centre of the
 * row (search), and the right-hand actions.
 */
export const SCOUT_TERMINAL_HEADER_SLOT_IDS = {
  crumb: "scout-terminal-header-crumb-slot",
  search: "scout-terminal-header-search-slot",
  actions: SCOUT_TERMINAL_HEADER_SLOT_ID,
} as const;

export type TerminalHeaderSlot = keyof typeof SCOUT_TERMINAL_HEADER_SLOT_IDS;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function findTerminalHeaderHost(slot: TerminalHeaderSlot): HTMLElement | null {
  return typeof document === "undefined"
    ? null
    : document.getElementById(SCOUT_TERMINAL_HEADER_SLOT_IDS[slot]);
}

/**
 * Put workspace controls in the app title row when it exists. Standalone and
 * legacy hosts keep the exact same controls in the terminal surface instead of
 * silently dropping task-completing actions.
 */
export function TerminalHeaderMount({
  slot = "actions",
  children,
}: {
  slot?: TerminalHeaderSlot;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(() => findTerminalHeaderHost(slot));

  useBrowserLayoutEffect(() => {
    setHost(findTerminalHeaderHost(slot));
  }, [slot]);

  const connectedHost = host?.isConnected ? host : null;
  return connectedHost
    ? createPortal(children, connectedHost)
    : (
        <div
          className={`s-term-inline-header s-term-inline-header--${slot}`}
          data-scout-terminal-header-fallback={slot}
        >
          {children}
        </div>
      );
}
