import { useEffect, useState } from "react";
import { ChatApiError } from "../screens/chat-space/chat-api.ts";
import type { HostedInvitationApi, HostedInvitationPreview, HostedSession } from "./hosted-chat-api.ts";
import { DoorShell, ProviderButtons, type SignInOption } from "./HostedDoor.tsx";

const GITHUB_ONLY: ReadonlyArray<SignInOption> = [{
  id: "github",
  label: "Continue with GitHub",
  name: "GitHub",
  hrefFor: (returnTo) => `/auth/github/start?return_to=${encodeURIComponent(returnTo)}`,
}];

type Loaded = { preview: HostedInvitationPreview; session: HostedSession };
const explanation = (error: unknown) => error instanceof ChatApiError && error.status !== 0
  ? error.message : "Could not reach Scout Chat. Check your connection and try again.";

/**
 * A teammate invitation, in the door's shell. Joining is an explicit
 * mutation: reading or sharing this page never consumes the link.
 */
export function HostedChatJoin({ token, api, signInOptions }: {
  token: string;
  api: HostedInvitationApi;
  /** The deployment's providers; the invitation returns here after sign-in. Defaults to GitHub. */
  signInOptions?: ReadonlyArray<SignInOption>;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [joining, setJoining] = useState(false);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    setError(null);
    void Promise.all([api.previewHumanInvitation(token), api.invitationSession()]).then(([preview, session]) => {
      if (active) setLoaded({ preview, session });
    }).catch(error => { if (active) setError(explanation(error)); });
    return () => { active = false; };
  }, [api, token, attempt]);

  const join = async () => {
    if (joining) return;
    setJoining(true);
    setError(null);
    try {
      const result = await api.acceptHumanInvitation(token);
      window.location.assign(`/${encodeURIComponent(result.space.slug)}?channel=${encodeURIComponent(result.conversationId)}`);
    } catch (error) {
      setError(explanation(error));
      if (error instanceof ChatApiError && error.status === 401) {
        setLoaded(current => current ? { ...current, session: { authenticated: false } } : current);
      }
      setJoining(false);
    }
  };
  const preview = loaded?.preview;
  const session = loaded?.session;
  const account = session?.authenticated ? session.account ?? null : null;

  return (
    <DoorShell
      labelledBy="hcl-head"
      aside={account ? <span className="hcl-account">{account.displayName}</span> : null}
    >
      <p className="hcl-eyebrow">Invitation</p>
      <h1 id="hcl-head" className="hcl-head">{preview ? `Join #${preview.channelTitle}` : "Your invitation"}</h1>
      {preview ? <p className="hcl-slip"><span className="hcl-slip-path">{preview.space.title}</span></p> : null}
      <div aria-busy={!loaded && !error}>
        {!loaded && !error ? <p className="hcl-sub" role="status">Opening your invitation…</p> : null}
        {error ? <div className="hcl-notice" role="alert"><p>{error}</p></div> : null}
        {!loaded && error ? (
          <button type="button" className="hcl-button hcl-button--quiet" onClick={() => setAttempt(value => value + 1)}>
            Try again
          </button>
        ) : null}
      </div>
      {preview?.kind === "api" ? <>
        <p className="hcl-sub">
          This invitation is for an agent that joins over HTTP. Ask the space owner for a teammate
          invitation to join as yourself.
        </p>
        <a className="hcl-button hcl-button--quiet" href={`/invite/${token}/agent.md`}>View agent instructions</a>
      </> : preview ? <>
        <p className="hcl-sub">Read the conversation, post messages and reply in threads. This invitation opens this one channel.</p>
        {account ? <>
          <button type="button" className="hcl-button" disabled={joining} onClick={() => void join()}>
            {joining ? "Opening channel…" : preview.alreadyMember ? "Open channel" : "Join channel"}
          </button>
          <p className="hcl-fine">Joining as <b>{account.displayName}</b>.</p>
        </> : <>
          <ProviderButtons options={signInOptions?.length ? signInOptions : GITHUB_ONLY} returnTo={`/join/${token}`} />
          <p className="hcl-fine">Sign in, then choose to join. Your account name identifies you in the conversation.</p>
        </>}
        {!preview.alreadyMember
          ? <p className="hcl-fine">For one person · Expires {new Date(preview.expiresAt).toLocaleString()}</p>
          : null}
      </> : null}
    </DoorShell>
  );
}
