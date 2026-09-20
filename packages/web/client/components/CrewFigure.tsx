import type { CSSProperties } from "react";
import { useMemo } from "react";
import {
  CREW_ART,
  CREW_ASSETS_AVAILABLE,
  CREW_SHEETS,
  GROUND_SPLIT,
  SHEET_FRAMES,
  crewAssetUrl,
  crewGround,
  poseAsset,
  projectHue,
} from "../lib/crew-registry.ts";
import type { PoseName } from "../lib/crew-registry.ts";
import { useBlinkFrame } from "./CrewAvatar.tsx";
import "./crew-avatar.css";

export interface CrewFigureProps {
  slug: string;
  /** Rendered height in px; width follows the master's aspect. */
  height: number;
  /** A whole-body pose frame; a member without it draws rest. */
  pose?: PoseName | "rest";
  /** Draw the app's floor shadow under the boots. */
  floor?: boolean;
  /**
   * Group hue for the two-band rule: a project name (hashed) or a hue. Art
   * darker than the split gets the light band behind it; lighter art needs
   * nothing. `null` draws no halo at all.
   */
  halo?: string | number | null;
  /** Blink on the member's own clock (rest pose only). */
  blink?: boolean;
  alt?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The whole master, standing. The one placement allowed to show the full
 * figure: a profile, an empty stage, the crew photo. Coin and figure are crops
 * of the same image, so a member looks the same here as in its 28px pip —
 * just more of it.
 */
export function CrewFigure({
  slug,
  height,
  pose = "rest",
  floor = false,
  halo = null,
  blink = true,
  alt = "",
  className,
  style,
}: CrewFigureProps) {
  const key = slug.toLowerCase();
  const art = CREW_ART[key];
  const sheet = CREW_SHEETS[key];
  const atRest = pose === "rest";
  const frameIdx = useBlinkFrame(blink && atRest && sheet ? sheet.roles.length + 1 : 1);
  const role = atRest && sheet && frameIdx > 0 ? SHEET_FRAMES[frameIdx]?.role : undefined;
  const hue = useMemo(
    () => (typeof halo === "number" ? halo : halo ? projectHue(halo) : null),
    [halo],
  );

  if (!art || !CREW_ASSETS_AVAILABLE) return null;

  const k = height / art.h;
  const width = art.w * k;
  const showHalo = hue != null && art.ink < GROUND_SPLIT;

  return (
    <span
      className={`xc-figure ${className ?? ""}`}
      style={{ width, height, ["--xc-fig-h" as string]: `${height}px`, ...style }}
      data-pose={pose}
    >
      {showHalo && <span className="xc-figure-halo" style={{ background: crewGround(hue, art.ink) }} />}
      {floor && <span className="xc-figure-floor" />}
      <img src={crewAssetUrl(poseAsset(key, pose))} alt={alt} className="xc-figure-img" draggable={false} />
      {sheet && role && (
        <img
          src={crewAssetUrl(`${sheet.dir}/${role}.webp`)}
          alt=""
          className="xc-figure-patch"
          style={{
            width: sheet.patch[2] * k,
            height: sheet.patch[3] * k,
            left: sheet.patch[0] * k,
            top: sheet.patch[1] * k,
          }}
        />
      )}
    </span>
  );
}
