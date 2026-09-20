import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { HarnessMark } from "./HarnessMark.tsx";
import {
  CHIP_ART,
  CREW_ART,
  CREW_ASSETS_AVAILABLE,
  CREW_SHEETS,
  SHEET_FRAMES,
  crewAssetUrl,
  crewGround,
  displayCoin,
  poseAsset,
  projectHue,
} from "../lib/crew-registry.ts";
import type { PoseName } from "../lib/crew-registry.ts";
import {
  GAZE_GLANCE_MS,
  GAZE_IDLE_MS,
  createGazeTracker,
  gazeRole,
  glanceToward,
  subscribeAttention,
  subscribePointer,
} from "../lib/crew-gaze.ts";
import type { GazeDir } from "../lib/crew-gaze.ts";
import "./crew-avatar.css";

export type CrewMascotState =
  | "idle"
  | "thinking"
  | "working"
  | "needs"
  | "error"
  | "offline";

export interface CrewAvatarProps {
  slug: string;
  name?: string;
  project?: string | null;
  harness?: string | null;
  state?: string | null;
  size?: number;
  badge?: boolean;
  ring?: boolean;
  chip?: boolean;
  glow?: boolean;
  /**
   * Where the eyes look. `"pointer"` follows the cursor while it is near the
   * coin (see `crew-gaze.ts`); a direction pins them. Blinks still win, and a
   * sheet without the frame for a direction rests instead of guessing.
   */
  gaze?: "pointer" | GazeDir;
  /**
   * A whole-body pose frame in place of the rest bust (see `CREW_POSES`). A
   * member without the frame draws rest. Eyes are only drawn at rest: a turned
   * head has its own eyes in the art.
   */
  pose?: PoseName | "rest";
  /**
   * Pack-relative bust URL override. Hosted Chat's landing imports a few coins
   * as bundled assets because that build has no `/crew` public tree. A custom
   * bust skips eye-sheet overlays — those files are not in the override.
   */
  bustSrc?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * Ring colour per state — the app's status tokens, not this file's own greens.
 *
 * These were six literals, and the cost was not only that they ignored the
 * theme. `--scout-chrome-ink-dim` is defined NOWHERE in the repo, so `idle`
 * silently resolved to its `#71717a` fallback in every theme — a token that
 * reads as intentional and never was. And the crew ring's `#7fb069` sat beside
 * a generative sprite whose presence dot comes from `stateColor()`, which
 * returns `var(--green)`: two renderers of the same system, in the same row,
 * disagreeing about the colour of working.
 *
 * Routing to the status tokens settles both. `idle` and `offline` share `dim`
 * because they always did — `#71717a` and `#6e6e72` are the same grey to the
 * eye — and stay distinct the way they actually read: offline is the dashed,
 * half-opacity ring.
 */
const STATE_CONFIG: Record<
  CrewMascotState,
  { label: string; colour: string }
> = {
  idle: { label: "Idle", colour: "var(--hud-dim, #71717a)" },
  thinking: { label: "Thinking", colour: "var(--info, #6fb7c7)" },
  working: { label: "Working", colour: "var(--hud-status-ok, #7fb069)" },
  needs: { label: "Needs attention", colour: "var(--hud-status-warn, #d9a441)" },
  error: { label: "Error", colour: "var(--hud-status-error, #c74a4a)" },
  offline: { label: "Offline", colour: "var(--hud-dim, #6e6e72)" },
};

function normalizeCrewState(rawState?: string | null): CrewMascotState {
  if (!rawState) return "idle";
  const s = rawState.toLowerCase();
  if (s.includes("think")) return "thinking";
  if (s.includes("work") || s.includes("turn") || s.includes("stream") || s.includes("run") || s.includes("busy")) return "working";
  if (s.includes("need") || s.includes("wait") || s.includes("block") || s.includes("ask") || s.includes("prompt")) return "needs";
  if (s.includes("err") || s.includes("fail") || s.includes("crash")) return "error";
  if (s.includes("off") || s.includes("stop") || s.includes("down") || s.includes("dead")) return "offline";
  return "idle";
}

/**
 * Blink scheduler: frames 1 → 2 → 1 → 0 at 40/90/130ms, every 2.8–7.3s on the
 * member's own clock. `blinkNonce` asks for one now — the end of a glance —
 * without disturbing the schedule. Exported so the full figure blinks the same
 * way the coin does.
 */
export function useBlinkFrame(framesCount: number, blinkNonce = 0): number {
  const [frame, setFrame] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (framesCount < 3) return;
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const schedule = () => {
      timers.current.push(
        window.setTimeout(() => {
          setFrame(1);
          timers.current.push(window.setTimeout(() => setFrame(2), 40));
          timers.current.push(window.setTimeout(() => setFrame(1), 90));
          timers.current.push(
            window.setTimeout(() => {
              setFrame(0);
              schedule();
            }, 130),
          );
        }, 2800 + Math.random() * 4500),
      );
    };

    schedule();
    const activeTimers = timers.current;
    return () => {
      activeTimers.forEach((id) => window.clearTimeout(id));
      activeTimers.length = 0;
    };
  }, [framesCount]);

  useEffect(() => {
    if (blinkNonce === 0 || framesCount < 3) return;
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const ids = [
      window.setTimeout(() => setFrame(1), 0),
      window.setTimeout(() => setFrame(2), 40),
      window.setTimeout(() => setFrame(1), 90),
      window.setTimeout(() => setFrame(0), 130),
    ];
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [blinkNonce, framesCount]);

  return framesCount < 3 ? 0 : frame;
}

