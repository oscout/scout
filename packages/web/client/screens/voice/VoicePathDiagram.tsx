// DIRECTION CONTRACT — Voice paths
//
// THESIS: "See where your voice goes." The mode switch is drawn as two signal
// topologies, not two interchangeable tabs. GPT Live is a capsule loop that
// visibly leaves the machine — the OpenAI hop arches out of the device frame
// in mesh-sky and comes back — while Local Live is a machined block chain that
// never crosses the frame. Refuses the category default of two tabs and a mic
// button.
// OWN-WORLD: Lit Control Room, unchanged. Hue-260 canvas, ink hairlines,
// JetBrains Mono labels, lime = working. Shape carries the mode: 999px pills
// for the cloud loop, 6px blocks for the on-device pipeline. The only
// categorical color is --cat-sky, spent exclusively on hops that leave the
// machine.
// STORY: The operator picks a mode by seeing the trade — continuous call that
// routes through their OpenAI account, versus turn-based conversation whose
// audio stays home. Every node reports its real state; the local turn engine
// is drawn dashed because it is not wired yet, and the caption says so.
// FIRST VIEWPORT: eyebrow + mode title + segmented switch; the path diagram at
// full width directly under it; the mode's working panel below.
// FORM: extension of the existing /voice surface inside the established world.
// The brief named both modes and their differentiation, so no concept roll.

import type { ScoutRealtimeVoiceConnectionState } from "../../lib/realtime-voice.ts";
import type { ScoutVoiceProbeSnapshot } from "../../lib/scout-voice.ts";
import type { DirectVoicePhase } from "../../scout/scoutbot/DirectVoicePanel.tsx";
import "./voice-paths.css";

export type VoicePathMode = "gpt-live" | "local-live";

type NodeState = "dim" | "ok" | "ready" | "working" | "warn" | "error" | "pending";

type PathNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  state: NodeState;
  tone?: "sky";
};

const NODE_TEXT_DY = 3;

function PathNodeGlyph({ node }: { node: PathNode }) {
  const dotX = node.x + 14;
  const midY = node.y + node.h / 2;
  return (
    <g className={`vpd-node vpd-node--${node.state}${node.tone ? ` vpd-node--${node.tone}` : ""}`}>
      <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={node.rx} className="vpd-node-plate" />
      <circle cx={dotX} cy={midY} r={3} className="vpd-node-dot" />
      <text x={node.x + 24} y={midY + NODE_TEXT_DY} className="vpd-node-label">
        {node.label}
      </text>
    </g>
  );
}

function ArrowDefs() {
  return (
    <defs>
      <marker id="vpd-arrow-ink" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
        <path d="M 0 0.5 L 8 4 L 0 7.5 Z" className="vpd-arrow vpd-arrow--ink" />
      </marker>
      <marker id="vpd-arrow-sky" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
        <path d="M 0 0.5 L 8 4 L 0 7.5 Z" className="vpd-arrow vpd-arrow--sky" />
      </marker>
      <marker id="vpd-arrow-sky-dim" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
        <path d="M 0 0.5 L 8 4 L 0 7.5 Z" className="vpd-arrow vpd-arrow--sky-dim" />
      </marker>
    </defs>
  );
}

function MachineFrame({ label }: { label: string }) {
  return (
    <>
      <rect x={24} y={96} width={672} height={72} rx={8} className="vpd-frame" />
      <text x={38} y={111} className="vpd-frame-label">
        {label}
      </text>
    </>
  );
}

function gptLiveNodes(state: ScoutRealtimeVoiceConnectionState | "idle"): PathNode[] {
  const live = state === "live";
  const connecting = state === "connecting";
  const errored = state === "error";
  const local: NodeState = errored ? "error" : live ? "ok" : connecting ? "working" : "dim";
  /* Connecting is work in progress, not a warning — lime, not amber. */
  const cloud: NodeState = errored ? "error" : live ? "ok" : connecting ? "working" : "dim";
  return [
    { id: "mic", label: "MIC", x: 44, y: 122, w: 64, h: 32, rx: 16, state: local },
    { id: "webrtc", label: "WEBRTC", x: 148, y: 122, w: 88, h: 32, rx: 16, state: local },
    {
      id: "openai",
      label: "OPENAI REALTIME",
      x: 288,
      y: 8,
      w: 176,
      h: 32,
      rx: 16,
      state: cloud,
      tone: "sky",
    },
    { id: "scoutbot", label: "SCOUTBOT", x: 560, y: 122, w: 112, h: 32, rx: 16, state: local },
  ];
}

