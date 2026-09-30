/** ⌘K — jump to a channel or a member. Keyboard first, no mouse required. */

import { useEffect, useId, useMemo, useState } from "react";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import type { ConversationDefinition } from "@openscout/protocol";

import type { ChannelMemberView } from "./chat-api.ts";
import { MemberAvatar } from "./ChatAvatar.tsx";
import { channelLabel, memberDisplayName } from "./chat-space-model.ts";

export type JumpTarget =
  | { kind: "channel"; id: string; label: string }
  | { kind: "member"; id: string; label: string; member: ChannelMemberView };

export function JumpPalette({
  channels,
  members,
  onPick,
  onClose,
}: {
  channels: ConversationDefinition[];
  members: ChannelMemberView[];
  onPick: (target: JumpTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();
  const { ref: dialogRef, onKeyDown: trapFocus } = useFocusTrap<HTMLDivElement>();

  const targets = useMemo<JumpTarget[]>(() => {
    const needle = query.trim().toLowerCase();
    const all: JumpTarget[] = [
      ...channels.map((channel) => ({
        kind: "channel" as const,
        id: channel.id,
        label: channelLabel(channel.title),
      })),
      ...members.map((member) => ({
        kind: "member" as const,
        id: member.actorId,
        label: memberDisplayName(member),
        member,
      })),
    ];
    if (!needle) return all.slice(0, 20);
    return all.filter((target) => target.label.toLowerCase().includes(needle)).slice(0, 20);
  }, [channels, members, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  return (
    <div
      className="chat-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="chat-palette" role="dialog" aria-modal="true" aria-label="Jump to a channel or person" onKeyDown={(event) => {
        trapFocus(event);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}>
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={targets[index] ? `${listId}-${index}` : undefined}
          value={query}
          placeholder="Jump to a channel or person"
          aria-label="Jump to a channel or person"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => (current + 1) % Math.max(1, targets.length));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => (current - 1 + targets.length) % Math.max(1, targets.length));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const picked = targets[index];
              if (picked) onPick(picked);
              return;
            }
          }}
        />
        <div id={listId} className="chat-palette-list" role="listbox" aria-label="Channels and people">
          {targets.length === 0 ? (
            <div className="chat-palette-empty">Nothing matches that.</div>
          ) : (
            targets.map((target, position) => (
              <button
                key={`${target.kind}:${target.id}`}
                type="button"
                id={`${listId}-${position}`}
                role="option"
                aria-selected={position === index}
                data-active={position === index}
                className="chat-palette-option"
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onFocus={() => setIndex(position)}
                onClick={() => onPick(target)}
              >
                {target.kind === "member"
                  ? <MemberAvatar member={target.member} size={18} />
                  : <span className="chat-hash">#</span>}
                {target.kind === "member" ? target.label : target.label.replace(/^#/u, "")}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
