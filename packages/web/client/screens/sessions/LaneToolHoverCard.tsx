import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  buildLaneToolDetailModel,
  laneToolHoverPreview,
  type LaneToolDetailModel,
} from "../../lib/lane-tool-detail.ts";
import type { ObserveEvent } from "../../lib/types.ts";

const HOVER_INTENT_MS = 140;
const HIDE_GRACE_MS = 100;
const CARD_WIDTH = 320;
const CARD_GAP = 4;
const VIEWPORT_PADDING = 8;
const CARET_SIZE = 7;

export type LaneToolHoverMeta = {
  wallLabel?: string;
  wallTitle?: string;
  sessionOffset?: string;
};

export type LaneToolHoverBindings = {
  ref: (el: HTMLDivElement | null) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
};

type CardSide = "left" | "right";

type CardPosition = {
  top: number;
  left: number;
  side: CardSide;
  caretTop: number;
};

function resolveToolAnchorRect(anchor: HTMLElement): DOMRect {
  const tool = anchor.querySelector<HTMLElement>(".s-observe-tool");
  return (tool ?? anchor).getBoundingClientRect();
}

function hoverPortalHost(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-scout-theme]") ?? document.body;
}

function positionsEqual(a: CardPosition | null, b: CardPosition | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top
    && a.left === b.left
    && a.side === b.side
    && a.caretTop === b.caretTop;
}

function computeCardPosition(anchor: DOMRect, cardHeight: number): CardPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchorCenterY = anchor.top + anchor.height / 2;

  const rightSpace = vw - anchor.right - VIEWPORT_PADDING;
  const leftSpace = anchor.left - VIEWPORT_PADDING;
  const fitsRight = rightSpace >= CARD_WIDTH + CARD_GAP;
  const fitsLeft = leftSpace >= CARD_WIDTH + CARD_GAP;

  let side: CardSide = "right";
  let left = anchor.right + CARD_GAP;
  let top = anchor.top;

  if (fitsRight) {
    side = "right";
    left = anchor.right + CARD_GAP;
  } else if (fitsLeft) {
    side = "left";
    left = anchor.left - CARD_GAP - CARD_WIDTH;
  } else {
    side = "right";
    left = Math.max(VIEWPORT_PADDING, Math.min(anchor.right + CARD_GAP, vw - CARD_WIDTH - VIEWPORT_PADDING));
    top = anchor.bottom + CARD_GAP;
  }

  if (top + cardHeight > vh - VIEWPORT_PADDING) {
    top = Math.max(VIEWPORT_PADDING, anchor.top - cardHeight + anchor.height);
  }
  top = Math.max(VIEWPORT_PADDING, Math.min(top, vh - cardHeight - VIEWPORT_PADDING));
  left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - CARD_WIDTH - VIEWPORT_PADDING));

  const caretTop = Math.max(
    CARET_SIZE + 4,
    Math.min(anchorCenterY - top, cardHeight - CARET_SIZE - 4),
  );

  return { top, left, side, caretTop };
}