function GptLiveDiagram({ state }: { state: ScoutRealtimeVoiceConnectionState | "idle" }) {
  const live = state === "live";
  const stateCopy = live ? "Call live." : state === "connecting" ? "Call connecting." : state === "error" ? "Call in error." : "No call; idle.";
  return (
    <svg viewBox="0 0 720 176" className="vpd" role="img" aria-live="polite" aria-label={`GPT Live path: microphone and WebRTC on this machine, audio arches out to OpenAI Realtime in the cloud and back to Scoutbot. ${stateCopy}`}>
      <ArrowDefs />
      <MachineFrame label="THIS MACHINE" />
      <text x={476} y={27} className="vpd-cloud-label">
        CLOUD
      </text>
      {/* Mic ⇄ WebRTC: duplex on-device hop, plain ink. */}
      <line x1={108} y1={138} x2={148} y2={138} className={`vpd-link${live ? " vpd-flow" : ""}`} markerStart="url(#vpd-arrow-ink)" markerEnd="url(#vpd-arrow-ink)" />
      {/* The two hops that leave the machine. Only these may wear sky. */}
      <path d="M 192 122 C 192 80, 300 66, 334 40" className={`vpd-link vpd-link--sky${live ? " vpd-flow" : ""}`} markerEnd={live ? "url(#vpd-arrow-sky)" : "url(#vpd-arrow-sky-dim)"} />
      <path d="M 418 42 C 452 66, 616 80, 616 122" className={`vpd-link vpd-link--sky${live ? " vpd-flow" : ""}`} markerEnd={live ? "url(#vpd-arrow-sky)" : "url(#vpd-arrow-sky-dim)"} />
      {/* Boundary crossings, marked where the arches pierce the frame. */}
      <circle cx={209} cy={96} r={2.5} className="vpd-crossing" />
      <circle cx={590} cy={96} r={2.5} className="vpd-crossing" />
      {gptLiveNodes(state).map((node) => (
        <PathNodeGlyph key={node.id} node={node} />
      ))}
    </svg>
  );
}

function localLiveNodes(
  probe: ScoutVoiceProbeSnapshot | null,
  replyModel: string | null,
  phase: DirectVoicePhase | null,
): PathNode[] {
  const hostUp = probe?.hostReachable === true;
  const mic: NodeState = !probe ? "dim" : probe.microphoneGranted === true ? "ready" : "warn";
  const stage: NodeState = !probe ? "dim" : hostUp ? "ready" : "warn";
  const nodes: PathNode[] = [
    { id: "mic", label: "MIC", x: 44, y: 122, w: 60, h: 32, rx: 6, state: mic },
    { id: "stt", label: "STT", x: 140, y: 122, w: 64, h: 32, rx: 6, state: stage },
    { id: "turn", label: "TURN ENGINE", x: 244, y: 122, w: 128, h: 32, rx: 6, state: "pending" },
    { id: "scoutbot", label: "SCOUTBOT", x: 416, y: 122, w: 104, h: 32, rx: 6, state: replyModel ? "ready" : "dim" },
    { id: "tts", label: "TTS", x: 560, y: 122, w: 60, h: 32, rx: 6, state: stage },
  ];
  /* The live turn overrides availability: the stage doing the work right now
     wears lime (working), per the Signal-Not-Status rule. */
  if (phase === "listening") {
    nodes[0]!.state = "working";
    nodes[1]!.state = "working";
  } else if (phase === "processing") {
    nodes[1]!.state = "working";
  } else if (phase === "thinking") {
    nodes[3]!.state = "working";
  } else if (phase === "speaking") {
    nodes[4]!.state = "working";
  }
  return nodes;
}

