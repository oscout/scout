import { ChatStopControl } from "./ChatExecutionControls.tsx";
import { ChatApprovalPrompts, useChatApprovals } from "./ChatApprovalControls.tsx";
import { ChatQuestionControls } from "./ChatQuestionControls.tsx";
import { readChatMessageCorrection } from "@openscout/protocol";
import { ChatMessageCorrectionControls, type CorrectChatMessage } from "./ChatMessageCorrectionControls.tsx";
/**
 * The small shared parts of the chat surface: copy affordances, the turn, the
 * tracked-ask card, and the connection block.
 *
 * They live together because they are the pieces that must say the same thing
 * in the feed, the thread panel, and the member card. A rule enforced in one
 * place and re-implemented in another is a rule that drifts.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bookmark, MessageSquare, Pin } from "lucide-react";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import {
  REACTION_EMOJI_MORE,
  REACTION_EMOJI_QUICK,
  type MessageAttachment,
} from "@openscout/protocol";
import { sameOriginBlobUrl } from "../../components/MessageEmbeds.tsx";

import {
  CHAT_LINK_PREVIEW_PATH,
  ChatApiError,
  type ChannelMemberView,
  type ChatMessage,
  type TrackedRequest,
} from "./chat-api.ts";
import { ChatMessageMarkup } from "./chat-message-markup.tsx";
import { useChatCapabilities } from "./chat-transport.tsx";
import { MemberAvatar } from "./ChatAvatar.tsx";
import {
  askChip,
  askHeadline,
  clockTime,
  memberDisplayName,
  memberOrFallback,
  reactionReactorNames,
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
  onStop,
}: {
  request: TrackedRequest;
  target: ChannelMemberView | null;
  withTarget: boolean;
  onStop?: (flightId: string) => void | Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const stop = async () => {
    if (!onStop || inFlight.current) return;
    inFlight.current = true;
    setStopping(true);
    setStopError(null);
    try { await onStop(request.flightId); }
    catch (error) {
      setStopError(error instanceof ChatApiError && error.status > 0 && error.status < 500
        ? error.message : "Could not confirm cancellation. Check your connection and try again.");
    } finally { inFlight.current = false; setStopping(false); }
  };
  const chip = askChip(
    request,
    target ? { label: memberDisplayName(target), reception: target.reception } : null,
  );
  const agentLabel = target ? memberDisplayName(target) : request.targetName ?? request.targetActorId;
  const active = ["running", "waiting", "blocked", "needs_input"].includes(chip.state);
  const approvals = useChatApprovals(request.flightId, active);
  const responsibility = request.responsibility;
  const headline = askHeadline({
    state: request.state,
    agent: withTarget ? agentLabel : null,
    responsibility,
    approvalsForYou: active ? approvals.pending.length : 0,
  });
  const failed = chip.tone === "failed";
  return (
    <div
      className="chat-ask-card"
      data-tone={chip.tone}
      data-needs-you={headline.needsYou || undefined}
      role="group"
      aria-label={chip.ariaLabel}
    >
      <p className="chat-ask-headline">{headline.text}</p>
      {request.summary ? <p className="chat-ask-summary">{request.summary}</p> : null}

      {active ? <ChatApprovalPrompts approvals={approvals} /> : null}

      {responsibility ? <div className="chat-ask-slot">
        <p className="chat-ask-slot-label">
          {responsibility.kind === "question" ? "Question" : "Work"}{responsibility.settled ? ` · ${responsibility.state}` : ""}
        </p>
        <p className="chat-ask-quote">{responsibility.title}</p>
        {responsibility.answer ? <>
          <p className="chat-ask-slot-label">Answer</p>
          <pre className="chat-ask-answer">{responsibility.answer}</pre>
        </> : null}
        <ChatQuestionControls question={responsibility} />
      </div> : chip.state === "waiting" && !approvals.pending.length ? (
        <p className="chat-ask-trail">The next actor is not available in this view.</p>
      ) : null}

      {failed && request.error ? <div className="chat-ask-error" role="alert">
        <p className="chat-ask-error-label">Error</p>
        <pre>{request.error}</pre>
      </div> : null}

      {request.output ? <details className="chat-ask-outcome" open={chip.state === "completed" || undefined}>
        <summary>{chip.state === "completed" ? "Recorded outcome" : "Recorded output"}{request.outputTruncated ? " (preview)" : ""}</summary>
        <pre>{request.output}</pre>
        {request.outputTruncated ? <p>
          Preview limited to 4,000 characters. {request.outputUrl?.startsWith("/api/channels/") && !request.outputUrl.includes("\\")
            ? <a href={request.outputUrl} target="_blank" rel="noopener noreferrer">Read full outcome</a> : null}
        </p> : null}
      </details> : null}
      {chip.state === "completed" && !request.output && !request.summary ? <p className="chat-ask-trail">Completed without a recorded outcome.</p> : null}

      {chip.state === "running" ? <ChatStopControl flightId={request.flightId} /> : null}
      {chip.canStop && stopError ? <p className="chat-ask-trail" role="alert">{stopError}</p> : null}
      {chip.canStop && onStop ? (
        <button
          type="button"
          className="chat-ask-stop"
          disabled={stopping}
          onClick={() => void stop()}
        >
          {stopping ? "Cancelling…" : stopError ? "Retry cancellation" : "Cancel request"}
        </button>
      ) : null}

      <details className="chat-ask-more">
        <summary>Details</summary>
        <dl>
          <dt>Agent</dt><dd>{agentLabel}</dd>
          <dt>State</dt><dd>{chip.state}</dd>
          {request.requesterActorId ? <><dt>Requested by</dt><dd>{request.requesterName || request.requesterActorId}</dd></> : null}
          {request.startedAt != null ? <><dt>Started</dt><dd><time dateTime={new Date(request.startedAt).toISOString()}>{new Date(request.startedAt).toLocaleString()}</time></dd></> : null}
          {request.completedAt != null ? <><dt>Finished</dt><dd><time dateTime={new Date(request.completedAt).toISOString()}>{new Date(request.completedAt).toLocaleString()}</time></dd></> : null}
          {!failed && request.error ? <><dt>Error</dt><dd>{request.error}</dd></> : null}
        </dl>
      </details>
    </div>
  );
}

const BODY_URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/giu;

function extractBodyUrls(body: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of body.matchAll(BODY_URL_PATTERN)) {
    const cleaned = match[0]?.replace(/[.,;:!?)]+$/u, "") ?? "";
    if (!cleaned.startsWith("http") || cleaned.includes("/api/blobs/") || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
    if (urls.length >= 3) break;
  }
  return urls;
}

export function MessageBody({
  message,
  fallbackLabels,
}: {
  message: ChatMessage;
  fallbackLabels?: string[];
}) {
  const urls = extractBodyUrls(message.body);
  return (
    <>
      <div className="chat-turn-body">
        <ChatMessageMarkup message={message} fallbackLabels={fallbackLabels} />
      </div>
      {urls.map((url) => <ChatLinkCard key={url} url={url} />)}
    </>
  );
}

type LinkPreviewPayload = {
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
};

const linkPreviewCache = new Map<string, LinkPreviewPayload | null>();
const linkPreviewInflight = new Map<string, Promise<LinkPreviewPayload | null>>();

function loadLinkPreview(url: string): Promise<LinkPreviewPayload | null> {
  if (linkPreviewCache.has(url)) return Promise.resolve(linkPreviewCache.get(url) ?? null);
  const pending = linkPreviewInflight.get(url);
  if (pending) return pending;
  const request = fetch(`${CHAT_LINK_PREVIEW_PATH}?url=${encodeURIComponent(url)}`, { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = await response.json() as { preview?: LinkPreviewPayload };
      return payload.preview ?? null;
    })
    .catch(() => null)
    .then((preview) => {
      linkPreviewCache.set(url, preview);
      linkPreviewInflight.delete(url);
      return preview;
    });
  linkPreviewInflight.set(url, request);
  return request;
}

function ChatLinkCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreviewPayload | null>(() => linkPreviewCache.get(url) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    void loadLinkPreview(url).then((next) => {
      if (!cancelled) setPreview(next);
    });
    return () => { cancelled = true; };
  }, [preview, url]);
  if (!preview) return null;
  return (
    <a className="chat-link-card" href={preview.url} target="_blank" rel="noreferrer">
      {preview.imageUrl && !failed ? (
        <img
          className="chat-link-card-image"
          src={preview.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : null}
      <span className="chat-link-card-copy">
        {preview.siteName ? <span className="chat-link-card-site">{preview.siteName}</span> : null}
        <span className="chat-link-card-title">{preview.title}</span>
        {preview.description ? <span className="chat-link-card-desc">{preview.description}</span> : null}
      </span>
    </a>
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
  onReact,
  onCopyLink,
  saved,
  saveBusy,
  onSave,
  pinned,
  onPin,
  viewerActorId,
  viewerIsOperator,
  onCorrect,
  onStopAsk,
  focused = false,
  continues = false,
  withTargetOnChip = true,
}: {
  message: ChatMessage;
  members: Map<string, ChannelMemberView>;
  nowMs: number;
  request?: TrackedRequest | null;
  replyCount?: number;
  lastReplyAt?: number | null;
  onOpenThread?: () => void;
  onOpenMember?: (actorId: string) => void;
  onReact?: (messageId: string, emoji: string, remove: boolean) => void;
  onCopyLink?: (messageId: string) => void;
  saved?: boolean;
  saveBusy?: boolean;
  onSave?: (messageId: string, saved: boolean) => void;
  pinned?: boolean;
  onPin?: (messageId: string, pinned: boolean) => void;
  viewerActorId?: string;
  viewerIsOperator?: boolean;
  onCorrect?: CorrectChatMessage;
  onStopAsk?: (flightId: string) => void | Promise<void>;
  focused?: boolean;
  /**
   * Same author, moments after the turn above. The header is already on
   * screen, so this one shows only its body — with the clock moved into the
   * avatar gutter, where it stays reachable without repeating a name.
   */
  continues?: boolean;
  withTargetOnChip?: boolean;
}) {
  const capabilities = useChatCapabilities();
  const correction = readChatMessageCorrection(message.metadata);
  const deleted = correction?.deletedAt != null;
  const authored = message.actorId === viewerActorId || (viewerIsOperator === true && message.actorId === "owner");
  const [pickerPinned, setPickerPinned] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const author = memberOrFallback(members, message.actorId, message.actorName);
  const target = request ? members.get(request.targetActorId) ?? null : null;
  const name = memberDisplayName(author);
  const canReact = !deleted && capabilities.reactions && Boolean(onReact);

  const clearPress = () => {
    if (press.current) {
      window.clearTimeout(press.current.timer);
      press.current = null;
    }
  };

  // The same stamp serves both shapes: beside the name when the block opens,
  // in the gutter where the avatar would be when it continues. A continued
  // turn never loses its clock, it only stops shouting it.
  const clock = (
    <time className="chat-when" dateTime={new Date(message.createdAt).toISOString()}>
      {clockTime(message.createdAt)}
    </time>
  );
  const stamp = onCopyLink
    ? (
      <button
        type="button"
        className="chat-when-link"
        title="Copy link to this message"
        aria-label={`Copy link to this message, sent ${clockTime(message.createdAt)}`}
        onClick={() => onCopyLink(message.id)}
      >
        {clock}
      </button>
    )
    : clock;
  const picker = canReact
    ? (
      <ReactionPicker
        message={message}
        onReact={onReact!}
        pinned={pickerPinned}
        onDismiss={() => setPickerPinned(false)}
      />
    )
    : null;

  // Everything you can do to a message, in one floating strip that appears on
  // hover, keyboard focus or a long press. It used to be a row of words under
  // every message, which made a quiet feed read like a form.
  const toolButtons = [
    onOpenThread ? (
      <button key="reply" type="button" className="chat-turn-tool" onClick={onOpenThread}
        aria-label={`Reply in thread to ${name}`} title="Reply in thread">
        <MessageSquare size={15} strokeWidth={1.8} aria-hidden />
      </button>
    ) : null,
    onSave && (!deleted || saved) ? (
      <button key="save" type="button" className="chat-turn-tool" aria-pressed={saved === true}
        disabled={saveBusy} onClick={() => onSave(message.id, !saved)}
        aria-label={saved ? "Remove from saved messages" : "Save message privately"}
        title={saved ? "Saved — remove" : "Save for later"}>
        <Bookmark size={15} strokeWidth={1.8} aria-hidden />
      </button>
    ) : null,
    onPin && (!deleted || pinned) ? (
      <button key="pin" type="button" className="chat-turn-tool" aria-pressed={pinned === true}
        disabled={saveBusy} onClick={() => onPin(message.id, !pinned)}
        aria-label={pinned ? "Unpin from channel" : "Pin for everyone in channel"}
        title={pinned ? "Pinned — unpin" : "Pin to channel"}>
        <Pin size={15} strokeWidth={1.8} aria-hidden />
      </button>
    ) : null,
  ].filter(Boolean);
  const tools = picker || toolButtons.length ? <>{picker}{toolButtons}</> : null;

  return (
    <article
      className="chat-turn"
      data-message-id={message.id}
      data-continues={continues ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      data-reacting={pickerPinned ? "true" : undefined}
      onPointerDown={(event) => {
        if (!canReact) return;
        if (event.pointerType === "mouse") return;
        if ((event.target as HTMLElement | null)?.closest("button")) return;
        clearPress();
        const x = event.clientX;
        const y = event.clientY;
        press.current = {
          x,
          y,
          timer: window.setTimeout(() => {
            press.current = null;
            setPickerPinned(true);
          }, 450),
        };
      }}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerMove={(event) => {
        if (!press.current) return;
        const dx = event.clientX - press.current.x;
        const dy = event.clientY - press.current.y;
        if (dx * dx + dy * dy > 64) clearPress();
      }}
      onContextMenu={(event) => {
        if (canReact && pickerPinned) event.preventDefault();
      }}
    >
      {continues ? (
        <span className="chat-turn-gutter">{stamp}</span>
      ) : onOpenMember ? (
        <button
          type="button"
          onClick={() => onOpenMember(author.actorId)}
          aria-label={`Open ${name}'s member card`}
        >
          <MemberAvatar member={author} size={36} />
        </button>
      ) : (
        <MemberAvatar member={author} size={36} />
      )}
      <div>
        {continues ? null : (
          <div className="chat-turn-meta">
            <span className="chat-who">{name}</span>
            {stamp}
            {pinned ? <span className="chat-turn-mark">Pinned</span> : null}
            {saved ? <span className="chat-turn-mark">Saved</span> : null}
          </div>
        )}
        {!deleted && viewerActorId && message.mentions?.some(mention => mention.actorId === viewerActorId) ? <span className="chat-message-mention">Mentions you</span> : null}
        {deleted ? <p className="chat-message-deleted">Message deleted</p> : <MessageBody message={message} />}
        {!deleted && correction?.editedAt != null ? <span className="chat-message-edited" title={new Date(correction.editedAt).toLocaleString()}>Edited</span> : null}
        {onCorrect
          ? <ChatMessageCorrectionControls key={`${viewerActorId}:${message.id}`} message={message} canEdit={authored} canDelete={authored || viewerIsOperator === true} onCorrect={onCorrect} tools={tools} />
          : tools ? <div className="chat-turn-tools" role="toolbar" aria-label="Message actions">{tools}</div> : null}
        <ChatAttachments attachments={deleted ? [] : message.attachments ?? []} />
        {request ? (
          <TrackedAskCard
            request={request}
            target={target}
            withTarget={withTargetOnChip}
            onStop={onStopAsk}
          />
        ) : null}
        {capabilities.reactions && !deleted ? (
          <ReactionChips message={message} members={members} viewerActorId={viewerActorId} onReact={canReact ? onReact : undefined} />
        ) : null}
        {onOpenThread && replyCount && replyCount > 0 ? (
          // A thread that exists is part of the conversation and stays on the
          // page. Starting one is an action, so it lives in the hover toolbar
          // and costs the feed no reserved row under every message.
          <button
            type="button"
            className="chat-thread-stub"
            onClick={onOpenThread}
            aria-label={`Open thread, ${threadStubLabel(replyCount, lastReplyAt ?? null, nowMs)}`}
          >
            {`⌵ ${threadStubLabel(replyCount, lastReplyAt ?? null, nowMs)}`}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * An image's real shape is not known until its bytes arrive, and a guessed
 * `width`/`height` pair reserves the wrong box and then jumps to the right one.
 * Remember the ratio the browser reports the first time, keyed by URL: the same
 * capture shown again — a poll re-render, the thread panel, a scroll back —
 * reserves its true shape with no extra request. Until then the stylesheet
 * supplies a neutral band, and nothing is ever fetched to learn a size.
 */
const knownImageRatios = new Map<string, number>();

function ChatImageAttachment({ href, name }: { href: string; name: string }) {
  const [ratio, setRatio] = useState(() => knownImageRatios.get(href) ?? null);
  return (
    <a className="chat-attach-image" href={href} target="_blank" rel="noreferrer">
      <img
        src={href}
        alt={name}
        loading="lazy"
        decoding="async"
        // The feed's own reads come first; a screenshot can arrive after them.
        fetchPriority="low"
        style={ratio ? { aspectRatio: String(ratio) } : undefined}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (!naturalWidth || !naturalHeight) return;
          const next = naturalWidth / naturalHeight;
          knownImageRatios.set(href, next);
          setRatio((current) => (current === next ? current : next));
        }}
      />
    </a>
  );
}

function ChatAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="chat-attach">
      {attachments.map((attachment) => {
        const href = attachment.url ? sameOriginBlobUrl(attachment.url) : null;
        const name = attachment.fileName?.trim() || "Attachment";
        const type = attachment.mediaType.toLowerCase();
        const fileName = name.toLowerCase();
        const video = href && (
          type.startsWith("video/")
          || /\.(mp4|webm|mov|m4v)$/u.test(fileName)
        );
        const image = href && type.startsWith("image/") && type !== "image/svg+xml" && !video;
        if (image) {
          return <ChatImageAttachment key={attachment.id} href={href} name={name} />;
        }
        if (video) {
          return (
            <video
              key={attachment.id}
              className="chat-attach-video"
              src={href}
              controls
              playsInline
              preload="metadata"
            >
              {name}
            </video>
          );
        }
        const audio = href && (
          type.startsWith("audio/")
          || /\.(mp3|wav|m4a|aac|ogg|oga)$/u.test(fileName)
        );
        if (audio) {
          return (
            <audio
              key={attachment.id}
              className="chat-attach-audio"
              src={href}
              controls
              preload="metadata"
            >
              {name}
            </audio>
          );
        }
        if (href && (type === "text/html" || type === "application/xhtml+xml")) {
          return (
            <iframe
              key={attachment.id}
              className="chat-attach-html"
              title={name}
              src={href}
              sandbox=""
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          );
        }
        return href ? (
          <a key={attachment.id} className="chat-attach-file" href={href} target="_blank" rel="noreferrer">
            {name}
          </a>
        ) : (
          <span key={attachment.id} className="chat-attach-file">{name}</span>
        );
      })}
    </div>
  );
}

function toggleReaction(
  message: ChatMessage,
  emoji: string,
  onReact: (messageId: string, emoji: string, remove: boolean) => void,
) {
  const mine = message.reactions?.find((chip) => chip.emoji === emoji)?.me === true;
  onReact(message.id, emoji, mine);
}

function ReactionChips({
  message,
  members,
  viewerActorId,
  onReact,
}: {
  message: ChatMessage;
  members: Map<string, ChannelMemberView>;
  viewerActorId?: string;
  onReact?: (messageId: string, emoji: string, remove: boolean) => void;
}) {
  const chips = message.reactions ?? [];
  if (chips.length === 0) return null;
  return (
    <div className="chat-reaction-row">
      {chips.map((chip) => {
        // Names ride on hover and in the accessible label; the click stays a
        // toggle. A server that sends no reactor list gets the count alone.
        const reactors = reactionReactorNames(chip.actorIds, members, viewerActorId);
        const who = reactors ? ` from ${reactors}` : "";
        const label = chip.me
          ? `${chip.emoji} ${chip.count}${who}, including you. Remove your reaction.`
          : `${chip.emoji} ${chip.count}${who}. React with ${chip.emoji}.`;
        return (
          <button
            type="button"
            key={chip.emoji}
            className="chat-reaction"
            data-me={chip.me ? "true" : undefined}
            data-reactors={reactors ?? undefined}
            aria-pressed={chip.me}
            aria-label={label}
            onClick={() => onReact && toggleReaction(message, chip.emoji, onReact)}
          >
            <span aria-hidden="true">{chip.emoji}</span>
            <span>{chip.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The hover strip, and the rest of the set behind one step.
 *
 * Five stay on the strip because five is what fits beside a name and a clock
 * without pushing them around. `›` opens the remainder as a small sheet under
 * the strip rather than stretching the meta row to seventeen cells — the same
 * allowlist, one grid, no keyboard invented for it. Opening it also holds the
 * picker open, so the sheet does not evaporate the moment the pointer leaves
 * the turn on its way there.
 */
function ReactionPicker({
  message,
  onReact,
  pinned,
  onDismiss,
}: {
  message: ChatMessage;
  onReact: (messageId: string, emoji: string, remove: boolean) => void;
  pinned: boolean;
  onDismiss: () => void;
}) {
  const [focusIndex, setFocusIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const quick = [...REACTION_EMOJI_QUICK];
  const visible = expanded ? [...quick, ...REACTION_EMOJI_MORE] : quick;

  const collapse = useCallback(() => {
    setExpanded(false);
    setFocusIndex((current) => Math.min(current, REACTION_EMOJI_QUICK.length - 1));
  }, []);

  const close = useCallback(() => {
    collapse();
    onDismiss();
  }, [collapse, onDismiss]);

  // A long press pins the picker; so does opening the sheet. Either way the
  // next press outside it puts the picker away.
  useEffect(() => {
    if (!pinned && !expanded) return;
    const onPointer = (event: PointerEvent) => {
      if (pickerRef.current?.contains(event.target as Node | null)) return;
      close();
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [pinned, expanded, close]);

  const onPickerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // Escape closes the sheet first, and the picker only once it is shut.
      if (expanded) collapse();
      else onDismiss();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      setFocusIndex((current) =>
        (current + delta + visible.length) % visible.length);
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const emoji = visible[focusIndex];
      if (emoji) {
        toggleReaction(message, emoji, onReact);
        close();
      }
    }
  };

  const option = (emoji: string, index: number) => (
    <button
      type="button"
      key={emoji}
      role="option"
      tabIndex={index === focusIndex ? 0 : -1}
      aria-label={`React with ${emoji}`}
      aria-selected={index === focusIndex}
      aria-pressed={message.reactions?.some((chip) => chip.emoji === emoji && chip.me) === true}
      onClick={() => {
        toggleReaction(message, emoji, onReact);
        close();
      }}
    >
      {emoji}
    </button>
  );

  return (
    <div
      ref={pickerRef}
      className="chat-reaction-picker"
      data-expanded={expanded ? "true" : undefined}
      role="listbox"
      aria-label="React to this message"
      onKeyDown={onPickerKey}
    >
      {quick.map(option)}
      <button
        type="button"
        className="chat-reaction-more"
        aria-expanded={expanded}
        aria-label={expanded ? "Fewer emoji" : "More emoji"}
        onClick={() => (expanded ? collapse() : setExpanded(true))}
      >
        {expanded ? "‹" : "›"}
      </button>
      {expanded ? (
        <div className="chat-reaction-sheet" role="presentation">
          {REACTION_EMOJI_MORE.map((emoji, index) => option(emoji, quick.length + index))}
        </div>
      ) : null}
    </div>
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
