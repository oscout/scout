import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";

import {
  engageScoutVoiceDictation,
  ensureScoutVoiceAutoProbe,
  formatScoutVoiceIssue,
  getSharedScoutVoiceClient,
  subscribeScoutVoiceProbe,
  type ScoutVoiceIssue,
  type ScoutVoiceLiveHandle,
  type ScoutVoiceSessionState,
} from "../lib/scout-voice.ts";
import {
  createLevelHistory,
  energyFromPartialDelta,
  tryStartMicLevelMeter,
  VOICE_WAVE_BARS,
  type LevelHistory,
  type StreamLevelMeter,
} from "../lib/voice-levels.ts";

import "./dictation-mic.css";

export type MicSessionState = "idle" | "starting" | "recording" | "processing";

type MicProbeState = "probing" | "idle" | "launching";

export type MicStatus = {
  state: MicSessionState;
  partial: string;
  message: string | null;
  tone: "neutral" | "recording" | "processing" | "error";
  /**
   * Rolling mic/speech energy samples, oldest → newest (0–1).
   * Empty when idle. Drives MessageComposer waveform.
   */
  levels: number[];
  /** True when levels come from a real AnalyserNode (not speech-proxy). */
  levelsLive: boolean;
  /**
   * The structured engagement failure behind `message`, when there is one.
   * `message` is the flattened form; a surface with room should render the
   * title, hint and action from here instead of clipping one long string.
   */
  issue: ScoutVoiceIssue | null;
};

function sessionStateFromVoice(state: ScoutVoiceSessionState): MicSessionState {
  switch (state) {
    case "starting":
      return "starting";
    case "recording":
      return "recording";
    case "processing":
      return "processing";
    default:
      return "idle";
  }
}

