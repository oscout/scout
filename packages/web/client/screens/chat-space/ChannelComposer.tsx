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
 * Shape: a roomy text field over a quiet toolbar, closed by a round send.
 * Every control in the toolbar does something — the `@` button opens the real
 * member list, the selector opens the real agent list, and send sends. There
 * is no formatting row because the feed renderer has no formatting to show
 * (`bodySegments` emits text and mention spans, nothing else), and a bold
 * button that yields literal asterisks would be a lie in a toolbar.
 */

import { ArrowUp, AtSign, ChevronDown, Loader2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { ChannelMemberView } from "./chat-api.ts";
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
  onSend: () => void;
  sending: boolean;
  error: string | null;
  placeholder: string;
  variant?: "channel" | "thread";
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerButtonRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The picker offers only members `/asks` will actually route to. An API
  // participant is listed inertly below — hiding the one agent in the room
  // would be worse than saying why it cannot be asked.
  const askable = useMemo(() => members.filter(isAskableMember), [members]);
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

  const resize = useCallback(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [draft, resize]);

  const closePicker = useCallback((returnFocus: "toggle" | "input") => {
    setPickerOpen(false);
    if (returnFocus === "toggle") pickerButtonRef.current?.focus();
    else inputRef.current?.focus();
  }, []);

  const applyMention = useCallback(
    (member: ChannelMemberView) => {
      const node = inputRef.current;
      const caret = node?.selectionStart ?? draft.length;
      const active = query ?? readMentionQuery(draft, caret);
      const label = memberDisplayName(member);
      if (!active) {
        onDraftChange(`${draft}${draft.endsWith(" ") || draft === "" ? "" : " "}@${label} `);
      } else {
        const next = `${draft.slice(0, active.start)}@${label} ${draft.slice(caret)}`;
        onDraftChange(next);
      }
      // The selection — not the text — is what addresses the agent. An API
      // participant is never armed as a target: `/asks` refuses it by name,
      // and a mention of it is an ordinary post it reads on its next poll.
      if (isAskableMember(member)) onAskTargetChange(member.actorId);
      setQuery(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        const position = (active?.start ?? draft.length) + label.length + 2;
        input.setSelectionRange(position, position);
      });
    },
    [draft, onAskTargetChange, onDraftChange, query],
  );

  /**
   * The `@` button is the pointer route into the same mention list the keyboard
   * opens: it types the `@` the person would have typed, at their caret, and
   * leaves the query open on an empty needle so the whole roster is showing.
   */
  const openMentionList = useCallback(() => {
    const node = inputRef.current;
    const { next, caret } = mentionInsertion(draft, node?.selectionStart ?? draft.length);
    onDraftChange(next);
    setPickerOpen(false);
    setQuery({ start: caret - 1, text: "" });
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  }, [draft, onDraftChange]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!sending && draft.trim()) onSend();
      }
    },
    [activeIndex, applyMention, draft, matches, onSend, pickerOpen, query, sending],
  );

  const hint = composerHint(target ? memberDisplayName(target) : null);
  const canSend = !sending && draft.trim().length > 0;
  const sendTitle = target
    ? `Send — asks ${memberDisplayName(target)}`
    : variant === "thread"
      ? "Send reply"
      : "Send to the channel";

  return (
    <div className="chat-composer" data-variant={variant}>
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

      <textarea
        ref={inputRef}
        className="chat-composer-input"
        rows={1}
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={sending}
        onChange={(event) => {
          onDraftChange(event.target.value);
          setQuery(readMentionQuery(event.target.value, event.target.selectionStart ?? 0));
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(null)}
      />

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

      {pickerOpen && variant === "channel" ? (
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
          {variant === "channel" ? (
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
            onClick={onSend}
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
