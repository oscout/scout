import type { MessageMention } from "@openscout/protocol";
import type { CorrectChatMessage } from "./ChatMessageCorrectionControls.tsx";
import { captureChatReadingPosition, restoreChatReadingPosition, type ChatReadingPosition } from "./chat-reading-position.ts";
/**
 * The right panel: one panel, three contents, mutually exclusive.
 *
 * Thread, Members, and the member card that pushes onto Members with a back
 * affordance. Everything it shows about reachability comes from the roster's
 * reception reading — membership is a durable fact, reception is a live one,
 * and this panel is where the difference is visible.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ChannelInvitePublicView, ConversationDefinition } from "@openscout/protocol";

import type { ChannelMemberView, ChatMessage, TrackedRequest } from "./chat-api.ts";
import { useChatCapabilities } from "./chat-transport.tsx";
import { MemberAvatar } from "./ChatAvatar.tsx";
import { ChatMemberRemoval } from "./ChatMemberRemoval.tsx";
import { ChannelComposer } from "./ChannelComposer.tsx";
import { CopyAction, Field, ReceptionBlock, Turn } from "./ChatBits.tsx";

function ThreadReadMarker({ messageId, onRead }: { messageId: string; onRead: () => void }) {
  const marker = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onRead);
  callback.current = onRead;
  useEffect(() => {
    const node = marker.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    let acknowledged = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!visible || acknowledged || document.visibilityState !== "visible") return;
      timer = setTimeout(() => { acknowledged = true; callback.current(); }, 800);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      schedule();
    }, { root: node.closest(".chat-rpanel-body"), threshold: 1 });
    observer.observe(node);
    document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); observer.disconnect(); document.removeEventListener("visibilitychange", schedule); };
  }, [messageId]);
  return <div ref={marker} aria-hidden="true" style={{ height: 1 }} />;
}
import {
  canRevokeInvite,
  channelLabel,
  expiryLabel,
  inviteKindLabel,
  inviteKindOf,
  isAgentMember,
  isApiParticipant,
  maskedTokenHint,
  memberDisplayName,
  memberOrFallback,
  memberTrailingFact,
  relativeTime,
} from "./chat-space-model.ts";

export type PanelView =
  | { kind: "none" }
  | { kind: "thread"; rootMessageId: string }
  | { kind: "members" }
  | { kind: "member"; actorId: string }
  | { kind: "team" };

function shortId(value: string): string {
  return value.length > 12 ? `…${value.slice(-8)}` : value;
}

function MemberRow({
  member,
  viewerActorId,
  onOpen,
}: {
  member: ChannelMemberView;
  viewerActorId: string;
  onOpen: (actorId: string) => void;
}) {
  const fact = memberTrailingFact(member, viewerActorId);
  const stranded = member.reception.state === "disconnected"
    || member.reception.state === "unavailable";
  return (
    <button type="button" className="chat-member-row" onClick={() => onOpen(member.actorId)}>
      <MemberAvatar member={member} size={24} />
      <span className="chat-member-name">{memberDisplayName(member)}</span>
      {fact ? (
        <span className="chat-member-fact" data-stranded={stranded && fact !== "you"}>{fact}</span>
      ) : null}
    </button>
  );
}

function InviteRow({
  invite,
  nowMs,
  onRevoke,
  busy,
  canRevoke,
  prefix,
}: {
  invite: ChannelInvitePublicView;
  nowMs: number;
  onRevoke: (inviteId: string) => void;
  busy: boolean;
  canRevoke: boolean;
  /** Leading cell, where a caller needs one — the Team panel's channel tag. */
  prefix?: ReactNode;
}) {
  const kind = inviteKindOf(invite);
  const issuedFor = invite.invitee?.displayName?.trim();
  const expiry = expiryLabel(invite.expiresAt, nowMs);
  return (
    <div className="chat-invite-row">
      {prefix ?? null}
      {/* Only the non-secret hint, ever. The raw token exists in the copied
          artifact and nowhere else. */}
      <span className="chat-token-hint">{maskedTokenHint(invite.tokenHint)}</span>
      <span>
        {[
          inviteKindLabel(kind),
          issuedFor ? `for ${issuedFor}` : null,
          expiry,
        ].filter(Boolean).join(" · ")}
      </span>
      {/* Revoke is offered only where the server would honour it: the operator,
          or the member who issued this invitation. */}
      {canRevoke ? (
        <button
          type="button"
          className="chat-invite-revoke"
          disabled={busy}
          onClick={() => onRevoke(invite.id)}
        >
          Revoke
        </button>
      ) : invite.state === "active" ? (
        // Somebody else's live invitation: it is worth seeing, but there is no
        // action here for this viewer.
        <span />
      ) : (
        <span className="chat-invite-revoke" aria-hidden="false">{invite.state}</span>
      )}
    </div>
  );
}

