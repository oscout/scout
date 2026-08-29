import type { CSSProperties } from "react";
import { useOptionalScout } from "../scout/Provider.tsx";
import { SpriteAvatar, agentSpriteProps } from "./SpriteAvatar.tsx";
import { CrewAvatar } from "./CrewAvatar.tsx";
import { CREW_ART, CREW_ASSETS_AVAILABLE, assignCastSlug, hasChipArt, matchCastSlug } from "../lib/crew-registry.ts";
import { stateColor } from "../lib/colors.ts";
import { isAgentInTurn, isAgentOnline } from "../lib/agent-state.ts";
import {
  resolveAgentCharacterAssignment,
  type ScoutAvatarSize,
  type ScoutAvatarStyle,
} from "../lib/theme.ts";

/**
 * AgentAvatar — the single entry point for agent, operator, and channel avatars.
 *
 * One component, many placements. Pass an `agent` (or a bare `name`) and a
 * `placement`, and the right treatment is applied — size, tile wash, presence
 * dot, glow, or high-fidelity Crew mascot art with animated eye sheets and
 * 4-slot status rings.
 *
 * Respects operator appearance settings (`avatarStyle: "crew" | "sprite" | "chip"`)
 * with graceful per-agent fallback to SpriteAvatar if the agent is not in the cast.
 */

export type AvatarPlacement =
  | "hero" // profile header — fills a framed circle, glow on; host owns the ring
  | "inspector" // inspector identity header — 40px tile + presence dot
  | "row" // dense list rows (home / agents / terminal) — tile + presence dot
  | "turn" // message / signal turn — fills host, flat, no dot
  | "list" // activity list item — fills host, flat, no dot
  | "roster" // left-rail pip — flat, name-only, host-driven size
  | "node"; // graph node — small, flat

interface Treatment {
  /** Fixed pixel box per operator avatar size. `undefined` → fill the parent (host class sizes it). */
  sizes?: Record<ScoutAvatarSize, number>;
  tile: boolean;
  glow?: boolean;
  /** Show a state dot in the corner (derived from the agent's state). */
  presence: boolean;
}

/**
 * The size ladder is a TABLE, not a multiplier on one number.
 *
 * Two reasons. Avatar boxes want integers — 24 × 1.3 is a 31.2px coin, which
 * resamples the art and softens the sprite's 7×7 grid onto half-pixels. And
 * the cast renderers have legibility floors measured in the kit study (28px
 * for the crew bust, 32px for the pixel chip, 20px for the generative sprite),
 * so the rungs should land on them rather than straddle them. `row` at
 * `compact` sits under the cast floors deliberately: that tier is for
 * operators reading the name, with the face as a colour cue.
 *
 * Fill placements (hero, turn, list, roster) are absent because their host
 * class owns the box — they follow the surface, not this setting.
 */
const PLACEMENT: Record<AvatarPlacement, Treatment> = {
  hero: { tile: false, presence: false, glow: true },
  inspector: { sizes: { compact: 32, regular: 40, large: 52 }, tile: true, presence: true },
  row: { sizes: { compact: 20, regular: 24, large: 32 }, tile: true, presence: true },
  turn: { tile: false, presence: false },
  list: { tile: false, presence: false },
  roster: { tile: false, presence: false },
  node: { sizes: { compact: 14, regular: 16, large: 20 }, tile: false, presence: false },
};

/**
 * Most call sites pass their own `size` rather than taking the placement
 * preset, so a preference that only moved the presets would be a control that
 * changes almost nothing — a setting the app does not honour. The tier is
 * therefore a SCALE, and the table above is what `row` / `inspector` / `node`
 * happen to land on when it is applied to their base.
 *
 * The range is deliberately narrow. An avatar usually sits in a row whose other
 * dimensions (line height, gap, the host's grid column) are fixed, so a tier
 * that doubled the coin would push text out of its container rather than make
 * anything more legible. ±~25% moves a 24px list coin between 20 and 30 — over
 * the crew bust's 28px floor at the top end, under it at the bottom, which is
 * the trade the two outer tiers are actually offering.
 */
const AVATAR_SIZE_SCALE: Record<ScoutAvatarSize, number> = {
  compact: 0.85,
  regular: 1,
  large: 1.25,
};

