import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Mic,
  Plus,
  Settings2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { stripScoutbotUiFences } from "../../lib/scoutbot.ts";
import type { ScoutVoiceSessionState } from "../../lib/scout-voice.ts";
import type {
  ScoutbotAssistantMessage,
  VoiceProbeState,
} from "./scoutbot-model.ts";

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
  onPrimaryAction: () => void;
  onToggleVoiceReplies: () => void;
  onToggleSettings: () => void;
  onNewChat: () => void;
  onOpenLive?: () => void;
};

type DirectVoicePhase =
  | "checking"
  | "unavailable"
  | "listening"
  | "processing"
  | "thinking"
  | "speaking"
  | "ready";

const DIRECT_VOICE_THEME = {
  "--scout-chrome-bg": "#f3f0e9",
  "--scout-chrome-ink": "#2a2d2f",
  "--scout-chrome-ink-strong": "#171a1c",
  "--scout-chrome-ink-faint": "#6f716e",
  "--scout-chrome-ink-ghost": "#9b9a94",
  "--scout-chrome-border-soft": "#d9d4ca",
  "--scout-chrome-hover": "#e9e5dc",
  "--scout-chrome-active": "#ded8cc",
  "--scout-accent": "#b58a3f",
} as CSSProperties;

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
      return "Transcribing voice turn";
    case "thinking":
      return "Scout is thinking";
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
        className="group grid h-28 w-28 place-items-center rounded-full border border-[#d4cfc5] bg-white text-[#232729] shadow-[0_14px_34px_rgba(55,48,38,0.12)] outline-none transition-[border-color,box-shadow,transform] duration-200 hover:border-[#b9b2a6] hover:shadow-[0_17px_38px_rgba(55,48,38,0.16)] focus-visible:ring-2 focus-visible:ring-[#9c7736] focus-visible:ring-offset-4 focus-visible:ring-offset-[#f3f0e9] active:scale-[0.98] disabled:cursor-wait disabled:opacity-65"
      >
        <svg viewBox="0 0 72 72" className="h-[72px] w-[72px]" aria-hidden="true">
          <circle cx="36" cy="36" r="24" fill="none" stroke="#d2cec6" strokeWidth="0.8" />
          {WAVEFORM_SEGMENTS.map((segment, index) => (
            <line
              key={index}
              x1={segment.x1}
              y1={segment.y1}
              x2={segment.x2}
              y2={segment.y2}
              stroke={active ? "#817b71" : "#a5a198"}
              strokeWidth="1.15"
              strokeLinecap="round"
            />
          ))}
          <circle cx="36" cy="36" r="7.5" fill={active ? "#b98a3b" : "#d3b16d"} />
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
  onPrimaryAction,
  onToggleVoiceReplies,
  onToggleSettings,
  onNewChat,
  onOpenLive,
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
  const busy = phase === "checking" || phase === "processing" || phase === "thinking";
  const inputSourceLabel = voiceInputSource
    ?? (voiceAvailable === true ? "Default input from Scout Menu" : "Checking microphone…");
  const recentMessages = messages.slice(-12);
  const activeTurn = partial || (sending && recentMessages.at(-1)?.body !== pendingAsk ? pendingAsk : null);
  const empty = recentMessages.length === 0 && !activeTurn;
  const currentStage = activeStage(phase);
  const modelLabel = assistantModel?.trim() || "Turn-based voice";
  const micLabel = voiceAvailable === false
    ? "Mic offline"
    : voiceAvailable === null
      ? "Checking mic"
      : "Mic active";
  const statusDot = phase === "unavailable"
    ? "bg-[#a25549]"
    : phase === "ready" || phase === "checking"
      ? "bg-[#a7a49d]"
      : "bg-[#b58a3f]";

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, pendingAsk]);

  return (
    <section
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#f3f0e9] text-[#2a2d2f]"
      style={DIRECT_VOICE_THEME}
      aria-label="Direct voice conversation"
    >
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-[#d9d4ca] px-3 py-2.5 sm:gap-4 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate font-[var(--font-accent-title)] text-[15px] font-semibold tracking-[-0.018em] text-[#171a1c] sm:text-[17px]">
            Direct Voice
          </h1>
          <span className="hidden h-4 w-px bg-[#d6d1c7] sm:block" aria-hidden="true" />
          <div className="hidden min-w-0 items-center gap-2 sm:flex" aria-live="polite">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot}`} aria-hidden="true" />
            <span className="truncate text-xs text-[#6f716e]">{copy.label}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <div
            className="flex rounded-md border border-[#cbc5ba] bg-[#e8e3da] p-0.5"
            role="tablist"
            aria-label="Voice mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected="true"
              className="rounded-[4px] bg-[#202426] px-2 py-1.5 text-[11px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.14)] sm:px-3"
            >
              Direct
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="false"
              onClick={onOpenLive}
              disabled={!onOpenLive}
              className="rounded-[4px] px-2 py-1.5 text-[11px] font-medium text-[#6a6c69] transition-colors hover:bg-white/65 hover:text-[#232628] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c7736] disabled:cursor-default disabled:opacity-45 sm:px-3"
            >
              Live
            </button>
          </div>

          <button
            type="button"
            onClick={onNewChat}
            className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[#4f5352] transition-colors hover:bg-[#e7e2d9] hover:text-[#191c1e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c7736] min-[430px]:flex sm:px-2.5"
            aria-label="Start a new voice conversation"
            title="New conversation"
          >
            <Plus size={14} aria-hidden="true" />
            <span className="hidden md:inline">New chat</span>
          </button>
          <button
            type="button"
            onClick={onToggleVoiceReplies}
            className={`grid h-8 w-8 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c7736] ${
              voiceReplies
                ? "bg-[#e1d5bd] text-[#765923]"
                : "text-[#6e706d] hover:bg-[#e7e2d9] hover:text-[#191c1e]"
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
            className={`grid h-8 w-8 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c7736] ${
              settingsOpen
                ? "bg-[#e1d5bd] text-[#765923]"
                : "text-[#6e706d] hover:bg-[#e7e2d9] hover:text-[#191c1e]"
            }`}
            aria-expanded={settingsOpen}
            aria-label="Voice and Scoutbot settings"
            title="Voice and Scoutbot settings"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col px-6 py-8 sm:px-10 sm:py-10 lg:px-14">
          <div className="w-full max-w-[720px]">
            {empty ? (
              <div className="pt-1">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b8983]">
                  Conversation
                </p>
                <p className="mt-2 max-w-[38ch] text-sm leading-6 text-[#737570]">
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
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#575a59]">
                          {fromScout ? "Scout" : "You"}
                        </span>
                        {fromScout && (
                          <span className="text-[10px] text-[#8a8983]">{modelLabel}</span>
                        )}
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-6 text-[#25292a] sm:text-base sm:leading-7">
                        {fromScout ? stripScoutbotUiFences(message.body) : message.body}
                      </p>
                    </article>
                  );
                })}

                {activeTurn && (
                  <article className="max-w-[68ch]" aria-live="polite">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#765923]">
                        You
                      </span>
                      <span className="text-[10px] text-[#9a7a40]">
                        {partial ? "Listening" : "Sending"}
                      </span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-6 text-[#25292a] sm:text-base sm:leading-7">
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

      <AnimatePresence initial={false}>
        {(setupPanel || settingsOpen || error) && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 6 }}
            className="max-h-[34vh] shrink-0 overflow-y-auto border-y border-[#d9d4ca] bg-[#eeeae2]"
          >
            <div className="mx-auto w-full max-w-[880px] px-6 py-4 sm:px-10 lg:px-14">
              {error && (
                <p className="mb-3 text-sm leading-6 text-[#93483f]">{error}</p>
              )}
              {setupPanel}
              {settingsOpen && settingsPanel}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="shrink-0 px-5 pb-4 pt-3 sm:px-8 sm:pb-5">
        <div className="flex flex-col items-center text-center">
          <VoiceControl phase={phase} disabled={busy} onClick={onPrimaryAction} />
          <div className="mt-3" aria-live="polite">
            <p className="text-sm font-semibold text-[#24282a]">{copy.label}</p>
            <p className="mt-0.5 text-xs text-[#7a7b76]">{copy.helper}</p>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[#7b6a49]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#b58a3f]" aria-hidden="true" />
            <span>{micLabel}</span>
          </div>
        </div>

        <footer className="mx-auto mt-4 flex w-full max-w-[880px] flex-col items-stretch justify-between gap-2 border-t border-[#d9d4ca] pt-3 text-[11px] text-[#747570] sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <Mic size={12} className="shrink-0 text-[#8b7350]" aria-hidden="true" />
            <span className="truncate">Input: {inputSourceLabel}</span>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-start" aria-label={`Voice turn state: ${copy.label}`}>
            {TURN_STAGES.map((stage) => {
              const active = currentStage === stage.id;
              return (
                <span
                  key={stage.id}
                  className={active ? "font-medium text-[#5e4821]" : "text-[#96948e]"}
                >
                  {stage.label}
                </span>
              );
            })}
          </div>
          {status && !sending && phase !== "listening" && (
            <span className="hidden max-w-48 truncate text-right text-[#96948e] lg:block">{status}</span>
          )}
        </footer>
      </div>
    </section>
  );
}
