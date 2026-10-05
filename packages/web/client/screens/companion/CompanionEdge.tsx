import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { castSlugForAgent } from "../../components/AgentAvatar.tsx";
import { ScoutMark } from "../../components/ScoutMark.tsx";
import { SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import {
  beginFigureDrag,
  companionHostAvailable,
  onCompanionAnchors,
  onCompanionFigureDrag,
  onCompanionPointer,
  reportCompanionHitRegions,
  setCompanionEngaged,
  type CompanionAnchorUpdate,
  type CompanionEdgeAnchor,
  type CompanionEdgeGeometry,
  type CompanionFigure,
  type CompanionFigureDefaults,
  type CompanionFigureDrag,
  type CompanionFigureMotion,
  type CompanionFigurePatch,
  type CompanionHitRegion,
} from "../../lib/companion-host.ts";
import { CREW_ART, crewAssetUrl, poseAsset, projectHue, type PoseName } from "../../lib/crew-registry.ts";
import type { Agent } from "../../lib/types.ts";
import { useOptionalScout } from "../../scout/Provider.tsx";
import { pruneKeys } from "./companion-data.ts";
import { clockLabel, type CompanionCardState } from "./companion-model.ts";
import {
  ARRIVAL_MS,
  EDGE_FIGURE,
  EDGE_HOME_SLOT,
  EDGE_MARGIN,
  EDGE_SLOT,
  EDGE_SLOT_HEIGHT,
  EDGE_VISIBLE_LABEL,
  HOP_MS,
  STEP_MS,
  detectArrivals,
  edgeVisible,
  nextExpiry,
  pruneExpired,
  exactDiffers,
  exactLabel,
  freeSpans,
  originGroups,
  popoverLeft,
  solveEdge,
  spreadPins,
  stepTarget,
  type EdgeVisible,
} from "./edge-model.ts";
import { WorkInstrument } from "./WorkInstrument.tsx";
import {
  FIGURE_FALL_MS,
  FIGURE_MOTIONS,
  FIGURE_MOTION_LABEL,
  FIGURE_SIZE_PRESETS,
  figureMotion,
  figureNudge,
  figureBox,
  figureHasPlate,
  figureSize,
  figureSlot,
  figureWhere,
  hiddenFigures,
  isFigureClick,
  placedPopover,
  workPopoverSpot,
} from "./figure-model.ts";

/** One piece of work on the edge: a pin, or work a grant surfaced. */
export type EdgeWork = {
  workId: string;
  title: string;
  state: CompanionCardState | undefined;
  kind: "pinned" | "surfaced";
  agent: Agent | undefined;
  /** Owner name when the agent is not in the roster. */
  ownerName: string | null;
  conversationId: string | null;
  lastActivityAt: number;
  /** Set only with real remote provenance: the node the work runs on. */
  visitorFrom: string | null;
  /** Surfaced work: the grant that let it in ("via Hudson"). */
  origin: string | null;
  /** What the work last said: the reported headline, or what was observed. */
  report: string | null;
  harness: string | null;
};

type Arrival = { kind: "chute" | "visitor"; at: number; until: number };
type Walk = { target: number; n: number; until: number; facing: "left" | "right" };

const POP_WIDTH = 348;

/** Drops entries once their `until` passes, on a timer to the earliest one. */
function useExpiry<T extends { until: number }>(map: Map<string, T>, set: (update: (prev: Map<string, T>) => Map<string, T>) => void) {
  useEffect(() => {
    const at = nextExpiry(map);
    if (at === null) return;
    const timer = setTimeout(() => set((prev) => pruneExpired(prev, Date.now())), Math.max(0, at - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [map, set]);
}
const SETTLE_MS = 4000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useViewport(geometry: CompanionEdgeGeometry | null): { width: number; height: number } {
  const read = () => ({
    width: typeof window === "undefined" ? geometry?.width ?? 1200 : window.innerWidth || geometry?.width || 1200,
    height: typeof window === "undefined" ? geometry?.height ?? 470 : window.innerHeight || geometry?.height || 470,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const update = () => setSize(read());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
    // geometry changes resize the panel; the resize event follows.
  }, [geometry?.width, geometry?.height]);
  return size;
}

export function StatePlate({ visible }: { visible: EdgeVisible }) {
  switch (visible) {
    case "needs":
      return (
        <svg className="ce-plate is-ask" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5.5" />
          <path d="M6 3.1v3.7" />
          <circle cx="6" cy="8.8" r=".8" className="is-dot" />
        </svg>
      );
    case "done":
      return (
        <svg className="ce-plate" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5.5" />
          <path d="m3.7 6.2 1.6 1.6 3-3.4" />
        </svg>
      );
    case "disconnected":
      return (
        <svg className="ce-plate is-offline" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5.25" />
          <path d="M3.4 8.6 8.6 3.4" />
        </svg>
      );
    default:
      return null;
  }
}

/**
 * The character itself: the agent's crew member (or its generative sprite).
 * Poses are personality, never state; the plate and stance carry state.
 */
function EdgeCharacter({
  slug,
  name,
  state,
  offline,
  size = EDGE_FIGURE,
  walking = false,
  stride = 0,
  facing = "right",
  onEdge = false,
  hop = false,
  reduced = false,
}: {
  slug: string | undefined;
  name: string;
  state: CompanionCardState | undefined;
  offline: boolean;
  size?: number;
  walking?: boolean;
  stride?: 0 | 1;
  facing?: "left" | "right";
  onEdge?: boolean;
  hop?: boolean;
  reduced?: boolean;
}) {
  const visible = edgeVisible(state, offline);
  // Geometry follows the underlying reading, so a dropped link freezes figures where they stood.
  const sunk = onEdge && edgeVisible(state, false) === "resting";
  const art = slug ? CREW_ART[slug] : undefined;
  const pose: PoseName | "rest" = walking ? (stride ? "run-b" : "run-a") : visible === "done" ? "wave" : "rest";
  const width = art ? Math.round((size * art.w) / art.h) : size;
  const classes = [
    "ce-fig",
    `is-${visible}`,
    walking && !reduced ? "is-moving" : "",
    reduced ? "is-reduced" : "",
    onEdge ? "on-edge" : "",
    sunk ? "is-sunk" : "",
    hop && !reduced ? "is-hop" : "",
  ].filter(Boolean).join(" ");
  return (
    <span className={classes} data-facing={facing} style={{ "--fig": `${size}px` } as CSSProperties} aria-hidden="true">
      <span className="ce-fig__body" style={{ width, height: size }}>
        {art && slug
          ? <img className="ce-fig__art" src={crewAssetUrl(poseAsset(slug, pose))} alt="" draggable={false} />
          : <span className="ce-fig__sprite"><SpriteAvatar name={name} size={Math.round(size * 0.86)} /></span>}
        <span className="ce-fig__plate"><StatePlate visible={visible} /></span>
      </span>
    </span>
  );
}

function Canopy({ hue }: { hue: number }) {
  return (
    <svg className="ce-canopy" viewBox="0 0 28 22" style={{ "--hue": hue } as CSSProperties} aria-hidden="true">
      <path className="ce-canopy__lines" d="M3 9 14 21M25 9 14 21M10 8 14 21M18 8 14 21" />
      <path className="ce-canopy__dome" d="M2 9.5C3 3.5 8 1 14 1s11 2.5 12 8.5c-1.6-1-3.2-1-4.6 0-1.6-1-3.4-1-5 0-1.6-1-3.2-1-4.8 0-1.6-1-3.4-1-5 0-1.4-1-3-1-4.6 0Z" />
    </svg>
  );
}

export type CompanionEdgeProps = {
  works: EdgeWork[];
  geometry: CompanionEdgeGeometry | null;
  anchor: CompanionEdgeAnchor;
  originPins: boolean;
  offline: boolean;
  lastSync: number | null;
  refTime: number;
  /** True once the first read finished, so arrivals are only real ones. */
  ready: boolean;
  /** Whether the panel is on screen; nothing animates or reports while hidden. */
  visible: boolean;
  hostError: string | null;
  renderSettings: () => ReactNode;
  onSelect: (workId: string | null) => void;
  onOpenSurfaced: (target: "work" | "thread", work: EdgeWork) => void;
  onPinSurfaced: (work: EdgeWork) => void;
  onOpenThread: (conversationId: string, workId: string) => void;
  onOpenPinned: (target: "work" | "thread", work: EdgeWork) => void;
  onUnpin: (workId: string) => void;
  /** One per pin; surfaced work has no figure settings. */
  figures: CompanionFigure[];
  figureDefaults: CompanionFigureDefaults;
  onFigure: (workId: string, patch: CompanionFigurePatch) => void;
  onFigureNudge: (workId: string, dx: number, dy: number) => void;
  onFigureDefaults: (patch: Partial<CompanionFigureDefaults>) => void;
  onFiguresHome: () => void;
};

/**
 * The hex dock plate a held figure rests against: 1px, centred on the edge
 * line, on the figure's edge side. Drawn inside the figure's button so it
 * moves with it; it takes no pointer.
 */
function HexPlate({ side }: { side: "top" | "left" | "right" }) {
  // Flat side toward the figure: flat-topped under an edge, pointy-topped on a side.
  return side === "top" ? (
    <svg className="ce-hex is-top" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
      <path d="M3.75 0.5h6.5L13.5 6l-3.25 5.5h-6.5L0.5 6z" />
      <circle cx="7" cy="6" r="1.4" />
    </svg>
  ) : (
    <svg className={`ce-hex is-${side}`} width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <path d="M6 0.5l5.5 3.25v6.5L6 13.5 0.5 10.25v-6.5z" />
      <circle cx="6" cy="7" r="1.4" />
    </svg>
  );
}

export function CompanionEdge({
  works,
  geometry,
  anchor,
  originPins,
  offline,
  lastSync,
  refTime,
  ready,
  visible,
  hostError,
  renderSettings,
  onSelect,
  onOpenSurfaced,
  onPinSurfaced,
  onOpenThread,
  onOpenPinned,
  onUnpin,
  figures,
  figureDefaults,
  onFigure,
  onFigureNudge,
  onFigureDefaults,
  onFiguresHome,
}: CompanionEdgeProps) {
  const scout = useOptionalScout();
  const hosted = companionHostAvailable();
  const reduced = usePrefersReducedMotion();
  // The panel covers the whole display; the home row lives in the band by the
  // mark. Without the host (browser preview) the band is the whole window.
  const screen = useViewport(geometry);
  const band = geometry?.band ?? { x: 0, y: 0, width: screen.width, height: screen.height };
  const { width, height } = band;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Figures you place. The host sends anchors up to 15 times a second while a
  // figure rides on a window; between full state pushes they override.
  const [liveAnchors, setLiveAnchors] = useState<CompanionAnchorUpdate["anchors"]>(new Map());
  // A state push carries the anchors as of that moment, so it replaces them.
  // Keyed by content: the parent rebuilds the array on every render.
  const pushedAnchors = JSON.stringify(figures.map((figure) => [figure.workId, figure.placement, figure.anchor, figure.label]));
  useEffect(() => { setLiveAnchors(new Map()); }, [pushedAnchors]);
  const [falling, setFalling] = useState<Map<string, { until: number }>>(new Map());
  const [drag, setDrag] = useState<Extract<CompanionFigureDrag, { workId: string }> | null>(null);
  const press = useRef<{ id: string; x: number; y: number } | null>(null);
  const figureById = useMemo(() => {
    const out = new Map<string, CompanionFigure>();
    for (const figure of figures) {
      const live = liveAnchors.get(figure.workId);
      out.set(figure.workId, live ? { ...figure, anchor: figure.placement.kind === "home" ? null : live.anchor, label: live.label ?? figure.label } : figure);
    }
    return out;
  }, [figures, liveAnchors]);
  const motionOf = (workId: string): CompanionFigureMotion => figureMotion(figureById.get(workId), figureDefaults, reduced);
  const sizeOf = (workId: string): number => figureSize(figureById.get(workId), figureDefaults);

  // Popover state: only a click opens a figure's popover. Passing the
  // pointer over the crew on the way to the Dock or menubar opens nothing.
  const [kept, setKept] = useState<string | null>(null);
  const [panel, setPanel] = useState<"settings" | "overflow" | `pin:${string}` | null>(null);
  const stepCount = useRef(new Map<string, number>());

  const [arrivals, setArrivals] = useState<Map<string, Arrival>>(new Map());
  const [walks, setWalks] = useState<Map<string, Walk>>(new Map());
  const [hops, setHops] = useState<Map<string, { until: number }>>(new Map());
  const [stride, setStride] = useState<0 | 1>(0);
  const known = useRef<Set<string> | null>(null);
  const seenActivity = useRef(new Map<string, number>());
  const seenVisible = useRef(new Map<string, EdgeVisible>());
  const posRef = useRef(new Map<string, number>());
  const previousAnchor = useRef(anchor);
  const homeRef = useRef(new Map<string, number>());

  const animate = visible && !reduced && !offline;
  const byId = useMemo(() => new Map(works.map((work) => [work.workId, work])), [works]);
  const idKey = works.map((work) => work.workId).join(",");

  // Offline, hidden or reduced motion: everything in flight lands at once, so
  // no arrival keeps its boosted spot and no hop or step is left half done.
  useEffect(() => {
    if (animate) return;
    setArrivals((prev) => (prev.size ? new Map() : prev));
    setHops((prev) => (prev.size ? new Map() : prev));
    setWalks((prev) => (prev.size ? new Map() : prev));
  }, [animate]);

  // Each motion expires on its own clock, independent of incoming refreshes:
  // a timer to the earliest end, re-armed whenever the set changes.
  useExpiry(arrivals, setArrivals);
  useExpiry(hops, setHops);
  useExpiry(walks, setWalks);

  // Arrivals: only work that appears after the first full read. Reads that
  // settle in just after it (the roster loading, a grant's rows) are absorbed
  // quietly rather than dropped in as if they were new.
  const settleUntil = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const ids = idKey ? idKey.split(",") : [];
    const { known: next, arrived } = detectArrivals(known.current, ids);
    known.current = next;
    if (settleUntil.current === null) settleUntil.current = Date.now() + SETTLE_MS;
    if (!arrived.length || !animate || Date.now() < settleUntil.current) return;
    const now = Date.now();
    setArrivals((prev) => {
      const out = new Map(prev);
      for (const id of arrived) {
        if (motionOf(id) !== "full") continue;
        const kind = byId.get(id)?.visitorFrom ? "visitor" : "chute";
        out.set(id, { kind, at: now, until: now + ARRIVAL_MS[kind] });
      }
      return out;
    });
    // byId is read for the kind only; the id list drives this.
  }, [ready, idKey, animate]);

  // Steps and hops follow genuine activity: a working figure steps once when
  // its last activity moves forward; a figure that starts needing you hops once.
  useEffect(() => {
    const now = Date.now();
    const nextWalks = new Map<string, Walk>();
    const nextHops: string[] = [];
    for (const work of works) {
      const reading = edgeVisible(work.state, false);
      const before = seenVisible.current.get(work.workId);
      if (before && before !== "needs" && reading === "needs" && motionOf(work.workId) !== "still") nextHops.push(work.workId);
      seenVisible.current.set(work.workId, reading);
      const lastSeen = seenActivity.current.get(work.workId);
      seenActivity.current.set(work.workId, work.lastActivityAt);
      if (lastSeen === undefined || work.lastActivityAt <= lastSeen) continue;
      if (reading !== "working" || arrivals.has(work.workId)) continue;
      // Calm and Still figures stay put; placed figures stay where they were put.
      if (motionOf(work.workId) !== "full" || figureWhere(figureById.get(work.workId)) !== "row") continue;
      const current = posRef.current.get(work.workId);
      if (current === undefined) continue;
      const home = homeRef.current.get(work.workId) ?? current;
      const prior = walks.get(work.workId);
      if (prior && prior.until > now) continue; // one step at a time
      const n = (prior?.n ?? stepCount.current.get(work.workId) ?? 0) + 1;
      stepCount.current.set(work.workId, n);
      const target = stepTarget(work.workId, n, current, home);
      nextWalks.set(work.workId, { target, n, until: now + STEP_MS, facing: target > current ? "right" : "left" });
    }
    // Forget work that left the edge, so a returning pin starts fresh.
    const present = new Set(works.map((work) => work.workId));
    for (const seen of [seenVisible.current, seenActivity.current, stepCount.current]) pruneKeys(seen, present);
    if (!animate) return;
    if (nextWalks.size) setWalks((prev) => new Map([...prev, ...nextWalks]));
    if (nextHops.length) setHops((prev) => new Map([...prev, ...nextHops.map((id) => [id, { until: now + HOP_MS }] as const)]));
    // walks/arrivals are read, not followed: only new data takes a step.
  }, [works, animate]);

  // The stride alternates only while someone is mid-step.
  const walking = walks.size > 0;
  useEffect(() => {
    if (!walking) return;
    const strideTimer = setInterval(() => setStride((s) => (s ? 0 : 1)), 160);
    return () => clearInterval(strideTimer);
  }, [walking]);

  // Placement.
  const homeSpan = anchor === "left"
    ? { start: EDGE_MARGIN, end: EDGE_MARGIN + EDGE_HOME_SLOT }
    : { start: width - EDGE_MARGIN - EDGE_HOME_SLOT, end: width - EDGE_MARGIN };
  const homeX = (homeSpan.start + homeSpan.end) / 2;
  const obstacles = geometry?.obstacles ?? [];
  const free = useMemo(
    () => freeSpans(width, obstacles, homeSpan),
    [width, anchor, JSON.stringify(obstacles)],
  );
  const now = Date.now();
  // The home row holds surfaced work and pinned figures at home. A figure the
  // operator placed stands where it was put; a hidden one is nowhere.
  const rowWorks = useMemo(
    () => works.filter((work) => work.kind === "surfaced"
      || (figureWhere(figureById.get(work.workId)) === "row" && drag?.workId !== work.workId)),
    [works, figureById, drag?.workId],
  );
  const placedWorks = works.filter((work) => work.kind === "pinned"
    && (drag?.workId === work.workId || figureWhere(figureById.get(work.workId)) === "placed"));
  const hidden = hiddenFigures(figures);
  const { pos, overflow, stackAt } = useMemo(() => solveEdge(rowWorks.map((work) => {
    const walk = walks.get(work.workId);
    return {
      id: work.workId,
      visible: edgeVisible(work.state, false),
      arriving: arrivals.has(work.workId),
      stepTarget: walk && walk.until > now ? walk.target : null,
      lastActivityAt: work.lastActivityAt,
      width: figureSlot(sizeOf(work.workId)).width,
    };
  }), { prev: posRef.current, previousAnchor: previousAnchor.current, free, anchor, width }), [rowWorks, walks, arrivals, free, anchor, width, figureById, figureDefaults]);
  useEffect(() => {
    if (previousAnchor.current !== anchor) {
      previousAnchor.current = anchor;
      homeRef.current.clear();
      setWalks(new Map());
    }
    posRef.current = pos;
    for (const [id, x] of pos) if (!homeRef.current.has(id)) homeRef.current.set(id, x);
    // Forget homes of work that left, so a returning pin starts fresh.
    for (const id of homeRef.current.keys()) if (!pos.has(id)) homeRef.current.delete(id);
  }, [pos, byId, anchor]);

  useExpiry(falling, setFalling);
  // The host tracks a figure drag; the page draws the figure at the pointer
  // and the guide for the held modifier.
  useEffect(() => onCompanionFigureDrag((event) => {
    if (event.workId === null) {
      setDrag(null);
      return;
    }
    setDrag(event);
    setKept(null);
    setPanel(null);
  }), []);
  useEffect(() => onCompanionAnchors((update) => {
    setLiveAnchors(update.anchors);
    if (!update.falling.length || reduced) return;
    const until = Date.now() + FIGURE_FALL_MS;
    setFalling((prev) => new Map([...prev, ...update.falling.map((id) => [id, { until }] as const)]));
  }), [reduced]);

  type Slot = { kind: "work"; key: string; work: EdgeWork; x: number } | { kind: "stack"; key: "stack"; ids: string[]; x: number };
  const slots: Slot[] = rowWorks.filter((work) => pos.has(work.workId))
    .map((work): Slot => ({ kind: "work", key: work.workId, work, x: pos.get(work.workId)! }));
  if (overflow.length && stackAt !== null) slots.push({ kind: "stack", key: "stack", ids: overflow, x: stackAt });
  slots.sort((a, b) => a.x - b.x);

  const open = kept;
  const openWork = open ? byId.get(open) ?? null : null;
  const openPlaced = openWork && placedWorks.some((work) => work.workId === openWork.workId) ? figureById.get(openWork.workId)?.anchor ?? null : null;
  // A placed figure is not in the row, so its popover hangs off its anchor,
  // not off a row spot or "+N" that may not exist.
  const openSpot = openWork ? workPopoverSpot(pos.get(openWork.workId) ?? stackAt, openPlaced) : null;
  const openX = open === "stack" ? stackAt : openSpot?.x ?? null;

  // The parent loads full detail for the work the operator is looking at.
  const selected = openWork?.workId ?? null;
  useEffect(() => { onSelect(selected); }, [selected, onSelect]);

  const groups = useMemo(
    () => (originPins ? originGroups(rowWorks.map((work) => ({ id: work.workId, conversationId: work.conversationId })), pos, selected) : []),
    [originPins, rowWorks, pos, selected],
  );
  const pinXs = spreadPins(groups.map((group) => group.center), width);

  // The host reports a click elsewhere on the desktop: close what was open.
  useEffect(() => onCompanionPointer(({ outside }) => {
    if (!outside) return;
    setKept(null);
    setPanel(null);
  }), []);

  useEffect(() => {
    if (!hosted) return;
    setCompanionEngaged(Boolean(kept || panel));
  }, [hosted, kept, panel]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const nudge = figureNudge(event.key, event.shiftKey);
      if (nudge) {
        // Arrows move the focused placed figure, or the one whose popover is kept.
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, select, textarea")) return;
        const focused = target?.closest<HTMLElement>("[data-placed]")?.dataset.placed ?? null;
        const id = focused ?? (kept && figureWhere(figureById.get(kept)) === "placed" ? kept : null);
        if (!id) return;
        event.preventDefault();
        onFigureNudge(id, nudge.dx, nudge.dy);
        return;
      }
      if (event.key !== "Escape") return;
      if (kept) rootRef.current?.querySelector<HTMLElement>(`[data-slot="${CSS.escape(kept)}"]`)?.focus();
      setKept(null);
      setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kept, figureById, onFigureNudge]);

  // Report what takes the pointer. Everything else passes through to the desktop.
  const lastRegions = useRef("");
  const reportRegions = useCallback(() => {
    if (!hosted || !rootRef.current) return;
    const regions: CompanionHitRegion[] = [];
    for (const el of rootRef.current.querySelectorAll<HTMLElement>("[data-hit]")) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      regions.push({ id: el.dataset.hit!, x: rect.left - 2, y: rect.top - 2, width: rect.width + 4, height: rect.height + 4 });
    }
    const key = JSON.stringify(regions);
    if (key === lastRegions.current) return;
    lastRegions.current = key;
    reportCompanionHitRegions(regions);
  }, [hosted]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(reportRegions);
    return () => cancelAnimationFrame(frame);
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener("transitionend", reportRegions);
    root.addEventListener("animationend", reportRegions);
    // The popover grows from inside (Reply, the gear) without a parent
    // render; its new controls must take the pointer as soon as they show.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => reportRegions());
    const watch = () => root.querySelectorAll<HTMLElement>("[data-hit=\"popover\"]").forEach((el) => resize?.observe(el));
    watch();
    const added = new MutationObserver(watch);
    added.observe(root, { childList: true, subtree: true });
    return () => {
      root.removeEventListener("transitionend", reportRegions);
      root.removeEventListener("animationend", reportRegions);
      resize?.disconnect();
      added.disconnect();
    };
  }, [reportRegions]);

  const castOf = (work: EdgeWork) => castSlugForAgent(scout, {
    agent: work.agent ? { id: work.agent.id, name: work.agent.name, slug: (work.agent as { slug?: string | null }).slug ?? undefined } : undefined,
    name: work.agent?.name ?? work.ownerName ?? undefined,
  }).castSlug;
  const nameOf = (work: EdgeWork) => work.agent?.name ?? work.ownerName ?? "Unassigned";

  // A press on a pinned figure hands the drag to the host; a press that the
  // host tracked as a drag is not also a click.
  const onFigurePointerDown = (event: PointerEvent<HTMLElement>, work: EdgeWork) => {
    if (event.button !== 0 || work.kind !== "pinned") return;
    press.current = { id: work.workId, x: event.clientX, y: event.clientY };
    if (hosted) beginFigureDrag(work.workId);
  };
  const wasDragged = (event: MouseEvent<HTMLElement>, id: string) =>
    event.detail !== 0 && press.current?.id === id && !isFigureClick(press.current, { x: event.clientX, y: event.clientY });

  const onCrewKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + slots.length) % slots.length;
    rootRef.current?.querySelector<HTMLElement>(`[data-slot="${CSS.escape(slots[next]!.key)}"]`)?.focus();
  };

  const counts = works.reduce<Record<EdgeVisible, number>>((acc, work) => {
    acc[edgeVisible(work.state, false)] += 1;
    return acc;
  }, { working: 0, resting: 0, needs: 0, done: 0, disconnected: 0 });
  const homeLabel = [
    "Scout companion",
    `${works.length - hidden.length} on screen`,
    hidden.length ? `${hidden.length} hidden` : "",
    counts.needs ? `${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you` : "",
    offline ? `offline, synced ${lastSync ? clockLabel(lastSync) : "never"}` : "",
  ].filter(Boolean).join(" · ");

  const renderWorkPopover = (work: EdgeWork) => (
    <WorkInstrument
      work={work}
      name={nameOf(work)}
      offline={offline}
      refTime={refTime}
      hosted={hosted}
      figureSettings={work.kind === "pinned" ? renderFigureControls(work) : null}
      onThread={work.conversationId
        ? () => (work.kind === "pinned" ? onOpenPinned("thread", work) : onOpenSurfaced("thread", work))
        : null}
      onWork={() => (work.kind === "pinned" ? onOpenPinned("work", work) : onOpenSurfaced("work", work))}
      onPin={work.kind === "surfaced" && hosted ? () => onPinSurfaced(work) : null}
      // Replying keeps the popover open, as a click on it would.
      onComposing={(composing) => { if (composing) setKept(work.workId); }}
    />
  );

  // The figure's own settings, one instrument row behind the popover's gear.
  const renderFigureControls = (work: EdgeWork) => {
    const figure = figureById.get(work.workId);
    if (!figure) return null;
    const size = figure.size ?? figureDefaults.size;
    const motion = figure.motion ?? figureDefaults.motion;
    const presets = [...FIGURE_SIZE_PRESETS] as number[];
    const below = [...presets].reverse().find((preset) => preset < size);
    const above = presets.find((preset) => preset > size);
    return (
      <div className="ce-in__fig" role="group" aria-label="This figure">
        <span className="ce-in__face" aria-hidden="true">
          <EdgeCharacter slug={castOf(work)} name={nameOf(work)} state={work.state} offline={offline} size={Math.min(size, 28)} reduced />
        </span>
        <span className="ce-in__cell"><i>Size</i>
          <span className="ce-in__step">
            <button type="button" aria-label="Smaller" disabled={below === undefined} onClick={() => below !== undefined && onFigure(work.workId, { size: below })}>&minus;</button>
            <b title={figure.size === null ? "Default size" : undefined}>{size}</b>
            <button type="button" aria-label="Larger" disabled={above === undefined} onClick={() => above !== undefined && onFigure(work.workId, { size: above })}>+</button>
          </span>
        </span>
        <span className="ce-in__cell"><i>Motion</i>
          <span className="ce-in__step" role="radiogroup" aria-label="Motion">
            {FIGURE_MOTIONS.map((option) => (
              <button key={option} type="button" role="radio" aria-checked={motion === option} onClick={() => onFigure(work.workId, { motion: option })}>{FIGURE_MOTION_LABEL[option]}</button>
            ))}
          </span>
        </span>
        <span className="ce-in__cell ce-in__cell--acts"><i title={figure.label}>Place</i>
          <span>
            <button type="button" className="ce-in__link" disabled={figure.placement.kind === "home"} onClick={() => onFigure(work.workId, { home: true })}>Home</button>
            <button type="button" className="ce-in__link" onClick={() => { setKept(null); onFigure(work.workId, { hidden: true }); }}>Hide</button>
            <button type="button" className="ce-in__link" onClick={() => { setKept(null); onUnpin(work.workId); }}>Unpin</button>
          </span>
        </span>
        {reduced && <p className="ce-in__fignote">Reduce Motion is on, so every figure holds still.</p>}
      </div>
    );
  };

  const pinnedWorks = works.filter((work) => work.kind === "pinned");
  const renderFigureSettings = () => (
    <section className="co-sheet ce-figures" aria-label="Figures">
      <div className="co-field">
        <span className="co-sheet-h" id="ce-default-size">Figure size</span>
        <div className="co-seg" role="radiogroup" aria-labelledby="ce-default-size">
          {FIGURE_SIZE_PRESETS.map((size) => (
            <button key={size} type="button" role="radio" aria-checked={figureDefaults.size === size} className="co-seg-btn"
              aria-label={`${size} points`} onClick={() => onFigureDefaults({ size })}>{size}</button>
          ))}
        </div>
      </div>
      <div className="co-field">
        <span className="co-sheet-h" id="ce-default-motion">Figure motion</span>
        <div className="co-seg" role="radiogroup" aria-labelledby="ce-default-motion">
          {FIGURE_MOTIONS.map((motion) => (
            <button key={motion} type="button" role="radio" aria-checked={figureDefaults.motion === motion} className="co-seg-btn"
              onClick={() => onFigureDefaults({ motion })}>{FIGURE_MOTION_LABEL[motion]}</button>
          ))}
        </div>
        <p className="co-hint">Full walks and parachutes in; Calm only hops when work needs you; Still never moves.{reduced ? " Reduce Motion is on, so every figure holds still." : ""}</p>
      </div>
      <div className="co-field">
        <span className="co-sheet-h">Figures</span>
        {pinnedWorks.length ? (
          <ul className="ce-figlist">
            {pinnedWorks.map((work) => {
              const figure = figureById.get(work.workId);
              if (!figure) return null;
              return (
                <li key={work.workId}>
                  <label className="ce-figlist__show">
                    <input type="checkbox" checked={!figure.hidden} onChange={(event) => onFigure(work.workId, { hidden: !event.currentTarget.checked })} />
                    <span className="ce-list__t"><b title={work.title}>{work.title}</b><small>{figure.hidden ? "Hidden" : figure.label}</small></span>
                  </label>
                  <select className="ce-select" aria-label={`Size of ${work.title}`} value={figure.size ?? "default"}
                    onChange={(event) => onFigure(work.workId, { size: event.currentTarget.value === "default" ? "default" : Number(event.currentTarget.value) })}>
                    <option value="default">Default</option>
                    {(figure.size !== null && !FIGURE_SIZE_PRESETS.includes(figure.size as typeof FIGURE_SIZE_PRESETS[number]) ? [...FIGURE_SIZE_PRESETS, figure.size].sort((a, b) => a - b) : FIGURE_SIZE_PRESETS)
                      .map((size) => <option key={size} value={size}>{size}</option>)}
                  </select>
                  <select className="ce-select" aria-label={`Motion of ${work.title}`} value={figure.motion ?? "default"}
                    onChange={(event) => onFigure(work.workId, { motion: event.currentTarget.value as CompanionFigureMotion | "default" })}>
                    <option value="default">Default</option>
                    {FIGURE_MOTIONS.map((motion) => <option key={motion} value={motion}>{FIGURE_MOTION_LABEL[motion]}</option>)}
                  </select>
                </li>
              );
            })}
          </ul>
        ) : <p className="co-hint">Pinned work gets a figure you can place.</p>}
        <p className="co-hint">Drag a figure anywhere on this display. Hold &#x2325; as you let go to stick it to the nearest edge or window, &#x21E7; to drop it onto whatever is below.</p>
      </div>
      <div className="co-foot">
        <button type="button" className="co-chip" disabled={!figures.some((figure) => figure.placement.kind !== "home")} onClick={onFiguresHome}>Send all home</button>
      </div>
    </section>
  );

  const renderOverflowList = (ids: readonly string[], heading: string, why: ReactNode) => (
    <>
      <p className="ce-pop__eyebrow">{heading}</p>
      {why}
      <ul className="ce-list">
        {ids.map((id) => {
          const work = byId.get(id);
          if (!work) return null;
          return (
            <li key={id}>
              <button type="button" onClick={() => { setPanel(null); setKept(id); }}>
                <EdgeCharacter slug={castOf(work)} name={nameOf(work)} state={work.state} offline={offline} size={20} reduced />
                <span className="ce-list__t">
                  <b>{work.title}</b>
                  <small>{EDGE_VISIBLE_LABEL[edgeVisible(work.state, offline)]}{exactDiffers(work.state) ? ` · ${exactLabel(work.state)}` : ""} · {nameOf(work)}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );

  // What the popover shows, if anything: a clicked figure, "+N", a pin, or settings.
  let popover: { x: number; body: ReactNode; label: string } | null = null;
  if (panel === "settings") {
    popover = { x: homeX, label: "Companion settings", body: <>{renderSettings()}{renderFigureSettings()}</> };
  } else if (panel?.startsWith("pin:")) {
    const index = groups.findIndex((group) => `pin:${group.conversationId}` === panel);
    const group = groups[index];
    if (group) {
      popover = {
        x: pinXs[index]!,
        label: "Work launched from one conversation",
        body: (
          <>
            {renderOverflowList(group.ids, `${group.ids.length} launched from one conversation`, null)}
            <div className="co-foot">
              <button type="button" className="co-chip primary" onClick={() => onOpenThread(group.conversationId, group.ids[0]!)}>Open the conversation</button>
            </div>
          </>
        ),
      };
    }
  } else if (open === "stack" && stackAt !== null) {
    popover = {
      x: stackAt,
      label: `${overflow.length} without a spot on the edge`,
      body: renderOverflowList(overflow, `${overflow.length} without a spot`, (
        <p className="ce-pop__why">No free spot is left between Scout&rsquo;s windows and the other characters. Resting and done work gives up its spot first; anything that needs you always keeps one.</p>
      )),
    };
  } else if (openWork && openSpot) {
    popover = { x: openSpot.x, label: `${openWork.title}, ${EDGE_VISIBLE_LABEL[edgeVisible(openWork.state, offline)]}`, body: renderWorkPopover(openWork) };
  }

  const popWidth = Math.min(POP_WIDTH, width - 24);
  const popMaxHeight = Math.max(120, height - EDGE_SLOT_HEIGHT - 40);
  // A placed figure's popover opens beside the figure, anywhere on the display.
  const placedPop = popover && !panel && openSpot?.placed && openWork
    ? placedPopover(openSpot.placed, sizeOf(openWork.workId), Math.min(POP_WIDTH, screen.width - 24), screen)
    : null;
  const renderPopover = () => popover && (
    <div
      className={`ce-pop${kept || panel ? " is-kept" : ""}${placedPop ? " is-placed" : ""}`}
      role="dialog"
      aria-label={popover.label}
      data-hit="popover"
      style={placedPop
        ? { left: placedPop.left, top: placedPop.top, bottom: placedPop.bottom, width: Math.min(POP_WIDTH, screen.width - 24), maxHeight: placedPop.maxHeight }
        : { left: popoverLeft(popover.x, popWidth, width), width: popWidth, maxHeight: popMaxHeight }}
    >
      {popover.body}
      {!panel && open !== "stack" && (
        <p className="ce-pop__hint">
          {kept ? "Kept open · Esc or click elsewhere to close" : "Click to keep open"}
          {kept && placedPop ? " · Arrow keys nudge it" : ""}
        </p>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`ce-root${reduced ? " is-reduced" : ""}${offline ? " is-offline" : ""}`}
      data-anchor={anchor}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("[data-hit]")) {
          setKept(null);
          setPanel(null);
        }
      }}
    >
      <div className="ce-band" style={{ left: band.x, top: band.y, width, height }}>
      {groups.map((group, index) => {
        const ids = group.ids;
        const needs = ids.filter((id) => edgeVisible(byId.get(id)?.state, false) === "needs").length;
        const key = `pin:${group.conversationId}` as const;
        const lit = selected ? ids.includes(selected) : false;
        return (
          <button
            key={group.conversationId}
            type="button"
            className={`ce-pin${panel === key ? " is-open" : ""}${lit ? " is-lit" : ""}`}
            data-hit={`pin.${index}`}
            style={{ left: pinXs[index] }}
            aria-expanded={panel === key}
            aria-label={`${ids.length} launched from one conversation${needs ? `, ${needs} needing you` : ""}`}
            onClick={() => { setKept(null); setPanel((current) => (current === key ? null : key)); }}
          >
            <ScoutMark className="ce-pin__mark" />
            <span className="ce-pin__n">{ids.length}</span>
            {needs > 0 && <span className="ce-pin__ask" aria-hidden="true" />}
          </button>
        );
      })}

      <div className="ce-crew" role="toolbar" aria-label={`Scout crew: ${rowWorks.length} in the home row`} aria-orientation="horizontal">
        {slots.map((slot, index) => {
          const isOpen = open === slot.key && !panel;
          const common = {
            "data-slot": slot.key,
            "data-hit": slot.key,
            type: "button" as const,
            tabIndex: index === 0 ? 0 : -1,
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => onCrewKey(event, index),
            onClick: (event: MouseEvent<HTMLElement>) => {
              if (wasDragged(event, slot.key)) return;
              setPanel(null);
              setKept((current) => (current === slot.key ? null : slot.key));
            },
            "aria-pressed": kept === slot.key,
          };
          if (slot.kind === "stack") {
            const needs = slot.ids.filter((id) => edgeVisible(byId.get(id)?.state, false) === "needs").length;
            return (
              <button key="stack" {...common} className={`ce-slot is-stack${isOpen ? " is-open" : ""}`} style={{ left: slot.x }}
                aria-label={`${slot.ids.length} more with no room on the edge${needs ? `, ${needs} needing you` : ""}`}>
                <span className="ce-stack__n">+{slot.ids.length}</span>
              </button>
            );
          }
          const work = slot.work;
          const walk = walks.get(work.workId);
          const moving = Boolean(walk && walk.until > now);
          const arrival = arrivals.get(work.workId);
          const arriving = arrival && animate && now - arrival.at < ARRIVAL_MS[arrival.kind] ? arrival.kind : null;
          const reading = edgeVisible(work.state, offline);
          // Parachutes drop from above their own spot: Scout does not know
          // where the originating window is. Visitors walk in from the screen
          // edge nearer their spot.
          const fromLeft = slot.x < width / 2;
          const dx = arriving === "visitor" ? (fromLeft ? -slot.x - EDGE_SLOT : width - slot.x + EDGE_SLOT) : 0;
          const dy = arriving === "chute" ? -(height - EDGE_SLOT_HEIGHT - 8) : 0;
          const lit = panel?.startsWith("pin:") ? groups.find((group) => `pin:${group.conversationId}` === panel)?.ids.includes(work.workId) : null;
          const slug = castOf(work);
          const size = sizeOf(work.workId);
          const motion = motionOf(work.workId);
          const box = figureSlot(size);
          return (
            <button
              key={work.workId}
              {...common}
              onPointerDown={(event) => onFigurePointerDown(event, work)}
              className={`ce-slot${isOpen ? " is-open" : ""}${moving && animate ? " is-walk" : ""}${lit === false ? " is-unlit" : ""}${lit ? " is-lit" : ""}`}
              style={{ left: slot.x, width: box.width, height: box.height }}
              aria-label={`${nameOf(work)}: ${work.title}. ${EDGE_VISIBLE_LABEL[reading]}${reading !== "disconnected" && exactDiffers(work.state) ? ` (${exactLabel(work.state)})` : ""}${work.visitorFrom ? `. Runs on ${work.visitorFrom}` : ""}`}
            >
              <span className={`ce-arrive${arriving ? ` is-${arriving}` : ""}`} style={{ "--dx": `${dx}px`, "--dy": `${dy}px` } as CSSProperties}>
                <span className="ce-sway">
                  {arriving === "chute" && <Canopy hue={projectHue(work.agent?.project ?? work.title)} />}
                  <EdgeCharacter
                    slug={slug}
                    name={nameOf(work)}
                    state={work.state}
                    offline={offline}
                    size={size}
                    walking={animate && (moving || arriving === "visitor")}
                    stride={stride}
                    facing={arriving === "visitor" ? (fromLeft ? "right" : "left") : walk?.facing}
                    onEdge
                    hop={hops.has(work.workId)}
                    reduced={!animate || motion === "still"}
                  />
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className={`ce-home${panel === "settings" ? " is-open" : ""}`}
        data-hit="home"
        style={{ left: homeX }}
        aria-expanded={panel === "settings"}
        aria-label={`${homeLabel}. Settings`}
        title={homeLabel}
        onClick={() => { setKept(null); setPanel((current) => (current === "settings" ? null : "settings")); }}
      >
        <ScoutMark className="ce-home__mark" />
        {counts.needs > 0 && <span className="ce-home__ask" aria-hidden="true" />}
        {offline && <span className="ce-home__off" aria-hidden="true" />}
      </button>
      {hidden.length > 0 && (
        <span className="ce-hidden" aria-hidden="true" style={anchor === "left" ? { left: homeSpan.end + 6 } : { right: width - homeSpan.start + 6 }}>
          {hidden.length} hidden
        </span>
      )}

      {works.length === 0 && ready && (
        <p className="ce-empty" style={anchor === "left" ? { left: homeSpan.end + 8 } : { right: width - homeSpan.start + 8 }}>
          Nothing pinned. Open work in the Scout app and press Pin to companion.
        </p>
      )}
      {(offline || hostError) && (
        <p className="ce-status" style={anchor === "left" ? { left: homeSpan.start } : { right: width - homeSpan.end }}>
          {hostError ?? `offline · synced ${lastSync ? clockLabel(lastSync) : "never"}`}
        </p>
      )}

      {!placedPop && renderPopover()}
      </div>

      <div className="ce-layer">
        {drag?.guide && (
          <svg className="ce-guides" width={screen.width} height={screen.height} aria-hidden="true">
            {drag.guide.kind === "perch" && drag.guide.from && drag.guide.to && (
              <line className="ce-guide__line" x1={drag.guide.from.x} y1={drag.guide.from.y} x2={drag.guide.to.x} y2={drag.guide.to.y} />
            )}
            {drag.guide.kind === "fall" && (
              <line className="ce-guide__fall" x1={drag.x} y1={drag.y} x2={drag.guide.spot.x} y2={drag.guide.spot.y} />
            )}
            <circle className="ce-guide__spot" cx={drag.guide.spot.x} cy={drag.guide.spot.y} r={3} />
          </svg>
        )}
        {placedWorks.map((work) => {
          const figure = figureById.get(work.workId);
          const dragging = drag?.workId === work.workId;
          const at = dragging ? { x: drag.x, y: drag.y, down: null, covered: false } : figure?.anchor;
          if (!at) return null;
          const size = sizeOf(work.workId);
          const motion = motionOf(work.workId);
          const box = figureSlot(size);
          const held = figureBox(at, size, screen);
          const hold = figureHasPlate(at.down) && !dragging ? at.down : null;
          const reading = edgeVisible(work.state, offline);
          const isOpen = open === work.workId && !panel;
          return (
            <button
              key={work.workId}
              type="button"
              data-slot={work.workId}
              data-placed={work.workId}
              // A ghosted figure is behind a window: clicks there belong to that window.
              data-hit={at.covered || dragging ? undefined : work.workId}
              className={`ce-placed${hold ? ` is-hold-${hold}` : ""}${isOpen ? " is-open" : ""}${at.covered ? " is-covered" : ""}${dragging ? " is-dragging" : ""}${falling.has(work.workId) && !dragging ? " is-falling" : ""}`}
              style={{ left: held.left, top: held.top, width: box.width, height: box.height } as CSSProperties}
              aria-label={`${nameOf(work)}: ${work.title}. ${EDGE_VISIBLE_LABEL[reading]}. ${figure?.label ?? ""}`}
              aria-pressed={kept === work.workId}
              onPointerDown={(event) => onFigurePointerDown(event, work)}
              onClick={(event) => {
                if (wasDragged(event, work.workId)) return;
                setPanel(null);
                setKept((current) => (current === work.workId ? null : work.workId));
              }}
            >
              {hold ? <HexPlate side={hold} /> : null}
              <EdgeCharacter
                slug={castOf(work)}
                name={nameOf(work)}
                state={work.state}
                offline={offline}
                size={size}
                hop={hops.has(work.workId)}
                reduced={!animate || motion === "still"}
              />
            </button>
          );
        })}
        {placedPop && renderPopover()}
      </div>
    </div>
  );
}
