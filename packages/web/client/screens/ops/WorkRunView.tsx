import { useEffect, useMemo, useState } from "react";
import { SpriteAvatar, agentSpriteProps } from "../../components/SpriteAvatar.tsx";
import { floorContextEvents } from "./floor-context-model.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";
import "./work-run-view.css";

const WINDOW = 15 * 60_000;
const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function WorkRunView({ lanes, now, onActor }: { lanes: AgentLane[]; now: number; onActor: (lane: AgentLane) => void }) {
  const [solo, setSolo] = useState(false);
  const [actorId, setActorId] = useState<string | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const horizon = end ?? now;
  const start = horizon - WINDOW;
  const at = Math.max(start, Math.min(horizon, cursor ?? horizon));
  const activeId = lanes.some((lane) => lane.id === actorId) ? actorId : lanes[0]?.id;
  const visible = solo ? lanes.filter((lane) => lane.id === activeId) : lanes;
  const records = useMemo(() => lanes.map((lane) => ({ lane, events: floorContextEvents([lane], horizon, ["tool", "message", "ask"], 250).reverse() })), [lanes, horizon]);
  const inspected = records.flatMap((row) => row.events).find((row) => `${row.lane.id}:${row.event.id}` === selected);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setCursor((value) => {
        const next = Math.min(horizon, (value ?? start) + 5_000);
        return next;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing, horizon, start]);
  useEffect(() => { if (playing && cursor !== null && cursor >= horizon) setPlaying(false); }, [playing, cursor, horizon]);
  const play = () => {
    if (playing) { setPlaying(false); return; }
    setEnd(horizon);
    if (at >= horizon) setCursor(start);
    setPlaying(true);
  };
  return <section className={`work-run${playing ? " is-playing" : ""}`} aria-label="Work run replay">
    <header className="work-run__controls">
      <strong>Work run</strong>
      <div role="group" aria-label="Actors shown"><button type="button" aria-pressed={!solo} onClick={() => setSolo(false)}>Everyone</button><button type="button" aria-pressed={solo} onClick={() => setSolo(true)}>Solo</button></div>
      {solo ? <select aria-label="Solo actor" value={activeId ?? ""} onChange={(event) => setActorId(event.target.value)}>{lanes.map((lane) => <option key={lane.id} value={lane.id}>{lanePrimaryLabel(lane.agent, lane.source)} · {lane.id.slice(-5)}</option>)}</select> : null}
      <button type="button" onClick={play} disabled={!lanes.length}>{playing ? "Pause replay" : "Play replay"}</button>
      <button type="button" aria-pressed={end === null} onClick={() => { setEnd(null); setCursor(null); setPlaying(false); }}>Live</button>
      <time>{stamp(at)}</time>
    </header>
    <label className="work-run__scrub"><span>{stamp(start)}</span><input type="range" aria-label="Replay time" min={start} max={horizon} step={1000} value={at} onChange={(event) => { setEnd(horizon); setCursor(Number(event.target.value)); setPlaying(false); }} /><span>{stamp(horizon)}</span></label>
    <p className="work-run__caption">Recorded activity · 15 minutes · position follows the latest observation · playback 20×</p>
    <div className="work-run__scroll"><div className="work-run__level">
      {visible.map((lane) => {
        const events = records.find((row) => row.lane.id === lane.id)?.events ?? [];
        const latest = events.filter((row) => row.at <= at).at(-1);
        const markers = events.slice(-18);
        const sprite = agentSpriteProps(lane.agent);
        const position = latest ? (latest.at - start) / WINDOW * 100 : 0;
        return <article className="work-run__track" key={lane.id}>
          <button type="button" className="work-run__actor-name" onClick={() => onActor(lane)}>{lanePrimaryLabel(lane.agent, lane.source)}<small>{lane.id.slice(-5)}</small></button>
          <div className="work-run__path">
            <div className="work-run__ground" aria-hidden="true" />
            {markers.map((row) => <button type="button" key={row.event.id} className={`work-run__checkpoint${row.at <= at ? " is-reached" : ""}${selected === `${lane.id}:${row.event.id}` ? " is-selected" : ""}`} style={{ left: `${(row.at - start) / WINDOW * 100}%` }} aria-label={`${row.event.tool || row.event.kind} at ${stamp(row.at)}`} title={`${row.event.tool || row.event.kind} · ${stamp(row.at)}`} onClick={() => setSelected(`${lane.id}:${row.event.id}`)}><span aria-hidden="true">{row.event.kind === "tool" ? "◆" : "●"}</span></button>)}
            <button type="button" className={`work-run__runner${latest ? " has-observation" : ""}`} style={{ left: `${position}%` }} onClick={() => onActor(lane)} aria-label={`Inspect ${lanePrimaryLabel(lane.agent, lane.source)}, ${latest ? `latest observation ${stamp(latest.at)}` : "no observation before replay time"}`}><span><SpriteAvatar name={lane.agent.name} size={54} hue={sprite.hue} tone={sprite.tone} /></span></button>
            {!latest ? <span className="work-run__waiting">No observation yet</span> : null}
          </div>
          <small className="work-run__coverage">{events.length > 18 ? "Latest 18 checkpoints shown" : `${events.length} observed checkpoints`}</small>
        </article>;
      })}
      {!lanes.length ? <p className="work-run__empty">Actors appear here when session activity is available.</p> : null}
    </div></div>
    {inspected ? <aside className="work-run__detail"><div><strong>{inspected.event.tool || inspected.event.kind}</strong><time>{stamp(inspected.at)}</time><button type="button" onClick={() => setSelected(null)}>Close</button></div><p>{inspected.event.text?.slice(0, 700) || "No event text recorded."}</p><button type="button" onClick={() => onActor(inspected.lane)}>Inspect actor</button></aside> : null}
  </section>;
}
