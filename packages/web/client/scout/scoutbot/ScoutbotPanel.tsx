import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Square, Volume2, VolumeX } from "lucide-react";
import { useOptionalFlag } from "hudsonkit/flags";
import { api } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import { ScoutbotBroadcastChip } from "../../components/ScoutbotBroadcastChip.tsx";
import { ensureOpenAIKeyOnServer } from "../../lib/credentials.ts";
import { usePersistentBoolean, usePersistentNumber, usePersistentString } from "../../lib/persistent-state.ts";
import { onToggleScoutbot } from "../../lib/scoutbot-broadcast-store.ts";
import {
  extractScoutbotUiActions,
  SCOUTBOT_SUBMIT_EVENT,
  stripScoutbotUiFences,
} from "../../lib/scoutbot.ts";
import { toSpokenScoutText } from "../../lib/spoken-text.ts";
import {
  isScoutSpeechStopped,
  ensureScoutVoiceAutoProbe,
  getSharedScoutVoiceClient,
  startScoutSpeechWithEffects,
  subscribeScoutVoiceProbe,
  type ScoutVoiceLiveHandle,
  type ScoutVoiceSessionState,
  type ScoutSpeechHandle,
} from "../../lib/scout-voice.ts";
import { SCOUT_REALTIME_VOICE_FLAG } from "../../../shared/realtime-voice.ts";
import { scoutbotUiContext } from "../../../shared/scoutbot-navigation.ts";
import { useScout } from "../Provider.tsx";
import {
  useScoutbotStatePublisher,
  type ScoutbotActionApi,
  type ScoutbotActivity,
  type ScoutbotPublicState,
} from "./ScoutbotStateContext.tsx";
import { ChatHistory, ChatInput } from "./ScoutbotChat.tsx";
import { ScoutbotIconButton, ScoutVoiceSetupPanel } from "./ScoutbotControls.tsx";
import { ScoutbotSettingsPanel } from "./ScoutbotSettingsPanel.tsx";
import {
  SCOUTBOT_REALTIME_REPLY_EVENT,
  SCOUTBOT_SESSION_CHANGED_EVENT,
  useScoutbotRealtimeVoice,
} from "./ScoutbotRealtimeVoiceContext.tsx";
import {
  DEFAULT_SCOUTBOT_VOICE_PRESET_ID,
  DEFAULT_SCOUTBOT_VOICE_SPEED,
  SCOUT_VOICE_STOP_TIMEOUT_MS,
  extractAbsoluteFilePaths,
  isScoutVoiceCancellation,
  makeScoutAudioLaunchContext,
  releaseScoutVoiceLive,
  resolveScoutbotFxParams,
  shortenForMenu,
  withTimeout,
  type ScoutbotAgentConfig,
  type ScoutbotAgentConfigUpdateResult,
  type ScoutbotAskAgentResult,
  type ScoutbotAssistantReply,
  type ScoutbotAssistantSession,
  type ScoutbotAssistantSessionState,
  type ScoutbotVoiceDefaults,
  type VoiceProbeState,
  type ScoutVoiceCancelReason,
} from "./scoutbot-model.ts";

const SCOUTBOT_STARTER_PROMPTS = [
  "Explain what went wrong here.",
  "Help me rewrite this message.",
  "What should I try next?",
] as const;

