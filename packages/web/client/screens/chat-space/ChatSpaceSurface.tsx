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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChannelInvitePublicView, ConversationDefinition } from "@openscout/protocol";

import {
  chatApi,
  ChatApiError,
  DEFAULT_CHAT_SPACE,
  type ChannelFeed,
  type ChannelMemberView,
  type ChatBootstrap,
  type ChatSpaceView,
} from "./chat-api.ts";
import { RailToggle } from "../../components/RailToggle.tsx";
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
  newRequestId,
  peopleAgentLabel,
  projectFeed,
  sortChannels,
} from "./chat-space-model.ts";

const CHANNEL_QUERY_KEY = "channel";
/**
 * The space rides in the URL beside the channel, so a link carries the whole
 * address. It is a selector, not a credential: pasting a link to a space you
 * are not in lands on a 404 from the server, never on somebody else's room.
 */
const SPACE_QUERY_KEY = "space";

/**
 * Whether the sidebar is collapsed to its rail. Per browser, not per account:
 * it is a window-shape preference, and a teammate reaching this Scout from a
 * second machine has a different window.
 */
const CHAT_RAIL_STORAGE_KEY = "openscout.chat.rail";

function readRailPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CHAT_RAIL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRailPreference(railed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_RAIL_STORAGE_KEY, railed ? "1" : "0");
  } catch {
    // The collapse holds for this visit when device storage is unavailable.
  }
}

function readChannelFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(CHANNEL_QUERY_KEY);
  return value?.trim() || null;
}

function readSpaceFromLocation(): string {
  if (typeof window === "undefined") return DEFAULT_CHAT_SPACE;
  const value = new URLSearchParams(window.location.search).get(SPACE_QUERY_KEY);
  return value?.trim() || DEFAULT_CHAT_SPACE;
}

