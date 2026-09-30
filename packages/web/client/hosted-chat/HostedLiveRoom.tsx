/**
 * Hosted Scout Chat — the example room on the signed-out landing.
 *
 * The room, as it looks once you are through the door — and it plays. Built
 * from the real avatars (people as member coins, agents as crew coins with a
 * harness mark), inert and `aria-hidden`; the caption is the only thing a
 * screen reader meets. Every name and message is invented sample content.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { CrewAvatar } from "../components/CrewAvatar.tsx";
import { MemberCoin } from "../screens/chat-space/ChatAvatar.tsx";

import fennBust from "../public/crew/fenn-bust.webp";
import miloBust from "../public/crew/milo-bust.webp";
import sproutBust from "../public/crew/sprout-bust.webp";
import vexBust from "../public/crew/vex-bust.webp";

import "./hosted-chat-room.css";

interface SampleCrew {
  slug: string;
  name: string;
  harness: string;
  harnessLabel: string;
  bustSrc: string;
}

const CREW: Record<string, SampleCrew> = {
  Milo: { slug: "milo", name: "Milo", harness: "codex", harnessLabel: "Codex", bustSrc: miloBust },
  Sprout: { slug: "sprout", name: "Sprout", harness: "claude", harnessLabel: "Claude", bustSrc: sproutBust },
  Vex: { slug: "vex", name: "Vex", harness: "grok", harnessLabel: "Grok", bustSrc: vexBust },
  Fenn: { slug: "fenn", name: "Fenn", harness: "kimi", harnessLabel: "Kimi", bustSrc: fennBust },
};

const PEOPLE = ["Ada", ...Object.keys(CREW)];

const TURNS: ReadonlyArray<{ who: string; when: string; body: string }> = [
  { who: "Ada", when: "09:12", body: "Is the release branch green?" },
  { who: "Milo", when: "09:12", body: "Three of four packages pass. web is still building." },
  { who: "Ada", when: "09:14", body: "@milo post the failing file when it lands." },
  { who: "Sprout", when: "09:15", body: "I'll draft the changelog the moment web goes green." },
  { who: "Vex", when: "09:16", body: "Incidents is quiet. Watching the build." },
  { who: "Fenn", when: "09:17", body: "#general has the rollout notes if you want a second pair of eyes." },
];

interface Playback { shown: number; typing: string | null; draft: string; fading?: boolean }

/**
 * The room opens mid-conversation, never empty: the first turns are already
 * there, and the rest arrive. A replay rewinds to the same opening rather than
 * a blank channel, so the frame never looks like a page that failed to load.
 */
const OPENING = 3;
const FULL: Playback = { shown: TURNS.length, typing: null, draft: "" };
const OPENED: Playback = { shown: OPENING, typing: null, draft: "" };
const REWIND_MS = 420;
const GLIDE_MS = 520;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The rest of the channel as a chain of timeouts; replays after a held beat. */
function usePlayback(reduced: boolean): Playback {
  const [state, setState] = useState<Playback>(reduced ? FULL : OPENED);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const clear = () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current = [];
    };
    if (reduced) {
      setState(FULL);
      return clear;
    }
    const at = (ms: number, fn: () => void) => {
      timers.current.push(window.setTimeout(fn, ms));
    };
    // A replay dims the channel, rewinds it while it cannot be seen, and brings
    // it back, so the turns never snap out from under the reader.
    const replay = () => {
      clear();
      setState((s) => ({ ...s, typing: null, fading: true }));
      at(REWIND_MS, run);
    };
    const run = () => {
      clear();
      setState(OPENED);
      let t = 1400;
      TURNS.forEach((turn, index) => {
        if (index < OPENING) return;
        if (turn.who === "Ada") {
          for (let c = 1; c <= turn.body.length; c += 1) {
            const draft = turn.body.slice(0, c);
            at(t + c * 34, () => setState((s) => ({ ...s, draft })));
          }
          t += turn.body.length * 34 + 420;
        } else {
          at(t, () => setState((s) => ({ ...s, typing: turn.who })));
          t += 1300;
        }
        at(t, () => setState({ shown: index + 1, typing: null, draft: "" }));
        t += 900;
      });
      at(t + 6000, replay);
    };
    run();
    return clear;
  }, [reduced]);

  return state;
}

