import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Agent, Route } from "../lib/types.ts";
import { AgentDetailCard } from "./AgentDetailCard.tsx";

type CardSide = "right" | "left" | "center";

type CardPosition = {
  top: number;
  left: number;
  side: CardSide;
};

export type SelectMode = "preview" | "navigate";

const CARD_WIDTH = 340;
const CARD_GAP = 16;
const SHOW_DELAY = 180;
const HIDE_DELAY = 100;
const SIDE_MIN_ROOM = CARD_WIDTH + CARD_GAP;

function computeCardPosition(anchor: DOMRect, cardHeight: number): CardPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const padding = 12;

  const rightSpace = vw - anchor.right;
  const leftSpace = anchor.left;

  if (rightSpace < SIDE_MIN_ROOM && leftSpace < SIDE_MIN_ROOM) {
    return {
      top: Math.max(padding, Math.min(vh / 2 - cardHeight / 2, vh - cardHeight - padding)),
      left: Math.max(padding, vw / 2 - CARD_WIDTH / 2),
      side: "center",
    };
  }

  const side: Exclude<CardSide, "center"> = rightSpace >= leftSpace ? "right" : "left";
  const left = side === "right"
    ? Math.min(anchor.right + CARD_GAP, vw - CARD_WIDTH - padding)
    : Math.max(anchor.left - CARD_GAP - CARD_WIDTH, padding);

  const center = anchor.top + anchor.height / 2;
  const idealTop = center - cardHeight / 2;
  const top = Math.max(padding, Math.min(idealTop, vh - cardHeight - padding));

  return { top, left, side };
}

export type AgentHoverCardOptions = {
  /** All agents (used to resolve ids → agent). */
  agents: Agent[];
  /** Ordered agent ids currently visible to the user — drives Arrow navigation. */
  orderedIds: string[];
  /** Scout navigate fn (for the "Open agent →" link and "o" hotkey). */
  navigate: (r: Route) => void;
  /** What a click on a row does. Default "preview" (pin card, no nav). */
  selectMode?: SelectMode;
};

export type RowBindings<E extends HTMLElement = HTMLElement> = {
  ref: (el: E | null) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: () => void;
  "data-agent-id": string;
  tabIndex: number;
};

export type AgentRowState = {
  isActive: boolean;
  isPinned: boolean;
};

export type UseAgentHoverCard = {
  /** Spread onto a row element to wire hover/focus/click/keyboard. */
  bind: <E extends HTMLElement = HTMLElement>(agentId: string) => RowBindings<E>;
  /** Get visual state flags for styling. */
  getState: (agentId: string) => AgentRowState;
  /** Whichever agent is currently being previewed (hovered or pinned). */
  activeAgent: Agent | null;
  /** The pinned agent, if any. */
  pinnedAgent: Agent | null;
  /** Imperatively clear hover + pin (e.g. external close button). */
  clear: () => void;
  /** Render this near the root of your component — it portals the card. */
  card: ReactNode;
  /** Attach to the scrollable container so keyboard events scope correctly. */
  containerRef: RefObject<HTMLDivElement | null>;
};

