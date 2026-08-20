/* Feed rows that are not a single authored turn.
 *
 * The day divider lives here rather than inline in the transcript because both
 * kinds of row need it: a collapsed fan-out can just as easily be the first
 * thing that happened on a given day, and a thread that silently drops the
 * divider there reads as if the whole run belonged to the day before. */

import { MessageMarkup } from "../../lib/message-markup.tsx";
import { formatThreadDayLabel } from "../../lib/thread-days.ts";
import { timeAgo } from "../../lib/time.ts";
import type { ConversationFeedRow } from "./conversation-model.ts";

/// The rule for when a row opens a new day. Kept next to the rows that draw it
/// so the fan-out branch and the message branch cannot drift apart.
export function ThreadDayDivider({ at }: { at: number }) {
  const label = formatThreadDayLabel(at);
  return (
    <div className="s-thread-day-divider" aria-label={label}>
      <span className="s-thread-day-line" aria-hidden="true" />
      <span className="s-thread-day-label">{label}</span>
      <span className="s-thread-day-line" aria-hidden="true" />
    </div>
  );
}

/// One kickoff that was delivered to several agents, drawn as the one event it
/// was rather than as one identical turn per recipient. Collapsed it states the
/// count; expanded it names every recipient and shows the text that went out
/// once. A disclosure button rather than a hover affordance, so the recipients
/// are reachable by keyboard and announced as expandable.
export function FanOutRow({
  row,
  expanded,
  showDayDivider,
  onToggle,
}: {
  row: Extract<ConversationFeedRow, { kind: "fanout" }>;
  expanded: boolean;
  showDayDivider: boolean;
  onToggle: () => void;
}) {
  const summary = `${row.recipients.length} recipients`;
  return (
    <div
      className={[
        "s-thread-feed-block",
        "s-thread-fanout",
        showDayDivider && "s-thread-feed-block--full-width",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {showDayDivider && <ThreadDayDivider at={row.createdAt} />}

      {/* Folding removed the `msg-<id>` element each delivery used to own, and
          reply backlinks and `#msg-` permalinks resolve by that id. Every
          folded message keeps a marker here so those targets still land; the
          markers have no box of their own, and the scroll and the highlight are
          handed to this row. */}
      {row.messages.map((message) => (
        <span
          key={message.id}
          id={`msg-${message.id}`}
          className="s-thread-fanout-anchor"
          aria-hidden="true"
        />
      ))}

      <button
        type="button"
        className="s-thread-fanout-summary"
        aria-expanded={expanded}
        onClick={onToggle}
        title={row.recipients.join(", ")}
      >
        <span className="s-thread-fanout-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="s-thread-fanout-label">{summary}</span>
        <span className="s-thread-fanout-time">{timeAgo(row.createdAt)}</span>
      </button>

      {expanded && (
        <div className="s-thread-fanout-detail">
          <ul className="s-thread-fanout-recipients">
            {row.messages.map((message, index) => (
              <li key={message.id} className="s-thread-fanout-recipient">
                {row.recipients[index]}
              </li>
            ))}
          </ul>
          <div className="s-thread-fanout-body">
            <MessageMarkup text={row.messages[0]!.body} />
          </div>
        </div>
      )}
    </div>
  );
}
