import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { castSlugForAgent } from "./AgentAvatar.tsx";
import { CrewFigure } from "./CrewFigure.tsx";
import { useOptionalScout } from "../scout/Provider.tsx";
import {
  CREW_ART,
  assignCastSlug,
  crewGround,
  hasPose,
  projectHue,
  type PoseName,
} from "../lib/crew-registry.ts";
import "./crew-photo.css";

/**
 * The crew photo — one project, one hue, the members standing on it.
 *
 * Everything here is identity, never state: the band's hue is the project, the
 * figures are the members who actually work in it (resolved exactly the way
 * their coin resolves, so a member with no art is absent rather than borrowing
 * somebody's face), and the poses are personality. Nothing in this file says
 * what anyone is doing — that is the ring's job, and the ring is not here.
 */

/** A crew member as the photo needs it. `CrewMember` satisfies this shape. */
export type CrewPhotoSubject = {
  key: string;
  name: string;
  agentId?: string | null;
  lastActivityAt: number;
};

/** A subject that resolved to real cast art and can therefore be drawn. */
export type CrewPhotoFigure = {
  key: string;
  name: string;
  castSlug: string;
  lastActivityAt: number;
};

/** Six is the width a header band reads at; past that the faces stop being faces. */
export const CREW_PHOTO_LIMIT = 6;

const TRAVEL_MS = 2_100;
const WAVE_MS = 1_400;
/** 7 fps — the run cycle is two frames, and a faster flip reads as a flicker. */
const RUN_FRAME_MS = 143;

const DEFAULT_FIGURE_HEIGHT = 120;
const DEFAULT_BAND_HEIGHT = 168;
/** Matches `--xcp-gap` and the stage's side padding in crew-photo.css. */
const SLOT_GAP = 16;
const STAGE_PAD = 18;
/** Under this a member is a smudge, so a too-narrow band clips instead. */
const MIN_FIGURE_HEIGHT = 64;

type ArrivalPhase = "travel" | "wave";

/**
 * The tallest the figures can be and still all fit across `bandWidth`.
 *
 * Six members is a cap on the crew, not a promise about the pane: the centre
 * column is a third of the window on a laptop. Widths differ per member (nori
 * is 394 wide where sprout is 516), so the row is measured from the art rather
 * than from a count.
 */
export function fitFigureHeight(
  aspects: readonly number[],
  bandWidth: number,
  preferred = DEFAULT_FIGURE_HEIGHT,
): number {
  if (aspects.length === 0 || bandWidth <= 0) return preferred;
  const total = aspects.reduce((sum, aspect) => sum + aspect, 0);
  if (total <= 0) return preferred;
  const room = bandWidth - STAGE_PAD * 2 - SLOT_GAP * (aspects.length - 1);
  if (room <= 0) return MIN_FIGURE_HEIGHT;
  return Math.max(MIN_FIGURE_HEIGHT, Math.min(preferred, Math.floor(room / total)));
}

/* ── Pure helpers (unit-tested in crew-photo.test.ts) ─────────────────── */

/**
 * The figures a photo actually draws.
 *
 * One slug appears once: two agents resolving to the same cast member are the
 * same face, and printing it twice reads as two of them. The survivor is the
 * most recently active, so the photo shows the version of that face that is
 * doing something. Capped at `limit`, most recent first.
 */
