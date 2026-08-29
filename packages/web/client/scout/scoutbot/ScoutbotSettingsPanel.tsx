import { Loader2 } from "lucide-react";
import { VOICE_FX_PRESETS } from "@voxd/client/fx";
import type { ScoutbotVoiceDefaults } from "./scoutbot-model.ts";
import {
  SCOUTBOT_SPEECH_PROFILES,
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
    <div className={`rounded border border-[var(--scout-chrome-border-soft)] p-3 ${directVoice ? "bg-[#f8f5ef]" : "bg-black/10"}`}>
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
                        ? directVoice
                          ? "border-[#b89a5f] bg-[#efe5d0] text-[var(--scout-chrome-ink)]"
                          : "border-lime-300/60 bg-lime-300/10 text-[var(--scout-chrome-ink)]"
                        : directVoice
                          ? "border-[var(--scout-chrome-border-soft)] bg-white/55 text-[var(--scout-chrome-ink-faint)] hover:bg-white"
                          : "border-[var(--scout-chrome-border-soft)] bg-black/20 text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)]"
                    }`}
                  >
                    <span className="block font-mono text-xs font-bold uppercase tracking-[0.1em]">
                      {profile.label}
                    </span>
                    <span className="mt-1 block font-mono text-2xs leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
                      {profile.voiceName} · {profile.description}
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              role="radio"
              aria-checked={speechSelectionId === "custom"}
              onClick={() => onSpeechSelectionId("custom")}
              className={`rounded border px-2.5 py-2 text-left font-mono text-xs transition ${
                speechSelectionId === "custom"
                  ? directVoice
                    ? "border-[#b89a5f] bg-[#efe5d0] text-[var(--scout-chrome-ink)]"
                    : "border-lime-300/60 bg-lime-300/10 text-[var(--scout-chrome-ink)]"
                  : directVoice
                    ? "border-[var(--scout-chrome-border-soft)] bg-white/55 text-[var(--scout-chrome-ink-faint)] hover:bg-white"
                    : "border-[var(--scout-chrome-border-soft)] bg-black/20 text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-hover)]"
              }`}
            >
              <span className="font-bold uppercase tracking-[0.1em]">Custom voice</span>
              <span className="ml-2 text-[var(--scout-chrome-ink-ghost)]">Use any supported model, voice, and style.</span>
            </button>
            {speechSelectionId === "custom" && (
              <div className={`grid gap-2 rounded border border-[var(--scout-chrome-border-soft)] p-2.5 ${directVoice ? "bg-white/55" : "bg-black/20"}`}>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                    Speech model
                    <input
                      value={customSpeechModelId}
                      onChange={(event) => onCustomSpeechModelId(event.target.value)}
                      placeholder="gpt-4o-mini-tts"
                      className={`rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] ${directVoice ? "bg-white/75" : "bg-black/25"}`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
                    Voice ID
                    <input
                      value={customSpeechVoiceId}
                      onChange={(event) => onCustomSpeechVoiceId(event.target.value)}
                      placeholder="marin"
                      className={`rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] ${directVoice ? "bg-white/75" : "bg-black/25"}`}
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
                    className={`w-full resize-y rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case leading-relaxed tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] ${directVoice ? "bg-white/75" : "bg-black/25"}`}
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
          </>
        )}
        <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          Preferred model
          <input
            value={modelDraft}
            onChange={(event) => onModelDraft(event.target.value)}
            placeholder="gpt-4.1-mini"
            className={`rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-sm normal-case tracking-normal text-[var(--scout-chrome-ink)] placeholder:text-[var(--scout-chrome-ink-ghost)] ${directVoice ? "bg-white/75" : "bg-black/20"}`}
            disabled={configLoading || configSaving}
          />
        </label>
        <label className="flex flex-col gap-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
          System Prompt
          <textarea
            value={promptDraft}
            onChange={(event) => onPromptDraft(event.target.value)}
            rows={6}
            className={`w-full resize-y rounded border border-[var(--scout-chrome-border-soft)] px-2 py-1.5 font-mono text-xs normal-case leading-relaxed tracking-normal text-[var(--scout-chrome-ink)] ${directVoice ? "bg-white/75" : "bg-black/20"}`}
            disabled={configLoading || configSaving}
          />
        </label>
        {configError && (
          <div className={`font-mono text-xs leading-relaxed ${directVoice ? "text-[#93483f]" : "text-red-300"}`}>
            {configError}
          </div>
        )}
        {configStatus && (
          <div className={`font-mono text-xs leading-relaxed ${directVoice ? "text-[#765923]" : "text-lime-200"}`}>
            {configStatus}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={configLoading || configSaving || !promptDraft.trim()}
            className={`flex items-center justify-center gap-2 rounded px-2.5 py-2 font-mono text-xs font-bold uppercase tracking-[0.12em] transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${directVoice ? "bg-[#282c2d] text-white hover:bg-[#151819]" : "bg-lime-300/90 text-black"}`}
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
