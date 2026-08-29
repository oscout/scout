import type { CSSProperties } from "react";
import { useMemo } from "react";
import { HARNESS_HUE, spriteFor, type SpriteOpts, type Tone } from "../lib/agent-identity.ts";
import {
  normalizeAgentState,
  type AgentDisplayState,
} from "../lib/agent-state.ts";

/**
 * SpriteAvatar — the production agent avatar.
 *
 * A deterministic little creature generated from the agent's name
 * (lib/agent-identity.ts). The mark is read at a glance:
 *   shape      = WHO        (the name)
 *   hue        = HARNESS    (the runtime — see HARNESS_HUE)
 *   brightness = STATE      (working is vivid, offline greys out)
 *
 * Geometry is viewBox-based, so one component scales crisply from an 18px
 * roster pip to a 96px hero. Pass an explicit `size` for fixed layouts, or
 * omit it to fill the parent. Use `agentSpriteProps(agent)` to derive the
 * hue + tone from a real agent.
 */

const SPRITE_SIZE = 7;
const UNIT = 10; // user units per cell in the viewBox
const DIM = SPRITE_SIZE * UNIT;

export interface SpriteAvatarProps {
  name: string;
  /** Pixel box (square). Omit to fill the parent (100%). */
  size?: number;
  /** Force the hue (harness-tint / curation). */
  hue?: number;
  /** Body lightness/chroma — the state-driven range. */
  tone?: Tone;
  /** Reroll entropy — a different creature for the same name. */
  salt?: string;
  /** Full 0–359 spectrum instead of the curated wheel. */
  spectrum?: boolean;
  /** Soft hue-wash tile behind the creature. */
  tile?: boolean;
  /** Drop-shadow bloom. Defaults on at ≥40px. */
  glow?: boolean;
  /** A state dot in the corner (pass the color). */
  corner?: string;
  /** Pulse ring on the corner dot (working state). */
  cornerPulse?: boolean;
  className?: string;
  title?: string;
}

export function SpriteAvatar({
  name,
  size,
  hue,
  tone,
  salt,
  spectrum,
  tile = false,
  glow,
  corner,
  cornerPulse,
  className,
  title,
}: SpriteAvatarProps) {
  const sprite = useMemo(() => {
    const opts: SpriteOpts = { hue, salt, spectrum, tone };
    return spriteFor(name, opts);
  }, [name, hue, salt, spectrum, tone?.l, tone?.c]);

  const showGlow = glow ?? (size != null && size >= 40);
  const dims: CSSProperties = size != null ? { width: size, height: size } : { width: "100%", height: "100%" };

  const wrapStyle: CSSProperties = {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    ...dims,
    borderRadius: tile ? "26%" : undefined,
    background: tile ? sprite.palette.soft : undefined,
    boxSizing: "border-box",
  };

  return (
    <span className={className} style={wrapStyle} title={title}>
      <SpriteSvg sprite={sprite} glow={showGlow} inset={tile} />
      {corner && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: "-4%",
            bottom: "-4%",
            width: "28%",
            height: "28%",
            minWidth: 6,
            minHeight: 6,
            borderRadius: "999px",
            background: corner,
            boxShadow: cornerPulse
              ? `0 0 0 2px var(--scout-chrome-surface, var(--hud-bg, #000)), 0 0 0 4px color-mix(in oklab, ${corner} 32%, transparent)`
              : `0 0 0 2px var(--scout-chrome-surface, var(--hud-bg, #000))`,
          }}
        />
      )}
    </span>
  );
}

/** The raw SVG creature — viewBox-based, scales to its box.
 *  `inset` shrinks the creature to 72% and lets the centered wrapper provide
 *  the tile margin (≈ the old 14%-per-side). We size off width + aspect-ratio,
 *  never height:100% — a percentage height collapses to 0 inside an
 *  inline-grid wrapper and leaves an empty tile. */
