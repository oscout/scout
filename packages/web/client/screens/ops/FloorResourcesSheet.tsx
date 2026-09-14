import { buildSharedWorkArtifacts } from "./shared-work-artifacts.ts";
import { useEffect, useState } from "react";
import { FileCode2, GitBranch, Terminal, X, ArrowUpRight } from "lucide-react";
import { useScout } from "../../scout/Provider.tsx";
import { routePath } from "../../lib/router.ts";
import { fetchTerminalSessions, terminalListItems, type TerminalListItem } from "../../lib/terminal-sessions.ts";
import { buildLaneSessionStats } from "./agent-lane-detail.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";
import "./floor-context-sheet.css";

export type FloorResourceView = "artifacts" | "branches" | "terminals";
const TITLES = { artifacts: "Artifact shelf", branches: "Branch board", terminals: "Terminal bay" };

export function FloorResourcesSheet({ view, lanes, onView, onClose, onActor }: {
  view: FloorResourceView; lanes: AgentLane[]; onView: (view: FloorResourceView) => void; onClose: () => void; onActor: (lane: AgentLane) => void;
}) {
  const { openFilePreview } = useScout();
  const [terminals, setTerminals] = useState<TerminalListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [herdrOnly, setHerdrOnly] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (view !== "terminals") return;
    let active = true;
    const refresh = () => fetchTerminalSessions().then((sessions) => { if (active) { setTerminals(terminalListItems(sessions)); setError(null); } }).catch(() => { if (active) setError("Terminal discovery is unavailable. Retry or open the terminal workspace."); }).finally(() => { if (active) setLoading(false); });
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [view]);
  const rows = lanes.map((lane) => ({ lane, stats: buildLaneSessionStats(lane) }));
  const branches = new Map<string, { branch: string; cwd: string; owners: AgentLane[] }>();
  const artifacts = new Map(buildSharedWorkArtifacts(lanes).map((artifact) => [artifact.id, { path: artifact.path, resolved: artifact.resolvedPath, owners: artifact.owners, state: artifact.state }]));
  for (const { lane, stats } of rows) {
    const cwd = lane.facts?.cwd || stats.cwd || "";
    const branch = lane.facts?.branch || stats.branch;
    if (branch) {
      const key = `${cwd}\0${branch}`;
      const row = branches.get(key) ?? { branch, cwd, owners: [] };
      row.owners.push(lane); branches.set(key, row);
    }
  }

  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase());
  const Icon = view === "artifacts" ? FileCode2 : view === "branches" ? GitBranch : Terminal;
  return <aside className="agent-floor__trace-panel floor-context" aria-label={`${TITLES[view]} context sheet`}>
    <header className="floor-context__header"><Icon size={20} /><div><h2>{TITLES[view]}</h2><p>{view === "terminals" ? "Discovered sessions · refreshes every 15s" : "Across the loaded fleet"}</p></div><button type="button" onClick={onClose} aria-label="Close resource sheet"><X size={17} /></button></header>
    <nav className="floor-context__tabs" aria-label="Resource sheets">{(["artifacts", "branches", "terminals"] as const).map((item) => <button type="button" key={item} aria-pressed={view === item} onClick={() => { setQuery(""); onView(item); }}>{TITLES[item]}</button>)}</nav>
    <div className="floor-context__body">
      <input className="floor-context__search" aria-label="Filter floor resources" placeholder={view === "terminals" ? "Find a session or workspace…" : "Filter by path or branch…"} value={query} onChange={(event) => setQuery(event.target.value)} />
      {view === "artifacts" ? <section><h3>Observed changed files <span>{artifacts.size}</span></h3><p className="floor-context__scope">Files changed in loaded session history. Select a file to preview.</p>
        {[...artifacts].filter(([, row]) => matches(row.path)).map(([key, row]) => <article className="floor-context__resource" key={key}><button className="floor-context__resource-title" type="button" disabled={!row.resolved} onClick={() => row.resolved && openFilePreview(row.resolved)}><FileCode2 size={15} /><strong>{row.path.split("/").at(-1)}</strong><ArrowUpRight size={13} /></button><code title={row.resolved ?? row.path}>{row.resolved ?? row.path}</code><small>{row.state}{row.owners.length > 1 ? ` · ${row.owners.length} {row.owners.length === 1 ? "actor" : "actors"} touched this file` : ""}</small><div className="floor-context__owners">{row.owners.map((owner) => <button type="button" key={owner.id} onClick={() => onActor(owner)}>{lanePrimaryLabel(owner.agent, owner.source)} · {owner.id.slice(-5)}</button>)}</div></article>)}
        {![...artifacts.values()].some((row) => matches(row.path)) ? <p className="floor-context__empty">No observed changed files match this view.</p> : null}
      </section> : null}
      {view === "branches" ? <section><h3>Observed branches <span>{branches.size}</span></h3><p className="floor-context__scope">Branches and workspaces reported by these sessions.</p>{[...branches].filter(([, row]) => matches(`${row.branch} ${row.cwd}`)).map(([key, row]) => <article className="floor-context__resource" key={key}><h3><GitBranch size={15} />{row.branch}<span>{row.owners.length} {row.owners.length === 1 ? "actor" : "actors"}</span></h3><code>{row.cwd || "Workspace not reported"}</code><div className="floor-context__owners">{row.owners.map((owner) => <button key={owner.id} type="button" onClick={() => onActor(owner)}>{lanePrimaryLabel(owner.agent, owner.source)} · {owner.id.slice(-5)}</button>)}</div></article>)}{![...branches.values()].some((row) => matches(`${row.branch} ${row.cwd}`)) ? <p className="floor-context__empty">No reported branches match this view.</p> : null}</section> : null}
      {view === "terminals" ? <section><nav className="floor-context__tabs"><button type="button" aria-pressed={!herdrOnly} onClick={() => setHerdrOnly(false)}>All terminals</button><button type="button" aria-pressed={herdrOnly} onClick={() => setHerdrOnly(true)}>Herdr</button></nav><p className="floor-context__scope">All discovered terminal surfaces. Opening a session uses observe mode.</p>{error ? <p role="alert" className="floor-context__empty">{error}</p> : null}{loading ? <p className="floor-context__empty">Loading terminals…</p> : terminals.filter((item) => (!herdrOnly || item.surface.backend === "herdr") && matches(item.searchable)).map((item) => <article key={item.id} className="floor-context__resource"><a className="floor-context__resource-title" href={routePath({ view: "terminal", terminalSessionId: item.session.id, terminalSurfaceKey: item.key, mode: "observe" })}><Terminal size={15} /><strong>{item.title}</strong><ArrowUpRight size={13} /></a><small>{item.surface.backend} · {item.condition}</small><code>{item.session.cwd || item.project}</code></article>)}{!loading && !terminals.some((item) => (!herdrOnly || item.surface.backend === "herdr") && matches(item.searchable)) ? <p className="floor-context__empty">No {herdrOnly ? "Herdr " : ""}terminals match this view.</p> : null}<a className="floor-context__resource-title" href="/terminal">Open terminal workspace <ArrowUpRight size={13} /></a></section> : null}
    </div>
  </aside>;
}
