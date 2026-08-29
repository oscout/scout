import { useEffect, type RefObject } from "react";

/**
 * The facepile's two pointer-driven eye behaviours, plus the one that runs
 * while nobody is pointing at anything.
 *
 * Every eye behaviour in the pile is tied to a fact about the agent, and the
 * thing that lets them all run at once is that no two of them animate the same
 * property. The split:
 *
 *   .sprite-cell--eye      scaleY      blink      ambient, staggered  (CSS)
 *   circle                 transform   gaze/scan  pointer near / working  (here)
 *   circle                 r           dilate     holding the turn    (CSS)
 *                                      widen      pointer on the coin (CSS)
 *   .s-thread-participant-avatar svg  rotate      lean                (here)
 *
 * Gaze and scan share the pupil's position on purpose: they are the same
 * channel arbitrated by distance, which is the correct relationship rather
 * than a workaround. A working agent sweeps its eyes while unattended and
 * looks up when you come near.
 *
 * The whole thing is one rAF loop over rects cached at mount, so a moving
 * pointer costs a coordinate write and nothing else. Nothing runs at all under
 * prefers-reduced-motion — the pile is then exactly as still as a screenshot.
 */

/** Full tracking inside this radius of an eye. */
const NEAR_PX = 150;
/** Fully settled back to centre beyond this one. */
const FAR_PX = 320;
/** Pupil travel, in sprite user units — the eye cell is 10 and the pupil ~4.8,
 *  so ±1.4 horizontally stays inside the white. */
const PUPIL_X = 1.4;
const PUPIL_Y = 1.1;
/** How far the head leans, in degrees, at the extremes. */
const LEAN_DEG = 5;
/** Pointer px per degree of lean. */
const LEAN_DIVISOR = 22;
/** One sweep of a working agent's eyes. */
const SCAN_MS = 5200;
const SCAN_UNITS = 1;
/** Rects go stale when the header reflows; cheaper to re-read than to observe. */
const REMEASURE_MS = 1200;

type Eye = { el: SVGCircleElement; cx: number; cy: number; working: boolean };
type Head = { el: SVGSVGElement; cx: number; cy: number };

export function useFacepileAttention(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let eyes: Eye[] = [];
    let heads: Head[] = [];
    let px = -9999;
    let py = -9999;
    let raf = 0;

    const measure = () => {
      eyes = [];
      heads = [];
      host.querySelectorAll<SVGCircleElement>(".sprite-cell--eye circle").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const slot = el.closest<HTMLElement>("[data-state]");
        eyes.push({
          el,
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          working: slot?.dataset.state === "in_flight",
        });
      });
      host
        .querySelectorAll<SVGSVGElement>(".s-thread-participant-avatar svg")
        .forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width) return;
          heads.push({ el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
        });
    };

    /** 1 within NEAR_PX, easing to 0 by FAR_PX. */
    const attention = (d: number) =>
      d < NEAR_PX ? 1 : d > FAR_PX ? 0 : (FAR_PX - d) / (FAR_PX - NEAR_PX);

    const frame = (now: number) => {
      for (const eye of eyes) {
        const dx = px - eye.cx;
        const dy = py - eye.cy;
        const d = Math.hypot(dx, dy);
        const near = attention(d);
        const len = d < 1 ? 1 : d;
        let ux = (dx / len) * PUPIL_X * near;
        const uy = (dy / len) * PUPIL_Y * near;
        if (eye.working && near < 1) {
          const t = (now % SCAN_MS) / SCAN_MS;
          ux += Math.sin(t * Math.PI * 2) * SCAN_UNITS * (1 - near);
        }
        eye.el.style.transform = `translate(${ux.toFixed(2)}px, ${uy.toFixed(2)}px)`;
      }
      for (const head of heads) {
        const dx = px - head.cx;
        const d = Math.hypot(dx, py - head.cy);
        const lean = attention(d);
        const deg = Math.max(-LEAN_DEG, Math.min(LEAN_DEG, dx / LEAN_DIVISOR)) * lean;
        // Rest is always square: an empty transform, never a rounded-to-zero one.
        head.el.style.transform = deg === 0 ? "" : `rotate(${deg.toFixed(2)}deg)`;
      }
      raf = requestAnimationFrame(frame);
    };

    const onMove = (event: PointerEvent) => {
      px = event.clientX;
      py = event.clientY;
    };

    measure();
    const remeasure = window.setInterval(measure, REMEASURE_MS);
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", measure);
    document.addEventListener("pointermove", onMove, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(remeasure);
      window.removeEventListener("resize", measure);
      document.removeEventListener("pointermove", onMove);
      for (const eye of eyes) eye.el.style.transform = "";
      for (const head of heads) head.el.style.transform = "";
    };
  }, [root]);
}
