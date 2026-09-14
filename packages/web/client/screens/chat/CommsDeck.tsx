/**
 * Comms · Beside — the conversations kept open in columns next to the stage.
 *
 * Two, three, four, as many as you want, side by side, on every Comms page
 * until closed. Each column is resized from its own left edge, so widening one
 * never silently narrows another; past the stage's minimum the row scrolls
 * sideways rather than squeezing what was opened. Any column furls to a spine
 * to be kept without being read.
 *
 * Nothing arrives here by browsing. A column is put here by the beside button
 * on a conversation, and it leaves by its own × — or by ↗, which moves it onto
 * the stage. Which columns are open is the URL's job (`?open=`, see
 * use-beside.ts); only the widths are remembered here.
 */

import "./comms-deck.css";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, X } from "lucide-react";
import { conversationDisplayTitle } from "../../lib/conversations.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { sessionMatchesConversationId } from "./agent-master-model.ts";

const MIN_W = 260;
const MAX_W = 720;
const DEFAULT_W = 380;
/** Widths outlive a reload; which columns are open is the route's job. */
const WIDTH_KEY = "openscout.comms.deck.width";

function readWidth(): number {
  try {
    const held = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(held) && held >= MIN_W && held <= MAX_W ? held : DEFAULT_W;
  } catch {
    return DEFAULT_W;
  }
}

export function CommsDeck({
  ids,
  onClose,
  onStage,
  renderConversation,
}: {
  ids: readonly string[];
  onClose: (conversationId: string) => void;
  /** Move a column onto the stage: it opens there, and the column closes. */
  onStage: (conversationId: string) => void;
  renderConversation: (conversationId: string) => ReactNode;
}) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [furled, setFurled] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [base, setBase] = useState(DEFAULT_W);
  const columns = useRef(new Map<string, HTMLElement>());
  const { sessions } = useConversationList();

  useEffect(() => setBase(readWidth()), []);

  const furl = useCallback((id: string) => {
    setFurled((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // A column takes its width from its own left edge. Dragging one grows the
  // deck and the stage gives way; it never redistributes width between columns.
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const element = columns.current.get(drag);
      if (!element) return;
      const width = Math.max(MIN_W, Math.min(MAX_W, element.getBoundingClientRect().right - event.clientX));
      setWidths((held) => ({ ...held, [drag]: width }));
      setBase(width);
    };
    const onUp = () => {
      setDrag(null);
      setBase((width) => {
        try {
          window.localStorage.setItem(WIDTH_KEY, String(width));
        } catch {
          // A browser that refuses storage still gets a working drag.
        }
        return width;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag]);

  if (ids.length === 0) return null;

  return (
    <div className="cdk" aria-label="Beside the stage">
      {ids.map((id) => {
        // The column is named the way the rail names it — the conversation's
        // title under whose it is — never by its id.
        const session = sessions.find((entry) => sessionMatchesConversationId(entry, id));
        const title = session ? conversationDisplayTitle(session) : id;
        const kicker = session?.agentName ?? "Conversation";

        if (furled.has(id)) {
          return (
            <button
              key={id}
              type="button"
              className="cdk-spine"
              onClick={() => furl(id)}
              title={`Unfurl — ${title}`}
              aria-label={`Unfurl ${kicker}: ${title}`}
            >
              <span className="cdk-spine-kicker">{kicker}</span>
              <span className="cdk-spine-title">{title}</span>
            </button>
          );
        }

        return (
          <section
            key={id}
            className="cdk-col"
            style={{ width: widths[id] ?? base }}
            ref={(element) => {
              if (element) columns.current.set(id, element);
              else columns.current.delete(id);
            }}
          >
            <div
              className={`cdk-grip${drag === id ? " cdk-grip--on" : ""}`}
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${title}`}
              onPointerDown={(event) => {
                event.preventDefault();
                setDrag(id);
              }}
              onKeyDown={(event: KeyboardEvent) => {
                const step = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
                if (!step) return;
                event.preventDefault();
                setWidths((held) => ({
                  ...held,
                  [id]: Math.max(MIN_W, Math.min(MAX_W, (held[id] ?? base) + step)),
                }));
              }}
              tabIndex={0}
            />
            <header className="cdk-head">
              <span className="cdk-ident">
                <span className="cdk-kicker">{kicker}</span>
                <span className="cdk-title" title={title}>{title}</span>
              </span>
              <button
                type="button"
                className="cdk-btn"
                title="Move to the stage — it opens there and this column closes"
                aria-label="Move to the stage"
                onClick={() => onStage(id)}
              >
                <ArrowUpRight size={13} strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                className="cdk-btn"
                title="Furl to a spine"
                aria-label="Furl to a spine"
                onClick={() => furl(id)}
              >
                <ChevronRight size={13} strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                className="cdk-btn"
                title="Close"
                aria-label="Close"
                onClick={() => onClose(id)}
              >
                <X size={13} strokeWidth={2} aria-hidden />
              </button>
            </header>
            <div className="cdk-live">{renderConversation(id)}</div>
          </section>
        );
      })}
    </div>
  );
}