function LaneToolHoverCardPanel({
  model,
  position,
  cardRef,
  onMouseEnter,
  onMouseLeave,
}: {
  model: LaneToolDetailModel;
  position: CardPosition;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const preview = laneToolHoverPreview(model);
  const whenField = model.hoverFields.find((field) => field.label === "when");
  const style: CSSProperties = {
    position: "fixed",
    top: position.top,
    left: position.left,
    width: CARD_WIDTH,
    maxWidth: CARD_WIDTH,
    ["--hover-caret-top" as string]: `${position.caretTop}px`,
  };

  return (
    <div
      ref={cardRef}
      className={`s-observe-tool-hover-card s-observe-tool-hover-card--side-${position.side}`}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="tooltip"
    >
      <div className="s-observe-tool-hover-card-cmd">{model.command}</div>
      {whenField && (
        <div className="s-observe-tool-hover-card-meta">{whenField.value}</div>
      )}
      {preview.slice(1).map((line, index) => (
        <div key={index} className="s-observe-tool-hover-card-line">{line}</div>
      ))}
      <div className="s-observe-tool-hover-card-hint">Click row for full detail</div>
    </div>
  );
}

/** One shared hover card for all lane tool rows in a trace stream. */
export function useLaneToolHoverCard(enabled = true): {
  bind: (event: ObserveEvent, meta: LaneToolHoverMeta) => LaneToolHoverBindings;
  card: ReactNode;
  hoveredEventId: string | null;
} {
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [position, setPosition] = useState<CardPosition | null>(null);

  const anchorsRef = useRef(new Map<string, HTMLDivElement>());
  const metaRef = useRef(new Map<string, LaneToolHoverMeta>());
  const eventsRef = useRef(new Map<string, ObserveEvent>());
  const bindingsRef = useRef(new Map<string, LaneToolHoverBindings>());
  const hoveredEventIdRef = useRef<string | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  hoveredEventIdRef.current = hoveredEventId;

  const clearTimers = useCallback(() => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    showTimerRef.current = null;
    hideTimerRef.current = null;
  }, []);

  const model = useMemo(() => {
    if (!enabled || !hoveredEventId) return null;
    const event = eventsRef.current.get(hoveredEventId);
    if (!event) return null;
    const meta = metaRef.current.get(hoveredEventId);
    return buildLaneToolDetailModel(event, meta);
  }, [enabled, hoveredEventId]);

  const commitPosition = useCallback((next: CardPosition | null) => {
    setPosition((prev) => (positionsEqual(prev, next) ? prev : next));
  }, []);

  const updatePosition = useCallback(() => {
    const activeId = hoveredEventIdRef.current;
    if (!activeId) {
      commitPosition(null);
      return;
    }
    const anchor = anchorsRef.current.get(activeId);
    if (!anchor) return;
    const rect = resolveToolAnchorRect(anchor);
    const cardHeight = cardRef.current?.offsetHeight ?? 132;
    commitPosition(computeCardPosition(rect, cardHeight));
  }, [commitPosition]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useLayoutEffect(() => {
    if (!hoveredEventId) {
      commitPosition(null);
      return;
    }
    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(frame);
  }, [hoveredEventId, commitPosition, updatePosition]);

  useEffect(() => {
    if (!hoveredEventId) return;
    const onLayout = () => updatePosition();
    window.addEventListener("scroll", onLayout, true);
    window.addEventListener("resize", onLayout);
    return () => {
      window.removeEventListener("scroll", onLayout, true);
      window.removeEventListener("resize", onLayout);
    };
  }, [hoveredEventId, updatePosition]);

  const scheduleShow = useCallback((eventId: string) => {
    if (!enabled) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    if (hoveredEventIdRef.current === eventId) return;
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    showTimerRef.current = setTimeout(() => {
      setHoveredEventId(eventId);
      showTimerRef.current = null;
    }, HOVER_INTENT_MS);
  }, [enabled]);

  const scheduleHide = useCallback(() => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
    if (!hoveredEventIdRef.current) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setHoveredEventId(null);
      hideTimerRef.current = null;
    }, HIDE_GRACE_MS);
  }, []);

  const bind = useCallback((event: ObserveEvent, meta: LaneToolHoverMeta): LaneToolHoverBindings => {
    eventsRef.current.set(event.id, event);
    metaRef.current.set(event.id, meta);

    let bindings = bindingsRef.current.get(event.id);
    if (!bindings) {
      const eventId = event.id;
      bindings = {
        ref: (el) => {
          if (el) anchorsRef.current.set(eventId, el);
          else anchorsRef.current.delete(eventId);
        },
        onMouseEnter: () => scheduleShow(eventId),
        onMouseLeave: scheduleHide,
        onFocus: () => scheduleShow(eventId),
        onBlur: scheduleHide,
      };
      bindingsRef.current.set(eventId, bindings);
    }
    return bindings;
  }, [scheduleShow, scheduleHide]);

  const card = enabled && model && position && typeof document !== "undefined"
    ? createPortal(
        <LaneToolHoverCardPanel
          model={model}
          position={position}
          cardRef={cardRef}
          onMouseEnter={() => {
            const activeId = hoveredEventIdRef.current;
            if (activeId) scheduleShow(activeId);
          }}
          onMouseLeave={scheduleHide}
        />,
        hoverPortalHost(),
      )
    : null;

  return { bind, card, hoveredEventId };
}