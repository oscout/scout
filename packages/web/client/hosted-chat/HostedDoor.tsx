/**
 * Hosted Scout Chat — the pieces every signed-out and first-run page shares.
 *
 * DIRECTION CONTRACT (studio: /studies/hosted-chat-door, take D · Account)
 *
 * THESIS: these are task pages — sign up, sign in, name your space, join a
 * channel — so each does one job in one centred panel. The brand is the ink
 * lockup in the corner (the landing, `HostedBrandLanding.tsx`, carries the
 * rest), and there is no accent colour.
 * PROVIDERS ARE EQUAL: GitHub, Google and X are drawn as the same neutral
 * button, each wearing its own mark. The visitor already knows which account
 * they have; the page does not pick for them.
 * ONE SOLID BUTTON, INK: where a page has a single action of its own (create a
 * space, join a channel) it is ink on the ground, never the accent.
 */

import { useEffect, useState, type ReactNode } from "react";

import { ScoutMark } from "../components/ScoutMark.tsx";
import { ChatSpaceTheme, useScoutStandaloneAppearance } from "../screens/chat-space/ChatSpaceTheme.tsx";
import type { ScoutTheme, ScoutThemePreference } from "../lib/theme.ts";

import "./hosted-chat-landing.css";

export interface SignInOption {
  /** Provider id; `github`, `google` and `x` draw their marks. */
  id: string;
  /** The button's words ("Continue with GitHub"). */
  label: string;
  /** The provider on its own ("GitHub"), for sentences about it. Defaults to `label`. */
  name?: string;
  hrefFor: (returnTo: string) => string;
}

/**
 * The providers a deployment offers, as door options. Each is a Worker route
 * (`/auth/<id>/start`) that takes the same return parameter.
 */
export function signInOptionsFor(
  providers: ReadonlyArray<{ id: string; label: string; startPath: string }>,
  returnToParam: string,
): SignInOption[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: `Continue with ${provider.label}`,
    name: provider.label,
    hrefFor: (returnTo: string) => `${provider.startPath}?${returnToParam}=${encodeURIComponent(returnTo)}`,
  }));
}

/** The provider this browser left with last, so a second visit is not a guess. */
const LAST_PROVIDER_KEY = "scout-chat:last-provider";

function readLastProvider(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROVIDER_KEY);
  } catch {
    // Private browsing, or storage the viewer has blocked. The door works without it.
    return null;
  }
}

function rememberProvider(id: string): void {
  try {
    window.localStorage.setItem(LAST_PROVIDER_KEY, id);
  } catch { /* see above: a hint, never a dependency */ }
}

/* ── the shell ────────────────────────────────────────────────────────────── */

const LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Docs", href: "https://openscout.app/docs" },
  { label: "Source", href: "https://github.com/oscout/scout" },
  { label: "openscout.app", href: "https://openscout.app" },
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

/**
 * The frame: the name in the corner, one centred panel, quiet links under it.
 * `aside` is what the bar's right edge says (the signed-in account, say).
 */
export function DoorShell({
  children,
  aside,
  theme: themeProp,
  labelledBy,
}: {
  children: ReactNode;
  aside?: ReactNode;
  theme?: ScoutTheme;
  labelledBy?: string;
}) {
  const { theme: resolvedTheme, preference, setPreference } = useScoutStandaloneAppearance();
  const theme = themeProp ?? resolvedTheme;
  return (
    <ChatSpaceTheme theme={theme} className="hcl">
      <header className="hcl-bar">
        <a className="hcl-name" href="/" aria-label="Scout Chat">
          <ScoutMark className="hcl-name-mark" />
          <b>Scout</b>
          <span className="hcl-name-sub">Chat</span>
        </a>
        {aside ? <span className="hcl-bar-aside">{aside}</span> : null}
      </header>

      <main className="hcl-page">
        <section className="hcl-panel" aria-labelledby={labelledBy}>
          {children}
        </section>
      </main>

      <footer className="hcl-foot">
        <nav className="hcl-links" aria-label="Scout">
          {LINKS.map((link) => (
            <a className="hcl-link" key={link.href} href={link.href} rel="noreferrer">
              {link.label}
            </a>
          ))}
        </nav>
        {themeProp ? null : <ThemeSwitch preference={preference} onChange={setPreference} />}
      </footer>
    </ChatSpaceTheme>
  );
}

