/**
 * Scout Chat — the standalone channel surface at `/chat`.
 *
 * A member-scoped room: it renders what the signed-in member belongs to, and
 * nothing else. It does not mount the operator shell, and it makes no operator
 * API calls — a teammate holding a channel credential can open this page and
 * every request it fires is one their credential is allowed to make.
 *
 * Three truths this component is responsible for keeping:
 *
 *  - **Nothing is invented.** Every member, message, state, and invitation on
 *    screen came off the wire. Where the server sends nothing, the surface
 *    says so rather than filling the gap.
 *  - **Polling is the reader of record.** This surface re-reads at a modest
 *    interval and says "reconnecting" when a read fails. Where the server
 *    offers a change stream it takes the nudge and re-reads sooner, but a
 *    notification only ever triggers the same `/feed` read the poll makes —
 *    nothing on screen came off a stream instead of the canonical endpoint,
 *    and a stream that is absent or broken costs latency, never correctness.
 *  - **Drafts survive.** A poll replaces server state only. What you were
 *    typing is client state and is never touched by a refresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { ChannelInvitePublicView, ConversationDefinition, MessageAttachment } from "@openscout/protocol";

import {
  ChatApiError,
  DEFAULT_CHAT_SPACE,
  type ChannelFeed,
  type ChannelMemberView,
  type ChatBootstrap,
  type ChatSpaceView,
} from "./chat-api.ts";
import { useChatAddress, useChatApi, useChatCapabilities } from "./chat-transport.tsx";
import { RailToggle } from "../../components/RailToggle.tsx";
import {
  SIDEBAR_EXPANDED_WIDTH,
  SLACK_SIDEBAR_COLLAPSED_WIDTH,
  useSidebarCollapse,
} from "../../scout/sidebar/useSidebarCollapse.ts";

import { ChatSpaceTheme, useScoutStandaloneAppearance } from "./ChatSpaceTheme.tsx";
import { ChannelSidebar } from "./ChannelSidebar.tsx";
import { ChannelComposer } from "./ChannelComposer.tsx";
import { ChatRightPanel, type PanelView } from "./ChatRightPanel.tsx";
import { Facepile } from "./ChatAvatar.tsx";
import { Turn } from "./ChatBits.tsx";
import { InviteSheet } from "./InviteSheet.tsx";
import { JumpPalette } from "./JumpPalette.tsx";
import { createSelectionGuard, subscribeChannelChanges } from "./chat-live.ts";
import {
  BOOTSTRAP_POLL_MS,
  FEED_POLL_MS,
  ROSTER_POLL_MS,
  channelHasOwedAttention,
  channelLabel,
  isAskableMember,
  memberDisplayName,
  applyOptimisticReaction,
  mergeChannelRoster,
  newRequestId,
  peopleAgentLabel,
  projectFeed,
  sortChannels,
} from "./chat-space-model.ts";
import { uploadMediaFiles } from "../../lib/media-blobs.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { chatMessageHref } from "./chat-address.ts";

/**
 * The space rides in the URL beside the channel, so a link carries the whole
 * address. It is a selector, not a credential: pasting a link to a space you
 * are not in lands on a 404 from the server, never on somebody else's room.
 *
 * How it is spelled belongs to the transport (`chat-address.ts`): local Scout
 * puts both selectors in the query string, hosted Chat gives the space its own
 * `/c/<slug>` path. This component only ever asks for them and sets them.
 */

/**
 * Chat defaults the column open. Scout's shared hook defaults it railed.
 * Seed the persisted key once from the old `openscout.chat.rail` flag so the
 * first paint matches what this surface used to do.
 */
const CHAT_SIDEBAR_COLLAPSE_KEY = "appshell.chat.sidebar.manualCollapsed";
const CHAT_PANEL_WIDTH_KEY = "openscout.chat.panel.width";
const CHAT_PANEL_DEFAULT = 360;
const CHAT_PANEL_MIN = 280;
const CHAT_PANEL_MAX = 520;

function seedChatSidebarCollapse(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(CHAT_SIDEBAR_COLLAPSE_KEY) != null) return;
    const railed = window.localStorage.getItem("openscout.chat.rail") === "1";
    window.localStorage.setItem(CHAT_SIDEBAR_COLLAPSE_KEY, JSON.stringify(railed));
  } catch {
    // First paint uses the hook default when storage is unavailable.
  }
}

function readPanelWidth(): number {
  if (typeof window === "undefined") return CHAT_PANEL_DEFAULT;
  try {
    const raw = Number(window.localStorage.getItem(CHAT_PANEL_WIDTH_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return CHAT_PANEL_DEFAULT;
    return Math.max(CHAT_PANEL_MIN, Math.min(CHAT_PANEL_MAX, Math.round(raw)));
  } catch {
    return CHAT_PANEL_DEFAULT;
  }
}

function writePanelWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_PANEL_WIDTH_KEY, String(width));
  } catch {
    // Width holds for this visit when device storage is unavailable.
  }
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(query).matches
      : false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** A poll that pauses with the tab and never overlaps itself. */
function usePoll(run: () => Promise<void>, intervalMs: number, enabled: boolean) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let busy = false;
    const tick = () => {
      if (cancelled || busy) return;
      if (typeof document !== "undefined" && document.hidden) return;
      busy = true;
      void runRef.current().finally(() => {
        busy = false;
      });
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs]);
}

/**
 * The server's change stream for one channel, when it serves one.
 *
 * It carries no content: every notification becomes the same feed read the
 * poll makes. Enabled/channel changes tear the subscription down, so a
 * notification for a channel you have left cannot reach the surface.
 */
