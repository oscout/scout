import type { CSSProperties, ReactNode } from "react";
import { CornerDownLeft } from "lucide-react";

export type MessageComposerSuggestion = {
  id: string;
  token: string;
  description: string;
  avatarNode?: ReactNode;
  avatar?: {
    label: string;
    color: string;
  };
};

export type MessageComposerSuggestionsProps = {
  label: string;
  items: readonly MessageComposerSuggestion[];
  activeIndex: number;
  placement?: "above" | "inside";
  onPick: (index: number) => void;
  onActiveIndexChange: (index: number) => void;
};

/** Shared slash-command / agent-mention menu for every MessageComposer surface. */
export function MessageComposerSuggestions({
  label,
  items,
  activeIndex,
  placement = "above",
  onPick,
  onActiveIndexChange,
}: MessageComposerSuggestionsProps) {
  if (items.length === 0) return null;

  return (
    <div
      className="s-msg-compose-suggest surface-card"
      data-placement={placement}
      role="listbox"
      aria-label={label}
    >
      <div className="s-msg-compose-suggest-header">
        <span className="s-msg-compose-suggest-label label-xs text-muted">{label}</span>
        <span className="label-xs text-dim s-msg-compose-suggest-count">{items.length} options</span>
      </div>

      <div className="s-msg-compose-suggest-list">
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={isActive}
              className={`s-msg-compose-suggest-item${isActive ? " s-msg-compose-suggest-item--active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(index);
              }}
              onMouseEnter={() => onActiveIndexChange(index)}
            >
              {isActive && (
                <span className="s-msg-compose-suggest-active-indicator" aria-hidden="true" />
              )}
              {item.avatarNode ? (
                <span className="s-msg-compose-suggest-avatar-node" aria-hidden="true">
                  {item.avatarNode}
                </span>
              ) : item.avatar ? (
                <span
                  className="s-ops-avatar s-msg-compose-suggest-avatar"
                  style={{
                    "--size": "20px",
                    background: item.avatar.color,
                  } as CSSProperties}
                  aria-hidden="true"
                >
                  {item.avatar.label}
                </span>
              ) : null}
              <span className="s-msg-compose-suggest-token">{item.token}</span>
              <span className="s-msg-compose-suggest-desc">{item.description}</span>
              {isActive && (
                <span className="s-msg-compose-suggest-pick-hint label-xs text-dim">
                  <CornerDownLeft size={10} aria-hidden="true" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="s-msg-compose-suggest-footer">
        <span className="label-xs text-dim">
          <kbd className="s-kbd">↑</kbd> <kbd className="s-kbd">↓</kbd> navigate · <kbd className="s-kbd">↵</kbd> select · <kbd className="s-kbd">esc</kbd> close
        </span>
      </div>
    </div>
  );
}
