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
  const enabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, false);
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
          Turn on the <span className="font-mono">{SCOUT_REALTIME_VOICE_FLAG}</span> flag to hold live
          conversations with Scoutbot. Calls use the configured OpenAI API account.
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

/** Full routed workspace for longer calls and a readable, scrollable audit trail. */
export function RealtimeVoicePage() {
  const enabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, false);
  const { enabled: operatorEnabled, state } = useScoutbotRealtimeVoice();

  if (!enabled || !operatorEnabled) {
    return <RealtimeVoiceScreen />;
  }

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--scout-chrome-bg)]">
      <div className="border-b border-[var(--scout-chrome-border-soft)] px-6 py-5">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--scout-chrome-ink-faint)]">
          Scoutbot
        </p>
        <h1 className="mt-1 text-3xl font-medium text-[var(--scout-chrome-ink-strong)]">Live voice</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--scout-chrome-ink-faint)]">
          Hold a live conversation, inspect navigation attempts, and audit what Scoutbot tried without leaving the call.
        </p>
      </div>
      <div className="min-h-0 flex-1 p-5">
        <section className="mx-auto flex h-full min-h-[26rem] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--hud-ink)_11%,transparent)] bg-[color-mix(in_srgb,var(--scout-chrome-bg)_96%,black)] shadow-[0_18px_48px_rgba(0,0,0,0.24)]">
          <ScoutbotRealtimeVoiceCallHeader state={state} layout="page" />
          <ScoutbotRealtimeVoiceCall dictationActive={false} layout="page" />
        </section>
      </div>
    </main>
  );
}

export const scoutSurface = defineSurface({
  id: "voice",
  label: "Live voice",
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
