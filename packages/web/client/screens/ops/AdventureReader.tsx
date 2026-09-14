import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, X, Terminal, FileDiff, ScrollText } from "lucide-react";
import { api } from "../../lib/api.ts";
import { fileRenderers, type FilePreviewContent } from "../../scout/file-renderers/index.ts";
import type { AdventureStop } from "./agent-adventures-model.ts";
import { adventureCommandText } from "./adventure-playback.ts";
import { floorPreviewText } from "./floor-preview-text.ts";
import "./adventure-reader.css";

type ReaderPage = "notes" | "diff" | "result";
const TAB: Record<ReaderPage, string> = { notes: "Field notes", diff: "Changes", result: "Results" };
const RUNNING_HEAD: Record<ReaderPage, string> = { notes: "Field notes", diff: "What changed", result: "What came back" };
const MARK = { notes: ScrollText, diff: FileDiff, result: Terminal };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const countLines = (value: string) => value.split("\n").length;
const measure = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 102400 ? 1 : 0)} KB`;

/** One record often repeats itself through prose, arguments and output; set each passage once. */
function echoes(a: string | null, b: string | null): boolean {
  const shape = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!a || !b) return false;
  const [x, y] = [shape(a), shape(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 24 && long.includes(short.slice(0, 80));
}

function resultText(stop?: AdventureStop): string {
  if (stop?.event.stream?.length) return stop.event.stream.join("\n");
  return stop?.event.result ? JSON.stringify(stop.event.result, null, 2) : "";
}

/** Long paths break at their separators rather than mid-word in the narrow margin column. */
function pathParts(value: string): ReactNode[] {
  return value.split("/").flatMap((segment, index) => index === 0 ? [segment] : ["/", <wbr key={index}/>, segment]);
}

function note(term: string, value: ReactNode, mono = false) {
  return value ? <div key={term}><dt>{term}</dt><dd className={mono ? "is-path" : undefined}>{value}</dd></div> : null;
}

export function AdventureReader({ stop, path, onClose, onPath }: { stop?: AdventureStop; path: string | null; onClose: () => void; onPath: (path: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const leaf = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<ReaderPage>("notes");
  const [resource, setResource] = useState<FilePreviewContent | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setResource(null); setError("");
    if (path) api<FilePreviewContent>(`/api/file/preview?path=${encodeURIComponent(path)}`).then(value => { if (active) setResource(value); }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [path]);

  const command = stop ? adventureCommandText(stop) : null;
  const recorded = command || stop?.event.detail || stop?.event.arg || null;
  const prose = floorPreviewText(stop?.event.text);
  const output = resultText(stop);
  const exit = stop?.event.result?.exit_code ?? stop?.event.result?.exitCode;
  const diff = stop?.event.diff;
  const pages = (["notes", "diff", "result"] as const).filter(name => name === "notes" || (name === "diff" ? Boolean(diff) : Boolean(output)));
  const active = pages.includes(tab) ? tab : "notes";
  // A new page or a new file starts at the top of the leaf, never mid-way down the previous one.
  useEffect(() => { leaf.current?.scrollTo({ top: 0 }); }, [active, path]);

  const segments = path ? path.split("/").filter(Boolean) : [];
  const title = path ? segments.at(-1) ?? path : stop?.event.tool || stop?.label || "Artifact";
  const size = resource?.kind === "file" ? resource.sizeBytes : undefined;
  const truncated = resource?.kind === "file" && resource.previewable ? resource.truncated : false;
  const renderer = resource && fileRenderers.find(item => item.canHandle(resource));

  const notesLeaf = <>
    {prose && !echoes(prose, recorded) ? <p className="adventure-reader__prose">{prose}</p> : null}
    {recorded ? <figure className="adventure-reader__record"><figcaption>{command ? "Observed command" : "Recorded input"}</figcaption><pre>{recorded}</pre></figure> : null}
    {!prose && !recorded ? <p className="adventure-reader__quiet">Nothing was written down at this stop.</p> : null}
    {pages.includes("result") ? <button type="button" className="adventure-reader__next" onClick={() => setTab("result")}>Read what came back<span aria-hidden="true">→</span></button> : null}
  </>;

  const diffLeaf = <>
    <p className="adventure-reader__tally"><b>+{diff?.add ?? 0}</b> added <b>−{diff?.del ?? 0}</b> removed</p>
    {diff?.preview
      ? <pre className="adventure-reader__diff">{diff.preview.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? "is-added" : line.startsWith("-") ? "is-removed" : ""}>{line || " "}</span>)}</pre>
      : <p className="adventure-reader__quiet">No preview was recorded for this change.</p>}
  </>;

  const resultLeaf = <>
    <p className="adventure-reader__tally">{exit === undefined ? "Output" : `Exit code ${exit}`}{output ? <small>{countLines(output)} {countLines(output) === 1 ? "line" : "lines"}</small> : null}</p>
    {output ? <pre className="adventure-reader__output">{output}</pre> : <p className="adventure-reader__quiet">Nothing came back at this stop.</p>}
  </>;

  const fileLeaf = error
    ? <div className="adventure-reader__failed" role="alert"><strong>This file could not be opened.</strong><p>{error}</p></div>
    : resource && renderer ? <div className="adventure-reader__file">{renderer.render({ resource, openFilePreview: onPath })}</div>
    : resource ? <p className="adventure-reader__quiet">No reader is available for this kind of file.</p>
    : <p className="adventure-reader__quiet" role="status">Opening {title}…</p>;

  return <dialog ref={dialog} className="adventure-reader" aria-labelledby="adventure-reader-title" onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header>
      <BookOpen size={19} aria-hidden="true"/>
      <div className="adventure-reader__masthead">
        <small>{path ? "Field journal · current file" : "Field journal · recorded stop"}</small>
        <h2 id="adventure-reader-title" title={path ?? undefined}>{title}</h2>
      </div>
      {!path && stop ? <span className="adventure-reader__stamp">{stop.label} · {clock(stop.at)}</span> : null}
      <button type="button" onClick={onClose} aria-label="Close field journal"><X size={18}/></button>
    </header>
    <div className="adventure-reader__binding">
      <aside>
        {path ? null : <nav aria-label="Journal pages">{pages.map(name => { const Mark = MARK[name]; return <button type="button" key={name} aria-pressed={active === name} onClick={() => setTab(name)}><Mark size={15}/><span>{TAB[name]}</span></button>; })}</nav>}
        <dl className="adventure-reader__meta">
          {path ? <>
            {note("Path", pathParts(path), true)}
            {note("Reading", "Current contents on disk")}
            {size === undefined ? null : note("Size", truncated ? `${measure(size)} · preview truncated` : measure(size))}
          </> : <>
            {stop ? note("Observed", clock(stop.at)) : null}
            {stop ? note("Stop", stop.label) : null}
            {note("Tool", stop?.event.tool, true)}
            {exit === undefined ? null : note("Exit code", String(exit))}
            {diff ? note("Change", `+${diff.add} / −${diff.del} lines`) : null}
          </>}
        </dl>
      </aside>
      <article className="adventure-reader__leaf" ref={leaf}>
        <div className="adventure-reader__head">
          <span>{path ? "Current file" : RUNNING_HEAD[active]}</span>
          <small>{path ? "Current contents, read from disk" : "As recorded, never re-run"}</small>
        </div>
        <div className="adventure-reader__body">{path ? fileLeaf : active === "notes" ? notesLeaf : active === "diff" ? diffLeaf : resultLeaf}</div>
      </article>
    </div>
    <footer><span>Esc returns to the trail.</span><button type="button" onClick={onClose}>Back to the trail →</button></footer>
  </dialog>;
}
