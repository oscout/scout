import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CREW_ART,
  CREW_ASSETS_AVAILABLE,
  CREW_SHEETS,
  CAST_MEMBERS,
  SHEET_FRAMES,
  crewAssetUrl,
  crewGround,
} from "../lib/crew-registry.ts";
import "./crew-avatar.css";

export interface CrewStageProps {
  slug: string;
  open?: boolean;
  onToggle?: () => void;
  coin?: number;
  figure?: number;
  hue?: number | null;
  state?: string | null;
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
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
        }, 2600 + Math.random() * 4200),
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

/**
 * Stage component implementing the coin → full figure breakout morph.
 * One master image, two declared framings. Morphing expands the crop into the
 * full body with smooth GPU-accelerated bezier transitions.
 */
export function CrewStage({
  slug,
  open = false,
  onToggle,
  coin = 56,
  figure = 240,
  hue,
  state = "idle",
  interactive = true,
  className,
  style,
  children,
}: CrewStageProps) {
  const normalizedSlug = slug.toLowerCase();
  const art = CREW_ART[normalizedSlug] ?? CREW_ART.milo;
  const sheet = CREW_SHEETS[normalizedSlug];
  const member = CAST_MEMBERS.find((m) => m.slug === normalizedSlug) ?? CAST_MEMBERS[0];

  const frameIdx = useSheetFrame(sheet ? sheet.roles.length + 1 : 1);
  const role = sheet && frameIdx > 0 ? SHEET_FRAMES[frameIdx]?.role : undefined;

  if (!CREW_ASSETS_AVAILABLE) return null;

  const [coinX, coinY, coinSide] = art.coin;
  const kCoin = coin / coinSide;
  const figW = (figure * art.w) / art.h;
  const kFig = figure / art.h;

  const width = open ? figW : coin;
  const height = open ? figure : coin;

  const imgWidth = open ? figW : art.w * kCoin;
  const imgHeight = open ? figure : art.h * kCoin;
  const imgLeft = open ? 0 : -coinX * kCoin;
  const imgTop = open ? 0 : -coinY * kCoin;

  // Disc ground: neutral when no hue is supplied (default), so the
  // background is decoupled from the character's identity hue. Callers
  // that want a colored disc must pass an explicit hue.
  const groundBg = useMemo(() => crewGround(hue ?? null, art.ink), [hue, art.ink]);

  const patchWidth = sheet ? sheet.patch[2] * (open ? kFig : kCoin) : 0;
  const patchHeight = sheet ? sheet.patch[3] * (open ? kFig : kCoin) : 0;
  const patchLeft = sheet
    ? (open ? 0 : imgLeft) + sheet.patch[0] * (open ? kFig : kCoin)
    : 0;
  const patchTop = sheet
    ? (open ? 0 : imgTop) + sheet.patch[1] * (open ? kFig : kCoin)
    : 0;

  return (
    <div
      className={`xc-stage-wrapper ${className || ""}`}
      style={style}
      data-open={open ? "true" : "false"}
    >
      <div
        className="xc-stage"
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={`${member.name} (${open ? "Full body breakout" : "Coin disc"})`}
        onClick={interactive ? onToggle : undefined}
        onKeyDown={
          interactive && onToggle
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        style={{
          width,
          height,
          borderRadius: open ? "16px" : "50%",
        }}
      >
        <span
          className="xc-stage-ground"
          style={{
            background: groundBg,
            opacity: open ? 0.92 : 1,
            borderRadius: open ? "16px" : "50%",
          }}
        />

        <img
          src={crewAssetUrl(`${normalizedSlug}-bust.webp`)}
          alt={member.name}
          className="xc-stage-img"
          style={{
            width: imgWidth,
            height: imgHeight,
            left: imgLeft,
            top: imgTop,
          }}
        />

        {sheet && role && (
          <img
            src={crewAssetUrl(`${sheet.dir}/${role}.webp`)}
            alt=""
            className="xc-stage-patch"
            style={{
              width: patchWidth,
              height: patchHeight,
              left: patchLeft,
              top: patchTop,
            }}
          />
        )}
      </div>

      {children}
    </div>
  );
}
