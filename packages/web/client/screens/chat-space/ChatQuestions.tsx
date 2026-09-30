import { CircleQuestionMark } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatApiError, type ChatApi, type ChatQuestionChange, type ChatQuestionPage } from "./chat-api.ts";
import { ChatQuestionReviewGuidance, ChatQuestionControls, ChatQuestionResponder } from "./ChatQuestionControls.tsx";
import { usePoll } from "./use-poll.ts";

type Question = ChatQuestionPage["questions"][number];
export function ChatQuestions({ api, channelId, space, onChanged, open: controlledOpen, onOpenChange }: {
  api: ChatApi; channelId: string; space: string; onChanged: () => void;
  /** Controlled by the channel header, which keeps one tray open at a time. */
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [history, setHistory] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => { if (onOpenChange) onOpenChange(value); else setLocalOpen(value); };
  const [questions, setQuestions] = useState<Question[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pages = useRef(1);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const refresh = useCallback(async () => {
    const read = history ? api.questionHistory : api.questions;
    if (!read) return;
    const request = ++generation.current;
    try {
      const rows: Question[] = [];
      let next: string | null = null;
      for (let page = 0; page < pages.current; page++) {
        const result = await read(channelId, next, space);
        rows.push(...result.questions); next = result.nextCursor;
        if (!next) break;
      }
      if (!alive.current || request !== generation.current) return;
      setQuestions(rows); setCursor(next); setLoaded(true); setError(null);
    } catch { if (alive.current && request === generation.current) setError("Questions could not be refreshed. Try again."); }
  }, [api, channelId, space, history]);
  useEffect(() => { void refresh(); }, [refresh]);
  usePoll(refresh, 15000, !history || open);
  const respond = async (id: string, change: ChatQuestionChange) => {
    if (!api.respondQuestion) throw new Error("Question responses are unavailable.");
    generation.current++;
    try {
      const result = await api.respondQuestion(channelId, id, change, space);
      if (!alive.current) return;
      generation.current++;
      setQuestions(current => current.flatMap(question => question.recordId !== id ? [question] : result.responsibility.settled ? [] : [result.responsibility]));
      onChanged();
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 409) await refresh();
      throw error;
    }
  };
  return <section className="chat-attention chat-questions" aria-label="Channel questions">
    {/* An icon with a count only when there is something to answer: "Questions · 0"
        was a word and a zero taking up the header to say nothing. */}
    <button type="button" className="chat-head-tool" aria-expanded={open} aria-controls="chat-questions-body"
      aria-label={`${history ? "Question history" : "Questions"}${loaded ? `, ${questions.length}${cursor ? "+" : ""} open` : ""}${error ? ", refresh needed" : ""}`}
      title={history ? "Question history" : "Questions"} onClick={() => setOpen(!open)}>
      <CircleQuestionMark size={16} strokeWidth={1.8} aria-hidden />
      {loaded && questions.length ? <span className="chat-head-tool-count">{questions.length}{cursor ? "+" : ""}</span> : null}
      {error ? <span className="chat-head-tool-count" data-tone="error">!</span> : null}
    </button>
    {open ? <div id="chat-questions-body" className="chat-questions-body">
      {api.questionHistory ? <div className="chat-question-views" role="group" aria-label="Question view">
        {[false, true].map(value => <button className="btn btn--ghost btn--sm" key={String(value)} type="button" aria-pressed={history === value} onClick={() => {
          if (history === value) return;
          generation.current++; pages.current = 1;
          setQuestions([]); setCursor(null); setLoaded(false); setError(null); setHistory(value);
        }}>{value ? "Resolved history" : "Open and awaiting review"}</button>)}
      </div> : null}
      {history ? <p>Resolved questions, oldest first.</p> : null}
      {error ? <p role="alert">{error} <button type="button" onClick={() => void refresh()}>Retry</button></p> : null}
      {!loaded && !error ? <p>Loading questions…</p> : null}
      {loaded && !questions.length && !error ? <p>{history ? "No resolved questions were found in this channel’s retained history." : "No open questions or answers awaiting review in this channel."}</p> : null}
      <ChatQuestionResponder.Provider value={api.respondQuestion ? respond : null}>
        {questions.map(question => <article key={question.recordId} className="chat-question-card">
          <h3>{question.title}</h3>
          <p>{question.settled ? question.state === "declined" ? "Declined" : "Resolved" : question.state === "answered" ? "Answer awaiting review" : "Answer requested"}{!question.settled ? ` · ${question.actorId ? `Next: ${question.actorName || question.actorId}` : "Next actor not recorded"}` : ""}</p>
          {history && question.updatedAt != null ? <p>Updated <time dateTime={new Date(question.updatedAt).toISOString()}>{new Date(question.updatedAt).toLocaleString()}</time></p> : null}
          {question.answer ? <details><summary>Recorded answer</summary><pre>{question.answer}</pre></details> : null}
          <ChatQuestionReviewGuidance question={question} />
          <ChatQuestionControls question={question} />
        </article>)}
      </ChatQuestionResponder.Provider>
      {cursor ? <button type="button" disabled={busy} onClick={async () => { setBusy(true); pages.current++; await refresh(); if (alive.current) setBusy(false); }}>{busy ? "Loading…" : "Load more questions"}</button> : null}
    </div> : null}
  </section>;
}
