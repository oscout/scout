import { Loader2, Play } from "lucide-react";
import { useOptionalFlag } from "hudsonkit/flags";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SCOUT_REALTIME_VOICE_FLAG } from "../../../shared/realtime-voice.ts";
import {
  ScoutbotRealtimeVoiceCall,
  ScoutbotRealtimeVoiceCallHeader,
} from "./ScoutbotRealtimeVoiceCall.tsx";
import { useScoutbotRealtimeVoice } from "./ScoutbotRealtimeVoiceContext.tsx";
import { useScout } from "../Provider.tsx";

export function ScoutbotRealtimeVoice({
  dictationActive,
}: {
  dictationActive: boolean;
}) {
  const enabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, false);
  // The chip owns the trigger and the popover shell; call state and controls
  // live in ScoutbotRealtimeVoiceCall, shared with the macOS embed.
  const { open, setOpen, state } = useScoutbotRealtimeVoice();
  const { navigate } = useScout();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ left: 12, bottom: 36 });

  useEffect(() => () => setOpen(false), [setOpen]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, setOpen]);

  useLayoutEffect(() => {
    if (!open) return;
    const positionPopover = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const popoverWidth = Math.min(384, window.innerWidth - 16);
      setPopoverPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8)),
        bottom: Math.max(36, window.innerHeight - rect.top + 8),
      });
    };
    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [open]);

  if (!enabled) return null;

  const active = state === "connecting" || state === "live";
  const title = active
    ? state === "connecting"
      ? "Scoutbot voice is connecting"
      : "Scoutbot voice is live"
    : open
      ? "Hide Scoutbot voice"
      : "Open Scoutbot voice controls";
  const portalHost = typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-scout-theme]") ?? document.body;

  return (
    <div className="flex items-center">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-controls="scoutbot-realtime-voice-menu"
        className={`flex h-[18px] items-center gap-1.5 rounded border px-1.5 font-mono text-2xs uppercase tracking-[0.1em] transition-colors ${
          state === "live"
            ? "border-lime-300/35 bg-lime-300/[0.08] text-lime-100"
            : state === "connecting"
              ? "border-amber-300/30 bg-amber-300/[0.07] text-amber-100/90"
              : state === "error"
                ? "border-red-400/30 bg-red-400/[0.07] text-red-100"
                : open
                  ? "border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] text-[var(--scout-chrome-ink)]"
                  : "border-transparent text-[var(--scout-chrome-ink-faint)] hover:text-[var(--scout-chrome-ink)]"
        }`}
      >
        {state === "connecting" ? (
          <Loader2 size={10} className="animate-spin" aria-hidden="true" />
        ) : state === "live" ? (
          <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-lime-300/30" />
            <span className="relative inline-flex size-1.5 rounded-full bg-lime-300/90" />
          </span>
        ) : (
          <Play size={10} fill="currentColor" aria-hidden="true" />
        )}
        <span>{state === "live" ? "Voice live" : state === "connecting" ? "Voice connecting" : "Voice"}</span>
      </button>

      {open && portalHost && createPortal(
        <>
          <div
            className="fixed inset-0 z-[80]"
            aria-hidden="true"
            onMouseDown={() => setOpen(false)}
          />
          <div
            id="scoutbot-realtime-voice-menu"
            className="fixed z-[81] flex h-[min(31rem,calc(100vh-3rem))] min-h-80 w-[min(24rem,calc(100vw-1rem))] min-w-80 resize flex-col overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--hud-ink)_13%,transparent)] bg-[color-mix(in_srgb,var(--scout-chrome-bg)_96%,black)] shadow-[0_18px_44px_rgba(0,0,0,0.46)] backdrop-blur-md"
            style={{ left: popoverPosition.left, bottom: popoverPosition.bottom }}
            role="dialog"
            aria-label="Scoutbot live voice"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <ScoutbotRealtimeVoiceCallHeader
              state={state}
              onExpand={() => {
                setOpen(false);
                navigate({ view: "voice" });
              }}
            />

            <ScoutbotRealtimeVoiceCall dictationActive={dictationActive} />

          </div>
        </>,
        portalHost,
      )}
    </div>
  );
}
