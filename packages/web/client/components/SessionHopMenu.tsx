/**
 * SessionHopMenu — the "hop into terminal" affordance.
 *
 * One component, two shapes:
 *
 * - `<SessionHopMenu>` renders a single `Terminal` button that opens the hop
 *   destinations as a menu at the click point (dense lists, mastheads).
 * - `<SessionHopActions>` renders the destinations as an inline row for
 *   surfaces that already show a full-width action area (project session
 *   overview).
 *
 * Both resolve the session/agent hints through the shared inventory cache and
 * the protocol resolver, so every surface lands on the same terminal target.
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ExternalLink, SquareTerminal } from "lucide-react";

import { useContextMenu, type MenuItem } from "./ContextMenu.tsx";
import {
  getTerminalSessionInventory,
  herdrFocusableSurface,
  peekTerminalSessionInventory,
  requestHerdrPaneFocus,
  requestLocalTerminalOpen,
  resolveSessionTerminalTarget,
  subscribeTerminalSessionInventory,
  terminalHopDeepLink,
  terminalHopRoute,
  warmTerminalSessionInventory,
  type SessionTerminalHints,
  type SessionTerminalTarget,
} from "../lib/session-terminal-hop.ts";
import { openContent } from "../scout/slots/openContent.ts";
import type { Route } from "../lib/types.ts";

type Navigate = (route: Route, options?: { returnTo?: Route }) => void;

export function useSessionTerminalTarget(hints: SessionTerminalHints): {
  target: SessionTerminalTarget | null;
  /** True once the inventory answered at least once for these hints. */
  resolved: boolean;
} {
  const agentId = hints.agentId ?? null;
  const refsKey = useMemo(
    () => JSON.stringify((hints.sessionRefs ?? []).filter(Boolean)),
    [hints.sessionRefs],
  );
  const [state, setState] = useState<{
    key: string;
    resolved: boolean;
    target: SessionTerminalTarget | null;
  }>(() => {
    const peeked = peekTerminalSessionInventory();
    return {
      key: JSON.stringify([agentId, refsKey]),
      resolved: peeked !== null,
      target: peeked ? resolveSessionTerminalTarget(peeked, hints) : null,
    };
  });

  const key = JSON.stringify([agentId, refsKey]);
  useEffect(() => {
    let active = true;
    const update = () => {
      const sessions = peekTerminalSessionInventory();
      if (active && sessions) setState({ key, resolved: true, target: resolveSessionTerminalTarget(sessions, hints) });
    };
    const refresh = () => {
      void getTerminalSessionInventory().then((sessions) => {
        if (active) setState({ key, resolved: true, target: resolveSessionTerminalTarget(sessions, hints) });
      }).catch(() => {
        if (active) setState({ key, resolved: true, target: null });
      });
    };
    const unsubscribe = subscribeTerminalSessionInventory(update);
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => { active = false; unsubscribe(); window.clearInterval(interval); };
    // hints is reconstructed per render; key captures the semantic inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state.key === key
    ? { target: state.target, resolved: state.resolved }
    : { target: null, resolved: false };
}

/** Build the hop menu items for a resolved (or unresolved) context. */
export function sessionHopMenuItems(args: {
  target: SessionTerminalTarget | null;
  agentId?: string | null;
  navigate: Navigate;
  returnTo?: Route;
  onError?: (message: string) => void;
  /** Surfaces that already offer a web-terminal action pass false. */
  includeWeb?: boolean;
  /** Pass false when the caller merges items into a larger menu. */
  emptyFallback?: boolean;
}): MenuItem[] {
  const {
    target, agentId, navigate, returnTo, onError,
    includeWeb = true, emptyFallback = true,
  } = args;
  const items: MenuItem[] = [];

  const webRoute = includeWeb ? terminalHopRoute(target, agentId) : null;
  if (webRoute) {
    items.push({
      kind: "action",
      label: "Open in web terminal",
      onSelect: () => openContent(navigate, webRoute, { returnTo }),
    });
  }

  const deepLink = target ? terminalHopDeepLink(target) : null;
  if (deepLink) {
    items.push({
      kind: "action",
      label: "Open in Scout app",
      onSelect: () => window.open(deepLink, "_self"),
    });
  }

  if (target && herdrFocusableSurface(target)) {
    items.push({
      kind: "action",
      label: "Focus pane in Herdr",
      onSelect: () => {
        void requestHerdrPaneFocus(target).catch((error) =>
          onError?.(error instanceof Error ? error.message : "herdr focus failed"));
      },
    });
  } else if (target && target.surface.attachCommand.length > 0) {
    items.push({
      kind: "action",
      label: "Open in terminal app",
      onSelect: () => {
        void requestLocalTerminalOpen(target).catch((error) =>
          onError?.(error instanceof Error ? error.message : "could not open a terminal"));
      },
    });
  }

  if (items.length === 0 && emptyFallback) {
    items.push({ kind: "action", label: "No live terminal for this session", onSelect: () => {} });
  }
  return items;
}

export function SessionHopMenu({
  hints,
  navigate,
  returnTo,
  className,
  label = "Terminal",
}: {
  hints: SessionTerminalHints;
  navigate: Navigate;
  returnTo?: Route;
  className?: string;
  label?: string;
}) {
  const showContextMenu = useContextMenu();
  const { target } = useSessionTerminalTarget(hints);
  const targetRef = useRef(target);
  targetRef.current = target;
  const [error, setError] = useState<string | null>(null);

  const open = (event: MouseEvent) => {
    event.stopPropagation();
    showContextMenu(event, sessionHopMenuItems({
      target: targetRef.current,
      agentId: hints.agentId,
      navigate,
      returnTo,
      onError: setError,
    }));
  };

  return (
    <button
      type="button"
      className={className}
      title={error ?? "Hop into this session's terminal"}
      onMouseEnter={() => warmTerminalSessionInventory()}
      onClick={open}
    >
      <SquareTerminal size={12} strokeWidth={1.8} aria-hidden />
      {error ? "Terminal error" : label}
    </button>
  );
}

/**
 * Inline hop row for detail surfaces. Mirrors the project-inbox treatment:
 * a `backend · name` chip plus one control per destination, each shown only
 * when the surface supports it. Renders nothing when no hints could ever
 * resolve (no agentId and no refs), and a plain takeover button when only an
 * agent is known.
 */
export function SessionHopActions({
  hints,
  navigate,
  returnTo,
  className,
}: {
  hints: SessionTerminalHints;
  navigate: Navigate;
  returnTo?: Route;
  className?: string;
}) {
  const { target, resolved } = useSessionTerminalTarget(hints);
  const [error, setError] = useState<string | null>(null);

  const agentId = hints.agentId ?? null;
  const webRoute = terminalHopRoute(target, agentId);
  const deepLink = target ? terminalHopDeepLink(target) : null;
  if (!resolved && !webRoute) return null;
  if (!webRoute) return null;

  return (
    <div className={className} aria-label="terminal actions">
      {target ? (
        <span className="s-hop-target" title={`${target.surface.backend} · ${target.surface.sessionName}`}>
          {target.surface.backend} · {target.surface.sessionName}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => openContent(navigate, webRoute, { returnTo })}
      >
        Open in web terminal
      </button>
      {deepLink ? (
        <a href={deepLink}>
          Open in Scout app
          <ExternalLink size={11} strokeWidth={1.8} aria-hidden />
        </a>
      ) : null}
      {target && herdrFocusableSurface(target) ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            void requestHerdrPaneFocus(target).catch((err) =>
              setError(err instanceof Error ? err.message : "herdr focus failed"));
          }}
        >
          Focus in Herdr
        </button>
      ) : target && target.surface.attachCommand.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            void requestLocalTerminalOpen(target).catch((err) =>
              setError(err instanceof Error ? err.message : "could not open a terminal"));
          }}
        >
          Open in terminal app
        </button>
      ) : null}
      {error ? <span role="status">{error}</span> : null}
    </div>
  );
}
