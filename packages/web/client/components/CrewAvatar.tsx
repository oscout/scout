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
  projectHue,
} from "../lib/crew-registry.ts";
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

function useSheetFrame(framesCount: number): number {
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

  return framesCount < 3 ? 0 : frame;
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
  className,
  style,
  title,
}: CrewAvatarProps) {
  const key = slug.toLowerCase();
  const art = CREW_ART[key];
  const sheet = CREW_SHEETS[key];
  const crewState = normalizeCrewState(state);
  const st = STATE_CONFIG[crewState];

  const frameIdx = useSheetFrame(sheet ? sheet.roles.length + 1 : 1);
  const role = sheet && frameIdx > 0 ? SHEET_FRAMES[frameIdx]?.role : undefined;

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
              src={crewAssetUrl(`${slug.toLowerCase()}-bust.webp`)}
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
