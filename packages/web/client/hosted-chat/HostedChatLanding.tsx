/**
 * Hosted Scout Chat — signed out.
 *
 * DIRECTION CONTRACT (studio: /studies/hosted-chat-door, take D · Account for
 * the task pages; the shared shell and provider buttons live in
 * `HostedDoor.tsx`)
 *
 * THREE PAGES, ONE COMPONENT:
 * - THE LANDING (the root, signed out): the brand-forward page, with the
 *   example room playing and two ways in — Sign up and Sign in
 *   (`HostedBrandLanding.tsx`). No accent colour anywhere.
 * - SIGN UP / SIGN IN (`#sign-up`, `#sign-in`): the same provider buttons —
 *   with OAuth they are the same click — but each says what it is for. Sign-up
 *   is a first-class path with its own heading and the promise of what comes
 *   next (naming the space, `HostedChatSetup.tsx`); sign-in is the way back.
 *   A hash, so the browser's Back returns to the landing.
 * - A ROOM'S ADDRESS: the visitor already has a destination, so the door is
 *   sign-in straight away, and it promises the way back to that room.
 *
 * Every deployment-owned string — the sign-in hrefs above all — is a prop.
 */

import { useEffect, useState } from "react";

import type { ScoutTheme } from "../lib/theme.ts";
import { displayAddress } from "./hosted-chat-landing-address.ts";
import type { AuthErrorNotice } from "./hosted-chat-auth-error.ts";
import { DoorShell, ProviderButtons, type DoorPhase, type SignInOption } from "./HostedDoor.tsx";
import { HostedBrandLanding } from "./HostedBrandLanding.tsx";

export type { SignInOption } from "./HostedDoor.tsx";

/** What the page knows about the session, as three states rather than two flags. */
export type HostedChatLandingStatus = DoorPhase;

export interface HostedChatLandingProps {
  /**
   * The single sign-in door — **already carrying the return URL** — for a
   * deployment that passes no `signInOptions`. The deployment owns this.
   */
  signInHref: string;
  /** One button per identity provider, each able to carry a return address. */
  signInOptions?: ReadonlyArray<SignInOption>;
  /** The single door's words. Defaults to "Continue with GitHub". */
  signInLabel?: string;
  /** The address this visitor was heading for. Defaults to the live location. */
  returnTo?: string | null;
  /** The host to print beside it. Defaults to the browser's own. */
  host?: string | null;
  /** Replaces the landing's lede when the deployment has a sentence of its own. */
  lede?: string | null;
  /** The data-use line under the buttons. */
  note?: string | null;
  /** Why the gate appeared, when there is a reason ("Your session ended."). */
  message?: string | null;
  /** A failure the visitor can act on. Rendered as an alert, never swallowed. */
  error?: string | null;
  /**
   * A sign-in that came back refused, already turned into a sentence by
   * `hosted-chat-auth-error.ts`. Shown above the buttons it is about.
   */
  authError?: AuthErrorNotice | null;
  /** Offered beside an error. Omit it and no retry is drawn. */
  onRetry?: () => void;
  /** Defaults to "ready". */
  status?: HostedChatLandingStatus;
  /** Defaults to the viewer's resolved Scout theme. */
  theme?: ScoutTheme;
}

const DEFAULT_LABEL = "Continue with GitHub";


/**
 * Accounts are per provider and are never linked, so the second door is a
 * different, empty account. Said where a returning visitor chooses.
 */
const SAME_PROVIDER = "Use the provider you signed up with: each one is a separate account.";


type View = "landing" | "sign-up" | "sign-in";

function viewFromHash(): View {
  if (typeof window === "undefined") return "landing";
  const hash = window.location.hash.slice(1);
  return hash === "sign-up" || hash === "sign-in" ? hash : "landing";
}

