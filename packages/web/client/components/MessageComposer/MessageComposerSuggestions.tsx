import type { CSSProperties } from "react";

export type MessageComposerSuggestion = {
  id: string;
  token: string;
  description: string;
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
      className="s-msg-compose-suggest"
      data-placement={placement}
      role="listbox"
      aria-label={label}
    >
      <div className="s-msg-compose-suggest-label">{label}</div>
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={[
            "s-msg-compose-suggest-item",
            index === activeIndex && "s-msg-compose-suggest-item--active",
          ]
            .filter(Boolean)
            .join(" ")}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(index);
          }}
          onMouseEnter={() => onActiveIndexChange(index)}
        >
          {item.avatar ? (
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
        </button>
      ))}
    </div>
  );
}
