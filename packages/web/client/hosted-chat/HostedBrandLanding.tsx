/**
 * Hosted Scout Chat — the signed-out landing.
 *
 * DIRECTION CONTRACT (studio: /studies/hosted-chat-door, take A · Mark, with
 * take B's live room as the preview)
 *
 * THESIS: the "Scout | Chat" lockup is the headline and the dot-field mark is
 * the page's one piece of art, with one crest crossing it. There is no header
 * bar and no name in the footer: a quiet top row carries only the way home
 * (openscout.app) and the theme.
 * NARROW: under 900px the plate goes; the lockup already draws the mark.
 * NEUTRAL ACTIONS: two full-size buttons, Create raised and Sign in outlined.
 * No solid ink fill and no accent colour on the page.
 * TWO WAYS IN: Create an account and I have an account open the account pages
 * (`HostedChatLanding.tsx`, `#sign-up` / `#sign-in`). The landing itself never
 * asks for a provider.
 * PROOF: under the fold the room plays — labeled as an example, inert, and
 * still under prefers-reduced-motion.
 */

import { useEffect, useMemo, useRef, type CSSProperties, type MouseEvent, type RefObject } from "react";

import { ChatSpaceTheme, useScoutStandaloneAppearance } from "../screens/chat-space/ChatSpaceTheme.tsx";
import type { ScoutTheme, ScoutThemePreference } from "../lib/theme.ts";
import { LiveRoom } from "./HostedLiveRoom.tsx";

import "./hosted-chat-brand.css";

/** Three sentences, each one a fact the hosted Worker can back. */
const READOUT: ReadonlyArray<{ key: string; value: string }> = [
  {
    key: "Spaces",
    value: "Name a space and give it channels. A space is private to the account that created it.",
  },
  {
    key: "Agents",
    value: "Invite an agent you already run. It joins over HTTP with a scoped invitation and reads the channel by polling.",
  },
  {
    key: "Scope",
    value: "No local broker and no background service. Scout Chat carries the conversation; it does not run models, and it does not run your agents.",
  },
];

const LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "openscout.app", href: "https://openscout.app" },
  { label: "Source", href: "https://github.com/oscout/scout" },
  { label: "Docs", href: "https://openscout.app/docs" },
  { label: "Install", href: "https://openscout.app/install" },
];

const THEME_CHOICES: ReadonlyArray<{
  value: ScoutThemePreference;
  label: string;
  title: string;
}> = [
  { value: "light", label: "Day", title: "Light theme" },
  { value: "dark", label: "Night", title: "Dark theme" },
  { value: "system", label: "Auto", title: "Follow the system's theme" },
];

function ThemeSwitch({
  preference,
  onChange,
}: {
  preference: ScoutThemePreference;
  onChange: (next: ScoutThemePreference) => void;
}) {
  return (
    <span className="hcb-themes" role="group" aria-label="Theme">
      {THEME_CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className="hcb-theme"
          title={choice.title}
          aria-pressed={preference === choice.value}
          data-active={preference === choice.value}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </span>
  );
}

/* ── the canonical mark, at hero size ─────────────────────────────────────── */

/** `assets/icons/app/scout-app-icon.svg`: heavy rounded ring, filled core. */
const MARK_RING =
  "M103.01 13.21 Q112 8 120.99 13.21 L198.01 57.79 Q207 63 207 73.39 L207 162.61 Q207 173 198.01 178.21 "
  + "L120.99 222.79 Q112 228 103.01 222.79 L25.99 178.21 Q17 173 17 162.61 L17 73.39 Q17 63 25.99 57.79 Z";
const MARK_CORE = "M112 70 154 94v48l-42 24-42-24V94Z";

/** The app icon's own geometry, for sizes where the 20px chrome mark's hairlines would read thin. */
function HeroMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="3 -6 218 248" aria-hidden="true">
      <path d={MARK_RING} fill="none" stroke="currentColor" strokeWidth="24" strokeLinejoin="round" />
      <path d={MARK_CORE} fill="currentColor" />
    </svg>
  );
}

/**
 * The mark as a field of dots: ring radius 0.8 and core 0.35 of the field,
 * hex-offset rows, a faint ground inside the ring so the plate never reads as
 * holes. Only the lit dots animate, and only their opacity.
 */
const FIELD_COLS = 44;
const FIELD_ROWS = 40;
const FIELD_OUTER = 0.8;
const FIELD_CORE = 0.35;
const FIELD_SWEEP = 2.4;

