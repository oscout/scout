import { useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { readChatMessageCorrection, type ChatMessageChange } from "@openscout/protocol";
import { ChatApiError, type ChatMessage } from "./chat-api.ts";

import { ChatCorrectionScope, parseChatCorrectionDraft, type ChatCorrectionDraft } from "./chat-correction-draft.ts";
import { chatLocalKey, createChatLocalStore } from "./chat-local-state.ts";

export type CorrectChatMessage = (messageId: string, change: ChatMessageChange) => Promise<ChatMessage>;

interface CorrectionProps {
  message: ChatMessage; canEdit: boolean; canDelete: boolean; onCorrect: CorrectChatMessage;
  /** The turn's other actions; Edit and Delete join them in one toolbar. */
  tools?: ReactNode;
}

export function ChatMessageCorrectionControls(props: CorrectionProps) {
  const scope = useContext(ChatCorrectionScope);
  const key = scope ? chatLocalKey("correction", scope, props.message.id) : null;
  const store = useMemo(() => createChatLocalStore<ChatCorrectionDraft | null>(key, null, parseChatCorrectionDraft), [key]);
  return <CorrectionEditor key={key ?? props.message.id} {...props} store={store} />;
}

function CorrectionEditor({ message, canEdit, canDelete, onCorrect, tools, store }: CorrectionProps & {
  store: ReturnType<typeof createChatLocalStore<ChatCorrectionDraft | null>>;
}) {
  const [restored] = useState(() => canEdit ? store.read() : null);
  const [mode, setMode] = useState<"edit" | "delete" | null>(restored ? "edit" : null);
  const [draft, setDraft] = useState(restored?.body ?? "");
  const [revision, setRevision] = useState(restored?.expectedRevision ?? 0);
  const savedDraft = useRef(restored);
  const preserve = (body: string, expectedRevision: number) => {
    savedDraft.current = { body, expectedRevision };
    store.write(savedDraft.current);
  };
  const cancel = () => {
    store.clearIfUnchanged(savedDraft.current);
    setMode(null);
  };
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const correction = readChatMessageCorrection(message.metadata);
  const currentRevision = correction?.revision ?? 0;
  const changed = mode !== null && revision !== currentRevision;
  const deleted = correction?.deletedAt != null;
  const toolbar = (triggers: ReactNode) => tools || triggers
    ? <div className="chat-turn-tools" role="toolbar" aria-label="Message actions">{tools}{triggers}</div>
    : null;
  if (deleted && !mode) return toolbar(null);
  const start = (next: "edit" | "delete") => {
    setDraft(message.body); setRevision(currentRevision); setError(null); setMode(next);
    if (next === "edit") preserve(message.body, currentRevision);
  };
  const submit = async () => {
    if (!mode || pending.current || changed || (mode === "edit" && !draft.trim())) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      await onCorrect(message.id, mode === "delete" ? { expectedRevision: revision, deleted: true } : { expectedRevision: revision, body: draft });
      store.clearIfUnchanged(savedDraft.current);
      setMode(null);
    } catch (error) {
      setError(error instanceof ChatApiError && error.status === 409
        ? "This message changed. Your text is still here. Cancel to review the latest message before editing again."
        : error instanceof ChatApiError && error.status === 403 ? "You no longer have permission to change this message."
        : "The change could not be saved. Your text is still here; try again.");
    } finally { pending.current = false; setBusy(false); }
  };
  return <>
    {toolbar(!mode && (canEdit || canDelete) ? <>
      {canEdit ? <button type="button" className="chat-turn-tool" onClick={() => start("edit")} aria-label="Edit message" title="Edit"><Pencil size={14} strokeWidth={1.8} aria-hidden /></button> : null}
      {canDelete ? <button type="button" className="chat-turn-tool" data-tone="danger" onClick={() => start("delete")} aria-label="Delete message" title="Delete"><Trash2 size={14} strokeWidth={1.8} aria-hidden /></button> : null}
    </> : null)}
    {!mode ? null : <form className="chat-message-correction" aria-label={mode === "edit" ? "Edit message" : "Delete message"} onSubmit={event => { event.preventDefault(); void submit(); }}>
      {mode === "edit" ? <label>Edit message<textarea autoFocus={!restored} aria-label="Edited message text" value={draft} maxLength={32000} disabled={busy}
        onChange={event => { setDraft(event.target.value); preserve(event.target.value, revision); }} onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); cancel(); } }} /></label>
        : <p>Delete this message from the conversation? Replies will remain.</p>}
      <p className="chat-attention-hint">Changes update this conversation. They do not undo work already received by an agent.</p>
      {restored && mode === "edit" ? <p className="chat-attention-hint">Unfinished edit restored on this browser.</p> : null}
      {changed ? <p role="alert">A newer version is available. Your text is preserved here; cancel to review it.</p> : null}
      {error && !changed ? <p role="alert">{error}</p> : null}
      <div>
        <button type="submit" className="btn btn--sm" disabled={busy || changed || (mode === "edit" && !draft.trim())}>{busy ? "Saving…" : mode === "edit" ? "Save changes" : "Delete message"}</button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
    </form>}
  </>;
}