export function useAgentHoverCard({
  agents,
  orderedIds,
  navigate,
  selectMode = "preview",
}: AgentHoverCardOptions): UseAgentHoverCard {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [position, setPosition] = useState<CardPosition | null>(null);

  const anchorsRef = useRef(new Map<string, HTMLElement>());
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeId = pinnedId ?? hoveredId;
  const activeAgent = useMemo(
    () => (activeId ? agents.find((a) => a.id === activeId) ?? null : null),
    [activeId, agents],
  );
  const pinnedAgent = useMemo(
    () => (pinnedId ? agents.find((a) => a.id === pinnedId) ?? null : null),
    [pinnedId, agents],
  );

  const clearTimers = useCallback(() => {
    if (showTimerRef.current) { window.clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    if (hideTimerRef.current) { window.clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Recompute card position when active id or layout changes.
  useEffect(() => {
    if (!activeId) { setPosition(null); return; }
    const anchor = anchorsRef.current.get(activeId);
    if (!anchor) return;

    const recompute = () => {
      const rect = anchor.getBoundingClientRect();
      const cardH = cardRef.current?.offsetHeight ?? 260;
      setPosition(computeCardPosition(rect, cardH));
    };
    recompute();

    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    const ro = new ResizeObserver(recompute);
    if (cardRef.current) ro.observe(cardRef.current);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
      ro.disconnect();
    };
  }, [activeId]);

  // ESC unpins; click outside unpins.
  useEffect(() => {
    if (!pinnedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPinnedId(null); setHoveredId(null); }
    };
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target)) return;
      for (const el of anchorsRef.current.values()) {
        if (el.contains(target)) return;
      }
      setPinnedId(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDocClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDocClick);
    };
  }, [pinnedId]);

  const focusAgent = useCallback((id: string | undefined) => {
    if (!id) return;
    const el = anchorsRef.current.get(id);
    if (!el) return;
    if (typeof (el as HTMLElement).focus === "function") {
      (el as HTMLElement).focus({ preventScroll: false });
    }
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  // Keyboard scanning within container scope.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      const focusedAgentId = focused?.dataset?.agentId ?? null;
      const visible = orderedIds;
      if (visible.length === 0) return;

      const withinScope = root.contains(focused);
      if (!withinScope && e.key !== "Escape") return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const currentIdx = focusedAgentId ? visible.indexOf(focusedAgentId) : -1;
        const nextIdx = e.key === "ArrowDown"
          ? (currentIdx < 0 ? 0 : Math.min(currentIdx + 1, visible.length - 1))
          : (currentIdx <= 0 ? 0 : currentIdx - 1);
        focusAgent(visible[nextIdx]);
        return;
      }
      if (e.key === "Home") { e.preventDefault(); focusAgent(visible[0]); return; }
      if (e.key === "End") { e.preventDefault(); focusAgent(visible[visible.length - 1]); return; }
      if (e.key.toLowerCase() === "o" && focusedAgentId && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        navigate({ view: "agents-v2", agentId: focusedAgentId });
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [orderedIds, focusAgent, navigate]);

  const scheduleShow = useCallback((id: string) => {
    clearTimers();
    if (pinnedId && pinnedId !== id) return;
    if (hoveredId || pinnedId === id) {
      setHoveredId(id);
      return;
    }
    showTimerRef.current = window.setTimeout(() => {
      setHoveredId(id);
      showTimerRef.current = null;
    }, SHOW_DELAY);
  }, [clearTimers, hoveredId, pinnedId]);

  const scheduleHide = useCallback(() => {
    if (pinnedId) return;
    if (showTimerRef.current) { window.clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    hideTimerRef.current = window.setTimeout(() => {
      setHoveredId(null);
      hideTimerRef.current = null;
    }, HIDE_DELAY);
  }, [pinnedId]);

  const handleClick = useCallback((agentId: string) => {
    if (selectMode === "navigate") {
      navigate({ view: "agents-v2", agentId });
      return;
    }
    clearTimers();
    setPinnedId((prev) => (prev === agentId ? null : agentId));
    setHoveredId(agentId);
  }, [selectMode, navigate, clearTimers]);

  const handleOpen = useCallback(() => {
    if (!activeAgent) return;
    navigate({ view: "agents-v2", agentId: activeAgent.id });
  }, [activeAgent, navigate]);

  const clear = useCallback(() => {
    clearTimers();
    setPinnedId(null);
    setHoveredId(null);
  }, [clearTimers]);

  const bind = useCallback(<E extends HTMLElement = HTMLElement>(agentId: string): RowBindings<E> => ({
    ref: (el: E | null) => {
      if (el) anchorsRef.current.set(agentId, el as unknown as HTMLElement);
      else anchorsRef.current.delete(agentId);
    },
    onMouseEnter: () => scheduleShow(agentId),
    onMouseLeave: () => scheduleHide(),
    onFocus: () => scheduleShow(agentId),
    onBlur: () => scheduleHide(),
    onClick: () => handleClick(agentId),
    "data-agent-id": agentId,
    tabIndex: 0,
  }), [scheduleShow, scheduleHide, handleClick]);

  const getState = useCallback((agentId: string): AgentRowState => ({
    isActive: activeId === agentId,
    isPinned: pinnedId === agentId,
  }), [activeId, pinnedId]);

  const cardStyle: CSSProperties | undefined = position ? {
    position: "fixed",
    top: position.top,
    left: position.left,
    width: CARD_WIDTH,
  } : undefined;

  const card: ReactNode = activeAgent && position && typeof document !== "undefined"
    ? createPortal(
        <AgentDetailCard
          ref={cardRef}
          agent={activeAgent}
          pinned={pinnedId === activeAgent.id}
          onOpen={handleOpen}
          onClose={clear}
          onAction={clear}
          style={cardStyle}
          className={`agent-card--side-${position.side}${pinnedId === activeAgent.id ? "" : " agent-card--preview"}`}
        />,
        document.querySelector<HTMLElement>("[data-scout-theme]") ?? document.body,
      )
    : null;

  return { bind, getState, activeAgent, pinnedAgent, clear, card, containerRef };
}