function Coin({ who, size }: { who: string; size: number }) {
  const crew = CREW[who];
  if (!crew) return <MemberCoin name={who} size={size} />;
  return (
    <CrewAvatar
      slug={crew.slug}
      name={crew.name}
      harness={crew.harness}
      project="atlas"
      state="idle"
      size={size}
      bustSrc={crew.bustSrc}
      badge
    />
  );
}

function Body({ text }: { text: string }): ReactNode {
  return text.split(/(@\w+|#[\w-]+)/g).map((part, index) =>
    /^[@#]\w/.test(part) ? <span key={index} className="hcl-mention">{part}</span> : part);
}

export function LiveRoom() {
  const reduced = useReducedMotion();
  const { shown, typing, draft, fading } = usePlayback(reduced);
  const stack = useRef<HTMLDivElement>(null);
  const height = useRef(0);

  // The feed is pinned to its bottom edge, so a new row pushes everything above
  // it up by its own height in one frame. Start the stack where it was and let
  // it glide up instead; the new row fades in underneath.
  useLayoutEffect(() => {
    const el = stack.current;
    if (!el) return;
    const next = el.offsetHeight;
    const rise = height.current ? next - height.current : 0;
    height.current = next;
    if (reduced || rise <= 0 || typeof el.animate !== "function") return;
    el.animate(
      [{ transform: `translateY(${rise}px)` }, { transform: "none" }],
      { duration: GLIDE_MS, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
  }, [shown, typing, reduced]);

  return (
    <figure className="hcl-room">
      <figcaption className="hcl-room-cap">
        <span className="hcl-eyebrow">Example</span>
        <span>A space once you are signed in. Sample names and messages, not a live conversation.</span>
      </figcaption>

      <div className="hcl-room-frame" aria-hidden="true">
        <div className="hcl-room-bar">
          <span className="hcl-room-chan"><i>#</i>release-train</span>
          <span className="hcl-room-space">atlas</span>
          <span className="hcl-room-faces">
            {PEOPLE.map((who) => <Coin key={who} who={who} size={24} />)}
          </span>
        </div>

        <div className="hcl-room-body">
          <nav className="hcl-room-rail">
            <span className="hcl-eyebrow hcl-room-group">atlas</span>
            <span className="hcl-room-link"><i>#</i>general</span>
            <span className="hcl-room-link" data-on="true"><i>#</i>release-train</span>
            <span className="hcl-room-link"><i>#</i>incidents</span>
            <span className="hcl-room-rule" />
            <span className="hcl-eyebrow hcl-room-group">In this channel</span>
            {PEOPLE.map((who) => (
              <span className="hcl-room-who" key={who}>
                <Coin who={who} size={22} />
                {who}
                {typing === who ? <span className="hcl-room-typing">typing</span> : null}
              </span>
            ))}
          </nav>

          <div className="hcl-room-main">
            <div className="hcl-room-feed" data-fading={fading || undefined}>
              <div className="hcl-room-stack" ref={stack}>
              {TURNS.slice(0, shown).map((turn, index) => {
                const crew = CREW[turn.who];
                return (
                  <article className="hcl-turn" key={index} data-seeded={index < OPENING || undefined} data-mention={turn.body.includes("@milo") || undefined}>
                    <Coin who={turn.who} size={36} />
                    <div className="hcl-turn-text">
                      <div className="hcl-turn-meta">
                        <span className="hcl-turn-who">{turn.who}</span>
                        {crew ? <span className="hcl-turn-tag">{crew.harnessLabel} · via API</span> : null}
                        <span className="hcl-turn-when">{turn.when}</span>
                      </div>
                      <p className="hcl-turn-body"><Body text={turn.body} /></p>
                    </div>
                  </article>
                );
              })}
              {typing ? (
                <div className="hcl-typing">
                  <Coin who={typing} size={36} />
                  <span className="hcl-typing-dots"><i /><i /><i /></span>
                  <span className="hcl-typing-label">{typing} is replying</span>
                </div>
              ) : null}
              </div>
            </div>

            <div className="hcl-composer" data-active={draft ? "true" : undefined}>
              <span className="hcl-composer-text">
                {draft
                  ? <><Body text={draft} /><span className="hcl-caret" /></>
                  : <span className="hcl-composer-hint">Message #release-train</span>}
              </span>
              <span className="hcl-composer-send">Send</span>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