export function crewPhotoRoster(
  figures: readonly CrewPhotoFigure[],
  limit = CREW_PHOTO_LIMIT,
): CrewPhotoFigure[] {
  const ordered = [...figures].sort(
    (left, right) => right.lastActivityAt - left.lastActivityAt
      || left.name.localeCompare(right.name)
      || left.key.localeCompare(right.key),
  );
  const seen = new Set<string>();
  const kept: CrewPhotoFigure[] = [];
  for (const figure of ordered) {
    if (seen.has(figure.castSlug)) continue;
    seen.add(figure.castSlug);
    kept.push(figure);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * Which slugs are new to the photo since the last roster.
 *
 * Order follows `next`, so arrivals animate left-to-right as they stand.
 */
export function arrivingCastSlugs(
  shown: Iterable<string>,
  next: readonly string[],
): string[] {
  const already = shown instanceof Set ? shown : new Set(shown);
  const fresh: string[] = [];
  for (const slug of next) {
    if (already.has(slug) || fresh.includes(slug)) continue;
    fresh.push(slug);
  }
  return fresh;
}

/** Resolves subjects to cast identity; a subject with no crew art drops out. */
export function crewPhotoFigures(
  scout: ReturnType<typeof useOptionalScout>,
  subjects: readonly CrewPhotoSubject[],
): CrewPhotoFigure[] {
  const figures: CrewPhotoFigure[] = [];
  for (const subject of subjects) {
    const { castSlug } = castSlugForAgent(scout, {
      agent: { id: subject.agentId ?? null, name: subject.name },
    });
    if (!castSlug) continue;
    figures.push({
      key: subject.key,
      name: subject.name,
      castSlug,
      lastActivityAt: subject.lastActivityAt,
    });
  }
  return figures;
}

/* ── Photo ───────────────────────────────────────────────────────────── */

/** `useLayoutEffect` on the client, `useEffect` where there is no layout. */
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export interface CrewPhotoProps {
  /** The project's crew — unresolved; members without art are dropped here. */
  subjects: readonly CrewPhotoSubject[];
  /** Project slug: the band's hue and every figure's halo. */
  projectSlug: string;
  figureHeight?: number;
  bandHeight?: number;
  className?: string;
  style?: CSSProperties;
}

export function CrewPhoto({
  subjects,
  projectSlug,
  figureHeight = DEFAULT_FIGURE_HEIGHT,
  bandHeight = DEFAULT_BAND_HEIGHT,
  className,
  style,
}: CrewPhotoProps) {
  const scout = useOptionalScout();
  const roster = useMemo(
    () => crewPhotoRoster(crewPhotoFigures(scout, subjects)),
    [scout, subjects],
  );
  const slugs = useMemo(() => roster.map((figure) => figure.castSlug), [roster]);
  const slugKey = slugs.join("\u0000");

  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [phases, setPhases] = useState<Record<string, ArrivalPhase>>({});
  const [runFrame, setRunFrame] = useState(0);
  const [bandWidth, setBandWidth] = useState(0);
  const bandRef = useRef<HTMLDivElement>(null);
  /* The roster the last commit drew. `null` means no photo exists yet — and an
     arrival is somebody joining a photo that already existed. A crew that is
     still loading is not a photo, so the first NON-EMPTY set becomes the
     baseline and nobody runs in on first paint. */
  const shownRef = useRef<Set<string> | null>(null);
  /* Which project the baseline belongs to. Scoping to another project is a
     different photo, not the same one gaining six members. */
  const photoRef = useRef<string | null>(null);
  const slotRefs = useRef(new Map<string, HTMLSpanElement>());
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(preference.matches);
    sync();
    preference.addEventListener("change", sync);
    return () => preference.removeEventListener("change", sync);
  }, []);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => {
    const band = bandRef.current;
    if (!band || typeof ResizeObserver === "undefined") return;
    setBandWidth(band.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width != null) setBandWidth(width);
    });
    observer.observe(band);
    return () => observer.disconnect();
  }, [roster.length]);

  useCommitEffect(() => {
    const next = slugKey ? slugKey.split("\u0000") : [];
    if (photoRef.current !== projectSlug) {
      photoRef.current = projectSlug;
      shownRef.current = next.length > 0 ? new Set(next) : null;
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
      setPhases((previous) => (Object.keys(previous).length > 0 ? {} : previous));
      return;
    }
    const shown = shownRef.current;
    if (!shown) {
      if (next.length > 0) shownRef.current = new Set(next);
      return;
    }
    shownRef.current = new Set(next);
    const arriving = reduced ? [] : arrivingCastSlugs(shown, next);
    const current = new Set(next);
    setPhases((previous) => {
      const kept: Record<string, ArrivalPhase> = {};
      for (const [slug, phase] of Object.entries(previous)) {
        if (current.has(slug)) kept[slug] = phase;
      }
      for (const slug of arriving) kept[slug] = "travel";
      return kept;
    });
    for (const slug of arriving) {
      /* Travel starts off the band's left edge, so the distance is this slot's
         own offset plus its width — measured, because the slots are centred
         and evenly gapped and therefore have no offset the CSS can guess. */
      const slot = slotRefs.current.get(slug);
      if (slot) {
        slot.style.setProperty("--xcp-from", `${-(slot.offsetLeft + slot.offsetWidth + 16)}px`);
      }
      timers.current.push(window.setTimeout(() => {
        setPhases((previous) => (previous[slug] === "travel" ? { ...previous, [slug]: "wave" } : previous));
      }, TRAVEL_MS));
      timers.current.push(window.setTimeout(() => {
        setPhases((previous) => {
          if (!(slug in previous)) return previous;
          const rest = { ...previous };
          delete rest[slug];
          return rest;
        });
      }, TRAVEL_MS + WAVE_MS));
    }
  }, [projectSlug, reduced, slugKey]);

  const running = Object.values(phases).some((phase) => phase === "travel");
  useEffect(() => {
    if (!running || reduced || typeof window === "undefined") return;
    const tick = window.setInterval(() => setRunFrame((frame) => (frame === 0 ? 1 : 0)), RUN_FRAME_MS);
    return () => clearInterval(tick);
  }, [reduced, running]);

  if (roster.length === 0) return null;

  const hue = projectHue(projectSlug);
  const drawHeight = fitFigureHeight(
    roster.map((figure) => {
      const art = CREW_ART[figure.castSlug];
      return art ? art.w / art.h : 1;
    }),
    bandWidth,
    figureHeight,
  );

  return (
    <div
      ref={bandRef}
      className={`xcp-photo${className ? ` ${className}` : ""}`}
      style={{
        height: bandHeight,
        background: crewGround(hue, 0.7),
        ...style,
      }}
    >
      <div className="xcp-stage">
        {roster.map((figure) => {
          const phase = phases[figure.castSlug];
          const canRun = hasPose(figure.castSlug, "run-a") && hasPose(figure.castSlug, "run-b");
          const pose: PoseName | "rest" = phase === "travel" && canRun
            ? (runFrame === 0 ? "run-a" : "run-b")
            : phase === "wave"
              ? "wave"
              : "rest";
          return (
            <span
              key={figure.castSlug}
              className="xcp-slot"
              style={{ width: drawHeight * CREW_ART[figure.castSlug].w / CREW_ART[figure.castSlug].h }}
              data-phase={phase ?? undefined}
              data-run={canRun ? undefined : "off"}
              ref={(node) => {
                if (node) slotRefs.current.set(figure.castSlug, node);
                else slotRefs.current.delete(figure.castSlug);
              }}
            >
              <CrewFigure
                slug={figure.castSlug}
                height={drawHeight}
                pose={pose}
                floor={false}
                halo={projectSlug}
                blink
                alt={figure.name}
              />
              <span className="xcp-name" title={figure.name}>{figure.name}</span>
            </span>
          );
        })}
      </div>
      <span className="xcp-fade" aria-hidden />
    </div>
  );
}

