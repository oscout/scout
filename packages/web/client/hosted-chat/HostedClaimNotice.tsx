/**
 * Why a name reserved on the door did not become a space.
 *
 * Shown once, over the signed-in surface, after the round trip through GitHub
 * ended in a refusal (the name was taken while they were away, or the Worker
 * refused it). It says what happened and where to go next, and it leaves when
 * dismissed; nothing in the surface depends on it.
 */

import { useState } from "react";

import "./hosted-chat-claim.css";

export function HostedClaimNotice({ message }: { message: string }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="hcc-notice" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
        Dismiss
      </button>
    </div>
  );
}
