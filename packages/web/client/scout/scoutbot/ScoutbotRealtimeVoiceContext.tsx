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
  isActiveResponseError,
  type ScoutRealtimeVoiceCall,
  type ScoutRealtimeVoiceConnectionState,
  type ScoutRealtimeVoiceReplyActions,
  type ScoutRealtimeVoiceTraceEvent,
  type ScoutRealtimeVoiceTraceKind,
} from "../../lib/realtime-voice.ts";
import { SCOUT_REALTIME_VOICE_FLAG } from "../../../shared/realtime-voice.ts";
import {
  extractScoutbotUiActions,
  isScoutNativeUiActionHost,
  type ScoutbotUiAction,
} from "../../lib/scoutbot.ts";
import { scoutbotUiContext } from "../../../shared/scoutbot-navigation.ts";
import { useScout } from "../Provider.tsx";
import type {
  ScoutbotAskAgentResult,
  ScoutbotAssistantSessionState,
} from "./scoutbot-model.ts";

export const SCOUTBOT_REALTIME_REPLY_EVENT = "scout:scoutbot-realtime-reply";
export const SCOUTBOT_SESSION_CHANGED_EVENT = "scout:scoutbot-session-changed";

type ScoutbotRealtimeVoiceContextValue = {
  enabled: boolean;
  open: boolean;
  state: ScoutRealtimeVoiceConnectionState | "idle";
  leaseId: string | null;
  error: string | null;
  trace: ScoutRealtimeVoiceTraceEvent[];
  chatState: ScoutbotAssistantSessionState | null;
  sessionAction: "new" | string | null;
  setOpen: Dispatch<SetStateAction<boolean>>;
  startCall: () => Promise<void>;
  endCall: () => Promise<boolean>;
  startNewChat: () => Promise<void>;
  switchChat: (id: string) => Promise<void>;
  updatePreferredModel: (model: string) => Promise<string>;
  clearTrace: () => void;
  openVoiceSettings: () => void;
};

const DEFAULT_REALTIME_VOICE_CONTEXT: ScoutbotRealtimeVoiceContextValue = {
  enabled: false,
  open: false,
  state: "idle",
  leaseId: null,
  error: null,
  trace: [],
  chatState: null,
  sessionAction: null,
  setOpen: () => {},
  startCall: async () => {},
  endCall: async () => true,
  startNewChat: async () => {},
  switchChat: async () => {},
  updatePreferredModel: async (model) => model,
  clearTrace: () => {},
  openVoiceSettings: () => {},
};

const ScoutbotRealtimeVoiceContext = createContext<ScoutbotRealtimeVoiceContextValue>(
  DEFAULT_REALTIME_VOICE_CONTEXT,
);

