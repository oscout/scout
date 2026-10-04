import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { castSlugForAgent } from "../../components/AgentAvatar.tsx";
import { ScoutMark } from "../../components/ScoutMark.tsx";
import { SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import {
  companionHostAvailable,
  onCompanionPointer,
  reportCompanionHitRegions,
  setCompanionEngaged,
  type CompanionEdgeAnchor,
  type CompanionEdgeGeometry,
  type CompanionHitRegion,
} from "../../lib/companion-host.ts";
import { CREW_ART, crewAssetUrl, poseAsset, projectHue, type PoseName } from "../../lib/crew-registry.ts";
import type { Agent } from "../../lib/types.ts";
import { useOptionalScout } from "../../scout/Provider.tsx";
import { pruneKeys } from "./companion-data.ts";
import { ageLabel, clockLabel, type CompanionCardState } from "./companion-model.ts";
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
};

type Arrival = { kind: "chute" | "visitor"; at: number; until: number };
type Walk = { target: number; n: number; until: number; facing: "left" | "right" };

const POP_WIDTH = 348;
const HOVER_GRACE_MS = 220;

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

const RESTING_NOTE: Partial<Record<CompanionCardState, string>> = {
  quiet: "No new activity for a while. Not paused: Scout has just not seen anything.",
  waiting: "Waiting on someone else, not on you.",
  ended: "The session ended without reporting done.",
  cancelled: "Cancelled. Nothing is running.",
};

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
  /** The stack's card for a pinned item: detail, tail, artifacts, actions. */
  renderCard: (workId: string) => ReactNode;
  renderSettings: () => ReactNode;
  onSelect: (workId: string | null) => void;
  onOpenSurfaced: (target: "work" | "thread", work: EdgeWork) => void;
  onPinSurfaced: (work: EdgeWork) => void;
  onOpenThread: (conversationId: string, workId: string) => void;
};

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
  renderCard,
  renderSettings,
  onSelect,
  onOpenSurfaced,
  onPinSurfaced,
  onOpenThread,
}: CompanionEdgeProps) {
  const scout = useOptionalScout();
  const hosted = companionHostAvailable();
  const reduced = usePrefersReducedMotion();
  const { width, height } = useViewport(geometry);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Popover state: hover (reported by the host) shows it; click keeps it.
  const [hover, setHover] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [panel, setPanel] = useState<"settings" | "overflow" | `pin:${string}` | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      if (before && before !== "needs" && reading === "needs") nextHops.push(work.workId);
      seenVisible.current.set(work.workId, reading);
      const lastSeen = seenActivity.current.get(work.workId);
      seenActivity.current.set(work.workId, work.lastActivityAt);
      if (lastSeen === undefined || work.lastActivityAt <= lastSeen) continue;
      if (reading !== "working" || arrivals.has(work.workId)) continue;
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
  const { pos, overflow, stackAt } = useMemo(() => solveEdge(works.map((work) => {
    const walk = walks.get(work.workId);
    return {
      id: work.workId,
      visible: edgeVisible(work.state, false),
      arriving: arrivals.has(work.workId),
      stepTarget: walk && walk.until > now ? walk.target : null,
      lastActivityAt: work.lastActivityAt,
    };
  }), { prev: posRef.current, previousAnchor: previousAnchor.current, free, anchor, width }), [works, walks, arrivals, free, anchor, width]);
  useEffect(() => {
    if (previousAnchor.current !== anchor) {
      previousAnchor.current = anchor;
      homeRef.current.clear();
      setWalks(new Map());
    }
    posRef.current = pos;
    for (const [id, x] of pos) if (!homeRef.current.has(id)) homeRef.current.set(id, x);
    // Forget homes of work that left, so a returning pin starts fresh.
    for (const id of homeRef.current.keys()) if (!byId.has(id)) homeRef.current.delete(id);
  }, [pos, byId, anchor]);

  type Slot = { kind: "work"; key: string; work: EdgeWork; x: number } | { kind: "stack"; key: "stack"; ids: string[]; x: number };
  const slots: Slot[] = works.filter((work) => pos.has(work.workId))
    .map((work): Slot => ({ kind: "work", key: work.workId, work, x: pos.get(work.workId)! }));
  if (overflow.length && stackAt !== null) slots.push({ kind: "stack", key: "stack", ids: overflow, x: stackAt });
  slots.sort((a, b) => a.x - b.x);

  const open = kept ?? hover;
  const openWork = open ? byId.get(open) ?? null : null;
  const openX = open === "stack" ? stackAt : openWork ? pos.get(openWork.workId) ?? stackAt : null;

  // The parent loads full detail for the work the operator is looking at.
  const selected = openWork?.workId ?? null;
  useEffect(() => { onSelect(selected); }, [selected, onSelect]);

  const groups = useMemo(
    () => (originPins ? originGroups(works.map((work) => ({ id: work.workId, conversationId: work.conversationId })), pos, selected) : []),
    [originPins, works, pos, selected],
  );
  const pinXs = spreadPins(groups.map((group) => group.center), width);

  // Host pointer reports stand in for hover; a click elsewhere on the desktop
  // closes what was kept open.
  const setHoverSoon = useCallback((id: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (id) {
      setHover(id);
      return;
    }
    hoverTimer.current = setTimeout(() => setHover(null), HOVER_GRACE_MS);
  }, []);
  useEffect(() => onCompanionPointer(({ id, outside }) => {
    if (outside) {
      setKept(null);
      setPanel(null);
      setHoverSoon(null);
      return;
    }
    // Over the popover or a pin: keep whatever is open.
    if (id === "popover" || id?.startsWith("pin.") || id === "home" || id === "panel") {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
      return;
    }
    setHoverSoon(id);
  }), [setHoverSoon]);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  useEffect(() => {
    if (!hosted) return;
    setCompanionEngaged(Boolean(kept || panel));
  }, [hosted, kept, panel]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (kept) rootRef.current?.querySelector<HTMLElement>(`[data-slot="${CSS.escape(kept)}"]`)?.focus();
      setKept(null);
      setPanel(null);
      setHover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kept]);

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
    return () => {
      root.removeEventListener("transitionend", reportRegions);
      root.removeEventListener("animationend", reportRegions);
    };
  }, [reportRegions]);

  const castOf = (work: EdgeWork) => castSlugForAgent(scout, {
    agent: work.agent ? { id: work.agent.id, name: work.agent.name, slug: (work.agent as { slug?: string | null }).slug ?? undefined } : undefined,
    name: work.agent?.name ?? work.ownerName ?? undefined,
  }).castSlug;
  const nameOf = (work: EdgeWork) => work.agent?.name ?? work.ownerName ?? "Unassigned";

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
    `${works.length} on the edge`,
    counts.needs ? `${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you` : "",
    offline ? `offline, synced ${lastSync ? clockLabel(lastSync) : "never"}` : "",
  ].filter(Boolean).join(" · ");

  const renderWorkPopover = (work: EdgeWork) => {
    const reading = edgeVisible(work.state, offline);
    const underlying = edgeVisible(work.state, false);
    const slug = castOf(work);
    const note = work.state ? RESTING_NOTE[work.state] : undefined;
    const project = work.agent?.project ?? null;
    return (
      <>
        <div className="ce-pop__state" data-visible={reading}>
          <span className="ce-pop__plate"><StatePlate visible={reading} /></span>
          <span>
            <b>{offline ? `${EDGE_VISIBLE_LABEL[underlying]} at last sync` : EDGE_VISIBLE_LABEL[reading]}</b>
            {exactDiffers(work.state) && <span className="ce-pop__exact"> · {exactLabel(work.state)}</span>}
            {note && underlying === "resting" && <small className="ce-pop__note">{note}</small>}
          </span>
          <span className="ce-pop__portrait" title={slug ? `${CREW_ART[slug] ? slug : ""}` : undefined}>
            <EdgeCharacter slug={slug} name={nameOf(work)} state={work.state} offline={offline} size={34} reduced />
          </span>
        </div>
        {work.kind === "pinned" ? renderCard(work.workId) : (
          <article className="co-card ce-surfaced" data-state={work.state ?? "unknown"}>
            <div className="co-c-head">
              <span className="co-c-title"><span className="co-t" title={work.title}>{work.title}</span>
                <span className="co-who">{[project, nameOf(work)].filter(Boolean).join(" · ")}</span></span>
              <span className="co-c-actions"><span className="co-age">{ageLabel(work.lastActivityAt, refTime)}</span></span>
            </div>
            <div className="co-foot">
              {work.conversationId && (
                <button type="button" className={`co-chip${underlying === "needs" ? " primary" : ""}`} onClick={() => onOpenSurfaced("thread", work)}>
                  {underlying === "needs" ? "Answer in thread" : "Open thread"}
                </button>
              )}
              <button type="button" className="co-chip" onClick={() => onOpenSurfaced("work", work)}>Open work</button>
              {hosted && <button type="button" className="co-chip" onClick={() => onPinSurfaced(work)}>Pin</button>}
            </div>
          </article>
        )}
        <dl className="ce-pop__facts">
          <dt>Origin</dt>
          <dd>
            {work.conversationId
              ? <button type="button" className="ce-link" onClick={() => onOpenThread(work.conversationId!, work.workId)}>Open the conversation it came from</button>
              : <span className="ce-none">No originating conversation recorded</span>}
            {work.origin && <small> · surfaced {work.origin}</small>}
          </dd>
          {work.visitorFrom && (<><dt>Machine</dt><dd>Runs on {work.visitorFrom}, not this Mac</dd></>)}
          <dt>Figure</dt>
          <dd>{slug ? `${slug[0]!.toUpperCase()}${slug.slice(1)}, the character for ${nameOf(work)}` : `${nameOf(work)}'s own sprite: no crew character assigned`}</dd>
        </dl>
      </>
    );
  };

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

  // What the popover shows, if anything: a kept or hovered figure, "+N", a pin, or settings.
  let popover: { x: number; body: ReactNode; label: string } | null = null;
  if (panel === "settings") {
    popover = { x: homeX, label: "Companion settings", body: renderSettings() };
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
  } else if (openWork && openX !== null) {
    popover = { x: openX, label: `${openWork.title}, ${EDGE_VISIBLE_LABEL[edgeVisible(openWork.state, offline)]}`, body: renderWorkPopover(openWork) };
  }

  const popWidth = Math.min(POP_WIDTH, width - 24);
  const popMaxHeight = Math.max(120, height - EDGE_SLOT_HEIGHT - 40);

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

      <div className="ce-crew" role="toolbar" aria-label={`Scout crew: ${works.length} on the edge`} aria-orientation="horizontal">
        {slots.map((slot, index) => {
          const isOpen = open === slot.key && !panel;
          const common = {
            "data-slot": slot.key,
            "data-hit": slot.key,
            type: "button" as const,
            tabIndex: index === 0 ? 0 : -1,
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => onCrewKey(event, index),
            onPointerEnter: hosted ? undefined : () => setHoverSoon(slot.key),
            onPointerLeave: hosted ? undefined : () => setHoverSoon(null),
            onFocus: () => setHover(slot.key),
            onBlur: () => setHover((current) => (current === slot.key ? null : current)),
            onClick: () => { setPanel(null); setKept((current) => (current === slot.key ? null : slot.key)); },
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
          return (
            <button
              key={work.workId}
              {...common}
              className={`ce-slot${isOpen ? " is-open" : ""}${moving && animate ? " is-walk" : ""}${lit === false ? " is-unlit" : ""}${lit ? " is-lit" : ""}`}
              style={{ left: slot.x }}
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
                    walking={animate && (moving || arriving === "visitor")}
                    stride={stride}
                    facing={arriving === "visitor" ? (fromLeft ? "right" : "left") : walk?.facing}
                    onEdge
                    hop={hops.has(work.workId)}
                    reduced={!animate}
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

      {popover && (
        <div
          className={`ce-pop${kept || panel ? " is-kept" : ""}`}
          role="dialog"
          aria-label={popover.label}
          data-hit="popover"
          style={{ left: popoverLeft(popover.x, popWidth, width), width: popWidth, maxHeight: popMaxHeight }}
        >
          {popover.body}
          {!panel && open !== "stack" && <p className="ce-pop__hint">{kept ? "Kept open · Esc or click elsewhere to close" : "Click to keep open"}</p>}
        </div>
      )}
    </div>
  );
}
