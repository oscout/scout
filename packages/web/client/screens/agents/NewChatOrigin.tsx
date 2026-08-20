import type { ComposerContextItem } from "../../lib/composer-context.ts";

/**
 * What a new task will say about where it came from.
 *
 * Presentational and stateless on purpose: the composer owns the capture, this
 * only states it. Rendered as readable facts rather than a badge, because a
 * capture the sender cannot inspect before sending is a capture they never
 * agreed to.
 */
export function NewChatOrigin({
  context,
  selection,
  attached,
  onToggleSelection,
}: {
  context: ComposerContextItem[];
  /** The selection captured when the panel opened, or "" if there was none. */
  selection: string;
  attached: boolean;
  onToggleSelection: () => void;
}) {
  if (context.length === 0) return null;
  return (
    <div className="s-newchat-origin">
      <span className="label-md s-newchat-origin-label">From</span>
      <dl className="s-newchat-origin-facts">
        {context.map((item) => (
          <div key={item.label} className="s-newchat-origin-fact">
            <dt>{item.label}</dt>
            <dd title={item.value}>{item.value}</dd>
          </div>
        ))}
      </dl>
      {selection ? (
        <button
          type="button"
          className="s-newchat-origin-attach"
          aria-pressed={attached}
          onClick={onToggleSelection}
        >
          {attached ? "Remove selection" : `Attach selection (${selection.length} chars)`}
        </button>
      ) : null}
    </div>
  );
}