export function ChatRightPanel({
  view,
  channel,
  members,
  membersById,
  invites,
  inviteError,
  revokingInviteId,
  viewerActorId,
  viewerIsOperator,
  nowMs,
  threadRoot,
  threadReplies,
  threadRequest,
  threadRequestsByMessage,
  threadDraft,
  threadMentions,
  threadAskTargetId,
  threadAttachmentScope,
  onThreadAskTargetChange,
  onThreadMentionsChange,
  onThreadDraftChange,
  onSendThreadReply,
  onReact,
  onCopyLink,
  savedMessageIds,
  onSave,
  pinnedMessageIds,
  onPin,
  onCorrect,
  onStopAsk,
  focusMessageId,
  threadSending,
  threadError,
  onLoadEarlier,
  loadingEarlier,
  earlierError,
  contextNotice,
  onRetryContext,
  onMarkThreadRead,
  onMarkChannelRead,
  onToggleFollow,
  following,
  followBusy,
  followError,
  onClose,
  onBack,
  onOpenMember,
  onMention,
  onRevokeInvite,
  onRemoveMember,
  onInvite,
  overlay,
}: {
  view: PanelView;
  channel: ConversationDefinition;
  members: ChannelMemberView[];
  membersById: Map<string, ChannelMemberView>;
  invites: ChannelInvitePublicView[];
  inviteError: string | null;
  revokingInviteId: string | null;
  viewerActorId: string;
  viewerIsOperator: boolean;
  nowMs: number;
  threadRoot: ChatMessage | null;
  threadReplies: ChatMessage[];
  threadRequest: TrackedRequest | null;
  threadRequestsByMessage: ReadonlyMap<string, TrackedRequest>;
  threadDraft: string;
  threadMentions?: MessageMention[];
  threadAskTargetId: string | null;
  threadAttachmentScope: string;
  onThreadAskTargetChange: (actorId: string | null) => void;
  onThreadMentionsChange?: (mentions: MessageMention[]) => void;
  onThreadDraftChange: (value: string) => void;
  onSendThreadReply: (files: File[]) => void | boolean | Promise<boolean | void>;
  onReact?: (messageId: string, emoji: string, remove: boolean) => void;
  onCopyLink?: (messageId: string) => void;
  savedMessageIds?: string[];
  onSave?: (messageId: string, saved: boolean) => void;
  pinnedMessageIds?: string[];
  onPin?: (messageId: string, pinned: boolean) => void;
  onCorrect?: CorrectChatMessage;
  onStopAsk?: (flightId: string) => void | Promise<void>;
  focusMessageId?: string | null;
  threadSending: boolean;
  threadError: string | null;
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  earlierError?: string;
  contextNotice?: string | null;
  onRetryContext?: () => void;
  onMarkThreadRead?: () => void;
  /** Marks the channel and its threads read. Lives here, not in the channel header. */
  onMarkChannelRead?: () => void;
  onToggleFollow?: () => void;
  following?: boolean;
  followBusy?: boolean;
  followError?: string | null;
  onClose: () => void;
  onBack: () => void;
  onOpenMember: (actorId: string) => void;
  onMention: (actorId: string) => void;
  onRevokeInvite: (inviteId: string) => void;
  onRemoveMember?: (actorId: string) => Promise<void>;
  onInvite: () => void;
  overlay: boolean;
}) {
  // Read before the early return: what this server can do is not conditional on
  // which panel happens to be open.
  const capabilities = useChatCapabilities();
  const threadBody = useRef<HTMLDivElement | null>(null);
  const beforePage = useRef<ChatReadingPosition | null>(null);
  useLayoutEffect(() => {
    if (loadingEarlier || !beforePage.current || !threadBody.current) return;
    restoreChatReadingPosition(threadBody.current, beforePage.current);
    beforePage.current = null;
  }, [loadingEarlier, threadReplies]);


  // The Team view is not one of this panel's three contents: the surface
  // renders TeamPanel for it, at space scope, with or without a channel.
  if (view.kind === "none" || view.kind === "team") return null;

  const scope = channelLabel(channel.title);

  if (view.kind === "thread") {
    return (
      <aside className="chat-rpanel" data-overlay={overlay} aria-label="Thread">
        <header className="chat-rpanel-head">
          <span className="chat-rpanel-title">Thread</span>
          <span className="chat-rpanel-scope">{scope}</span>
          {onToggleFollow ? <button type="button" className="btn btn--ghost btn--sm" disabled={followBusy} aria-pressed={following} onClick={onToggleFollow}>{following ? "Following" : "Follow"}</button> : null}
          {onMarkThreadRead ? <button type="button" className="btn btn--ghost btn--sm" onClick={onMarkThreadRead}>Mark read</button> : null}
          <button type="button" className="chat-rpanel-close" onClick={onClose} aria-label="Close panel">
            ×
          </button>
        </header>
        <div className="chat-rpanel-body" ref={threadBody}>
          {contextNotice ? <p className="chat-feed-notice" role="status">{contextNotice} {onRetryContext ? <button type="button" className="btn btn--sm" onClick={onRetryContext}>Retry</button> : null}</p> : null}
          {followError ? <p role="alert" className="chat-feed-notice">{followError}</p> : null}
          {threadRoot ? (
            <div className="chat-anchor-msg">
              <Turn
                message={threadRoot}
                members={membersById}
                nowMs={nowMs}
                request={threadRequest}
                withTargetOnChip={false}
                onReact={onReact}
                onCopyLink={onCopyLink}
                onSave={onSave}
                saveBusy={followBusy}
                saved={savedMessageIds?.includes(threadRoot.id)}
                pinned={pinnedMessageIds?.includes(threadRoot.id)}
                onPin={onPin}
                viewerActorId={viewerActorId}
                viewerIsOperator={viewerIsOperator}
                onCorrect={onCorrect}
                onStopAsk={onStopAsk}
                focused={focusMessageId === threadRoot.id}
              />
            </div>
          ) : !contextNotice ? (
            <p className="chat-feed-notice">This thread's anchor message is no longer available.</p>
          ) : null}
          {onLoadEarlier ? <div className="chat-thread-pagination">
            <button type="button" className="btn btn--sm" disabled={loadingEarlier} onClick={() => {
              if (threadBody.current) beforePage.current = { ...captureChatReadingPosition(threadBody.current), atLatest: false };
              onLoadEarlier();
            }}>{loadingEarlier ? "Loading earlier replies…" : "Load earlier replies"}</button>
            {earlierError ? <p role="alert" className="chat-feed-notice">{earlierError}</p> : null}
          </div> : null}
          {threadReplies.map((reply) => (
            <Turn
              key={reply.id}
              message={reply}
              request={threadRequestsByMessage.get(reply.id)}
              onStopAsk={onStopAsk}
              members={membersById}
              nowMs={nowMs}
              onReact={onReact}
              onCopyLink={onCopyLink}
              onSave={onSave}
              saveBusy={followBusy}
              saved={savedMessageIds?.includes(reply.id)}
              pinned={pinnedMessageIds?.includes(reply.id)}
              onPin={onPin}
                viewerActorId={viewerActorId}
                viewerIsOperator={viewerIsOperator}
                onCorrect={onCorrect}
              focused={focusMessageId === reply.id}
            />
          ))}
          {threadReplies.length === 0 && threadRoot ? (
            <p className="chat-feed-notice">No replies yet.</p>
          ) : null}
          {onMarkThreadRead && threadReplies.length > 0 ? <ThreadReadMarker messageId={threadReplies.at(-1)!.id} onRead={onMarkThreadRead} /> : null}
        </div>
          <div className="chat-thread-composer">
            <ChannelComposer
              attachmentScope={threadAttachmentScope}
              members={members}
              draft={threadDraft}
              mentions={threadMentions}
              onMentionsChange={onThreadMentionsChange}
              onDraftChange={onThreadDraftChange}
              askTargetId={threadAskTargetId}
              onAskTargetChange={onThreadAskTargetChange}
              onSend={onSendThreadReply}
              sending={threadSending}
              error={threadError}
              placeholder="Reply in thread…"
              variant="thread"
            />
          </div>
      </aside>
    );
  }

  if (view.kind === "member") {
    const member = memberOrFallback(membersById, view.actorId);
    const isAgent = isAgentMember(member);
    const owner = member.owner?.displayName?.trim() ?? null;
    const sessionId = member.reception.attachedSessionId;
    const isOwnAgent = isAgent && member.owner?.actorId === viewerActorId;
    return (
      <aside className="chat-rpanel" data-overlay={overlay} aria-label="Member">
        <header className="chat-rpanel-head">
          <button type="button" className="chat-rpanel-back" onClick={onBack} aria-label="Back to members">
            ‹
          </button>
          <span className="chat-rpanel-title">Member</span>
          <button type="button" className="chat-rpanel-close" onClick={onClose} aria-label="Close panel">
            ×
          </button>
        </header>
        <div className="chat-rpanel-body">
          <div className="chat-mcard-head">
            <MemberAvatar member={member} size={32} />
            <div>
              <div className="chat-mcard-name">{memberDisplayName(member)}</div>
              <div className="chat-mcard-sub">
                {[
                  isAgent ? "agent" : member.kind === "unknown" ? "former member" : "person",
                  isApiParticipant(member) ? "via API" : null,
                  owner ? `owned by ${owner}` : null,
                  member.actorId === viewerActorId ? "you" : null,
                ].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>

          {/* Only rows the server actually sent. A blank field would read as
              "none", which is a different claim from "not reported". */}
          {(member.harness || member.projectRoot || sessionId || member.nodeId) ? (
            <div className="chat-psec chat-kv">
              {member.harness ? (
                <Field label="Harness">
                  {[member.harness, member.model].filter(Boolean).join(" · ")}
                </Field>
              ) : null}
              {member.projectRoot ? <Field label="Project">{member.projectRoot}</Field> : null}
              {sessionId ? (
                <Field label="Session">
                  {shortId(sessionId)}
                  <CopyAction value={sessionId} label="copy" className="chat-copy-inline" copiedLabel="ok" />
                </Field>
              ) : null}
              {member.nodeId ? <Field label="Node">{member.nodeId}</Field> : null}
            </div>
          ) : null}

          {isAgent ? (
            <div className="chat-psec">
              <ReceptionBlock member={member} nowMs={nowMs} />
              {member.reception.redeemedAt ? (
                <span className="chat-conn-evidence">
                  {`joined ${relativeTime(member.reception.redeemedAt, nowMs)}`}
                </span>
              ) : null}
            </div>
          ) : null}

          {capabilities.memberRemove && viewerIsOperator && member.actorId !== viewerActorId && member.kind !== "unknown" && onRemoveMember ? (
            <ChatMemberRemoval key={`${channel.id}:${member.actorId}`} member={member} channelTitle={channel.title} onRemove={onRemoveMember} />
          ) : null}

          <div className="chat-psec" style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap" }}>
            <button type="button" className="btn btn--sm" onClick={() => onMention(member.actorId)}>
              Mention
            </button>
            {(!capabilities.invitesRequireOwner || viewerIsOperator) && (isOwnAgent || member.actorId === viewerActorId) ? (
              <button type="button" className="btn btn--sm" onClick={onInvite}>
                Copy agent invitation
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    );
  }

  const inChannel = [...members].sort((left, right) => {
    const leftAgent = Number(isAgentMember(left));
    const rightAgent = Number(isAgentMember(right));
    if (leftAgent !== rightAgent) return leftAgent - rightAgent;
    return memberDisplayName(left).localeCompare(memberDisplayName(right));
  });
  const outstanding = invites.filter((invite) => invite.state === "active");

  return (
    <aside className="chat-rpanel" data-overlay={overlay} aria-label="Members">
      <header className="chat-rpanel-head">
        <span className="chat-rpanel-title">Members</span>
        <span className="chat-rpanel-scope">{scope}</span>
        {onMarkChannelRead ? <button type="button" className="btn btn--ghost btn--sm" title="Mark the channel and its threads as read" onClick={onMarkChannelRead}>Mark read</button> : null}
        <button type="button" className="chat-rpanel-close" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>
      <div className="chat-rpanel-body">
        <div className="chat-psec">
          <span className="label-sm">In this channel</span>
          {inChannel.length === 0 ? (
            <p className="chat-feed-notice">The roster is empty.</p>
          ) : (
            inChannel.map((member) => (
              <MemberRow
                key={member.actorId}
                member={member}
                viewerActorId={viewerActorId}
                onOpen={onOpenMember}
              />
            ))
          )}
        </div>

        <div className="chat-psec">
          <span className="label-sm">Invited</span>
          {inviteError ? <p className="chat-sheet-error" role="alert">{inviteError}</p> : null}
          {/* "Not listed here" and "none outstanding" are different claims, and
              only one of them is true on a server with no listing endpoint. */}
          {!capabilities.inviteList ? (
            <p className="chat-feed-notice">
              This server does not list outstanding invitations. A link is shown once,
              when you create it.
            </p>
          ) : outstanding.length === 0 && !inviteError ? (
            <p className="chat-feed-notice">No outstanding invitations.</p>
          ) : (
            outstanding.map((invite) => (
              <InviteRow
                key={invite.id}
                invite={invite}
                nowMs={nowMs}
                onRevoke={onRevokeInvite}
                busy={Boolean(revokingInviteId)}
                canRevoke={capabilities.inviteRevoke && canRevokeInvite(invite, {
                  actorId: viewerActorId,
                  isOperator: viewerIsOperator,
                })}
              />
            ))
          )}
          <div style={{ marginTop: "var(--space-sm)" }}>
            {!capabilities.invitesRequireOwner || viewerIsOperator ? <button type="button" className="btn btn--sm" onClick={onInvite}>Invite</button> : null}
          </div>
        </div>
      </div>
    </aside>
  );
}

export { InviteRow, MemberRow };