function useChannelLive(
  channelId: string | null,
  enabled: boolean,
  invalidate: () => Promise<void>,
  space: string,
) {
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;
  useEffect(() => {
    if (!enabled || !channelId) return;
    return subscribeChannelChanges({
      channelId,
      space,
      onInvalidate: () => invalidateRef.current(),
    });
  }, [channelId, enabled, space]);
}

type Phase = "loading" | "ready" | "gate" | "error";

/**
 * What a signed-out visitor is shown, when the deployment wants its own door.
 *
 * Hosted Chat passes this to mount its own entrance; local `/chat` omits it and
 * keeps the card it has always had. `signInHref` arrives already carrying the
 * return address, so the sign-in grammar is composed in exactly one place.
 */
export interface ChatSpaceSignedOutView {
  signInHref: string;
  signInLabel: string;
  note: string | null;
  message: string | null;
}

export interface ChatSpaceSurfaceProps {
  /** Rendered instead of the default gate when the visitor has no session. */
  signedOut?: (view: ChatSpaceSignedOutView) => ReactNode;
}

type StagedOutgoing = MessageAttachment & { localPath?: string };

interface PendingSend {
  channelId: string;
  body: string;
  replyToMessageId: string | null;
  targetActorId: string | null;
  requestId: string;
  attachments?: StagedOutgoing[];
}

async function outgoingChatAttachments(
  files: File[],
  uploadRemote: (files: File[]) => Promise<StagedOutgoing[]>,
): Promise<StagedOutgoing[]> {
  // Browser File objects always upload. A Finder path is often Desktop/Downloads,
  // which is outside Scout's trusted roots — sending it as localPath 403s and
  // looks like "attach did nothing".
  if (files.length === 0) return [];
  return uploadRemote(files);
}