export function ScoutbotPanel({
  height,
  forceExpanded = false,
  fill = false,
}: {
  height?: number;
  forceExpanded?: boolean;
  fill?: boolean;
} = {}) {
  const {
    applyScoutbotUiAction,
    agents,
    route,
    onlineCount,
  } = useScout();
  const publisher = useScoutbotStatePublisher();
  const realtimeVoiceFlag = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, false);
  const realtimeVoice = useScoutbotRealtimeVoice();
  const realtimeLive = realtimeVoiceFlag
    && (realtimeVoice.state === "connecting" || realtimeVoice.state === "live");

  const [collapsed, setCollapsed] = usePersistentBoolean("openscout.scoutbot.collapsed", true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceAvailable, setVoiceAvailable] = useState<boolean | null>(null);
  const [voiceIssue, setVoiceIssue] = useState<string | null>(null);
  const [voiceProbeState, setVoiceProbeState] = useState<VoiceProbeState>("idle");
  const [voiceReplies, setVoiceReplies] = usePersistentBoolean("openscout.scoutbot.voiceReplies", false);
  const [voiceSpeed, setVoiceSpeed] = usePersistentNumber("openscout.scoutbot.voiceSpeed", DEFAULT_SCOUTBOT_VOICE_SPEED);
  const [voicePresetId, setVoicePresetId] = usePersistentString("openscout.scoutbot.voicePresetId", DEFAULT_SCOUTBOT_VOICE_PRESET_ID);
  const [recording, setRecording] = useState(false);
  const [voiceState, setVoiceState] = useState<ScoutVoiceSessionState | null>(null);
  const [partial, setPartial] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [lastAsk, setLastAsk] = useState<string | null>(null);
  const [lastReply, setLastReply] = useState<string | null>(null);
  const [askStatus, setAskStatus] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [sessionState, setSessionState] = useState<ScoutbotAssistantSessionState | null>(null);
  const [resettingSession, setResettingSession] = useState(false);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [voiceDefaults, setVoiceDefaults] = useState<ScoutbotVoiceDefaults | null>(null);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [composeFocusNonce, setComposeFocusNonce] = useState(0);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [switchingSessionId, setSwitchingSessionId] = useState<string | null>(null);
  const clientRef = useRef(getSharedScoutVoiceClient());
  const liveRef = useRef<ScoutVoiceLiveHandle | null>(null);
  const liveCancelReasonRef = useRef<ScoutVoiceCancelReason | null>(null);
  const speechRef = useRef<ScoutSpeechHandle | null>(null);
  const voiceRepliesRef = useRef(voiceReplies);
  voiceRepliesRef.current = voiceReplies;

  const stopSpeech = useCallback(() => {
    speechRef.current?.stop();
    speechRef.current = null;
    setSpeaking(false);
  }, []);

  const runSpeech = useCallback((text: string) => {
    if (!text) return;
    stopSpeech();
    const speech = startScoutSpeechWithEffects(toSpokenScoutText(text), {
      speed: voiceSpeed,
      presetId: voicePresetId,
      params: resolveScoutbotFxParams(voicePresetId, onlineCount),
    });
    speechRef.current = speech;
    setSpeaking(true);
    void speech.promise
      .catch((err) => {
        if (!isScoutSpeechStopped(err)) {
          setError(err instanceof Error ? err.message : "Scout voice speech failed.");
        }
      })
      .finally(() => {
        if (speechRef.current === speech) {
          speechRef.current = null;
          setSpeaking(false);
        }
      });
  }, [stopSpeech, voiceSpeed, onlineCount, voicePresetId]);

  const speakScoutbotText = useCallback((text: string) => {
    if (!voiceRepliesRef.current) return;
    runSpeech(text);
  }, [runSpeech]);

  const replayScoutbotText = useCallback((body: string) => {
    runSpeech(stripScoutbotUiFences(body));
  }, [runSpeech]);

  const { openFilePreview } = useScout();
  const showContextMenu = useContextMenu();
  const onAssistantMessageContextMenu = useCallback(
    (event: React.MouseEvent, body: string) => {
      const sel = window.getSelection()?.toString().trim();
      const text = stripScoutbotUiFences(body);
      const paths = extractAbsoluteFilePaths(text);
      const items: MenuItem[] = [];
      if (sel) {
        items.push({
          kind: "action",
          label: "Copy selection",
          shortcut: "⌘C",
          onSelect: () => {
            void copyTextToClipboard(sel);
          },
        });
        items.push({ kind: "separator" });
      }
      items.push({
        kind: "action",
        label: "Copy message",
        onSelect: () => {
          void copyTextToClipboard(text);
        },
      });
      if (paths.length > 0) {
        items.push({ kind: "separator" });
        for (const path of paths.slice(0, 5)) {
          const display = shortenForMenu(path);
          items.push({
            kind: "action",
            label: `Preview ${display}`,
            onSelect: () => openFilePreview(path),
          });
        }
        for (const path of paths.slice(0, 5)) {
          const display = shortenForMenu(path);
          items.push({
            kind: "action",
            label: `Open ${display} in OS`,
            onSelect: () => {
              void api("/api/file/reveal", {
                method: "POST",
                body: JSON.stringify({ path }),
              }).catch(() => {});
            },
          });
        }
        items.push({
          kind: "action",
          label: paths.length === 1 ? "Copy path" : "Copy first path",
          onSelect: () => {
            void copyTextToClipboard(paths[0]);
          },
        });
      }
      items.push({ kind: "separator" });
      items.push({
        kind: "action",
        label: speaking ? "Say again (stop current)" : "Say",
        onSelect: () => replayScoutbotText(body),
      });
      showContextMenu(event, items);
    },
    [openFilePreview, replayScoutbotText, showContextMenu, speaking],
  );

  useEffect(() => () => {
    stopSpeech();
  }, [stopSpeech]);

  const suggestedPrompts = SCOUTBOT_STARTER_PROMPTS;

  const syncLastMessages = useCallback((session: ScoutbotAssistantSession) => {
    const lastUser = [...session.messages].reverse().find((message) => message.role === "user");
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
    setLastAsk(lastUser?.body ?? null);
    setLastReply(lastAssistant ? stripScoutbotUiFences(lastAssistant.body) : null);
  }, []);

  const loadScoutbotSession = useCallback(async () => {
    try {
      const state = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session");
      setSessionState(state);
      syncLastMessages(state.session);
    } catch {
      setSessionState(null);
    }
  }, [syncLastMessages]);

  useEffect(() => {
    void loadScoutbotSession();
  }, [loadScoutbotSession]);

  const loadScoutbotConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const config = await api<ScoutbotAgentConfig>("/api/scoutbot/config");
      setModelDraft(config.model);
      setPromptDraft(config.systemPrompt);
      setConfigStatus(null);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Could not load settings.");
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    if (settingsOpen) {
      void loadScoutbotConfig();
    }
  }, [loadScoutbotConfig, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    void api<ScoutbotVoiceDefaults>("/api/voice/defaults")
      .then((defaults) => {
        if (!cancelled) {
          setVoiceDefaults(defaults);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVoiceDefaults(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  const saveScoutbotConfig = useCallback(async () => {
    setConfigSaving(true);
    setConfigError(null);
    setConfigStatus(null);
    try {
      const result = await api<ScoutbotAgentConfigUpdateResult>(
        "/api/scoutbot/config",
        {
          method: "POST",
          body: JSON.stringify({
            model: modelDraft,
            systemPrompt: promptDraft,
          }),
        },
      );
      setModelDraft(result.config.model);
      setPromptDraft(result.config.systemPrompt);
      setConfigStatus("Saved");
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setConfigSaving(false);
    }
  }, [modelDraft, promptDraft]);

  const switchScoutbotSession = useCallback(async (id: string) => {
    if (!id || switchingSessionId) return;
    setSwitchingSessionId(id);
    setError(null);
    stopSpeech();
    try {
      const state = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session/switch", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      setSessionState(state);
      syncLastMessages(state.session);
      setSessionPickerOpen(false);
      setChatExpanded(false);
      window.dispatchEvent(new CustomEvent(SCOUTBOT_SESSION_CHANGED_EVENT, { detail: { id: state.session.id } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch session.");
    } finally {
      setSwitchingSessionId(null);
    }
  }, [stopSpeech, switchingSessionId, syncLastMessages]);

  const resetScoutbotSession = useCallback(async () => {
    if (resettingSession || sending) return;
    if (sessionState?.session.messages.length === 0) {
      setDraft("");
      setError(null);
      setChatExpanded(false);
      setSessionPickerOpen(false);
      setAskStatus("New chat ready");
      setComposeFocusNonce((nonce) => nonce + 1);
      return;
    }
    setResettingSession(true);
    setError(null);
    setAskStatus("Starting new chat");
    stopSpeech();
    try {
      const state = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session/reset", { method: "POST" });
      setSessionState(state);
      setDraft("");
      setLastAsk(null);
      setLastReply(null);
      setChatExpanded(false);
      setSessionPickerOpen(false);
      setAskStatus("New chat ready");
      setComposeFocusNonce((nonce) => nonce + 1);
      window.dispatchEvent(new CustomEvent(SCOUTBOT_SESSION_CHANGED_EVENT, { detail: { id: state.session.id } }));
    } catch (err) {
      setAskStatus(null);
      setError(err instanceof Error ? err.message : "Could not start a new chat.");
    } finally {
      setResettingSession(false);
    }
  }, [resettingSession, sending, sessionState, stopSpeech]);

  const archiveScoutbotSession = useCallback(async (id: string) => {
    if (!id || archivingSessionId) return;
    setArchivingSessionId(id);
    setError(null);
    stopSpeech();
    try {
      const state = await api<ScoutbotAssistantSessionState>("/api/scoutbot/session/archive", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      setSessionState(state);
      syncLastMessages(state.session);
      setChatExpanded(false);
      setAskStatus("session archived");
      window.dispatchEvent(new CustomEvent(SCOUTBOT_SESSION_CHANGED_EVENT, { detail: { id: state.session.id } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive session.");
    } finally {
      setArchivingSessionId(null);
    }
  }, [archivingSessionId, stopSpeech, syncLastMessages]);

  const applyProbeState = useCallback((client: ReturnType<typeof getSharedScoutVoiceClient>, ok: boolean) => {
    setVoiceAvailable(ok);
    setVoiceIssue(ok ? null : client.lastUnavailableReason ?? "Scout voice service is not reachable.");
    setVoiceProbeState("idle");
  }, []);

  const probeVoice = useCallback(async (force = false) => {
    const client = clientRef.current;
    setVoiceProbeState((state) => (state === "launching" ? state : "probing"));

    const ok = await client.probe(force ? { force: true } : undefined);
    applyProbeState(client, ok);
    return ok;
  }, [applyProbeState]);

  useEffect(() => {
    ensureScoutVoiceAutoProbe();
    const client = clientRef.current;
    const unsubscribe = subscribeScoutVoiceProbe((snapshot) => {
      setVoiceAvailable(snapshot.ok);
      setVoiceIssue(snapshot.ok ? null : snapshot.reason);
      setVoiceProbeState("idle");
    });

    if (client.connectionState === "unknown") {
      void probeVoice();
    } else {
      applyProbeState(client, client.connectionState === "connected");
    }

    return unsubscribe;
  }, [applyProbeState, probeVoice]);

  const launchScoutVoice = useCallback(() => {
    const client = clientRef.current;
    setError(null);
    setVoiceProbeState("launching");
    void client.launch({ source: "openscout", context: makeScoutAudioLaunchContext() });
    window.setTimeout(() => {
      void probeVoice(true);
    }, 2400);
  }, [probeVoice]);

  const handleScoutbotReply = useCallback((body: string) => {
    const replyText = stripScoutbotUiFences(body);
    setLastReply(replyText);
    for (const action of extractScoutbotUiActions(body)) {
      if (action.type === "ask-agent") {
        setAskStatus(`Sending to ${action.targetLabel}`);
        void api<ScoutbotAskAgentResult>("/api/scoutbot/actions/ask", {
          method: "POST",
          body: JSON.stringify({
            targetLabel: action.targetLabel,
            targetAgentId: action.targetAgentId,
            body: action.body,
            channel: action.channel,
          }),
        }).then((result) => {
          setAskStatus(
            result.flightId
              ? `Sent to ${result.targetAgentId ?? result.targetLabel} · run ${result.flightId}`
              : `Sent to ${result.targetAgentId ?? result.targetLabel}`,
          );
        }).catch((err) => {
          setAskStatus(null);
          setError(err instanceof Error ? err.message : "Could not send to agent.");
        });
      } else if (action.type !== "reminder") {
        applyScoutbotUiAction(action);
      }
    }
    speakScoutbotText(replyText);
  }, [applyScoutbotUiAction, speakScoutbotText]);

  useEffect(() => {
    const handleRealtimeReply = () => {
      setAskStatus("Scoutbot replied by voice");
      void loadScoutbotSession();
    };
    const handleSessionChange = () => {
      setAskStatus("Scoutbot chat changed");
      void loadScoutbotSession();
    };
    window.addEventListener(SCOUTBOT_REALTIME_REPLY_EVENT, handleRealtimeReply);
    window.addEventListener(SCOUTBOT_SESSION_CHANGED_EVENT, handleSessionChange);
    return () => {
      window.removeEventListener(SCOUTBOT_REALTIME_REPLY_EVENT, handleRealtimeReply);
      window.removeEventListener(SCOUTBOT_SESSION_CHANGED_EVENT, handleSessionChange);
    };
  }, [loadScoutbotSession]);

  const askScoutbot = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    setLastAsk(trimmed);
    setLastReply(null);
    setAskStatus("Sending");
    setDraft((current) => current.trim() === trimmed ? "" : current);
    try {
      await ensureOpenAIKeyOnServer().catch(() => null);
      const result = await api<ScoutbotAssistantReply>("/api/scoutbot/chat", {
        method: "POST",
        body: JSON.stringify({
          body: trimmed,
          route,
          uiContext: scoutbotUiContext("web"),
        }),
      });
      setSessionState({
        session: result.session,
        sessions: result.sessions,
        config: result.config,
      });
      setAskStatus("Reply received");
      handleScoutbotReply(result.reply.body);
    } catch (err) {
      setAskStatus(null);
      setError(err instanceof Error ? err.message : "Could not send.");
    } finally {
      setSending(false);
    }
  }, [handleScoutbotReply, route, sending]);

  const startVoice = useCallback(async () => {
    if (recording) return;
    const client = clientRef.current;
    liveCancelReasonRef.current = null;
    setError(null);
    setPartial("");
    setVoiceState("starting");

    if (voiceAvailable !== true) {
      const ok = await probeVoice(true);
      if (!ok) {
        setVoiceState(null);
        return;
      }
    }

    let live: ScoutVoiceLiveHandle | null = null;
    let released = false;
    const cleanupLive = async () => {
      if (!live || released) return;
      released = true;
      await releaseScoutVoiceLive(live, { allowCurrentSession: liveRef.current === live });
      if (liveRef.current === live) {
        liveRef.current = null;
      }
    };

    try {
      live = await client.startLive({
        onState: setVoiceState,
        onPartial: setPartial,
      });
      liveRef.current = live;
      setRecording(true);
      const final = await live.result;
      await cleanupLive();
      setRecording(false);
      setPartial("");
      if (liveCancelReasonRef.current) {
        return;
      }
      setVoiceState("done");
      if (final.text) {
        await askScoutbot(final.text);
      }
    } catch (err) {
      const cancelReason = liveCancelReasonRef.current;
      const wasCancellation = Boolean(cancelReason) || isScoutVoiceCancellation(err);
      await cleanupLive();
      setRecording(false);
      setPartial("");
      if (cancelReason === "stop-failed") {
        return;
      }
      setVoiceState(wasCancellation ? null : "error");
      if (!wasCancellation) {
        setError(err instanceof Error ? err.message : "Scout voice recording failed.");
      }
    } finally {
      await cleanupLive();
      liveCancelReasonRef.current = null;
    }
  }, [askScoutbot, probeVoice, recording, voiceAvailable]);

  const stopVoice = useCallback(async () => {
    const live = liveRef.current;
    if (!live) return;
    setVoiceState("processing");
    try {
      await withTimeout(
        live.stop(),
        SCOUT_VOICE_STOP_TIMEOUT_MS,
        "Scout voice did not finish processing the recording.",
      );
    } catch (err) {
      liveCancelReasonRef.current = "stop-failed";
      await releaseScoutVoiceLive(live, { allowCurrentSession: true });
      if (liveRef.current === live) {
        liveRef.current = null;
        setRecording(false);
        setPartial("");
        setVoiceState("error");
      }
      setError(err instanceof Error ? `Scout voice recording did not finish: ${err.message}` : "Scout voice recording did not finish.");
    }
  }, []);

  useEffect(() => {
    const openHandler = () => setCollapsed(false);
    window.addEventListener("scout:scoutbot-panel-open", openHandler);
    return () => window.removeEventListener("scout:scoutbot-panel-open", openHandler);
  }, [setCollapsed]);

  useEffect(
    () => onToggleScoutbot(() => setCollapsed(!collapsed)),
    [collapsed, setCollapsed],
  );

  useEffect(() => {
    const submitHandler = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const body = detail && typeof detail === "object" && "body" in detail
        ? (detail as { body?: unknown }).body
        : null;
      if (typeof body === "string" && body.trim()) {
        setCollapsed(false);
        void askScoutbot(body);
      }
    };
    window.addEventListener(SCOUTBOT_SUBMIT_EVENT, submitHandler);
    return () => window.removeEventListener(SCOUTBOT_SUBMIT_EVENT, submitHandler);
  }, [askScoutbot, setCollapsed]);

  useEffect(() => {
    const composeHandler = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const body = detail && typeof detail === "object" && "body" in detail
        ? (detail as { body?: unknown }).body
        : null;
      if (typeof body === "string" && body.trim()) {
        setCollapsed(false);
        setDraft(body);
        setComposeFocusNonce((nonce) => nonce + 1);
      }
    };
    window.addEventListener("scout:scoutbot-compose", composeHandler);
    return () => window.removeEventListener("scout:scoutbot-compose", composeHandler);
  }, [setCollapsed]);

  const scoutbotPublicState = useMemo<ScoutbotPublicState>(() => {
    const activity: ScoutbotActivity = speaking
      ? "speaking"
      : sending
        ? "thinking"
        : recording
          ? "listening"
          : "idle";
    const session = sessionState?.session ?? null;
    const lastMessage = session && session.messages.length > 0
      ? session.messages[session.messages.length - 1]
      : null;
    return {
      activity,
      brief: { lastDeliveredAt: null },
      reminders: {
        dueCount: 0,
        upcomingCount: 0,
        due: [],
        next: null,
      },
      voice: {
        available: voiceAvailable,
        setupBlocked: voiceAvailable === false,
        replies: voiceReplies,
      },
      error,
      session: {
        title: session?.title ?? null,
        lastActivityAt: lastMessage?.createdAt ?? session?.updatedAt ?? null,
      },
      // SCO-085: shell-readable emptiness (panel children unmount when collapsed).
      conversation: {
        messageCount: session?.messages.length ?? 0,
        loading: sessionState === null,
      },
    };
  }, [
    speaking,
    sending,
    recording,
    voiceAvailable,
    voiceReplies,
    error,
    sessionState,
  ]);

  useEffect(() => {
    publisher?.publishState(scoutbotPublicState);
  }, [publisher, scoutbotPublicState]);

  useEffect(() => {
    if (!publisher) return;
    const actions: ScoutbotActionApi = {
      focusScoutbot: () => setCollapsed(false),
      triggerBrief: () => {
        setCollapsed(false);
        setComposeFocusNonce((nonce) => nonce + 1);
      },
      triggerAskState: () => {
        setCollapsed(false);
        setComposeFocusNonce((nonce) => nonce + 1);
      },
      toggleVoiceReplies: () => {
        const next = !voiceReplies;
        setVoiceReplies(next);
        if (!next) stopSpeech();
      },
      openScoutbotSettings: () => {
        setCollapsed(false);
        setSettingsOpen(true);
      },
      startNewChat: () => {
        setCollapsed(false);
        if (!resettingSession) {
          void resetScoutbotSession();
        }
      },
      dismissReminder: () => undefined,
      askReminderStatus: () => {
        setCollapsed(false);
        setComposeFocusNonce((nonce) => nonce + 1);
      },
    };
    publisher.registerActions(actions);
  }, [
    publisher,
    setCollapsed,
    voiceReplies,
    setVoiceReplies,
    stopSpeech,
    setSettingsOpen,
    resettingSession,
    resetScoutbotSession,
  ]);

  useEffect(() => {
    if (voiceAvailable === true) {
      setVoiceSetupOpen(false);
    }
  }, [voiceAvailable]);

  const voiceLabel = realtimeLive
    ? "Live call"
    : recording
      ? voiceState === "processing" ? "Sending" : "Stop"
      : voiceProbeState === "probing" ? "Checking Voice"
      : voiceProbeState === "launching" ? "Opening Scout"
      : voiceAvailable === false ? "Open Scout" : "Start Talking";
  const isEmptyChat = sessionState !== null
    && sessionState.session.messages.length === 0
    && !sending;
  if (collapsed && !forceExpanded) {
    return (
      <div className="flex shrink-0 items-center border-t border-[var(--scout-chrome-border-soft)] px-3 py-1.5">
        <ScoutbotBroadcastChip />
      </div>
    );
  }

  const expandedClassName = fill
    ? "flex h-full min-h-0 flex-col overflow-hidden border-t border-[var(--scout-chrome-border-soft)]"
    : height === undefined
      ? "flex max-h-[60vh] shrink-0 flex-col overflow-hidden border-t border-[var(--scout-chrome-border-soft)]"
      : "flex shrink-0 flex-col overflow-hidden border-t border-[var(--scout-chrome-border-soft)]";
  const expandedStyle = height === undefined || fill ? undefined : { height: `${height}px` };

  return (
    <section className={expandedClassName} style={expandedStyle}>
      <div className="flex shrink-0 flex-col gap-2 px-3 pt-2.5 pb-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bot size={20} className="shrink-0 text-lime-300" aria-hidden="true" />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <ScoutbotIconButton
            icon={voiceReplies ? <Volume2 size={11} /> : <VolumeX size={11} />}
            title={
              realtimeLive
                ? voiceReplies
                  ? "Voice replies on for typed chat (live call has its own audio)"
                  : "Voice replies off for typed chat (live call has its own audio)"
                : voiceReplies
                  ? "Voice replies on (click to mute)"
                  : "Voice replies off (click to enable)"
            }
            onClick={() => {
              const next = !voiceReplies;
              setVoiceReplies(next);
              if (!next) stopSpeech();
            }}
            active={voiceReplies}
          />
          {!forceExpanded && (
            <ScoutbotIconButton
              icon={<ChevronDown size={11} />}
              title="Minimize"
              onClick={() => setCollapsed(true)}
            />
          )}
        </div>
      </div>

      {settingsOpen && (
        <ScoutbotSettingsPanel
          voicePresetId={voicePresetId}
          onVoicePresetId={setVoicePresetId}
          voiceDefaults={voiceDefaults}
          modelDraft={modelDraft}
          onModelDraft={setModelDraft}
          promptDraft={promptDraft}
          onPromptDraft={setPromptDraft}
          configLoading={configLoading}
          configSaving={configSaving}
          configError={configError}
          configStatus={configStatus}
          onSave={() => void saveScoutbotConfig()}
          onReload={() => void loadScoutbotConfig()}
        />
      )}

      </div>{/* /top stack */}

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-1.5">
        {sessionState && (
          <ChatHistory
            state={sessionState}
            chatExpanded={chatExpanded}
            onToggleExpanded={() => setChatExpanded((v) => !v)}
            sessionPickerOpen={sessionPickerOpen}
            onToggleSessionPicker={() => setSessionPickerOpen((v) => !v)}
            onStartNewChat={() => void resetScoutbotSession()}
            startingNewChat={resettingSession}
            onSwitchSession={(id) => void switchScoutbotSession(id)}
            switchingSessionId={switchingSessionId}
            sending={sending}
            briefing={false}
            pendingAsk={sending ? lastAsk : null}
            onArchiveSession={(id) => void archiveScoutbotSession(id)}
            archivingSessionId={archivingSessionId}
            onAssistantContextMenu={onAssistantMessageContextMenu}
            suggestedPrompts={suggestedPrompts}
            onSelectPrompt={(prompt) => {
              setDraft(prompt);
              setChatExpanded(false);
            }}
          />
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-t border-[var(--scout-chrome-border-soft)] bg-black/10 px-3 pt-2 pb-2.5">
        {voiceAvailable === false && voiceSetupOpen && !realtimeLive && (
          <ScoutVoiceSetupPanel
            issue={voiceIssue}
            probeState={voiceProbeState}
            onLaunch={launchScoutVoice}
            onRetry={() => void probeVoice(true)}
            onSettings={() => setSettingsOpen(true)}
            onDismiss={() => setVoiceSetupOpen(false)}
          />
        )}

        {(partial || speaking) && !realtimeLive && (
          <div className="flex items-center justify-between gap-2 rounded border border-[var(--scout-chrome-border-soft)] bg-black/10 px-2.5 py-2 font-mono text-xs leading-relaxed text-[var(--scout-chrome-ink-faint)]">
            <span className="min-w-0 truncate">{speaking ? "Speaking reply…" : partial}</span>
            {speaking && (
              <button
                type="button"
                title="Stop spoken reply"
                onClick={stopSpeech}
                className="shrink-0 rounded border border-[var(--scout-chrome-border-soft)] p-1 text-[var(--scout-chrome-ink)] hover:bg-[var(--scout-chrome-hover)]"
              >
                <Square size={11} className="fill-current" />
              </button>
            )}
          </div>
        )}

        {askStatus && !sending && (
          <div className="font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
            {askStatus}
          </div>
        )}

        <ChatInput
          agents={agents}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={() => void askScoutbot(draft)}
          sending={sending}
          recording={recording}
          voiceLabel={voiceLabel}
          voiceBusy={voiceState === "processing" || voiceProbeState === "probing" || voiceProbeState === "launching"}
          voiceUnavailable={voiceAvailable === false}
          voiceHeld={realtimeLive}
          onMicClick={() => {
            if (realtimeLive) return;
            if (voiceAvailable === false) {
              setVoiceSetupOpen(true);
              return;
            }
            void (recording ? stopVoice() : startVoice());
          }}
          prominent={isEmptyChat && !realtimeLive}
          autoFocus={forceExpanded}
          focusSignal={composeFocusNonce}
        />

        {error && (
          <div className="rounded border border-red-400/30 bg-red-400/10 px-2.5 py-2 font-mono text-xs leading-relaxed text-red-200">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
