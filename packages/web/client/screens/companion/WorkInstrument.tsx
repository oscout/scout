import { useEffect, useRef, useState, type ReactNode } from "react";
import { DictationMic, type DictationMicControl, type MicStatus } from "../../components/DictationMic.tsx";
import { api } from "../../lib/api.ts";
import { focusCompanionInput } from "../../lib/companion-host.ts";
import { edgeVisible, exactLabel } from "./edge-model.ts";
import { ageLabel, type CompanionCardState } from "./companion-model.ts";
import type { EdgeWork } from "./CompanionEdge.tsx";

/** Absolute paths read as their file name; the full path stays in the title. */
const PATH = /(\/(?:[\w.-]+\/)+[\w.-]+)/g;
function Prose({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PATH)) {
    if (match.index! > last) parts.push(text.slice(last, match.index));
    parts.push(<span key={match.index} className="ce-in__file" title={match[1]}>{match[1]!.split("/").pop()}</span>);
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <p className="ce-in__prose">{parts}</p>;
}

function MicGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.1">
      <rect x="4" y="1.5" width="4" height="6" rx="2" /><path d="M2.5 6a3.5 3.5 0 0 0 7 0M6 9.5V11" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
      <circle cx="6" cy="6" r="1.6" /><circle cx="6" cy="6" r="3.3" />
      <path d="M6 1.2v1.4M6 9.4v1.4M1.2 6h1.4M9.4 6h1.4M2.6 2.6l1 1M8.4 8.4l1 1M2.6 9.4l1-1M8.4 3.6l1-1" />
    </svg>
  );
}

const RESTING_NOTE: Partial<Record<CompanionCardState, string>> = {
  quiet: "No new activity for a while. Not paused: Scout has just not seen anything.",
  waiting: "Waiting on someone else, not on you.",
  ended: "The session ended without reporting done.",
  cancelled: "Cancelled. Nothing is running.",
};

type Sent = { at: number } | null;

/**
 * What a figure's popover shows: the work's state, what it last said, and one
 * quiet row of actions. Reply opens a small composer that starts listening
 * when Scout voice is ready; typing works the whole time and takes over from
 * dictation. The figure's own settings sit behind the gear.
 */
