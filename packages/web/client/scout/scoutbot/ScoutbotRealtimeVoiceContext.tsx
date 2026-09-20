import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useOptionalFlag } from "hudsonkit/flags";

import { api } from "../../lib/api.ts";
import { fetchScoutVoiceSettings } from "../../lib/scout-voice.ts";
import {
  startScoutRealtimeVoiceCall,
  type ScoutRealtimeVoiceCall,
  type ScoutRealtimeVoiceConnectionState,
  type ScoutRealtimeVoiceReplyActions,
  type ScoutRealtimeVoiceTraceEvent,
  type ScoutRealtimeVoiceTraceKind,
} from "../../lib/realtime-voice.ts";
import {
  EMPTY_LEDGER,
  actionTickLabel,
  reduceLedger,
  type VoiceLedger,
  type VoiceLedgerEvent,
} from "../../lib/voice-turn-ledger.ts";
import {
  SCOUT_REALTIME_VOICE_FLAG,
  SCOUT_REALTIME_VOICE_SETTINGS_PATH,
} from "../../../shared/realtime-voice.ts";
import {
  fetchScoutRealtimeVoiceSettings,
  subscribeScoutRealtimeVoiceSettings,
} from "../../lib/realtime-voice-settings.ts";
import {
  extractScoutbotUiActions,
  isScoutNativeUiActionHost,
  type ScoutbotUiAction,
} from "../../lib/scoutbot.ts";
import { scoutbotUiContext } from "../../../shared/scoutbot-navigation.ts";
import { useScout } from "../Provider.tsx";
import { setScoutLiveVoiceActive } from "../../lib/scout-audio-owners.ts";
import type {
  ScoutbotAskAgentResult,
  ScoutbotAssistantSessionState,
} from "./scoutbot-model.ts";

export const SCOUTBOT_REALTIME_REPLY_EVENT = "scout:scoutbot-realtime-reply";
export const SCOUTBOT_SESSION_CHANGED_EVENT = "scout:scoutbot-session-changed";

/** Live chat is fetched separately from the call, so it reports its own state. */
export type ScoutbotLiveChatStatus = "idle" | "loading" | "ready" | "failed";

type ScoutbotRealtimeVoiceContextValue = {
  enabled: boolean;
  open: boolean;
  state: ScoutRealtimeVoiceConnectionState | "idle";
  leaseId: string | null;
  error: string | null;
  trace: ScoutRealtimeVoiceTraceEvent[];
  chatState: ScoutbotAssistantSessionState | null;
  chatStatus: ScoutbotLiveChatStatus;
  chatError: string | null;
  sessionAction: "new" | string | null;
  micMuted: boolean;
  playbackMuted: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setMicMuted: (muted: boolean) => void;
  setPlaybackMuted: (muted: boolean) => void;
  startCall: () => Promise<void>;
  endCall: () => Promise<boolean>;
  startNewChat: () => Promise<void>;
  switchChat: (id: string) => Promise<void>;
  updatePreferredModel: (model: string) => Promise<string>;
  clearTrace: () => void;
  openVoiceSettings: () => void;
  ledger: VoiceLedger;
};

const DEFAULT_REALTIME_VOICE_CONTEXT: ScoutbotRealtimeVoiceContextValue = {
  enabled: false,
  open: false,
  state: "idle",
  leaseId: null,
  error: null,
  trace: [],
  chatState: null,
  chatStatus: "idle",
  chatError: null,
  sessionAction: null,
  micMuted: false,
  playbackMuted: false,
  setOpen: () => {},
  setMicMuted: () => {},
  setPlaybackMuted: () => {},
  startCall: async () => {},
  endCall: async () => true,
  startNewChat: async () => {},
  switchChat: async () => {},
  updatePreferredModel: async (model) => model,
  clearTrace: () => {},
  openVoiceSettings: () => {},
  ledger: EMPTY_LEDGER,
};