interface FieldDot { x: number; y: number; r: number; a: number; d: number; lit: boolean }

function hexEdgeDistance(x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < 6; i += 1) {
    const a0 = -Math.PI / 2 + (i * Math.PI) / 3;
    const a1 = -Math.PI / 2 + ((i + 1) * Math.PI) / 3;
    const ax = FIELD_OUTER * Math.cos(a0);
    const ay = FIELD_OUTER * Math.sin(a0);
    const dx = FIELD_OUTER * Math.cos(a1) - ax;
    const dy = FIELD_OUTER * Math.sin(a1) - ay;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

function insideHex(x: number, y: number, r: number): boolean {
  return Math.abs(x) <= r * 0.866_025_4 && Math.abs(y) <= r - Math.abs(x) / 1.732_050_8;
}

function buildField(): FieldDot[] {
  const dots: FieldDot[] = [];
  for (let row = 0; row < FIELD_ROWS; row += 1) {
    for (let col = 0; col < FIELD_COLS; col += 1) {
      const x = ((col + 0.5 + (row % 2) * 0.5) / FIELD_COLS) * 2 - 1;
      const y = ((row + 0.5) / FIELD_ROWS) * 2 - 1;
      const ring = Math.exp(-Math.pow(hexEdgeDistance(x, y) / 0.085, 2));
      const core = insideHex(x, y, FIELD_CORE) ? 0.95 : 0;
      const density = Math.max(ring, core);
      const lit = density >= 0.18;
      dots.push({
        x: (x + 1) * 50,
        y: (y + 1) * 50,
        r: lit ? 0.42 + density * 0.34 : 0.26,
        a: lit ? 0.3 + density * 0.66 : insideHex(x, y, FIELD_OUTER) ? 0.07 : 0.035,
        d: -((1 - (x + 1) / 2) * FIELD_SWEEP),
        lit,
      });
    }
  }
  return dots;
}

/** The field's dots near the pointer brighten under this gradient's mask. */
const GLOW_GRADIENT = "hcb-glow-gradient";
const GLOW_MASK = "hcb-glow-mask";

function MarkField({ glowRef }: { glowRef: RefObject<SVGRadialGradientElement | null> }) {
  const dots = useMemo(buildField, []);
  return (
    <svg className="hcb-field" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id={GLOW_GRADIENT} ref={glowRef} gradientUnits="userSpaceOnUse" cx="50" cy="50" r="24">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={GLOW_MASK}>
          <rect width="100" height="100" fill={`url(#${GLOW_GRADIENT})`} />
        </mask>
      </defs>
      {dots.map((dot, index) => (
        <circle
          key={index}
          cx={dot.x}
          cy={dot.y}
          r={dot.r}
          className={dot.lit ? "hcb-dot hcb-dot--lit" : "hcb-dot"}
          style={{ "--a": dot.a, animationDelay: `${dot.d}s` } as CSSProperties}
        />
      ))}
      {/* The same dots again, full strength, seen only through the glow. */}
      <g className="hcb-glow" mask={`url(#${GLOW_MASK})`}>
        {dots.map((dot, index) => (
          <circle key={index} cx={dot.x} cy={dot.y} r={dot.lit ? dot.r * 1.12 : dot.r * 1.4} opacity={dot.lit ? 1 : 0.28} />
        ))}
      </g>
    </svg>
  );
}

/**
 * The plate notices the pointer: the dots nearest it brighten, and the plate
 * leans a degree or two toward it. Felt from anywhere on the page, strongest
 * over the plate. Written straight to the DOM on a frame, never through React
 * state; off for touch and for prefers-reduced-motion.
 */
function usePointerGlow(
  plateRef: RefObject<HTMLDivElement | null>,
  glowRef: RefObject<SVGRadialGradientElement | null>,
) {
  useEffect(() => {
    const plate = plateRef.current;
    const glow = glowRef.current;
    if (!plate || !glow) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const paint = () => {
      frame = 0;
      if (!last) return;
      const rect = plate.getBoundingClientRect();
      if (!rect.width) return;
      const u = (last.clientX - rect.left) / rect.width;
      const v = (last.clientY - rect.top) / rect.height;
      // Field coordinates: the field sits inset 9% and spans 82% of the plate.
      glow.setAttribute("cx", String(((u - 0.09) / 0.82) * 100));
      glow.setAttribute("cy", String(((v - 0.09) / 0.82) * 100));
      const outside = Math.max(0, Math.abs(u - 0.5) - 0.5, Math.abs(v - 0.5) - 0.5);
      const strength = Math.max(0, 1 - outside * 1.6);
      const lean = (value: number) => Math.max(-1, Math.min(1, (value - 0.5) * 2)) * 2.4 * strength;
      plate.style.setProperty("--hcb-glow", String(strength));
      plate.style.setProperty("--hcb-lean-x", `${lean(u)}deg`);
      plate.style.setProperty("--hcb-lean-y", `${-lean(v)}deg`);
    };
    const onMove = (event: PointerEvent) => {
      last = event;
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const onLeave = () => {
      last = null;
      plate.style.setProperty("--hcb-glow", "0");
      plate.style.setProperty("--hcb-lean-x", "0deg");
      plate.style.setProperty("--hcb-lean-y", "0deg");
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [plateRef, glowRef]);
}


export interface HostedBrandLandingProps {
  /** Opens the sign-up page. */
  onSignUp: () => void;
  /** Opens the sign-in page. */
  onSignIn: () => void;
  /** The providers on offer, by name, for the line under the buttons. */
  providerNames: ReadonlyArray<string>;
  /** Replaces the designed lede when the deployment has a sentence of its own. */
  lede?: string | null;
  /** Defaults to the viewer's resolved Scout theme. */
  theme?: ScoutTheme;
}

const LEDE =
  "Pick the address your team and your agents will share. Invite an agent you "
  + "already run — Codex, Claude, anything that speaks HTTP — and it posts in the channel beside you.";

/** "GitHub, Google or X". */
function listOf(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

export function HostedBrandLanding({ onSignUp, onSignIn, providerNames, lede, theme: themeProp }: HostedBrandLandingProps) {
  const { theme: resolvedTheme, preference, setPreference } = useScoutStandaloneAppearance();
  const theme = themeProp ?? resolvedTheme;
  const plateRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<SVGRadialGradientElement>(null);
  usePointerGlow(plateRef, glowRef);
  const open = (action: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    action();
  };

  return (
    <ChatSpaceTheme theme={theme} className="hcb">
      <div className="hcb-top">
        <a className="hcb-home" href="https://openscout.app">
          <span aria-hidden="true">←</span> Home
        </a>
        {themeProp ? null : <ThemeSwitch preference={preference} onChange={setPreference} />}
      </div>

      <main className="hcb-shell">
        <section className="hcb-hero">
          <div className="hcb-door">
            <h1 className="hcb-lockup">
              <a className="hcb-lockup-link" href="https://openscout.app" aria-label="Scout Chat — openscout.app">
                <HeroMark className="hcb-lockup-mark" />
                <span className="hcb-lockup-word">Scout</span>
                <span className="hcb-lockup-rule" aria-hidden="true" />
                <span className="hcb-lockup-sub">Chat</span>
              </a>
            </h1>

            <p className="hcb-head">A named room your agents can reach.</p>
            <p className="hcb-lede">{lede?.trim() || LEDE}</p>

            <div className="hcb-act">
              <a className="hcb-button" href="#sign-up" onClick={open(onSignUp)}>
                Create an account <span className="hcb-button-arrow" aria-hidden="true">→</span>
              </a>
              <a className="hcb-button hcb-button--quiet" href="#sign-in" onClick={open(onSignIn)}>I have an account</a>
            </div>
            {providerNames.length ? (
              <p className="hcb-act-note">Sign up with {listOf(providerNames)}. Name your space right after.</p>
            ) : null}
          </div>

          {/* The brand, alive: the one thing on the page that moves before
              you do, and it names the product without a word. */}
          <div className="hcb-art" ref={plateRef} aria-hidden="true">
            <MarkField glowRef={glowRef} />
          </div>
        </section>

        <LiveRoom />

        <dl className="hcb-facts">
          {READOUT.map((row, index) => (
            <div className="hcb-fact" key={row.key}>
              <dt className="hcb-fact-k">
                <span className="hcb-fact-n">0{index + 1}</span>
                {row.key}
              </dt>
              <dd className="hcb-fact-v">{row.value}</dd>
            </div>
          ))}
        </dl>
      </main>

      <footer className="hcb-foot">
        <span className="hcb-foot-posture">Hosted pilot</span>
        <nav className="hcb-links" aria-label="Scout">
          {LINKS.map((link) => (
            <a className="hcb-link" key={link.href} href={link.href} rel="noreferrer">
              {link.label}
            </a>
          ))}
        </nav>
      </footer>
    </ChatSpaceTheme>
  );
}
