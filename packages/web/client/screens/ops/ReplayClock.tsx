import { useEffect, useRef } from "react";
/** Smooth presentation time between recorded observations; never invent future events. */
export function ReplayClock({ at, nextAt, start, duration, running }: { at: number; nextAt: number; start: number; duration: number; running: boolean }) {
  const node = useRef<HTMLTimeElement>(null);
  useEffect(() => {
    const began = performance.now();
    let frame = 0;
    const paint = () => {
      const fraction = running ? Math.min(1, (performance.now() - began) / duration) : 0;
      const timestamp = at + Math.max(0, nextAt - at) * fraction;
      const ms = Math.max(0, Math.floor(timestamp - start));
      const seconds = Math.floor(ms / 1000);
      if (node.current) node.current.textContent = `T+ ${String(Math.floor(seconds / 3600)).padStart(2,"0")}:${String(Math.floor(seconds / 60) % 60).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}.${String(ms % 1000).padStart(3,"0")}`;
      if (running && fraction < 1) frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  }, [at, nextAt, start, duration, running]);
  return <time ref={node} className="adventures__elapsed-clock" title="Playback time interpolated between recorded observations" aria-label="Playback elapsed time" />;
}
