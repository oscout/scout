import { useEffect, useState } from "react";
import type { AgentLane } from "./agent-lanes-model.ts";
import { floorCharacterName } from "./floor-character-name.ts";
import { floorExchanges } from "./floor-exchanges.ts";
import { buildSharedWorkArtifacts } from "./shared-work-artifacts.ts";
import { useExchangeSpeech } from "./useExchangeSpeech.ts";
import { floorRelations } from "./floor-memory.ts";
import { floorPreviewText } from "./floor-preview-text.ts";
import "./floor-exchanges.css";

export function FloorExchangePanel({ pair, lanes, now, onClose, onFile, onSpeaker }: { pair: [string,string]; lanes: AgentLane[]; now: number; onClose: () => void; onFile: (path:string) => void; onSpeaker: (id:string|null) => void }) {
  const exchange = floorExchanges(lanes, now).find(e => pair.includes(e.from) && pair.includes(e.to));
  const messages = exchange?.messages ?? [];
  const playableMessages = messages.filter(message => message.bodyAvailable !== false);
  const family = floorRelations(lanes).find(edge => pair.includes(edge.parent.id) && pair.includes(edge.child.id));
  const name = (id:string) => { const lane=lanes.find(l=>l.id===id); return lane ? floorCharacterName(lane).label : "Departed actor"; };
  const artifacts = buildSharedWorkArtifacts(lanes).filter(a => pair.every(id=>a.owners.some(o=>o.id===id)));
  const speech = useExchangeSpeech();
  const [replay, setReplay] = useState<number | null>(null);
  const [playbackMessages, setPlaybackMessages] = useState<typeof messages>([]);
  const visibleMessages = replay !== null || speech.playing ? playbackMessages : messages;
  useEffect(() => {
    const spoken = visibleMessages.find(m => m.id === speech.speakingId);
    onSpeaker(spoken?.from ?? (replay === null ? null : visibleMessages[replay]?.from ?? null));
    return () => onSpeaker(null);
  }, [speech.speakingId, replay]);
  useEffect(() => {
    if (replay === null) return;
    const timer = window.setTimeout(() => setReplay(current => current === null || current + 1 >= playbackMessages.length ? null : current + 1), 1800);
    return () => window.clearTimeout(timer);
  }, [replay]);
  return <aside className="floor-exchange-panel" aria-label={messages.length ? "Recent exchange" : "Agent relationship"} onPointerDown={e=>e.stopPropagation()}>
    <header><div><strong>{name(pair[0])} ↔ {name(pair[1])}</strong><small>{messages.length ? "Recent exchanges · last 15 minutes" : "Parent → subagent"}</small></div><button type="button" onClick={onClose} aria-label="Close exchange">×</button></header>
    {family ? <section className="floor-exchange-panel__relationship"><small>Delegation relationship</small><p>{name(family.parent.id)} → {name(family.child.id)}</p><strong>Subagent’s current task</strong><p>{floorPreviewText(family.child.facts?.currentTask) || "Task details have not been reported yet."}</p></section> : null}
    {playableMessages.length > 0 ? <div className="floor-exchange-panel__actions"><button type="button" disabled={!messages.length} onClick={()=> { speech.stop(); setPlaybackMessages(playableMessages); setReplay(replay === null ? 0 : null); }}>{replay === null ? "Replay" : "Stop replay"}</button><button type="button" disabled={!speech.supported || !messages.length} onClick={()=> { setReplay(null); setPlaybackMessages(playableMessages); speech.playing ? speech.stop() : speech.play(playableMessages); }}>{speech.playing ? "Stop voice" : "Listen"}</button></div> : null}
    {playableMessages.length > 0 && (!speech.supported ? <small>Voice playback isn’t available in this browser.</small> : speech.voiceCount < 2 ? <small>Distinct character voices depend on available browser voices.</small> : null)}
    {speech.error ? <p role="status">{speech.error}</p> : null}
    <ol>{visibleMessages.map((message,index)=><li key={message.id} className={speech.speakingId===message.id || replay===index ? "is-speaking" : ""}><div><strong>{name(message.from)}</strong><small>{Math.max(0,Math.floor((now-message.at)/60000))}m ago</small></div><p>{message.text}</p>{message.bodyAvailable === false ? <details><summary>Why unavailable?</summary><small>The harness recorded the exchange without readable message contents. Playback skips this entry.</small></details> : null}</li>)}</ol>
    {!messages.length ? <p>This dotted link shows who the subagent belongs to. Recorded exchanges appear here when available.</p> : null}
    {artifacts.length ? <section><strong>Files both touched</strong>{artifacts.slice(0,6).map(artifact=><button key={artifact.id} type="button" disabled={!artifact.resolvedPath} onClick={()=>artifact.resolvedPath && onFile(artifact.resolvedPath)}>{artifact.path.split("/").at(-1)}</button>)}</section> : null}
  </aside>;
}
