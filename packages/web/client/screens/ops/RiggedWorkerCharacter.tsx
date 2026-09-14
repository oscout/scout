import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { makeRng } from "../../lib/agent-identity.ts";
import "./rigged-worker-character.css";

export type RiggedWorkerPosture = "idle" | "thinking" | "working" | "waiting";
export type WorkerRigTraits = {
  /** 0 round, 1 squared, 2 pointed side fins. */
  head: number;
  /** Head dimensions in the 100×120 viewBox; face anchors remain head-local. */
  headWidth: number; headHeight: number;
  /** Torso dimensions; limbs attach to its shoulder and hip anchors. */
  bodyWidth: number; bodyHeight: number;
  /** Accent/eye hue, 0–359 degrees. */
  hue: number; eyeGap: number; antenna: boolean; blinkDelay: number;
};
export type RiggedWorkerCharacterProps = { identity: string; posture: RiggedWorkerPosture; paused?: boolean; size?: number; traits?: Partial<WorkerRigTraits> };

/** Traits belong to identity; posture never rerolls geometry or moves face anchors. */
export function traitsFor(identity: string): WorkerRigTraits {
  const rng = makeRng(`worker-rig:${identity}`);
  return { head: rng.int(0, 2), headWidth: rng.int(46, 60), headHeight: rng.int(37, 45),
    bodyWidth: rng.int(25, 35), bodyHeight: rng.int(25, 32), hue: [155, 38, 266, 195, 14, 330][rng.int(0, 5)],
    eyeGap: rng.int(10, 13), antenna: rng.bool(.45), blinkDelay: rng.float(-7, 0) };
}