function writeLocation(
  input: { channelId: string | null; space: string },
  replace: boolean,
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (input.channelId) url.searchParams.set(CHANNEL_QUERY_KEY, input.channelId);
  else url.searchParams.delete(CHANNEL_QUERY_KEY);
  // The default space is written as an absent parameter, so every link to a
  // room that predates spaces is exactly the link it has always been.
  if (input.space && input.space !== DEFAULT_CHAT_SPACE) {
    url.searchParams.set(SPACE_QUERY_KEY, input.space);
  } else {
    url.searchParams.delete(SPACE_QUERY_KEY);
  }
  const next = `${url.pathname}${url.search}`;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
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

interface PendingSend {
  channelId: string;
  body: string;
  replyToMessageId: string | null;
  targetActorId: string | null;
  requestId: string;
}

export function ChatSpaceSurface() {
  const {
    theme,
    preference: themePreference,
    setPreference: setThemePreference,
  } = useScoutStandaloneAppearance();

  const [phase, setPhase] = useState<Phase>("loading");
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<ChatBootstrap | null>(null);
  const [channelId, setChannelId] = useState<string | null>(() => readChannelFromLocation());
  const [space, setSpace] = useState<string>(readSpaceFromLocation);
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
    () => (readChannelFromLocation() ? "channel" : "list"),
  );
  const [railPreference, setRailPreference] = useState<boolean>(readRailPreference);

  const pendingSend = useRef<PendingSend | null>(null);
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
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

  const isCompact = useMediaQuery("(max-width: 899px)");
  const isMidWidth = useMediaQuery("(max-width: 1199px)");

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
  }, [space, bootstrapSelection]);

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
    writeLocation({ channelId: fallback, space }, true);
  }, [channelId, channels, directs, phase, selectableIds, space]);

  useEffect(() => {
    const onPopState = () => {
      const next = readChannelFromLocation();
      setChannelId(next);
      setSpace(readSpaceFromLocation());
      setPanel({ kind: "none" });
      setCompactView(next ? "channel" : "list");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
  }, [channelId, selection, space]);

  const loadRoster = useCallback(async () => {
    if (!channelId) return;
    const isCurrent = selection.begin();
    try {
      const next = await chatApi.members(channelId, space);
      if (!isCurrent()) return;
      setMembers(next.members ?? []);
    } catch {
      if (!isCurrent()) return;
      setStale(true);
    }
  }, [channelId, selection, space]);

  const loadInvites = useCallback(async () => {
    if (!channelId) return;
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
  }, [channelId, selection, space]);

  useEffect(() => {
    // Abandon everything in flight before the new channel's reads start.
    selection.reset();
    setFeed(null);
    setMembers([]);
    setInvites([]);
    setFeedError(null);
    setPanel({ kind: "none" });
    if (!channelId) return;
    void loadFeed();
    void loadRoster();
    void loadInvites();
  }, [channelId, loadFeed, loadInvites, loadRoster, selection]);

  usePoll(loadFeed, FEED_POLL_MS, phase === "ready" && Boolean(channelId));
  usePoll(loadRoster, ROSTER_POLL_MS, phase === "ready" && Boolean(channelId));

  // The stream only shortens the wait for a posted message. The polls above
  // stay exactly as they were: they remain the fallback when no stream is
  // served, and they are still the only reader of roster and reception, which
  // the current stream contract says nothing about.
  useChannelLive(channelId, phase === "ready", loadFeed, space);

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
    async (input: { body: string; replyToMessageId: string | null; targetActorId: string | null }) => {
      if (!channelId) return false;
      const body = input.body.trim();
      if (!body) return false;

      // One logical send keeps one request id across retries, so a failure we
      // cannot interpret does not turn into two posts.
      const previous = pendingSend.current;
      const sameSend = previous
        && previous.channelId === channelId
        && previous.body === body
        && previous.replyToMessageId === input.replyToMessageId
        && previous.targetActorId === input.targetActorId;
      const requestId = sameSend ? previous!.requestId : newRequestId();
      pendingSend.current = {
        channelId,
        body,
        replyToMessageId: input.replyToMessageId,
        targetActorId: input.targetActorId,
        requestId,
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
        });
      }
      // Only a definite success clears the retry slot.
      pendingSend.current = null;
      await loadFeed();
      void loadRoster();
      return true;
    },
    [channelId, loadFeed, loadRoster, space],
  );

  const onSendChannel = useCallback(() => {
    if (!channelId || sending) return;
    setSendError(null);
    setSending(true);
    void send({ body: draft, replyToMessageId: null, targetActorId: askTargetId })
      .then((sent) => {
        if (sent) {
          setDrafts((current) => ({ ...current, [channelId]: "" }));
          setAskTargets((current) => ({ ...current, [channelId]: null }));
        }
      })
      .catch((error: unknown) => {
        setSendError(
          error instanceof ChatApiError
            ? error.message
            : "That did not send. The text is still here — try again.",
        );
      })
      .finally(() => setSending(false));
  }, [askTargetId, channelId, draft, send, sending]);

  const threadRootId = panel.kind === "thread" ? panel.rootMessageId : null;
  const threadDraft = threadRootId ? threadDrafts[threadRootId] ?? "" : "";

  const onSendThreadReply = useCallback(() => {
    if (!threadRootId || threadSending) return;
    setThreadError(null);
    setThreadSending(true);
    void send({ body: threadDraft, replyToMessageId: threadRootId, targetActorId: null })
      .then((sent) => {
        if (sent) setThreadDrafts((current) => ({ ...current, [threadRootId]: "" }));
      })
      .catch((error: unknown) => {
        setThreadError(
          error instanceof ChatApiError ? error.message : "That reply did not send.",
        );
      })
      .finally(() => setThreadSending(false));
  }, [send, threadDraft, threadRootId, threadSending]);

  /* ── navigation ────────────────────────────────────────────────────────── */

  const selectChannel = useCallback((id: string) => {
    setChannelId(id);
    writeLocation({ channelId: id, space }, false);
    setPanel({ kind: "none" });
    setCompactView("channel");
  }, [space]);

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
    writeLocation({ channelId: null, space: slug }, false);
  }, [space]);

  const openPanel = useCallback((next: PanelView) => {
    setPanel(next);
    setCompactView(next.kind === "none" ? "channel" : "panel");
  }, []);

  const closePanel = useCallback(() => {
    setPanel({ kind: "none" });
    setCompactView("channel");
  }, []);

  const toggleRail = useCallback(() => {
    setRailPreference((current) => {
      writeRailPreference(!current);
      return !current;
    });
  }, []);

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
  }, []);

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
    [loadBootstrap, selectChannel, space],
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
      writeLocation(
        { channelId: created.channel?.id ?? null, space: created.space.slug },
        false,
      );
    },
    [],
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
    [channelId, loadInvites, space, viewer],
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
      // an API participant's mention stays an ordinary post.
      if (isAskableMember(member)) setAskTarget(actorId);
      closePanel();
    },
    [channelId, closePanel, membersById, setAskTarget],
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

  if (phase === "gate" || phase === "error") {
    const isGate = phase === "gate";
    return (
      <ChatSpaceTheme theme={theme} className="chat-centered">
        <div className="chat-card">
          <span className="chat-card-eyebrow">Scout Chat</span>
          <h1>{isGate ? "You are not signed in" : "Scout Chat is unavailable"}</h1>
          <p>
            {isGate
              ? "Open the invitation you were sent to join a channel, or sign in as the host of this Scout."
              : gateMessage ?? "The chat service did not answer."}
          </p>
          {isGate ? (
            <>
              <a className="btn btn--accent" href={`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in as the host</a>
              <p className="chat-card-note">
                Your invitation link signs you into the channel shared with you.
              </p>
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
  const countLabel = peopleAgentLabel(members);
  // Under 900 the sidebar IS the screen; there is no column left to collapse.
  const railed = railPreference && !isCompact;
  const panelOpen = panel.kind !== "none";
  const threadRoot = threadRootId
    ? (feed?.messages ?? []).find((message) => message.id === threadRootId) ?? null
    : null;
  const threadReplyList = threadRootId ? projection.repliesByRoot.get(threadRootId) ?? [] : [];
  const threadRequest = threadRootId
    ? projection.requestsByMessage.get(threadRootId) ?? null
    : null;

  return (
    <ChatSpaceTheme theme={theme} className="chat-space" compactView={compactView} railed={railed}>
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
