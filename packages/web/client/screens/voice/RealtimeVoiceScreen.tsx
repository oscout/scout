import { useOptionalFlag } from "hudsonkit/flags";
import { useEffect, useRef, useState } from "react";

import {
  SCOUT_REALTIME_VOICE_FLAG,
  SCOUT_REALTIME_VOICE_STOP_EVENT,
} from "../../../shared/realtime-voice.ts";
import {
  fetchScoutRealtimeVoiceSettings,
  subscribeScoutRealtimeVoiceSettings,
} from "../../lib/realtime-voice-settings.ts";
import {
  ScoutbotRealtimeVoiceCall,
  ScoutbotRealtimeVoiceCallHeader,
} from "../../scout/scoutbot/ScoutbotRealtimeVoiceCall.tsx";
import { useScoutbotRealtimeVoice } from "../../scout/scoutbot/ScoutbotRealtimeVoiceContext.tsx";
import { ScoutbotPanel } from "../../scout/scoutbot/ScoutbotPanel.tsx";
import { VoiceUsagePanel } from "../../scout/scoutbot/VoiceUsagePanel.tsx";
import type { DirectVoicePhase } from "../../scout/scoutbot/DirectVoicePanel.tsx";
import type { ScoutbotSpeechIdentity } from "../../scout/scoutbot/scoutbot-voice-profiles.ts";
import { fetchScoutVoiceSettings } from "../../lib/scout-voice.ts";
import { defineSurface } from "../../surfaces/types.ts";
import { EMPTY_LEDGER, formatVoiceQuote, reduceLedger, turnFloor, turnSettle, turnTotal, type VoiceLedger } from "../../lib/voice-turn-ledger.ts";
import { VoiceControlWell, gptLiveWellSpec } from "./VoiceControlWell.tsx";
import { VoiceTurnDetails } from "./VoiceTurnDetails.tsx";
import { VoiceTurnHero, VoiceTurnStageTrack, gptStageStops, localStageStops, voiceTurnQuoteWho, type HeroWhoTone } from "./VoiceTurnStage.tsx";
import { VoiceTurnSettle, VoiceTurnView } from "./VoiceTurnView.tsx";
import "./voice-paths.css";

type VoiceMode = "gpt-live" | "local-live";

declare global {
  interface Window {
    __scoutRealtimeVoiceStopRequested?: boolean;
    __scoutRealtimeVoiceStop?: () => Promise<boolean>;
  }
}

// Live voice as a standalone surface.
//
// The web status bar reaches the same call through a chip and a popover; this
// is the panel on its own, so a native host can mount it in a window without
// running a second WebRTC client. Everything below the header is the shared
// ScoutbotRealtimeVoiceCall.

