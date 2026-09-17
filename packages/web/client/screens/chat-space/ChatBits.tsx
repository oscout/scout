/**
 * The small shared parts of the chat surface: copy affordances, the turn, the
 * tracked-ask card, and the connection block.
 *
 * They live together because they are the pieces that must say the same thing
 * in the feed, the thread panel, and the member card. A rule enforced in one
 * place and re-implemented in another is a rule that drifts.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import type { MessageRecord } from "@openscout/protocol";

import type { ChannelMemberView, TrackedRequest } from "./chat-api.ts";
import { MemberAvatar } from "./ChatAvatar.tsx";
import {
  askChip,
  bodySegments,
  clockTime,
  memberDisplayName,
  memberOrFallback,
  memberReceptionView,
  relativeTime,
  threadStubLabel,
} from "./chat-space-model.ts";

/** Copy, then say so for 1.5s. The existing pattern; no toast system exists. */
export function CopyAction({
  value,
  label,
  className = "btn btn--sm",
  copiedLabel = "Copied",
  onCopyFailed,
}: {
  value: string;
  label: string;
  className?: string;
  copiedLabel?: string;
  onCopyFailed?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onClick = useCallback(() => {
    const done = (ok: boolean) => {
      setCopied(ok);
      setFailed(!ok);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
        setFailed(false);
      }, 1500);
    };
    void copyTextToClipboard(value).then((ok) => {
      done(ok);
      if (!ok) onCopyFailed?.();
    }).catch(() => { done(false); onCopyFailed?.(); });
  }, [value, onCopyFailed]);

  return (
    <button type="button" className={className} onClick={onClick} aria-live="polite">
      {failed ? "Copy failed — select the text" : copied ? copiedLabel : label}
    </button>
  );
}

export function TrackedAskCard({
  request,
  target,
  withTarget,
}: {
  request: TrackedRequest;
  target: ChannelMemberView | null;
  withTarget: boolean;
}) {
  const chip = askChip(
    request,
    target ? { label: memberDisplayName(target), reception: target.reception } : null,
  );
  return (
    <div className="chat-ask-card" data-tone={chip.tone}>
      <span className="label-sm">Tracked request</span>
      <span
        className="chip chip--sm chip--mono chip--ghost chat-ask-chip"
        data-tone={chip.tone}
        aria-label={chip.ariaLabel}
      >
        {withTarget ? chip.textWithTarget : chip.text}
      </span>
    </div>
  );
}

export function MessageBody({
  message,
  fallbackLabels,
}: {
  message: MessageRecord;
  fallbackLabels?: string[];
}) {
  const segments = bodySegments(message, fallbackLabels ?? []);
  return (
    <div className="chat-turn-body">
      {segments.map((segment, index) =>
        segment.kind === "mention"
          ? <span className="chat-mention" key={index}>{segment.text}</span>
          : <span key={index}>{segment.text}</span>,
      )}
    </div>
  );
}

/**
 * One avatar-led turn. Flat by design: the card is reserved for the tracked
 * ask, and there are no delivery ticks anywhere on a message.
 */
export function Turn({
  message,
  members,
  nowMs,
  request,
  replyCount,
  lastReplyAt,
  onOpenThread,
  onOpenMember,
  withTargetOnChip = true,
}: {
  message: MessageRecord;
  members: Map<string, ChannelMemberView>;
  nowMs: number;
  request?: TrackedRequest | null;
  replyCount?: number;
  lastReplyAt?: number | null;
  onOpenThread?: () => void;
  onOpenMember?: (actorId: string) => void;
  withTargetOnChip?: boolean;
}) {
  const author = memberOrFallback(members, message.actorId);
  const target = request ? members.get(request.targetActorId) ?? null : null;
  const name = memberDisplayName(author);
  return (
    <article className="chat-turn">
      {onOpenMember ? (
        <button
          type="button"
          onClick={() => onOpenMember(author.actorId)}
          aria-label={`Open ${name}'s member card`}
        >
          <MemberAvatar member={author} size={32} />
        </button>
      ) : (
        <MemberAvatar member={author} size={32} />
      )}
      <div>
        <div className="chat-turn-meta">
          <span className="chat-who">{name}</span>
          <time className="chat-when" dateTime={new Date(message.createdAt).toISOString()}>
            {clockTime(message.createdAt)}
          </time>
        </div>
        <MessageBody message={message} />
        {request ? (
          <TrackedAskCard request={request} target={target} withTarget={withTargetOnChip} />
        ) : null}
        {onOpenThread ? (
          // Every root can start a thread, not only one that already has
          // replies — an ordinary message and a pending ask are exactly where a
          // follow-up belongs. With no replies yet the affordance is quiet
          // until the turn is hovered or focused (see chat-space.css).
          <button
            type="button"
            className="chat-thread-stub"
            data-empty={replyCount && replyCount > 0 ? undefined : "true"}
            onClick={onOpenThread}
            aria-label={
              replyCount && replyCount > 0
                ? `Open thread, ${threadStubLabel(replyCount, lastReplyAt ?? null, nowMs)}`
                : `Reply in thread to ${name}`
            }
          >
            {replyCount && replyCount > 0
              ? `⌵ ${threadStubLabel(replyCount, lastReplyAt ?? null, nowMs)}`
              : "⌵ Reply in thread"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The connection plane, rendered from the protocol's own words.
 *
 * `summary` and `detail` come off the wire; the dot appears only when a live
 * process is attached, and a wake-on-delivery route says so in a sentence
 * rather than being demoted to a colour. An API participant renders its
 * declared mode instead — its endpoint-derived reading describes a session
 * this membership can never have.
 */
export function ReceptionBlock({
  member,
  nowMs,
}: {
  member: ChannelMemberView;
  nowMs: number;
}) {
  const view = memberReceptionView(member, nowMs);
  if (!view) return null;
  return (
    <div className="chat-conn" aria-label={view.ariaLabel}>
      <span className="chat-conn-state">
        {view.showDot ? <span className="dot dot--neutral" aria-hidden="true" /> : null}
        {view.summary}
      </span>
      <span className="chat-conn-detail">{view.detail}</span>
      {view.routeNote ? <span className="chat-conn-detail">{view.routeNote}</span> : null}
      {view.evidence ? <span className="chat-conn-evidence">{view.evidence}</span> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="chat-k">{label}</span>
      <span className="chat-v">{children}</span>
    </>
  );
}

export function TimeAgo({ at, nowMs }: { at: number; nowMs: number }) {
  return (
    <time className="chat-when" dateTime={new Date(at).toISOString()}>
      {relativeTime(at, nowMs)}
    </time>
  );
}