export function SpriteSvg({
  sprite,
  glow = false,
  inset = false,
}: {
  sprite: ReturnType<typeof spriteFor>;
  glow?: boolean;
  inset?: boolean;
}) {
  const { cells, palette } = sprite;
  const gap = UNIT * 0.07;
  const radius = UNIT * 0.2;
  const pupil = UNIT * 0.24;

  /* ONE light, across the whole creature.
   *
   * Every lit cell used to take the same flat `body`, so a sprite read as a
   * mosaic of identical tiles rather than a lit object — and `bodyDim`, the
   * palette's own shadow value, was never drawn anywhere. The ramp below
   * spends exactly that range: a small lift on the head row falling away to
   * roughly `bodyDim` at the feet, with chroma creeping up into the shadow the
   * way it does in oklch. The light crosses the SILHOUETTE, not each tile, so
   * the creature gains a form instead of thirty individually shaded pixels.
   *
   * Geometry is deliberately untouched — same cells, same `gap`, same
   * `radius`, same pupil, all of which are mirrored constants in the SwiftUI
   * port. This is finish, not a different creature. */
  const LIFT = 0.05;
  const DROP = 0.085;
  const rows = cells.length;
  const shadeAt = (ri: number) => {
    const t = rows > 1 ? ri / (rows - 1) : 0;
    return { d: LIFT - (LIFT + DROP) * t, t };
  };
  const lit = (l: number) => Math.max(0.06, Math.min(0.97, l));
  const bodyAt = (ri: number) => {
    const { d, t } = shadeAt(ri);
    return `oklch(${lit(palette.bodyL + d)} ${palette.bodyC + t * 0.012} ${palette.hue})`;
  };
  const accentAt = (ri: number) => {
    const { d, t } = shadeAt(ri);
    return `oklch(${lit(palette.accentL + d)} ${palette.accentC + t * 0.012} ${palette.accentHue})`;
  };

  /* A tight contact edge at EVERY size, not just the glow tier. The coloured
   * bloom only separates a creature from a dark panel; on light paper it left
   * the silhouette floating, so the shape needs an edge of its own. */
  const filter = [
    /* Tighter and fainter than the old 5px/45% bloom, which at a 46px coin was
       a haze wide enough to soften the very silhouette it was meant to lift. A
       glow should read as the creature sitting ABOVE the panel, not as fog. */
    glow
      ? `drop-shadow(0 1px 3.5px color-mix(in oklab, ${palette.glow} 68%, transparent))`
      : null,
    `drop-shadow(0 0.35px 0.5px oklch(0.16 0.04 ${palette.hue} / 0.55))`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${DIM} ${DIM}`}
      shapeRendering="geometricPrecision"
      style={{
        display: "block",
        width: inset ? "72%" : "100%",
        height: "auto",
        aspectRatio: "1 / 1",
        overflow: "visible",
        filter,
      }}
    >
      {cells.flatMap((row, ri) =>
        row.map((c, ci) => {
          if (c === "off") return null;
          const x = ci * UNIT;
          const y = ri * UNIT;
          const key = `${ri}-${ci}`;
          if (c === "eye") {
            const ex = x + UNIT / 2;
            const ey = y + UNIT * 0.52;
            return (
              <g key={key} className="sprite-cell sprite-cell--eye">
                <rect x={x + gap} y={y + gap} width={UNIT - gap * 2} height={UNIT - gap * 2} rx={radius} fill={palette.sclera} />
                <circle cx={ex} cy={ey} r={pupil} fill={palette.ink} />
                {/* Catchlight. Sized as a fraction of the pupil, so it melts
                    into the ink at a 20px roster pip and only resolves once the
                    coin is big enough to read as a face. The eye is the one
                    place a creature stops being a pattern.

                    An <ellipse>, NOT a second <circle>, and that is load-bearing.
                    The comms facepile animates `.sprite-cell--eye circle` with
                    absolute radii tuned to the pupil (`r: 2.4px → 3.2px` in
                    conversation-screen.css — widen on hover, dilate in turn). A
                    circle here would be swept up by those selectors and balloon
                    to pupil size, swallowing the eye on every hover. Sitting
                    outside that selector keeps the four eye channels documented
                    there disjoint, with no edit to their file. */}
                <ellipse
                  cx={ex - pupil * 0.33}
                  cy={ey - pupil * 0.36}
                  rx={pupil * 0.34}
                  ry={pupil * 0.34}
                  fill={palette.sclera}
                  opacity={0.9}
                />
              </g>
            );
          }
          /* `mouth` keeps `palette.ink` untouched: its fill treatment is
             paired with the SwiftUI port and cannot move on one side alone. */
          const fill = c === "accent" ? accentAt(ri) : c === "mouth" ? palette.ink : bodyAt(ri);
          const cellClass = c === "accent" ? "sprite-cell sprite-cell--accent" : "sprite-cell";
          return <rect key={key} className={cellClass} x={x + gap} y={y + gap} width={UNIT - gap * 2} height={UNIT - gap * 2} rx={radius} fill={fill} />;
        }),
      )}
    </svg>
  );
}

// ── agent mapping — hue ← harness, tone ← state ──────────────────────────

const STATE_TONE: Record<AgentDisplayState, Tone> = {
  in_turn: { l: 0.75, c: 0.16 },
  in_flight: { l: 0.72, c: 0.14 },
  needs_attention: { l: 0.78, c: 0.16 },
  callable: { l: 0.73, c: 0.13 },
  blocked: { l: 0.5, c: 0.02 },
};

/** Derive sprite hue + tone from an agent's harness + state. */
export function agentSpriteProps(agent: {
  harness?: string | null;
  state?: string | null;
}): { hue?: number; tone: Tone } {
  const key = agent.harness?.trim().toLowerCase();
  return {
    hue: key ? HARNESS_HUE[key] : undefined,
    tone: STATE_TONE[normalizeAgentState(agent.state ?? null)],
  };
}
