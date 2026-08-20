import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { isComposerSendShortcut } from "../../lib/compose-shortcuts.ts";
import { DictationMic, type MicStatus } from "../DictationMic.tsx";
import { useMessageComposerEmbedded } from "./MessageComposerEmbedBoundary.tsx";
import { VoiceWaveform } from "./VoiceWaveform.tsx";
import "./message-composer.css";

export type MessageComposerDensity = "panel" | "thread" | "compact" | "bare";
export type MessageComposerDictationStatus = MicStatus;

export type MessageComposerChangeMeta = {
  caret: number;
};

export type MessageComposerProps = {
  value: string;
  onChange: (value: string, meta?: MessageComposerChangeMeta) => void;
  onSend: () => void;
  /**
   * Embedded surfaces normally defer to their host's composer. Set this only
   * when an embed intentionally owns a distinct message target.
   */
  renderWhenEmbedded?: boolean;
  placeholder?: string;
  /** Disables the textarea and actions. */
  disabled?: boolean;
  /** True while a send is in flight (disables Send). */
  sending?: boolean;
  /** Override Send enablement (defaults to non-empty trimmed value). */
  canSend?: boolean;
  /**
   * Agent-stop mode: the primary action becomes Stop agent (not mic stop).
   * Dictation still uses its own mic control.
   */
  stopMode?: boolean;
  onStop?: () => void;
  /** Standardized Send labels — prefer leaving defaults. */
  sendTitle?: string;
  sendAriaLabel?: string;
  stopAriaLabel?: string;
  showDictation?: boolean;
  /** Reports dictation lifecycle so a containing focus surface can preserve it. */
  onDictationStatusChange?: (status: MessageComposerDictationStatus) => void;
  /** Left toolbar: paperclip / add attachment. */
  showAttach?: boolean;
  onAttach?: () => void;
  attachTitle?: string;
  attachAriaLabel?: string;
  /** Paste handler on the field — used to stage clipboard images/files. */
  onPaste?: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  /** Drop target handlers for the composer shell (see useComposerAttachments). */
  dropHandlers?: {
    onDragOver: (event: ReactDragEvent) => void;
    onDragLeave: (event: ReactDragEvent) => void;
    onDrop: (event: ReactDragEvent) => void;
  };
  /** Highlights the shell while a routable drag hovers it. */
  dragActive?: boolean;
  /**
   * Rendered immediately before Send. Used for the alternate commit path when
   * the primary action is ambiguous (e.g. Steer alongside Queue).
   */
  secondaryAction?: ReactNode;
  /** Toolbar tools on the left (commands, context controls, etc.). */
  leadingTools?: ReactNode;
  /**
   * Toolbar tools on the right, before mic/Send (model picker, harness, etc.).
   * Attach stays on the left.
   */
  tools?: ReactNode;
  /** Alias for tools — older call sites used `footer` for selects. */
  footer?: ReactNode;
  /** Top decoration: reply annotation, target chip, etc. */
  header?: ReactNode;
  /**
   * Rendered above the shell, outside the box but at the same width (queued
   * message stack, etc.). Use `header` for decoration that belongs inside.
   */
  above?: ReactNode;
  /**
   * Fuse the `above` slot onto the top of the shell so the two read as one
   * object (shared edge, no gap) instead of two stacked boxes.
   */
  aboveAttached?: boolean;
  /**
   * Replace the default textarea (e.g. AgentMentionTextarea). Parent still
   * owns `value` / `onChange` for Send enablement; this only swaps the field.
   */
  input?: ReactNode;
  /** Absolute overlay anchored to the shell (slash / mention menus). */
  overlay?: ReactNode;
  /** Send receipt or other feedback rendered below the toolbar. */
  status?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Extra key handling before the send shortcut. Return true to stop. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean | void;
  /** Use Enter to send while preserving Shift+Enter for a line break. */
  sendOnEnter?: boolean;
  onSelect?: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  density?: MessageComposerDensity;
  /** Use `div` when nested inside an outer form. */
  as?: "form" | "div";
  className?: string;
  rows?: number;
  autoResize?: boolean;
  maxHeightPx?: number;
  "aria-label"?: string;
};

/**
 * Standardized Send glyph — upright arrow.
 * Use this anywhere a composer primary Send appears (not a paper plane).
 */
export function MessageComposerSendIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function AgentStopIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function AttachIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05 12.05 20.44a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48" />
    </svg>
  );
}