/* ── Empty stage ─────────────────────────────────────────────────────── */

export interface ProjectEmptyStageProps {
  /** The project's crew, if it ever had one. */
  subjects: readonly CrewPhotoSubject[];
  projectSlug: string;
  /** Wired only when the app has a real way to start one. */
  onStart?: (() => void) | null;
}

/**
 * A project with no sessions: one member on an empty stage.
 *
 * The member is whoever worked here last. When nobody ever did there is no
 * identity to show, so the figure is openly decoration — assigned from the
 * project slug and deliberately unnamed, because a name under it would claim
 * somebody is here.
 */
export function ProjectEmptyStage({ subjects, projectSlug, onStart }: ProjectEmptyStageProps) {
  const scout = useOptionalScout();
  const last = useMemo(
    () => crewPhotoRoster(crewPhotoFigures(scout, subjects), 1)[0] ?? null,
    [scout, subjects],
  );
  const slug = last?.castSlug ?? assignCastSlug(projectSlug);

  return (
    <div className="xcp-empty" role="note">
      <CrewFigure
        slug={slug}
        height={210}
        pose={hasPose(slug, "wave") ? "wave" : "rest"}
        floor
        halo={null}
        blink
        alt={last?.name ?? ""}
      />
      {last ? <span className="xcp-emptyWho">{last.name}</span> : null}
      <span className="xcp-emptyTitle">Nobody is flying this project yet</span>
      <span className="xcp-emptyDetail">Start a conversation and the crew shows up here.</span>
      {onStart ? (
        <button type="button" className="xcp-emptyAction" onClick={onStart}>
          Start a conversation
        </button>
      ) : null}
    </div>
  );
}