const ScoutbotRealtimeVoiceContext = createContext<ScoutbotRealtimeVoiceContextValue>(
  DEFAULT_REALTIME_VOICE_CONTEXT,
);

export function ScoutbotRealtimeVoiceProvider({ children }: { children: ReactNode }) {
  const { route, applyScoutbotUiAction } = useScout();
  const featureAvailable = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, true);
  const [settingsEnabled, setSettingsEnabled] = useState(false);
  const enabled = featureAvailable && settingsEnabled;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ScoutRealtimeVoiceConnectionState | "idle">("idle");
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<ScoutRealtimeVoiceTraceEvent[]>([]);
  const [chatState, setChatState] = useState<ScoutbotAssistantSessionState | null>(null);
  const [chatStatus, setChatStatus] = useState<ScoutbotLiveChatStatus>("idle");
  const [chatError, setChatError] = useState<string | null>(null);
  const [sessionAction, setSessionAction] = useState<"new" | string | null>(null);
  const [micMuted, setMicMutedState] = useState(false);
  const [playbackMuted, setPlaybackMutedState] = useState(false);
  const [ledger, setLedger] = useState<VoiceLedger>(EMPTY_LEDGER);
  useEffect(() => {
    setScoutLiveVoiceActive(state === "connecting" || state === "live");
    return () => setScoutLiveVoiceActive(false);
  }, [state]);
  const sessionOriginRef = useRef<number | null>(null);
  const pushTurn = useCallback((event: VoiceLedgerEvent) => {
    setLedger((current) => reduceLedger(current, event));
  }, []);
  const callRef = useRef<ScoutRealtimeVoiceCall | null>(null);
  const endInFlightRef = useRef<Promise<boolean> | null>(null);
  const outstandingLeaseRef = useRef<string | null>(null);
  const audioControlsRef = useRef<Pick<ScoutRealtimeVoiceCall, "setMicMuted" | "setPlaybackMuted"> | null>(null);
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;
  const playbackMutedRef = useRef(playbackMuted);
  playbackMutedRef.current = playbackMuted;
  const abortControllerRef = useRef<AbortController | null>(null);
  const startSettledRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);
  const disposedRef = useRef(false);
  const startingRef = useRef(false);
  const bridgeRef = useRef({ route, applyScoutbotUiAction });
  bridgeRef.current = { route, applyScoutbotUiAction };

  const appendTrace = useCallback((
    label: string,
    detail?: string,
    kind: ScoutRealtimeVoiceTraceKind = "voice",
  ) => {
    setTrace((current) => [
      ...current,
      {
        id: `voice-ui-${Date.now()}-${current.length}`,
        at: Date.now(),
        kind,
        label,
        ...(detail ? { detail } : {}),
      },
    ].slice(-100));
  }, []);

  const clearTrace = useCallback(() => setTrace([]), []);

  const adoptChatState = useCallback((next: ScoutbotAssistantSessionState) => {
    setChatState(next);
    setChatStatus("ready");
    setChatError(null);
  }, []);

  const loadChatState = useCallback(async () => {
    setChatStatus((current) => (current === "ready" ? current : "loading"));
    const next = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session");
    if (!disposedRef.current) adoptChatState(next);
    return next;
  }, [adoptChatState]);

  useEffect(() => {
    if (!featureAvailable) {
      setSettingsEnabled(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const unsubscribe = subscribeScoutRealtimeVoiceSettings((settings) => {
      setSettingsEnabled(settings.enabled);
    });
    void fetchScoutRealtimeVoiceSettings(controller.signal)
      .then((settings) => {
        if (!cancelled) setSettingsEnabled(settings.enabled);
      })
      .catch((caught) => {
        if (cancelled || isAbortError(caught)) return;
        setSettingsEnabled(false);
        setError(describeVoiceSettingsFailure(caught));
      });
    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
    };
  }, [featureAvailable]);

  // The live chat and its reply model are Scoutbot state, not call state. Gating
  // the fetch on the voice toggle left the panel stuck on "Loading chat…" with a
  // dash for a model whenever live voice was off — or whenever the settings route
  // was unreachable and the toggle read false as a result.
  useEffect(() => {
    if (!featureAvailable || (!enabled && !open)) return;
    const refresh = () => void loadChatState().catch((caught) => {
      if (disposedRef.current) return;
      setChatStatus("failed");
      setChatError(caught instanceof Error ? caught.message : "Could not load Scoutbot chats.");
    });
    refresh();
    window.addEventListener(SCOUTBOT_SESSION_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SCOUTBOT_SESSION_CHANGED_EVENT, refresh);
  }, [enabled, featureAvailable, loadChatState, open]);

  const endCall = useCallback((): Promise<boolean> => {
    if (endInFlightRef.current) return endInFlightRef.current;
    generationRef.current += 1;
    const pendingStart = startSettledRef.current;
    const activeCall = callRef.current;
    // Stop before aborting, so the abort listener cannot launch a second retry.
    const stopping = activeCall?.stop();
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const ending = (async () => {
      try {
        await Promise.all([stopping, pendingStart]);
        // Cancelled setup may acquire ownership after endCall began.
        const lateCall = callRef.current;
        if (lateCall && lateCall !== activeCall) await lateCall.stop();
        if (!activeCall && !lateCall && outstandingLeaseRef.current) {
          throw new Error("Call cleanup is incomplete: the host lease is still outstanding.");
        }
      } catch (caught) {
        // Keep both handle and lease; the next attempt must retry the real DELETE.
        if (!disposedRef.current) {
          setState("error");
          setError(caught instanceof Error ? caught.message : "Could not end realtime voice cleanly.");
        }
        return false;
      }
      callRef.current = null;
      outstandingLeaseRef.current = null;
      if (disposedRef.current) return true;
      setLeaseId(null);
      setState("ended");
      setError(null);
      appendTrace("Live voice ended", "Microphone and host lease released", "voice");
      pushTurn({ t: "close", at: Date.now() });
      return true;
    })();
    endInFlightRef.current = ending;
    void ending.then(() => {
      if (endInFlightRef.current === ending) endInFlightRef.current = null;
    });
    return ending;
  }, [appendTrace, pushTurn]);

  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    if (callRef.current || state === "connecting" || state === "live") void endCall();
  }, [enabled, endCall, state]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      generationRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      void callRef.current?.stop().catch(() => {});
      callRef.current = null;
    };
  }, []);

  const applyReplyActions = useCallback(async (body: string, isCurrent: () => boolean): Promise<ScoutRealtimeVoiceReplyActions> => {
    if (!isCurrent()) return { agentRequests: { requested: 0, sent: 0, failed: 0 } };
    window.dispatchEvent(new CustomEvent(SCOUTBOT_REALTIME_REPLY_EVENT, { detail: { body } }));
    const spokenBody = body.replace(/```[\s\S]*?```/gu, "").trim();
    if (spokenBody) appendTrace("Scoutbot replied", spokenBody.slice(0, 2_000), "scoutbot");
    pushTurn({ t: "bot-close", at: Date.now() });
    let requested = 0;
    let sent = 0;
    let failed = 0;
    let unknown = 0;
    for (const action of extractScoutbotUiActions(body)) {
      if (!isCurrent()) break;
      if (action.type === "ask-agent") {
        pushTurn({ t: "action", at: Date.now(), label: actionTickLabel(action) });
        requested += 1;
        if (await sendScoutbotAsk(action, appendTrace, setError) === "sent") {
          sent += 1;
        } else {
          unknown += 1;
        }
      } else if (action.type !== "reminder") {
        const detail = describeActionDetail(action);
        const kind = action.type === "navigate" || action.type === "view-file"
          ? "navigation"
          : "scoutbot";
        pushTurn({ t: "action", at: Date.now(), label: actionTickLabel(action) });
        appendTrace(describeAction(action), detail, kind);
        bridgeRef.current.applyScoutbotUiAction(action);
        appendTrace(
          isScoutNativeUiActionHost() ? "Action sent to Scout for macOS" : "Action applied in OpenScout",
          detail,
          kind,
        );
      }
    }
    if (isCurrent()) await loadChatState().catch(() => null);
    return { agentRequests: { requested, sent, failed, unknown } };
  }, [appendTrace, loadChatState, pushTurn]);

  const openVoiceSettings = useCallback(() => {
    const action: ScoutbotUiAction = { type: "navigate", route: { view: "settings", section: "voice" } };
    appendTrace("Voice settings requested", undefined, "navigation");
    bridgeRef.current.applyScoutbotUiAction(action);
  }, [appendTrace]);

  const setMicMuted = useCallback((muted: boolean) => {
    micMutedRef.current = muted;
    setMicMutedState(muted);
    audioControlsRef.current?.setMicMuted(muted);
  }, []);

  const setPlaybackMuted = useCallback((muted: boolean) => {
    playbackMutedRef.current = muted;
    setPlaybackMutedState(muted);
    audioControlsRef.current?.setPlaybackMuted(muted);
  }, []);

  const startCall = useCallback(async () => {
    if (!enabled) {
      setError("Turn on live voice in Settings → Voice before starting a call.");
      setOpen(false);
      return;
    }
    // Error is not release evidence. Require explicit successful cleanup.
    if (startingRef.current || endInFlightRef.current || callRef.current || outstandingLeaseRef.current
      || state === "connecting" || state === "live") return;
    startingRef.current = true;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let settleStart: () => void = () => {};
    const startSettled = new Promise<void>((resolve) => {
      settleStart = resolve;
    });
    startSettledRef.current = startSettled;
    let started = false;
    setError(null);
    setTrace([{ id: "connecting", at: Date.now(), label: "Connecting secure audio" }]);
    setLedger(EMPTY_LEDGER);
    sessionOriginRef.current = Date.now();
    setState("connecting");
    try {
      const inputDeviceName = await fetchScoutVoiceSettings()
        .then(({ settings }) => settings.inputDeviceName)
        .catch(() => null);
      const call = await startScoutRealtimeVoiceCall({
        signal: controller.signal,
        inputDeviceName,
        getAudioMuteState: () => ({ micMuted: micMutedRef.current, playbackMuted: playbackMutedRef.current }),
        onAudioControls: (controls) => { audioControlsRef.current = controls; },
        onLeaseAcquired: (call) => {
          callRef.current = call;
          outstandingLeaseRef.current = call.leaseId;
          if (!disposedRef.current) setLeaseId(call.leaseId);
        },
        getRoute: () => bridgeRef.current.route,
        getUiContext: () => scoutbotUiContext(isScoutNativeUiActionHost() ? "macos" : "web"),
        onState: (next) => {
          if (!disposedRef.current && generationRef.current === generation) {
            setState(next);
            if (next === "ended" || next === "error") {
              generationRef.current += 1;
              if (next === "ended") {
                callRef.current = null;
                outstandingLeaseRef.current = null;
                setLeaseId(null);
              }
            }
          }
        },
        onError: (message) => {
          if (disposedRef.current || generationRef.current !== generation) return;
          setError(message);
          appendTrace("Voice issue", message, "error");
        },
        onTrace: (event) => {
          if (!disposedRef.current && generationRef.current === generation) {
            setTrace((current) => [...current, event].slice(-100));
            if (event.kind === "scoutbot" && event.label === "Scoutbot is checking the control plane") {
              pushTurn({ t: "bot-open", at: event.at, label: "Scout lookup" });
            }
          }
        },
        onTurn: (notice) => {
          if (disposedRef.current || generationRef.current !== generation) return;
          const origin = sessionOriginRef.current ?? Date.now();
          if (notice.kind === "speech") {
            pushTurn({
              t: "speech",
              speaker: notice.speaker,
              at: origin + notice.startMs,
              end: origin + notice.endMs,
              text: notice.text,
            });
          } else {
            pushTurn({ t: "bot-open", at: origin + notice.offsetMs, label: "Scout lookup" });
          }
        },
        onScoutbotReply: (body, taskIsCurrent) => {
          if (!disposedRef.current && generationRef.current === generation) {
            return applyReplyActions(body, () => taskIsCurrent() && !disposedRef.current && generationRef.current === generation);
          }
          return { agentRequests: { requested: 0, sent: 0, failed: 0 } };
        },
      });
      if (disposedRef.current || controller.signal.aborted || generationRef.current !== generation) {
        await call.stop();
        return;
      }
      callRef.current ??= call;
      outstandingLeaseRef.current = call.leaseId;
      call.setMicMuted(micMutedRef.current);
      call.setPlaybackMuted(playbackMutedRef.current);
      setLeaseId(call.leaseId);
      started = true;
    } catch (caught) {
      if (!disposedRef.current && generationRef.current === generation && !isAbortError(caught)) {
        setState("error");
        const message = caught instanceof Error ? caught.message : "Could not start realtime voice.";
        setError(message);
        appendTrace("Live voice could not start", message, "error");
      }
    } finally {
      if (!started && abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      settleStart();
      if (startSettledRef.current === startSettled) startSettledRef.current = null;
      startingRef.current = false;
    }
  }, [appendTrace, applyReplyActions, enabled, pushTurn, state]);

  const startNewChat = useCallback(async () => {
    if (sessionAction) return;
    setSessionAction("new");
    setError(null);
    try {
      if (callRef.current || state === "connecting" || state === "live") {
        if (!await endCall()) return;
      }
      if (chatState?.session.messages.length === 0) {
        setTrace([{ id: `voice-chat-${Date.now()}`, at: Date.now(), kind: "scoutbot", label: "New live chat ready" }]);
        return;
      }
      const next = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session/reset", {
        method: "POST",
      });
      adoptChatState(next);
      setTrace([{ id: `voice-chat-${Date.now()}`, at: Date.now(), kind: "scoutbot", label: "New live chat ready" }]);
      window.dispatchEvent(new CustomEvent(SCOUTBOT_SESSION_CHANGED_EVENT, { detail: { id: next.session.id } }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not start a new Scoutbot chat.";
      setError(message);
      appendTrace("Could not start a new live chat", message, "error");
    } finally {
      setSessionAction(null);
    }
  }, [adoptChatState, appendTrace, chatState?.session.messages.length, endCall, sessionAction, state]);

  const switchChat = useCallback(async (id: string) => {
    if (!id || sessionAction || id === chatState?.session.id) return;
    setSessionAction(id);
    setError(null);
    try {
      if (callRef.current || state === "connecting" || state === "live") {
        if (!await endCall()) return;
      }
      const next = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session/switch", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      adoptChatState(next);
      setTrace([{
        id: `voice-chat-${Date.now()}`,
        at: Date.now(),
        kind: "scoutbot",
        label: "Live chat restored",
        detail: next.session.title,
      }]);
      window.dispatchEvent(new CustomEvent(SCOUTBOT_SESSION_CHANGED_EVENT, { detail: { id: next.session.id } }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not switch Scoutbot chats.";
      setError(message);
      appendTrace("Could not restore the live chat", message, "error");
    } finally {
      setSessionAction(null);
    }
  }, [adoptChatState, appendTrace, chatState?.session.id, endCall, sessionAction, state]);

  const updatePreferredModel = useCallback(async (nextModel: string) => {
    const model = nextModel.trim();
    if (!model) throw new Error("Preferred model is required.");
    const result = await api<{ config: ScoutbotAssistantSessionState["config"] }>(
      "/api/scoutbot/config",
      { method: "POST", body: JSON.stringify({ model }) },
    );
    setChatState((current) => current
      ? { ...current, config: { ...current.config, ...result.config } }
      : current);
    appendTrace("Scoutbot preferred model updated", result.config.model, "scoutbot");
    return result.config.model;
  }, [appendTrace]);

  const value = useMemo<ScoutbotRealtimeVoiceContextValue>(
    () => ({
      enabled,
      open,
      state,
      leaseId,
      error,
      trace,
      chatState,
      chatStatus,
      chatError,
      sessionAction,
      micMuted,
      playbackMuted,
      setOpen,
      setMicMuted,
      setPlaybackMuted,
      startCall,
      endCall,
      startNewChat,
      switchChat,
      updatePreferredModel,
      clearTrace,
      openVoiceSettings,
      ledger,
    }),
    [
      enabled,
      open,
      state,
      leaseId,
      error,
      trace,
      chatState,
      chatStatus,
      chatError,
      sessionAction,
      micMuted,
      playbackMuted,
      setMicMuted,
      setPlaybackMuted,
      startCall,
      endCall,
      startNewChat,
      switchChat,
      updatePreferredModel,
      clearTrace,
      openVoiceSettings,
      ledger,
    ],
  );

  return (
    <ScoutbotRealtimeVoiceContext.Provider value={value}>
      {children}
    </ScoutbotRealtimeVoiceContext.Provider>
  );
}

/**
 * A Scout host whose web server predates the live voice settings route answers
 * the API router's 404 instead of the endpoint. Raw "unknown api route" reads as
 * a client bug in the panel; name the actual condition so the operator can act.
 */
function describeVoiceSettingsFailure(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "";
  if (/unknown api route/i.test(message) && message.includes(SCOUT_REALTIME_VOICE_SETTINGS_PATH)) {
    return "This Scout host is running an older web server with no live voice settings route. Restart Scout so it serves the current build.";
  }
  return message || "Could not load live voice settings.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export function useScoutbotRealtimeVoice(): ScoutbotRealtimeVoiceContextValue {
  return useContext(ScoutbotRealtimeVoiceContext);
}

function describeAction(action: Exclude<ScoutbotUiAction, { type: "ask-agent" } | { type: "reminder" }>): string {
  if (action.type === "navigate") return "Navigation requested";
  if (action.type === "open-scoutbot") return "Scoutbot opened its panel";
  if (action.type === "refresh") return "Scoutbot refreshed live state";
  return "Scoutbot opened the requested file";
}

function describeActionDetail(
  action: Exclude<ScoutbotUiAction, { type: "ask-agent" } | { type: "reminder" }>,
): string {
  if (action.type === "navigate") return JSON.stringify(action.route);
  if (action.type === "view-file") return action.path;
  return action.reason?.trim() || action.type;
}

async function sendScoutbotAsk(
  action: Extract<ScoutbotUiAction, { type: "ask-agent" }>,
  appendTrace: (label: string, detail?: string, kind?: ScoutRealtimeVoiceTraceKind) => void,
  setError: (message: string | null) => void,
): Promise<"sent" | "unknown"> {
  appendTrace("Scoutbot is coordinating", `Asking ${action.targetLabel}`, "agent");
  try {
    const result = await api<ScoutbotAskAgentResult>("/api/scoutbot/actions/ask", {
      method: "POST",
      body: JSON.stringify({
        targetLabel: action.targetLabel,
        targetAgentId: action.targetAgentId,
        body: action.body,
        channel: action.channel,
      }),
    });
    appendTrace(
      "Scoutbot sent the request",
      result.flightId
        ? `${result.targetAgentId ?? result.targetLabel} · run ${result.flightId}`
        : result.targetAgentId ?? result.targetLabel,
      "agent",
    );
    return "sent";
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not send to agent.";
    appendTrace("Scoutbot request delivery is unconfirmed", message, "error");
    setError(message);
    return "unknown";
  }
}