/** Decorative avatar. The actor button provides the accessible name. */
export function RiggedWorkerCharacter({ identity, posture, paused = false, size = 76, traits }: RiggedWorkerCharacterProps) {
  const t = useMemo(() => ({ ...traitsFor(identity), ...traits }), [identity, traits]);
  const id = useId().replace(/:/g, "");
  const node = useRef<SVGSVGElement>(null);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(node.current);
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  const shell = `url(#${id}-shell)`;
  const accent = `url(#${id}-accent)`;
  const dark = `url(#${id}-face)`;
  const joint = `url(#${id}-joint)`;
  const rim = `url(#${id}-rim)`;
  const iris = `url(#${id}-iris)`;
  const eye = `hsl(${t.hue} 70% 65%)`;
  const bodyY = 62;
  const feetY = bodyY + t.bodyHeight + 17;
  return <svg ref={node} className={`worker-rig is-${posture}${paused || !visible || !pageVisible ? " is-paused" : ""}`} width={size} height={size} viewBox="0 0 100 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false" style={{ "--rig-blink-delay": `${t.blinkDelay}s` } as CSSProperties}>
    <defs>
      <radialGradient id={`${id}-shell`} cx=".28" cy=".18" r=".88"><stop stopColor="#fffdf3" /><stop offset=".34" stopColor="#f2e8d3" /><stop offset=".7" stopColor="#d4c3a7" /><stop offset=".9" stopColor="#a7977c" /><stop offset="1" stopColor="#766b5c" /></radialGradient>
      <radialGradient id={`${id}-accent`} cx=".27" cy=".2" r=".9"><stop stopColor={`hsl(${t.hue} 30% 87%)`} /><stop offset=".27" stopColor={`hsl(${t.hue} 34% 68%)`} /><stop offset=".67" stopColor={`hsl(${t.hue} 28% 45%)`} /><stop offset="1" stopColor={`hsl(${t.hue} 26% 23%)`} /></radialGradient>
      <radialGradient id={`${id}-face`} cx=".3" cy=".15" r=".95"><stop stopColor="#465055" /><stop offset=".35" stopColor="#202c32" /><stop offset=".85" stopColor="#101a20" /><stop offset="1" stopColor="#080f14" /></radialGradient>
      <linearGradient id={`${id}-rim`} x1="0" y1="0" x2=".6" y2="1"><stop stopColor="#625a4d" /><stop offset=".4" stopColor="#a99a80" /><stop offset="1" stopColor="#fff0d2" /></linearGradient>
      <radialGradient id={`${id}-joint`} cx=".3" cy=".2" r=".85"><stop stopColor="#677074" /><stop offset=".45" stopColor="#364047" /><stop offset="1" stopColor="#121b20" /></radialGradient>
      <radialGradient id={`${id}-iris`} cx=".35" cy=".25" r=".85"><stop stopColor={`hsl(${t.hue} 80% 87%)`} /><stop offset=".6" stopColor={`hsl(${t.hue} 65% 63%)`} /><stop offset="1" stopColor={`hsl(${t.hue} 65% 35%)`} /></radialGradient>
    </defs>
    <ellipse cx="50" cy={feetY + 4} rx="23" ry="4" fill="#000" opacity=".16" />
    <g className="worker-rig__figure">
      {["left", "right"].map((side, i) => <g key={side} transform={`translate(${i ? 59 : 41} ${bodyY + t.bodyHeight - 2})`}><g className={`worker-rig__leg is-${side}`}><rect x="-5" y="0" width="10" height="15" rx="4" fill={joint} /><rect x="-6" y="4" width="12" height="12" rx="5" fill={shell} /><path d="M-7 13 Q0 10 7 14 L9 19 Q0 23 -9 19Z" fill={accent} stroke="#303839" strokeWidth=".8" /></g></g>)}
      <rect x="44" y="54" width="12" height="12" rx="4" fill={joint} /><path d="M45 59 H55 M45 62 H55" stroke="#151c21" strokeWidth="1" opacity=".55" />
      <rect x={50 - t.bodyWidth / 2} y={bodyY} width={t.bodyWidth} height={t.bodyHeight} rx={t.bodyWidth * .36} fill={shell} stroke="#948a79" strokeWidth=".7" /><ellipse cx="50" cy={bodyY + 3} rx={t.bodyWidth / 2 - 4} ry="3" fill="#4d4233" opacity=".22" /><ellipse cx={50 - t.bodyWidth / 2 + 6} cy={bodyY + 11} rx="2.5" ry="6" fill="#fffdf3" opacity=".38" />
      <path d={`M${50 - t.bodyWidth / 2 + 4} ${bodyY + t.bodyHeight - 10} Q50 ${bodyY + t.bodyHeight - 3} ${50 + t.bodyWidth / 2 - 4} ${bodyY + t.bodyHeight - 10} L${50 + t.bodyWidth / 2 - 5} ${bodyY + t.bodyHeight - 3} Q50 ${bodyY + t.bodyHeight + 2} ${50 - t.bodyWidth / 2 + 5} ${bodyY + t.bodyHeight - 3}Z`} fill={accent} />
      <circle cx="50" cy={bodyY + 10} r="4.6" fill={dark} /><circle cx="50" cy={bodyY + 10} r="2.8" fill={eye} /><circle cx="49" cy={bodyY + 9} r=".9" fill="#fff" opacity=".8" />
      {["left", "right"].map((side, i) => <g key={side} transform={`translate(${50 + (i ? 1 : -1) * (t.bodyWidth / 2 + 2)} ${bodyY + 4})`}><g className={`worker-rig__arm is-${side}`}><circle r="6.4" fill={joint} /><circle cx="-.4" cy="-.6" r="5.7" fill={accent} /><ellipse cx="-2" cy="-2.4" rx="2" ry="1" fill="#fff" opacity=".35" /><rect x="-4" y="4" width="8" height="16" rx="4" fill={shell} stroke="#a89d8c" strokeWidth=".6" /><path d="M-2 7 V14" stroke="#fff9e9" strokeWidth="1.1" opacity=".55" strokeLinecap="round" /><circle cy="22" r="5" fill={joint} /><path d="M-3 21 Q0 19 3 21" fill="none" stroke="#647279" /></g></g>)}
      <g transform="translate(50 33)"><g className="worker-rig__head">
        {t.antenna ? <g><path d={`M0 ${-t.headHeight / 2 + 1} V${-t.headHeight / 2 - 7}`} stroke="#576362" strokeWidth="3" /><circle cy={-t.headHeight / 2 - 8} r="3" fill={accent} /></g> : null}
        {[-1, 1].map((side) => t.head === 2 ? <path key={side} d={`M${side * (t.headWidth / 2 - 5)} -8 L${side * (t.headWidth / 2 + 4)} -25 L${side * (t.headWidth / 2 + 6)} 3Z`} fill={accent} stroke="#7b897d" strokeWidth=".8" /> : <ellipse key={side} cx={side * t.headWidth / 2} cy="1" rx="5" ry={t.head === 0 ? 8 : 6} fill={accent} stroke="#7b897d" strokeWidth=".8" />)}
        <rect x={-t.headWidth / 2} y={-t.headHeight / 2} width={t.headWidth} height={t.headHeight} rx={t.head === 0 ? t.headHeight / 2 : t.head === 1 ? 10 : 15} fill={shell} stroke="#948a79" strokeWidth=".8" /><path d={`M${-t.headWidth / 2 + 4} -5 Q${-t.headWidth / 2 + 2} ${-t.headHeight / 2 + 4} -8 ${-t.headHeight / 2 + 2}`} fill="none" stroke="#fffdf5" strokeWidth="1.8" strokeLinecap="round" opacity=".7" />
        <path d={`M-12 ${-t.headHeight / 2 + 3} Q0 ${-t.headHeight / 2 - 1} 12 ${-t.headHeight / 2 + 3} L10 ${-t.headHeight / 2 + 7} Q0 ${-t.headHeight / 2 + 9} -10 ${-t.headHeight / 2 + 7}Z`} fill={accent} />
        <rect x={-t.headWidth / 2 + 3.5} y={-t.headHeight / 2 + 8.5} width={t.headWidth - 7} height={t.headHeight - 12} rx="11.5" fill={rim} />
        <rect x={-t.headWidth / 2 + 5} y={-t.headHeight / 2 + 10} width={t.headWidth - 10} height={t.headHeight - 15} rx="10" fill={dark} stroke="#171c1f" strokeWidth=".6" />
        <path d={`M${-t.headWidth / 2 + 8} -5 Q${-t.headWidth / 2 + 8} -11 -12 -10`} fill="none" stroke="#fff" opacity=".15" strokeWidth="2" />
        {[-1, 1].map((side) => <g key={side} transform={`translate(${side * t.eyeGap} 3)`}><g className="worker-rig__eye"><ellipse rx="6" ry="7.5" fill={iris} /><g className="worker-rig__pupil"><ellipse rx="3.3" ry="5" fill="#13242e" /><ellipse cx="-1" cy="-2.4" rx="1.4" ry="1.6" fill="#fff" /></g></g><path className="worker-rig__brow" d="M-4 -9 Q0 -11 4 -9" fill="none" stroke={eye} strokeWidth="1.6" strokeLinecap="round" /></g>)}
      </g></g>
    </g>
  </svg>;
}