/* ── providers ────────────────────────────────────────────────────────────── */

export type DoorPhase =
  /** The door is open: the buttons are live. */
  | "ready"
  /** The session is still being read; the buttons wait rather than lying. */
  | "checking"
  /** The browser is on its way to a provider. */
  | "redirecting";

/**
 * One column of equal provider buttons.
 *
 * While the browser is leaving, every button goes inert and the one that was
 * pressed shows it — but no label changes, because a button whose words move
 * under the pointer is a button you cannot trust. What is happening is said
 * once, in the live region under the buttons, where a screen reader hears it.
 */
export function ProviderButtons({
  options,
  returnTo,
  status,
}: {
  options: ReadonlyArray<SignInOption>;
  /** Where each provider sends the browser back to. */
  returnTo: string;
  /** Defaults to "ready". */
  status?: DoorPhase;
}) {
  // Which provider the browser is leaving with, not merely that it is leaving.
  const [leaving, setLeaving] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  // Read after mount: storage is per-viewer, and the server rendered none of it.
  useEffect(() => { setLast(readLastProvider()); }, []);
  const phase: DoorPhase = status && status !== "ready" ? status : leaving ? "redirecting" : "ready";
  const inert = phase !== "ready";
  const going = options.find((option) => option.id === leaving);

  return (
    <div className="hcl-act">
      <div className="hcl-providers">
        {options.map((option) => {
          const busy = leaving === option.id;
          return (
            <a
              key={option.id}
              className="hcl-provider"
              data-provider={option.id}
              data-busy={busy || undefined}
              aria-disabled={inert || undefined}
              href={option.hrefFor(returnTo)}
              onClick={(event) => {
                if (inert) {
                  event.preventDefault();
                  return;
                }
                setLeaving(option.id);
                rememberProvider(option.id);
              }}
            >
              <span className="hcl-provider-mark" data-busy={busy || undefined}>
                <ProviderMark id={option.id} />
              </span>
              <span className="hcl-provider-label">{option.label}</span>
              {/* Accounts are never linked across providers, so the wrong door
                  silently makes a second, empty account. This is the reminder. */}
              {last === option.id && options.length > 1 && !inert
                ? <span className="hcl-last">Last used</span>
                : null}
            </a>
          );
        })}
      </div>
      <p className="hcl-phase" role="status" aria-live="polite">
        {phase === "checking"
          ? "Checking your session…"
          : phase === "redirecting"
            ? `Opening ${going?.name ?? going?.label ?? "sign-in"}…`
            : ""}
      </p>
    </div>
  );
}

/**
 * Each provider wears its own mark, so the buttons read as a choice between
 * accounts rather than three copies of one action. A provider without a mark
 * still gets a button — just a words-only one.
 */
function ProviderMark({ id }: { id: string }) {
  if (id === "github") return <GitHubMark />;
  if (id === "google") return <GoogleMark />;
  if (id === "x") return <XMark />;
  return null;
}

/** The GitHub mark (octicon `mark-github-16`). */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Google's "G", in its four colours — a provider's mark, and the page's only colour. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

/** X's mark. Ink, like the rest of the page. */
function XMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" fill="currentColor">
      <path d="M13.9 1.5h2.62l-5.73 6.55L17.53 16.5h-5.27l-4.13-5.4-4.73 5.4H.78l6.13-7.01L.61 1.5h5.4l3.73 4.93L13.9 1.5Zm-.92 13.43h1.45L5.1 2.99H3.54l9.44 11.94Z" />
    </svg>
  );
}
