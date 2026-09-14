import { floorPreviewText } from "./floor-preview-text.ts";
import { floorRelations } from "./floor-memory.ts";
import { Terminal, FileCode2, Radio, Coffee, ArrowUpRight, X } from "lucide-react";
import { SpriteAvatar, agentSpriteProps } from "../../components/SpriteAvatar.tsx";
import { floorContextEvents } from "./floor-context-model.ts";
import { timeAgo } from "../../lib/time.ts";
import { floorActorState, type FloorActorStation } from "./agent-floor-actor.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";
import { buildLaneSessionStats, buildLaneTouchedFiles, laneRecentCommands } from "./agent-lane-detail.ts";
import "./floor-context-sheet.css";

const ROOMS = {
  home: { title: "Crew quarters", subtitle: "Readiness & attention", icon: Coffee },
  tools: { title: "Execution lab", subtitle: "Recent commands & tool activity", icon: Terminal },
  edit: { title: "Build workshop", subtitle: "Observed files & changes", icon: FileCode2 },
  message: { title: "Communications", subtitle: "Observed messages & requests", icon: Radio },
};

type Props = {
  lane: AgentLane | null; room: FloorActorStation | null; lanes: AgentLane[]; allLanes: AgentLane[]; now: number;
  onClose: () => void; onSelectRoom: (room: FloorActorStation) => void; onSelectLane: (lane: AgentLane) => void; onOpenTrace: (lane: AgentLane) => void;
};


function ActorRow({ lane, now, onSelect }: { lane: AgentLane; now: number; onSelect: Props["onSelectLane"] }) {
  const sprite = agentSpriteProps(lane.agent);
  const state = floorActorState(lane, now);
  return <button className="floor-context__actor-row" type="button" onClick={() => onSelect(lane)}>
    <SpriteAvatar name={lane.agent.name} size={28} hue={sprite.hue} tone={sprite.tone} />
    <span><strong>{lanePrimaryLabel(lane.agent, lane.source)}</strong><small>{lane.agent.harness} · {lane.id.slice(-5)}</small></span>
    <span className={`floor-context__posture is-${state.posture}`}>{state.label}</span><ArrowUpRight size={13} />
  </button>;
}

function Empty({ children }: { children: string }) { return <p className="floor-context__empty">{children}</p>; }

