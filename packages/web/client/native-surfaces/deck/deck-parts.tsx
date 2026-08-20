import type { CSSProperties } from "react";
import {
  DECK_TREATMENTS,
  DECK_TREATMENT_META,
  blockDetail,
  blockTitle,
  composerPlaceholder,
  connectionLabel,
  consoleCaption,
  laneStateLabel,
  laneTone,
  primaryKeyDescription,
  primaryKeyLabel,
  relativeTime,
  shortId,
  taskTitle,
  threadRows,
  transportLabel,
  turnElapsed,
  turnPhaseDetail,
  turnPhaseLabel,
  voiceReadout,
} from "./deck-controller.ts";
import type { DeckLane, DeckModel } from "./deck-controller.ts";

/* ------------------------------------------------------------------ icons */

export function MicIcon() {
  return (
    <svg className="deck-glyph deck-glyph--mic" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="11" y="4" width="10" height="16" rx="5" />
      <path d="M7.5 15.5v.8a8.5 8.5 0 0 0 17 0v-.8M16 24.8V29M11.5 29h9" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg className="deck-glyph deck-glyph--mic" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M13 19l6-6M11.5 14.5 9 17a4.6 4.6 0 0 0 6.5 6.5l2.5-2.5M20.5 17.5 23 15a4.6 4.6 0 0 0-6.5-6.5L14 11" />
    </svg>
  );
}

export function SpeakerIcon() {
  return (
    <svg className="deck-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 8h3l4-3.2v10.4L6.5 12h-3zM13.3 7.2a4 4 0 0 1 0 5.6M15.6 5a7 7 0 0 1 0 10" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg className="deck-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.6" />
    </svg>
  );
}

export function SlidersIcon() {
  return (
    <svg className="deck-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 6h6M13 6h4M3 14h4M11 14h6" />
      <circle cx="11" cy="6" r="2.1" />
      <circle cx="9" cy="14" r="2.1" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg className="deck-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M16.5 8.2A6.6 6.6 0 0 0 4.6 6.4M3.5 11.8a6.6 6.6 0 0 0 11.9 1.8" />
      <path d="M16.8 4.2v4h-4M3.2 15.8v-4h4" />
    </svg>
  );
}

