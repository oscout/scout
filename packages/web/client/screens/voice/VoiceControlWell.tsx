import type { ScoutRealtimeVoiceConnectionState } from "../../lib/realtime-voice.ts";
import type { ScoutbotSpeechIdentity } from "../../scout/scoutbot/scoutbot-voice-profiles.ts";

export type VoiceWellFlag = {
  key: string;
  label: string;
  on?: boolean;
  momentary?: boolean;
  disabled?: boolean;
  title?: string;
};

export type VoiceWellSpec = {
  title: string;
  sub: string;
  cta: {
    label: string;
    clock?: string;
    disabled?: boolean;
    busy?: boolean;
    tone?: "start" | "end";
  };
  note?: string;
  noteError?: boolean;
  flags: VoiceWellFlag[];
  flagNote?: string;
  input: string;
  inputWarn?: boolean;
  newChatBusy?: boolean;
};

export type LocalLiveWellPhase =
  | "checking"
  | "unavailable"
  | "listening"
  | "processing"
  | "thinking"
  | "speaking"
  | "ready";

export function gptLiveWellSpec({
  enabled,
  state,
  error,
  clock,
  meterLine,
  inputLabel,
  micMuted,
  playbackMuted,
  dictationActive = false,
  newChatBusy = false,
}: {
  enabled: boolean;
  state: ScoutRealtimeVoiceConnectionState | "idle";
  error: string | null;
  clock?: string;
  meterLine: string;
  inputLabel: string;
  micMuted: boolean;
  playbackMuted: boolean;
  dictationActive?: boolean;
  newChatBusy?: boolean;
}): VoiceWellSpec {
  let cta: VoiceWellSpec["cta"];
  if (dictationActive) {
    cta = { label: "Start live voice", disabled: true };
  } else if (state === "connecting") {
    cta = { label: "Cancel connection", busy: true };
  } else if (state === "live") {
    cta = { label: "End live voice", tone: "end", clock };
  } else if (!enabled) {
    cta = { label: "Open voice settings", tone: "end" };
  } else {
    cta = { label: "Start live voice", tone: "start" };
  }

  let note: string | undefined;
  let noteError = false;
  if (error) {
    note = error;
    noteError = true;
  } else if (dictationActive) {
    note = "Dictation owns the microphone — live voice waits.";
  } else if (state === "connecting") {
    note = "mic consent → SDP answer → Live readiness";
  } else if (state === "live") {
    note = "the meter is running · billed per second";
  } else if (!enabled) {
    note = "live voice is off · flip it on in Voice settings";
  } else {
    note = "the meter starts on connect → clock · $ · metered";
  }

  return {
    title: "Live conversation",
    sub: meterLine,
    cta,
    note,
    noteError,
    flags: [
      { key: "mic", label: "Mute mic", on: micMuted, title: "the mic stays hot until End" },
      { key: "speaker", label: "Quiet", on: playbackMuted, title: "playback keeps flowing" },
    ],
    flagNote: state === "live"
      ? "the meter runs while the call is live"
      : micMuted || playbackMuted
        ? "armed now · applies on connect"
        : undefined,
    input: `input · ${inputLabel}`,
    newChatBusy,
  };
}

export function localLiveWellSpec({
  phase,
  voiceReplies,
  inputLabel,
  inputWarn,
  speechIdentity,
  assistantModel,
  recordingClock,
}: {
  phase: LocalLiveWellPhase;
  voiceReplies: boolean;
  inputLabel: string;
  inputWarn: boolean;
  speechIdentity: ScoutbotSpeechIdentity | null;
  assistantModel: string | null;
  recordingClock?: string;
}): VoiceWellSpec {
  const sub = speechIdentity
    ? `${[speechIdentity.providerLabel, speechIdentity.modelId].filter(Boolean).join(" ")} · voice ${speechIdentity.voiceLabel} · ${speechIdentity.metered ? "metered per reply" : "unmetered"}`
    : "voice host resolving…";
  const replyModel = assistantModel?.trim();

  let cta: VoiceWellSpec["cta"];
  switch (phase) {
    case "listening":
      cta = { label: "Send turn", tone: "start", clock: recordingClock };
      break;
    case "speaking":
      cta = { label: "Stop spoken reply", tone: "end" };
      break;
    case "unavailable":
      cta = { label: "Retry voice connection", tone: "end" };
      break;
    case "checking":
      cta = { label: "Checking voice…", busy: true, disabled: true };
      break;
    case "processing":
      cta = { label: "Cancel turn", tone: "end" };
      break;
    case "thinking":
      cta = { label: "Cancel turn", tone: "end" };
      break;
    case "ready":
      cta = { label: "Start voice turn", tone: "start" };
      break;
  }

  let note: string | undefined;
  switch (phase) {
    case "ready":
      note = `audio stays on this Mac${replyModel ? ` · reply text still hits ${replyModel}` : ""}`;
      break;
    case "checking":
      note = "checking microphone and speech services";
      break;
    case "unavailable":
      note = "voice is offline · nothing can record";
      break;
    case "listening":
      note = "recording · nothing is sent until Send";
      break;
    case "processing":
      note = "turning speech into text";
      break;
    case "thinking":
      note = replyModel ? `your turn is in · ${replyModel} is replying` : "your turn is in";
      break;
    case "speaking":
      note = speechIdentity?.metered ? "spoken reply · metered" : "spoken reply · unmetered";
      break;
  }

  const flags: VoiceWellFlag[] = [];
  if (phase === "listening") {
    flags.push({ key: "mic", label: "Discard", momentary: true, title: "drop this take — nothing is sent" });
  }
  flags.push({
    key: "speaker",
    label: "Spoken replies",
    on: voiceReplies,
    disabled: phase !== "ready" && phase !== "listening",
    title: "the reply voice speaks, or the reply lands as text",
  });

  let flagNote: string | undefined;
  switch (phase) {
    case "ready":
      flagNote = voiceReplies
        ? `TTS is prepared per reply · ${speechIdentity?.metered ? "metered" : "unmetered"}`
        : "reply lands as text · nothing metered";
      break;
    case "listening":
      flagNote = "the mic closes on Send or Discard";
      break;
    case "processing":
      flagNote = "the take is in · the meter is Scout's reply";
      break;
    case "thinking":
      flagNote = "the reply is paid, not the take";
      break;
    case "speaking":
      flagNote = speechIdentity?.metered ? "speech is a paid reply" : "speech is on this Mac";
      break;
    case "checking":
      flagNote = "device permission resolves the flag row";
      break;
    case "unavailable":
      flagNote = "resolve the input, then turn-taking works";
      break;
  }

  return {
    title: "Turn-based conversation",
    sub,
    cta,
    note,
    flags,
    flagNote,
    input: `input · ${inputLabel}`,
    inputWarn,
  };
}