/** The px a placement resolves to at a given operator size. Exported so the
 *  Appearance settings can preview each tier at the size it actually draws. */
export function placementSize(
  placement: AvatarPlacement,
  avatarSize: ScoutAvatarSize,
): number | undefined {
  return PLACEMENT[placement].sizes?.[avatarSize];
}

/** Applies the operator's tier to a caller's own px. Integer, and never below
 *  the generative sprite's 20px floor — under that the 7×7 grid stops being a
 *  creature and becomes noise, whatever the density preference says. */
export function scaleAvatarSize(size: number, avatarSize: ScoutAvatarSize): number {
  if (avatarSize === "regular") return size;
  const scaled = Math.round(size * AVATAR_SIZE_SCALE[avatarSize]);
  return avatarSize === "compact" ? Math.max(20, Math.min(size, scaled)) : scaled;
}

export interface AgentAvatarProps {
  /** Agent identity — derives hue (harness), tone + presence (state). */
  agent?: {
    id?: string | null;
    name: string;
    harness?: string | null;
    state?: string | null;
    slug?: string | null;
    project?: string | null;
  };
  /** Bare name when there is no agent object (e.g. an actor on a message). */
  name?: string;
  /** Explicit mascot slug override (e.g. "milo", "sprout", "brik", "wrench", etc.) */
  slug?: string;
  /** Force a specific avatar style ("crew" | "sprite" | "chip") */
  avatarStyle?: ScoutAvatarStyle;
  /** Project context for crew radial background */
  project?: string | null;
  /** Harness runtime */
  harness?: string | null;
  /** State override */
  state?: string | null;
  /** "channel" renders a `#` glyph instead of a creature. */
  kind?: "agent" | "channel";
  /** Placement preset — sets the default treatment. */
  placement?: AvatarPlacement;
  /** Override the preset size (px). Omit to keep the preset / fill the parent. */
  size?: number;
  /**
   * Opt out of the operator's avatar-size preference.
   *
   * For the app FRAME — the top row, anything living in a fixed-height band.
   * The preference is a density choice about content: how much of a list you
   * want on screen, how readable a face in a row has to be. Chrome is not
   * content and its band does not grow, so a `large` coin there does not read
   * bigger, it reads clipped by the 40px bar it sits in.
   */
  scaleWithPreference?: boolean;
  /** Force the presence dot on/off (defaults to the placement). */
  presence?: boolean;
  /** Force the tile wash on/off (defaults to the placement). */
  tile?: boolean;
  /** Reroll entropy / the salt a claimed identity keeps. */
  salt?: string;
  /** Wrapper class — sizing for fill placements (e.g. `s-profile-identity-avatar`). */
  className?: string;
  /** Class applied to the `#` glyph in channel mode. */
  channelClassName?: string;
  style?: CSSProperties;
  title?: string;
}

