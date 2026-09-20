/**
 * The small shared parts of the chat surface: copy affordances, the turn, the
 * tracked-ask card, and the connection block.
 *
 * They live together because they are the pieces that must say the same thing
 * in the feed, the thread panel, and the member card. A rule enforced in one
 * place and re-implemented in another is a rule that drifts.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import {
  REACTION_EMOJI_MORE,
  REACTION_EMOJI_QUICK,
  type MessageAttachment,
} from "@openscout/protocol";
import { sameOriginBlobUrl } from "../../components/MessageEmbeds.tsx";

import {
  CHAT_LINK_PREVIEW_PATH,
  type ChannelMemberView,
  type ChatMessage,
  type TrackedRequest,
} from "./chat-api.ts";
import { ChatMessageMarkup } from "./chat-message-markup.tsx";
import { useChatCapabilities } from "./chat-transport.tsx";
import { MemberAvatar } from "./ChatAvatar.tsx";
import {
  askChip,
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
  onStop,
}: {
  request: TrackedRequest;
  target: ChannelMemberView | null;
  withTarget: boolean;
  onStop?: (flightId: string) => void;
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
      {chip.canStop && onStop ? (
        <button
          type="button"
          className="chat-ask-stop"
          onClick={() => onStop(request.flightId)}
        >
          Stop
        </button>
      ) : null}
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
  onStopAsk,
  focused = false,
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
  onStopAsk?: (flightId: string) => void;
  focused?: boolean;
  withTargetOnChip?: boolean;
}) {
  const capabilities = useChatCapabilities();
  const [pickerPinned, setPickerPinned] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const author = memberOrFallback(members, message.actorId);
  const target = request ? members.get(request.targetActorId) ?? null : null;
  const name = memberDisplayName(author);
  const canReact = capabilities.reactions && Boolean(onReact);

  const clearPress = () => {
    if (press.current) {
      window.clearTimeout(press.current.timer);
      press.current = null;
    }
  };

  return (
    <article
      className="chat-turn"
      data-message-id={message.id}
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
          {onCopyLink ? (
            <button
              type="button"
              className="chat-when-link"
              title="Copy link to this message"
              aria-label="Copy link to this message"
              onClick={() => onCopyLink(message.id)}
            >
              <time className="chat-when" dateTime={new Date(message.createdAt).toISOString()}>
                {clockTime(message.createdAt)}
              </time>
            </button>
          ) : (
            <time className="chat-when" dateTime={new Date(message.createdAt).toISOString()}>
              {clockTime(message.createdAt)}
            </time>
          )}
          {canReact ? (
            <ReactionPicker
              message={message}
              onReact={onReact!}
              pinned={pickerPinned}
              onDismiss={() => setPickerPinned(false)}
            />
          ) : null}
        </div>
        <MessageBody message={message} />
        <ChatAttachments attachments={message.attachments ?? []} />
        {request ? (
          <TrackedAskCard
            request={request}
            target={target}
            withTarget={withTargetOnChip}
            onStop={onStopAsk}
          />
        ) : null}
        {capabilities.reactions ? (
          <ReactionChips message={message} onReact={canReact ? onReact : undefined} />
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
  onReact,
}: {
  message: ChatMessage;
  onReact?: (messageId: string, emoji: string, remove: boolean) => void;
}) {
  const chips = message.reactions ?? [];
  if (chips.length === 0) return null;
  return (
    <div className="chat-reaction-row">
      {chips.map((chip) => {
        const label = chip.me
          ? `${chip.emoji} ${chip.count}, including you. Remove your reaction.`
          : `${chip.emoji} ${chip.count}. React with ${chip.emoji}.`;
        return (
          <button
            type="button"
            key={chip.emoji}
            className="chat-reaction"
            data-me={chip.me ? "true" : undefined}
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
