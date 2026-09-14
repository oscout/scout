import { ReplayClock } from "./ReplayClock.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Flag, Hammer, Mail, Mountain, Tent, Wrench, ArrowLeft, ArrowRight, Play, Pause, SlidersHorizontal, Radio } from "lucide-react";
import { SproutActionProof, SproutActionSprite } from "../../components/SproutActionSprite.tsx";
import { CrewSprite } from "../../components/CrewSprite.tsx";
import { assignCastSlug, matchCastSlug, hasChipArt } from "../../lib/crew-registry.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";
import { adventureJourneys, type AdventureKind } from "./agent-adventures-model.ts";
import { adventureReviewReason, type AdventureReviewMode } from "./adventure-review.ts";
import { AdventureScenery } from "./AdventureScenery.tsx";
import { AdventureReader } from "./AdventureReader.tsx";
import { ReplayLog } from "./ReplayLog.tsx";
import { AdventureEvidence } from "./AdventureEvidence.tsx";
import { adventurePlayback, adventureCommandText } from "./adventure-playback.ts";
import { floorPreviewText } from "./floor-preview-text.ts";
import "./agent-adventures.css";

const props = { start: Flag, think: Mountain, read: BookOpen, edit: Hammer, tool: Wrench, message: Mail, wait: Tent, end: Flag, stopped: Tent };
const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const elapsedClock = (ms: number) => { const seconds = Math.floor(Math.max(0, ms) / 1000); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":"); };
const STEP = 218;
export function AgentAdventures({ lanes, now, onActor }: { lanes: AgentLane[]; now: number; onActor: (lane: AgentLane) => void }) {
  const [reader, setReader] = useState<{path: string | null} | null>(null);
  const [actorId, setActorId] = useState(lanes[0]?.id ?? "");
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(0);
  const [together, setTogether] = useState(true);
  const [animatedSprout, setAnimatedSprout] = useState(true);
  const [spritePreview, setSpritePreview] = useState(false);
  const [pixel, setPixel] = useState(false);
  const [paused, setPaused] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [stride, setStride] = useState<"travel" | "land" | "rest">("rest");
  const [reviewMode, setReviewMode] = useState<AdventureReviewMode>("results");
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  const scroll = useRef<HTMLDivElement>(null);
  const actor = lanes.find(lane => lane.id === actorId) ?? lanes[0];
  const journeys = useMemo(() => actor ? adventureJourneys(actor, now) : [], [actor, now]);
  const journey = journeys.find(item => item.id === journeyId) ?? journeys.at(-1);
  const stops = journey?.stops ?? [];
  const index = Math.min(cursor ?? stops.length - 1, stops.length - 1);
  const current = stops[index];
  const slug = actor ? matchCastSlug(actor.agent.name) ?? assignCastSlug(actor.id) : "sprout";
  const recipient = current?.event.to ? lanes.find(lane => [lane.id, lane.agent.id, lane.agent.name, lane.agent.handle].includes(current.event.to!)) : undefined;
  const companions = together && actor ? lanes.filter(lane => lane.id !== actor.id && Boolean(actor.agent.project) && lane.agent.project === actor.agent.project).slice(0, 4) : [];
  const live = journeyId === null;
  const beat = current ? adventurePlayback(current) : null;
  const reviewReason = current ? adventureReviewReason(current, reviewMode) : null;
  const nextReview = stops.findIndex((stop, i) => i > index && adventureReviewReason(stop, reviewMode === "continuous" ? "results" : reviewMode));
  const atCheckpoint = Boolean(playing && reviewReason && reviewed !== current?.id);
  const inspectingArtifact = atCheckpoint || (!playing && !!current);
  const moving = playing && !atCheckpoint;
  useEffect(() => {
    if (!playing || paused || !visible || !current) { setStride("rest"); return; }
    setStride("travel");
    const landing = window.setTimeout(() => setStride(beat?.routine ? "land" : "rest"), 700 / speed);
    const settled = window.setTimeout(() => setStride("rest"), 960 / speed);
    return () => { window.clearTimeout(landing); window.clearTimeout(settled); };
  }, [current?.id, playing, paused, visible, speed]);
  const runAction = stride === "travel" ? beat?.routine ? "jump" : "run" : stride === "land" ? "land" : "idle";
  const command = current ? adventureCommandText(current) : null;
  const outcome = current?.event.result?.exit_code ?? current?.event.result?.exitCode;
  const checkpointDetail = outcome !== undefined ? `Process exited with code ${outcome}` : current?.event.live ? "Command is still running" : "Inspect the observed command and collected evidence below";
  const useActionSprite = animatedSprout && !pixel;
  useEffect(() => { setCursor(0); setReviewed(null); }, [actor?.id, journey?.id]);
  useEffect(() => {
    if (!visible || !moving || !current || index >= stops.length - 1) return;
    const timer = window.setTimeout(() => { if (!document.hidden) setCursor(index + 1); }, Math.max(1000, beat?.durationMs ?? 1600) / speed);
    return () => window.clearTimeout(timer);
  }, [visible, moving, current?.id, index, stops.length, beat?.durationMs, speed]);
  useEffect(() => {
    if (!scroll.current || index < 0) return;
    scroll.current.scrollTo({ left: Math.max(0, 150 + index * STEP - scroll.current.clientWidth * .5), behavior: playing && !paused && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  }, [index, actor?.id, journey?.id]);
  const chooseActor = (id: string) => { setActorId(id); setJourneyId(null); setCursor(0); setPlaying(true); };
  const seek = (next: number) => { setPlaying(false); setJourneyId(journey?.id ?? null); setCursor(Math.max(0, Math.min(stops.length - 1, next))); };
  const togglePlayback = () => { setPlaying(!playing); if (!playing) setReviewed(current?.id ?? null); };
  const playbackStatus = atCheckpoint ? "Checkpoint" : !playing ? "Paused for review" : index >= stops.length - 1 ? journey?.closed ? "Journey complete" : "Following live" : "Playing journey";
  return <section onKeyDown={event => { if (event.code === "Space" && !(event.target as HTMLElement).closest("button,input,select,textarea,summary,[contenteditable=true]")) { event.preventDefault(); togglePlayback(); } }} className={`adventures${inspectingArtifact ? " is-reviewing" : ""}${paused || !playing ? " is-paused" : ""}`} aria-label="Agent Replay" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="adventures__scene" ref={scroll} tabIndex={0} aria-label="Replay landscape, follows the seek position">
      <div className="adventures__landscape" style={{ width: Math.max(1000, stops.length * STEP + 450) }}>
        <AdventureScenery />
        <div className="adventures__trail" aria-hidden="true"/>
        {!stops.length ? <div className="adventures__empty"><CrewSprite slug="sprout" size={120} paused={paused}/><h3>The trail is quiet.</h3><p>{lanes.length ? "No journey observations are available for this agent. Choose another agent or keep watching." : "Your crew will appear when agent activity arrives."}</p></div> : null}
        {stops.map((stop, i) => { const Icon = props[stop.kind]; const pacing = adventurePlayback(stop); return <button type="button" key={stop.id} className={`adventures__stop adventures__stop--${stop.kind}${pacing.checkpoint ? " is-checkpoint" : pacing.routine ? " is-routine" : ""}${i === index ? " is-current" : ""}${i > index ? " is-ahead" : ""}`} style={{ left: 150 + i * STEP }} onClick={() => seek(i)} aria-label={`${stop.label}, ${stamp(stop.at)}`} aria-pressed={i === index}><span className="adventures__stop-title">{pacing.checkpoint ? pacing.label : stop.label}</span><span className="adventures__prop"><Icon size={36} strokeWidth={1.5}/>{stop.kind === "edit" ? <span className="adventures__sparks"/> : null}</span><span className="adventures__artifact">{floorPreviewText(adventureCommandText(stop) ?? stop.artifact).slice(0, 100)}</span><time>{stamp(stop.at)}</time></button>; })}
        {current && actor ? <div className={`adventures__traveler adventures__traveler--${current.kind}${useActionSprite ? " has-action-sprite" : ""}${beat?.checkpoint ? " is-checkpoint" : ""}${beat?.routine && stride === "travel" ? " is-hopping" : ""}`} style={{ left: 112 + index * STEP, transitionDuration: `${700 / speed}ms` }}>{current.kind === "think" ? <span className="adventures__thought">Thinking</span> : null}<button key={current.id} type="button" onClick={() => { setPlaying(false); onActor(actor); }} aria-label={`Inspect ${lanePrimaryLabel(actor.agent, actor.source)}`}><>{useActionSprite ? <SproutActionSprite action={runAction} playbackRate={speed} size={128} paused={paused || !playing}/> : <CrewSprite slug={slug} size={112} pixel={pixel && hasChipArt(slug)} paused={paused || !moving} expression={inspectingArtifact ? "look-right" : expression(current.kind)}/>}</></button><span className="adventures__shadow"/>{current.kind !== "think" ? <span className="adventures__action-caption"><strong>{current.event.tool || (current.kind === "message" ? "Message" : current.kind === "end" ? "Turn complete" : current.kind === "wait" ? "Waiting" : current.label)}</strong>{current.event.tool ? <small>{floorPreviewText(command || current.event.arg).slice(0,90)}</small> : null}</span> : null}</div> : null}
        {current && inspectingArtifact ? <button type="button" className="adventures__world-artifact" style={{left:252 + index * STEP}} onClick={() => { setPlaying(false); setReader({path:null}); }} aria-label="Inspect current artifact"><span className="adventures__artifact-sheet"><BookOpen size={23}/><strong>{reviewReason || current.label}</strong><span>{floorPreviewText(command || current.artifact).slice(0,110)}</span><small>Inspect artifact ↗</small></span><span className="adventures__artifact-stand"/></button> : null}
        {current?.event.to ? <div className="adventures__handoff" style={{ left: 218 + index * STEP }}><Mail size={20}/><span>Message to {current.event.to}</span>{recipient ? <CrewSprite slug={matchCastSlug(recipient.agent.name) ?? assignCastSlug(recipient.id)} size={70} paused={paused || !moving}/> : null}</div> : null}
        {current ? <div className="adventures__frontier" style={{ left: 240 + stops.length * STEP }}><span>{journey?.closed ? "Until the next turn" : "Uncharted"}</span><small>{journey?.closed ? "This journey has ended." : "The next step is not known yet."}</small></div> : null}
      </div>
    </div>
    <div className="adventures__console">
    <details className="replay-selection"><summary>Choose agent / journey</summary>
    <div className="adventures__navigation"><label>{useActionSprite ? "Sprout follows" : "Follow"}<select aria-label="Follow agent" value={actor?.id ?? ""} onChange={event => chooseActor(event.target.value)}>{lanes.map(lane => <option value={lane.id} key={lane.id}>{lanePrimaryLabel(lane.agent, lane.source)} · {lane.id.slice(-5)}</option>)}</select></label><label>Journey<select aria-label="Select journey" value={journey?.id ?? ""} onChange={event => { setJourneyId(event.target.value); setCursor(0); setPlaying(true); }}>{journeys.map((item, i) => <option key={item.id} value={item.id}>{i + 1} · {stamp(item.stops[0]!.at)} · {item.closed ? item.stops.at(-1)!.label : "end not observed"}</option>)}</select></label></div></details>
    <div className="adventures__transport">
      <div className="adventures__recording-clock"><ReplayClock at={current?.at ?? 0} nextAt={stops[index + 1]?.at ?? current?.at ?? 0} start={stops[0]?.at ?? 0} duration={Math.max(1000, beat?.durationMs ?? 1600) / speed} running={visible && moving && !paused} /><span className="adventures__clock-divider" aria-hidden="true" />{current ? <time dateTime={new Date(current.at).toISOString()}>{new Date(current.at).toLocaleString([], {year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",timeZoneName:"short"})}</time> : <span>No recorded timestamp</span>}</div>
      <div className="adventures__transport-top">
        <button type="button" className="adventures__play-button" title="Play or pause · Space" aria-label={playing ? "Pause journey" : "Play journey"} onClick={togglePlayback}>{playing ? <Pause size={17}/> : <Play size={17}/>}<span>{playing ? "Pause" : "Play"}</span></button>
        <span className={`adventures__transport-status${atCheckpoint ? " is-checkpoint" : ""}`} role="status"><i/>{playbackStatus}</span>
        <label className="adventures__speed"><span>Speed</span><select aria-label="Playback pace" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.5}>1.5×</option></select></label>
        <select className="adventures__checkpoint-mode" aria-label="Checkpoint behavior" value={reviewMode} onChange={event => setReviewMode(event.target.value as AdventureReviewMode)}><option value="results">Review results</option><option value="all">Every checkpoint</option><option value="problems">Only problems</option><option value="continuous">Play straight through</option></select>
      </div>
      <button className="adventures__next-review" type="button" disabled={nextReview < 0} onClick={() => { setJourneyId(journey?.id ?? null); setCursor(nextReview); setPlaying(true); setReviewed(null); if (reviewMode === "continuous") setReviewMode("results"); }}><Flag size={12}/> Next review point</button>
      <div className="adventures__playhead"><button type="button" className={live ? "is-live" : ""} aria-pressed={live} onClick={() => { setJourneyId(null); setCursor(null); setPlaying(true); }}><Radio size={14}/> Live edge</button><button type="button" aria-label="Previous observation" disabled={index <= 0} onClick={() => seek(index - 1)}><ArrowLeft size={15}/></button><div className="adventures__seek-track"><input type="range" aria-label="Journey observation" min={0} max={Math.max(0, stops.length - 1)} value={Math.max(0,index)} disabled={!stops.length} onChange={event => seek(Number(event.target.value))}/><div className="adventures__seek-markers">{stops.map((stop, position) => adventureReviewReason(stop, "all") ? <button type="button" key={stop.id} style={{left: `${stops.length > 1 ? position / (stops.length - 1) * 100 : 0}%`}} className={position <= index ? "is-visited" : ""} aria-label={`Seek to ${adventureReviewReason(stop, "all")} at ${stamp(stop.at)}`} title={`${stop.label} · ${stamp(stop.at)}`} onClick={() => seek(position)} /> : null)}</div></div><button type="button" aria-label="Next observation" disabled={index >= stops.length - 1} onClick={() => seek(index + 1)}><ArrowRight size={15}/></button><span>{stops.length ? `${index + 1} / ${stops.length}` : "No observations"}</span></div>

      {atCheckpoint ? <div className="adventures__checkpoint-review"><div><strong>{reviewReason}</strong><small>{checkpointDetail}</small></div><button type="button" onClick={() => setReviewed(current?.id ?? null)}>Continue <ArrowRight size={14}/></button></div> : null}
    </div>
    <ReplayLog stops={stops} index={index} onInspect={position => { seek(position); setReader({path:null}); }}/>
    {actor ? <div onClickCapture={() => setPlaying(false)}><AdventureEvidence stops={stops} index={index} lane={actor} onFile={path => { setPlaying(false); setReader({path}); }}/></div> : null}
    </div>
    {reader ? <AdventureReader stop={current} path={reader.path} onClose={() => setReader(null)} onPath={path => setReader({path})}/> : null}
  </section>;
}
function expression(kind: AdventureKind) { return kind === "think" ? "look-up" as const : kind === "message" ? "look-left" as const : "look-right" as const; }
