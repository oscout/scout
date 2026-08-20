import type { CSSProperties } from "react";
import { stateColor } from "../lib/colors.ts";
import { normalizeAgentState, type AgentDisplayState, isAgentBusy } from "../lib/agent-state.ts";
import { spriteFor } from "../lib/agent-identity.ts";
import { SpriteSvg } from "./SpriteAvatar.tsx";

export type AvatarKind = "user" | "channel";
export type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps {
  /** Name used to derive the initial and the deterministic background color. */
  name: string;
  /** "channel" renders a `#` glyph instead of an initial. Defaults to "user". */
  kind?: AvatarKind;
  /**
   * Size hint. Currently informational only — the visual size is driven by
   * the legacy CSS classes passed through `className`. Reserved for future
   * unified styling.
   */
  size?: AvatarSize;
  /**
   * When provided, an overlaid <PresenceDot/> is rendered alongside the
   * avatar. Callers that need custom positioning for the dot should render
   * <PresenceDot/> themselves instead of using this prop.
   */
  presence?: AgentDisplayState | string | null;
  /**
   * Class applied to the avatar element itself (e.g. `ctx-panel-avatar`,
   * `s-avatar s-avatar-sm`, `s-left-roster-avatar`). The existing CSS keeps
   * driving the visuals; the component just centralizes the logic.
   */
  className?: string;
  /**
   * Class applied to the `#` element when `kind === "channel"`. Defaults to
   * the value of `className` if not provided.
   */
  channelClassName?: string;
  /**
   * Optional override for the background color. When omitted the color is
   * derived from `actorColor(name)`.
   */
  background?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * Shared avatar primitive. Wraps the deterministic actor-color + first-letter
 * pattern that previously appeared inline across the web client.
 *
 * The component intentionally accepts a `className` so existing CSS variants
 * (`ctx-panel-avatar`, `s-avatar s-avatar-sm`, `s-left-roster-avatar`, etc.)
 * keep working untouched.
 */
export function Avatar({
  name,
  kind = "user",
  presence,
  className,
  channelClassName,
  background,
  style,
  title,
}: AvatarProps) {
  if (kind === "channel") {
    return (
      <span className={channelClassName ?? className} style={style} title={title}>
        #
      </span>
    );
  }

  // User avatars are deterministic sprite creatures derived from the name
  // (lib/agent-identity.ts). We keep the caller's sizing className but
  // override the legacy solid background to transparent and let the sprite
  // fill the box (overflow visible so antennae/legs never clip).
  const sprite = spriteFor(name);
  const spriteStyle: CSSProperties = {
    ...style,
    background: "transparent",
    overflow: "visible",
  };
  const dot =
    presence !== undefined && presence !== null ? (
      <PresenceDot state={presence} />
    ) : null;

  // When a presence dot is requested we render a positioned wrapper so the
  // dot can sit on the avatar without callers needing to wire it up. Callers
  // that need a custom dot layout (e.g. LeftPanel's `s-left-roster-avatar-wrap`)
  // should render <Avatar/> and <PresenceDot/> themselves and skip `presence`.
  if (dot) {
    return (
      <span className="oc-avatar-wrap">
        <span className={className} style={spriteStyle} title={title}>
          <SpriteSvg sprite={sprite} />
        </span>
        {dot}
      </span>
    );
  }

  return (
    <span className={className} style={spriteStyle} title={title}>
      <SpriteSvg sprite={sprite} />
    </span>
  );
}

export interface PresenceDotProps {
  state: AgentDisplayState | string | null;
  className?: string;
  style?: CSSProperties;
}

/**
 * Small colored dot indicating agent presence. The CSS class drives layout
 * (position/size); inline color comes from `stateColor`.
 */
export function PresenceDot({ state, className, style }: PresenceDotProps) {
  const normalized = normalizeAgentState(
    typeof state === "string" ? state : state ?? null,
  );
  const colorInput =
    normalizeAgentState(typeof state === "string" ? state : state ?? null) !== "blocked" ? (isAgentBusy(typeof state === "string" ? state : state ?? null) ? "working" : "available") : null;
  return (
    <span
      className={className}
      style={{ background: stateColor(colorInput), ...style }}
    />
  );
}
