import type { ReactNode } from "react";
import { Loader2, RefreshCw, Rocket, Settings, X } from "lucide-react";
import type { VoiceProbeState } from "./scoutbot-model.ts";

export function ScoutbotIconButton({
  icon,
  title,
  onClick,
  disabled,
  active,
  badge,
}: {
  icon: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  badge?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex shrink-0 items-center gap-1 rounded border p-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-lime-300/50 bg-lime-300/10 text-lime-200"
          : "border-[var(--scout-chrome-border-soft)] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
      }`}
    >
      {icon}
      {badge && <span className="font-mono text-3xs tracking-tight">{badge}</span>}
    </button>
  );
}

export function ScoutbotActionButton({
  icon,
  label,
  title,
  onClick,
  disabled,
  compact = false,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-8 items-center justify-center gap-1.5 rounded border border-[var(--scout-chrome-border-soft)] font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink)] transition-colors hover:bg-[var(--scout-chrome-hover)] disabled:cursor-not-allowed disabled:opacity-45 ${
        compact ? "w-8 shrink-0 px-0" : "min-w-0 flex-1 px-2"
      }`}
    >
      {icon}
      {!compact && <span className="truncate">{label}</span>}
    </button>
  );
}

export function ScoutVoiceSetupPanel({
  issue,
  probeState,
  onLaunch,
  onRetry,
  onSettings,
  onDismiss,
}: {
  issue: string | null;
  probeState: VoiceProbeState;
  onLaunch: () => void;
  onRetry: () => void;
  onSettings: () => void;
  onDismiss?: () => void;
}) {
  const isBusy = probeState === "probing" || probeState === "launching";

  return (
    <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-black/15 px-2.5 py-2 font-mono text-xs text-[var(--scout-chrome-ink)]">
      <div className="flex items-start gap-2">
        <Rocket size={13} className="mt-0.5 shrink-0 text-[var(--scout-chrome-ink-faint)]" />
        <div className="min-w-0 flex-1">
          <div className="uppercase tracking-[0.14em] text-[var(--scout-chrome-ink-faint)]">Scout Voice</div>
          <p className="mt-1 leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
            Open Scout Menu to use speech.
          </p>
          {issue && (
            <p className="mt-2 break-words leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
              {issue}
            </p>
          )}
        </div>
        {onDismiss ? (
          <button
            type="button"
            title="Hide voice setup"
            aria-label="Hide voice setup"
            onClick={onDismiss}
            className="shrink-0 rounded border border-transparent p-1 text-[var(--scout-chrome-ink-ghost)] transition-colors hover:border-[var(--scout-chrome-border-soft)] hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
          >
            <X size={11} />
          </button>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <ScoutVoiceSetupButton
          icon={probeState === "launching" ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />}
          label={probeState === "launching" ? "Opening" : "Open"}
          onClick={onLaunch}
          disabled={probeState === "probing"}
          title="Open Scout services"
        />
        <ScoutVoiceSetupButton
          icon={probeState === "probing" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          label="Retry"
          onClick={onRetry}
          disabled={isBusy}
          title="Check Scout voice again"
        />
        <ScoutVoiceSetupButton
          icon={<Settings size={12} />}
          label="Voice"
          onClick={onSettings}
          disabled={probeState === "probing"}
          title="Open Scoutbot voice settings"
        />
      </div>
    </div>
  );
}

function ScoutVoiceSetupButton({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-7 items-center justify-center gap-1.5 rounded border border-[var(--scout-chrome-border-soft)] px-2 text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      {icon}
      {label}
    </button>
  );
}
