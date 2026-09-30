import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { ChatApi, ChatMessage } from "./chat-api.ts";

export function ChatSearch({ api, channelId, space, onOpen, open: controlledOpen, onOpenChange }: {
  api: ChatApi; channelId: string; space: string; onOpen: (message: ChatMessage) => void;
  /** Controlled by the channel header, which keeps one tray open at a time. */
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean | ((value: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    if (onOpenChange) onOpenChange(value); else setLocalOpen(value);
  };
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const search = async (term: string, next: string | null = null) => {
    if (!api.searchMessages || !term.trim()) return;
    const attempt = ++generation.current;
    setBusy(true); setError(null);
    if (!next) { setMessages([]); setCursor(null); setQuery(term.trim()); }
    try {
      const found = await api.searchMessages(channelId, term.trim(), next, space);
      if (generation.current !== attempt) return;
      setMessages(previous => next ? [...new Map([...previous, ...found.messages].map(message => [message.id, message])).values()] : found.messages);
      setCursor(found.nextCursor);
    } catch {
      if (generation.current === attempt) setError("Search could not be completed. Try again.");
    } finally { if (generation.current === attempt) setBusy(false); }
  };
  return <section className="chat-search" aria-label="Search channel messages">
    <button type="button" className="chat-head-tool" aria-expanded={open} aria-controls="chat-search-content" aria-label="Search this channel" title="Search this channel" onClick={() => setOpen(value => !value)}>
      <Search size={16} strokeWidth={1.8} aria-hidden />
    </button>
    {open ? <div id="chat-search-content" className="chat-search-content">
      <form onSubmit={event => { event.preventDefault(); void search(input); }}>
        <input autoFocus aria-label="Search this channel and its replies" type="search" maxLength={200} value={input} onChange={event => setInput(event.target.value)} placeholder="Search this channel and its replies" />
        <button type="submit" className="btn btn--sm" disabled={!input.trim() || busy}>Search</button>
      </form>
      {error ? <p role="alert">{error} <button type="button" className="btn btn--sm" onClick={() => void search(query, cursor)}>Retry</button></p> : null}
      {busy ? <p role="status">Searching…</p> : query && !error ? <p role="status">{messages.length ? `${messages.length}${cursor ? "+" : ""} ${messages.length === 1 && !cursor ? "result" : "results"} for “${query}”` : `No retained messages match “${query}”.`}</p> : null}
      <div className="chat-search-results">
        {messages.map(message => <button key={message.id} type="button" className="chat-search-result" onClick={() => { setOpen(false); onOpen(message); }}>
          <span className="chat-search-meta">{new Date(message.createdAt).toLocaleString()}{message.replyToMessageId ? " · Reply" : ""}</span>
          <span className="chat-search-excerpt">{message.body}</span>
        </button>)}
      </div>
      {cursor ? <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void search(query, cursor)}>More results</button> : null}
    </div> : null}
  </section>;
}