export function ChevronIcon({ dir }: { dir: "up" | "down" | "left" | "right" }) {
  const rotate = { up: 180, down: 0, left: 90, right: -90 }[dir];
  return (
    <svg className="deck-glyph" viewBox="0 0 20 20" aria-hidden="true" style={{ transform: `rotate(${rotate}deg)` }}>
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}

/* ------------------------------------------------------- treatment switch */

/**
 * Switching treatments never touches the controller: the same hook instance
 * keeps driving whichever layout is mounted, so a running turn survives it.
 */
export function TreatmentSwitch({ model }: { model: DeckModel }) {
  return (
    <div className="deck-switch" role="group" aria-label="Controller treatment">
      {DECK_TREATMENTS.map((value) => (
        <button
          key={value}
          type="button"
          className="deck-switch__key"
          data-active={model.treatment === value || undefined}
          onClick={() => model.setTreatment(value)}
          aria-pressed={model.treatment === value}
          title={DECK_TREATMENT_META[value].tagline}
        >
          {DECK_TREATMENT_META[value].label}
          {value === "ops" ? <em>default</em> : null}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- identity */

/**
 * The exact Scout-managed Codex session the Deck is bound to. Every treatment
 * renders this; a missing session is stated rather than left blank.
 */
export function TaskBinding({ model, size = "md" }: { model: DeckModel; size?: "sm" | "md" | "lg" }) {
  const title = taskTitle(model.thread);
  const bound = Boolean(model.thread?.threadId);
  if (!model.adapterAvailable) {
    return (
      <div className="deck-binding" data-size={size}>
        <span className="deck-binding__label">Selected workspace</span>
        <strong>{model.selected?.name ?? "No lane selected"}</strong>
        <span className="deck-binding__id">{model.selected?.projectRoot
          ?? model.sessionStartUnavailableReason
          ?? `${transportLabel(model.selected?.transport)} · view only`}</span>
      </div>
    );
  }
  return (
    <div className="deck-binding" data-size={size} data-bound={bound || undefined}>
      <span className="deck-binding__label">Scout Codex session</span>
      <strong title={title ?? undefined}>{bound ? title ?? "Untitled session" : "No session connected"}</strong>
      <span className="deck-binding__id">
        {model.thread?.threadId ? `id ${shortId(model.thread.threadId)}` : "id —"}
        {model.thread?.turnId ? ` · turn ${shortId(model.thread.turnId)}` : ""}
      </span>
    </div>
  );
}

/** One consolidated lifecycle line: lamp, phase, what it is doing, how long. */
export function PhaseLine({ model, compact = false }: { model: DeckModel; compact?: boolean }) {
  const lane = model.selected;
  if (!lane) return null;
  const elapsed = turnElapsed(model);
  return (
    <div
      className="deck-phase"
      data-tone={model.phaseTone}
      data-phase={model.phase}
      data-compact={compact || undefined}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="deck-phase__state">
        <i className="deck-lamp" />
        {turnPhaseLabel(model.phase, lane.state)}
      </span>
      <span className="deck-phase__detail">
        {turnPhaseDetail(
          model.phase,
          model.thread,
          model.threadError,
          model.notice,
          lane,
          model.sessionStartUnavailableReason,
        )}
      </span>
      {elapsed ? <span className="deck-phase__clock" data-live={model.phase === "running" || undefined}>{elapsed}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------- controls */

export function PrimaryKey({ model, size = "lg" }: { model: DeckModel; size?: "md" | "lg" | "xl" }) {
  const state = model.primaryAction === "start_codex"
    ? model.sessionBusy ? "starting" : "start"
    : model.primaryAction === "connect"
      ? "connect"
      : model.voice.input.state;
  const description = primaryKeyDescription(
    model.primaryAction,
    model.phase,
    model.voice.input.state,
    model.sessionStartUnavailableReason,
  );
  const disabled = model.primaryAction === "start_codex"
    ? !model.canStartCodexSession
    : model.primaryAction === "connect"
      ? model.threadBusy
      : !model.canTalk;
  return (
    <button
      type="button"
      className="deck-primary"
      data-size={size}
      data-action={model.primaryAction}
      data-state={state}
      onClick={model.onPrimary}
      disabled={disabled}
      aria-label={description}
      aria-pressed={model.primaryAction === "talk" ? model.voice.input.state === "listening" : undefined}
      aria-busy={model.primaryAction === "start_codex" && model.sessionBusy ? true : undefined}
      title={description}
    >
      {model.primaryAction === "talk" ? <MicIcon /> : <LinkIcon />}
      <small>{primaryKeyLabel(model.primaryAction, model.phase, model.voice.input.state)}</small>
    </button>
  );
}

export function StopKey({ model, block = false }: { model: DeckModel; block?: boolean }) {
  if (!model.canInterrupt) return null;
  return (
    <button
      type="button"
      className="deck-stop"
      data-block={block || undefined}
      onClick={model.interruptThread}
      disabled={model.threadBusy || model.phase === "stopping"}
    >
      <StopIcon />
      <span>{model.phase === "stopping" ? "Stopping" : "Stop turn"}</span>
    </button>
  );
}

/**
 * Live dictation feedback. The host contract carries no microphone level, so
 * this plots transcript cadence and says so — a silent mic never looks hot.
 */
export function VoiceTrace({ model }: { model: DeckModel }) {
  const listening = model.voice.input.state === "listening";
  return (
    <div className="deck-trace-wrap" data-live={listening || undefined}>
      <span className="deck-trace__label" title="The surface contract reports no microphone level, so the Deck plots transcript cadence instead.">
        {listening ? "Listening · cadence" : "Input cadence"}
      </span>
      <div className="deck-trace" data-live={listening || undefined} aria-hidden="true">
        {model.inputTrace.map((level, index) => (
          <i key={index} style={{ "--level": level } as CSSProperties} />
        ))}
      </div>
    </div>
  );
}

/** Observed lane traffic over the last five minutes, straight from the tail. */
export function LaneActivity({ model }: { model: DeckModel }) {
  return (
    <div className="deck-activity" aria-label="Lane activity over the last five minutes">
      <small>5m</small>
      <div aria-hidden="true">
        {model.laneActivity.map((level, index) => (
          <i key={index} style={{ "--level": level } as CSSProperties} />
        ))}
      </div>
      <small>now</small>
    </div>
  );
}

export function VoiceCaption({ model }: { model: DeckModel }) {
  return (
    <p
      className="deck-caption"
      data-active={model.voiceInputActive || undefined}
      data-error={Boolean(model.voiceError) || undefined}
      aria-live="polite"
    >
      <i aria-hidden="true" />
      <span>{model.voiceError ?? consoleCaption(model)}</span>
    </p>
  );
}

export function Composer({ model, rows = 2 }: { model: DeckModel; rows?: number }) {
  return (
    <form className="deck-composer" onSubmit={model.onComposerSubmit} aria-busy={model.threadBusy || undefined}>
      <textarea
        value={model.command}
        onChange={(event) => model.setCommand(event.target.value)}
        onKeyDown={model.onComposerKeyDown}
        placeholder={composerPlaceholder(model.phase, model.voice.input.state)}
        disabled={!model.canCompose}
        rows={rows}
        aria-label={model.phase === "running" ? "Steer the active Codex turn" : "Start a Codex turn"}
      />
      <button type="submit" className="deck-send" disabled={!model.canCompose || !model.command.trim()}>
        {model.phase === "running" ? "Steer" : "Send"}
        <em>⌘↵</em>
      </button>
    </form>
  );
}

/*
 * Every chip below can lose its visible word — either from the `label` prop or,
 * in the Console bar, because the layout hides the span once the surface
 * narrows. The word going away must not take the meaning with it, so each chip
 * always carries an accessible name and a tooltip that name the control *and*
 * its current state. That is also what keeps the Console honest after the right
 * rail folds away, since the rail is where those states are otherwise spelled
 * out. The name always opens with the visible word so voice control still
 * matches what an operator can read on screen.
 */

/** `Word — what it means right now`, the one shape every chip label takes. */
function chipName(word: string, description: string): string {
  return `${word} — ${description}`;
}

export function VoiceOutKey({ model, label = true }: { model: DeckModel; label?: boolean }) {
  const word = model.voice.output.speaking ? "Speaking" : model.voiceOutEnabled ? "Voice out" : "Muted";
  const description = !model.voiceOutputAvailable
    ? "spoken replies unavailable on this host"
    : model.voice.output.speaking
      ? "spoken replies are on and playing now"
      : model.voiceOutEnabled
        ? "spoken replies are on"
        : "spoken replies are off";
  return (
    <button
      type="button"
      className={chipClass("deck-chip deck-chip--voice", label)}
      data-active={model.voiceOutEnabled || undefined}
      data-speaking={model.voice.output.speaking || undefined}
      onClick={model.toggleVoiceOutput}
      disabled={!model.voiceOutputAvailable}
      aria-pressed={model.voiceOutEnabled}
      aria-label={chipName(word, description)}
      title={chipName(word, description)}
    >
      <SpeakerIcon />
      {label ? <span>{word}</span> : null}
    </button>
  );
}

export function SettingsKey({ model, label = true }: { model: DeckModel; label?: boolean }) {
  const name = chipName("Audio", model.settingsOpen ? "dictation and playback settings, open" : "dictation and playback settings");
  return (
    <button
      type="button"
      className={chipClass("deck-chip", label)}
      data-active={model.settingsOpen || undefined}
      onClick={() => model.setSettingsOpen(!model.settingsOpen)}
      aria-expanded={model.settingsOpen}
      aria-label={name}
      title={name}
    >
      <SlidersIcon />
      {label ? <span>Audio</span> : null}
    </button>
  );
}

export function RefreshKey({ model, label = true }: { model: DeckModel; label?: boolean }) {
  const name = chipName(
    "Re-read",
    model.canRefresh ? "pull the connected session snapshot from the host again" : "unavailable until a session is connected",
  );
  return (
    <button
      type="button"
      className={chipClass("deck-chip", label)}
      onClick={model.refreshSnapshot}
      disabled={!model.canRefresh}
      aria-label={name}
      title={name}
    >
      <RefreshIcon />
      {label ? <span>Re-read</span> : null}
    </button>
  );
}

export function RebindKey({ model, label = true }: { model: DeckModel; label?: boolean }) {
  if (!model.canRebind) return null;
  const word = model.phase === "failed" ? "Retry link" : "Reconnect";
  const name = chipName(
    word,
    model.phase === "failed"
      ? "the last connection failed; reconnect Scout's managed Codex session"
      : "connect Scout's managed Codex session",
  );
  return (
    <button
      type="button"
      className={chipClass("deck-chip deck-chip--warn", label)}
      onClick={model.connectThread}
      disabled={model.threadBusy}
      aria-label={name}
      title={name}
    >
      <LinkIcon />
      {label ? <span>{word}</span> : null}
    </button>
  );
}

/** Icon-only chips get a square tap target instead of a text-width one. */
function chipClass(base: string, label: boolean): string {
  return label ? base : `${base} deck-chip--icon`;
}

/**
 * Audio settings that actually do something. Engine and model readiness are
 * host-reported facts and are labelled as read-only; everything else is a
 * control the operator can act on right now.
 */
export function AudioSettings({ model }: { model: DeckModel }) {
  if (!model.settingsOpen) return null;
  const selectedModel = model.speechCatalog?.models.find((entry) => entry.id === model.speechModelId);
  const selectedVoice = model.speechCatalog?.voices.find((entry) => entry.id === model.speechVoiceId && entry.modelId === model.speechModelId);
  const outputState = model.speechOutputPhase === "preparing"
    ? "Synthesizing through Scout…"
    : model.voice.output.speaking
      ? "A reply is being spoken now."
      : "Ready for the next completed reply.";
  return (
    <div className="deck-sheet" role="dialog" aria-label="Audio and dictation settings">
      <header>
        <strong>Audio &amp; dictation</strong>
        <button type="button" className="deck-chip" onClick={() => model.setSettingsOpen(false)}>Close</button>
      </header>

      <div className="deck-sheet__row">
        <div>
          <strong>Spoken replies</strong>
          <small>Speak each completed Codex reply aloud.</small>
        </div>
        <button
          type="button"
          className="deck-toggle"
          data-on={model.voiceOutEnabled || undefined}
          onClick={model.toggleVoiceOutput}
          disabled={!model.voiceOutputAvailable}
          aria-pressed={model.voiceOutEnabled}
        >
          <i />{model.voiceOutEnabled ? "On" : "Off"}
        </button>
      </div>

      <div className="deck-sheet__voice-grid" aria-label="Scout speech provider and voice">
        <label>
          <span>Provider &amp; model</span>
          <select
            className="deck-sheet__select"
            value={model.speechModelId}
            onChange={(event) => model.selectSpeechModel(event.currentTarget.value)}
            disabled={!model.cloudSpeechAvailable || !model.speechCatalog}
          >
            {model.speechCatalog?.models.filter((entry) => isCloudSpeechProvider(entry.provider)).map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.available}>
                {providerLabel(entry.provider)} · {entry.name}{entry.available ? "" : " · unavailable"}
              </option>
            )) ?? <option>{model.speechCatalog ? "No API models" : "Loading Scout voices…"}</option>}
          </select>
        </label>

        <label>
          <span>Voice</span>
          <select
            className="deck-sheet__select"
            value={model.speechVoiceId}
            onChange={(event) => model.selectSpeechVoice(event.currentTarget.value)}
            disabled={!model.cloudSpeechAvailable || !model.speechCatalog || model.speechCatalog.voices.length === 0}
          >
            {model.speechCatalog?.voices.filter((entry) => entry.modelId === model.speechModelId && entry.available).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}{entry.language ? ` · ${entry.language}` : ""}
              </option>
            )) ?? <option>Loading…</option>}
          </select>
        </label>
      </div>

      <div className="deck-sheet__pace">
        <div>
          <strong>Speaking pace</strong>
          <small>Applied by the selected Scout TTS provider.</small>
        </div>
        <div className="deck-segment" role="group" aria-label="Speaking pace">
          {([
            [0.85, "Calm"],
            [1, "Natural"],
            [1.15, "Brisk"],
          ] as const).map(([speed, label]) => (
            <button
              type="button"
              key={label}
              data-active={model.speechSpeed === speed || undefined}
              aria-pressed={model.speechSpeed === speed}
              onClick={() => model.selectSpeechSpeed(speed)}
              disabled={!model.cloudSpeechAvailable}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="deck-sheet__row">
        <div>
          <strong>Stopping dictation sends</strong>
          <small>Off keeps the transcript in the composer for editing.</small>
        </div>
        <button
          type="button"
          className="deck-toggle"
          data-on={model.autoSendOnStop || undefined}
          onClick={model.toggleAutoSend}
          aria-pressed={model.autoSendOnStop}
        >
          <i />{model.autoSendOnStop ? "On" : "Off"}
        </button>
      </div>

      <div className="deck-sheet__row">
        <div>
          <strong>Playback</strong>
          <small>{outputState}</small>
        </div>
        <div className="deck-sheet__playback">
          <button
            type="button"
            className="deck-chip"
            onClick={model.previewSpeechVoice}
            disabled={!model.voiceOutputAvailable || model.speechOutputPhase !== "idle"}
          >
            <SpeakerIcon /><span>Hear voice</span>
          </button>
          <button
            type="button"
            className="deck-chip deck-chip--warn"
            onClick={model.stopSpeaking}
            disabled={!model.voice.output.speaking}
          >
            <StopIcon /><span>Stop</span>
          </button>
        </div>
      </div>

      <dl className="deck-sheet__facts">
        <div><dt>Voice in</dt><dd>{model.voiceAvailable ? model.voice.input.engine : "—"}</dd></div>
        <div><dt>Input</dt><dd>{model.voiceAvailable ? voiceReadout(model.voice.input.state) : "—"}</dd></div>
        <div><dt>Voice out</dt><dd>{selectedModel ? providerLabel(selectedModel.provider) : "Scout API"}</dd></div>
        <div><dt>Route</dt><dd>{model.speechRoute?.voiceId ?? selectedVoice?.name ?? model.speechVoiceId}</dd></div>
      </dl>
      <p className="deck-sheet__note">
        Scout owns both directions: Scout dictation in; OpenAI or ElevenLabs synthesis out through the paired host API.
      </p>
    </div>
  );
}

function providerLabel(provider: string): string {
  if (provider.toLowerCase() === "openai") return "OpenAI";
  if (provider.toLowerCase() === "elevenlabs") return "ElevenLabs";
  return provider.replace(/(^|[-_])([a-z])/g, (_, prefix: string, letter: string) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function isCloudSpeechProvider(provider: string): boolean {
  const normalized = provider.toLowerCase();
  return normalized === "openai" || normalized === "elevenlabs";
}

/* ------------------------------------------------------------------ lanes */

export function LaneRow({
  lane,
  index,
  model,
  onSelect,
}: {
  lane: DeckLane;
  index: number;
  model: DeckModel;
  onSelect?: () => void;
}) {
  const active = lane.key === model.selected?.key;
  return (
    <button
      type="button"
      className="deck-lane"
      data-active={active || undefined}
      data-tone={active && model.phaseTone !== "quiet" ? model.phaseTone : laneTone(lane)}
      onClick={() => {
        model.selectLane(lane);
        onSelect?.();
      }}
      aria-pressed={active}
    >
      <span className="deck-lane__index">{String(index + 1).padStart(2, "0")}</span>
      <span className="deck-lane__body">
        <strong>{lane.name}</strong>
        <small>{lane.hostName} · {lane.harness ?? "agent"} · {laneStateLabel(lane.state).toLowerCase()}</small>
      </span>
      <i className="deck-lane__signal" aria-hidden="true" />
    </button>
  );
}

export function HostScopeBar({ model }: { model: DeckModel }) {
  const { hosts } = model;
  if (hosts.length === 0) return null;
  return (
    <div className="deck-scope" role="group" aria-label="Agent lane scope">
      {hosts.length > 1 ? (
        <button
          type="button"
          className="deck-scope__key"
          data-active={model.hostScope === "all" || undefined}
          onClick={() => model.selectHostScope("all")}
          aria-pressed={model.hostScope === "all"}
        >
          <i data-all="true" />All hosts
        </button>
      ) : null}
      {hosts.map((host) => (
        <button
          type="button"
          className="deck-scope__key"
          key={host.id}
          data-state={host.state}
          data-active={model.hostScope === host.id || undefined}
          onClick={() => model.selectHostScope(host.id)}
          disabled={host.state !== "connected"}
          aria-pressed={model.hostScope === host.id}
        >
          <i />{host.name}
        </button>
      ))}
    </div>
  );
}

export function AttentionList({ model, onPick }: { model: DeckModel; onPick?: () => void }) {
  if (model.attention.length === 0) {
    return <p className="deck-empty-note">No lanes need intervention.</p>;
  }
  return (
    <div className="deck-attention">
      {model.attention.map((lane) => (
        <button
          type="button"
          className="deck-attention__row"
          key={lane.key}
          onClick={() => {
            model.selectLane(lane);
            onPick?.();
          }}
        >
          <i aria-hidden="true" />
          <span>
            <strong>{lane.name}</strong>
            <small>{lane.events[0]?.text ?? "Needs review"}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- streams */

export function ThreadStream({ model, limit = 9 }: { model: DeckModel; limit?: number }) {
  const { thread, adapterAvailable, threadBusy, threadError } = model;
  if (!adapterAvailable) {
    return (
      <StreamEmpty glyph={model.sessionBusy ? "···" : "CX"} title={model.sessionError ? "Codex did not start" : model.sessionBusy ? "Starting Codex" : "Workspace is view-only"} tone={model.sessionError ? "error" : undefined}>
        {model.sessionError ?? (model.sessionBusy
          ? model.sessionLaunchAccepted
            ? "Codex accepted the launch. Scout will switch Deck when its lane appears."
            : "Scout is launching a broker-managed Codex session."
          : model.canStartCodexSession
            ? "This lane remains intact when Scout opens its controllable Codex session."
            : model.sessionStartUnavailableReason ?? "This workspace remains view-only.")}
      </StreamEmpty>
    );
  }
  if (threadError) {
    return (
      <StreamEmpty glyph="!" title="Session connection failed" tone="error">
        {threadError}
        <button type="button" className="deck-chip deck-chip--warn" onClick={model.connectThread} disabled={threadBusy}>
          <LinkIcon /><span>Retry controller</span>
        </button>
      </StreamEmpty>
    );
  }
  if (!thread) {
    return (
      <StreamEmpty glyph="···" title="Reading the Codex session">
        Nothing is shown until the host returns a snapshot.
      </StreamEmpty>
    );
  }
  if (thread.state === "disconnected") {
    return (
      <StreamEmpty glyph="CX" title="Session is disconnected">
        No turns are readable until Deck reconnects Scout's managed Codex session on the host.
        <button type="button" className="deck-chip deck-chip--warn" onClick={model.connectThread} disabled={threadBusy}>
          <LinkIcon /><span>Reconnect</span>
        </button>
      </StreamEmpty>
    );
  }

  const rows = threadRows(thread, limit);
  if (rows.length === 0) {
    return (
      <StreamEmpty glyph="●" title="Codex ready" tone="connected">
        {thread.threadId
          ? `Session ${shortId(thread.threadId)} is ready. Start its first turn from the console.`
          : "The session is connected. Start its first turn from the console."}
      </StreamEmpty>
    );
  }

  return (
    <div className="deck-stream">
      {rows.map((row) => (
        <article className="deck-stream__row" data-role={row.role} data-type={row.block.type} key={row.block.id}>
          <div className="deck-stream__meta">
            <span>{row.role === "operator" ? "YOU" : row.block.type === "action" ? "RUN" : row.block.type === "reasoning" ? "THINK" : "CX"}</span>
            <time>{relativeTime(row.at)}</time>
          </div>
          <div className="deck-stream__content">
            <strong>{blockTitle(row.block)}</strong>
            {blockDetail(row.block) ? <p>{blockDetail(row.block)}</p> : null}
          </div>
          <span className="deck-stream__status" data-live={row.status === "streaming" || undefined}>
            {row.status === "streaming" ? "live" : row.status}
          </span>
        </article>
      ))}
    </div>
  );
}

export function SignalStream({ lane }: { lane: DeckLane }) {
  if (lane.events.length === 0) {
    return <StreamEmpty glyph="·" title="No recent activity">Nothing has been observed on this lane recently.</StreamEmpty>;
  }
  return (
    <div className="deck-stream">
      {lane.events.slice(0, 8).map((event) => (
        <article className="deck-stream__row" data-kind={event.kind} key={event.id}>
          <div className="deck-stream__meta">
            <span>{event.kind.toUpperCase()}</span>
            <time>{relativeTime(event.at)}</time>
          </div>
          <div className="deck-stream__content">
            <strong>{event.text}</strong>
            {event.detail ? <p>{event.detail}</p> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

export function StreamEmpty({
  glyph,
  title,
  tone,
  children,
}: {
  glyph: string;
  title: string;
  tone?: "error" | "connected";
  children: React.ReactNode;
}) {
  return (
    <div className="deck-stream-empty" data-tone={tone}>
      <span className="deck-stream-empty__glyph">{glyph}</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function ViewTabs({ model }: { model: DeckModel }) {
  return (
    <div className="deck-tabs" role="tablist" aria-label="Lane view">
      <button
        type="button"
        role="tab"
        aria-selected={model.view === "thread"}
        onClick={() => model.setView("thread")}
        disabled={!model.adapterAvailable}
      >
        Session turns
      </button>
      <button type="button" role="tab" aria-selected={model.view === "signal"} onClick={() => model.setView("signal")}>
        Lane signal
      </button>
    </div>
  );
}

export function LaneStream({ model, limit }: { model: DeckModel; limit?: number }) {
  if (model.view === "signal" && model.selected) return <SignalStream lane={model.selected} />;
  return <ThreadStream model={model} limit={limit} />;
}

/* ---------------------------------------------------------------- status */

export function ConnectionChip({ model }: { model: DeckModel }) {
  return (
    <span className="deck-connection" data-connection={model.connection}>
      <i className="deck-lamp" />
      {connectionLabel(model.connection)}
    </span>
  );
}

export function LaneIdentity({ model }: { model: DeckModel }) {
  const lane = model.selected;
  if (!lane) return null;
  return (
    <div className="deck-identity">
      <h2>{lane.name}</h2>
      <p>
        <span>{lane.projectRoot ?? "Project unavailable"}</span>
        <em>{lane.hostName} · {lane.model ?? "default model"} · {transportLabel(lane.transport)}</em>
      </p>
    </div>
  );
}

export function DeckStandby({ model }: { model: DeckModel }) {
  return (
    <div className="deck-standby">
      <i className="deck-lamp" />
      <span className="deck-kicker">Deck standing by</span>
      <h2>{model.connection === "error" ? "Host unavailable" : "Waiting for a connected host"}</h2>
      <p>{model.error ?? "Connect a trusted Scout host to populate live lanes and enable controls."}</p>
      <HostScopeBar model={model} />
    </div>
  );
}