export function ChatSpaceSurface({ signedOut }: ChatSpaceSurfaceProps = {}) {
  // Which server this surface is talking to. Absent a provider it is the local
  // Scout server, which is what `/chat` has always mounted.
  const chatApi = useChatApi();
  const capabilities = useChatCapabilities();
  const address = useChatAddress();

  const {
    theme,
    preference: themePreference,
    setPreference: setThemePreference,
  } = useScoutStandaloneAppearance();

  const [phase, setPhase] = useState<Phase>("loading");
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<ChatBootstrap | null>(null);
  const [channelId, setChannelId] = useState<string | null>(() => address.read().channelId);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(() => address.read().messageId);
  // An absent selector means "whichever space the server answers for"; the
  // local default is named so that links predating spaces stay byte-identical.
  const [space, setSpace] = useState<string>(() => address.read().space ?? DEFAULT_CHAT_SPACE);
  const [feed, setFeed] = useState<ChannelFeed | null>(null);
  const [members, setMembers] = useState<ChannelMemberView[]>([]);
  const [invites, setInvites] = useState<ChannelInvitePublicView[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [askTargets, setAskTargets] = useState<Record<string, string | null>>({});
  const [panel, setPanel] = useState<PanelView>({ kind: "none" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [threadSending, setThreadSending] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [compactView, setCompactView] = useState<"list" | "channel" | "panel">(
    () => (address.read().channelId ? "channel" : "list"),
  );
  seedChatSidebarCollapse();
  const viewportWidth = useViewportWidth();
  const isCompact = useMediaQuery("(max-width: 899px)");
  const isMidWidth = useMediaQuery("(max-width: 1199px)");
  const sidebarCollapse = useSidebarCollapse(
    "chat",
    isCompact ? 1600 : viewportWidth,
    SLACK_SIDEBAR_COLLAPSED_WIDTH,
  );
  const sidebarDragTargetRef = useRef(sidebarCollapse.width);
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const panelDragTargetRef = useRef(panelWidth);
  const [panelDragWidth, setPanelDragWidth] = useState<number | null>(null);

  const pendingSend = useRef<PendingSend | null>(null);
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const rosterForChannel = useRef<string | null>(null);
  // Every channel read is stamped with the selection that started it. A
  // response that outlives its selection is dropped rather than applied —
  // including the A→B→A case, where the channel id alone would look current
  // again while the reading is from the previous visit.
  const [selection] = useState(createSelectionGuard);
  const [bootstrapSelection] = useState(createSelectionGuard);
  const bootstrapSpace = useRef(space);
  if (bootstrapSpace.current !== space) {
    bootstrapSpace.current = space;
    bootstrapSelection.reset();
  }

  /* ── identity and channel list ─────────────────────────────────────────── */

  const loadBootstrap = useCallback(async (initial: boolean) => {
    const isCurrent = bootstrapSelection.begin();
    try {
      const next = await chatApi.bootstrap({
        recoverSession: !new URLSearchParams(window.location.search).has("signedOut"),
        space,
      });
      if (!isCurrent()) return;
      setBootstrap(next);
      // Adopt the space the server answered for rather than the one we asked
      // about. A member whose credential names one space is answered for that
      // space whatever the URL said, and the switcher must show where they
      // actually are.
      if (next.space && next.space !== space) setSpace(next.space);
      setPhase("ready");
      setGateMessage(null);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ChatApiError && error.isUnauthenticated) {
        // A later poll 401 must not kick a working room to the login gate.
        // That is how a cookie blip turned a multiplayer channel into an
        // empty solo view.
        if (!initial && phase === "ready") {
          setStale(true);
          return;
        }
        setPhase("gate");
        setGateMessage(error.message);
        return;
      }
      if (initial) {
        setPhase("error");
        setGateMessage(
          error instanceof Error ? error.message : "Scout Chat could not be reached.",
        );
      } else {
        setStale(true);
      }
    }
  }, [bootstrapSelection, chatApi, phase, space]);

  useEffect(() => {
    void loadBootstrap(true);
  }, [loadBootstrap]);

  usePoll(() => loadBootstrap(false), BOOTSTRAP_POLL_MS, phase === "ready");

  const channels = useMemo(
    () => sortChannels((bootstrap?.channels ?? []).filter((item) => item.kind === "channel")),
    [bootstrap],
  );
  const directs = useMemo(
    () =>
      (bootstrap?.channels ?? []).filter(
        (item) => item.kind === "direct" || item.kind === "group_direct",
      ),
    [bootstrap],
  );

  const selectableIds = useMemo(
    () => new Set([...channels, ...directs].map((item) => item.id)),
    [channels, directs],
  );

  // Never invented. A server that sends no space list is a server that predates
  // spaces, and the surface renders exactly one: the one it is in.
  const spaces = useMemo<ChatSpaceView[]>(
    () => bootstrap?.spaces?.length
      ? bootstrap.spaces
      : [{
          slug: space,
          title: space === DEFAULT_CHAT_SPACE ? "Home" : space,
          conversationId: null,
          isDefault: space === DEFAULT_CHAT_SPACE,
          channelCount: channels.length,
        }],
    [bootstrap, channels.length, space],
  );

  // Land on something real: a link to a channel we cannot see falls back to
  // the first one rather than rendering an empty room.
  useEffect(() => {
    if (phase !== "ready") return;
    if (channelId && selectableIds.has(channelId)) return;
    const fallback = channels[0]?.id ?? directs[0]?.id ?? null;
    if (fallback === channelId) return;
    setChannelId(fallback);
    address.write({ channelId: fallback, space, messageId: null }, true);
  }, [address, channelId, channels, directs, phase, selectableIds, space]);

  useEffect(() => {
    const onPopState = () => {
      const here = address.read();
      setChannelId(here.channelId);
      setSpace(here.space ?? DEFAULT_CHAT_SPACE);
      setFocusMessageId(here.messageId);
      setPanel({ kind: "none" });
      setCompactView(here.channelId ? "channel" : "list");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [address]);

  const channel = useMemo(
    () => [...channels, ...directs].find((item) => item.id === channelId) ?? null,
    [channels, channelId, directs],
  );

  /* ── channel contents ──────────────────────────────────────────────────── */

  const loadFeed = useCallback(async () => {
    if (!channelId) return;
    const isCurrent = selection.begin();
    try {
      const next = await chatApi.feed(channelId, space);
      if (!isCurrent()) return;
      setFeed(next);
      setFeedError(null);
      setStale(false);
    } catch (error) {
      // Keep the last good feed on screen and say the reading is stale. An
      // empty channel and an unreachable one must never look the same.
      if (!isCurrent()) return;
      if (error instanceof ChatApiError && error.isUnauthenticated) {
        setFeedError(error.message);
        return;
      }
      setStale(true);
    }
  }, [channelId, chatApi, selection, space]);

  const loadRoster = useCallback(async () => {
    if (!channelId) return;
    const isCurrent = selection.begin();
    try {
      const next = await chatApi.members(channelId, space);
      if (!isCurrent()) return;
      setMembers((current) => {
        const incoming = next.members ?? [];
        if (incoming.length === 0) return current;
        // First successful read for this channel may replace. Every later
        // read merges — a thin snapshot finishing last was wiping Arc.
        if (rosterForChannel.current !== channelId) {
          rosterForChannel.current = channelId;
          return incoming;
        }
        return mergeChannelRoster(current, incoming);
      });
    } catch {
      if (!isCurrent()) return;
      setStale(true);
    }
  }, [channelId, chatApi, selection, space]);

  const loadInvites = useCallback(async () => {
    // A server that does not list invitations is not a server with none. The
    // panel says so; this read is simply not made.
    if (!channelId || !capabilities.inviteList) return;
    const isCurrent = selection.begin();
    try {
      const next = await chatApi.invites(channelId, space);
      if (!isCurrent()) return;
      setInvites(next.invites ?? []);
      setInviteError(null);
    } catch (error) {
      if (!isCurrent()) return;
      setInvites([]);
      setInviteError(
        error instanceof ChatApiError && error.isUnauthenticated
          ? "Only members of this channel can manage its invitations."
          : error instanceof Error
            ? error.message
            : "Invitations could not be read.",
      );
    }
  }, [capabilities.inviteList, channelId, chatApi, selection, space]);

  useEffect(() => {
    // Wipe feed/invites on channel change, but keep the last roster until
    // the new one arrives so the facepile does not collapse to nobody.
    selection.reset();
    setFeed(null);
    setInvites([]);
    setFeedError(null);
    setPanel({ kind: "none" });
    if (rosterForChannel.current !== channelId) {
      rosterForChannel.current = null;
    }
  }, [channelId, selection]);

  useEffect(() => {
    if (!channelId) return;
    void loadFeed();
    void loadRoster();
    void loadInvites();
  }, [channelId, loadFeed, loadInvites, loadRoster]);

  usePoll(loadFeed, FEED_POLL_MS, phase === "ready" && Boolean(channelId));
  usePoll(loadRoster, ROSTER_POLL_MS, phase === "ready" && Boolean(channelId));

  // The stream only shortens the wait for a posted message. The polls above
  // stay exactly as they were: they remain the fallback when no stream is
  // served, and they are still the only reader of roster and reception, which
  // the current stream contract says nothing about.
  useChannelLive(
    channelId,
    phase === "ready" && capabilities.liveStream,
    loadFeed,
    space,
  );

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const membersById = useMemo(() => {
    const map = new Map<string, ChannelMemberView>();
    for (const member of members) map.set(member.actorId, member);
    return map;
  }, [members]);

  const projection = useMemo(
    () => projectFeed({
      messages: feed?.messages ?? [],
      requests: feed?.requests ?? [],
      nowMs,
    }),
    [feed, nowMs],
  );

  const viewer = bootstrap?.viewer ?? null;

  const addressedChannelIds = useMemo(() => {
    const ids = new Set<string>();
    // Attention is only claimed for the channel whose feed we actually hold.
    // There is no unread projection on the wire, so no other row gets a dot.
    if (!channelId || !viewer) return ids;
    if (channelHasOwedAttention({ projection, viewerActorId: viewer.actorId, members })) {
      ids.add(channelId);
    }
    return ids;
  }, [channelId, members, projection, viewer]);

  // Follow the tail unless the reader has scrolled up to read something.
  useEffect(() => {
    const node = feedScrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distanceFromBottom < 160) node.scrollTop = node.scrollHeight;
  }, [projection.lastMessageAt]);

  /* ── sending ───────────────────────────────────────────────────────────── */

  const draft = channelId ? drafts[channelId] ?? "" : "";
  const askTargetId = channelId ? askTargets[channelId] ?? null : null;

  const setDraft = useCallback(
    (value: string) => {
      if (!channelId) return;
      setDrafts((current) => ({ ...current, [channelId]: value }));
    },
    [channelId],
  );

  const setAskTarget = useCallback(
    (actorId: string | null) => {
      if (!channelId) return;
      setAskTargets((current) => ({ ...current, [channelId]: actorId }));
    },
    [channelId],
  );

  const send = useCallback(
    async (input: {
      body: string;
      replyToMessageId: string | null;
      targetActorId: string | null;
      files?: File[];
    }) => {
      if (!channelId) return false;
      const body = input.body.trim();
      const files = input.files ?? [];
      if (!body && files.length === 0) return false;

      // One logical send keeps one request id across retries, so a failure we
      // cannot interpret does not turn into two posts.
      const previous = pendingSend.current;
      const sameSend = previous
        && previous.channelId === channelId
        && previous.body === body
        && previous.replyToMessageId === input.replyToMessageId
        && previous.targetActorId === input.targetActorId;
      const requestId = sameSend ? previous!.requestId : newRequestId();
      const attachments = sameSend && previous?.attachments
        ? previous.attachments
        : files.length > 0
          ? await outgoingChatAttachments(files, (remote) =>
            chatApi.uploadAttachments
              ? chatApi.uploadAttachments(channelId, remote, space)
              : uploadMediaFiles(remote))
          : undefined;
      pendingSend.current = {
        channelId,
        body,
        replyToMessageId: input.replyToMessageId,
        targetActorId: input.targetActorId,
        requestId,
        attachments,
      };

      if (input.targetActorId) {
        await chatApi.postAsk(channelId, {
          requestId,
          body,
          targetActorId: input.targetActorId,
          space,
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        });
      } else {
        await chatApi.postMessage(channelId, {
          requestId,
          body,
          space,
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
      }
      // Only a definite success clears the retry slot.
      pendingSend.current = null;
      await loadFeed();
      void loadRoster();
      return true;
    },
    [channelId, chatApi, loadFeed, loadRoster, space],
  );

  const onReact = useCallback((messageId: string, emoji: string, remove: boolean) => {
    if (!channelId) return;
    const previous = feed;
    setFeed((current) => {
      if (!current) return current;
      return {
        ...current,
        messages: current.messages.map((message) =>
          message.id === messageId
            ? { ...message, reactions: applyOptimisticReaction(message.reactions, emoji, remove) }
            : message),
      };
    });
    const requestId = newRequestId();
    const write = remove ? chatApi.removeReaction : chatApi.addReaction;
    void write(channelId, { messageId, emoji, requestId, space })
      .then(() => {
        void loadFeed();
      })
      .catch((error: unknown) => {
        setFeed(previous);
        setFeedError(
          error instanceof ChatApiError
            ? error.message
            : "That reaction did not save.",
        );
      });
  }, [channelId, chatApi, feed, loadFeed, space]);

  const onStopAsk = useCallback((flightId: string) => {
    if (!channelId) return;
    void chatApi.cancelAsk(channelId, flightId, space)
      .then((result) => {
        setFeed((current) => {
          if (!current) return current;
          return {
            ...current,
            requests: current.requests.map((item) =>
              item.flightId === flightId ? { ...item, state: result.request.state } : item
            ),
          };
        });
      })
      .catch(() => {
        void loadFeed();
      });
  }, [channelId, chatApi, loadFeed, space]);

  const onSendChannel = useCallback((files: File[] = []) => {
    if (!channelId || sending) return Promise.resolve(false);
    setSendError(null);
    setSending(true);
    return send({ body: draft, replyToMessageId: null, targetActorId: askTargetId, files })
      .then((sent) => {
        if (sent) {
          setDrafts((current) => ({ ...current, [channelId]: "" }));
          setAskTargets((current) => ({ ...current, [channelId]: null }));
        }
        return sent;
      })
      .catch((error: unknown) => {
        setSendError(
          error instanceof ChatApiError
            ? error.message
            : "That did not send. The text is still here — try again.",
        );
        return false;
      })
      .finally(() => setSending(false));
  }, [askTargetId, channelId, draft, send, sending]);

  const threadRootId = panel.kind === "thread" ? panel.rootMessageId : null;
  const threadDraft = threadRootId ? threadDrafts[threadRootId] ?? "" : "";

  const onSendThreadReply = useCallback((files: File[] = []) => {
    if (!threadRootId || threadSending) return Promise.resolve(false);
    setThreadError(null);
    setThreadSending(true);
    return send({ body: threadDraft, replyToMessageId: threadRootId, targetActorId: null, files })
      .then((sent) => {
        if (sent) setThreadDrafts((current) => ({ ...current, [threadRootId]: "" }));
        return sent;
      })
      .catch((error: unknown) => {
        setThreadError(
          error instanceof ChatApiError ? error.message : "That reply did not send.",
        );
        return false;
      })
      .finally(() => setThreadSending(false));
  }, [send, threadDraft, threadRootId, threadSending]);

  /* ── navigation ────────────────────────────────────────────────────────── */

  const selectChannel = useCallback((id: string) => {
    setChannelId(id);
    address.write({ channelId: id, space, messageId: null }, false);
    setFocusMessageId(null);
    setPanel({ kind: "none" });
    setCompactView("channel");
  }, [address, space]);

  /**
   * Switch spaces.
   *
   * The channel is dropped, not carried: a channel id belongs to exactly one
   * space, so keeping it across the switch would ask the server for a room
   * that is not in the space we just moved to — and be answered, correctly,
   * with a 404. The next bootstrap lands on that space's first channel.
   */
  const selectSpace = useCallback((slug: string) => {
    if (slug === space) return;
    setSpace(slug);
    setChannelId(null);
    setBootstrap(null);
    setFeed(null);
    setMembers([]);
    setInvites([]);
    setPanel({ kind: "none" });
    setCompactView("list");
    address.write({ channelId: null, space: slug, messageId: null }, false);
    setFocusMessageId(null);
  }, [address, space]);

  const onCopyLink = useCallback((messageId: string) => {
    if (!channelId) return;
    const href = chatMessageHref(window.location.href, {
      channelId,
      messageId,
      space,
    });
    address.write({ channelId, space, messageId }, true);
    setFocusMessageId(messageId);
    void copyTextToClipboard(href);
  }, [address, channelId, space]);

  const openPanel = useCallback((next: PanelView) => {
    setPanel(next);
    setCompactView(next.kind === "none" ? "channel" : "panel");
  }, []);

  const scrolledToMessage = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMessageId || !feed) return;
    const target = feed.messages.find((message) => message.id === focusMessageId);
    if (!target) return;
    if (target.replyToMessageId) {
      setPanel({ kind: "thread", rootMessageId: target.replyToMessageId });
      setCompactView("panel");
    }
    if (scrolledToMessage.current === focusMessageId) return;
    scrolledToMessage.current = focusMessageId;
    const frame = window.requestAnimationFrame(() => {
      const node = document.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`);
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [feed, focusMessageId]);

  const closePanel = useCallback(() => {
    setPanel({ kind: "none" });
    setCompactView("channel");
  }, []);

  const toggleRail = useCallback(() => {
    sidebarCollapse.toggleCollapsed();
  }, [sidebarCollapse]);

  const handleSidebarResizePointerDown = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startedCollapsed = sidebarCollapse.effectiveCollapsed;
    const startX = event.clientX;
    const startWidth = startedCollapsed
      ? SLACK_SIDEBAR_COLLAPSED_WIDTH
      : sidebarCollapse.expandedWidth;
    sidebarDragTargetRef.current = startWidth;
    sidebarCollapse.beginResize(startWidth, startedCollapsed);
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
    };
    const onMove = (ev: PointerEvent) => {
      const raw = startWidth + (ev.clientX - startX);
      sidebarDragTargetRef.current = raw;
      sidebarCollapse.updateResize(raw);
    };
    const onUp = () => {
      sidebarCollapse.commitDrag(sidebarDragTargetRef.current ?? startWidth, startedCollapsed);
      cleanup();
    };
    const onCancel = () => {
      sidebarCollapse.clearDrag();
      cleanup();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  }, [sidebarCollapse]);

  const handlePanelResizePointerDown = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = panelWidth;
    panelDragTargetRef.current = startWidth;
    setPanelDragWidth(startWidth);
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
    };
    const clamp = (raw: number) =>
      Math.max(CHAT_PANEL_MIN, Math.min(CHAT_PANEL_MAX, Math.round(raw)));
    const onMove = (ev: PointerEvent) => {
      const raw = clamp(startWidth - (ev.clientX - startX));
      panelDragTargetRef.current = raw;
      setPanelDragWidth(raw);
    };
    const onUp = () => {
      const next = clamp(panelDragTargetRef.current ?? startWidth);
      setPanelWidth(next);
      writePanelWidth(next);
      setPanelDragWidth(null);
      cleanup();
    };
    const onCancel = () => {
      setPanelDragWidth(null);
      cleanup();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  }, [panelWidth]);

  const signOut = useCallback(() => {
    void (async () => {
      try {
        await chatApi.signOut();
        const target = new URL(window.location.href);
        target.searchParams.set("signedOut", "1");
        window.location.assign(target.pathname + target.search);
      } catch (error) {
        setFeedError(error instanceof Error ? error.message : "Could not sign out. Try again.");
      }
    })();
  }, [chatApi]);

  const createChannel = useCallback(
    async (input: { title: string; topic: string }) => {
      const created = await chatApi.createChannel({
        title: input.title,
        ...(input.topic ? { topic: input.topic } : {}),
        // Created into the space the operator is looking at, never into a
        // default the sidebar is not showing.
        space,
      });
      await loadBootstrap(false);
      selectChannel(created.conversation.id);
    },
    [chatApi, loadBootstrap, selectChannel, space],
  );

  /**
   * Create a space and land in it.
   *
   * Its first channel is created with it — a space with no room in it is a
   * dead end — and the surface moves there in one step rather than leaving the
   * operator on an empty switcher entry to work out themselves.
   */
  const createSpace = useCallback(
    async (input: { title: string; channel: string }) => {
      const created = await chatApi.createSpace({
        title: input.title,
        ...(input.channel ? { channel: input.channel } : {}),
      });
      setSpace(created.space.slug);
      setBootstrap(null);
      setFeed(null);
      setMembers([]);
      setInvites([]);
      setChannelId(created.channel?.id ?? null);
      setPanel({ kind: "none" });
      setCompactView(created.channel ? "channel" : "list");
      address.write(
        { channelId: created.channel?.id ?? null, space: created.space.slug, messageId: null },
        false,
      );
    },
    [address, chatApi],
  );

  /**
   * Delete a space.
   *
   * Irreversible, and the server owns the refusal — a space that is not yours
   * fails there, not here. Afterwards the surface drops everything it was
   * holding for that space and re-bootstraps onto whatever is left, rather than
   * rendering a room the server has just destroyed.
   */
  const deleteSpace = useMemo(
    () =>
      capabilities.spaceDelete && chatApi.deleteSpace
        ? async (slug: string) => {
            await chatApi.deleteSpace!(slug);
            setBootstrap(null);
            setFeed(null);
            setMembers([]);
            setInvites([]);
            setChannelId(null);
            setPanel({ kind: "none" });
            setCompactView("list");
            setSpace(DEFAULT_CHAT_SPACE);
            address.write({ channelId: null, space: DEFAULT_CHAT_SPACE, messageId: null }, false);
            await loadBootstrap(true);
          }
        : null,
    [address, capabilities.spaceDelete, chatApi, loadBootstrap],
  );

  const revokeInvite = useCallback(
    async (inviteId: string) => {
      if (!channelId || !viewer) return;
      setRevokingInviteId(inviteId);
      try {
        await chatApi.revokeInvite(channelId, inviteId, viewer.actorId, space);
        await loadInvites();
      } catch (error) {
        setInviteError(error instanceof Error ? error.message : "That invitation could not be revoked.");
      } finally {
        setRevokingInviteId(null);
      }
    },
    [channelId, chatApi, loadInvites, space, viewer],
  );

  const mentionMember = useCallback(
    (actorId: string) => {
      const member = membersById.get(actorId);
      if (!member || !channelId) return;
      const label = memberDisplayName(member);
      setDrafts((current) => {
        const existing = current[channelId] ?? "";
        const separator = existing.length === 0 || existing.endsWith(" ") ? "" : " ";
        return { ...current, [channelId]: `${existing}${separator}@${label} ` };
      });
      // Mentioning arms an ask target only for a member `/asks` can route to;
      // an API participant's mention stays an ordinary post, and so does every
      // mention on a server with no `/asks`.
      if (capabilities.asks && isAskableMember(member)) setAskTarget(actorId);
      closePanel();
    },
    [capabilities.asks, channelId, closePanel, membersById, setAskTarget],
  );

  /* ── keyboard (§11) ────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // ⌘B is the sidebar chord everywhere else in Scout. Leave it to the
      // browser while text is being edited, where it means bold.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        const active = document.activeElement;
        const typing = active instanceof HTMLElement
          && (active.tagName === "TEXTAREA"
            || active.tagName === "INPUT"
            || active.isContentEditable);
        if (typing) return;
        event.preventDefault();
        toggleRail();
        return;
      }
      if (event.key === "Escape") {
        if (paletteOpen || sheetOpen) return;
        if (panel.kind !== "none") {
          event.preventDefault();
          closePanel();
          return;
        }
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.tagName === "TEXTAREA") active.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePanel, panel.kind, paletteOpen, sheetOpen, toggleRail]);

  /* ── gates ─────────────────────────────────────────────────────────────── */

  if (phase === "loading") {
    return (
      <ChatSpaceTheme theme={theme} className="chat-centered">
        <p className="chat-card-meta">Loading Scout Chat…</p>
      </ChatSpaceTheme>
    );
  }

  // The deployment's own entrance, when it has one. Only the gate takes this
  // path: an error is a failure to report, not a door to open.
  if (phase === "gate" && signedOut) {
    return signedOut({
      signInHref: `${capabilities.signIn.startPath}?${capabilities.signIn.returnToParam}=${
        encodeURIComponent(window.location.pathname + window.location.search)
      }`,
      signInLabel: capabilities.signIn.label,
      note: capabilities.signIn.note ?? null,
      message: gateMessage,
    });
  }

  if (phase === "gate" || phase === "error") {
    const isGate = phase === "gate";
    return (
      <ChatSpaceTheme theme={theme} className="chat-centered">
        <div className="chat-card">
          <span className="chat-card-eyebrow">Scout Chat</span>
          <h1>{isGate ? "You are not signed in" : "Scout Chat is unavailable"}</h1>
          <p>
            {isGate
              ? capabilities.signIn.prompt
              : gateMessage ?? "The chat service did not answer."}
          </p>
          {isGate ? (
            <>
              {/* The door belongs to the deployment: local Scout's own login,
                  hosted Chat's GitHub OAuth. Both come off the transport so the
                  sentence beside the button is true of the door it opens. */}
              <a
                className="btn btn--accent"
                href={`${capabilities.signIn.startPath}?${capabilities.signIn.returnToParam}=${
                  encodeURIComponent(window.location.pathname + window.location.search)
                }`}
              >
                {capabilities.signIn.label}
              </a>
              {capabilities.signIn.note ? (
                <p className="chat-card-note">{capabilities.signIn.note}</p>
              ) : null}
            </>
          ) : (
            <button type="button" className="btn" onClick={() => void loadBootstrap(true)}>
              Try again
            </button>
          )}
          {isGate && gateMessage ? <p className="chat-card-note">{gateMessage}</p> : null}
        </div>
      </ChatSpaceTheme>
    );
  }

  const viewerName = viewer?.displayName ?? "you";
  // A roster that has not come back yet is not a roster of nobody. The viewer
  // is always in their own channel, so an empty list can only mean the first
  // read is still out — say so rather than asserting "0 people · 0 agents" and
  // then correcting it a beat later.
  const countLabel = members.length > 0 ? peopleAgentLabel(members) : "reading…";
  // Under 900 the sidebar IS the screen; there is no column left to collapse.
  const railed = sidebarCollapse.effectiveCollapsed && !isCompact;
  const sidebarWidth = railed ? SLACK_SIDEBAR_COLLAPSED_WIDTH : sidebarCollapse.width;
  const livePanelWidth = panelDragWidth ?? panelWidth;
  const chromeStyle = {
    "--sidebar-w": `${sidebarWidth}px`,
    "--panel-w": `${livePanelWidth}px`,
  } as CSSProperties;
  const panelOpen = panel.kind !== "none";
  const threadRoot = threadRootId
    ? (feed?.messages ?? []).find((message) => message.id === threadRootId) ?? null
    : null;
  const threadReplyList = threadRootId ? projection.repliesByRoot.get(threadRootId) ?? [] : [];
  const threadRequest = threadRootId
    ? projection.requestsByMessage.get(threadRootId) ?? null
    : null;

  return (
    <ChatSpaceTheme
      theme={theme}
      className="chat-space"
      compactView={compactView}
      railed={railed}
      style={chromeStyle}
    >
      <header className="chat-topbar">
        {/* The sidebar's header band. One chevron, the same cell in both states:
            tucked against the column's inner edge when it is open, centred when
            it is a rail — so collapse happens in place and nothing jumps. */}
        <div className="chat-topbar-band">
          <div className="chat-space-name">
            <b>Scout Chat</b>
            {channel ? <span>{channel.authorityNodeId}</span> : null}
          </div>
          {isCompact ? null : (
            <RailToggle
              side="left"
              collapsed={railed}
              label="Sidebar"
              onToggle={toggleRail}
              className="chat-band-toggle"
            />
          )}
        </div>
        <button type="button" className="chat-jump" onClick={() => setPaletteOpen(true)}>
          ⌕ Jump to a channel or person
          <span className="chat-kbd">⌘K</span>
        </button>
      </header>

      <div
        className="chat-body"
        data-panel={panelOpen && !isMidWidth ? "open" : "closed"}
      >
        <ChannelSidebar
          channels={channels}
          directs={directs}
          spaces={spaces}
          activeSpace={space}
          selectedId={channelId}
          addressedChannelIds={addressedChannelIds}
          canCreate={viewer?.isOperator === true}
          viewerName={viewerName}
          viewerIsHost={viewer?.isOperator === true}
          railed={railed}
          themePreference={themePreference}
          onSelect={selectChannel}
          onSelectSpace={selectSpace}
          onCreate={createChannel}
          onCreateSpace={createSpace}
          onDeleteSpace={deleteSpace}
          onInvite={() => setSheetOpen(true)}
          onExpandRail={toggleRail}
          onOpenProfile={channel && viewer
            ? () => openPanel({ kind: "member", actorId: viewer.actorId })
            : null}
          onThemePreference={setThemePreference}
          onSignOut={signOut}
        />

        {channel ? (
          <main className="chat-channel" aria-label={channelLabel(channel.title)}>
            <header className="chat-chan-head">
              <button
                type="button"
                className="chat-compact-back"
                onClick={() => setCompactView("list")}
                aria-label="Back to channels"
              >
                ‹
              </button>
              <span className="chat-chan-name">
                <span className="chat-hash">#</span>
                {channel.title.replace(/^#/u, "")}
              </span>
              <span className={`chat-topic${channel.topic ? "" : " chat-topic--empty"}`}>
                {channel.topic ?? "No topic set"}
              </span>
              <Facepile
                members={members}
                countLabel={countLabel}
                onOpen={() => openPanel({ kind: "members" })}
              />
              <button type="button" className="btn btn--sm" onClick={() => setSheetOpen(true)}>
                Invite
              </button>
            </header>

            <div className="chat-feed" ref={feedScrollRef} role="log" aria-label="Channel messages">
              {stale ? (
                <p className="chat-feed-notice">
                  Reconnecting — this is the last reading that came back.
                </p>
              ) : null}
              {feedError ? (
                <p className="chat-feed-notice" data-tone="error">{feedError}</p>
              ) : null}
              {!feed && !feedError ? <p className="chat-feed-notice">Loading messages…</p> : null}
              {feed && projection.entries.length === 0 ? (
                <p className="chat-feed-empty">
                  Nothing has been posted here yet. Say something, or invite the people and
                  agents who belong in this room.
                </p>
              ) : null}

              {projection.entries.map((entry) => {
                if (entry.kind === "day") {
                  return (
                    <div className="chat-day" key={entry.id}>
                      <span className="label-sm">{entry.label}</span>
                    </div>
                  );
                }
                if (entry.kind === "status") {
                  return (
                    <div className="chat-status-line" key={entry.id}>
                      {entry.message.body}
                    </div>
                  );
                }
                if (entry.kind === "status-fold") {
                  return <StatusFold key={entry.id} label={entry.label} messages={entry.messages} />;
                }
                return (
                  <Turn
                    key={entry.id}
                    message={entry.message}
                    members={membersById}
                    nowMs={nowMs}
                    request={entry.request}
                    replyCount={entry.replyCount}
                    lastReplyAt={entry.lastReplyAt}
                    onOpenThread={() => openPanel({ kind: "thread", rootMessageId: entry.message.id })}
                    onOpenMember={(actorId) => openPanel({ kind: "member", actorId })}
                    onReact={onReact}
                    onCopyLink={onCopyLink}
                    onStopAsk={onStopAsk}
                    focused={focusMessageId === entry.message.id}
                  />
                );
              })}
            </div>

            <div className="chat-composer-wrap">
              <ChannelComposer
                members={members}
                draft={draft}
                onDraftChange={setDraft}
                askTargetId={askTargetId}
                onAskTargetChange={setAskTarget}
                onSend={onSendChannel}
                sending={sending}
                error={sendError}
                placeholder={`Message ${channelLabel(channel.title)}`}
              />
            </div>
          </main>
        ) : (
          <main className="chat-channel">
            <div className="chat-feed">
              <p className="chat-feed-empty">
                {viewer?.isOperator
                  ? "Create a channel to start."
                  : "You are not in a channel yet. Open the invitation you were sent."}
              </p>
            </div>
          </main>
        )}

        {channel && panelOpen && isMidWidth && !isCompact ? (
          <div className="chat-panel-scrim" role="presentation" onClick={closePanel} />
        ) : null}

        {!isCompact ? (
          <div
            data-scout-sidebar-resize-handle=""
            role="separator"
            aria-orientation="vertical"
            aria-label={railed ? "Expand sidebar (drag out)" : "Resize or collapse sidebar"}
            title={railed
              ? "Drag out to expand · double-click to expand"
              : "Drag to resize · drag in to collapse · double-click to reset"}
            onPointerDown={handleSidebarResizePointerDown}
            onDoubleClick={(event) => {
              event.preventDefault();
              if (railed) {
                sidebarCollapse.setExpandedWidth(SIDEBAR_EXPANDED_WIDTH);
                sidebarCollapse.setCollapsed(false);
              } else {
                sidebarCollapse.resetExpandedWidth();
              }
            }}
            style={{
              position: "absolute",
              left: Math.max(0, sidebarWidth - 3),
              top: 0,
              bottom: 0,
              width: 6,
              zIndex: 50,
              cursor: "ew-resize",
              touchAction: "none",
            }}
          />
        ) : null}

        {sidebarCollapse.isSidebarResizing && sidebarCollapse.dragGhostWidth != null ? (
          <div
            data-scout-sidebar-resize-ghost=""
            aria-hidden="true"
            className="scout-sidebar-resize-ghost"
            style={{
              position: "absolute",
              left: sidebarCollapse.dragGhostWidth,
              top: 0,
              bottom: 0,
              width: 2,
              transform: "translateX(-50%)",
              zIndex: 55,
              pointerEvents: "none",
            }}
          />
        ) : null}

        {channel && viewer ? (
          <ChatRightPanel
            view={panel}
            channel={channel}
            members={members}
            membersById={membersById}
            invites={invites}
            inviteError={inviteError}
            revokingInviteId={revokingInviteId}
            viewerActorId={viewer.actorId}
            viewerIsOperator={viewer.isOperator}
            nowMs={nowMs}
            threadRoot={threadRoot}
            threadReplies={threadReplyList}
            threadRequest={threadRequest}
            threadDraft={threadDraft}
            onThreadDraftChange={(value) => {
              if (!threadRootId) return;
              setThreadDrafts((current) => ({ ...current, [threadRootId]: value }));
            }}
            onSendThreadReply={onSendThreadReply}
            onReact={onReact}
            onCopyLink={onCopyLink}
            onStopAsk={onStopAsk}
            focusMessageId={focusMessageId}
            threadSending={threadSending}
            threadError={threadError}
            onClose={closePanel}
            onBack={() => openPanel({ kind: "members" })}
            onOpenMember={(actorId) => openPanel({ kind: "member", actorId })}
            onMention={mentionMember}
            onRevokeInvite={(inviteId) => void revokeInvite(inviteId)}
            onInvite={() => setSheetOpen(true)}
            overlay={isMidWidth}
          />
        ) : null}

        {channel && panelOpen && !isMidWidth && !isCompact ? (
          <div
            data-scout-sidebar-resize-handle=""
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            title="Drag to resize · double-click to reset"
            onPointerDown={handlePanelResizePointerDown}
            onDoubleClick={(event) => {
              event.preventDefault();
              setPanelWidth(CHAT_PANEL_DEFAULT);
              writePanelWidth(CHAT_PANEL_DEFAULT);
            }}
            style={{
              position: "absolute",
              right: Math.max(0, livePanelWidth - 3),
              top: 0,
              bottom: 0,
              width: 6,
              zIndex: 50,
              cursor: "ew-resize",
              touchAction: "none",
            }}
          />
        ) : null}
      </div>
      {sheetOpen && channel && viewer ? (
        <InviteSheet
          key={`${space}:${channel.id}`}
          space={space}
          channel={channel}
          viewerActorId={viewer.actorId}
          viewerName={viewer.displayName}
          onClose={() => setSheetOpen(false)}
          onInvitesChanged={() => void loadInvites()}
        />
      ) : null}

      {paletteOpen ? (
        <JumpPalette
          channels={[...channels, ...directs]}
          members={members}
          onClose={() => setPaletteOpen(false)}
          onPick={(target) => {
            setPaletteOpen(false);
            if (target.kind === "channel") selectChannel(target.id);
            else openPanel({ kind: "member", actorId: target.id });
          }}
        />
      ) : null}
    </ChatSpaceTheme>
  );
}

function StatusFold({
  label,
  messages,
}: {
  label: string;
  messages: { id: string; body: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="chat-status-line">
        <button type="button" className="chat-fold" onClick={() => setOpen((value) => !value)}>
          {`${open ? "⌃" : "⌵"} ${label}`}
        </button>
        <span className="chip chip--sm chip--mono chip--ghost chip--neutral">{messages.length}</span>
      </div>
      {open
        ? messages.map((message) => (
          <div className="chat-status-line" key={message.id}>{message.body}</div>
        ))
        : null}
    </>
  );
}
