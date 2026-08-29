import { useOptionalFlag } from "hudsonkit/flags";
import { useEffect, useRef, useState } from "react";

import {
  SCOUT_REALTIME_VOICE_FLAG,
  SCOUT_REALTIME_VOICE_STOP_EVENT,
} from "../../../shared/realtime-voice.ts";
import {
  ScoutbotRealtimeVoiceCall,
  ScoutbotRealtimeVoiceCallHeader,
} from "../../scout/scoutbot/ScoutbotRealtimeVoiceCall.tsx";
import { useScoutbotRealtimeVoice } from "../../scout/scoutbot/ScoutbotRealtimeVoiceContext.tsx";
import { ScoutbotPanel } from "../../scout/scoutbot/ScoutbotPanel.tsx";
import { defineSurface } from "../../surfaces/types.ts";

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

/** Routed voice workspace. Direct, turn-based voice is the default; GPT Live remains available as a separate mode. */
export function RealtimeVoicePage() {
  const enabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, true);
  const { enabled: operatorEnabled, state } = useScoutbotRealtimeVoice();
  const [mode, setMode] = useState<"direct" | "realtime">("direct");
  const realtimeReady = enabled && operatorEnabled;

  if (mode === "direct") {
    return (
      <main className="h-full min-h-0 overflow-hidden bg-[#f3f0e9]">
        <ScoutbotPanel
          forceExpanded
          fill
          presentation="direct-voice"
          onOpenLive={() => setMode("realtime")}
        />
      </main>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--scout-chrome-bg)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--scout-chrome-border-soft)] px-4 py-2.5 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate font-[var(--font-accent-title)] text-[17px] font-semibold tracking-[-0.018em] text-[var(--scout-chrome-ink-strong)]">
            GPT Live
          </h1>
          <span className="hidden h-4 w-px bg-[var(--scout-chrome-border-soft)] sm:block" aria-hidden="true" />
          <span className="hidden items-center gap-2 text-xs text-[var(--scout-chrome-ink-faint)] sm:flex">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                realtimeReady ? "bg-[var(--scout-accent)]" : "bg-[var(--scout-chrome-ink-ghost)]"
              }`}
              aria-hidden="true"
            />
            {realtimeReady ? "Ready for a live call" : "Live voice unavailable"}
          </span>
        </div>
        <div
          className="flex rounded-md border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] p-0.5"
          role="tablist"
          aria-label="Voice mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected="false"
            onClick={() => setMode("direct")}
            className="rounded-[4px] px-3 py-1.5 text-[11px] font-medium text-[var(--scout-chrome-ink-faint)] transition-colors hover:text-[var(--scout-chrome-ink-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--scout-accent)]"
          >
            Direct
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="rounded-[4px] bg-[var(--scout-chrome-ink-strong)] px-3 py-1.5 text-[11px] font-medium text-[var(--scout-chrome-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
          >
            Live
          </button>
        </div>
      </header>
      <section className="min-h-0 flex-1 overflow-hidden">
        {realtimeReady ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <ScoutbotRealtimeVoiceCallHeader state={state} layout="page" />
            <ScoutbotRealtimeVoiceCall dictationActive={false} layout="page" />
          </div>
        ) : (
          <RealtimeVoiceScreen />
        )}
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
