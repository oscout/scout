import { HarnessMark, harnessLabel } from "../../components/HarnessMark.tsx";
import { CrewSprite } from "../../components/CrewSprite.tsx";
import { CREW_ART, hasChipArt } from "../../lib/crew-registry.ts";
import { WorldCharacter } from "./WorldCharacter.tsx";
import { type WorkerCharacter } from "./worker-characters.ts";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { SpriteAvatar, agentSpriteProps } from "../../components/SpriteAvatar.tsx";
import { observeEventWallMs } from "../../lib/lane-observe.ts";
import { floorActorState } from "./agent-floor-actor.ts";
import { type AgentLane } from "./agent-lanes-model.ts";
import { floorCharacterName } from "./floor-character-name.ts";
import { characterContext } from "./character-context.ts";
import { RenderedWorkerSprite } from "./RenderedWorkerSprite.tsx";
import { floorContextEvents } from "./floor-context-model.ts";
import "./shared-floor-character.css";

export type SharedFloorCharacterProps = {
  displayName?: string;
  crewSlug?: string;
  pixelCrew?: boolean;
  lane: AgentLane;
  now: number;
  paused: boolean;
  playful?: boolean;
  character?: WorkerCharacter;
  rigged?: boolean;
  onActor: (lane: AgentLane) => void;
};

/** Activity cadence, not elapsed mounting time, earns the optional gesture. */
export function sharedCharacterGesture(lane: AgentLane, now: number): "run" | "hop" | null {
  if (floorActorState(lane, now).posture !== "working") return null;
  const observations = new Map<number, string>();
  for (const event of lane.observe?.events ?? []) {
    if (event.kind !== "tool" && event.kind !== "message") continue;
    const at = observeEventWallMs(event, lane.observe?.metadata?.session?.sessionStart);
    if (at === null || at > now || now - at > 120_000) continue;
    // Duplicate projections at the same instant never count as sustained work.
    if (event.kind === "tool" || !observations.has(at)) observations.set(at, event.kind);
  }
  const times = [...observations.keys()].sort((a, b) => a - b);
  const last = times.at(-1);
  if (last === undefined || now - last > 15_000) return null;
  if (times.length >= 3 && last - times[0] >= 30_000) return "run";
  return observations.get(last) === "tool" ? "hop" : null;
}

/** A live actor's stance reflects observations; motion never invents extra activity. */
export function SharedFloorCharacter({ lane, now, paused, playful = false, character, rigged = false, onActor, displayName, crewSlug, pixelCrew = false }: SharedFloorCharacterProps) {
  const state = floorActorState(lane, now);
  const context = characterContext(lane, now);
  const runtimeHarness = lane.agent.harness || lane.facts?.attribution;
  const runtimeModel = lane.facts?.model || lane.agent.model;
  const runtimeAnchor = crewSlug && !pixelCrew ? CREW_ART[crewSlug.toLowerCase()]?.runtimeAnchor ?? [.82, .94] : [.82, .94];
  const runtimeLabel = `${harnessLabel(runtimeHarness)} · ${runtimeModel || "Model not reported"}`;
  const contextId = useId();
  const latest = floorContextEvents([lane], now, ["think", "tool", "message", "ask"], 1)[0];
  const thinking = latest?.event.kind === "think" && now - latest.at < 90000 && lane.facts?.turn?.phase !== "complete";
  const renderedPosture = state.posture === "attention" || state.posture === "blocked" ? "waiting" : thinking ? "thinking" : state.posture === "working" ? "working" : "idle";
  const gesture = playful ? sharedCharacterGesture(lane, now) : null;
  const sprite = agentSpriteProps(lane.agent);
  const identity = floorCharacterName(lane);
  const name = identity.named ? identity.name : displayName || identity.name;
  const label = identity.named ? name : `${name} · ${lane.id.slice(-4)}`;
  const node = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const working = state.posture === "working";
  const [atWork, setAtWork] = useState(working);
  useEffect(() => { if (!paused) setAtWork(working); }, [working, paused]);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element);
    const visibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const identityOffset = [...lane.id].reduce((sum, char) => (sum + char.charCodeAt(0)) % 37, 0);
  const needsAttention = state.posture === "attention" || state.posture === "blocked";
  return <button
    ref={node}
    type="button"
    className={`shared-floor-character is-${state.posture}${gesture ? ` has-${gesture}` : ""}${atWork ? " is-at-work" : ""}${paused || !visible || !pageVisible ? " is-still" : ""}`}
    style={{ "--character-delay": `${-identityOffset / 10}s` } as CSSProperties}
    onClick={() => onActor(lane)}
    aria-describedby={contextId}
    aria-label={`${name} ${lane.id.slice(-5)}, ${context.summary}. ${runtimeLabel}. Inspect actor`}
  >
    <span className="shared-floor-character__shadow" aria-hidden="true" />
    <span className={`shared-floor-character__sprite${crewSlug || character || rigged ? " is-rendered" : ""}`} aria-hidden="true">
      {crewSlug && (!pixelCrew || hasChipArt(crewSlug)) ? <CrewSprite slug={crewSlug} pixel={pixelCrew} size={86} paused={paused || !visible || !pageVisible} expression={thinking ? "look-up" : "rest"} /> : crewSlug && pixelCrew ? <SpriteAvatar name={lane.agent.name} size={76} hue={sprite.hue} tone={sprite.tone} /> : rigged ? <WorldCharacter identity={identity.named ? identity.name : lane.id} state={{ mood: renderedPosture === "waiting" ? "concerned" : renderedPosture === "thinking" ? "curious" : renderedPosture === "working" ? "focused" : "neutral", action: renderedPosture === "waiting" ? "idle" : renderedPosture, interaction: {} }} motion={paused || !visible || !pageVisible ? "paused" : "normal"} size={76} /> : character ? <RenderedWorkerSprite character={character} posture={renderedPosture} paused={paused} size={76} /> : <SpriteAvatar name={lane.agent.name} size={76} hue={sprite.hue} tone={sprite.tone} />}
      <span className="shared-floor-character__runtime-mark" style={{ left: `${runtimeAnchor[0] * 100}%`, top: `${runtimeAnchor[1] * 100}%` }} title={runtimeLabel}><HarnessMark harness={runtimeHarness} size={16} title={null} /></span>
    </span>
    {needsAttention ? <span className="shared-floor-character__attention" aria-hidden="true">!</span> : null}
    <span className="shared-floor-character__label" aria-hidden="true"><strong className="shared-floor-character__identity"><span>{label}</span></strong><small>{context.summary}</small></span>
    <span id={contextId} className="shared-floor-character__context" role="tooltip"><strong>{context.state}</strong><span className="shared-floor-character__runtime"><HarnessMark harness={runtimeHarness} size={14} title={null} />{runtimeLabel}</span><span>{context.task || "No task summary reported."}</span>{context.activity ? <span className="shared-floor-character__context-activity">{context.activity}</span> : null}<small>{context.at ? `Observed ${Math.max(0, Math.floor((now - context.at) / 60000)) < 1 ? "just now" : `${Math.floor((now - context.at) / 60000)}m ago`}` : "No recent observation"} · Click to inspect</small></span>
  </button>;
}
