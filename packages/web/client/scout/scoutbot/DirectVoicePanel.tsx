import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Mic,
  Plus,
  Settings2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { stripScoutbotUiFences } from "../../lib/scoutbot.ts";
import { ScoutbotMarkdown } from "../../lib/scoutbot-markdown.tsx";
import type { ScoutVoiceSessionState } from "../../lib/scout-voice.ts";
import {
  VoiceControlWell,
  localLiveWellSpec,
} from "../../screens/voice/VoiceControlWell.tsx";
import type {
  ScoutbotAssistantMessage,
  VoiceProbeState,
} from "./scoutbot-model.ts";
import type { ScoutbotSpeechIdentity } from "./scoutbot-voice-profiles.ts";
import "./direct-voice.css";

type DirectVoicePanelProps = {
  messages: ScoutbotAssistantMessage[];
  pendingAsk: string | null;
  partial: string;
  error: string | null;
  status: string | null;
  recording: boolean;
  sending: boolean;
  speaking: boolean;
  voiceAvailable: boolean | null;
  voiceInputSource: string | null;
  voiceProbeState: VoiceProbeState;
  voiceState: ScoutVoiceSessionState | null;
  voiceReplies: boolean;
  settingsOpen: boolean;
  setupPanel: ReactNode;
  settingsPanel: ReactNode;
  assistantModel: string | null;
  speechIdentity?: ScoutbotSpeechIdentity | null;
  onPrimaryAction: () => void;
  onToggleVoiceReplies: () => void;
  onToggleSettings: () => void;
  onNewChat: () => void;
  /** Drops the in-flight take without sending it (the mic gate while recording). */
  onDiscardTake?: () => void;
  onOpenLive?: () => void;
  /** Set false when the surrounding page already owns the voice mode switch. */
  showModeSwitch?: boolean;
  /** Set false when the surrounding page already owns the title. */
  showHeading?: boolean;
  /** Set false when the surrounding page draws the turn instead of the transcript column. */
  showTranscript?: boolean;
  /** Header title; defaults to "Local Live". */
  title?: string;
  /** Reports the resolved turn phase as it changes (listening, thinking, …). */
  onVoicePhaseChange?: (phase: DirectVoicePhase) => void;
};

export type DirectVoicePhase =
  | "checking"
  | "unavailable"
  | "listening"
  | "processing"
  | "thinking"
  | "speaking"
  | "ready";

/* The room's palette lives in direct-voice.css as the .dvp-room token set:
   paper in light mode, the hue-260 control room in dark. The panel reads
   vars only, so the theme swap is a cascade, not a re-render. */

const WAVEFORM_AMPLITUDES = [
  2, 4, 7, 5, 3, 6, 9, 5, 3, 4, 8, 6,
  3, 5, 9, 6, 3, 5, 7, 4, 2, 4, 6, 3,
] as const;

const WAVEFORM_SEGMENTS = WAVEFORM_AMPLITUDES.map((amplitude, index) => {
  const angle = (index / WAVEFORM_AMPLITUDES.length) * Math.PI * 2 - Math.PI / 2;
  const inner = 24 - amplitude / 2;
  const outer = 24 + amplitude / 2;
  return {
    x1: 36 + Math.cos(angle) * inner,
    y1: 36 + Math.sin(angle) * inner,
    x2: 36 + Math.cos(angle) * outer,
    y2: 36 + Math.sin(angle) * outer,
  };
});

function resolvePhase({
  recording,
  sending,
  speaking,
  voiceAvailable,
  voiceProbeState,
  voiceState,
}: Pick<
  DirectVoicePanelProps,
  | "recording"
  | "sending"
  | "speaking"
  | "voiceAvailable"
  | "voiceProbeState"
  | "voiceState"
>): DirectVoicePhase {
  if (speaking) return "speaking";
  if (sending) return "thinking";
  if (recording && voiceState === "processing") return "processing";
  if (recording) return "listening";
  if (voiceProbeState !== "idle" || voiceState === "starting" || voiceAvailable === null) return "checking";
  if (voiceAvailable === false) return "unavailable";
  return "ready";
}

const PHASE_COPY: Record<DirectVoicePhase, { label: string; helper: string }> = {
  checking: {
    label: "Getting voice ready",
    helper: "Checking your microphone and speech services",
  },
  unavailable: {
    label: "Voice is offline",
    helper: "Tap to reconnect",
  },
  listening: {
    label: "Listening",
    helper: "Tap to finish your turn",
  },
  processing: {
    label: "Transcribing",
    helper: "Turning speech into text",
  },
  thinking: {
    label: "Scout is thinking",
    helper: "Your turn is in",
  },
  speaking: {
    label: "Scout is speaking",
    helper: "Tap to interrupt",
  },
  ready: {
    label: "Ready to listen",
    helper: "Tap to speak",
  },
};

