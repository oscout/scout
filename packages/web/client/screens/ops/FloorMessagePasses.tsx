import type { WorldBrokerMessage } from "../../../shared/world-broker-messages.ts";
import { useEffect, useRef, type CSSProperties } from "react";
import type { AgentLane } from "./agent-lanes-model.ts";
import { floorMessagePasses, FLOOR_PASS_LIFETIME } from "./floor-message-passes.ts";
import "./floor-message-passes.css";

type Props = {
  lanes: AgentLane[];
  broker?: WorldBrokerMessage[];
  now: number;
  positions: Map<string, { x: number; y: number }>;
  paused: boolean;
};

/** Place inside the world transform, alongside the existing connection SVG. */
export function FloorMessagePasses({ lanes, now, positions, paused, broker }: Props) {
  const frozenAt = useRef<number | null>(null);
  const phases = useRef(new Map<string, number>());
  const clock = paused ? (frozenAt.current ?? now) : now;
  useEffect(() => { frozenAt.current = paused ? (frozenAt.current ?? now) : null; }, [paused, now]);
  const passes = floorMessagePasses(lanes, clock, broker);
  useEffect(() => {
    const active = new Set(passes.map((pass) => `${pass.id}:${paused}`));
    for (const key of phases.current.keys()) if (!active.has(key)) phases.current.delete(key);
  }, [passes, paused]);
  return <svg className={`floor-message-passes${paused ? " is-paused" : ""}`} aria-label="Recent messages between agents">
    {passes.map((pass) => {
      const from = positions.get(pass.from), to = positions.get(pass.to);
      if (!from || !to) return null;
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2 - Math.min(110, 30 + Math.hypot(to.x - from.x, to.y - from.y) * .3);
      const path = `M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`;
      // Stable key plus wall-clock phase prevents polling from replaying old passes.
      const age = Math.max(0, clock - pass.at);
      const phaseKey = `${pass.id}:${paused}`;
      if (!phases.current.has(phaseKey)) phases.current.set(phaseKey, age);
      return <g key={phaseKey} className="floor-message-passes__pass" style={{ opacity: Math.min(1, (FLOOR_PASS_LIFETIME - age) / 3000), "--pass-age": `${-phases.current.get(phaseKey)!}ms` } as CSSProperties}>
        <title>{pass.label}</title>
        <path className="floor-message-passes__trail" d={path} />
        <path className="floor-message-passes__hit" d={path} />
        <g className="floor-message-passes__marker" style={{ offsetPath: `path('${path}')` } as CSSProperties}>
          <circle className="floor-message-passes__aura" r="12" />
          <ellipse className="floor-message-passes__ball" rx="6" ry="4.5" />
          <path className="floor-message-passes__seam" d="M -2.5 0 H 2.5 M -1.3 -1.2 V 1.2 M 1.3 -1.2 V 1.2" />
        </g>
        <circle className="floor-message-passes__arrival" cx={to.x} cy={to.y} r="7" />
        <circle className="floor-message-passes__still" cx={to.x} cy={to.y} r="4" />
      </g>;
    })}
  </svg>;
}