function resizeTextarea(el: HTMLTextAreaElement, maxHeightPx: number) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, maxHeightPx)}px`;
}

function voiceLabel(status: MicStatus): string {
  if (status.tone === "error") return "Voice";
  if (status.state === "recording") return "Listening";
  if (status.state === "processing") return "Transcribing";
  if (status.state === "starting") return "Starting";
  return "Voice";
}

/**
 * Classic message composer — sandwich layout.
 *
 * 1. Header — reply / annotation decoration (optional)
 * 2. Body — message input; live dictation partials appear here
 * 3. Toolbar — attach (left) · tools/model · mic · Send (right)
 *
 * Mic only starts/stops recording. Final transcript lands in the draft so
 * the operator can edit, then hit Send — or hit Send anytime the draft is
 * ready. Send never stops the mic; the mic never sends.
 */
export function MessageComposer({
  renderWhenEmbedded = false,
  ...props
}: MessageComposerProps) {
  const embedded = useMessageComposerEmbedded();
  if (embedded && !renderWhenEmbedded) return null;
  return <MessageComposerControl {...props} />;
}

function MessageComposerControl({
  value,
  onChange,
  onSend,
  placeholder = "Type a message…",
  disabled = false,
  sending = false,
  canSend,
  stopMode = false,
  onStop,
  sendTitle = "Send (Cmd+Enter)",
  sendAriaLabel = "Send message (Cmd+Enter)",
  stopAriaLabel = "Stop agent",
  showDictation = true,
  onDictationStatusChange,
  showAttach = false,
  onAttach,
  attachTitle = "Add attachment",
  attachAriaLabel = "Add attachment",
  onPaste,
  dropHandlers,
  dragActive = false,
  secondaryAction,
  leadingTools,
  tools,
  footer,
  header,
  above,
  aboveAttached = false,
  input,
  overlay,
  status,
  textareaRef,
  onKeyDown,
  sendOnEnter = false,
  onSelect,
  onBlur,
  density = "panel",
  as = "form",
  className,
  rows = 1,
  autoResize = true,
  maxHeightPx = 160,
  "aria-label": ariaLabel = "Message",
}: Omit<MessageComposerProps, "renderWhenEmbedded">) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<MicStatus | null>(null);

  const setTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node;
      if (textareaRef) {
        (textareaRef as { current: HTMLTextAreaElement | null }).current = node;
      }
    },
    [textareaRef],
  );

  useEffect(() => {
    if (!autoResize) return;
    const el = localRef.current;
    if (!el) return;
    resizeTextarea(el, maxHeightPx);
  }, [value, autoResize, maxHeightPx]);

  const sendEnabled = (canSend ?? value.trim().length > 0) && !sending && !disabled;
  const toolsSlot = tools ?? footer;
  const recording = voiceStatus?.state === "recording" || voiceStatus?.state === "starting";
  const processing = voiceStatus?.state === "processing";
  const showVoiceLine = Boolean(
    voiceStatus
    && (
      voiceStatus.tone === "error"
      || recording
      || processing
      || (voiceStatus.partial && voiceStatus.partial.trim())
    ),
  );

  const trySend = useCallback(() => {
    // Send always means commit the draft — independent of mic state.
    if (stopMode) return;
    if (!(canSend ?? value.trim().length > 0) || sending || disabled) return;
    onSend();
  }, [canSend, disabled, onSend, sending, stopMode, value]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    trySend();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Suggestion menus must get first refusal on plain Enter / Tab. Modified
    // send shortcuts still fall through when the menu handler returns false.
    if (onKeyDown?.(event)) {
      event.preventDefault();
      return;
    }
    if (isComposerSendShortcut(event, sendOnEnter)) {
      event.preventDefault();
      trySend();
      return;
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    onChange(next, { caret: event.target.selectionStart ?? next.length });
    if (autoResize) {
      resizeTextarea(event.target, maxHeightPx);
    }
  };

  const handleDictationAppend = (text: string) => {
    // Final transcript lands in the draft so the operator can edit before Send.
    const next = value.trim() ? `${value.trimEnd()} ${text}` : text;
    onChange(next, { caret: next.length });
    // Focus the field after stop so editing is immediate.
    requestAnimationFrame(() => localRef.current?.focus());
  };

  const handleDictationStatus = useCallback((next: MicStatus) => {
    setVoiceStatus(next);
    onDictationStatusChange?.(next);
  }, [onDictationStatusChange]);

  const rootClass = [
    "s-msg-compose",
    `s-msg-compose--${density}`,
    density === "thread" ? "s-thread-compose" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const shellClass = [
    "s-msg-compose-shell",
    density === "thread" ? "s-thread-compose-shell" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const inputClass = [
    "s-msg-compose-input",
    density === "thread" ? "s-thread-compose-input" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const sendClass = [
    "s-msg-compose-send",
    density === "thread" ? "s-thread-compose-send" : "",
    stopMode ? "s-msg-compose-send--agent-stop s-thread-compose-send--stop" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const voiceClass = [
    "s-msg-compose-voice",
    voiceStatus?.tone === "recording" || recording
      ? "s-msg-compose-voice--recording"
      : "",
    voiceStatus?.tone === "processing" || processing
      ? "s-msg-compose-voice--processing"
      : "",
    voiceStatus?.tone === "error" ? "s-msg-compose-voice--error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const isError = voiceStatus?.tone === "error";
  const partialText = voiceStatus?.partial?.trim() || null;
  const statusCopy = isError
    ? voiceStatus?.message
    : processing
      ? "Finalizing transcript…"
      : partialText;

  const shell = (
    <div
      className={shellClass}
      data-drag-active={dragActive ? "true" : undefined}
      {...dropHandlers}
    >
      {header ? <div className="s-msg-compose-header">{header}</div> : null}

      <div className="s-msg-compose-body">
        {input ?? (
          <textarea
            ref={setTextareaRef}
            className={inputClass}
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            rows={rows}
            aria-label={ariaLabel}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={onSelect}
            onBlur={onBlur}
            onPaste={onPaste}
          />
        )}

        {showVoiceLine ? (
          <div
            className={voiceClass}
            role={isError ? "alert" : "status"}
            aria-live={isError ? "assertive" : "polite"}
          >
            {/* Waveform owns the horizontal band while live; toolbar stays free. */}
            {!isError && (recording || processing) ? (
              <VoiceWaveform
                samples={voiceStatus?.levels}
                active={recording}
                processing={processing}
              />
            ) : null}
            <div className="s-msg-compose-voice-meta">
              <span className="s-msg-compose-voice-label">
                {voiceStatus ? voiceLabel(voiceStatus) : "Voice"}
              </span>
              {statusCopy ? (
                <span className="s-msg-compose-voice-text">{statusCopy}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div
        className={[
          "s-msg-compose-toolbar",
          density === "thread" ? "s-thread-compose-footer" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Left: contextual tools, then attach when the surface supports it. */}
        <div className="s-msg-compose-toolbar-start">
          {leadingTools}
          {showAttach ? (
            <button
              type="button"
              className="s-msg-compose-icon-btn"
              title={attachTitle}
              aria-label={attachAriaLabel}
              disabled={disabled || sending}
              onClick={onAttach}
            >
              <AttachIcon />
            </button>
          ) : !leadingTools ? (
            <span className="s-msg-compose-toolbar-spacer" aria-hidden="true" />
          ) : null}
        </div>

        {/* Right: model/tools · mic · Send (flush end) */}
        <div className="s-msg-compose-toolbar-end">
          {toolsSlot ? (
            <div className="s-msg-compose-tools">{toolsSlot}</div>
          ) : null}

          {showDictation ? (
            <DictationMic
              onAppend={handleDictationAppend}
              onStatus={handleDictationStatus}
              disabled={disabled || sending}
            />
          ) : null}

          {secondaryAction ? (
            <div className="s-msg-compose-secondary">{secondaryAction}</div>
          ) : null}

          {stopMode ? (
            <button
              type="button"
              className={sendClass}
              onClick={onStop}
              title={stopAriaLabel}
              aria-label={stopAriaLabel}
            >
              <AgentStopIcon />
            </button>
          ) : (
            <button
              type={as === "form" ? "submit" : "button"}
              className={sendClass}
              disabled={!sendEnabled}
              title={sendTitle}
              aria-label={sendAriaLabel}
              data-action="send"
              onClick={as === "div" ? () => trySend() : undefined}
            >
              <MessageComposerSendIcon />
            </button>
          )}
        </div>
      </div>

      {status}
    </div>
  );

  // Menus must be siblings of the clipped shell. Keeping them inside the shell
  // makes an overlay positioned above the composer fully invisible because the
  // rounded composer clips its contents.
  const content = (
    <div
      className="s-msg-compose-frame"
      data-above-attached={above && aboveAttached ? "true" : undefined}
    >
      {overlay}
      {above ? <div className="s-msg-compose-above">{above}</div> : null}
      {shell}
    </div>
  );

  if (as === "div") {
    return <div className={rootClass}>{content}</div>;
  }

  return (
    <form className={rootClass} onSubmit={handleSubmit}>
      {content}
    </form>
  );
}