export function WorkInstrument({
  work,
  name,
  offline,
  refTime,
  hosted,
  figureSettings,
  onThread,
  onWork,
  onPin,
  onComposing,
}: {
  work: EdgeWork;
  name: string;
  offline: boolean;
  refTime: number;
  hosted: boolean;
  /** Pinned work: the figure's settings, behind the gear. */
  figureSettings: ReactNode | null;
  onThread: (() => void) | null;
  onWork: () => void;
  /** Surfaced work: keep it as a pin. */
  onPin: (() => void) | null;
  /** The composer opened or closed: the edge keeps the popover open meanwhile. */
  onComposing: (composing: boolean) => void;
}) {
  const reading = edgeVisible(work.state, offline);
  const underlying = edgeVisible(work.state, false);
  const stateLabel = offline ? `${exactLabel(work.state)} at last sync` : exactLabel(work.state);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [mic, setMic] = useState<MicStatus | null>(null);
  const [sent, setSent] = useState<Sent>(null);
  const [error, setError] = useState<string | null>(null);
  const [gear, setGear] = useState(false);
  const dictation = useRef<DictationMicControl | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const listening = mic?.state === "recording" || mic?.state === "starting";

  const composingCallback = useRef(onComposing);
  composingCallback.current = onComposing;
  useEffect(() => { composingCallback.current(composing); }, [composing]);
  // Every opened composer is its own session. Dictation and send results
  // land only in the session that started them: never in a later composer,
  // and never in another figure's (the popover is reused across figures).
  const [session, setSession] = useState(0);
  const sessionRef = useRef(0);
  const live = useRef(false);
  const draftRef = useRef("");
  draftRef.current = draft;
  // Send pressed mid-take: the reply goes once the take's words have landed.
  const [sendWhenHeard, setSendWhenHeard] = useState(false);
  const sendWhenHeardRef = useRef(false);
  const [sendingFor, setSendingFor] = useState<number | null>(null);
  const sending = sendingFor !== null && sendingFor === session;
  const holdSend = (on: boolean) => { sendWhenHeardRef.current = on; setSendWhenHeard(on); };

  useEffect(() => {
    sessionRef.current += 1;
    live.current = false;
    sendWhenHeardRef.current = false;
    setComposing(false); setDraft(""); setSent(null); setError(null); setGear(false); setSendWhenHeard(false);
  }, [work.workId]);

  const openComposer = () => {
    heard.current = false;
    sessionRef.current += 1;
    live.current = true;
    setSession(sessionRef.current);
    setSent(null);
    setError(null);
    setComposing(true);
    if (hosted) focusCompanionInput();
    window.requestAnimationFrame(() => field.current?.focus());
  };
  const close = () => {
    // Closing unmounts the mic, which cancels any take in flight.
    sessionRef.current += 1;
    live.current = false;
    holdSend(false);
    setComposing(false);
    setDraft("");
    setError(null);
  };
  const post = async (body: string, forSession: number) => {
    if (!work.conversationId) return;
    setSendingFor(forSession);
    setError(null);
    try {
      await api("/api/send", { method: "POST", body: JSON.stringify({ body, chatId: work.conversationId }) });
      // Sent either way; only the composer that sent it closes.
      if (sessionRef.current !== forSession) return;
      sessionRef.current += 1;
      live.current = false;
      setSent({ at: Date.now() });
      setComposing(false);
      setDraft("");
    } catch (failure) {
      if (sessionRef.current === forSession) setError(failure instanceof Error ? failure.message : "Could not send.");
    } finally {
      setSendingFor((current) => (current === forSession ? null : current));
    }
  };
  // Words from a take landed. A held send waits for the mic's next status,
  // which says whether the take ended cleanly or with an error.
  const heard = useRef(false);
  const append = (text: string, from: number) => {
    if (!live.current || from !== sessionRef.current) return;
    const prev = draftRef.current;
    const next = prev.trim() ? `${prev.replace(/\s*$/, "")} ${text}` : text;
    draftRef.current = next;
    setDraft(next);
    heard.current = true;
  };
  const send = () => {
    if (sending || sendWhenHeard || !work.conversationId) return;
    // Mid-take: finish it; the reply goes when its words land.
    if (dictation.current?.busy() || listening || mic?.state === "processing") {
      holdSend(true);
      dictation.current?.finish();
      return;
    }
    const body = draft.trim();
    if (body) void post(body, session);
  };
  // Send a held reply once the take is over and its words are in. A take that
  // ended in an error (even with recovered words) is left for review.
  useEffect(() => {
    if (!sendWhenHeardRef.current || !mic || mic.state !== "idle") return;
    if (mic.tone === "error") {
      heard.current = false;
      holdSend(false);
      return;
    }
    // Not busy means the take's transcript, if any, is already in the draft:
    // the mic clears its handle in the same step that delivers the words.
    if (dictation.current?.busy()) return;
    heard.current = false;
    holdSend(false);
    const body = draftRef.current.trim();
    if (body) void post(body, sessionRef.current);
  }, [mic]);

  const meta = (
    <div className="ce-in__meta">
      <span className={`ce-in__cell${underlying === "needs" && !offline ? " is-ask" : ""}`} data-visible={reading}><i>State</i>{stateLabel}</span>
      <span className="ce-in__cell"><i>Age</i>{ageLabel(work.lastActivityAt, refTime)}</span>
      <span className="ce-in__cell" title={name}><i>Agent</i>{name}</span>
      {work.harness && <span className="ce-in__cell"><i>Harness</i>{work.harness}</span>}
    </div>
  );

  const note = [
    underlying === "resting" && work.state ? RESTING_NOTE[work.state] ?? null : null,
    work.visitorFrom ? `Runs on ${work.visitorFrom}, not this Mac` : null,
    work.origin ? `Surfaced ${work.origin}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="ce-in">
      {meta}
      <h3 className="ce-in__title" title={work.title}>{work.title}</h3>
      {work.report && <Prose text={work.report} />}
      {note && <p className="ce-in__note">{note}</p>}

      {composing && work.conversationId && (
        <div className="ce-in__box" data-listening={listening}>
          <textarea
            ref={field}
            className="ce-in__input"
            rows={3}
            value={draft}
            placeholder={`Reply to ${name}`}
            aria-label={`Reply to ${name}`}
            onChange={(event) => {
              // Typing takes over: dictation stops, and its words still land.
              if (listening) dictation.current?.finish();
              if (sendWhenHeard) holdSend(false);
              setDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
          />
          {listening && mic?.partial ? <p className="ce-in__heard">{mic.partial}</p> : null}
          {error || (mic?.tone === "error" && mic.message) ? <p className="ce-in__err">{error ?? mic?.message}</p> : null}
          <div className="ce-in__row">
            <DictationMic
              className="ce-in__mic"
              autoStart={draft === ""}
              controlRef={dictation}
              disabled={sending}
              onStatus={setMic}
              key={session}
              onAppend={(text) => append(text, session)}
            />
            <span className="ce-in__hint">
              {listening ? "Listening · type to take over" : mic?.state === "processing" ? "Transcribing…" : "To the thread"}
            </span>
            <button type="button" className="ce-in__q" onClick={close}>Discard</button>
            <button type="button" className="ce-in__send" disabled={(!draft.trim() && !listening) || sending || sendWhenHeard} onClick={send}>
              {sending || sendWhenHeard ? "Sending…" : "Send"} <kbd>↩</kbd>
            </button>
          </div>
        </div>
      )}

      <div className="ce-in__acts">
        {sent && <span className="ce-in__sent">Sent</span>}
        {!composing && work.conversationId && (
          <button type="button" className="ce-in__reply" onClick={openComposer} title="Reply in the thread. Starts listening when voice is ready; typing always works.">
            <MicGlyph />{sent ? "Reply again" : "Reply"}
          </button>
        )}
        {onThread && <button type="button" className="ce-in__q" onClick={onThread}>Thread</button>}
        <button type="button" className="ce-in__q" onClick={onWork}>{work.state === "done" ? "Output" : "Work"}</button>
        {onPin && <button type="button" className="ce-in__q" onClick={onPin}>Pin</button>}
        {figureSettings && (
          <button type="button" className="ce-in__gear" aria-label="Figure settings" title="Figure settings" aria-expanded={gear} onClick={() => setGear((value) => !value)}>
            <GearGlyph />
          </button>
        )}
      </div>
      {gear && figureSettings}
    </div>
  );
}