/**
 * Where one coin looks. Two claims on the eyes, resolved in order:
 *
 * - the POINTER, while it is within the coin's follow radius — the closer
 *   claim, so it wins; rests after `GAZE_IDLE_MS` of silence or when the
 *   pointer leaves the page;
 * - the ATTENTION target (`setAttentionTarget`, e.g. the composer taking
 *   focus): a glance toward it held for `GAZE_GLANCE_MS`, then one blink and
 *   rest. Every coin hears the same event, so the crew turns together.
 *
 * Subscribes only while enabled, re-renders only when the quantised direction
 * changes, and does nothing under reduced motion.
 */
function useCrewGaze(
  ref: { current: HTMLElement | null },
  enabled: boolean,
  size: number,
): { dir: GazeDir; blinkNonce: number } {
  const [dir, setDir] = useState<GazeDir>("rest");
  const [blinkNonce, setBlinkNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setDir("rest");
      return;
    }
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const tracker = createGazeTracker(size);
    const measure = () => ref.current?.getBoundingClientRect() ?? null;
    let pointer: GazeDir = "rest";
    let glance: GazeDir = "rest";
    let current: GazeDir = "rest";
    let idleTimer = 0;
    let glanceTimer = 0;
    const apply = () => {
      const next = pointer !== "rest" ? pointer : glance;
      if (next === current) return;
      current = next;
      setDir(next);
    };

    const unsubscribePointer = subscribePointer((sample) => {
      pointer = tracker.sample(sample, measure);
      apply();
      window.clearTimeout(idleTimer);
      if (pointer !== "rest") {
        idleTimer = window.setTimeout(() => {
          pointer = "rest";
          apply();
        }, GAZE_IDLE_MS);
      }
    });
    const unsubscribeAttention = subscribeAttention((target) => {
      window.clearTimeout(glanceTimer);
      glance = target ? glanceToward(target, measure()) : "rest";
      apply();
      if (glance !== "rest") {
        glanceTimer = window.setTimeout(() => {
          glance = "rest";
          apply();
          setBlinkNonce((n) => n + 1);
        }, GAZE_GLANCE_MS);
      }
    });
    return () => {
      unsubscribePointer();
      unsubscribeAttention();
      window.clearTimeout(idleTimer);
      window.clearTimeout(glanceTimer);
    };
  }, [enabled, size, ref]);

  return { dir: enabled ? dir : "rest", blinkNonce };
}

