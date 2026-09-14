import { useEffect, useRef, useState } from "react";
import { CHIP_ART, CREW_ART, CREW_ASSETS_AVAILABLE, CREW_SHEETS, crewAssetUrl } from "../lib/crew-registry.ts";
import { makeRng } from "../lib/agent-identity.ts";
import "./crew-sprite.css";

export type CrewSpriteProps = {
  slug: string;
  /** Full artwork height in pixels, preserving its authored aspect ratio. */
  size: number;
  pixel?: boolean;
  paused?: boolean;
  expression?: "rest" | "look-left" | "look-right" | "look-up";
};

/** Original art and authored eye patches only. The enclosing control owns labels. */
export function CrewSprite({ slug, size, pixel = false, paused = false, expression = "rest" }: CrewSpriteProps) {
  const key = slug.toLowerCase();
  const art = CREW_ART[key];
  const sheet = !pixel ? CREW_SHEETS[key] : undefined;
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [blink, setBlink] = useState<string | null>(null);
  const available = CREW_ASSETS_AVAILABLE && Boolean(art) && (!pixel || Boolean(CHIP_ART[key]));
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(node.current);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReduced(preference.matches);
    const updateVisibility = () => setPageVisible(!document.hidden);
    preference.addEventListener("change", updatePreference);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => { observer.disconnect(); preference.removeEventListener("change", updatePreference); document.removeEventListener("visibilitychange", updateVisibility); };
  }, [available]);
  const canBlink = Boolean(sheet?.roles.includes("blink-half") && sheet.roles.includes("blink-shut")) && !paused && visible && pageVisible && !reduced;
  useEffect(() => {
    if (!canBlink) return;
    const rng = makeRng(`crew-blink:${key}`);
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setBlink("blink-half");
        timer = window.setTimeout(() => {
          setBlink("blink-shut");
          timer = window.setTimeout(() => {
            setBlink("blink-half");
            timer = window.setTimeout(() => { setBlink(null); schedule(); }, 40);
          }, 50);
        }, 40);
      }, rng.float(2800, 6800));
    };
    setBlink(null);
    schedule();
    return () => window.clearTimeout(timer);
  }, [key, canBlink]);
  if (!available || !art) return null;
  const role = canBlink && blink ? blink : expression;
  return <span ref={node} className={`crew-sprite${pixel ? " is-pixel" : ""}`} style={{ width: size * art.w / art.h, height: size }} aria-hidden="true">
    {key === "milo" && !pixel ? <span className="crew-sprite__visor-backing" /> : null}
    <img className="crew-sprite__art" src={crewAssetUrl(`${key}-${pixel ? "chip-id" : "bust"}.webp`)} alt="" draggable={false} />
    {sheet ? sheet.roles.map((patchRole) => <img key={patchRole} className="crew-sprite__patch" src={crewAssetUrl(`${sheet.dir}/${patchRole}.webp`)} alt="" draggable={false} style={{ left: `${sheet.patch[0] / art.w * 100}%`, top: `${sheet.patch[1] / art.h * 100}%`, width: `${sheet.patch[2] / art.w * 100}%`, height: `${sheet.patch[3] / art.h * 100}%`, visibility: role === patchRole ? "visible" : "hidden" }} />) : null}
  </span>;
}
