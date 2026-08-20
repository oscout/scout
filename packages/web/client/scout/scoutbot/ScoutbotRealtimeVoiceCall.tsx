import { ChevronDown, History, ListTree, Loader2, Maximize2, Minimize2, Play, Plus, Radio, Settings2, Square } from "lucide-react";
import { useEffect, useState } from "react";

import { useScoutbotRealtimeVoice } from "./ScoutbotRealtimeVoiceContext.tsx";
import type { ScoutRealtimeVoiceTraceKind } from "../../lib/realtime-voice.ts";

// The live-call panel: durable Scoutbot chat selection, recent trace, and the
// start/end control. The audio connection is disposable; the selected chat is
// what preserves conversational context across calls.
//
// Shared on purpose. The web status bar wears it inside a popover; the macOS
// app mounts it directly through /embed/voice. A second copy would mean two
// consent checkboxes and two start buttons to keep honest.

// One plate, one hairline, one field.
//
// Stroke weight scales INVERSELY WITH STROKE LENGTH. A full-bleed rule at 9%
// ink carries several times the total ink of a 60px button outline at the same
// alpha, so uniform alpha makes the longest strokes shout — which is what made
// the panel read as a stack of white bars. The ladder now runs:
//
//   plates (longest perimeter)  no stroke at all — the fill alone bounds them
//   fields (medium, editable)   10% — needs to read as a place you can type
//   buttons/chips (shortest)    8%  — short enough to survive a faint edge
//
// Plates dropping their hairline is the load-bearing change: an ink fill
// already lifts the plate off the panel in both themes, so stroke+fill was
// belt-and-braces and the stroke was the half that shouted.
const PLATE = "rounded-lg bg-[color-mix(in_srgb,var(--hud-ink)_4.5%,transparent)]";
const FIELD = "rounded-md border border-[color-mix(in_srgb,var(--hud-ink)_10%,transparent)] bg-[color-mix(in_srgb,var(--hud-bg)_70%,transparent)] text-[var(--scout-chrome-ink-strong)] outline-none transition-colors focus:border-lime-300/45";
const QUIET_BUTTON = "rounded-md border border-[color-mix(in_srgb,var(--hud-ink)_8%,transparent)] text-[var(--scout-chrome-ink)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink-strong)] disabled:cursor-not-allowed disabled:opacity-40";
const EYEBROW = "font-mono text-xs uppercase tracking-[0.11em] text-[var(--scout-chrome-ink-ghost)]";

type SessionTone = {
  label: string;
  detail: string;
  chip: string;
  iconWrap: string;
};

export function sessionTone(state: string): SessionTone {
  if (state === "live") {
    return {
      label: "Live",
      detail: "Listening — speak naturally",
      chip: "border-lime-300/35 bg-lime-300/[0.10] text-lime-100",
      iconWrap: "border-lime-300/40 bg-lime-300/[0.10] text-lime-200",
    };
  }
  if (state === "connecting") {
    return {
      label: "Connecting",
      detail: "Opening secure audio…",
      chip: "border-amber-300/30 bg-amber-300/[0.09] text-amber-100/90",
      iconWrap: "border-amber-300/35 bg-amber-300/[0.09] text-amber-100",
    };
  }
  if (state === "error") {
    return {
      label: "Error",
      detail: "Could not hold the call",
      chip: "border-red-400/35 bg-red-400/[0.10] text-red-100",
      iconWrap: "border-red-400/35 bg-red-400/[0.10] text-red-100",
    };
  }
  if (state === "ended") {
    return {
      label: "Ended",
      detail: "Call closed — start again anytime",
      chip: "border-[color-mix(in_srgb,var(--hud-ink)_12%,transparent)] text-[var(--scout-chrome-ink-faint)]",
      iconWrap: "border-[color-mix(in_srgb,var(--hud-ink)_10%,transparent)] bg-[color-mix(in_srgb,var(--hud-ink)_4%,transparent)] text-[var(--scout-chrome-ink-faint)]",
    };
  }
  return {
    label: "Ready",
    detail: "Talk continuously with Scoutbot",
    /* Idle states bound with fill, not stroke — same rule as the plates. The
       lit states below keep their accent stroke, because there the border is
       carrying meaning rather than just drawing a box. */
    chip: "border-transparent bg-[color-mix(in_srgb,var(--hud-ink)_6%,transparent)] text-[var(--scout-chrome-ink-faint)]",
    iconWrap: "border-transparent bg-[color-mix(in_srgb,var(--hud-ink)_5%,transparent)] text-[var(--scout-chrome-ink-faint)]",
  };
}

