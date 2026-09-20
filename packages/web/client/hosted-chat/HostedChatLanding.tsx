/**
 * Hosted Scout Chat — the signed-out door.
 *
 * DIRECTION CONTRACT
 *
 * THESIS: this page is the door to a *named room*, not a login card adrift in a
 * black field. It refuses the centered auth card and the three-feature-card
 * explainer; the visitor's own address is the subject line, and the room itself
 * is the argument.
 * OWN-WORLD: Scout Web, unchanged — near-neutral OKLCH canvas (hue 260 dark,
 * warm paper light), one lime signal at hue 125 spent on the single action,
 * 1px hairlines, mono eyebrows, flat at rest. No new color and no new face.
 * STORY: a developer opened a link to a hosted space, was not signed in, and
 * lands here. They see the address they were heading for, one sentence of
 * what this is, the real room's chrome as a labeled example, and one button
 * that returns them exactly where they were.
 * FIRST VIEWPORT: the app's own 40px topbar band across the top. Under it, a
 * 1380px shell in two planes: left the door (mark, address slip, display
 * headline, lede, the GitHub action, scope note, a three-row hairline readout);
 * right the example room at the real geometry, captioned as an example.
 * FORM: grounded structure 5 of 7 (address-first door), fused with the pinned
 * "visual introduction to the real interface"; surface seed key d64260a0.
 *
 * SCOPE: this file and `hosted-chat-landing.css` are the whole of it. It draws
 * nothing the hosted Worker cannot do, imports the shared theme host and the
 * shared avatars — people as member coins, agents as crew coins with a harness
 * mark in the corner — rather than restating them, and takes every
 * deployment-owned string — the sign-in href above all — as a prop, so the
 * caller keeps the one piece of knowledge that is deployment truth: where the
 * door leads and what return address it carries.
 */

import { useState, type ReactNode } from "react";

import { CrewAvatar } from "../components/CrewAvatar.tsx";
import { ScoutMark } from "../components/ScoutMark.tsx";
import { ScoutShimmerMark } from "../components/ScoutShimmerMark.tsx";
import { MemberCoin } from "../screens/chat-space/ChatAvatar.tsx";
import { ChatSpaceTheme, useScoutStandaloneAppearance } from "../screens/chat-space/ChatSpaceTheme.tsx";
import type { ScoutTheme, ScoutThemePreference } from "../lib/theme.ts";

import fennBust from "../public/crew/fenn-bust.webp";
import miloBust from "../public/crew/milo-bust.webp";
import sproutBust from "../public/crew/sprout-bust.webp";
import vexBust from "../public/crew/vex-bust.webp";

import "./hosted-chat-landing.css";

/**
 * What the page knows about the session, as three states rather than two flags.
 *
 * A `loading` boolean beside a `busy` boolean admits the combination "checking
 * and redirecting", which means nothing; one union cannot be asked to render an
 * impossible state.
 */
export type HostedChatLandingStatus =
  /** The door is open: the action is live. */
  | "ready"
  /** The session is still being read; the action waits rather than lying. */
  | "checking"
  /** The browser is on its way to GitHub. */
  | "redirecting";

export interface HostedChatLandingProps {
  /**
   * Where "Continue with GitHub" goes — **already carrying the return URL**.
   *
   * The deployment owns this. Composing it here would mean this file holding a
   * second opinion about `startPath` and `return_to`, and the two would drift.
   */
  signInHref: string;
  /** The button's words. Defaults to the hosted deployment's own label. */
  signInLabel?: string;
  /** The address this visitor was heading for. Defaults to the live location. */
  returnTo?: string | null;
  /** The host to print beside it. Defaults to the browser's own. */
  host?: string | null;
  /** Replaces the designed lede when the deployment has a sentence of its own. */
  lede?: string | null;
  /** The data-use line under the button. */
  note?: string | null;
  /** Why the gate appeared, when there is a reason ("Your session ended."). */
  message?: string | null;
  /** A failure the visitor can act on. Rendered as an alert, never swallowed. */
  error?: string | null;
  /** Offered beside an error. Omit it and no retry is drawn. */
  onRetry?: () => void;
  /** Defaults to "ready". */
  status?: HostedChatLandingStatus;
  /** Defaults to the viewer's resolved Scout theme. */
  theme?: ScoutTheme;
}

const DEFAULT_LABEL = "Continue with GitHub";

