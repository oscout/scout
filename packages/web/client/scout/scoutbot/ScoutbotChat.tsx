import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, CheckCircle2, ChevronDown, ChevronUp, Copy, History, Loader2, Mic, Plus, SendHorizontal, Square } from "lucide-react";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { AgentMentionTextarea, type AgentMentionTextareaHandle } from "../../lib/agent-autocomplete.tsx";
import {
  formatAbsoluteTimestamp,
  formatClockTimestamp,
  normalizeTimestampMs,
} from "../../lib/time.ts";
import { ScoutbotMarkdown } from "../../lib/scoutbot-markdown.tsx";
import { stripScoutbotUiFences } from "../../lib/scoutbot.ts";
import type { Agent } from "../../lib/types.ts";
import type {
  ScoutbotAssistantMessage,
  ScoutbotAssistantSessionState,
} from "./scoutbot-model.ts";

export function ChatHistory({
  state,
  chatExpanded,
  onToggleExpanded,
  sessionPickerOpen,
  onToggleSessionPicker,
  onStartNewChat,
  startingNewChat,
  onSwitchSession,
  switchingSessionId,
  sending,
  briefing,
  pendingAsk,
  onArchiveSession,
  archivingSessionId,
  onAssistantContextMenu,
  suggestedPrompts,
  onSelectPrompt,
}: {
  state: ScoutbotAssistantSessionState;
  chatExpanded: boolean;
  onToggleExpanded: () => void;
  sessionPickerOpen: boolean;
  onToggleSessionPicker: () => void;
  onStartNewChat: () => void;
  startingNewChat: boolean;
  onSwitchSession: (id: string) => void;
  switchingSessionId: string | null;
  sending: boolean;
  briefing: boolean;
  pendingAsk: string | null;
  onArchiveSession: (id: string) => void;
  archivingSessionId: string | null;
  onAssistantContextMenu?: (event: React.MouseEvent, body: string) => void;
  suggestedPrompts?: readonly string[];
  onSelectPrompt?: (prompt: string) => void;
}) {
  const TRAIL = 4;
  const messages = state.session.messages;
  const visible = chatExpanded ? messages : messages.slice(-TRAIL);
  const hiddenCount = chatExpanded ? 0 : Math.max(0, messages.length - visible.length);
  const totalCount = messages.length;
  const sessionsCount = state.sessions.length;
  const retention = state.retention;
  const isEmptySession = messages.length === 0 && !pendingAsk && !sending && !briefing;
  const chatActionsBusy = startingNewChat
    || sending
    || briefing
    || Boolean(switchingSessionId)
    || Boolean(archivingSessionId);
  const startedAt = state.session.createdAt
    ? formatClockTimestamp(state.session.createdAt)
    : null;
  const titleLine = isEmptySession
    ? "Scout conversation"
    : state.session.title && state.session.title !== "New Scout Session"
    ? state.session.title
    : `Session ${state.session.id.slice(0, 8)}`;

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMessageId = messages[messages.length - 1]?.id ?? null;
  const lastMessageBody = messages[messages.length - 1]?.body ?? "";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lastMessageId, lastMessageBody, pendingAsk, sending, chatExpanded, state.session.id]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded border border-[var(--scout-chrome-border-soft)] bg-black/10 font-mono text-xs text-[var(--scout-chrome-ink-faint)]">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--scout-chrome-border-soft)] px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[var(--scout-chrome-ink)]" title={state.session.id}>
            {titleLine}
          </span>
          {startedAt && !isEmptySession && (
            <span className="shrink-0 text-[var(--scout-chrome-ink-ghost)]">· {startedAt}</span>
          )}
          {!isEmptySession && (
            <span className="shrink-0 text-[var(--scout-chrome-ink-ghost)]">· {totalCount} msg{totalCount === 1 ? "" : "s"}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="Start a new chat (keeps this chat in Chats)"
            aria-label="Start new chat"
            onClick={onStartNewChat}
            disabled={chatActionsBusy}
            className="flex items-center gap-1 rounded border border-lime-300/30 bg-lime-300/[0.06] px-1.5 py-0.5 text-2xs uppercase tracking-[0.1em] text-lime-100 transition-colors hover:border-lime-300/50 hover:bg-lime-300/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {startingNewChat ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
            <span>{startingNewChat ? "Starting" : "New chat"}</span>
          </button>
          <button
            type="button"
            title={`Switch chat (${sessionsCount} total)`}
            aria-label="Switch chat"
            onClick={onToggleSessionPicker}
            className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs uppercase tracking-[0.1em] transition-colors ${
              sessionPickerOpen
                ? "border-lime-300/40 bg-lime-300/10 text-lime-100"
                : "border-[var(--scout-chrome-border-soft)] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
            }`}
          >
            <History size={10} />
            <span>Chats</span>
            <span className="text-[var(--scout-chrome-ink-ghost)]">{sessionsCount}</span>
            <ChevronDown size={9} className={sessionPickerOpen ? "rotate-180 transition-transform" : "transition-transform"} />
          </button>
          {totalCount > TRAIL && (
            <button
              type="button"
              title={chatExpanded ? "Collapse chat" : "View full session"}
              aria-label={chatExpanded ? "Collapse chat" : "View full session"}
              onClick={onToggleExpanded}
              className="flex items-center gap-1 rounded border border-[var(--scout-chrome-border-soft)] px-1.5 py-0.5 text-2xs uppercase tracking-[0.1em] text-[var(--scout-chrome-ink-faint)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
            >
              <span>{chatExpanded ? "Collapse" : "Full"}</span>
              {chatExpanded ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
            </button>
          )}
        </div>
      </div>

      {sessionPickerOpen && (
        <div className="shrink-0 border-b border-[var(--scout-chrome-border-soft)] px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between gap-2 px-0.5 text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
            <span>Recent chats</span>
            {retention && retention.archivedCount > 0 && (
              <span>{retention.archivedCount} archived</span>
            )}
          </div>
          <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto pr-0.5">
            {state.sessions.map((entry) => {
              const isActive = entry.id === state.session.id;
              const isBusy = switchingSessionId === entry.id;
              const isArchiving = archivingSessionId === entry.id;
              const ts = formatAbsoluteTimestamp(entry.updatedAt) || "unknown";
              const display = entry.title && entry.title !== "New Scout Session"
                ? entry.title
                : `Session ${entry.id.slice(0, 8)}`;
              return (
                <div
                  key={entry.id}
                  className={`flex items-center gap-2 rounded border px-2 py-1 text-left transition-colors ${
                    isActive
                      ? "border-lime-300/40 bg-lime-300/[0.06] text-lime-100"
                      : "border-transparent text-[var(--scout-chrome-ink-faint)] hover:border-[var(--scout-chrome-border-soft)] hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (isActive) return;
                      onSwitchSession(entry.id);
                    }}
                    disabled={isActive || Boolean(switchingSessionId) || Boolean(archivingSessionId)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-lime-300" : "bg-[var(--scout-chrome-ink-ghost)]"}`} />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--scout-chrome-ink)]">{display}</span>
                    <span className="shrink-0 text-2xs text-[var(--scout-chrome-ink-ghost)]">
                      {entry.messageCount} msg
                    </span>
                    <span className="shrink-0 text-2xs text-[var(--scout-chrome-ink-ghost)]">{ts}</span>
                    {isBusy && <Loader2 size={10} className="shrink-0 animate-spin text-lime-200" />}
                  </button>
                  <button
                    type="button"
                    title="Archive chat"
                    aria-label={`Archive chat ${display}`}
                    onClick={() => onArchiveSession(entry.id)}
                    disabled={Boolean(switchingSessionId) || Boolean(archivingSessionId)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-transparent text-[var(--scout-chrome-ink-ghost)] transition-colors hover:border-[var(--scout-chrome-border-soft)] hover:bg-black/20 hover:text-[var(--scout-chrome-ink)] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {isArchiving ? <Loader2 size={10} className="animate-spin" /> : <Archive size={10} />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2">
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="self-start text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)] hover:text-[var(--scout-chrome-ink)]"
          >
            ↑ {hiddenCount} earlier message{hiddenCount === 1 ? "" : "s"}
          </button>
        )}
        {isEmptySession && (
          <ScoutbotZeroState
            suggestedPrompts={suggestedPrompts}
            onSelectPrompt={onSelectPrompt}
          />
        )}
        {visible.map((message, index) => {
          const showTimestamp = shouldShowScoutbotMessageTimestamp(visible[index - 1], message);
          const timestamp = formatScoutbotMessageTimestamp(message.createdAt);
          return (
            <div key={message.id} className="flex flex-col gap-1">
              {showTimestamp && (
                <div
                  className="self-center rounded-full bg-white/[0.06] px-2.5 py-0.5 font-mono text-2xs font-medium text-[var(--scout-chrome-ink-ghost)]"
                  title={formatAbsoluteTimestamp(message.createdAt)}
                  aria-label={timestamp}
                >
                  {timestamp}
                </div>
              )}
              <ChatBubble
                role={message.role}
                body={message.body}
                onContextMenu={
                  message.role === "assistant" && onAssistantContextMenu
                    ? (event) => onAssistantContextMenu(event, message.body)
                    : undefined
                }
              />
            </div>
          );
        })}
        {pendingAsk && (
          <ChatBubble role="user" body={pendingAsk} pending />
        )}
        {sending && !pendingAsk && (
          <p className="text-[var(--scout-chrome-ink-ghost)]">Reading the control plane…</p>
        )}
        {briefing && (
          <div className="flex items-center gap-2 rounded border border-lime-300/30 bg-lime-300/[0.06] px-2.5 py-2 font-mono text-xs leading-relaxed text-lime-100">
            <Loader2 size={12} className="shrink-0 animate-spin text-lime-300" aria-hidden="true" />
            <div className="min-w-0 flex flex-col gap-0.5">
              <span className="text-xs uppercase tracking-[0.14em] text-lime-300">Briefing</span>
              <span className="text-[var(--scout-chrome-ink)]">
                Codex is reviewing the control-plane snapshot. Voice will pick up when it lands.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ScoutbotZeroState({
  suggestedPrompts = [],
  onSelectPrompt,
}: {
  suggestedPrompts?: readonly string[];
  onSelectPrompt?: (prompt: string) => void;
}) {
  // SCO-085: suggested prompts at the top of the empty state (not vertically centered).
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-start gap-2 px-1 py-2.5">
      {suggestedPrompts.length > 0 ? (
        <div className="grid gap-1">
          {suggestedPrompts.slice(0, 3).map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onSelectPrompt?.(prompt)}
              className="min-h-7 truncate rounded border border-[var(--scout-chrome-border-soft)] bg-black/10 px-2.5 text-left font-mono text-xs leading-snug text-[var(--scout-chrome-ink-faint)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}
      <div className="max-w-[30rem]">
        <div className="font-sans text-lg font-semibold leading-tight text-[var(--scout-chrome-ink)]">
          Start with a question.
        </div>
        <p className="mt-0.5 font-sans text-xs leading-snug text-[var(--scout-chrome-ink-faint)]">
          Paste a failed result or ask about what you are seeing. Scout replies when you ask.
        </p>
      </div>
    </div>
  );
}

export function ChatInput({
  agents,
  draft,
  onDraftChange,
  onSubmit,
  sending,
  recording,
  voiceLabel,
  voiceBusy,
  voiceUnavailable,
  voiceHeld = false,
  onMicClick,
  prominent = false,
  autoFocus,
  focusSignal,
}: {
  agents: Agent[];
  draft: string;
  onDraftChange: (next: string) => void;
  onSubmit: () => void;
  sending: boolean;
  recording: boolean;
  voiceLabel: string;
  voiceBusy: boolean;
  voiceUnavailable: boolean;
  /** Soft-hold the mic without a busy spinner (e.g. live call owns the mic). */
  voiceHeld?: boolean;
  onMicClick: () => void;
  prominent?: boolean;
  autoFocus?: boolean;
  focusSignal?: number;
}) {
  const textareaRef = useRef<AgentMentionTextareaHandle>(null);
  const focusTextarea = useCallback(() => {
    const handle = textareaRef.current;
    if (!handle) return;
    if (handle.textarea) {
      handle.textarea.focus({ preventScroll: true });
    } else {
      handle.focus();
    }
  }, []);
  useEffect(() => {
    if (!autoFocus) return;
    focusTextarea();
  }, [autoFocus, focusTextarea]);
  useEffect(() => {
    if (!focusSignal) return;
    focusTextarea();
  }, [focusSignal, focusTextarea]);

  let micTitle = "Start talking";
  if (voiceUnavailable) micTitle = "Set up Scout voice";
  if (recording) micTitle = "Stop talking";
  if (voiceBusy || voiceHeld) micTitle = voiceLabel;
  const showVoiceLabel = voiceBusy || recording || voiceHeld;
  const textareaClassName = [
    "w-full resize-none rounded border font-mono text-sm leading-relaxed text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)]",
    prominent
      ? "min-h-[88px] max-h-[170px] border-lime-300/30 bg-black/25 px-3 py-2 text-md"
      : "min-h-[44px] max-h-[124px] border-[var(--scout-chrome-border-soft)] bg-black/20 px-2 py-1.5",
  ].join(" ");
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <AgentMentionTextarea
        ref={textareaRef}
        agents={agents}
        value={draft}
        onChange={onDraftChange}
        onSubmit={() => {
          if (draft.trim() && !sending) onSubmit();
        }}
        placeholder={
          voiceHeld
            ? "Type while live voice is on…"
            : prominent
              ? "Ask Scout about what you are seeing…"
              : "Ask Scout…"
        }
        rows={prominent ? 4 : 2}
        disabled={sending}
        submitOnEnter
        className="min-w-0"
        textareaClassName={textareaClassName}
      />
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          title={micTitle}
          aria-label={micTitle}
          onClick={onMicClick}
          disabled={sending || voiceBusy || voiceHeld}
          className={`flex h-8 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            recording
              ? "border-lime-300/50 bg-lime-300/10 text-lime-200"
              : voiceHeld
                ? "border-lime-300/25 bg-lime-300/[0.05] text-lime-100/70"
                : "border-[var(--scout-chrome-border-soft)] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
          } ${showVoiceLabel ? "gap-1.5 px-3 font-mono text-xs uppercase tracking-[0.12em]" : "w-9"}`}
        >
          {voiceBusy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : recording ? (
            <Square size={12} className="fill-current" />
          ) : (
            <Mic size={13} />
          )}
          {showVoiceLabel && <span className="truncate">{voiceLabel}</span>}
        </button>
        <button
          type="submit"
          title="Send"
          aria-label="Send"
          disabled={!draft.trim() || sending}
          className="flex h-8 w-9 items-center justify-center rounded bg-lime-300/90 text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? <Loader2 size={13} className="animate-spin" /> : <SendHorizontal size={13} />}
        </button>
      </div>
    </form>
  );
}

function ChatBubble({
  role,
  body,
  pending = false,
  onContextMenu,
}: {
  role: "user" | "assistant";
  body: string;
  pending?: boolean;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const isUser = role === "user";
  const text = isUser ? body : stripScoutbotUiFences(body);
  const [copied, setCopied] = useState(false);
  const copyMessage = useCallback(() => {
    void copyTextToClipboard(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [text]);
  return (
    <div className="group flex flex-col gap-0.5" onContextMenu={onContextMenu}>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-2xs uppercase tracking-[0.12em] ${isUser ? "text-[var(--scout-chrome-ink-ghost)]" : "text-lime-300"}`}>
          {isUser ? "You" : "Reply"}
          {pending && " · sending"}
        </span>
        <button
          type="button"
          title={copied ? "Copied" : "Copy message"}
          aria-label={copied ? "Copied message" : "Copy message"}
          disabled={pending || !text.trim()}
          onClick={copyMessage}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--scout-chrome-border-soft)] text-[var(--scout-chrome-ink-ghost)] opacity-70 transition hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)] disabled:cursor-not-allowed disabled:opacity-20 group-hover:opacity-100"
        >
          {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
        </button>
      </div>
      {isUser ? (
        <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--scout-chrome-ink)] ${pending ? "opacity-60" : ""}`}>
          {text}
        </p>
      ) : (
        <div className={pending ? "opacity-60" : ""}>
          <ScoutbotMarkdown text={text} />
        </div>
      )}
    </div>
  );
}

const SCOUTBOT_MESSAGE_TIMESTAMP_GAP_MS = 5 * 60_000;

function shouldShowScoutbotMessageTimestamp(
  previous: ScoutbotAssistantMessage | undefined,
  current: ScoutbotAssistantMessage,
): boolean {
  if (!previous) return true;
  if (!isSameScoutbotMessageDay(previous.createdAt, current.createdAt)) return true;
  const previousMs = normalizeTimestampMs(previous.createdAt);
  const currentMs = normalizeTimestampMs(current.createdAt);
  if (previousMs === null || currentMs === null) return true;
  return Math.abs(currentMs - previousMs) >= SCOUTBOT_MESSAGE_TIMESTAMP_GAP_MS;
}

function isSameScoutbotMessageDay(left: number, right: number): boolean {
  const leftMs = normalizeTimestampMs(left);
  const rightMs = normalizeTimestampMs(right);
  if (leftMs === null || rightMs === null) return false;
  const leftDate = new Date(leftMs);
  const rightDate = new Date(rightMs);
  return (
    leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
  );
}

function formatScoutbotMessageTimestamp(value: number): string {
  const valueMs = normalizeTimestampMs(value);
  if (valueMs === null) return "";
  const date = new Date(valueMs);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (isSameScoutbotMessageDay(valueMs, now.getTime())) {
    return `Today ${time}`;
  }
  if (isSameScoutbotMessageDay(valueMs, yesterday.getTime())) {
    return `Yesterday ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} ${time}`;
}
