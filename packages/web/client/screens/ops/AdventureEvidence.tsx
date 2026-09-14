import { BookOpen, Hammer, FlaskConical, ArrowUpRight } from "lucide-react";
import { useScout } from "../../scout/Provider.tsx";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { AdventureStop } from "./agent-adventures-model.ts";
import { adventureEvidence, type AdventureFileEvidence } from "./adventure-evidence.ts";
import "./adventure-evidence.css";

export function AdventureEvidence({ stops, index, lane, onFile }: { stops: AdventureStop[]; index: number; lane: AgentLane; onFile?: (path: string) => void }) {
  const { openFilePreview } = useScout();
  const evidence = adventureEvidence(stops, index, lane);
  const files = (items: AdventureFileEvidence[], empty: string) => items.length ? <ul>{items.map(file => <li key={file.resolvedPath ?? file.path}>{file.resolvedPath ? <button type="button" title={file.path} onClick={() => (onFile ?? openFilePreview)(file.resolvedPath!)}><span>{file.path}</span><ArrowUpRight size={12}/></button> : <code>{file.path}</code>}<small>{file.clue}{file.observations > 1 ? ` · ${file.observations} observations` : ""}</small></li>)}</ul> : <p>{empty}</p>;
  return <aside className="adventure-evidence" aria-label="Evidence collected through playhead"><header><strong>Collected along the way</strong><small>Through this observation · file previews show current contents</small></header><div className="adventure-evidence__shelves">
    <section><h3><BookOpen size={16}/>Explored <span>{evidence.read.length}</span></h3>{files(evidence.read, "No file paths observed yet.")}</section>
    <section><h3><Hammer size={16}/>Changed <span>{evidence.changed.length}</span></h3>{files(evidence.changed, "No changed paths observed yet.")}</section>
    <section><h3><FlaskConical size={16}/>Validation <span>{evidence.runs.length}</span></h3>{evidence.runs.length ? <ul>{evidence.runs.map(run => <li key={run.id}><code>{run.command}</code><span className={`adventure-evidence__outcome is-${run.outcome}`}>{run.outcome === "passed" ? "Exited successfully" : run.outcome === "failed" ? "Exited with error" : "Result unavailable"}</span><details><summary>Trace clue</summary><pre>{run.clue}</pre></details></li>)}</ul> : <p>No validation command observed yet.</p>}</section>
  </div></aside>;
}