export function VoiceControlWell({
  spec,
  onCta,
  onFlag,
  onTail,
  layout = "card",
}: {
  spec: VoiceWellSpec;
  onCta: () => void;
  onFlag: (key: string, flag: VoiceWellFlag) => void;
  onTail: (key: "new-chat" | "settings") => void;
  /** Card is the resting geometry; row is the collapsed performing one —
      same slots, one line: input left, flags + notes + quiet tails center,
      CTA right. Row drops the title/sub (the header readout carries the
      meter line) and quiets egress: Cancel/Stop go ghost, only Start/Send/End
      commitments stay solid. */
  layout?: "card" | "row";
}) {
  const { cta } = spec;
  const rowTone = cta.tone === "start"
    ? "start"
    : cta.busy || /^(cancel|stop)\b/i.test(cta.label)
      ? "ghost"
      : "end";
  const ctaButton = (tone: "start" | "end" | "ghost") => (
    <button
      type="button"
      className={`voice-well-cta voice-well-cta--${tone}`}
      disabled={cta.disabled}
      aria-busy={cta.busy || undefined}
      onClick={onCta}
    >
      <span>{cta.label}</span>
      {cta.clock && <span className="voice-well-cta-clock">{cta.clock}</span>}
    </button>
  );
  const flagButtons = spec.flags.map((flag) => (
    <button
      key={flag.key}
      type="button"
      className={`voice-well-flag${flag.on ? " voice-well-flag--on" : ""}`}
      disabled={flag.disabled}
      aria-pressed={flag.momentary ? undefined : Boolean(flag.on)}
      title={flag.title}
      onClick={() => onFlag(flag.key, flag)}
    >
      {flag.label}
    </button>
  ));
  const note = spec.note ? (
    <p
      className={`voice-well-note${spec.noteError ? " voice-well-note--error" : ""}`}
      role={spec.noteError ? "alert" : undefined}
    >
      {spec.note}
    </p>
  ) : null;
  const input = (
    <span className={`voice-well-input${spec.inputWarn ? " voice-well-input--warn" : ""}`}>
      {spec.input}
    </span>
  );
  const tailActions = (
    <>
      <button
        type="button"
        className="voice-well-tail-action"
        disabled={spec.newChatBusy}
        onClick={() => onTail("new-chat")}
      >
        New chat
      </button>
      <button
        type="button"
        className="voice-well-tail-action"
        onClick={() => onTail("settings")}
      >
        Voice settings
      </button>
    </>
  );

  if (layout === "row") {
    return (
      <section className="voice-well voice-well--row" aria-label={spec.title}>
        {input}
        <div className="voice-well-flags">
          {flagButtons}
          {spec.flagNote && <span className="voice-well-flag-note">{spec.flagNote}</span>}
          {note}
          {tailActions}
        </div>
        {ctaButton(rowTone)}
      </section>
    );
  }

  return (
    <section className="voice-well" aria-label={spec.title}>
      <div className="voice-well-title">{spec.title}</div>
      <div className="voice-well-sub">{spec.sub}</div>
      {ctaButton(cta.tone === "end" ? "end" : "start")}
      {note}
      <div className="voice-well-flags">
        {flagButtons}
        {spec.flagNote && <span className="voice-well-flag-note">{spec.flagNote}</span>}
      </div>
      <div className="voice-well-tail">
        {input}
        {tailActions}
      </div>
    </section>
  );
}
