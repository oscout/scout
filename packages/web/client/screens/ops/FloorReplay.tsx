import { floorActorState } from "./agent-floor-actor.ts";
import { AgentFloorWorld } from "./AgentFloorWorld.tsx";
import { replayFloorLane } from "./floor-replay-model.ts";
import { useEffect, useRef, useState } from "react";
import { floorContextEvents } from "./floor-context-model.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";
import "./floor-replay.css";
const WINDOW = 15 * 60_000;
export function FloorReplay({ lanes, now, onActor }: { lanes: AgentLane[]; now: number; onActor: (lane: AgentLane) => void }) {
  const [view, setView] = useState<"both" | "timeline" | "map">("both");
  const [projection, setProjection] = useState<"flat" | "iso">("flat");
  const [sector, setSector] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState({ width: 800, height: 300 });
  useEffect(() => { if (!mapRef.current) return; const observer = new ResizeObserver(([entry]) => setMapSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(mapRef.current); return () => observer.disconnect(); }, []);
  const [anchor] = useState(now);
  const [cursor, setCursor] = useState(anchor);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [snapshotLanes] = useState(lanes);
  const [events] = useState(() => floorContextEvents(lanes, anchor, ["tool", "message", "ask"], 2000).reverse());
  useEffect(() => { if (!playing) return; const timer = window.setInterval(() => setCursor((at) => Math.min(anchor, at + 250 * speed)), 250); return () => window.clearInterval(timer); }, [playing, speed, anchor]);
  useEffect(() => { if (cursor >= anchor) setPlaying(false); }, [cursor, anchor]);
  const sectorLanes = snapshotLanes.slice(sector * 8, sector * 8 + 8);
  const historicalLanes = sectorLanes.flatMap((lane) => { const historical = replayFloorLane(lane, cursor); return historical ? [historical] : []; });
  const berths = Object.fromEntries(sectorLanes.map((lane, index) => [lane.id, index]));
  const mapScale = Math.max(.1, Math.min((mapSize.width - 20) / (projection === "iso" ? 1395 : 960), (mapSize.height - 20) / (projection === "iso" ? 805 : 650)));
  const selectedEvent = inspect ? events.filter((entry) => entry.lane.id === inspect && entry.at <= cursor).slice(-1)[0] : null;
  const current = events.filter((entry) => entry.at <= cursor).slice(-1)[0];
  return <section className={`floor-replay is-${view}`} aria-label="History replay"><header><div role="group" aria-label="Replay layout">{(["both", "timeline", "map"] as const).map((layout) => <button type="button" key={layout} aria-pressed={view === layout} onClick={() => setView(layout)}>{layout === "both" ? "Both" : layout === "timeline" ? "Timeline" : "Map"}</button>)}</div><div className="floor-replay__projection" role="group" aria-label="Replay map projection">{(["flat", "iso"] as const).map((mode) => <button key={mode} type="button" aria-pressed={projection === mode} onClick={() => setProjection(mode)}>{mode === "iso" ? "Iso" : "Flat"}</button>)}{snapshotLanes.length > 8 ? <><button type="button" aria-label="Previous replay sector" disabled={sector === 0} onClick={() => setSector(sector - 1)}>←</button><span>Sector {sector + 1}</span><button type="button" aria-label="Next replay sector" disabled={(sector + 1) * 8 >= snapshotLanes.length} onClick={() => setSector(sector + 1)}>→</button></> : null}</div></header>
    <div className="floor-replay__map" ref={mapRef}><div className="floor-replay__world" style={{ transform: `scale(${mapScale})${projection === "iso" ? " matrix(0.8660254, 0.5, -0.8660254, 0.5, 0, 0)" : ""}` }}><AgentFloorWorld lanes={historicalLanes} now={cursor} berths={berths} instant motionPaused={false} selectedId={inspect ?? focus} onFocus={setFocus} onSelect={(lane) => setInspect(lane.id)} onFocusRoom={(station) => setInspect(historicalLanes.find((lane) => floorActorState(lane, cursor).station === station)?.id ?? null)} /></div>{!historicalLanes.length ? <p className="floor-replay__map-empty">No actors observed yet at this point</p> : null}</div>
    <div className="floor-replay__controls"><button type="button" onClick={() => { if (cursor >= anchor) setCursor(anchor - WINDOW); setPlaying(!playing); }}>{playing ? "Pause replay" : "Play replay"}</button><select aria-label="Replay speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value={1}>1×</option><option value={10}>10×</option><option value={30}>30×</option></select><input type="range" aria-label="Replay time" min={anchor - WINDOW} max={anchor} step={1000} value={cursor} onChange={(event) => { setPlaying(false); setCursor(Number(event.target.value)); }} /><time>{new Date(cursor).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>
    <div className="floor-replay__details"><div className="floor-replay__track-label"><span>Actor timelines · {events.length} observations</span><div className="floor-replay__legend" aria-label="Timeline event colors"><span>Tools</span><span>Messages / asks</span></div></div><div className="floor-replay__axis"><span>15 minutes before opening</span><span>Snapshot end</span></div>
    <div className="floor-replay__tracks">{snapshotLanes.map((lane) => <div className="floor-replay__row" key={lane.id}><button type="button" onClick={() => onActor(lane)}>{lanePrimaryLabel(lane.agent, lane.source)}<small>{lane.id.slice(-5)}</small></button><div className="floor-replay__track"><i style={{ left: `${(cursor - anchor + WINDOW) / WINDOW * 100}%` }} />{events.filter((entry) => entry.lane.id === lane.id).map(({ event, at }) => <button type="button" key={event.id} className={`is-${event.kind}${at > cursor ? " is-future" : ""}`} style={{ left: `${(at - anchor + WINDOW) / WINDOW * 100}%` }} aria-label={`${event.tool || event.kind} at ${new Date(at).toLocaleTimeString()}`} title={event.tool || event.kind} onClick={() => { setPlaying(false); setCursor(at); }} />)}</div></div>)}</div>
    </div>
    {selectedEvent ? <div className="floor-replay__selection"><strong>{lanePrimaryLabel(selectedEvent.lane.agent, selectedEvent.lane.source)}</strong> · {selectedEvent.event.tool || selectedEvent.event.kind}<button type="button" onClick={() => setInspect(null)}>Clear selection</button><p>{(selectedEvent.event.arg || selectedEvent.event.text).slice(0, 500)}</p></div> : null}
    <article className="floor-replay__event">{current ? <><header><strong>{current.event.tool || current.event.kind}</strong><button type="button" onClick={() => onActor(current.lane)}>Inspect {lanePrimaryLabel(current.lane.agent, current.lane.source)}</button></header><pre>{(current.event.arg || current.event.text).slice(0, 1600)}</pre></> : <p>No loaded event before this point.</p>}</article>
  </section>;
}