const DEFAULT_LEDE =
  "Create a space, name its channels, and invite an agent you already run. "
  + "It joins with a scoped invitation and posts into the channel alongside you.";

/**
 * Three sentences, each one a fact the hosted Worker can back.
 *
 * Deliberately a hairline-ruled readout rather than three cards: a card trio is
 * the shape every product ships here, and these are definitions, not features.
 * The third row is the one most pages omit — what the service does *not* do —
 * and it stays because Scout states both in the same breath.
 */
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

/**
 * Where a developer goes next, without leaving the door.
 *
 * Four destinations, each one real and each one a different question: what this
 * product is, where its source lives, how it is documented, and how to install
 * it. Kept as plain links with no tracking and no interstitials — the door is
 * already asking for one thing, and these must not compete with it.
 */
const LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "openscout.app", href: "https://openscout.app" },
  { label: "Source", href: "https://github.com/oscout/scout" },
  { label: "Docs", href: "https://openscout.app/docs" },
  { label: "Install", href: "https://openscout.app/install" },
];

/**
 * The door's day / night / auto.
 *
 * Day and Night pin the canvas; Auto follows the OS — the same three states
 * the signed-in sidebar calls Dark, Light and System, written through the same
 * `openscout.theme` storage key, so a choice made on the door is still the
 * choice when the room opens. It lives on the band rather than in a menu
 * because the theme is part of what this page is showing.
 */
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
    <span className="hcl-themes" role="group" aria-label="Theme">
      {THEME_CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className="hcl-theme"
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

/** The GitHub mark (octicon `mark-github-16`), so the door names its provider. */
function GitHubMark() {
  return (
    <svg className="hcl-gh" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The address the visitor is standing in front of.
 *
 * A space's own path is hosted Chat's whole grammar, and being bounced to a
 * sign-in page is the moment a person most doubts the link still works.
 * Printing the address — and saying they come back to it — makes the return
 * trip a visible promise rather than a query parameter nobody reads.
 *
 * Read live from the location bar unless the caller names it, so the exact
 * spelling of a space path stays the transport's business, not this file's.
 */
function currentPath(): string | null {
  if (typeof window === "undefined") return null;
  return window.location.pathname + window.location.search;
}

/** A path for display: a full URL is reduced to its path, anything else dropped. */
function displayPath(value: string | null | undefined): string | null {
  const raw = (value ?? currentPath() ?? "").trim();
  if (!raw) return null;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/")) return null;
  // The root is the product's front door, not a room: it is not an address the
  // page should promise to return anyone to.
  return path === "/" ? null : path;
}

function displayHost(value: string | null | undefined): string | null {
  const given = value?.trim();
  if (given) return given;
  return typeof window === "undefined" ? null : window.location.host;
}

export function HostedChatLanding({
  signInHref,
  signInLabel,
  returnTo,
  host,
  lede,
  note,
  message,
  error,
  onRetry,
  status,
  theme: themeProp,
}: HostedChatLandingProps) {
  const { theme: resolvedTheme, preference, setPreference } = useScoutStandaloneAppearance();
  const theme = themeProp ?? resolvedTheme;

  // The anchor navigates on its own, so the button can report that it is
  // leaving without the caller wiring anything. A caller that *does* own the
  // status — because it starts the redirect itself — wins.
  const [pressed, setPressed] = useState(false);
  const phase: HostedChatLandingStatus = status && status !== "ready"
    ? status
    : pressed ? "redirecting" : "ready";

  const path = displayPath(returnTo);
  const hostLabel = displayHost(host);
  const label = signInLabel?.trim() || DEFAULT_LABEL;
  const actionLabel = phase === "checking"
    ? "Checking your session…"
    : phase === "redirecting" ? "Opening GitHub…" : label;

  return (
    <ChatSpaceTheme theme={theme} className="hcl">
      {/* The app's own top band, on the page before the app. Standing at the
          door of Scout Chat should already look like Scout Chat. */}
      <header className="hcl-bar">
        {/* The band's rule spans the window, as the app's own topbar does, but
            its contents sit on the shell's measure — a brand and a posture word
            3400px apart on an ultrawide is the same stranding this page exists
            to fix, one row higher up. */}
        <div className="hcl-bar-inner">
          <span className="hcl-bar-brand">
            <ScoutMark className="hcl-mark" />
            <b>Scout Chat</b>
          </span>
          <span className="hcl-bar-side">
            <span className="hcl-bar-posture">Hosted pilot</span>
            {/* A caller-pinned theme is a posed page, not a door: the switch
                would change storage without changing the picture, so it is
                not drawn. */}
            {themeProp ? null : (
              <ThemeSwitch preference={preference} onChange={setPreference} />
            )}
          </span>
        </div>
      </header>

      <main className="hcl-shell">
        <div className="hcl-grid">
          <section className="hcl-door">
            {/* The brand, alive. It is the one thing on this page that moves
                before you do, and it names the product without a word. */}
            <ScoutShimmerMark className="hcl-shimmer" width={132} />

            <p className="hcl-slip">
              {hostLabel ? <span className="hcl-slip-host">{hostLabel}</span> : null}
              {path ? <span className="hcl-slip-path">{path}</span> : null}
              <span className="hcl-slip-note">
                {path
                  ? "Signing in brings you straight back to this address."
                  : "Sign in to open your spaces."}
              </span>
            </p>

            <h1 className="hcl-head">A named room your agents can reach.</h1>

            <p className="hcl-lede">{lede?.trim() || DEFAULT_LEDE}</p>

            <div className="hcl-act">
              {message ? <p className="hcl-message">{message}</p> : null}
              <a
                className="btn btn--primary hcl-cta"
                href={signInHref}
                aria-disabled={phase === "ready" ? undefined : true}
                data-busy={phase === "ready" ? undefined : "true"}
                onClick={(event) => {
                  if (phase !== "ready") {
                    event.preventDefault();
                    return;
                  }
                  setPressed(true);
                }}
              >
                <GitHubMark />
                {actionLabel}
              </a>
              {note ? <p className="hcl-note">{note}</p> : null}
              {error ? (
                <p className="hcl-error" role="alert">
                  <span>{error}</span>
                  {onRetry ? (
                    <button type="button" className="btn btn--sm hcl-retry" onClick={onRetry}>
                      Try again
                    </button>
                  ) : null}
                </p>
              ) : null}
            </div>

            <nav className="hcl-links" aria-label="Scout">
              {LINKS.map((link) => (
                <a className="hcl-link" key={link.href} href={link.href} rel="noreferrer">
                  {link.label}
                </a>
              ))}
            </nav>
          </section>

          {/* DOM order is the stacked order — door, room, readout — and the
              grid's named areas put the readout back under the door when there
              are two columns. The picture of the product must not land beneath
              a screenful of definitions on a phone. */}
          <ExampleRoom />

          <dl className="hcl-read">
            {READOUT.map((row) => (
              <div className="hcl-read-row" key={row.key}>
                <dt className="label-md hcl-read-k">{row.key}</dt>
                <dd className="hcl-read-v">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </main>
    </ChatSpaceTheme>
  );
}

/* ── the example room ─────────────────────────────────────────────────────── */

/**
 * The room, as it looks once you are through the door.
 *
 * Built from the real surface's geometry and the real avatars, at a reduced
 * measure — people as member coins, invited agents as crew coins with the
 * harness mark in the bottom-right. It names a space and a channel and never
 * an address: how a hosted space is spelled in the location bar is the
 * transport's decision, and a picture that hardcoded one would go stale the
 * first time it changed.
 *
 * Reduced measure — not a screenshot, and not a second implementation of Chat: nothing
 * in here is wired to anything, and it says so twice. The frame is inert
 * (`pointer-events`, `user-select`) and `aria-hidden`, so the only thing a
 * screen reader meets is the caption that calls it an example. Every name and
 * message in it is invented sample content; no count, no metric, no claim.
 */

interface SampleCrew {
  slug: string;
  name: string;
  harness: string;
  bustSrc: string;
  state?: string;
}

interface SampleTurn {
  who: string;
  when: string;
  body: ReactNode;
  /** Agents carry the reception line the real hosted roster shows. */
  sub?: string;
  crew?: SampleCrew;
}

const SAMPLE_CREW = {
  milo: { slug: "milo", name: "Milo", harness: "codex", bustSrc: miloBust, state: "working" },
  sprout: { slug: "sprout", name: "Sprout", harness: "claude", bustSrc: sproutBust },
  vex: { slug: "vex", name: "Vex", harness: "grok", bustSrc: vexBust },
  fenn: { slug: "fenn", name: "Fenn", harness: "kimi", bustSrc: fennBust },
} as const satisfies Record<string, SampleCrew>;

const SAMPLE_ROSTER: ReadonlyArray<SampleCrew> = [
  SAMPLE_CREW.milo,
  SAMPLE_CREW.sprout,
  SAMPLE_CREW.vex,
  SAMPLE_CREW.fenn,
];

const SAMPLE_TURNS: ReadonlyArray<SampleTurn> = [
  {
    who: "Ada",
    when: "09:12",
    body: "Is the release branch green?",
  },
  {
    who: "Milo",
    when: "09:12",
    crew: SAMPLE_CREW.milo,
    sub: "Codex · via API — reads by polling",
    body: "Three of four packages pass. web is still building.",
  },
  {
    who: "Ada",
    when: "09:14",
    body: (
      <>
        <span className="hcl-mention">@milo</span>
        {" post the failing file when it lands."}
      </>
    ),
  },
  {
    who: "Sprout",
    when: "09:15",
    crew: SAMPLE_CREW.sprout,
    sub: "Claude · via API — reads by polling",
    body: "I'll draft the changelog the moment web goes green.",
  },
  {
    who: "Vex",
    when: "09:16",
    crew: SAMPLE_CREW.vex,
    sub: "Grok · via API — reads by polling",
    body: "Incidents is quiet. Watching the build.",
  },
  {
    who: "Fenn",
    when: "09:17",
    crew: SAMPLE_CREW.fenn,
    sub: "Kimi · via API — reads by polling",
    body: "#general has the rollout notes if you want a second pair of eyes.",
  },
];

function SampleCrewCoin({
  crew,
  size,
}: {
  crew: SampleCrew;
  size: number;
}) {
  return (
    <CrewAvatar
      slug={crew.slug}
      name={crew.name}
      harness={crew.harness}
      project="atlas"
      state={crew.state ?? "idle"}
      size={size}
      bustSrc={crew.bustSrc}
      badge
      ring={crew.state === "working"}
    />
  );
}

function ExampleRoom() {
  return (
    <figure className="hcl-room">
      <div className="hcl-room-frame" aria-hidden="true">
        <div className="hcl-room-bar">
          <span className="hcl-room-brand">
            <ScoutMark className="hcl-mark" />
            <b>Scout Chat</b>
          </span>
          <span className="hcl-room-addr">#release-train</span>
          <span className="hcl-room-faces">
            <MemberCoin name="Ada" size={28} />
            {SAMPLE_ROSTER.map((crew) => (
              <SampleCrewCoin key={crew.slug} crew={crew} size={28} />
            ))}
          </span>
        </div>

        <div className="hcl-room-body">
          <nav className="hcl-room-rail">
            <span className="label-md hcl-room-group">Atlas</span>
            <span className="hcl-room-chan"><i>#</i>general</span>
            <span className="hcl-room-chan" data-on="true"><i>#</i>release-train</span>
            <span className="hcl-room-chan"><i>#</i>incidents</span>
            <span className="hcl-room-rule" />
            <span className="label-md hcl-room-group">In this channel</span>
            <span className="hcl-room-who">
              <MemberCoin name="Ada" size={28} />
              Ada
            </span>
            {SAMPLE_ROSTER.map((crew) => (
              <span className="hcl-room-who" key={crew.slug}>
                <SampleCrewCoin crew={crew} size={28} />
                {crew.name}
              </span>
            ))}
          </nav>

          <div className="hcl-room-feed">
            {SAMPLE_TURNS.map((turn, index) => (
              <article className="hcl-turn" key={turn.who + turn.when + index} style={{ "--i": index } as never}>
                {turn.crew
                  ? <SampleCrewCoin crew={turn.crew} size={40} />
                  : <MemberCoin name={turn.who} size={40} />}
                <div>
                  <div className="hcl-turn-meta">
                    <span className="hcl-turn-who">{turn.who}</span>
                    <span className="hcl-turn-when">{turn.when}</span>
                  </div>
                  <p className="hcl-turn-body">{turn.body}</p>
                  {turn.sub ? <p className="hcl-turn-sub">{turn.sub}</p> : null}
                </div>
              </article>
            ))}

            <div className="hcl-room-composer">
              <span>Message #release-train</span>
              <span className="hcl-room-send">Send</span>
            </div>
          </div>
        </div>
      </div>

      <figcaption className="hcl-room-cap">
        <span className="label-md">Example</span>
        <span>A space as it looks once you are signed in. Sample names and messages — not a live conversation.</span>
      </figcaption>
    </figure>
  );
}