function statusMessageForState(
  state: MicSessionState,
  partial: string,
  fallback: string | null,
): string | null {
  if (fallback) return fallback;
  switch (state) {
    case "starting":
      return "Starting voice…";
    case "recording":
      return partial.trim() ? partial.trim() : null;
    case "processing":
      return "Transcribing…";
    default:
      return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Lets the containing composer end a take without going through the button. */
export type DictationMicControl = {
  /**
   * Stop capture so the finalized transcript lands through `onAppend`.
   * Returns false when there is no take to finish.
   */
  finish: () => boolean;
  /** A take is in flight: starting, recording, transcribing, or its
   *  transcript not yet delivered through `onAppend`. */
  busy: () => boolean;
};

export function DictationMic({
  onAppend,
  onError,
  onStatus,
  controlRef,
  autoStart,
  disabled,
  className,
}: {
  onAppend: (text: string) => void;
  onError?: (message: string) => void;
  onStatus?: (status: MicStatus) => void;
  controlRef?: { current: DictationMicControl | null };
  /** Start recording once, as soon as voice reports ready: a surface where
   *  voice is the default way in. When voice is not ready nothing starts. */
  autoStart?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  // A take outlives many renders. Deliver its transcript through the latest
  // `onAppend`, never the one captured at start — that closure holds the draft
  // as it was then, and would restore text sent or edited in the meantime.
  const onAppendRef = useRef(onAppend);
  onAppendRef.current = onAppend;
  // Finish requested while the session was still starting; honored once live.
  const finishWhenLiveRef = useRef(false);
  // Starting is async; a mic that unmounts meanwhile must not start capture.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const clientRef = useRef(getSharedScoutVoiceClient());
  const liveRef = useRef<ScoutVoiceLiveHandle | null>(null);
  const historyRef = useRef<LevelHistory>(createLevelHistory(VOICE_WAVE_BARS));
  const meterRef = useRef<StreamLevelMeter | null>(null);
  const levelsLiveRef = useRef(false);
  const partialRef = useRef("");
  const lastPartialAtRef = useRef(0);
  const proxyRafRef = useRef(0);
  const [sessionState, setSessionState] = useState<MicSessionState>("idle");
  const [partialText, setPartialText] = useState("");
  const [probeState, setProbeState] = useState<MicProbeState>("probing");
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null);
  const [engageIssue, setEngageIssue] = useState<ScoutVoiceIssue | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [levelsTick, setLevelsTick] = useState(0);

  const stopLevelSources = useCallback(() => {
    if (proxyRafRef.current) {
      window.cancelAnimationFrame(proxyRafRef.current);
      proxyRafRef.current = 0;
    }
    meterRef.current?.stop();
    meterRef.current = null;
    levelsLiveRef.current = false;
  }, []);

  const reportError = useCallback((message: string) => {
    setLastError(message);
    onError?.(message);
  }, [onError]);

  const emitStatus = useCallback((
    state: MicSessionState,
    partial: string,
    message: string | null,
    issue: ScoutVoiceIssue | null,
  ) => {
    onStatus?.({
      state,
      partial,
      message: statusMessageForState(state, partial, message),
      tone: message
        ? "error"
        : state === "recording"
          ? "recording"
          : state === "processing"
            ? "processing"
            : "neutral",
      levels: state === "idle" && !message
        ? []
        : historyRef.current.snapshot(),
      levelsLive: levelsLiveRef.current,
      issue: message ? issue : null,
    });
  }, [onStatus]);

  useEffect(() => {
    emitStatus(sessionState, partialText, lastError, engageIssue);
  }, [emitStatus, engageIssue, lastError, partialText, sessionState, levelsTick]);

  const probeVoice = useCallback(async (force = false) => {
    const client = clientRef.current;
    setProbeState((state) => (state === "launching" ? state : "probing"));
    const ok = await client.probe(force ? { force: true } : undefined);
    setVoiceReady(ok);
    // A health probe cannot resolve a specific engagement/permission issue.
    // Keep its action until the next explicit capture attempt rechecks it.
    setProbeState("idle");
    return ok;
  }, []);

  useEffect(() => {
    ensureScoutVoiceAutoProbe();
    const client = clientRef.current;

    const unsubscribe = subscribeScoutVoiceProbe((snapshot) => {
      setVoiceReady(snapshot.ok);
      setProbeState("idle");
    });

    if (client.connectionState === "unknown") {
      void probeVoice();
    } else {
      setVoiceReady(client.connectionState === "connected");
      setEngageIssue(null);
      setProbeState("idle");
    }

    return () => {
      unsubscribe();
      stopLevelSources();
      const live = liveRef.current;
      if (live) {
        void live.cancel().catch(() => undefined);
        liveRef.current = null;
      }
    };
  }, [probeVoice, stopLevelSources]);

  const pushLevel = useCallback((level: number) => {
    historyRef.current.push(level);
    setLevelsTick((n) => n + 1);
  }, []);

  const startSpeechProxyLoop = useCallback(() => {
    if (proxyRafRef.current) return;
    let lastFrame = performance.now();
    const tick = (now: number) => {
      // ~28fps is enough for a calm bar field.
      if (now - lastFrame >= 36) {
        lastFrame = now;
        const idleMs = now - (lastPartialAtRef.current || now);
        const energy = energyFromPartialDelta(
          partialRef.current,
          partialRef.current,
          idleMs,
        );
        // Keep a little noise floor while live so silence still reads as open.
        historyRef.current.push(Math.max(0.05, energy));
        setLevelsTick((n) => n + 1);
      }
      proxyRafRef.current = window.requestAnimationFrame(tick);
    };
    proxyRafRef.current = window.requestAnimationFrame(tick);
  }, []);

  const startRecording = useCallback(async () => {
    const client = clientRef.current;
    setLastError(null);
    setEngageIssue(null);
    setPartialText("");
    partialRef.current = "";
    lastPartialAtRef.current = performance.now();
    historyRef.current.clear();
    setLevelsTick((n) => n + 1);
    setSessionState("starting");
    finishWhenLiveRef.current = false;
    stopLevelSources();

    let engagement = await engageScoutVoiceDictation({
      surface: "chat-composer",
      requestPermissions: true,
    });

    if (!engagement.ready && engagement.issue?.code === "microphone_not_requested") {
      await wait(1800);
      engagement = await engageScoutVoiceDictation({ surface: "chat-composer" });
    }
    if (!mountedRef.current) return;

    const canAttemptCapture = engagement.ready
      || engagement.issue?.code === "microphone_not_requested";

    if (!canAttemptCapture) {
      setSessionState("idle");
      const issue = engagement.issue;
      if (issue) {
        setEngageIssue(issue);
        reportError(formatScoutVoiceIssue(issue));
      } else {
        reportError("Scout voice is not ready.");
      }
      void probeVoice(true);
      return;
    }

    setEngageIssue(null);
    setVoiceReady(true);

    let live: ScoutVoiceLiveHandle | null = null;
    let sawStreamLevels = false;
    try {
      const started = await client.startLive({
        onState: (state) => setSessionState(sessionStateFromVoice(state)),
        onPartial: (text) => {
          const prev = partialRef.current;
          partialRef.current = text;
          lastPartialAtRef.current = performance.now();
          setPartialText(text);
          // When we only have speech-proxy levels, each partial growth is a hit.
          if (!levelsLiveRef.current) {
            const energy = energyFromPartialDelta(prev, text, 0);
            pushLevel(energy);
          }
        },
        onLevel: (level) => {
          sawStreamLevels = true;
          levelsLiveRef.current = true;
          // Prefer stream meter over speech proxy.
          if (proxyRafRef.current) {
            window.cancelAnimationFrame(proxyRafRef.current);
            proxyRafRef.current = 0;
          }
          pushLevel(level);
        },
      });
      if (!mountedRef.current) {
        started.result.catch(() => undefined);
        void started.cancel().catch(() => undefined);
        return;
      }
      live = started;
      liveRef.current = live;
      setSessionState("recording");
      if (finishWhenLiveRef.current) {
        finishWhenLiveRef.current = false;
        void stopRecordingRef.current();
      }

      // Browser capture emits onLevel from the same MediaStream. Native has no
      // stream — wait a beat, then parallel-meter or speech-proxy from partials.
      await wait(140);
      if (liveRef.current && !sawStreamLevels && !levelsLiveRef.current) {
        const meter = await tryStartMicLevelMeter((level) => {
          sawStreamLevels = true;
          levelsLiveRef.current = true;
          if (proxyRafRef.current) {
            window.cancelAnimationFrame(proxyRafRef.current);
            proxyRafRef.current = 0;
          }
          pushLevel(level);
        });
        if (meter && !liveRef.current) {
          // The take ended (or the mic unmounted) while the meter was starting.
          meter.stop();
        } else if (meter) {
          meterRef.current = meter;
        } else if (liveRef.current && !levelsLiveRef.current) {
          levelsLiveRef.current = false;
          startSpeechProxyLoop();
        }
      }

      const final = await live.result;
      liveRef.current = null;
      stopLevelSources();
      setSessionState("idle");
      const recoverablePartial = partialRef.current.trim();
      setPartialText("");
      partialRef.current = "";
      setLastError(null);
      historyRef.current.clear();
      setLevelsTick((n) => n + 1);
      const text = final.text?.trim() || recoverablePartial;
      if (text) {
        onAppendRef.current(text);
      } else {
        reportError("No speech was detected. Check your microphone in Settings → Voice.");
      }
      void probeVoice(true);
    } catch (error) {
      liveRef.current = null;
      stopLevelSources();
      setSessionState("idle");
      const recoverablePartial = partialRef.current.trim();
      setPartialText("");
      partialRef.current = "";
      historyRef.current.clear();
      setLevelsTick((n) => n + 1);
      const message = error instanceof Error ? error.message : "Scout voice recording failed.";
      if (recoverablePartial) {
        onAppendRef.current(recoverablePartial);
        if (!(error instanceof Error && error.name === "AbortError")) {
          reportError(`Recording ended early, but Scout recovered the partial transcript. ${message}`);
        }
        return;
      }
      if (error instanceof Error && error.name === "AbortError") return;
      reportError(message);
      void probeVoice(true);
    }
  }, [probeVoice, pushLevel, reportError, startSpeechProxyLoop, stopLevelSources]);

  const stopRecording = useCallback(async () => {
    const live = liveRef.current;
    if (!live) return;
    setSessionState("processing");
    // Soft decay while transcribing — bars settle, not hard cut.
    stopLevelSources();
    const decayTimer = window.setInterval(() => {
      historyRef.current.decay(0.82);
      setLevelsTick((n) => n + 1);
    }, 50);
    window.setTimeout(() => window.clearInterval(decayTimer), 600);
    try {
      await live.stop();
    } catch (error) {
      try { await live.cancel(); } catch { /* swallow */ }
      liveRef.current = null;
      setSessionState("idle");
      const recoverablePartial = partialRef.current.trim();
      setPartialText("");
      partialRef.current = "";
      historyRef.current.clear();
      setLevelsTick((n) => n + 1);
      const message = error instanceof Error ? error.message : "Scout voice recording did not finish.";
      if (recoverablePartial) {
        onAppendRef.current(recoverablePartial);
        reportError(`Recording ended early, but Scout recovered the partial transcript. ${message}`);
      } else {
        reportError(message);
      }
    }
  }, [reportError, stopLevelSources]);

  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;
  const sessionStateRef = useRef(sessionState);
  sessionStateRef.current = sessionState;

  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      finish: () => {
        switch (sessionStateRef.current) {
          case "recording":
            void stopRecordingRef.current();
            return true;
          case "starting":
            finishWhenLiveRef.current = true;
            return true;
          case "processing":
            return true;
          default:
            return false;
        }
      },
      busy: () => liveRef.current !== null || sessionStateRef.current !== "idle",
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef]);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || disabled || autoStarted.current || voiceReady !== true || sessionState !== "idle") return;
    autoStarted.current = true;
    void startRecording();
  }, [autoStart, disabled, voiceReady, sessionState, startRecording]);

  const onClick = useCallback(() => {
    if (sessionState === "recording") {
      void stopRecording();
      return;
    }
    if (sessionState === "processing" || sessionState === "starting") return;
    void startRecording();
  }, [sessionState, startRecording, stopRecording]);

  const isRecording = sessionState === "recording";
  const isBusy =
    probeState === "launching"
    || sessionState === "starting"
    || sessionState === "processing";
  const needsPermission = (
    clientRef.current.canRequestMicrophone
    || engageIssue?.action === "request_microphone"
    || engageIssue?.action === "request_speech"
  ) && !isRecording && !isBusy;
  const hardDenied = (
    clientRef.current.isMicrophoneHardDenied
    || engageIssue?.action === "open_microphone_settings"
  ) && !isRecording && !isBusy;
  const showUnavailable = (voiceReady === false || engageIssue !== null) && !needsPermission && !hardDenied && !isRecording && !isBusy;

  // Mic only starts/stops capture. Send is a separate control on the composer.
  const title = lastError
    ? lastError
    : engageIssue
      ? engageIssue.title
      : hardDenied
        ? "Microphone blocked. Open Privacy & Security → Microphone to change it."
      : needsPermission
        ? "Allow microphone access"
      : showUnavailable
      ? "Scout voice is not ready"
      : probeState === "probing"
        ? "Checking voice…"
        : isRecording
          ? "Stop recording"
          : sessionState === "processing"
            ? "Transcribing…"
            : sessionState === "starting"
              ? "Starting voice…"
              : "Start recording";

  const stateClass =
    lastError ? "s-dictation-mic--error"
    : isRecording ? "s-dictation-mic--recording"
    : hardDenied ? "s-dictation-mic--error"
    : needsPermission ? "s-dictation-mic--needs-permission"
    : showUnavailable ? "s-dictation-mic--unavailable"
    : isBusy ? "s-dictation-mic--busy"
    : "";

  const Icon = isBusy ? Loader2 : isRecording ? Square : Mic;
  const iconSize = isRecording ? 12 : 14;

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={isRecording}
      onClick={onClick}
      disabled={disabled || sessionState === "processing"}
      className={["s-dictation-mic", stateClass, className].filter(Boolean).join(" ")}
    >
      <Icon
        size={iconSize}
        className={isBusy ? "s-dictation-mic-spin" : isRecording ? "fill-current" : ""}
      />
    </button>
  );
}
