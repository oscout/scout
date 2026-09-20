/**
 * The composer, and with it the boundary this feature turns on.
 *
 * One Send action. An untargeted send posts a channel update and invokes
 * nobody. Work is created only by an explicitly selected agent — picked from
 * the mention list or the ask selector — and the selection carries an actor
 * id. A display name typed into the body routes nothing: names are not
 * addresses, and parsing one would be the "fake participant" bug wearing a
 * different hat.
 *
 * Shape: a roomy rich field over a quiet toolbar, closed by a round send.
 * Formatting marks the feed can actually paint (bold, italic, code, list) live
 * on the toolbar; the wire is still markdown. `@` opens the real member list,
 * the selector opens the real agent list, and send sends.
 */

import { ArrowUp, AtSign, Bold, ChevronDown, Code, Italic, List, Loader2, Paperclip, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useComposerAttachments } from "../../components/MessageComposer/ComposerAttachments.tsx";

import { ChatRichInput, type ChatRichInputHandle } from "./ChatRichInput.tsx";
import type { ChannelMemberView } from "./chat-api.ts";
import { useChatCapabilities } from "./chat-transport.tsx";
import { MemberAvatar } from "./ChatAvatar.tsx";
import {
  composerHint,
  isAgentMember,
  isApiParticipant,
  isAskableMember,
  memberDisplayName,
} from "./chat-space-model.ts";

interface MentionQuery {
  /** Index of the `@` that opened this query. */
  start: number;
  text: string;
}

function readMentionQuery(value: string, caret: number): MentionQuery | null {
  const upToCaret = value.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/u.test(upToCaret[at - 1] ?? "")) return null;
  const text = upToCaret.slice(at + 1);
  // A mention token never spans a newline, and two spaces mean the person
  // moved on without picking anybody.
  if (/\n/u.test(text)) return null;
  if (text.split(" ").length > 3) return null;
  return { start: at, text };
}

/**
 * Where an `@` lands when the toolbar button types it instead of the person.
 * A mention token is only recognised at a word boundary (`readMentionQuery`),
 * so the button has to supply the space the typist would have.
 */
export function mentionInsertion(draft: string, caret: number): { next: string; caret: number } {
  const clamped = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, clamped);
  const spacer = before.length > 0 && !/\s$/u.test(before) ? " " : "";
  const head = `${before}${spacer}@`;
  return { next: `${head}${draft.slice(clamped)}`, caret: head.length };
}