export function CrewAvatar({
  slug,
  name,
  project,
  harness,
  state,
  size,
  badge = true,
  ring = true,
  chip = false,
  glow = false,
  gaze,
  pose = "rest",
  bustSrc,
  className,
  style,
  title,
}: CrewAvatarProps) {
  const key = slug.toLowerCase();
  const art = CREW_ART[key];
  const sheet = bustSrc ? undefined : CREW_SHEETS[key];
  const crewState = normalizeCrewState(state);
  const st = STATE_CONFIG[crewState];

  const shellRef = useRef<HTMLSpanElement>(null);
  const atRest = pose === "rest";
  const { dir: pointerDir, blinkNonce } = useCrewGaze(shellRef, gaze === "pointer" && atRest && Boolean(sheet), size ?? 40);
  const frameIdx = useBlinkFrame(sheet && atRest ? sheet.roles.length + 1 : 1, blinkNonce);
  const blinkRole = sheet && frameIdx > 0 ? SHEET_FRAMES[frameIdx]?.role : undefined;
  const gazeDir: GazeDir = gaze === "pointer" ? pointerDir : (gaze ?? "rest");
  // A blink interrupts a look, never the other way round: mid-blink frames win.
  // A pose frame carries its own eyes, so no patch is drawn over it.
  const role = atRest ? (blinkRole ?? gazeRole(gazeDir, sheet?.roles)) : undefined;

  const pHue = useMemo(() => projectHue(project), [project]);
  // The ground is picked from the ink of the cut ACTUALLY being drawn. Bust and
  // chip disagree per member (brik: 0.37 vs 0.81), so reading the bust's ink
  // while drawing a chip would put the art on the ground built to swallow it.
  const ink = (chip ? CHIP_ART[key]?.ink : undefined) ?? art?.ink ?? 1;
  const bg = useMemo(() => crewGround(pHue, ink), [pHue, ink]);

  // Production software omits the source artwork. A configured web pack makes
  // the same renderer available without embedding those files in the app.
  if (!art || !CREW_ASSETS_AVAILABLE) return null;

  const chipArt = chip ? CHIP_ART[key] : undefined;
  const effectiveSize = size ?? 40;
  const [coinX, coinY, coinSide] = displayCoin(art, effectiveSize);
  const imgW = `${(art.w / coinSide) * 100}%`;
  const imgH = `${(art.h / coinSide) * 100}%`;
  const imgLeft = `${(-coinX / coinSide) * 100}%`;
  const imgTop = `${(-coinY / coinSide) * 100}%`;

  const displayName = name || slug.toUpperCase();
  const hoverTitle = title ?? `${displayName} · ${project || "openscout"} · ${harness || "scout"} · ${st.label}`;

  const showBadge = badge && effectiveSize >= 28 && Boolean(harness && harness !== "unknown");

  const dims: CSSProperties = size != null
    ? { width: size, height: size }
    : { width: "100%", height: "100%" };

  return (
    <span
      className={`xc-avatar-root ${className || ""}`}
      style={{
        ...dims,
        boxShadow: glow ? `0 0 ${Math.round(effectiveSize * 0.3)}px ${st.colour}` : undefined,
        ...style,
      }}
      title={hoverTitle}
    >
      <span
        ref={shellRef}
        className="xc-avatar-shell"
        style={{
          background: bg,
          opacity: crewState === "offline" ? 0.55 : 1,
        }}
      >
        {chipArt ? (
          /* Identity pixels only. Ground is behind, ring and badge are drawn
             over — the same four slots the bust renderer fills, just pixel art
             in the WHO slot. `fill` leaves the outer margin the ring and the
             facepile's lap carve need, so neither eats the face. */
          <img
            src={crewAssetUrl(`${key}-chip-id.webp`)}
            alt=""
            className="xc-avatar-img xc-avatar-img--pixel"
            style={{
              width: `${chipArt.fill * 100}%`,
              height: `${chipArt.fill * 100}%`,
              left: `${(0.5 - chipArt.fill / 2 + (chipArt.nudge?.[0] ?? 0)) * 100}%`,
              top: `${(0.5 - chipArt.fill / 2 + (chipArt.nudge?.[1] ?? 0)) * 100}%`,
            }}
          />
        ) : (
          <>
            <img
              src={bustSrc ?? crewAssetUrl(poseAsset(key, pose))}
              alt=""
              className="xc-avatar-img"
              style={{
                width: imgW,
                height: imgH,
                left: imgLeft,
                top: imgTop,
              }}
            />
            {sheet && role && (
              <img
                src={crewAssetUrl(`${sheet.dir}/${role}.webp`)}
                alt=""
                className="xc-avatar-patch"
                style={{
                  width: `${(sheet.patch[2] / coinSide) * 100}%`,
                  height: `${(sheet.patch[3] / coinSide) * 100}%`,
                  left: `${((-coinX + sheet.patch[0]) / coinSide) * 100}%`,
                  top: `${((-coinY + sheet.patch[1]) / coinSide) * 100}%`,
                }}
              />
            )}
          </>
        )}
      </span>

      {ring && (
        <span
          className="xc-ring"
          data-ring={crewState}
          style={{ ["--xc-c" as string]: st.colour }}
        />
      )}

      {showBadge && (
        <HarnessMark
          harness={harness!}
          size={Math.max(8, Math.round(effectiveSize * 0.22))}
          className="xc-badge-mark"
          style={{
            right: "0%",
            bottom: "0%",
            width: "32%",
            height: "32%",
            minWidth: 12,
            minHeight: 12,
          }}
          title={null}
        />
      )}
    </span>
  );
}
