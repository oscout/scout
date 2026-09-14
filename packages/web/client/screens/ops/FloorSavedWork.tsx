import { useState } from "react";
import { Pin, X } from "lucide-react";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";

type SavedWork = { id: string; name: string; task: string; savedAt: number };
const KEY = "openscout:floor-saved-work";
function read(): SavedWork[] {
  try { const rows: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(rows) ? rows.filter((row): row is SavedWork => !!row && typeof row.id === "string" && typeof row.name === "string" && typeof row.task === "string" && typeof row.savedAt === "number").slice(0, 24) : []; } catch { return []; }
}
export function FloorSavedWork({ lanes, selected, onActor }: { lanes: AgentLane[]; selected: AgentLane | null; onActor: (lane: AgentLane) => void }) {
  const [saved, setSaved] = useState(read);
  const [expanded, setExpanded] = useState(false);
  const update = (next: SavedWork[]) => { setSaved(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Memory-only when storage is unavailable. */ } };
  const pinned = selected && saved.some((row) => row.id === selected.id);
  return <div className="floor-saved">
    <button type="button" className="floor-tactical__motion" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Pin size={13} />Saved work · {saved.length}</button>
    {selected ? <button type="button" className="floor-tactical__motion" aria-pressed={Boolean(pinned)} disabled={!pinned && saved.length >= 24} onClick={() => {
      if (pinned) update(saved.filter((row) => row.id !== selected.id));
      else { update([...saved, { id: selected.id, name: lanePrimaryLabel(selected.agent, selected.source), task: selected.facts?.currentTask || "No task summary reported.", savedAt: Date.now() }]); setExpanded(true); }
    }}>{pinned ? "Unpin selected actor" : "Pin selected work"}</button> : null}
    {expanded ? <div className="floor-saved__list">{saved.length ? saved.map((row) => {
      const live = lanes.find((lane) => lane.id === row.id);
      return <article key={row.id}><button type="button" disabled={!live} onClick={() => live && onActor(live)}><strong>{row.name} · {row.id.slice(-5)}</strong><small>{live ? "Inspect actor" : "Outside loaded fleet"}</small></button><p>{row.task}</p><footer><small>Saved {new Date(row.savedAt).toLocaleDateString()}</small><button type="button" aria-label={`Remove saved work for ${row.name} ${row.id.slice(-5)}`} onClick={() => update(saved.filter((entry) => entry.id !== row.id))}><X size={12} /></button></footer></article>;
    }) : <p>Select an actor, then pin its work here. Saved task excerpts stay available after the actor leaves the floor.</p>}</div> : null}
  </div>;
}
