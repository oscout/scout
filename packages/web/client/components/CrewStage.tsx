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
  displayCoin,
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
  /** Corner radius of the OPEN stage, px. The coin is always a disc. */
  radius?: number;
  /**
   * Draw the contact shadow the open figure stands on.
   *
   * The floor is app-drawn, never painted into the master: the same art has to
   * read as a coin with no ground under it, so a baked shadow would be a
   * smudge at the bottom of every disc. It fades with the morph rather than
   * scaling with it — a shadow that grew out of a 96px disc would read as part
   * of the character.
   */
  floor?: boolean;
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
  radius = 16,
  floor = false,
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

  const [coinX, coinY, coinSide] = displayCoin(art, coin);
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

  const openRadius = `${radius}px`;

  /* Sized off the FIGURE, not the current box: the ellipse under the boots is
     a property of how big the member is standing up, so it holds still while
     the disc expands instead of inflating with it. ~120 × 16 at figure=224. */
  const floorWidth = Math.round(figW * 0.68);
  const floorHeight = Math.max(8, Math.round(figure * 0.072));

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
        aria-expanded={interactive ? open : undefined}
        aria-label={`${member.name} (${open ? "Full figure" : "Avatar"})`}
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
          borderRadius: open ? openRadius : "50%",
        }}
      >
        <span
          className="xc-stage-ground"
          style={{
            background: groundBg,
            opacity: open ? 0.92 : 1,
            borderRadius: open ? openRadius : "50%",
          }}
        />

        {floor && (
          <span
            className="xc-stage-floor"
            aria-hidden
            style={{
              position: "absolute",
              left: "50%",
              bottom: 0,
              width: floorWidth,
              height: floorHeight,
              transform: "translateX(-50%)",
              borderRadius: "50%",
              background:
                "radial-gradient(closest-side at 50% 50%, color-mix(in srgb, black 45%, transparent) 0%, color-mix(in srgb, black 22%, transparent) 46%, transparent 100%)",
              opacity: open ? 1 : 0,
              transition: "opacity 400ms ease",
              pointerEvents: "none",
            }}
          />
        )}

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