export function AgentAvatar({
  agent,
  name,
  slug,
  avatarStyle,
  project,
  harness,
  state,
  kind = "agent",
  placement = "row",
  size,
  scaleWithPreference = true,
  presence,
  tile,
  salt,
  className,
  channelClassName,
  style,
  title,
}: AgentAvatarProps) {
  const label = agent?.name ?? name ?? "?";

  if (kind === "channel") {
    return (
      <span
        className={channelClassName ?? className}
        style={style}
        title={title ?? label}
      >
        #
      </span>
    );
  }

  const scout = useOptionalScout();
  /* The cached name first: it is the same value the server will confirm, and it
     is here in frame one. Without it every avatar labelled with the operator's
     real name fails the isOperator test on first paint and renders as somebody
     else's generative sprite, then swaps to the chosen character when the fetch
     lands — a worse flicker than the blank it replaced. */
  const operatorName =
    scout?.operatorName
    || scout?.onboarding?.operatorName?.trim()
    || scout?.onboarding?.operatorNameSuggestion?.trim()
    || "operator";

  const isOperator =
    label.toLowerCase() === "operator"
    || label.toLowerCase() === "you"
    || label.toLowerCase() === operatorName.toLowerCase()
    || label.toLowerCase() === "art";

  const operatorCharacter = scout?.appearanceDetails?.operatorCharacter || "milo";
  const activeAvatarStyle = avatarStyle ?? scout?.appearanceDetails?.avatarStyle ?? "crew";

  /**
   * A cast slug is something you ARE, not something you get handed.
   *
   * Precedence: an explicit `slug` prop, the operator's own character pick,
   * then the operator's assignment for this agent — each is a choice about
   * this identity, so it may fall back to a deterministic cast member. Last
   * comes accidental name match ("milo-runner" names Milo). An agent with
   * none of those renders as its own generative sprite: assigning it a cast
   * face at random aliases two identities into one, which reads as "these
   * are the same agent" everywhere avatars are the cue.
   */
  const assignedCharacter = isOperator
    ? undefined
    : resolveAgentCharacterAssignment(
        scout?.appearanceDetails?.agentCharacters,
        { id: agent?.id, name: label },
        scout?.agents ?? [],
      );
  const castSlug = slug
    ? (matchCastSlug(slug) ?? assignCastSlug(slug))
    : isOperator
      ? (matchCastSlug(operatorCharacter) ?? assignCastSlug(operatorCharacter))
      : (matchCastSlug(assignedCharacter)
        ?? matchCastSlug(agent?.slug || label));

  /**
   * Pixel Chip covers a subset of the cast. A member with no chip art falls
   * back to the generative sprite rather than silently borrowing the Crew
   * renderer, so the coverage gap is visible instead of papered over.
   */
  const castRenderable =
    CREW_ASSETS_AVAILABLE
    && castSlug != null
    && CREW_ART[castSlug] != null
    && (activeAvatarStyle !== "chip" || hasChipArt(castSlug));

  const t = PLACEMENT[placement];
  const tier = scaleWithPreference
    ? scout?.appearanceDetails?.avatarSize ?? "regular"
    : "regular";
  const resolvedSize = size != null ? scaleAvatarSize(size, tier) : t.sizes?.[tier];

  // ── Render Cast Mascot (Crew / Chip) if matched ────────────────────────
  if (activeAvatarStyle !== "sprite" && castRenderable && castSlug) {
    const effectiveHarness = harness ?? agent?.harness ?? (isOperator ? undefined : undefined);
    const effectiveState = state ?? agent?.state ?? null;
    const effectiveProject = project ?? agent?.project ?? "openscout";

    const crewNode = (
      <CrewAvatar
        slug={castSlug}
        name={label}
        project={effectiveProject}
        harness={effectiveHarness}
        state={effectiveState}
        size={resolvedSize}
        badge={effectiveHarness ? (presence ?? t.presence) : false}
        ring={presence ?? (placement === "hero" || placement === "turn" ? false : t.presence)}
        chip={activeAvatarStyle === "chip"}
        glow={t.glow}
        title={title ?? label}
      />
    );

    if (resolvedSize == null) {
      return (
        <span
          className={className}
          style={{ background: "transparent", overflow: "visible", display: "inline-grid", placeItems: "center", ...style }}
          title={title ?? label}
        >
          {crewNode}
        </span>
      );
    }

    if (className || style) {
      return (
        <span className={className} style={{ display: "inline-grid", placeItems: "center", ...style }}>
          {crewNode}
        </span>
      );
    }

    return crewNode;
  }

  // ── Fallback to Deterministic Generative Sprite ───────────────────────
  const derived = agent ? agentSpriteProps(agent) : null;
  const showDot = presence ?? t.presence;
  const online = isAgentOnline(agent?.state ?? null);
  const corner = showDot && online ? stateColor(agent?.state ?? null) : undefined;
  const cornerPulse = showDot && isAgentInTurn(agent?.state ?? null);

  const sprite = (
    <SpriteAvatar
      name={label}
      size={resolvedSize}
      hue={derived?.hue}
      tone={derived?.tone}
      salt={salt}
      tile={tile ?? t.tile}
      glow={t.glow}
      corner={corner}
      cornerPulse={cornerPulse}
      title={title ?? label}
    />
  );

  if (resolvedSize == null) {
    return (
      <span
        className={className}
        style={{ background: "transparent", overflow: "visible", ...style }}
        title={title ?? label}
      >
        {sprite}
      </span>
    );
  }

  if (className || style) {
    return (
      <span className={className} style={style}>
        {sprite}
      </span>
    );
  }
  return sprite;
}
