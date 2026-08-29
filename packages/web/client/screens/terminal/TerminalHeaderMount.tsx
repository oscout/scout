import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const SCOUT_TERMINAL_HEADER_SLOT_ID = "scout-terminal-header-slot";

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function findTerminalHeaderHost(): HTMLElement | null {
  return typeof document === "undefined"
    ? null
    : document.getElementById(SCOUT_TERMINAL_HEADER_SLOT_ID);
}

/**
 * Put workspace controls in the app title row when it exists. Standalone and
 * legacy hosts keep the exact same controls in the terminal surface instead of
 * silently dropping task-completing actions.
 */
export function TerminalHeaderMount({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(findTerminalHeaderHost);

  useBrowserLayoutEffect(() => {
    setHost(findTerminalHeaderHost());
  }, []);

  const connectedHost = host?.isConnected ? host : null;
  return connectedHost
    ? createPortal(children, connectedHost)
    : (
        <div
          className="s-term-inline-header"
          data-scout-terminal-header-fallback=""
        >
          {children}
        </div>
      );
}