export function FloorContextSheet({ lane, room, lanes, allLanes, now, onClose, onSelectRoom, onSelectLane, onOpenTrace }: Props) {
  const relations = floorRelations(allLanes);
  const family = lane ? relations.filter((edge) => edge.parent.id === lane.id || edge.child.id === lane.id) : [];
  const descriptor = room ? ROOMS[room] : null;
  const Icon = descriptor?.icon ?? Terminal;
  const title = lane ? lanePrimaryLabel(lane.agent, lane.source) : descriptor?.title ?? "Floor";
  const residents = room ? lanes.filter((entry) => floorActorState(entry, now).station === room) : [];
  const events = floorContextEvents(lanes, now, room === "message" ? ["message", "ask"] : ["tool"]);
  const stats = lane ? buildLaneSessionStats(lane) : null;
  const files = (lane ? [lane] : lanes).flatMap((entry) => buildLaneTouchedFiles({ events: entry.observe?.events ?? [], files: entry.facts?.touchedFiles ?? entry.observe?.files ?? [] }, 50).map((file) => ({ lane: entry, file })))
    .filter((entry) => room !== "edit" || entry.file.state !== "read");
  const commands = lane ? laneRecentCommands(lane.observe, 4) : [];
  const state = lane ? floorActorState(lane, now) : null;

  return <aside className="agent-floor__trace-panel floor-context" aria-label={`${title} context sheet`}>
    <header className="floor-context__header"><Icon size={20} /><div><h2>{title}</h2><p>{lane ? `${lane.agent.harness ?? "Agent"} · ${lane.id.slice(-8)} · ${state?.label}` : descriptor?.subtitle}</p></div>
      <button type="button" onClick={onClose} aria-label="Close context sheet"><X size={17} /></button>
    </header>
    {!lane ? <nav className="floor-context__tabs" aria-label="Room sheets">
      {([['home', 'Crew'], ['tools', 'Execution'], ['edit', 'Build'], ['message', 'Comms']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={room === id} onClick={() => onSelectRoom(id)}>{label}</button>)}
    </nav> : null}
    <div className="floor-context__body">
      {lane ? <>
        <section><h3>Current task</h3><p className="floor-context__task">{floorPreviewText(lane.facts?.currentTask) || "No task summary reported for this session."}</p></section>
        <dl className="floor-context__facts">
          {[["Model", lane.facts?.model || stats?.model], ["Branch", lane.facts?.branch || stats?.branch], ["Workspace", lane.facts?.cwd || stats?.cwd], ["Parent", lane.facts?.parentAgentName]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value ?? undefined}>{value}</dd></div>)}
        </dl>
        <section><h3>Capabilities & tools</h3>
          {lane.agent.capabilities?.length || lane.agent.skills?.length ? <div className="floor-context__abilities">{[...new Set([...(lane.agent.capabilities ?? []), ...(lane.agent.skills ?? [])])].map((ability) => <span key={ability}>{ability}</span>)}</div> : <Empty>No capabilities reported by this actor.</Empty>}
          <p className="floor-context__scope">Tools observed in loaded session history</p>
          <div className="floor-context__abilities">{[...new Set((lane.observe?.events ?? []).filter((event) => event.kind === "tool" && event.tool).map((event) => event.tool!))].slice(0, 20).map((tool) => <span key={tool}>{tool}</span>)}</div>
        </section>
        <section><h3>Session relationships <span>{family.length}</span></h3>{family.length ? family.map((edge) => {
          const isParent = edge.child.id === lane.id;
          const relative = isParent ? edge.parent : edge.child;
          return <div key={relative.id}><p className="floor-context__scope">{isParent ? "Parent session" : "Child session"}</p><ActorRow lane={relative} now={now} onSelect={onSelectLane} /></div>;
        }) : <Empty>{lane.facts?.parentSessionId ? "Parent session is outside the loaded fleet." : "No parent or child sessions reported in the loaded fleet."}</Empty>}</section>
        <section><h3>Touched files <span>{files.length}</span></h3>
          {files.length ? files.slice(0, 10).map(({ file }) => <div key={file.path} className="floor-context__file"><FileCode2 size={14} /><code title={file.path}>{file.path}</code><small>{file.state}</small></div>) : <Empty>No files observed yet.</Empty>}
        </section>
        <section><h3>Recent commands</h3>{commands.length ? commands.map((command) => <div className="floor-context__command" key={command.id}><pre>{command.command}</pre>{command.outcome ? <small>{command.outcome}</small> : null}</div>) : <Empty>No shell commands observed yet.</Empty>}</section>
      </> : <>
        <section><h3>In this room <span>{residents.length}</span></h3>
          {residents.length ? residents.map((entry) => <ActorRow key={entry.id} lane={entry} now={now} onSelect={onSelectLane} />) : <Empty>No actors in this room right now.</Empty>}
        </section>
        {room === "home" ? <section><h3>Tasks in this sector</h3>{lanes.map((entry) => <button key={entry.id} type="button" className="floor-context__task-row" onClick={() => onSelectLane(entry)}><strong>{lanePrimaryLabel(entry.agent, entry.source)} <small>{entry.id.slice(-5)}</small></strong><p>{floorPreviewText(entry.facts?.currentTask) || "No task summary reported."}</p></button>)}</section> : null}
        {room === "edit" ? <section><h3>Changed files <span>{files.length}</span></h3><p className="floor-context__scope">Observed in this sector’s loaded session history.</p>
          {files.length ? files.map(({ lane: owner, file }) => <button type="button" key={`${owner.id}:${file.path}`} className="floor-context__file is-action" title={`Inspect the actor that touched ${file.path}`} onClick={() => onSelectLane(owner)}><FileCode2 size={14} /><span><code title={file.path}>{file.path}</code><small>{lanePrimaryLabel(owner.agent, owner.source)} · {owner.id.slice(-5)}</small></span><small>{file.state}</small></button>) : <Empty>No changed files observed in this sector.</Empty>}
        </section> : null}
        {room === "tools" || room === "message" ? <section><h3>{room === "tools" ? "Tool activity" : "Messages & requests"}</h3><p className="floor-context__scope">This sector · last 15 minutes · observed harness activity</p>
          {events.length ? events.map(({ lane: owner, event, at }) => <article className="floor-context__event" key={`${owner.id}:${event.id}`}>
            <header><strong>{room === "tools" ? event.tool || "Tool" : event.kind === "ask" ? "Request" : "Message"}</strong><time>{timeAgo(at, now)}</time></header>
            <p>{floorPreviewText(event.arg || event.text, 800)}</p>
            {event.diff ? <small className="floor-context__diff">+{event.diff.add} −{event.diff.del}</small> : null}
            <button type="button" onClick={() => onSelectLane(owner)}>{lanePrimaryLabel(owner.agent, owner.source)} · {owner.id.slice(-5)} <ArrowUpRight size={12} /></button>
          </article>) : <Empty>{room === "tools" ? "No recent tool activity in this sector." : "No recent messages or requests in this sector."}</Empty>}
        </section> : null}
      </>}
    </div>
    {lane ? <footer className="floor-context__footer"><span>Observed session context</span><button type="button" onClick={() => onOpenTrace(lane)}>Open full trace <ArrowUpRight size={14} /></button></footer> : null}
  </aside>;
}
