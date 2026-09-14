import { useEffect, useRef } from "react";
import { summarizeObserveEvent } from "../../lib/observe.ts";
import { floorPreviewText } from "./floor-preview-text.ts";
import type { AdventureStop } from "./agent-adventures-model.ts";

/** The Mission log's follow-at-top behavior, applied to recorded observations. */
export function ReplayLog({ stops, index, onInspect }: { stops: AdventureStop[]; index: number; onInspect: (index: number) => void }) {
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => { if (following.current && body.current) body.current.scrollTop = 0; }, [index, stops.length]);
  return <div className="replay-log" ref={body} role="region" aria-label="Replay event log" tabIndex={0} onScroll={() => { const node = body.current; if (node) following.current = node.scrollTop < 24; }}>
    {stops.slice(0, index + 1).map((stop, position) => ({ stop, position })).reverse().map(({ stop, position }) => <button type="button" key={stop.id} className={position === index ? "is-current" : ""} onClick={() => onInspect(position)}><time>{new Date(stop.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}</time><span className="replay-log__kind">{stop.event.tool || stop.kind}</span><span>{floorPreviewText(summarizeObserveEvent(stop.event)) || stop.label}</span></button>)}
    {!stops.length ? <p>No recorded events yet.</p> : null}
  </div>;
}
