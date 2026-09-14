import { CrewSprite } from "../../components/CrewSprite.tsx";
import { useEffect, useRef, useState } from "react";
import { CAST_MEMBERS, CREW_SHEETS, hasChipArt } from "../../lib/crew-registry.ts";
import { stepCharacterSpring } from "./character-spring.ts";
import "./character-family-preview.css";

type Expression = "rest" | "look-left" | "look-right" | "look-up";
function CastFigure({ slug, name, pixel, paused, expression }: { slug: string; name: string; pixel: boolean; paused: boolean; expression: Expression }) {
  const surface = useRef<HTMLDivElement>(null);
  const sprite = useRef<HTMLSpanElement>(null);
  const state = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const stopped = useRef(paused);
  stopped.current = paused;
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, last = performance.now();
    const draw = (time: number) => {
      const dt = Math.min(.05, (time - last) / 1000); last = time;
      if (!document.hidden && !drag.current && !stopped.current) {
        state.current = reduced.matches ? { x: 0, y: 0, vx: 0, vy: 0 } : stepCharacterSpring(state.current, { x: 0, y: 0 }, dt);
        const s = state.current;
        if (sprite.current) sprite.current.style.transform = `translate(${s.x}px, ${s.y}px) rotate(${Math.max(-6, Math.min(6, s.vx * .018))}deg)`;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  const available = !pixel || hasChipArt(slug);
  return <figure><div className="character-family-preview__stage" ref={surface} role="button" tabIndex={available ? 0 : -1} aria-label={`Nudge ${name}`} aria-disabled={!available || paused}
    onKeyDown={event => { if (available && !paused && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); state.current = { x: 12, y: -22, vx: 0, vy: 0 }; } }}
    onPointerDown={event => {
      if (!available || stopped.current || event.button !== 0) return;
      drag.current = { id: event.pointerId, x: event.clientX - state.current.x, y: event.clientY - state.current.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (drag.current?.id !== event.pointerId) return;
      const x = Math.max(-35, Math.min(35, event.clientX - drag.current.x));
      const y = Math.max(-45, Math.min(12, event.clientY - drag.current.y));
      state.current = { x, y, vx: 0, vy: 0 };
      if (sprite.current) sprite.current.style.transform = `translate(${x}px, ${y}px)`;
    }}
    onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { drag.current = null; }}>
    {available ? <span ref={sprite} className="character-family-preview__moving"><CrewSprite slug={slug} pixel={pixel} size={pixel ? 88 : 155} paused={paused} expression={expression} /></span> : <span className="character-family-preview__missing">No chip artwork yet</span>}
    </div><figcaption>{name}</figcaption>{!pixel && CREW_SHEETS[slug] ? <small>Eye expressions available</small> : null}</figure>;
}

export function CharacterFamilyPreview({ onClose }: { onClose: () => void }) {
  const [pixel, setPixel] = useState(false);
  const [paused, setPaused] = useState(false);
  const [expression, setExpression] = useState<Expression>("rest");
  return <section className="character-family-preview" aria-label="Character family preview">
    <header><div><strong>The crew</strong><p>Original identities · expressions · shared movement</p></div><button type="button" onClick={onClose} aria-label="Close character preview">×</button></header>
    <div className="character-family-preview__poses" role="group" aria-label="Character artwork"><button type="button" aria-pressed={!pixel} onClick={() => setPixel(false)}>Crew</button><button type="button" aria-pressed={pixel} onClick={() => setPixel(true)}>Pixel Chip</button><button type="button" onClick={() => setPaused(!paused)}>{paused ? "Resume motion" : "Pause motion"}</button></div>
    {!pixel ? <div className="character-family-preview__poses" role="group" aria-label="Eye expression">{(["rest", "look-left", "look-up", "look-right"] as Expression[]).map(value => <button key={value} type="button" aria-pressed={value === expression} onClick={() => setExpression(value)}>{value.replace("look-", "Look ")}</button>)}</div> : null}
    <div className="character-family-preview__cast">{CAST_MEMBERS.map(member => <CastFigure key={member.slug} slug={member.slug} name={member.name} pixel={pixel} paused={paused} expression={expression} />)}</div>
    <p>Drag a character gently and release. This tests shared spring motion; full-body action sprites and accessories come next.</p>
  </section>;
}