export function ScoutbotRealtimeVoiceProvider({ children }: { children: ReactNode }) {
  const { route, applyScoutbotUiAction } = useScout();
  const enabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, false);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ScoutRealtimeVoiceConnectionState | "idle">("idle");
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<ScoutRealtimeVoiceTraceEvent[]>([]);
  const [chatState, setChatState] = useState<ScoutbotAssistantSessionState | null>(null);
  const [sessionAction, setSessionAction] = useState<"new" | string | null>(null);
  const callRef = useRef<ScoutRealtimeVoiceCall | null>(null);
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

  const loadChatState = useCallback(async () => {
    const next = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session");
    if (!disposedRef.current) setChatState(next);
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void loadChatState().catch((caught) => {
      if (!disposedRef.current) {
        setError(caught instanceof Error ? caught.message : "Could not load Scoutbot chats.");
      }
    });
    refresh();
    window.addEventListener(SCOUTBOT_SESSION_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SCOUTBOT_SESSION_CHANGED_EVENT, refresh);
  }, [enabled, loadChatState]);

  const endCall = useCallback(async () => {
    generationRef.current += 1;
    const pendingStart = startSettledRef.current;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const activeCall = callRef.current;
    callRef.current = null;
    try {
      await activeCall?.stop();
      await pendingStart;
    } catch (caught) {
      if (!disposedRef.current) {
        setState("error");
        setError(caught instanceof Error ? caught.message : "Could not end realtime voice cleanly.");
      }
      return false;
    }
    if (disposedRef.current) return true;
    setLeaseId(null);
    setState("ended");
    appendTrace("Live voice ended", "Microphone and host lease released", "voice");
    return true;
  }, [appendTrace]);

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

  const applyReplyActions = useCallback(async (body: string): Promise<ScoutRealtimeVoiceReplyActions> => {
    window.dispatchEvent(new CustomEvent(SCOUTBOT_REALTIME_REPLY_EVENT, { detail: { body } }));
    const spokenBody = body.replace(/```[\s\S]*?```/gu, "").trim();
    if (spokenBody) appendTrace("Scoutbot replied", spokenBody.slice(0, 2_000), "scoutbot");
    let requested = 0;
    let sent = 0;
    let failed = 0;
    for (const action of extractScoutbotUiActions(body)) {
      if (action.type === "ask-agent") {
        requested += 1;
        if (await sendScoutbotAsk(action, appendTrace, setError)) {
          sent += 1;
        } else {
          failed += 1;
        }
      } else if (action.type !== "reminder") {
        const detail = describeActionDetail(action);
        const kind = action.type === "navigate" || action.type === "view-file"
          ? "navigation"
          : "scoutbot";
        appendTrace(describeAction(action), detail, kind);
        bridgeRef.current.applyScoutbotUiAction(action);
        appendTrace(
          isScoutNativeUiActionHost() ? "Action sent to Scout for macOS" : "Action applied in OpenScout",
          detail,
          kind,
        );
      }
    }
    await loadChatState().catch(() => null);
    return { agentRequests: { requested, sent, failed } };
  }, [appendTrace, loadChatState]);

  const openVoiceSettings = useCallback(() => {
    const action: ScoutbotUiAction = { type: "navigate", route: { view: "settings", section: "voice" } };
    appendTrace("Voice settings requested", undefined, "navigation");
    bridgeRef.current.applyScoutbotUiAction(action);
  }, [appendTrace]);

  const startCall = useCallback(async () => {
    if (!enabled) {
      setError("Turn on live voice in Settings → Voice before starting a call.");
      setOpen(false);
      return;
    }
    if (startingRef.current || state === "connecting" || state === "live") return;
    startingRef.current = true;
    abortControllerRef.current?.abort();
    const previousCall = callRef.current;
    callRef.current = null;
    try {
      await previousCall?.stop();
      setLeaseId(null);
    } catch (caught) {
      setState("error");
      setError(caught instanceof Error ? caught.message : "Could not end the previous realtime voice call.");
      startingRef.current = false;
      return;
    }
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
    setState("connecting");
    try {
      const inputDeviceName = await fetchScoutVoiceSettings()
        .then(({ settings }) => settings.inputDeviceName)
        .catch(() => null);
      const call = await startScoutRealtimeVoiceCall({
        signal: controller.signal,
        inputDeviceName,
        getRoute: () => bridgeRef.current.route,
        getUiContext: () => scoutbotUiContext(isScoutNativeUiActionHost() ? "macos" : "web"),
        onState: (next) => {
          if (!disposedRef.current && generationRef.current === generation) {
            setState(next);
          }
        },
        onError: (message) => {
          if (disposedRef.current || generationRef.current !== generation) return;
          if (isActiveResponseError(message)) {
            appendTrace("Scoutbot reply queued", "Waiting for the current spoken response to finish", "scoutbot");
            return;
          }
          setError(message);
          appendTrace("Voice issue", message, "error");
        },
        onTrace: (event) => {
          if (!disposedRef.current && generationRef.current === generation) {
            setTrace((current) => [...current, event].slice(-100));
          }
        },
        onScoutbotReply: (body) => {
          if (!disposedRef.current && generationRef.current === generation) {
            return applyReplyActions(body);
          }
          return { agentRequests: { requested: 0, sent: 0, failed: 0 } };
        },
      });
      if (disposedRef.current || controller.signal.aborted || generationRef.current !== generation) {
        await call.stop();
        return;
      }
      callRef.current = call;
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
  }, [appendTrace, applyReplyActions, enabled, state]);

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
      setChatState(next);
      setTrace([{ id: `voice-chat-${Date.now()}`, at: Date.now(), kind: "scoutbot", label: "New live chat ready" }]);
      window.dispatchEvent(new CustomEvent(SCOUTBOT_SESSION_CHANGED_EVENT, { detail: { id: next.session.id } }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not start a new Scoutbot chat.";
      setError(message);
      appendTrace("Could not start a new live chat", message, "error");
    } finally {
      setSessionAction(null);
    }
  }, [appendTrace, chatState?.session.messages.length, endCall, sessionAction, state]);

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
      setChatState(next);
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
  }, [appendTrace, chatState?.session.id, endCall, sessionAction, state]);

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
      sessionAction,
      setOpen,
      startCall,
      endCall,
      startNewChat,
      switchChat,
      updatePreferredModel,
      clearTrace,
      openVoiceSettings,
    }),
    [
      enabled,
      open,
      state,
      leaseId,
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
    ],
  );

  return (
    <ScoutbotRealtimeVoiceContext.Provider value={value}>
      {children}
    </ScoutbotRealtimeVoiceContext.Provider>
  );
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
): Promise<boolean> {
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
    return true;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not send to agent.";
    appendTrace("Scoutbot could not send the request", message, "error");
    setError(message);
    return false;
  }
}