function LocalLiveDiagram({
  probe,
  replyModel,
  phase,
  ttsProviderLabel,
  ttsMetered,
}: {
  probe: ScoutVoiceProbeSnapshot | null;
  replyModel: string | null;
  phase: DirectVoicePhase | null;
  ttsProviderLabel: string | null;
  ttsMetered: boolean;
}) {
  const listening = phase === "listening";
  const processing = phase === "processing" || phase === "thinking";
  const speaking = phase === "speaking";
  const phaseCopy = !phase || phase === "ready"
    ? "Idle."
    : phase === "listening"
      ? "Listening to a turn."
      : processing
        ? "Transcribing or thinking."
        : phase === "speaking"
          ? "Speaking a reply."
          : "Checking the voice host.";
  const ttsCopy = ttsMetered && ttsProviderLabel
    ? ` Spoken replies send reply text to ${ttsProviderLabel} TTS.`
    : " Spoken replies are synthesized on-device.";
  return (
    <svg viewBox="0 88 720 116" className="vpd" role="img" aria-live="polite" aria-label={`Local Live path: microphone, speech-to-text, turn engine, Scoutbot, and text-to-speech as one chain inside this machine, ending at the speaker. The turn engine is not wired yet. Reply text leaves the chain to the configured reply model.${ttsCopy} ${phaseCopy}`}>
      <ArrowDefs />
      <MachineFrame label="THIS MACHINE — AUDIO NEVER LEAVES" />
      {/* Turn-based chain: one direction, one stage at a time. */}
      <line x1={104} y1={138} x2={140} y2={138} className={`vpd-link${listening ? " vpd-flow" : ""}`} markerEnd="url(#vpd-arrow-ink)" />
      <line x1={204} y1={138} x2={244} y2={138} className={`vpd-link vpd-link--pending${processing ? " vpd-flow" : ""}`} markerEnd="url(#vpd-arrow-ink)" />
      <line x1={372} y1={138} x2={416} y2={138} className={`vpd-link vpd-link--pending${processing ? " vpd-flow" : ""}`} markerEnd="url(#vpd-arrow-ink)" />
      <line x1={520} y1={138} x2={560} y2={138} className={`vpd-link${speaking ? " vpd-flow" : ""}`} markerEnd="url(#vpd-arrow-ink)" />
      <line x1={620} y1={138} x2={648} y2={138} className={`vpd-link${speaking ? " vpd-flow" : ""}`} markerEnd="url(#vpd-arrow-ink)" />
      {/* Chain terminus: the speaker. */}
      <g className={speaking ? "vpd-speaker-live" : undefined}>
        <path d="M 652 135 L 657 135 L 663 130 L 663 146 L 657 141 L 652 141 Z" className="vpd-speaker" />
        <path d="M 666 133 Q 669 138 666 143" className="vpd-speaker-arc" />
        <path d="M 669 131 Q 673 138 669 145" className="vpd-speaker-arc" />
      </g>
      {/* The reply leg is text, not audio: it leaves the chain for the
          configured reply model without wearing the leaves-the-machine sky. */}
      <line x1={468} y1={154} x2={468} y2={182} className={`vpd-stub${processing ? " vpd-flow" : ""}`} />
      <text x={478} y={185} className="vpd-stub-label">
        TEXT TO REPLY MODEL
      </text>
      {/* The TTS hop the caption confesses: when spoken replies come from a
          metered provider, reply text takes a second text leg out — drawn
          only while that is true, so the topology never disagrees with the
          identity chips. */}
      {ttsMetered && ttsProviderLabel && (
        <>
          <line x1={590} y1={154} x2={590} y2={196} className={`vpd-stub${speaking ? " vpd-flow" : ""}`} />
          <text x={598} y={199} className="vpd-stub-label">
            {`TEXT TO ${ttsProviderLabel.toUpperCase()} TTS`}
          </text>
        </>
      )}
      {localLiveNodes(probe, replyModel, phase).map((node) => (
        <PathNodeGlyph key={node.id} node={node} />
      ))}
    </svg>
  );
}

export function VoicePathDiagram({
  mode,
  liveState,
  probe,
  replyModel,
  localPhase = null,
  ttsProviderLabel = null,
  ttsMetered = false,
}: {
  mode: VoicePathMode;
  liveState: ScoutRealtimeVoiceConnectionState | "idle";
  probe: ScoutVoiceProbeSnapshot | null;
  replyModel: string | null;
  localPhase?: DirectVoicePhase | null;
  ttsProviderLabel?: string | null;
  ttsMetered?: boolean;
}) {
  return (
    <div className="vpd-wrap" data-mode={mode}>
      {mode === "gpt-live" ? (
        <GptLiveDiagram state={liveState} />
      ) : (
        <LocalLiveDiagram
          probe={probe}
          replyModel={replyModel}
          phase={localPhase}
          ttsProviderLabel={ttsProviderLabel}
          ttsMetered={ttsMetered}
        />
      )}
    </div>
  );
}
