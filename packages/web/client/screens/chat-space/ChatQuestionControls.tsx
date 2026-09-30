import { createContext, useContext, useMemo, useRef, useState } from "react";
import { ChatApiError, type ChatQuestionChange, type TrackedRequest } from "./chat-api.ts";
import { ChatCorrectionScope, parseChatCorrectionDraft, type ChatCorrectionDraft } from "./chat-correction-draft.ts";
import { chatLocalKey, createChatLocalStore } from "./chat-local-state.ts";

export const ChatQuestionResponder = createContext<((questionId: string, change: ChatQuestionChange) => Promise<void>) | null>(null);

export function ChatQuestionReviewGuidance({ question }: { question: NonNullable<TrackedRequest["responsibility"]> }) {
  if (question.kind !== "question" || question.state !== "answered" || question.settled) return null;
  const canReview = question.actions?.includes("close") || question.actions?.includes("reopen");
  return <p className="chat-question-review-guidance">{canReview
    ? "Review the recorded answer, then accept it or reopen the question if more is needed."
    : `${question.actorName || question.actorId || "The requester"} reviews this answer and can accept it or reopen the question.`}
    {" An answer records the response. Check the tracked request for agent execution progress."}
  </p>;
}

export function ChatQuestionControls({ question }: { question: NonNullable<TrackedRequest["responsibility"]> }) {
  const respond = useContext(ChatQuestionResponder);
  const scope = useContext(ChatCorrectionScope);
  const key = scope ? chatLocalKey("question-answer", scope, question.recordId) : null;
  const store = useMemo(() => createChatLocalStore<ChatCorrectionDraft | null>(key, null, parseChatCorrectionDraft), [key]);
  if (!respond || question.kind !== "question" || question.updatedAt == null) return null;
  return <QuestionForm key={key ?? question.recordId} question={question} store={store} respond={respond} />;
}

function QuestionForm({ question, store, respond }: {
  question: NonNullable<TrackedRequest["responsibility"]>;
  store: ReturnType<typeof createChatLocalStore<ChatCorrectionDraft | null>>;
  respond: (questionId: string, change: ChatQuestionChange) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => store.read());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const actions = question.actions ?? [];
  const changed = draft !== null && draft.expectedRevision !== question.updatedAt;
  const write = (body: string, revision = draft?.expectedRevision ?? question.updatedAt!) => {
    const next = { body, expectedRevision: revision }; store.write(next); setDraft(next);
  };
  const submit = async (action: ChatQuestionChange["action"]) => {
    if (pending.current || !actions.includes(action) || (action === "answer" && (!draft?.body.trim() || changed))) return;
    const sent = draft;
    pending.current = true; setBusy(true); setError(null);
    try {
      await respond(question.recordId, { action, expectedUpdatedAt: action === "answer" ? draft!.expectedRevision : question.updatedAt!, ...(action === "answer" ? { answer: draft!.body } : {}) });
      store.clearIfUnchanged(sent); setDraft(store.read());
    } catch (error) {
      setError(error instanceof ChatApiError && error.status > 0 && error.status < 500 ? error.message : "Could not confirm the response. Your text is preserved; refresh before retrying.");
    } finally { pending.current = false; setBusy(false); }
  };
  if (!actions.length && !draft) return null;
  return <form className="chat-question-response" aria-label="Respond to question" onSubmit={event => { event.preventDefault(); void submit("answer"); }}>
    {actions.includes("answer") || draft ? <label>Your answer<textarea aria-label="Question answer" maxLength={32000} value={draft?.body ?? ""} disabled={busy || !actions.includes("answer")} onChange={event => write(event.target.value)} /></label> : null}
    {changed && actions.includes("answer") ? <p role="alert">This question changed. Review it above before using your saved answer. <button type="button" disabled={busy} onClick={() => { write(draft!.body, question.updatedAt!); setError(null); }}>Use current version</button></p> : null}
    {draft && !actions.includes("answer") ? <p>Your unfinished answer is preserved. This question no longer accepts an answer from you.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div>
      {actions.includes("answer") ? <button type="submit" className="btn btn--sm" disabled={busy || changed || !draft?.body.trim()}>{busy ? "Saving…" : "Send answer"}</button> : null}
      {actions.includes("close") ? <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void submit("close")}>{busy ? "Saving…" : "Accept answer"}</button> : null}
      {actions.includes("reopen") ? <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void submit("reopen")}>Reopen question</button> : null}
      {draft ? <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { store.clearIfUnchanged(draft); setDraft(null); setError(null); }}>Discard draft</button> : null}
    </div>
  </form>;
}