function primaryLabel(phase: DirectVoicePhase): string {
  switch (phase) {
    case "listening":
      return "Finish and send voice turn";
    case "speaking":
      return "Stop spoken reply";
    case "unavailable":
      return "Retry voice connection";
    case "checking":
      return "Checking voice";
    case "processing":
      return "Cancel turn";
    case "thinking":
      return "Cancel turn";
    case "ready":
      return "Start voice turn";
  }
}

function activeStage(phase: DirectVoicePhase): "listen" | "think" | "speak" | null {
  if (phase === "listening" || phase === "processing") return "listen";
  if (phase === "thinking") return "think";
  if (phase === "speaking") return "speak";
  return null;
}

function VoiceControl({
  phase,
  disabled,
  onClick,
}: {
  phase: DirectVoicePhase;
  disabled: boolean;
  onClick: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const active = phase === "listening" || phase === "speaking";
  const actionLabel = primaryLabel(phase);

  return (
    <motion.div
      animate={active && !reduceMotion ? { scale: [1, 1.025, 1] } : { scale: 1 }}
      transition={active && !reduceMotion
        ? { duration: 2.2, ease: "easeInOut", repeat: Infinity }
        : { duration: 0.18 }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={actionLabel}
        title={actionLabel}
        className="group grid h-28 w-28 place-items-center rounded-full border border-[var(--dvp-dial-border)] bg-[var(--dvp-dial-bg)] text-[var(--dvp-dial-ink)] shadow-[var(--dvp-dial-shadow)] outline-none transition-[border-color,box-shadow,transform] duration-200 hover:border-[var(--dvp-dial-border-hover)] hover:shadow-[var(--dvp-dial-shadow-hover)] focus-visible:ring-2 focus-visible:ring-[var(--dvp-focus)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--dvp-bg)] active:scale-[0.98] disabled:cursor-wait disabled:opacity-65"
      >
        <svg viewBox="0 0 72 72" className="h-[72px] w-[72px]" aria-hidden="true">
          <circle cx={36} cy={36} r={24} fill="none" stroke="var(--dvp-ring)" strokeWidth={0.8} />
          {WAVEFORM_SEGMENTS.map((segment, index) => (
            <line
              key={index}
              x1={segment.x1}
              y1={segment.y1}
              x2={segment.x2}
              y2={segment.y2}
              stroke={active ? "var(--dvp-wave-active)" : "var(--dvp-wave)"}
              strokeWidth="1.15"
              strokeLinecap="round"
            />
          ))}
          <circle cx={36} cy={36} r={7.5} fill={active ? "var(--dvp-orb-active)" : "var(--dvp-orb)"} />
        </svg>
      </button>
    </motion.div>
  );
}

const TURN_STAGES = [
  { id: "listen", label: "Listen" },
  { id: "think", label: "Think" },
  { id: "speak", label: "Speak" },
] as const;

export function DirectVoicePanel({
  messages,
  pendingAsk,
  partial,
  error,
  status,
  recording,
  sending,
  speaking,
  voiceAvailable,
  voiceInputSource,
  voiceProbeState,
  voiceState,
  voiceReplies,
  settingsOpen,
  setupPanel,
  settingsPanel,
  assistantModel,
  speechIdentity,
  onPrimaryAction,
  onToggleVoiceReplies,
  onToggleSettings,
  onNewChat,
  onDiscardTake,
  onOpenLive,
  showModeSwitch = true,
  showHeading = true,
  showTranscript = true,
  title = "Direct Voice",
  onVoicePhaseChange,
}: DirectVoicePanelProps) {
  const reduceMotion = useReducedMotion();
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const phase = resolvePhase({
    recording,
    sending,
    speaking,
    voiceAvailable,
    voiceProbeState,
    voiceState,
  });
  const copy = PHASE_COPY[phase];
  const busy = phase === "checking";
  const inputSourceLabel = voiceAvailable === false
    ? "No microphone available"
    : voiceInputSource ?? (voiceAvailable === true
      ? "Default input from Scout Menu"
      : "Checking microphone…");
  const recentMessages = messages.slice(-12);
  const activeTurn = partial || (sending && recentMessages.at(-1)?.body !== pendingAsk ? pendingAsk : null);
  const empty = recentMessages.length === 0 && !activeTurn;
  const currentStage = activeStage(phase);
  const modelLabel = assistantModel?.trim() || "Turn-based voice";
  const statusDot = phase === "unavailable"
    ? "bg-[var(--dvp-dot-off)]"
    : phase === "ready" || phase === "checking"
      ? "bg-[var(--dvp-dot-idle)]"
      : "bg-[var(--dvp-accent)]";
  const [recordStartedAt, setRecordStartedAt] = useState<number | null>(null);
  const [recordElapsedMs, setRecordElapsedMs] = useState(0);

  useEffect(() => {
    if (!recording) {
      setRecordStartedAt(null);
      setRecordElapsedMs(0);
      return;
    }
    const started = Date.now();
    setRecordStartedAt(started);
    const tick = window.setInterval(() => setRecordElapsedMs(Date.now() - started), 100);
    return () => window.clearInterval(tick);
  }, [recording]);

  const recordingClock = recording && recordStartedAt !== null
    ? `${(recordElapsedMs / 1000).toFixed(1)}s`
    : undefined;
  const wellSpec = showTranscript
    ? null
    : localLiveWellSpec({
        phase,
        voiceReplies,
        inputLabel: inputSourceLabel,
        inputWarn: voiceAvailable === false,
        speechIdentity: speechIdentity ?? null,
        assistantModel,
        recordingClock,
      });
  const wellLayout = phase === "listening" || phase === "processing" || phase === "thinking" || phase === "speaking"
    ? "row"
    : "card";
  const handleWellFlag = (key: string) => {
    if (key === "mic") {
      onDiscardTake?.();
    } else if (key === "speaker") {
      onToggleVoiceReplies();
    }
  };
  const handleWellTail = (key: "new-chat" | "settings") => {
    if (key === "new-chat") {
      onNewChat();
    } else {
      onToggleSettings();
    }
  };

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, pendingAsk]);

  useEffect(() => {
    onVoicePhaseChange?.(phase);
  }, [onVoicePhaseChange, phase]);

  return (
    <section
      className={`dvp-room relative flex min-h-0 w-full flex-col bg-[var(--dvp-bg)] text-[var(--dvp-ink)] ${showTranscript ? "h-full overflow-hidden" : "dvp-room--instrument overflow-visible"}`}
      aria-label={`${title} conversation`}
    >
      {(showHeading || showTranscript) && (
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--dvp-border)] px-3 py-2.5 sm:gap-4 sm:px-7">
        {showHeading ? (
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate font-[var(--font-accent-title)] text-sm font-semibold tracking-[-0.018em] text-[var(--dvp-heading)] sm:text-base">
            {title}
          </h1>
          <span className="hidden h-4 w-px bg-[var(--dvp-divider)] sm:block" aria-hidden="true" />
          <div className="hidden min-w-0 items-center gap-2 sm:flex" aria-live="polite">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot}`} aria-hidden="true" />
            <span className="truncate text-xs text-[var(--dvp-muted)]">{copy.label}</span>
          </div>
        </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {showModeSwitch && (
          <div
            className="flex rounded-md border border-[var(--dvp-switch-border)] bg-[var(--dvp-switch-bg)] p-0.5"
            role="tablist"
            aria-label="Voice mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected="true"
              className="rounded-[4px] bg-[var(--dvp-switch-active-bg)] px-2 py-1.5 text-[11px] font-medium text-[var(--dvp-switch-active-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.14)] sm:px-3"
            >
              Local
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="false"
              onClick={onOpenLive}
              disabled={!onOpenLive}
              className="rounded-[4px] px-2 py-1.5 text-[11px] font-medium text-[var(--dvp-switch-idle)] transition-colors hover:bg-[var(--dvp-switch-hover)] hover:text-[var(--dvp-heading)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dvp-focus)] disabled:cursor-default disabled:opacity-45 sm:px-3"
            >
              Live
            </button>
          </div>
          )}

          <button
            type="button"
            onClick={onNewChat}
            className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--dvp-btn)] transition-colors hover:bg-[var(--dvp-hover)] hover:text-[var(--dvp-btn-hover-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dvp-focus)] min-[430px]:flex sm:px-2.5"
            aria-label="Start a new voice conversation"
            title="New conversation"
          >
            <Plus size={14} aria-hidden="true" />
            <span className="hidden md:inline">New chat</span>
          </button>
          <button
            type="button"
            onClick={onToggleVoiceReplies}
            className={`grid h-8 w-8 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dvp-focus)] ${
              voiceReplies
                ? "bg-[var(--dvp-switch-active-bg)] text-[var(--dvp-switch-active-ink)]"
                : "text-[var(--dvp-btn)] hover:bg-[var(--dvp-hover)] hover:text-[var(--dvp-btn-hover-ink)]"
            }`}
            aria-pressed={voiceReplies}
            aria-label={voiceReplies ? "Mute spoken replies" : "Enable spoken replies"}
            title={voiceReplies ? "Spoken replies on" : "Spoken replies off"}
          >
            {voiceReplies ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
          <button
            type="button"
            onClick={onToggleSettings}
            className={`grid h-8 w-8 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dvp-focus)] ${
              settingsOpen
                ? "bg-[var(--dvp-accent-soft)] text-[var(--dvp-accent-ink)]"
                : "text-[var(--dvp-btn)] hover:bg-[var(--dvp-hover)] hover:text-[var(--dvp-btn-hover-ink)]"
            }`}
            aria-expanded={settingsOpen}
            aria-label="Voice and Scoutbot settings"
            title="Voice and Scoutbot settings"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </header>
      )}

      {showTranscript ? (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col px-6 py-8 sm:px-10 sm:py-10 lg:px-14">
          <div className="w-full max-w-[720px]">
            {empty ? (
              <div className="pt-1">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--dvp-meta-dim)]">
                  Conversation
                </p>
                <p className="mt-2 max-w-[38ch] text-sm leading-6 text-[var(--dvp-muted)]">
                  Your voice turns and Scout’s replies will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-8 sm:space-y-9">
                {recentMessages.map((message) => {
                  const fromScout = message.role === "assistant";
                  return (
                    <article key={message.id} className="max-w-[68ch]">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--dvp-meta)]">
                          {fromScout ? "Scout" : "You"}
                        </span>
                        {fromScout && (
                          <span className="text-[10px] text-[var(--dvp-meta-dim)]">{modelLabel}</span>
                        )}
                      </div>
                      {fromScout ? (
                        <div className="dvp-markdown mt-1.5 text-sm leading-6 text-[var(--dvp-body)] sm:text-base sm:leading-7">
                          <ScoutbotMarkdown text={stripScoutbotUiFences(message.body)} />
                        </div>
                      ) : (
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-[var(--dvp-body)] sm:text-base sm:leading-7">
                          {message.body}
                        </p>
                      )}
                    </article>
                  );
                })}

                {activeTurn && (
                  <article className="max-w-[68ch]" aria-live="polite">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--dvp-accent-ink)]">
                        You
                      </span>
                      <span className="text-[10px] text-[var(--dvp-you-meta)]">
                        {partial ? "Listening" : "Sending"}
                      </span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-[var(--dvp-body)] sm:text-base sm:leading-7">
                      {activeTurn}
                    </p>
                  </article>
                )}
              </div>
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>
      ) : null}

      <AnimatePresence initial={false}>
        {(setupPanel || settingsOpen || (error && showTranscript)) && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 6 }}
            className="max-h-[34vh] shrink-0 overflow-y-auto border-y border-[var(--dvp-border)] bg-[var(--dvp-well)]"
          >
            <div className="mx-auto w-full max-w-[880px] px-6 py-4 sm:px-10 lg:px-14">
              {error && showTranscript && (
                <p className="mb-3 text-sm leading-6 text-[var(--dvp-error)]">{error}</p>
              )}
              {setupPanel}
              {settingsOpen && settingsPanel}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={!showTranscript ? "dvp-instrument-stage" : `shrink-0 px-5 pb-4 pt-3 sm:px-8 sm:pb-5`}>
        {!showTranscript && wellSpec ? (
          <>
            <VoiceControlWell
              spec={wellSpec}
              layout={wellLayout}
              onCta={onPrimaryAction}
              onFlag={handleWellFlag}
              onTail={handleWellTail}
            />
            {error && <p className="dvp-instrument-error">{error}</p>}
          </>
        ) : (
        <>
        <div className="flex flex-col items-center text-center">
          <VoiceControl phase={phase} disabled={busy} onClick={onPrimaryAction} />
          <div className="mt-3" aria-live="polite">
            <p className="text-sm font-semibold text-[var(--dvp-phase)]">{copy.label}</p>
            <p className="mt-0.5 text-xs text-[var(--dvp-helper)]">{copy.helper}</p>
          </div>
        </div>

        {showTranscript && (
        <footer className="mx-auto mt-4 flex w-full max-w-[880px] flex-col items-stretch justify-between gap-2 border-t border-[var(--dvp-border)] pt-3 text-[11px] text-[var(--dvp-footer)] sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <Mic size={12} className="shrink-0 text-[var(--dvp-mic-icon)]" aria-hidden="true" />
            <span className="truncate">Input: {inputSourceLabel}</span>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-start" aria-label={`Voice turn state: ${copy.label}`}>
            {TURN_STAGES.map((stage) => {
              const active = currentStage === stage.id;
              return (
                <span
                  key={stage.id}
                  className={active ? "font-medium text-[var(--dvp-stage-active)]" : "text-[var(--dvp-stage-dim)]"}
                  aria-current={active ? "step" : undefined}
                >
                  {stage.label}
                </span>
              );
            })}
          </div>
          {status && !sending && phase !== "listening" && (
            <span className="hidden max-w-48 truncate text-right text-[var(--dvp-stage-dim)] lg:block">{status}</span>
          )}
        </footer>
        )}
        </>
        )}
      </div>
    </section>
  );
}
