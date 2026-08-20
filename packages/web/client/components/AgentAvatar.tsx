import type { CSSProperties } from "react";
import { SpriteAvatar, agentSpriteProps } from "./SpriteAvatar.tsx";
import { stateColor } from "../lib/colors.ts";
import { isAgentBusy, isAgentInTurn, isAgentOnline, normalizeAgentState } from "../lib/agent-state.ts";

/**
 * AgentAvatar — the single entry point for agent (and channel) avatars.
 *
 * One component, many placements. Pass an `agent` (or a bare `name`) and a
 * `placement`, and the right treatment is applied — size, tile wash, presence
 * dot, glow. Everything stays overridable per-prop for one-offs.
 *
 * Under the hood it renders the SpriteAvatar primitive (the deterministic
 * creature from lib/agent-identity.ts). AgentAvatar is the opinionated layer
 * on top: it derives hue (harness) + tone + presence from the agent, applies a
 * placement preset, and owns the `background: transparent; overflow: visible`
 * host wrapper — so call sites stop re-spreading `agentSpriteProps`, re-wiring
 * corner dots, and repeating the same inline styles.
 *
 *   <AgentAvatar agent={agent} placement="inspector" />   // 40px tile + dot
 *   <AgentAvatar agent={agent} placement="hero" className="s-profile-identity-avatar" />
 *   <AgentAvatar name={actorName} placement="turn" className="s-profile-signal-avatar" />
 *   <AgentAvatar kind="channel" name={channel} channelClassName="rr-row-hash" />
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
  /** Fixed pixel box. `undefined` → fill the parent (host class sizes it). */
  size?: number;
  tile: boolean;
  glow?: boolean;
  /** Show a state dot in the corner (derived from the agent's state). */
  presence: boolean;
}

const PLACEMENT: Record<AvatarPlacement, Treatment> = {
  hero: { tile: false, presence: false, glow: true },
  inspector: { size: 40, tile: true, presence: true },
  row: { size: 24, tile: true, presence: true },
  turn: { tile: false, presence: false },
  list: { tile: false, presence: false },
  roster: { tile: false, presence: false },
  node: { size: 16, tile: false, presence: false },
};

export interface AgentAvatarProps {
  /** Agent identity — derives hue (harness), tone + presence (state). */
  agent?: { name: string; harness?: string | null; state?: string | null };
  /** Bare name when there is no agent object (e.g. an actor on a message). */
  name?: string;
  /** "channel" renders a `#` glyph instead of a creature. */
  kind?: "agent" | "channel";
  /** Placement preset — sets the default treatment. */
  placement?: AvatarPlacement;
  /** Override the preset size (px). Omit to keep the preset / fill the parent. */
  size?: number;
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
  kind = "agent",
  placement = "row",
  size,
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

  const t = PLACEMENT[placement];
  const derived = agent ? agentSpriteProps(agent) : null;

  // Presence dot — only when shown and the agent reads as online (working /
  // ready). Color + pulse follow the canonical stateColor mapping.
  const showDot = presence ?? t.presence;
  const online = isAgentOnline(agent?.state ?? null);
  const corner = showDot && online ? stateColor(agent?.state ?? null) : undefined;
  const cornerPulse = showDot && isAgentInTurn(agent?.state ?? null);

  const resolvedSize = size ?? t.size;

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

  // Fill placements (no fixed size) fill a host-sized box. Bake the
  // transparent / overflow-visible treatment so call sites stop repeating it,
  // and let the host class drive layout (display / centering / size).
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

  // Fixed-size placements: only wrap when the caller needs a class/style hook.
  if (className || style) {
    return (
      <span className={className} style={style}>
        {sprite}
      </span>
    );
  }
  return sprite;
}
