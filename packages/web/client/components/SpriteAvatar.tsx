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
        filter: glow ? `drop-shadow(0 1.6px 5px ${palette.glow})` : undefined,
      }}
    >
      {cells.flatMap((row, ri) =>
        row.map((c, ci) => {
          if (c === "off") return null;
          const x = ci * UNIT;
          const y = ri * UNIT;
          const key = `${ri}-${ci}`;
          if (c === "eye") {
            return (
              <g key={key} className="sprite-cell sprite-cell--eye">
                <rect x={x + gap} y={y + gap} width={UNIT - gap * 2} height={UNIT - gap * 2} rx={radius} fill={palette.sclera} />
                <circle cx={x + UNIT / 2} cy={y + UNIT * 0.52} r={pupil} fill={palette.ink} />
              </g>
            );
          }
          const fill = c === "accent" ? palette.accent : c === "mouth" ? palette.ink : palette.body;
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
