import { useState } from "react";
import { ChatApiError, type ChannelMemberView } from "./chat-api.ts";
import { channelLabel, memberDisplayName } from "./chat-space-model.ts";

/** Explicit channel-scoped removal; a failed request leaves the person visible. */
export function ChatMemberRemoval({ member, channelTitle, onRemove }: {
  member: ChannelMemberView;
  channelTitle: string;
  onRemove: (actorId: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onRemove(member.actorId);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof ChatApiError && (cause.status === 0 || cause.status >= 500)
        ? "Could not confirm the removal. Check your connection and try again."
        : cause instanceof Error ? cause.message : "Could not remove this member. Try again.");
    } finally {
      setPending(false);
    }
  };
  return <section className="chat-psec" aria-label="Channel membership">
    {confirming ? <>
      <p>Remove <strong>{memberDisplayName(member)}</strong> from <strong>{channelLabel(channelTitle)}</strong>?</p>
      <p className="chat-feed-notice">They will lose access to this channel. Their existing messages stay in the conversation. Other channels are unaffected.</p>
      {error ? <p className="chat-feed-notice" data-tone="error" role="alert">{error}</p> : null}
      <div style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap" }}>
        <button className="btn btn--sm" disabled={pending} onClick={() => void remove()}>{pending ? "Removing…" : "Remove member"}</button>
        <button className="btn btn--sm" disabled={pending} onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
      </div>
    </> : <button className="btn btn--sm" onClick={() => setConfirming(true)}>Remove from channel</button>}
  </section>;
}
