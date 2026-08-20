import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { LazyMotion, m, useReducedMotion } from "motion/react";

import { laneSnippetText } from "../../lib/lane-observe.ts";

const STREAM_SETTLE_MS = 420;
const loadObserveMotionFeatures = () =>
  import("../chat/conversation-motion-features.ts").then((module) => module.default);

/**
 * Marks the real edge of a harness-owned text stream. It stays solid while
 * chunks arrive, then shifts to a quiet blink when the stream pauses. The text
 * itself is never replayed or typewritten client-side.
 */
export function ObserveStreamCursor({ text }: { text: string }) {
  const reduceMotion = useReducedMotion();
  const [receiving, setReceiving] = useState(true);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setReceiving(true);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => setReceiving(false), STREAM_SETTLE_MS);
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, [text]);

  return (
    <LazyMotion features={loadObserveMotionFeatures} strict>
      <m.span
        className="s-observe-stream-cursor"
        data-receiving={receiving || undefined}
        aria-hidden="true"
        initial={false}
        animate={
          reduceMotion || receiving
            ? { opacity: 1 }
            : { opacity: [1, 0.28, 1] }
        }
        transition={
          reduceMotion || receiving
            ? { duration: 0.12 }
            : { duration: 1.05, ease: "linear", repeat: Infinity }
        }
      />
    </LazyMotion>
  );
}

export function ObserveReasoningDisclosure({
  text,
  live,
  compact = false,
  copyControl,
}: {
  text: string;
  live: boolean;
  compact?: boolean;
  copyControl?: ReactNode;
}) {
  const disclosureId = useId();
  const normalized = text.trim();
  const [open, setOpen] = useState(live);
  const previousLiveRef = useRef(live);

  useEffect(() => {
    if (live) {
      setOpen(true);
    } else if (previousLiveRef.current) {
      setOpen(false);
    }
    previousLiveRef.current = live;
  }, [live]);

  const preview = laneSnippetText(normalized, compact ? 120 : 168, 1);
  const headerContents = (
    <>
      <span className="s-observe-reasoning-state">
        <span className="s-observe-reasoning-dot" aria-hidden="true" />
        {live ? "Thinking" : "Reasoning"}
      </span>
      {!live && !open && preview ? (
        <span className="s-observe-reasoning-preview" title={normalized}>
          {preview}
        </span>
      ) : null}
      {!live ? (
        <ChevronDown
          className="s-observe-reasoning-chevron"
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : null}
    </>
  );

  return (
    <div
      className={[
        "s-observe-block",
        "s-observe-reasoning",
        compact && "s-observe-reasoning--compact",
        live && "s-observe-reasoning--live",
        open && "s-observe-reasoning--open",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-busy={live || undefined}
    >
      {live ? (
        <div className="s-observe-reasoning-header" role="status">
          {headerContents}
        </div>
      ) : (
        <button
          type="button"
          className="s-observe-reasoning-header s-observe-reasoning-header--button"
          aria-expanded={open}
          aria-controls={disclosureId}
          aria-label={open ? "Hide reasoning" : "Show reasoning"}
          onClick={() => setOpen((value) => !value)}
        >
          {headerContents}
        </button>
      )}

      <div
        id={disclosureId}
        className="s-observe-reasoning-body"
        aria-hidden={!open}
        inert={!open ? true : undefined}
      >
        <div className="s-observe-reasoning-body-clip">
          <div className="s-observe-reasoning-body-inner">
            <div className="s-observe-reasoning-text">
              {normalized}
              {live ? <ObserveStreamCursor text={normalized} /> : null}
            </div>
            {copyControl ? (
              <div className="s-observe-reasoning-tools">{copyControl}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
