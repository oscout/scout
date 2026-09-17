/**
 * Identity at cue size.
 *
 * People are initial coins on a deterministic neutral fill — the fill is
 * derived with the same `actorColor` hash the rest of the client uses, mixed
 * down into `--muted` so a roster of humans reads as one neutral set rather
 * than a color rainbow. Agents are the existing generative sprite (shape is
 * WHO, hue is HARNESS, brightness is STATE) with their owner's coin inset, so
 * "Maya's Codex" is legible as Maya's without reading the name.
 */

import type { CSSProperties } from "react";

import { SpriteAvatar, agentSpriteProps } from "../../components/SpriteAvatar.tsx";
import { actorColor } from "../../lib/colors.ts";
import type { ChannelMemberView } from "./chat-api.ts";
import { initialsFor, isAgentMember, memberDisplayName } from "./chat-space-model.ts";

export function coinFill(name: string): string {
  return `color-mix(in srgb, var(--muted) 82%, ${actorColor(name)})`;
}

export function MemberCoin({
  name,
  size = 24,
  className,
  title,
}: {
  name: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    background: coinFill(name),
    fontSize: Math.max(7, Math.round(size * 0.38)),
  };
  return (
    <span className={`chat-coin${className ? ` ${className}` : ""}`} style={style} title={title}>
      {initialsFor(name)}
    </span>
  );
}

export function AgentSprite({
  member,
  size = 24,
  className,
}: {
  member: ChannelMemberView;
  size?: number;
  className?: string;
}) {
  const sprite = agentSpriteProps({
    harness: member.harness ?? null,
    state: member.activity?.status ?? null,
  });
  const owner = member.owner?.displayName?.trim() || null;
  return (
    <span
      className={`chat-sprite${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      title={memberDisplayName(member)}
    >
      <SpriteAvatar
        name={member.displayName || member.actorId}
        size={size}
        {...(sprite.hue === undefined ? {} : { hue: sprite.hue })}
        tone={sprite.tone}
        tile
      />
      {owner ? (
        <span
          className="chat-sprite-owner"
          style={{
            background: coinFill(owner),
            width: Math.max(10, Math.round(size * 0.46)),
            height: Math.max(10, Math.round(size * 0.46)),
            fontSize: Math.max(5, Math.round(size * 0.24)),
          }}
          aria-hidden="true"
        >
          {owner.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
    </span>
  );
}

/** One avatar for either kind of member. */
export function MemberAvatar({
  member,
  size = 24,
  className,
}: {
  member: ChannelMemberView;
  size?: number;
  className?: string;
}) {
  return isAgentMember(member)
    ? <AgentSprite member={member} size={size} {...(className ? { className } : {})} />
    : (
      <MemberCoin
        name={member.displayName || member.actorId}
        size={size}
        {...(className ? { className } : {})}
        title={member.displayName}
      />
    );
}

/**
 * Up to four faces and the split count. Never "7 members": members is a mixed
 * set, and people-vs-agents is the useful fact.
 */
export function Facepile({
  members,
  countLabel,
  onOpen,
}: {
  members: ChannelMemberView[];
  countLabel: string;
  onOpen: () => void;
}) {
  const visible = members.slice(0, 4);
  return (
    <button type="button" className="chat-facepile" onClick={onOpen} aria-label={`Members: ${countLabel}`}>
      <span className="chat-facepile-faces">
        {visible.map((member) => (
          <MemberAvatar key={member.actorId} member={member} size={20} className="chat-facepile-face" />
        ))}
      </span>
      <span className="chat-pile-count">{countLabel}</span>
    </button>
  );
}
