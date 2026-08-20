import { Loader2 } from "lucide-react";
import { VOICE_FX_PRESETS } from "@voxd/client/fx";
import type { ScoutbotVoiceDefaults } from "./scoutbot-model.ts";

export function ScoutbotSettingsPanel({
  voicePresetId,
  onVoicePresetId,
  voiceDefaults,
  modelDraft,
  onModelDraft,
  promptDraft,
  onPromptDraft,
  configLoading,
  configSaving,
  configError,
  configStatus,
  onSave,
  onReload,
}: {
  voicePresetId: string;
  onVoicePresetId: (value: string) => void;
  voiceDefaults: ScoutbotVoiceDefaults | null;
  modelDraft: string;
  onModelDraft: (value: string) => void;
  promptDraft: string;
  onPromptDraft: (value: string) => void;
  configLoading: boolean;
  configSaving: boolean;
  configError: string | null;
  configStatus: string | null;
  onSave: () => void;
  onReload: () => void;
}) {
  return (
    <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-black/10 p-3">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          Voice FX
          <select
            value={voicePresetId}
            onChange={(event) => onVoicePresetId(event.target.value)}
            className="rounded border border-[var(--scout-chrome-border-soft)] bg-black/20 px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)]"
          >
            {VOICE_FX_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — {preset.family}
              </option>
            ))}
          </select>
          <span className="font-mono text-2xs normal-case leading-relaxed tracking-normal text-[var(--scout-chrome-ink-ghost)]">
            {VOICE_FX_PRESETS.find((preset) => preset.id === voicePresetId)?.description
              ?? "Custom voice mood for spoken replies."}
          </span>
        </label>
        <div className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          Scout Voice
          <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-black/20 px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)]">
            {voiceDefaults
              ? `${voiceDefaults.modelId}${voiceDefaults.voiceId ? ` / ${voiceDefaults.voiceId}` : ""}`
              : "Unavailable"}
          </div>
        </div>
        <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          Preferred model
          <input
            value={modelDraft}
            onChange={(event) => onModelDraft(event.target.value)}
            placeholder="gpt-4.1-mini"
            className="rounded border border-[var(--scout-chrome-border-soft)] bg-black/20 px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)]"
            disabled={configLoading || configSaving}
          />
        </label>
        <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          System Prompt
          <textarea
            value={promptDraft}
            onChange={(event) => onPromptDraft(event.target.value)}
            rows={6}
            className="w-full resize-y rounded border border-[var(--scout-chrome-border-soft)] bg-black/20 px-2 py-1.5 font-mono text-xs normal-case leading-relaxed tracking-normal text-[var(--scout-chrome-ink)]"
            disabled={configLoading || configSaving}
          />
        </label>
        {configError && (
          <div className="font-mono text-xs leading-relaxed text-red-300">
            {configError}
          </div>
        )}
        {configStatus && (
          <div className="font-mono text-xs leading-relaxed text-lime-200">
            {configStatus}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={configLoading || configSaving || !promptDraft.trim()}
            className="flex items-center justify-center gap-2 rounded bg-lime-300/90 px-2.5 py-2 font-mono text-xs font-bold uppercase tracking-[0.12em] text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {(configLoading || configSaving) && <Loader2 size={13} className="animate-spin" />}
            {configSaving ? "Saving" : "Save"}
          </button>
          <button
            type="button"
            onClick={onReload}
            disabled={configLoading || configSaving}
            className="rounded border border-[var(--scout-chrome-border-soft)] px-2.5 py-2 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