export function ScoutbotRealtimeVoiceCallHeader({
  state,
  onMinimize,
  onExpand,
  layout = "compact",
}: {
  state: string;
  onMinimize?: () => void;
  onExpand?: () => void;
  layout?: "compact" | "page";
}) {
  const tone = sessionTone(state);
  const page = layout === "page";
  return (
    /* No rule under the header: the tab nav directly below carries its own,
       and two full-bleed rules ~40px apart is what read as stacked bars. The
       nav rule alone separates the header block. */
    <header className={`flex items-start ${page ? "gap-3.5 px-5 py-4" : "gap-2.5 px-3.5 py-3"}`}>
      <div className={`${page ? "size-9" : "size-7"} mt-px flex shrink-0 items-center justify-center rounded-md border ${tone.iconWrap}`}>
        {state === "connecting" ? (
          <Loader2 size={page ? 14 : 12} className="animate-spin" />
        ) : state === "live" ? (
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-lime-300/35" />
            <span className="relative inline-flex size-2 rounded-full bg-lime-300/90" />
          </span>
        ) : (
          <Radio size={page ? 14 : 12} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <h2 className={`truncate font-medium text-[var(--scout-chrome-ink-strong)] ${page ? "text-2xl" : "text-base"}`}>
            Live voice
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            <span className={`rounded border px-1.5 py-px font-mono text-xs uppercase tracking-[0.1em] ${tone.chip}`}>
              {tone.label}
            </span>
            {onExpand && (
              <button
                type="button"
                onClick={onExpand}
                title={page ? "Return to compact live voice view" : "Open full live voice view"}
                aria-label={page ? "Return to compact live voice view" : "Open full live voice view"}
                className="flex size-6 items-center justify-center rounded-md text-[var(--scout-chrome-ink-faint)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink-strong)]"
              >
                {page ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            )}
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                title="Collapse live voice into the status bar"
                aria-label="Collapse live voice into the status bar"
                className="flex size-6 items-center justify-center rounded-md text-[var(--scout-chrome-ink-faint)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink-strong)]"
              >
                <ChevronDown size={12} />
              </button>
            )}
          </div>
        </div>
        <p className={`mt-0.5 leading-snug text-[var(--scout-chrome-ink-faint)] ${page ? "text-base" : "text-sm"}`}>
          {tone.detail}
        </p>
      </div>
    </header>
  );
}

export function ScoutbotRealtimeVoiceCall({
  dictationActive,
  layout = "compact",
}: {
  dictationActive: boolean;
  layout?: "compact" | "page";
}) {
  const {
    state,
    error,
    trace,
    chatState,
    sessionAction,
    startCall,
    endCall,
    startNewChat,
    switchChat,
    updatePreferredModel,
    clearTrace,
    openVoiceSettings,
  } = useScoutbotRealtimeVoice();
  const active = state === "connecting" || state === "live";
  const [view, setView] = useState<"controls" | "activity">("controls");
  const visibleError = friendlyVoiceError(error);
  const page = layout === "page";
  const [modelDraft, setModelDraft] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelStatus, setModelStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!modelSaving && chatState?.config.model) setModelDraft(chatState.config.model);
  }, [chatState?.config.model, modelSaving]);

  const savePreferredModel = async () => {
    if (!modelDraft.trim() || modelSaving) return;
    setModelSaving(true);
    setModelStatus(null);
    try {
      const model = await updatePreferredModel(modelDraft);
      setModelDraft(model);
      setModelStatus("Saved");
    } catch (caught) {
      setModelStatus(caught instanceof Error ? caught.message : "Could not save model.");
    } finally {
      setModelSaving(false);
    }
  };

  // One control for the call, not a switch plus a second stop button below it.
  // The label carries the state, so the primary action never moves or
  // duplicates itself as the call progresses.
  const callAction = state === "connecting"
    ? {
      label: "Cancel connection",
      icon: <Loader2 size={11} className="animate-spin" />,
      tone: "border-amber-300/35 bg-amber-300/[0.10] text-amber-100 hover:bg-amber-300/[0.16]",
    }
    : state === "live"
      ? {
        label: "End live voice",
        icon: <Square size={9} className="fill-current" />,
        tone: "border-red-400/35 bg-red-400/[0.10] text-red-100 hover:bg-red-400/[0.16]",
      }
      : {
        label: "Start live voice",
        icon: <Play size={10} className="fill-current" />,
        tone: "border-lime-300/40 bg-lime-300/[0.12] text-lime-100 hover:bg-lime-300/[0.18]",
      };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className={`grid shrink-0 grid-cols-2 border-b border-[var(--scout-chrome-border-soft)] ${page ? "px-5" : "px-3.5"}`} aria-label="Live voice views">
        {([
          { id: "controls", label: "Controls", icon: <Radio size={11} /> },
          { id: "activity", label: "Activity", icon: <ListTree size={11} /> },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setView(tab.id)}
            aria-current={view === tab.id}
            className={`-mb-px flex items-center justify-center gap-1.5 border-b-2 font-mono uppercase tracking-[0.1em] transition-colors ${page ? "h-11 text-sm" : "h-9 text-xs"} ${
              view === tab.id
                ? "border-lime-300/80 text-[var(--scout-chrome-ink-strong)]"
                : "border-transparent text-[var(--scout-chrome-ink-faint)] hover:text-[var(--scout-chrome-ink-strong)]"
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.id === "activity" && trace.length > 0 && (
              <span className="rounded-full bg-[color-mix(in_srgb,var(--hud-ink)_10%,transparent)] px-1.5 py-px font-mono text-xs text-[var(--scout-chrome-ink-faint)]">
                {trace.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {view === "activity" ? (
        <div className={`flex min-h-0 flex-1 flex-col ${page ? "p-5" : "p-3.5"}`}>
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <p className={EYEBROW}>Session activity</p>
            {trace.length > 0 && (
              <button
                type="button"
                onClick={clearTrace}
                className="font-mono text-xs uppercase tracking-[0.09em] text-[var(--scout-chrome-ink-ghost)] transition-colors hover:text-[var(--scout-chrome-ink-strong)]"
              >
                Clear
              </button>
            )}
          </div>
          {trace.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[color-mix(in_srgb,var(--hud-ink)_10%,transparent)] px-6 text-center text-sm leading-relaxed text-[var(--scout-chrome-ink-faint)]">
              Start a call to record requests, replies, navigation attempts, and delivery results.
            </div>
          ) : (
            <ol className={`min-h-0 flex-1 overflow-y-auto ${PLATE}`}>
              {trace.map((entry, index) => (
                <li
                  key={entry.id}
                  className={`px-2.5 py-2 ${index > 0 ? "border-t border-[var(--scout-chrome-border-soft)]" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-1.5">
                      <span className={`mt-px shrink-0 rounded border px-1 py-px font-mono text-xs uppercase tracking-[0.08em] ${traceKindTone(entry.kind)}`}>
                        {traceKindLabel(entry.kind)}
                      </span>
                      <span className="min-w-0 text-sm leading-snug text-[var(--scout-chrome-ink-strong)]">{entry.label}</span>
                    </div>
                    <time className="shrink-0 font-mono text-xs text-[var(--scout-chrome-ink-ghost)]">
                      {formatTraceTime(entry.at)}
                    </time>
                  </div>
                  {entry.detail && (
                    <span className="mt-1 block whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[var(--scout-chrome-ink-faint)]">
                      {entry.detail}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <div className={`flex min-h-0 w-full flex-1 flex-col overflow-y-auto ${page ? "mx-auto max-w-2xl gap-4 p-5" : "gap-2.5 p-3.5"}`}>
          {/* The call itself leads: the panel exists to start and stop it. */}
          <section className={`${PLATE} shrink-0 p-3`}>
            <p className="text-base font-medium text-[var(--scout-chrome-ink-strong)]">Live conversation</p>
            <p className="mt-0.5 text-sm leading-snug text-[var(--scout-chrome-ink-faint)]">
              {state === "live"
                ? "Microphone and spoken replies are active."
                : state === "connecting"
                  ? "Opening the audio connection…"
                  : "Start when you are ready to speak."}
            </p>
            <button
              type="button"
              disabled={dictationActive && !active}
              onClick={() => void (active ? endCall() : startCall())}
              className={`mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border font-mono text-sm uppercase tracking-[0.1em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${callAction.tone}`}
            >
              {callAction.icon}
              {callAction.label}
            </button>
            {dictationActive && !active && (
              <p className="mt-2 text-xs leading-relaxed text-amber-200/80">
                Finish dictation before starting a live call.
              </p>
            )}
            {visibleError && (
              <p className="mt-2 rounded-md border border-red-400/30 bg-red-400/[0.08] px-2 py-1.5 text-sm leading-relaxed text-red-100">
                {visibleError}
              </p>
            )}
          </section>

          <section className={`${PLATE} shrink-0 p-3`}>
            <div className="flex items-center gap-1.5">
              <History size={11} className="shrink-0 text-[var(--scout-chrome-ink-ghost)]" />
              <p className={EYEBROW}>Live chat</p>
            </div>
            <p className="mt-1.5 truncate text-base text-[var(--scout-chrome-ink-strong)]" title={chatState?.session.id}>
              {chatState?.session.title || "Loading chat…"}
            </p>
            <p className="mt-0.5 text-sm leading-snug text-[var(--scout-chrome-ink-faint)]">
              Context stays with this chat when voice stops or the panel closes.
            </p>
            <div className="mt-2.5 flex min-w-0 items-center gap-1.5">
              {chatState && chatState.sessions.length > 1 && (
                <label className="min-w-0 flex-1">
                  <span className="sr-only">Switch live chat</span>
                  <select
                    value={chatState.session.id}
                    disabled={Boolean(sessionAction)}
                    onChange={(event) => void switchChat(event.target.value)}
                    className={`h-8 w-full min-w-0 px-2 font-mono text-sm disabled:cursor-wait disabled:opacity-50 ${FIELD}`}
                    title="Switch live chat; an active voice connection will end"
                  >
                    {chatState.sessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.title || `Chat ${session.id.slice(0, 8)}`} · {session.messageCount} msg
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                onClick={() => void startNewChat()}
                disabled={!chatState || Boolean(sessionAction)}
                title="Start a new chat; an active voice connection will end"
                className={`flex h-8 shrink-0 items-center justify-center gap-1.5 px-2.5 font-mono text-xs uppercase tracking-[0.09em] disabled:cursor-wait ${QUIET_BUTTON}`}
              >
                {sessionAction === "new" ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                New chat
              </button>
            </div>
          </section>

          {/* A model field is a setting, not a call control — it reads as a
              value with a way in, and only becomes an editor on request. */}
          <section className={`${PLATE} shrink-0 p-3`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                {/* "Scoutbot model" in a Live voice panel reads as the model
                    holding the call — it isn't. This is the text brain behind
                    ask_scoutbot; the speech-to-speech model is server-side
                    (OPENSCOUT_REALTIME_MODEL). Naming it avoids the misread. */}
                <p className={EYEBROW}>Scoutbot reply model</p>
                <p className="mt-1 truncate font-mono text-base text-[var(--scout-chrome-ink-strong)]">
                  {chatState?.config.model || "—"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {chatState?.config.provider && (
                  <span className="font-mono text-xs uppercase tracking-[0.08em] text-[var(--scout-chrome-ink-ghost)]">
                    {chatState.config.provider}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setModelStatus(null);
                    setModelOpen((open) => !open);
                  }}
                  aria-expanded={modelOpen}
                  className={`flex h-7 items-center px-2 font-mono text-xs uppercase tracking-[0.09em] ${QUIET_BUTTON}`}
                >
                  {modelOpen ? "Close" : "Change"}
                </button>
              </div>
            </div>
            {modelOpen && (
              <div className="mt-2.5 border-t border-[var(--scout-chrome-border-soft)] pt-2.5">
                <p className="text-sm leading-snug text-[var(--scout-chrome-ink-faint)]">
                  Used for typed and live Scoutbot replies.
                </p>
                <div className="mt-2 flex gap-1.5">
                  <input
                    value={modelDraft}
                    onChange={(event) => {
                      setModelDraft(event.target.value);
                      setModelStatus(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void savePreferredModel();
                    }}
                    placeholder="gpt-4.1-mini"
                    aria-label="Preferred Scoutbot model"
                    className={`h-8 min-w-0 flex-1 px-2 font-mono text-sm ${FIELD}`}
                  />
                  <button
                    type="button"
                    onClick={() => void savePreferredModel()}
                    disabled={modelSaving || !modelDraft.trim() || modelDraft.trim() === chatState?.config.model}
                    className={`flex h-8 min-w-14 items-center justify-center px-2 font-mono text-xs uppercase tracking-[0.09em] ${QUIET_BUTTON}`}
                  >
                    {modelSaving ? <Loader2 size={10} className="animate-spin" /> : "Apply"}
                  </button>
                </div>
                {modelStatus && (
                  <p className="mt-1.5 font-mono text-xs text-[var(--scout-chrome-ink-faint)]">{modelStatus}</p>
                )}
              </div>
            )}
          </section>

          {/* Deliberately strokeless: full-width + a hairline is a bar. It was
              previously QUIET_BUTTON plus `border-transparent`, which left the
              winner to stylesheet order rather than to intent. */}
          <button
            type="button"
            onClick={openVoiceSettings}
            className="mt-auto flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-md font-mono text-xs uppercase tracking-[0.09em] text-[var(--scout-chrome-ink-faint)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink-strong)]"
          >
            <Settings2 size={11} />
            Voice settings
          </button>
        </div>
      )}
    </div>
  );
}

function formatTraceTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function friendlyVoiceError(error: string | null): string | null {
  if (!error) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes("active response in progress") || normalized.includes("conversation already has an active response")) {
    return null;
  }
  if (normalized.includes("realtime voice call is already active")) {
    return "Live voice is still running on this Scout host. Stop it from the footer, or wait a moment for it to finish closing.";
  }
  return error;
}

function traceKindLabel(kind: ScoutRealtimeVoiceTraceKind | undefined): string {
  switch (kind) {
    case "navigation": return "Navigate";
    case "scoutbot": return "Scoutbot";
    case "agent": return "Agent ask";
    case "error": return "Error";
    case "voice":
    default:
      return "Voice";
  }
}

function traceKindTone(kind: ScoutRealtimeVoiceTraceKind | undefined): string {
  switch (kind) {
    case "navigation": return "border-sky-300/25 bg-sky-300/[0.06] text-sky-100/80";
    case "scoutbot": return "border-violet-300/25 bg-violet-300/[0.06] text-violet-100/80";
    case "agent": return "border-amber-300/25 bg-amber-300/[0.06] text-amber-100/80";
    case "error": return "border-red-300/25 bg-red-300/[0.06] text-red-100/80";
    case "voice":
    default:
      return "border-lime-300/20 bg-lime-300/[0.05] text-lime-100/70";
  }
}
