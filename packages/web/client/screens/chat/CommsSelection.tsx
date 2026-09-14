/**
 * Comms · the selection — the one thing clicked in a drawing.
 *
 * Docked to the right edge of the drawing it belongs to, never a column of the
 * deck: a selection is something you are looking at, not something you kept.
 * Clicking another thing replaces it; Esc or × clears it.
 *
 * A task, an exchange, a participant and a message are all a list of passes,
 * so they share one body. What the panel adds is the way out: the
 * conversations those passes happened in, each of which can go on the stage
 * or be kept beside — because a slice of a drawing is not a page, but the
 * conversation it came from is.
 */

import "./comms-deck.css";
import { useCallback, useEffect, useMemo } from "react";
import { PanelRight, X } from "lucide-react";
import type { FlowPass } from "../../lib/comms-flow.ts";
import { conversationDisplayTitle } from "../../lib/conversations.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { sessionMatchesConversationId } from "./agent-master-model.ts";
import type { FlowTask } from "./comms-flow-map.ts";
import {
  DECK_KICKER,
  deckConversations,
  deckNames,
  deckPasses,
  deckTitle,
  type DeckCard,
} from "./comms-deck.ts";

function clock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The passes behind one card, as a thread you can read. */
export function DeckMessages({ passes }: { passes: readonly FlowPass[] }) {
  if (passes.length === 0) {
    return <p className="cdk-empty">Nothing passed between them in this window.</p>;
  }
  return (
    <div className="cdk-body">
      {passes.map((pass) => (
        <article
          key={pass.id}
          className={[
            "cdk-msg",
            pass.inbound ? "cdk-msg--in" : "",
            pass.kind === "status" ? "cdk-msg--status" : "",
          ].filter(Boolean).join(" ")}
        >
          <header className="cdk-msg-head">
            <span className="cdk-msg-from">{pass.from.short}</span>
            <span className="cdk-msg-to">
              to {pass.kind === "channel" ? "the conversation" : pass.audience.map((a) => a.short).join(", ")}
            </span>
            {pass.count > 1 ? <span className="cdk-msg-tag">×{pass.count}</span> : null}
            <span className="cdk-msg-at">{clock(pass.at)}</span>
          </header>
          <p className="cdk-msg-body">{pass.message.body}</p>
        </article>
      ))}
    </div>
  );
}

export type BesideControl = {
  has: (conversationId: string) => boolean;
  toggle: (conversationId: string) => void;
};

export function CommsSelection({
  card,
  passes,
  tasks,
  onClear,
  onStage,
  beside,
}: {
  card: DeckCard;
  passes: readonly FlowPass[];
  tasks: readonly FlowTask[];
  onClear: () => void;
  /** Put a conversation this selection happened in on the stage. */
  onStage: (conversationId: string) => void;
  /** Keep one of them beside instead. A page with no deck offers no such thing. */
  beside?: BesideControl;
}) {
  const names = useMemo(() => deckNames(passes), [passes]);
  const nameOf = useCallback((actorId: string) => names.get(actorId) ?? actorId, [names]);
  const title = deckTitle(card, tasks, passes, nameOf);
  const shown = useMemo(() => deckPasses(card, passes, tasks), [card, passes, tasks]);
  const conversations = useMemo(() => deckConversations(card, passes, tasks), [card, passes, tasks]);
  const { sessions } = useConversationList();
  const titleOf = (conversationId: string) => {
    const session = sessions.find((entry) => sessionMatchesConversationId(entry, conversationId));
    return session ? conversationDisplayTitle(session) : conversationId;
  };

  // Esc clears the selection from anywhere on the page: the panel has no focus
  // of its own to lose, and the thing that was clicked is back in the drawing.
  // Typing somewhere keeps its own Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      onClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClear]);

  return (
    <aside className="csl" aria-label="Selection">
      <header className="cdk-head">
        <span className="cdk-ident">
          <span className="cdk-kicker">Selected · {DECK_KICKER[card.kind]}</span>
          <span className="cdk-title" title={title}>{title}</span>
        </span>
        <button
          type="button"
          className="cdk-btn"
          title="Clear the selection (Esc)"
          aria-label="Clear the selection"
          onClick={onClear}
        >
          <X size={13} strokeWidth={2} aria-hidden />
        </button>
      </header>
      {conversations.length > 0 ? (
        <div className="csl-in">
          <span className="csl-in-label">
            {conversations.length === 1 ? "In" : `In ${conversations.length} conversations`}
          </span>
          {conversations.map((conversationId) => {
            const kept = beside?.has(conversationId) ?? false;
            return (
              <span key={conversationId} className="csl-conv">
                <button
                  type="button"
                  className="csl-conv-open"
                  title="Open this conversation on the stage"
                  onClick={() => onStage(conversationId)}
                >
                  {titleOf(conversationId)}
                </button>
                {beside ? (
                  <button
                    type="button"
                    className={`cdk-btn${kept ? " cdk-btn--on" : ""}`}
                    title={kept ? "Close the column beside the stage" : "Keep this conversation beside the stage"}
                    aria-label={kept ? "Close beside" : "Keep beside"}
                    aria-pressed={kept}
                    onClick={() => beside.toggle(conversationId)}
                  >
                    <PanelRight size={12} strokeWidth={2} aria-hidden />
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
      <DeckMessages passes={shown} />
    </aside>
  );
}
