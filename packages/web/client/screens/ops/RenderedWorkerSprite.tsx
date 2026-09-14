import { useEffect, useRef, useState, type CSSProperties } from "react";
import { sageWorker, type WorkerCharacter, type RenderedWorkerPosture } from "./worker-characters.ts";
export type { RenderedWorkerPosture } from "./worker-characters.ts";
import "./rendered-worker-sprite.css";

export type RenderedWorkerSpriteProps = {
  /** Supply thinking only for an explicitly observed thinking event. */
  posture: RenderedWorkerPosture;
  paused?: boolean;
  size?: number;
  character?: WorkerCharacter;
};
/** Decorative sprite; its enclosing actor control supplies the accessible name. */
export function RenderedWorkerSprite({ posture, paused = false, size = 76, character = sageWorker }: RenderedWorkerSpriteProps) {
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element);
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <span ref={node} aria-hidden="true" className={`rendered-worker${paused || !visible || !pageVisible ? " is-paused" : ""}`} style={{ "--worker-size": `${size}px` } as CSSProperties}>
    {(Object.entries({ idle: character.poses.idle, thinking: character.poses.thinking || character.poses.idle, working: character.poses.working || character.poses.idle, waiting: character.poses.waiting || character.poses.idle }) as [RenderedWorkerPosture, string][]).map(([pose, src]) => <img key={pose} src={src} alt="" draggable={false} width={size} height={size} className={`rendered-worker__pose is-${pose}${posture === pose ? " is-current" : ""}`} />)}
  </span>;
}
