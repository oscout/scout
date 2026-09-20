import { Loader2 } from "lucide-react";
import { VOICE_FX_PRESETS } from "@voxd/client/fx";
import type { ScoutbotVoiceDefaults } from "./scoutbot-model.ts";
import {
  SCOUTBOT_SPEECH_PROFILES,
  SCOUTBOT_SPEECH_PROVIDER_LABELS,
  type ScoutbotSpeechSelectionId,
} from "./scoutbot-voice-profiles.ts";

export function ScoutbotSettingsPanel({
  presentation,
  voicePresetId,
  onVoicePresetId,
  speechSelectionId,
  onSpeechSelectionId,
  customSpeechModelId,
  onCustomSpeechModelId,
  customSpeechVoiceId,
  onCustomSpeechVoiceId,
  customSpeechInstructions,
  onCustomSpeechInstructions,
  voiceDefaults,
  modelDraft,
  onModelDraft,
  modelOptions = [],
  promptDraft,
  onPromptDraft,
  configLoading,
  configSaving,
  configError,
  configStatus,
  onSave,
  onReload,
}: {
  presentation: "chat" | "direct-voice";
  voicePresetId: string;
  onVoicePresetId: (value: string) => void;
  speechSelectionId: ScoutbotSpeechSelectionId;
  onSpeechSelectionId: (value: ScoutbotSpeechSelectionId) => void;
  customSpeechModelId: string;
  onCustomSpeechModelId: (value: string) => void;
  customSpeechVoiceId: string;
  onCustomSpeechVoiceId: (value: string) => void;
  customSpeechInstructions: string;
  onCustomSpeechInstructions: (value: string) => void;
  voiceDefaults: ScoutbotVoiceDefaults | null;
  modelDraft: string;
  onModelDraft: (value: string) => void;
  modelOptions?: { id: string; label: string }[];
  promptDraft: string;
  onPromptDraft: (value: string) => void;
  configLoading: boolean;
  configSaving: boolean;
  configError: string | null;
  configStatus: string | null;
  onSave: () => void;
  onReload: () => void;
}) {
  const directVoice = presentation === "direct-voice";

  return (
    <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--hud-surface)] p-3">
      <div className="flex flex-col gap-3">
        {directVoice ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
              Scout voice
            </legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Scout voice">
              {SCOUTBOT_SPEECH_PROFILES.map((profile) => {
                const selected = speechSelectionId === profile.id;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onSpeechSelectionId(profile.id)}
                    className={`min-h-20 rounded border p-2.5 text-left transition ${
                      selected
                        ? "border-[var(--hud-accent)] bg-[var(--hud-accent-soft)] text-[var(--scout-chrome-ink)]"
                        : "border-[var(--scout-chrome-border-soft)] bg-[var(--hud-bg)] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)]"
                    }`}
                  >
                    <span className="block font-mono text-xs font-bold uppercase tracking-[0.1em]">
                      {profile.label}
                    </span>
                    <span className="mt-1 block font-mono text-2xs leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
                      {profile.voiceName} · {profile.description}
                    </span>
                    <span className="mt-1 block font-mono text-2xs leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
                      {SCOUTBOT_SPEECH_PROVIDER_LABELS[profile.provider]} · {profile.speech.modelId} · {profile.speech.voiceId}
                    </span>
                    {profile.accentFromPrompt && (
                      <span className="mt-1 block font-mono text-2xs leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
                        Accent is prompted, not a separate voice.
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              role="radio"
              aria-checked={speechSelectionId === "device"}
              onClick={() => onSpeechSelectionId("device")}
              className={`rounded border px-2.5 py-2 text-left font-mono text-xs transition ${
                speechSelectionId === "device"
                  ? "border-[var(--hud-accent)] bg-[var(--hud-accent-soft)] text-[var(--scout-chrome-ink)]"
                  : "border-[var(--scout-chrome-border-soft)] bg-[var(--hud-bg)] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)]"
              }`}
            >
              <span className="block font-bold uppercase tracking-[0.1em]">This Mac&apos;s voice</span>
              <span className="mt-1 block leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
                Speaks through Scout Menu in its own Settings &rsaquo; Voice pick. The only way to hear installed voices such as Kokoro.
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={speechSelectionId === "custom"}
              onClick={() => onSpeechSelectionId("custom")}
              className={`rounded border px-2.5 py-2 text-left font-mono text-xs transition ${
                speechSelectionId === "custom"
                  ? "border-[var(--hud-accent)] bg-[var(--hud-accent-soft)] text-[var(--scout-chrome-ink)]"
                  : "border-[var(--scout-chrome-border-soft)] bg-[var(--hud-bg)] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)]"
              }`}
            >
              <span className="block font-bold uppercase tracking-[0.1em]">Custom voice</span>
              <span className="mt-1 block leading-relaxed text-[var(--scout-chrome-ink-ghost)]">Use any supported model, voice, and style.</span>
            </button>
            {speechSelectionId === "custom" && (
              <div className="grid gap-2 rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--hud-bg)] p-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                    Speech model
                    <input
                      value={customSpeechModelId}
                      onChange={(event) => onCustomSpeechModelId(event.target.value)}
                      placeholder="gpt-4o-mini-tts"
                      className={`rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] bg-[var(--hud-bg)]`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                    Voice ID
                    <input
                      value={customSpeechVoiceId}
                      onChange={(event) => onCustomSpeechVoiceId(event.target.value)}
                      placeholder="marin"
                      className={`rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] bg-[var(--hud-bg)]`}
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                  Speaking style
                  <textarea
                    value={customSpeechInstructions}
                    onChange={(event) => onCustomSpeechInstructions(event.target.value)}
                    rows={3}
                    placeholder="Speak naturally, clearly, and conversationally."
                    className={`w-full resize-y rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case leading-relaxed tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] bg-[var(--hud-bg)]`}
                  />
                </label>
              </div>
            )}
            <p className="font-mono text-2xs normal-case leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
              Request-based TTS, separate from GPT Live. Replies are AI-generated speech.
            </p>
          </fieldset>
        ) : (
          <>
            <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
              Voice FX
              <select
                value={voicePresetId}
                onChange={(event) => onVoicePresetId(event.target.value)}
                className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--hud-bg)] px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)]"
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
              <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--hud-bg)] px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)]">
                {voiceDefaults
                  ? `${voiceDefaults.modelId}${voiceDefaults.voiceId ? ` / ${voiceDefaults.voiceId}` : ""}`
                  : "Unavailable"}
              </div>
            </div>
          </>
        )}
        <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          Preferred model
          {modelOptions.length > 0 ? (
            <select
              value={modelDraft}
              onChange={(event) => onModelDraft(event.target.value)}
              className={`rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)] bg-[var(--hud-bg)]`}
              disabled={configLoading || configSaving}
            >
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={modelDraft}
              onChange={(event) => onModelDraft(event.target.value)}
              placeholder="gpt-5.6-luna"
              className={`rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] bg-[var(--hud-bg)]`}
              disabled={configLoading || configSaving}
            />
          )}
        </label>
        <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          System Prompt
          <textarea
            value={promptDraft}
            onChange={(event) => onPromptDraft(event.target.value)}
            rows={6}
            className={`w-full resize-y rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case leading-relaxed tracking-normal text-[var(--scout-chrome-ink)] bg-[var(--hud-bg)]`}
            disabled={configLoading || configSaving}
          />
        </label>
        {configError && (
          <div className="font-mono text-xs leading-relaxed text-[var(--hud-status-error)]">
            {configError}
          </div>
        )}
        {configStatus && (
          <div className="font-mono text-xs leading-relaxed text-[var(--hud-accent)]">
            {configStatus}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={configLoading || configSaving || !promptDraft.trim()}
            className="flex items-center justify-center gap-2 rounded bg-[var(--hud-accent)] px-2.5 py-2 font-mono text-xs font-bold uppercase tracking-[0.12em] text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
