import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal, FileCode2, Radio, Coffee, GitBranch } from "lucide-react";
import { SpriteAvatar, agentSpriteProps } from "../../components/SpriteAvatar.tsx";
import { floorActorState, type FloorActorStation } from "./agent-floor-actor.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";
import "./agent-floor-world.css";
import { FLOOR_WORLD_WIDTH, FLOOR_WORLD_HEIGHT, FLOOR_ROOMS, floorWorldPosition, floorWorldRoute } from "./agent-floor-world-layout.ts";
export { FLOOR_WORLD_WIDTH, FLOOR_WORLD_HEIGHT } from "./agent-floor-world-layout.ts";

/**
 * THESIS: a shared operations building, with agents travelling to the work.
 * WORLD: Scout's neutral control room, cutaway rooms, physical consoles, lime activity.
 * STORY: locate an actor, read its posture, select it to inspect the real trace.
 * VIEW: four shared rooms around a central passage; eight actors per sector.
 * FORM: an RTS cutaway with stable berths and event-driven movement through the passage.
 */
const ROOMS = [
  { id: "home", name: "Crew quarters", detail: "Ready · quiet · attention", ...FLOOR_ROOMS.home, icon: Coffee },
  { id: "tools", name: "Execution lab", detail: "Tools & runtime", ...FLOOR_ROOMS.tools, icon: Terminal },
  { id: "message", name: "Communications", detail: "Messages & requests", ...FLOOR_ROOMS.message, icon: Radio },
  { id: "edit", name: "Build workshop", detail: "Files & patches", ...FLOOR_ROOMS.edit, icon: FileCode2 },
] as const;

type WorldProps = {
  berths: Record<string, number>; lanes: AgentLane[]; now: number; selectedId: string | null; motionPaused: boolean; instant?: boolean;
  onFocus: (id: string | null) => void; onSelect: (lane: AgentLane) => void;
  onFocusRoom: (station: FloorActorStation, x: number, y: number) => void;
};

function WorldActor({ lane, berth, now, selected, motionPaused, instant, onFocus, onSelect }: {
  lane: AgentLane; berth: number; now: number; selected: boolean; motionPaused: boolean; instant?: boolean;
  onFocus: WorldProps["onFocus"]; onSelect: WorldProps["onSelect"];
}) {
  const actor = floorActorState(lane, now);
  const point = floorWorldPosition(actor.station, berth);
  const nodeRef = useRef<HTMLButtonElement>(null);
  const initialTransform = useRef(`translate(${point.x}px, ${point.y}px)`);
  const initialized = useRef(false);
  const [moving, setMoving] = useState(false);
  const sprite = agentSpriteProps(lane.agent);
  const name = lanePrimaryLabel(lane.agent, lane.source);
  const shortId = lane.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4);
  const task = lane.facts?.currentTask || lane.facts?.branch || lane.agent.harness || "Observed session";

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const transform = (x: number, y: number) => `translate(${x}px, ${y}px)`;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    const from = initialized.current ? { x: matrix.m41, y: matrix.m42 } : point;
    if (motionPaused) { initialized.current = true; setMoving(false); return; }
    node.style.transform = transform(point.x, point.y);
    const travelled = Math.hypot(from.x - point.x, from.y - point.y);
    if (!initialized.current || travelled < 1 || reduced.matches || instant) {
      initialized.current = true;
      setMoving(false);
      return;
    }
    const points = floorWorldRoute(from, point);
    let distance = 0;
    const distances = points.map((p, i) => {
      if (i) distance += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
      return distance;
    });
    const animation = node.animate(points.map((p, i) => ({ transform: transform(p.x, p.y), offset: distances[i] / distance })), {
      duration: Math.min(4200, Math.max(900, distance * 5)), easing: "linear",
    });
    setMoving(true);
    animation.onfinish = () => setMoving(false);
    const stopMotion = () => { if (reduced.matches) { animation.cancel(); setMoving(false); } };
    reduced.addEventListener("change", stopMotion);
    return () => {
      const current = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      animation.cancel();
      node.style.transform = transform(current.m41, current.m42);
      reduced.removeEventListener("change", stopMotion);
    };
  }, [point.x, point.y, motionPaused, instant]);

  return <button ref={nodeRef} type="button" style={{ transform: initialTransform.current }}
    className={`floor-world__actor is-${actor.posture}${selected ? " is-selected" : ""}${moving ? " is-moving" : ""}`}
    data-station={actor.station} aria-pressed={selected}
    aria-label={`${name} ${shortId}, ${actor.label}. Inspect actor`}
    onClick={() => onSelect(lane)} onMouseEnter={() => onFocus(lane.id)} onMouseLeave={() => onFocus(null)}
    onFocus={() => onFocus(lane.id)} onBlur={() => onFocus(null)}>
    <span className="floor-world__actor-shadow" />
    <span className="floor-world__ring" />
    <span className="floor-world__sprite"><SpriteAvatar name={lane.agent.name} size={44} hue={sprite.hue} tone={sprite.tone} glow={false} /></span>
    {actor.posture === "attention" || actor.posture === "blocked" ? <span className="floor-world__alert">!</span> : null}
    <span className="floor-world__actor-name">{name}<small>{shortId}</small></span>
    <span className="floor-world__actor-action">{moving ? "Moving" : actor.label}</span>
    {selected ? <span className="floor-world__thought">{task.slice(0, 150)}</span> : null}
  </button>;
}

