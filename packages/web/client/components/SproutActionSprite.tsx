import { useEffect, useRef, useState } from "react";
import atlasUrl from "../screens/ops/assets/sprout-actions-proof-v1.png?url";
import "./sprout-action-sprite.css";

export type SproutAction = "run" | "jump" | "land" | "idle";
const actions: SproutAction[] = ["run", "jump", "land", "idle"];
const durations: Record<SproutAction, number> = { run: 130, jump: 130, land: 65, idle: 650 };
// The generated source has slightly unequal margins. Explicit row cuts prevent
// adjacent poses entering the viewport; original pixels remain untouched.
const columns = [0, 323, 627, 950, 1262];
const rows = [0, 330, 610, 892, 1246];
// Opaque artwork bounds anchor every pose at the same foot line. The atlas
// remains untouched; transparent padding no longer makes the body drift.
const bounds = [
  [[85,43,283,312],[75,46,252,316],[39,44,243,314],[44,43,223,316]],
  [[99,16,258,264],[72,12,232,261],[44,11,230,261],[30,16,204,264]],
  [[94,14,264,265],[60,34,238,265],[61,5,217,267],[44,3,200,265]],
  [[91,8,249,289],[73,8,228,289],[61,8,220,288],[41,10,198,289]],
];

/** Four-frame authored raster proof. Caller owns spatial travel and labeling. */
export function SproutActionSprite({ action = "idle", size = 128, paused = false, playbackRate = 1 }: { action?: SproutAction; size?: number; paused?: boolean; playbackRate?: number }) {
  const node = useRef<HTMLSpanElement>(null);
  const [frame, setFrame] = useState(0);
  const [visible, setVisible] = useState(true);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting)); observer.observe(node.current);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener("change", preference); document.addEventListener("visibilitychange", visibility);
    return () => { observer.disconnect(); media.removeEventListener("change", preference); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => { setFrame(0); }, [action]);
  useEffect(() => {
    if (paused || !visible || hidden || reduced) return;
    const timer = window.setInterval(() => setFrame((value) => action === "jump" || action === "land" ? Math.min(3, value + 1) : (value + 1) % 4), durations[action] / Math.max(.25, playbackRate));
    return () => window.clearInterval(timer);
  }, [action, paused, visible, hidden, reduced, playbackRate]);
  const row = actions.indexOf(action);
  const x = columns[frame], y = rows[row];
  const width = columns[frame + 1] - x, height = rows[row + 1] - y;
  const scale = size / 300;
  const box = bounds[row][frame];
  const offsetX = (width / 2 - (box[0] + box[2]) / 2) * scale;
  const offsetY = (height - box[3]) * scale;
  return <span ref={node} className="sprout-action-sprite" aria-hidden="true" style={{ width: size, height: size }}>
    <span className="sprout-action-sprite__crop" style={{ width: width * scale, height: height * scale, transform: `translate(${offsetX}px, ${offsetY}px)` }}><img src={atlasUrl} alt="" draggable={false} style={{ width: 1262 * scale, height: 1246 * scale, left: -x * scale, top: -y * scale }} /></span>
  </span>;
}

export function SproutActionProof() {
  const [action, setAction] = useState<SproutAction>("run");
  const [paused, setPaused] = useState(false);
  return <section className="sprout-action-proof" aria-label="Sprout authored sprite proof">
    <div role="group" aria-label="Sprite action">{actions.map((item) => <button key={item} type="button" aria-pressed={item === action} onClick={() => setAction(item)}>{item}</button>)}<button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</button></div>
    <SproutActionSprite action={action} paused={paused} size={180} />
    <small>Authored pose proof · four frames per action · original Sprout remains unchanged</small>
  </section>;
}