export function RealtimeVoiceScreen({
  dictationActive = false,
  autoStart = false,
}: {
  dictationActive?: boolean;
  autoStart?: boolean;
}) {
  const enabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, true);
  const { enabled: operatorEnabled, state, leaseId, startCall, endCall } = useScoutbotRealtimeVoice();
  const autoStartAttemptedRef = useRef(false);
  const stopInFlightRef = useRef<Promise<boolean> | null>(null);
  const [layout, setLayout] = useState<"compact" | "page">(() => (
    window.innerWidth >= 720 && window.innerHeight >= 520 ? "page" : "compact"
  ));
  const nativeHandler = (
    window as unknown as {
      webkit?: { messageHandlers?: { scoutRealtimeVoice?: { postMessage: (message: unknown) => void } } };
    }
  ).webkit?.messageHandlers?.scoutRealtimeVoice;

  useEffect(() => {
    const updateLayout = () => {
      setLayout(window.innerWidth >= 720 && window.innerHeight >= 520 ? "page" : "compact");
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    nativeHandler?.postMessage({ kind: "session-state", state, leaseId });
  }, [leaseId, nativeHandler, state]);

  useEffect(() => {
    const stopFromNativeHost = (): Promise<boolean> => {
      if (stopInFlightRef.current) return stopInFlightRef.current;
      const stopping = endCall().finally(() => {
        if (stopInFlightRef.current === stopping) stopInFlightRef.current = null;
      });
      stopInFlightRef.current = stopping;
      return stopping;
    };

    const stopEventListener = () => { void stopFromNativeHost(); };
    window.__scoutRealtimeVoiceStop = stopFromNativeHost;
    window.addEventListener(SCOUT_REALTIME_VOICE_STOP_EVENT, stopEventListener);
    if (window.__scoutRealtimeVoiceStopRequested) {
      void stopFromNativeHost();
    }
    return () => {
      window.removeEventListener(SCOUT_REALTIME_VOICE_STOP_EVENT, stopEventListener);
      if (window.__scoutRealtimeVoiceStop === stopFromNativeHost) {
        delete window.__scoutRealtimeVoiceStop;
      }
    };
  }, [endCall]);

  useEffect(() => {
    if (!autoStart || dictationActive || !enabled || !operatorEnabled || autoStartAttemptedRef.current) return;
    if (state !== "idle" && state !== "ended" && state !== "error") return;
    autoStartAttemptedRef.current = true;
    void startCall();
  }, [autoStart, dictationActive, enabled, operatorEnabled, startCall, state]);

  // Off means the provider above us was never mounted, so there is no peer
  // connection to start. Say that instead of rendering a start button that
  // silently does nothing.
  if (!enabled) {
    return (
      <div className="flex h-full flex-col justify-center gap-2 p-4">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          Live voice is off
        </p>
        <p className="text-sm leading-snug text-[var(--scout-chrome-ink-faint)]">
          This Scout build has live conversations disabled. Calls use the configured OpenAI API account when the feature is available.
        </p>
      </div>
    );
  }

  if (!operatorEnabled) {
    return (
      <div className="flex h-full flex-col justify-center gap-2 p-4">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          Live voice is disabled
        </p>
        <p className="text-sm leading-snug text-[var(--scout-chrome-ink-faint)]">
          Enable realtime voice in Settings → Voice. The footer Voice control starts and manages calls.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScoutbotRealtimeVoiceCallHeader
        state={state}
        onMinimize={nativeHandler ? () => nativeHandler.postMessage("minimize") : undefined}
        onExpand={nativeHandler ? () => nativeHandler.postMessage(layout === "page" ? "restore" : "expand") : undefined}
        layout={layout}
      />
      <ScoutbotRealtimeVoiceCall dictationActive={dictationActive} layout={layout} />
    </div>
  );
}

function fmtClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function gptMeterLine(identity: { model: string; voice: string } | null): string {
  return identity
    ? `OpenAI ${identity.model} · ${identity.voice} · metered`
    : "OpenAI realtime · metered";
}

function localMeterLine(identity: ScoutbotSpeechIdentity | null): string {
  if (!identity) return "on-device STT · voice host resolving…";
  const tts = `${identity.providerLabel}${identity.modelId ? ` ${identity.modelId}` : ""} · ${identity.voiceLabel}`;
  return identity.metered
    ? `on-device STT · ${tts} · metered per reply`
    : `on-device STT · ${tts} · unmetered`;
}

const fmtTenths = (sec: number) => `${sec.toFixed(1)}s`;

/* While a local turn is between spans (take closed, transcribe not yet open)
   the phase still says the turn is performing — bridge gaps under a second
   so the hero and the stage track don't flash back to rest mid-turn. */
const TURN_GAP_BRIDGE_S = 1.0;

function localPhaseStory(phase: DirectVoicePhase, identity: ScoutbotSpeechIdentity | null): string {
  switch (phase) {
    case "listening":
      return "the take is recording · nothing is sent until Send";
    case "processing":
      return "turning speech into text";
    case "thinking":
      return "your turn is in";
    case "speaking":
      return identity?.metered ? "spoken reply · metered" : "spoken reply · unmetered";
    default:
      return localMeterLine(identity);
  }
}

/**
 * Routed /voice workspace. Two modes, one instrument: GPT Live is a
 * continuous metered OpenAI call; Local Live is tap-to-tap on this machine.
 * The header readout is the identity a call will meter, or the clock while
 * it runs. The stage track is the turn's live score, the hero is the spoken
 * sentence, and the well collapses to a control row while a turn performs.
 */
export function RealtimeVoicePage() {
  const {
    state,
    leaseId,
    enabled,
    error,
    sessionAction,
    endCall,
    startCall,
    startNewChat,
    openVoiceSettings,
    micMuted,
    playbackMuted,
    setMicMuted,
    setPlaybackMuted,
    ledger: gptLedger,
  } = useScoutbotRealtimeVoice();
  const [selectedMode, setMode] = useState<VoiceMode>("gpt-live");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchingRef = useRef(false);
  const callOutstanding = state === "connecting" || state === "live" || leaseId != null;
  // Calls started elsewhere and failed lease cleanup must remain visible.
  const mode: VoiceMode = callOutstanding ? "gpt-live" : selectedMode;
  const [localLedger, setLocalLedger] = useState<VoiceLedger>(EMPTY_LEDGER);
  const [localPhase, setLocalPhase] = useState<DirectVoicePhase>("ready");
  const [lanes, setLanes] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [speechIdentity, setSpeechIdentity] = useState<ScoutbotSpeechIdentity | null>(null);
  const [liveIdentity, setLiveIdentity] = useState<{ model: string; voice: string } | null>(null);
  const [gptInputLabel, setGptInputLabel] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const startedAtRef = useRef<number | null>(null);
  const callLive = state === "connecting" || state === "live";

  useEffect(() => {
    const controller = new AbortController();
    void fetchScoutRealtimeVoiceSettings(controller.signal)
      .then((settings) => {
        if (settings.model && settings.voice) {
          setLiveIdentity({ model: settings.model, voice: settings.voice });
        }
      })
      .catch(() => {});
    const unsubscribe = subscribeScoutRealtimeVoiceSettings((settings) => {
      if (settings.model && settings.voice) {
        setLiveIdentity({ model: settings.model, voice: settings.voice });
      }
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchScoutVoiceSettings()
      .then(({ settings }) => {
        if (!cancelled) setGptInputLabel(settings.inputDeviceName ?? "browser default");
      })
      .catch(() => {
        if (!cancelled) setGptInputLabel("browser default");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state === "connecting") {
      startedAtRef.current = Date.now();
      setElapsedMs(0);
    }
    if (state !== "live" && state !== "connecting") return;
    const tick = window.setInterval(() => {
      const start = startedAtRef.current;
      if (start) setElapsedMs(Date.now() - start);
    }, 250);
    return () => window.clearInterval(tick);
  }, [state]);

  const clock = callLive || state === "ended" ? fmtClock(elapsedMs) : undefined;
  const gptLine = gptMeterLine(liveIdentity);
  const localLine = localMeterLine(speechIdentity);
  const ledger = mode === "gpt-live" ? (gptLedger ?? EMPTY_LEDGER) : localLedger;
  const currentTurn = ledger.turns.at(-1);
  const pickedTurn = pickedId ? ledger.turns.find((turn) => turn.id === pickedId) : undefined;
  const turnOpen = Boolean(currentTurn?.spans.some((span) => span.end === null));
  useEffect(() => {
    setLanes(false);
    setPickedId(null);
  }, [mode]);
  useEffect(() => {
    if (!turnOpen) return;
    const tick = window.setInterval(() => setNowMs(Date.now()), 120);
    return () => window.clearInterval(tick);
  }, [turnOpen]);
  const nowSec = currentTurn && turnOpen && !pickedTurn
    ? Math.max(0, (nowMs - currentTurn.origin) / 1000)
    : undefined;
  const localPerforming = localPhase === "listening"
    || localPhase === "processing"
    || localPhase === "thinking"
    || localPhase === "speaking";
  const lastClosedEnd = currentTurn && !turnOpen && currentTurn.spans.length > 0
    ? Math.max(...currentTurn.spans.map((span) => span.end ?? 0))
    : null;
  const gapBridged = Boolean(
    mode === "local-live"
    && localPerforming
    && currentTurn
    && lastClosedEnd !== null
    && (nowMs - currentTurn.origin) / 1000 - lastClosedEnd < TURN_GAP_BRIDGE_S,
  );
  const gptLiveTurnIdle = Boolean(mode === "gpt-live" && state === "live" && currentTurn && !turnOpen);
  const liveFloor = Boolean(currentTurn && !pickedTurn && (turnOpen || gapBridged || gptLiveTurnIdle));
  const floorNow = nowSec ?? (currentTurn ? turnTotal(currentTurn) : 0);
  const floorState = liveFloor && currentTurn
    ? turnFloor(currentTurn, floorNow)
    : null;
  const floorWho = floorState?.who ?? "open";
  const heldTurn = pickedTurn ?? currentTurn;
  const heroTurn = pickedTurn ?? (liveFloor ? currentTurn : undefined);
  const showLanes = lanes && heldTurn;

  const voiceName = mode === "gpt-live"
    ? (liveIdentity?.voice ?? null)
    : (speechIdentity?.voiceLabel ?? null);
  const speakSpanOpen = Boolean(currentTurn?.spans.some(
    (span) => span.lane === "voice" && span.tone === "speak" && span.end === null,
  ));
  const stageStops = mode === "gpt-live"
    ? gptStageStops({
        state,
        floorWho: liveFloor ? floorWho : "open",
        speakOpen: speakSpanOpen,
        voiceName,
      })
    : localStageStops(heroTurn, pickedTurn ? undefined : nowSec, voiceName);

  const gptLiveStory = "live · billed per second · the meter is running";
  const heroRest = !heroTurn && !(mode === "gpt-live" && state === "live");
  const heroWho = pickedTurn
    ? "holding"
    : liveFloor
      ? floorWho
      : mode === "gpt-live"
        ? state === "live" ? "live" : state === "connecting" ? "connecting" : "ready"
        : localPhase === "checking" ? "checking" : localPhase === "unavailable" ? "offline" : "ready";
  const heroWhoTone: HeroWhoTone = heroWho === "you" || heroWho === "live"
    ? "open"
    : heroWho === "Scout"
      ? mode === "gpt-live" ? "sky" : "wait"
      : heroWho === "Scoutbot"
        ? "wait"
        : "dim";
  const heroClock = liveFloor && nowSec !== undefined
    ? fmtTenths(nowSec)
    : heroTurn
      ? fmtTenths(turnTotal(heroTurn))
      : mode === "gpt-live" && callLive
        ? clock
        : undefined;
  const heroStory = pickedTurn
    ? turnSettle(pickedTurn)
    : liveFloor
      ? floorState?.beneath ?? (mode === "gpt-live" ? gptLiveStory : localPhaseStory(localPhase, speechIdentity))
      : mode === "gpt-live" && state === "live"
        ? gptLiveStory
        : mode === "gpt-live"
          ? gptLine
          : localLine;
  const heroQuote = heroTurn ? formatVoiceQuote(heroTurn.quote) || undefined : undefined;
  const heroPlaceholder = heroRest
    ? mode === "gpt-live" ? "Start a call and hold the floor." : "Tap, talk, send. The reply speaks."
    : heroTurn
      ? "…"
      : "The floor is open.";
  const railLiveId = currentTurn && turnOpen ? currentTurn.id : null;
  const railNow = currentTurn && turnOpen
    ? Math.max(0, (nowMs - currentTurn.origin) / 1000)
    : undefined;
  const readout = mode === "gpt-live"
    ? callLive && clock
      ? <><span className="voice-readout-clock">{clock}</span> · metered</>
      : state === "ended" && clock
        ? `last call ${clock} · metered`
        : gptLine
    : localLine;

  const requestMode = async (next: VoiceMode) => {
    if (next === mode || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    setSwitchError(null);
    try {
      if (next === "local-live" && callOutstanding && !(await endCall())) {
        setMode("gpt-live");
        setSwitchError("Call cleanup is incomplete. Retry ending the API call before switching to Local.");
        return;
      }
      setLanes(false);
      setPickedId(null);
      setMode(next);
    } catch {
      setMode("gpt-live");
      setSwitchError("Could not end the API call. Retry before switching to Local.");
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  const toggleLanes = () => {
    if (pickedTurn) {
      setPickedId(null);
      setLanes(true);
      return;
    }
    setLanes((open) => !open);
  };

  const callSpec = gptLiveWellSpec({
    enabled, state, error, clock: callLive ? clock : undefined,
    meterLine: gptLine, inputLabel: gptInputLabel ?? "browser default",
    micMuted, playbackMuted, newChatBusy: sessionAction !== null,
  });
  if (callOutstanding && !callLive) {
    callSpec.cta = { label: "Retry ending call", tone: "end" };
    callSpec.note = "Call cleanup is incomplete. End this call before starting another.";
    callSpec.noteError = true;
  }
  if (switching) {
    callSpec.cta = { ...callSpec.cta, label: "Ending call…", disabled: true, busy: true };
  }

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--scout-chrome-bg)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--scout-chrome-border-soft)] px-4 py-2.5 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--scout-chrome-ink-ghost)] md:block">
            Voice
          </span>
          <h1 className="truncate font-[var(--font-accent-title)] text-base font-semibold tracking-[-0.018em] text-[var(--scout-chrome-ink-strong)]">
            {mode === "gpt-live" ? "GPT Live" : "Local Live"}
          </h1>
          <span className="hidden h-4 w-px bg-[var(--scout-chrome-border-soft)] sm:block" aria-hidden="true" />
          <span className="voice-readout hidden sm:block" aria-live="polite">{readout}</span>
        </div>
        <div className="voice-mode-switch" role="tablist" aria-label="Voice mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "gpt-live"}
            disabled={switching}
            onClick={() => void requestMode("gpt-live")}
          >
            GPT Live
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "local-live"}
            disabled={switching}
            title={callOutstanding ? "Ends local audio and releases the call lease before switching. Provider usage confirmation is separate." : undefined}
            onClick={() => void requestMode("local-live")}
          >
            Local Live
          </button>
        </div>
      </header>
      {switchError && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-[var(--scout-chrome-ink-strong)]">{switchError}</p>}
      <div className="max-h-[40%] shrink-0 overflow-y-auto">
        <VoiceUsagePanel
          mode={mode === "gpt-live" ? "api" : "local"}
          active={mode === "gpt-live" ? callLive : localPhase === "thinking"}
          currentLeaseId={leaseId}
        />
      </div>

      <section className="voice-instrument min-h-0 flex-1 overflow-hidden">
        <div className="voice-instrument-main flex min-h-0 flex-col overflow-hidden">
          <div className="voice-stack">
            <VoiceTurnStageTrack
              mode={mode}
              stops={stageStops}
              connecting={mode === "gpt-live" && state === "connecting"}
              error={mode === "gpt-live" && state === "error"}
              continuous={mode === "gpt-live" && state === "live"}
            />
            {pickedTurn && (
              <p className="vtl-hold">
                <b>holding</b> this turn ·{" "}
                <button type="button" onClick={() => { setPickedId(null); setLanes(false); }}>back to now</button>
              </p>
            )}
            <VoiceTurnHero
              who={heroWho}
              whoTone={heroWhoTone}
              clock={heroClock}
              story={heroStory}
              quote={heroQuote}
              quoteWho={voiceTurnQuoteWho(heroTurn)}
              placeholder={heroPlaceholder}
              turn={heroTurn}
              now={pickedTurn ? undefined : nowSec}
              live={liveFloor && turnOpen}
              lanesOpen={Boolean(showLanes)}
              onToggleLanes={heldTurn ? toggleLanes : undefined}
            />
            {showLanes && heldTurn && (
              <div className="overflow-x-auto">
                <VoiceTurnView turn={heldTurn} now={nowSec} mode={mode} />
                <VoiceTurnDetails turn={heldTurn} now={nowSec} />
              </div>
            )}
            <div className="voice-stack-ctl">
              {mode === "gpt-live" ? (
                <VoiceControlWell
                  layout={callLive ? "row" : "card"}
                  spec={callSpec}
                  onCta={() => {
                    if (switchingRef.current) return;
                    if (callOutstanding) {
                      void endCall();
                    } else if (!enabled) {
                      openVoiceSettings();
                    } else {
                      void startCall();
                    }
                  }}
                  onFlag={(key) => {
                    if (key === "mic") {
                      setMicMuted(!micMuted);
                    } else if (key === "speaker") {
                      setPlaybackMuted(!playbackMuted);
                    }
                  }}
                  onTail={(key) => {
                    if (key === "new-chat") {
                      void startNewChat();
                    } else {
                      openVoiceSettings();
                    }
                  }}
                />
              ) : (
                <ScoutbotPanel
                  forceExpanded
                  presentation="direct-voice"
                  voiceModeSwitch={false}
                  voiceHeading={false}
                  voiceTranscript={false}
                  voiceTitle="Local Live"
                  onSpeechIdentityChange={setSpeechIdentity}
                  onLedgerEvent={(event) => setLocalLedger((current) => reduceLedger(current, event))}
                  onVoicePhaseChange={setLocalPhase}
                />
              )}
            </div>
          </div>
        </div>
        <aside className="voice-instrument-trace flex min-h-0 flex-col">
          <p className="voice-trace-kicker">This call</p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <VoiceTurnSettle
              turns={ledger.turns}
              selectedId={pickedId}
              mode={mode}
              liveId={railLiveId}
              now={railNow}
              onSelect={(id) => {
                setPickedId((current) => (current === id ? null : id));
                setLanes(true);
              }}
            />
          </div>
        </aside>
      </section>
    </main>
  );
}

export const scoutSurface = defineSurface({
  id: "voice",
  label: "Voice",
  route: { view: "voice" },
  webPath: "/voice",
  screen: "RealtimeVoiceScreen",
  embed: {
    path: "/embed/voice",
    profile: "macos.voice",
    rootClassName: "s-voice-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    hosts: { macos: true },
    resolveEmbedProps: (params) => ({
      // A native host that is already capturing for dictation can say so, and
      // the panel holds the call back rather than fighting for the mic.
      dictationActive: params.get("dictationActive") === "1",
      // The native footer button is itself the explicit per-call activation.
      autoStart: params.get("autoStart") === "1",
    }),
  },
});