/** The landing's view, kept in the hash so Back and a shared link both work. */
function useView(): [View, (next: View) => void] {
  const [view, setView] = useState<View>(viewFromHash);
  useEffect(() => {
    const onChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = (next: View) => {
    window.location.hash = next === "landing" ? "" : next;
    // A fresh page starts at its top, not where the landing was scrolled to.
    document.querySelector(".hcl")?.scrollTo({ top: 0 });
  };
  return [view, go];
}

/**
 * A sign-in that came back refused. `hosted-chat-auth-error.ts` owns the
 * sentence; this only places it, adds the alternative when there is one, and
 * prints the Worker's own reason small — a pilot's visitor is often its
 * operator, and a code is what they will paste into an issue.
 */
function AuthNotice({ notice, multiple }: { notice: AuthErrorNotice | null; multiple: boolean }) {
  if (!notice) return null;
  return (
    <div className="hcl-notice" role="alert">
      <p>
        {notice.message}
        {notice.alternative && multiple ? " Try another provider." : null}
        {notice.code ? <code className="hcl-notice-code">{notice.code}</code> : null}
      </p>
    </div>
  );
}

function currentPath(): string | null {
  if (typeof window === "undefined") return null;
  return window.location.pathname + window.location.search;
}

function displayHost(value: string | null | undefined): string | null {
  const given = value?.trim();
  if (given) return given;
  return typeof window === "undefined" ? null : window.location.host;
}

export function HostedChatLanding({
  signInHref,
  signInOptions,
  signInLabel,
  returnTo,
  host,
  lede,
  note,
  message,
  error,
  authError,
  onRetry,
  status,
  theme,
}: HostedChatLandingProps) {
  const [view, go] = useView();
  const back = returnTo ?? currentPath() ?? "/";
  const path = displayAddress(back);
  const hostLabel = displayHost(host);
  // Without the deployment's provider list the door is its one `signInHref`,
  // which already carries the return address.
  const options: ReadonlyArray<SignInOption> = signInOptions?.length
    ? signInOptions
    : [{ id: "github", label: signInLabel?.trim() || DEFAULT_LABEL, name: "GitHub", hrefFor: () => signInHref }];
  const multiple = options.length > 1;
  const names = options.map((option) => option.name ?? option.label);

  const problems = (
    <>
      {message ? <p className="hcl-message">{message}</p> : null}
      <AuthNotice notice={authError ?? null} multiple={multiple} />
      {error ? (
        <div className="hcl-notice" role="alert">
          <p>{error}</p>
          {onRetry ? (
            <button type="button" className="hcl-button hcl-button--quiet" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  /* ── a room's address: sign in, straight back here ─────────────────────── */

  if (path) {
    return (
      <DoorShell theme={theme} labelledBy="hcl-head">
        <h1 id="hcl-head" className="hcl-head">Sign in to continue</h1>
        <p className="hcl-slip">
          {hostLabel ? <span className="hcl-slip-host">{hostLabel}</span> : null}
          <span className="hcl-slip-path">{path}</span>
        </p>
        {problems}
        <ProviderButtons options={options} returnTo={back} status={status} />
        <p className="hcl-fine">
          You come straight back to this address.{multiple ? <> {SAME_PROVIDER}</> : null}
        </p>
        {note ? <p className="hcl-fine">{note}</p> : null}
        <p className="hcl-switch">
          New to Scout Chat? <a href="/#sign-up">Create an account</a>
        </p>
      </DoorShell>
    );
  }

  // A refused sign-in or a reason to show belongs where the buttons are.
  const shown: View = view === "landing" && (authError || message || error) ? "sign-in" : view;

  /* ── sign up / sign in ──────────────────────────────────────────────────── */

  if (shown !== "landing") {
    const signingUp = shown === "sign-up";
    return (
      <DoorShell theme={theme} labelledBy="hcl-head">
        <a
          className="hcl-back"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            go("landing");
          }}
        >
          ← Scout Chat
        </a>
        {signingUp ? (
          <>
            <h1 id="hcl-head" className="hcl-head">Create your account</h1>
            <p className="hcl-sub">
              Sign up with {listOf(names)}. Next, you name your space — the address your team and
              your agents will share.
            </p>
          </>
        ) : (
          <>
            <h1 id="hcl-head" className="hcl-head">Welcome back</h1>
            <p className="hcl-sub">Sign in to open your spaces.</p>
          </>
        )}
        {problems}
        {/* The root door returns to the root, not to whatever a refused sign-in
            left in the query (`?auth_error=…`), or the notice would come back too. */}
        <ProviderButtons options={options} returnTo="/" status={status} />
        {signingUp ? (
          <ol className="hcl-next" aria-label="What happens next">
            <li><span>1</span>Choose a provider and approve Scout Chat.</li>
            <li><span>2</span>Name your space. It is created on the spot.</li>
            <li><span>3</span>Invite an agent or a teammate from any channel.</li>
          </ol>
        ) : multiple ? (
          <p className="hcl-fine">{SAME_PROVIDER}</p>
        ) : null}
        {note ? <p className="hcl-fine">{note}</p> : null}
        <p className="hcl-switch">
          {signingUp ? "Already have an account? " : "New to Scout Chat? "}
          <a
            href={signingUp ? "#sign-in" : "#sign-up"}
            onClick={(event) => {
              event.preventDefault();
              go(signingUp ? "sign-in" : "sign-up");
            }}
          >
            {signingUp ? "Sign in" : "Create an account"}
          </a>
        </p>
      </DoorShell>
    );
  }

  /* ── the landing ────────────────────────────────────────────────────────── */

  return (
    <HostedBrandLanding
      theme={theme}
      lede={lede}
      providerNames={names}
      onSignUp={() => go("sign-up")}
      onSignIn={() => go("sign-in")}
    />
  );
}

/** "GitHub, Google or X". */
function listOf(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