export function ChannelComposer({
  members,
  draft,
  onDraftChange,
  askTargetId,
  onAskTargetChange,
  onSend,
  sending,
  error,
  placeholder,
  variant = "channel",
  autoFocus = false,
}: {
  members: ChannelMemberView[];
  draft: string;
  onDraftChange: (value: string) => void;
  askTargetId: string | null;
  onAskTargetChange: (actorId: string | null) => void;
  onSend: (files: File[]) => void | boolean | Promise<boolean | void>;
  sending: boolean;
  error: string | null;
  placeholder: string;
  variant?: "channel" | "thread";
  autoFocus?: boolean;
}) {
  const inputRef = useRef<ChatRichInputHandle | null>(null);
  const pickerButtonRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const capabilities = useChatCapabilities();
  const attachments = useComposerAttachments();

  // The picker offers only members `/asks` will actually route to. An API
  // participant is listed inertly below — hiding the one agent in the room
  // would be worse than saying why it cannot be asked. Where the server has no
  // `/asks` at all, nobody is askable and the control is not offered.
  const askable = useMemo(
    () => (capabilities.asks ? members.filter(isAskableMember) : []),
    [capabilities.asks, members],
  );
  const apiParticipants = useMemo(() => members.filter(isApiParticipant), [members]);
  const target = useMemo(
    () => members.find((member) => member.actorId === askTargetId) ?? null,
    [members, askTargetId],
  );

  const matches = useMemo(() => {
    if (!query) return [];
    const needle = query.text.trim().toLowerCase();
    const ranked = members.filter((member) =>
      memberDisplayName(member).toLowerCase().includes(needle)
      || member.displayName.toLowerCase().includes(needle));
    // Agents first: they are the ones a mention can turn into work.
    return [...ranked].sort((left, right) =>
      Number(isAgentMember(right)) - Number(isAgentMember(left)),
    ).slice(0, 8);
  }, [members, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query?.text]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
  }, [autoFocus]);

  const closePicker = useCallback((returnFocus: "toggle" | "input") => {
    setPickerOpen(false);
    if (returnFocus === "toggle") pickerButtonRef.current?.focus();
    else inputRef.current?.focus();
  }, []);

  const applyMention = useCallback(
    (member: ChannelMemberView) => {
      const editor = inputRef.current;
      const before = editor?.textBeforeCaret() ?? draft;
      const active = query ?? readMentionQuery(before, before.length);
      const label = memberDisplayName(member);
      if (!editor) {
        onDraftChange(`${draft}${draft.endsWith(" ") || draft === "" ? "" : " "}@${label} `);
      } else if (!active) {
        editor.insertText(`${before.endsWith(" ") || before === "" ? "" : " "}@${label} `);
      } else {
        editor.replaceMention(active.start, label);
      }
      // The selection — not the text — is what addresses the agent. An API
      // participant is never armed as a target: `/asks` refuses it by name,
      // and a mention of it is an ordinary post it reads on its next poll.
      if (capabilities.asks && isAskableMember(member)) onAskTargetChange(member.actorId);
      setQuery(null);
    },
    [capabilities.asks, draft, onAskTargetChange, onDraftChange, query],
  );

  /**
   * The `@` button is the pointer route into the same mention list the keyboard
   * opens: it types the `@` the person would have typed, at their caret, and
   * leaves the query open on an empty needle so the whole roster is showing.
   */
  const openMentionList = useCallback(() => {
    const editor = inputRef.current;
    const before = editor?.textBeforeCaret() ?? draft;
    const spacer = before.length > 0 && !/\s$/u.test(before) ? " " : "";
    editor?.insertText(`${spacer}@`);
    if (!editor) {
      const { next, caret } = mentionInsertion(draft, draft.length);
      onDraftChange(next);
      setQuery({ start: caret - 1, text: "" });
    } else {
      const nextBefore = editor.textBeforeCaret();
      setQuery({ start: Math.max(0, nextBefore.length - 1), text: "" });
    }
    setPickerOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [draft, onDraftChange]);

  const canSend = !sending && (draft.trim().length > 0 || attachments.hasFiles);
  const submit = useCallback(() => {
    if (sending || (!draft.trim() && !attachments.hasFiles)) return;
    const files = attachments.files;
    void Promise.resolve(onSend(files)).then((sent) => {
      if (sent !== false) attachments.clear();
    });
  }, [attachments, draft, onSend, sending]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // IME confirmation belongs to the text input, including while a mention
      // list is open. Some WebKit versions expose only the legacy 229 code.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (query && matches.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % matches.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const picked = matches[activeIndex];
          if (picked) applyMention(picked);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setQuery(null);
          return;
        }
      }
      // Our own open list closes before Esc reaches the surface's panel handler.
      if (event.key === "Escape" && pickerOpen) {
        event.preventDefault();
        event.stopPropagation();
        setPickerOpen(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        inputRef.current?.applyFormat("bold");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
        event.preventDefault();
        inputRef.current?.applyFormat("italic");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
        event.preventDefault();
        inputRef.current?.applyFormat("code");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (canSend) submit();
      }
    },
    [activeIndex, applyMention, canSend, matches, pickerOpen, query, sending, submit],
  );

  const hint = composerHint(target ? memberDisplayName(target) : null);
  const sendTitle = target
    ? `Send — asks ${memberDisplayName(target)}`
    : variant === "thread"
      ? "Send reply"
      : "Send to the channel";

  return (
    <div
      className="chat-composer"
      data-variant={variant}
      data-drag={capabilities.attachments && attachments.dragActive ? "true" : undefined}
      {...(capabilities.attachments ? attachments.dropHandlers : {})}
    >
      {variant === "channel" && target ? (
        <div className="chat-ask-target">
          <span className="label-sm" style={{ color: "var(--dim)" }}>Asking</span>
          <span className="chip chip--sm chip--mono chip--neutral">
            <MemberAvatar member={target} size={14} />
            {memberDisplayName(target)}
          </span>
          <button
            type="button"
            className="chat-ask-target-clear"
            onClick={() => onAskTargetChange(null)}
            aria-label="Clear ask target — send as a channel update instead"
          >
            ×
          </button>
          {hint ? <span className="chat-composer-hint">{hint}</span> : null}
        </div>
      ) : null}

      <ChatRichInput
        ref={inputRef}
        value={draft}
        placeholder={placeholder}
        disabled={sending}
        onChange={(markdown) => {
          onDraftChange(markdown);
          const before = inputRef.current?.textBeforeCaret() ?? markdown;
          setQuery(readMentionQuery(before, before.length));
        }}
        onKeyDown={onKeyDown}
        onPaste={capabilities.attachments ? attachments.onPaste : undefined}
        onDragOver={capabilities.attachments ? attachments.dropHandlers.onDragOver : undefined}
        onDrop={capabilities.attachments ? attachments.dropHandlers.onDrop : undefined}
        onBlur={() => setQuery(null)}
      />
      {capabilities.attachments ? (
        <>
          <input
            ref={attachments.inputRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*,.mp4,.webm,.mov,.mp3,.wav,.m4a,.html,.htm,text/html,text/markdown,.md,.markdown,text/plain,.txt"
            className="chat-composer-file-input"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              attachments.stage([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          {attachments.files.length > 0 ? (
            <div className="chat-composer-files" aria-label="Attached files">
              {attachments.files.map((file) => (
                <span key={`${file.name}:${file.size}:${file.lastModified}`} className="chat-composer-file">
                  <span>{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => attachments.remove(file)}
                  >
                    <X size={12} strokeWidth={2} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {attachments.error ? (
            <p className="chat-send-error" role="alert">{attachments.error}</p>
          ) : null}
        </>
      ) : null}

      {query && matches.length > 0 ? (
        <div className="chat-mention-popup" role="listbox" aria-label="Mention a member">
          {matches.map((member, index) => (
            <button
              key={member.actorId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-active={index === activeIndex}
              className="chat-mention-option"
              // `mousedown` fires before the textarea blur that would close this.
              onMouseDown={(event) => {
                event.preventDefault();
                applyMention(member);
              }}
            >
              <MemberAvatar member={member} size={18} />
              {memberDisplayName(member)}
              <span className="chat-mention-kind">
                {isApiParticipant(member) ? "via API" : isAgentMember(member) ? "agent" : "person"}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {pickerOpen && variant === "channel" && capabilities.asks ? (
        <div
          className="chat-mention-popup"
          role="listbox"
          aria-label="Choose an agent to ask"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closePicker("toggle");
          }}
        >
          {askable.length === 0 && apiParticipants.length === 0 ? (
            <div className="chat-side-empty">
              No agent has joined this channel yet. Invite one from the Invite sheet.
            </div>
          ) : (
            <>
              {askable.map((member) => (
                <button
                  key={member.actorId}
                  type="button"
                  role="option"
                  aria-selected={member.actorId === askTargetId}
                  data-active={member.actorId === askTargetId}
                  className="chat-mention-option"
                  onClick={() => {
                    onAskTargetChange(member.actorId);
                    closePicker("input");
                  }}
                >
                  <MemberAvatar member={member} size={18} />
                  {memberDisplayName(member)}
                  <span className="chat-mention-kind">{member.reception.summary.toLowerCase()}</span>
                </button>
              ))}
              {/* Present but not selectable: `/asks` refuses these by name.
                  A post reaches them on their next poll. */}
              {apiParticipants.map((member) => (
                <button
                  key={member.actorId}
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-disabled="true"
                  disabled
                  className="chat-mention-option"
                >
                  <MemberAvatar member={member} size={18} />
                  {memberDisplayName(member)}
                  <span className="chat-mention-kind">via API — post to reach it</span>
                </button>
              ))}
              {askable.length === 0 ? (
                <div className="chat-side-empty">
                  API participants read posts when they poll. Send a channel message instead.
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {error ? <p className="chat-send-error" role="alert">{error}</p> : null}

      <div className="chat-composer-foot">
        <span className="chat-composer-tools">
          {capabilities.attachments ? (
            <button
              type="button"
              className="chat-composer-tool chat-composer-tool--icon"
              onClick={attachments.openPicker}
              disabled={sending}
              aria-label="Attach a file"
              title="Attach a file"
            >
              <Paperclip size={14} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="chat-composer-tool chat-composer-tool--icon"
            onClick={openMentionList}
            disabled={sending}
            aria-label="Mention a member"
            title="Mention a member"
          >
            <AtSign size={14} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="chat-composer-tool chat-composer-tool--icon"
            onMouseDown={(event) => {
              event.preventDefault();
              inputRef.current?.applyFormat("bold");
            }}
            disabled={sending}
            aria-label="Bold"
            title="Bold"
          >
            <Bold size={14} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="chat-composer-tool chat-composer-tool--icon"
            onMouseDown={(event) => {
              event.preventDefault();
              inputRef.current?.applyFormat("italic");
            }}
            disabled={sending}
            aria-label="Italic"
            title="Italic"
          >
            <Italic size={14} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="chat-composer-tool chat-composer-tool--icon"
            onMouseDown={(event) => {
              event.preventDefault();
              inputRef.current?.applyFormat("code");
            }}
            disabled={sending}
            aria-label="Code"
            title="Code"
          >
            <Code size={14} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="chat-composer-tool chat-composer-tool--icon"
            onMouseDown={(event) => {
              event.preventDefault();
              inputRef.current?.applyFormat("list");
            }}
            disabled={sending}
            aria-label="List"
            title="List"
          >
            <List size={14} strokeWidth={2} aria-hidden />
          </button>
          {variant === "channel" && capabilities.asks ? (
            <button
              ref={pickerButtonRef}
              type="button"
              className="chat-composer-tool"
              data-active={pickerOpen}
              aria-expanded={pickerOpen}
              aria-haspopup="listbox"
              disabled={sending}
              onClick={() => setPickerOpen((open) => !open)}
            >
              {target ? "Change agent" : "Ask an agent"}
              <ChevronDown size={12} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </span>
        <span className="chat-composer-right">
          <span className="chat-enter">
            {variant === "thread" ? "↵ send" : "↵ send · ⇧↵ newline"}
          </span>
          <button
            type="button"
            className="chat-composer-send"
            onClick={submit}
            disabled={!canSend}
            aria-label={sending ? "Sending…" : sendTitle}
            title={sending ? "Sending…" : sendTitle}
          >
            {sending
              ? <Loader2 size={15} strokeWidth={2.2} className="chat-composer-spin" aria-hidden />
              : <ArrowUp size={16} strokeWidth={2.4} aria-hidden />}
          </button>
        </span>
      </div>
    </div>
  );
}