export function AgentFloorWorld({ berths, lanes, now, selectedId, motionPaused, instant, onFocus, onSelect, onFocusRoom }: WorldProps) {
  const states = lanes.map((lane) => floorActorState(lane, now));
  const attention = states.filter((state) => state.posture === "attention" || state.posture === "blocked").length;
  return <div className={`floor-world${motionPaused ? " is-motion-paused" : ""}`} style={{ width: FLOOR_WORLD_WIDTH, height: FLOOR_WORLD_HEIGHT,
    left: -FLOOR_WORLD_WIDTH / 2, top: -FLOOR_WORLD_HEIGHT / 2 } as CSSProperties}>
    <div className="floor-world__passage"><span>SCOUT / OPERATIONS</span><span>{attention ? `${attention} need attention` : "Live observation"}</span></div>
    <div className="floor-world__spine" />
    {ROOMS.map((room) => {
      const Icon = room.icon;
      const residents = states.filter((state) => state.station === room.id);
      const working = residents.some((state) => state.posture === "working");
      return <section key={room.id} className={`floor-world__room is-${room.id}${working ? " is-active" : ""}`}
        style={{ left: room.x, top: room.y }} aria-label={`${room.name}, ${residents.length} actors`}>
        <header><button type="button" aria-label={`Inspect ${room.name}`} onClick={() => onFocusRoom(room.id, room.x + 205, room.y + 132)}><Icon size={20} /><span><strong>{room.name}</strong><small>{room.detail}</small></span><span className="floor-world__room-count">{residents.length}</span></button></header>
        <div className="floor-world__furniture" aria-hidden="true">
          {Array.from({ length: 8 }, (_, berth) => <span key={berth} className={`floor-world__console${lanes.some((lane, index) => berths[lane.id] === berth && states[index]?.station === room.id) ? " is-occupied" : ""}`}
            style={{ left: 65 + (berth % 4) * 94, top: 83 + Math.floor(berth / 4) * 94 }}>
            <span className="floor-world__screen"><i /><i /><i /></span><span className="floor-world__keyboard" />
          </span>)}
        </div>
        <span className="floor-world__door" aria-hidden="true" />
      </section>;
    })}
    <div className="floor-world__center-mark" aria-hidden="true"><GitBranch size={24} /></div>
    {lanes.map((lane) => <WorldActor key={lane.id} lane={lane} berth={berths[lane.id] ?? 0} now={now}
      instant={instant} motionPaused={motionPaused} selected={selectedId === lane.id} onFocus={onFocus} onSelect={onSelect} />)}
  </div>;
}
