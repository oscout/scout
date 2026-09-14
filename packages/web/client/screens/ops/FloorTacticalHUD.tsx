import { FloorSavedWork } from "./FloorSavedWork.tsx";
import { useState } from "react";
import { Radar, AlertTriangle, ArrowUpRight, Pause, Play, ChevronDown, ChevronUp } from "lucide-react";
import { floorActorState, type FloorActorStation } from "./agent-floor-actor.ts";
import { floorWorldPosition, FLOOR_ROOMS, FLOOR_WORLD_WIDTH, FLOOR_WORLD_HEIGHT } from "./agent-floor-world-layout.ts";
import { floorContextEvents } from "./floor-context-model.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";
import { timeAgo } from "../../lib/time.ts";
import "./floor-tactical-hud.css";

const ROOM_NAMES: Record<FloorActorStation, string> = { home: "Crew", tools: "Execution", edit: "Build", message: "Comms" };

export function FloorTacticalHUD({ berths, allLanes, lanes, now, selectedId, sheetOpen, motionPaused, onPause, onRoom, onActor }: {
  berths: Record<string, number>; allLanes: AgentLane[]; lanes: AgentLane[]; now: number; selectedId: string | null;
  sheetOpen: boolean; motionPaused: boolean; onPause: () => void;
  onRoom: (station: FloorActorStation) => void; onActor: (lane: AgentLane) => void;
}) {
  const [radarOpen, setRadarOpen] = useState(true);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attention = allLanes.filter((lane) => ["attention", "blocked"].includes(floorActorState(lane, now).posture));
  const activity = floorContextEvents(allLanes, now, ["tool", "message", "ask"]).slice(0, 4);
  return <>
    <aside className="floor-tactical floor-tactical__radar" aria-label="Tactical overview">
      <header><button type="button" className="floor-tactical__radar-toggle" aria-expanded={radarOpen} onClick={() => setRadarOpen(!radarOpen)}><Radar size={14} />Sector radar {radarOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button></header>
      {radarOpen ? <>
        <div className="floor-tactical__map" aria-label="Current sector rooms">
          {(Object.keys(FLOOR_ROOMS) as FloorActorStation[]).map((station) => {
            const room = FLOOR_ROOMS[station];
            const count = lanes.filter((lane) => floorActorState(lane, now).station === station).length;
            return <button key={station} type="button" className={`floor-tactical__room${count ? " is-occupied" : ""}`}
              style={{ left: `${room.x / FLOOR_WORLD_WIDTH * 100}%`, top: `${room.y / FLOOR_WORLD_HEIGHT * 100}%` }}
              aria-label={`Open ${ROOM_NAMES[station]} sheet from radar, ${count} actors`} onClick={() => onRoom(station)}>
              <span>{ROOM_NAMES[station]}</span>
            </button>;
          })}
          {lanes.map((lane) => {
            const state = floorActorState(lane, now);
            const point = floorWorldPosition(state.station, berths[lane.id] ?? 0);
            return <button type="button" key={lane.id} className={`floor-tactical__dot is-${state.posture}${selectedId === lane.id ? " is-selected" : ""}`}
              style={{ left: `${point.x / FLOOR_WORLD_WIDTH * 100}%`, top: `${point.y / FLOOR_WORLD_HEIGHT * 100}%` }}
              aria-label={`Locate ${lanePrimaryLabel(lane.agent, lane.source)} ${lane.id.slice(-5)}`} onClick={() => onActor(lane)} />;
          })}
        </div>
        <p>{lanes.length} in sector · {allLanes.length} in fleet</p>
      </> : null}
      <button type="button" className="floor-tactical__motion" aria-pressed={motionPaused} onClick={onPause}>{motionPaused ? <Play size={13} /> : <Pause size={13} />}{motionPaused ? "Resume scene motion" : "Pause scene motion"}</button>
      <FloorSavedWork lanes={allLanes} selected={allLanes.find((lane) => lane.id === selectedId) ?? null} onActor={onActor} />
      {motionPaused ? <small className="floor-tactical__paused">Motion paused · data stays live</small> : null}
    </aside>
    {!sheetOpen ? <aside className="floor-tactical floor-tactical__activity" aria-label="Fleet activity and attention">
      <button type="button" className={`floor-tactical__attention${attention.length ? " has-attention" : ""}`} aria-expanded={attentionOpen} onClick={() => setAttentionOpen(!attentionOpen)}>
        <AlertTriangle size={14} /><span>{attention.length ? `${attention.length} need attention` : "No attention signals"}</span><ChevronDown size={13} />
      </button>
      {attentionOpen ? <div className="floor-tactical__attention-list">{attention.length ? attention.map((lane) => <button type="button" key={lane.id} onClick={() => { setAttentionOpen(false); onActor(lane); }}><strong>{lanePrimaryLabel(lane.agent, lane.source)}</strong><small>{lane.id.slice(-5)} · {floorActorState(lane, now).label}</small></button>) : <p>No blocked or needs-attention actors reported in this fleet.</p>}</div> : null}
      <h3>Recent activity <span>15m</span></h3>
      {activity.length ? activity.map(({ lane, event, at }) => <button className="floor-tactical__activity-item" type="button" key={`${lane.id}:${event.id}`} onClick={() => onActor(lane)}>
        <span><strong>{event.kind === "tool" ? event.tool || "Tool" : event.kind === "ask" ? "Request" : "Message"}</strong><time>{timeAgo(at, now)}</time></span>
        <span><small>{lanePrimaryLabel(lane.agent, lane.source)} · {lane.id.slice(-5)}</small><ArrowUpRight size={11} /></span>
      </button>) : <p className="floor-tactical__empty">No recent events.</p>}
    </aside> : null}
  </>;
}
