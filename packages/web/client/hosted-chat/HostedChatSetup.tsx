/**
 * Hosted Scout Chat — naming the first space.
 *
 * The signed-out door no longer asks for a name (`HostedChatLanding.tsx`): a
 * new account signs in first and lands here, where the name is the one field
 * and the space is created at exactly that address. Same shell, same panel,
 * one ink button. `hosted-chat-claim.ts` refuses what the Worker would refuse
 * anyway, so the page can say so before the round trip; the Worker's
 * directory is still the only authority on whether a name is free.
 */

import { useRef, useState, type FormEvent } from "react";

import { ChatApiError } from "../screens/chat-space/chat-api.ts";
import { CLAIM_REFUSALS, checkSpaceName, foldSpaceName } from "./hosted-chat-claim.ts";
import { DoorShell } from "./HostedDoor.tsx";

export interface HostedChatSetupProps {
  /** Who is signed in, printed in the bar so the account is never a guess. */
  displayName: string | null;
  /** Creates the space; resolves with the slug it was created at. */
  createSpace: (slug: string) => Promise<string>;
  /** Ends the session — the way out for someone signed in with the wrong provider. */
  signOut: () => Promise<unknown>;
}

function displayHost(): string {
  return typeof window === "undefined" ? "" : window.location.host;
}

export function HostedChatSetup({ displayName, createSpace, signOut }: HostedChatSetupProps) {
  const [value, setValue] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const host = displayHost();
  const folded = foldSpaceName(value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const check = checkSpaceName(value);
    if (!check.ok) {
      setRefusal(CLAIM_REFUSALS[check.reason]);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const slug = await createSpace(check.slug);
      window.location.replace(`/${slug}`);
    } catch (error) {
      setBusy(false);
      setRefusal(
        error instanceof ChatApiError && error.reason === "slug_unavailable"
          ? `${host}/${check.slug} is taken. Choose another name.`
          : error instanceof Error ? error.message : "The space could not be created. Try again.",
      );
      field.current?.focus();
    }
  };

  const aside = (
    <>
      {displayName ? <span className="hcl-account">{displayName}</span> : null}
      <button
        type="button"
        className="hcl-bar-link"
        onClick={() => { void signOut().finally(() => window.location.replace("/")); }}
      >
        Sign out
      </button>
    </>
  );

  return (
    <DoorShell aside={aside} labelledBy="hcl-head">
      <h1 id="hcl-head" className="hcl-head">Name your space</h1>
      <p className="hcl-sub">
        This is the address you, your team and your agents will share. Channels and invitations
        live inside it.
      </p>

      <form className="hcl-form" noValidate onSubmit={(event) => void submit(event)}>
        <label className="hcl-field" data-invalid={refusal ? "true" : undefined}>
          <span className="hcl-field-host">{host}/</span>
          <input
            ref={field}
            className="hcl-field-input"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setRefusal(null);
            }}
            placeholder="your-team"
            aria-label={host ? `Space name, at ${host}/` : "Space name"}
            aria-describedby="hcl-field-help"
            aria-invalid={refusal ? true : undefined}
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="go"
            spellCheck={false}
            maxLength={48}
            disabled={busy}
          />
        </label>
        {/* One region, always present, always polite: swapping `role` onto a
            node that is already there is not reliably announced. */}
        <p className="hcl-help" id="hcl-field-help" aria-live="polite" data-invalid={refusal ? "true" : undefined}>
          {refusal
            ?? (folded && folded !== value.trim()
              ? <>Created as <b>{folded}</b>.</>
              : "Letters, numbers and hyphens.")}
        </p>
        <button type="submit" className="hcl-button" disabled={busy}>
          {busy ? "Creating…" : "Create space"}
        </button>
      </form>
    </DoorShell>
  );
}
