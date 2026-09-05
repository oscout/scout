import {
  createClientMessageId,
  pendingConversationFlight,
  settlePendingConversationFlight,
} from "../../lib/client-turn-transition.ts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type {
  ScoutDispatchRecord,
  ScoutDispatchCandidate,
} from "@openscout/protocol";
import { api } from "../../lib/api.ts";
import { uploadMediaFiles, type OutgoingAttachment } from "../../lib/media-blobs.ts";
import { useComposerAttachments } from "../../components/MessageComposer/index.ts";
import {
  canLoadEarlierConversationMessages,
  hasCachedConversationHistory,
  loadConversationHistory,
  loadEarlierConversationMessages,
  loadConversationTail,
  readCachedConversationTail,
  writeCachedConversationTail,
} from "../../lib/chat-cache.ts";
import {
  filterAgentsByMachineScope,
} from "../../lib/machine-scope.ts";
import {
  compactAgentId,
  minimalAgentDisplayName,
} from "../../lib/agent-labels.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import {
  formatAbsoluteTimestamp,
  normalizeTimestampMs,
  timeAgo,
} from "../../lib/time.ts";
import {
  TERMINAL_CONVERSATION_FLIGHT_STATES,
  conversationShortLabel,
  isActiveConversationFlight,
  isConversationWorkingTurnWithoutRecentUpdateAnswered,
  isQueuedUntilOnlineConversationFlight,
  isRequesterWaitTimeoutConversationFlight,
  shouldClearConversationWorkingStateForAgentMessage,
  shouldShowConversationWorkingTurn,
} from "../../lib/conversations.ts";
import { MessageMarkup } from "../../lib/message-markup.tsx";
import {
  dismissConversationFailure,
  loadDismissedConversationFailureIds,
} from "../../lib/conversation-failure-dismissals.ts";
import {
  conversationFailureNotice,
  conversationalTargetLabel,
  isNoisyConversationStatusMessage,
} from "../../lib/message-visibility.ts";
import { dismissOperatorAttention } from "../../lib/operator-attention.ts";
import {
  routeMachineId,
} from "../../lib/router.ts";
import {
  forwardScoutbotUiActionToNativeHost,
  isScoutbotAgent,
} from "../../lib/scoutbot.ts";
import {
  saveLastViewed,
} from "../../lib/sessionRead.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { createForwardContextSource } from "../../lib/forward-context.ts";
import { MessageEmbeds } from "../../components/MessageEmbeds.tsx";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import type {
  Agent,
  AgentObservePayload,
  Flight,
  FleetActivity,
  FleetState,
  FleetAsk,
  Message,
  Route,
  SessionEntry,
} from "../../lib/types.ts";
import { defineSurface } from "../../surfaces/types.ts";
import "./conversation-screen.css";
import "../ops/ops-screen.css";
import {
  AddParticipantForm,
  ConversationHeader,
  ConversationIdentityRow,
  type ConversationHeaderOperator,
  type ConversationHeaderParticipant,
} from "./ConversationHeader.tsx";
import {
  ConversationComposer,
  type ConversationReplyTarget,
} from "./ConversationComposer.tsx";
import { FanOutRow, ThreadDayDivider } from "./ConversationFeedRows.tsx";
import {
  ThreadLoadingSkeleton,
  ThreadMotionPanel,
  WorkingTurnActions,
  WorkingTurnActivityPreview,
  WorkingTurnSteps,
} from "./ConversationPanels.tsx";
import {
  buildTurnStepScope,
  describeTurnLaunchPhase,
  observeTurnSteps,
  latestStepSummary,
  summarizeTurnSteps,
} from "./turn-steps.ts";
import { useTurnSteps } from "./use-turn-steps.ts";
import { ConversationStatusStrip, PinnedAskCard } from "./ConversationStatus.tsx";
import {
  SLASH_COMMANDS,
  WORKING_DURATION_THRESHOLDS_MS,
  buildTurnSnapshot,
  canOpenConversationTerminal,
  conversationIdentityRoute,
  directConversationSessionId,
  deriveWorkingDurationStage,
  deriveDisplayTitle,
  describePresence,
  displayNameForActor,
  emptyFleetState,
  hasOutstandingConversationReply,
  isOperatorMessage,
  invocationTargetsConversation,
  keepPreviousIfJsonEqual,
  latestAgentMessageAt,
  mapEventFlight,
  mergeCanonicalMessagesPreservingPending,
  matchMentionTrigger,
  matchSlashTrigger,
  messageClassLabel,
  parseAskReplyTag,
  pathLeaf,
  buildConversationFeedRows,
  shouldShowThreadDayDivider,
  optimisticMessageIndexForClientId,
  readScoutDispatch,
  resolveAgentByIdentity,
  resolveComposeAction,
  resolveConversationAutoscroll,
  resolveAskReplyContext,
  resolveMessageAgent,
  resolveThreadEmbedProps,
  describeQueuedDrafts,
  resolveSendDisposition,
  shouldFlushQueue,
  type BusySendIntent,
  type QueuedDraft,
  selectCurrentFlight,
  selectOperatorPendingAsk,
  selectTurnActivity,
  selectTurnAsk,
  sortMessages,
  type ComposeAction,
  type ConversationPresence,
  type EventFlightRecord,
  type EventInvocationRecord,
  type EventMessageRecord,
  type MentionCandidate,
  type MentionSuggestState,
  type MotionTone,
  type SendResult,
  type SlashCommand,
  type SlashSuggestState,
  type ThreadTreatment,
} from "./conversation-model.ts";

/** Observe-trace refresh cadence while a working turn is on screen. */
const WORKING_TURN_TRACE_POLL_MS = 3_500;

function messageIdFromLocationHash(hash: string | null | undefined): string | null {
  const raw = hash?.trim().replace(/^#/, "");
  if (!raw?.startsWith("msg-")) return null;
  const id = raw.slice("msg-".length).trim();
  if (!id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

type ConversationMessageLoadMode = "initial" | "refresh" | "none";
type SendAttemptOutcome = "sent" | "failed" | "unknown";
type QueuedConversationDraft = QueuedDraft & {
  replyTarget?: ConversationReplyTarget | null;
};

const CONVERSATION_TAIL_THRESHOLD_PX = 64;

function clientMessageIdFromMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.["clientMessageId"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function messageReplyPreview(message: Message): string {
  const body = message.body.replace(/\s+/gu, " ").trim();
  if (body) {
    return body.length > 180
      ? `${body.slice(0, 179).trimEnd()}…`
      : body;
  }
  const attachmentCount = message.attachments?.length ?? 0;
  return attachmentCount === 1
    ? "Attachment"
    : attachmentCount > 1
      ? `${attachmentCount} attachments`
      : "Message";
}

function removeInsertedMention(draft: string, mention: string): string {
  const index = draft.toLocaleLowerCase().indexOf(mention.toLocaleLowerCase());
  if (index < 0) return draft;
  const before = draft.slice(0, index);
  const after = draft.slice(index + mention.length);
  if (!before && after.startsWith(" ")) return after.slice(1);
  if (before.endsWith(" ") && after.startsWith(" ")) {
    return `${before}${after.slice(1)}`;
  }
  return `${before}${after}`;
}

function isAmbiguousTransportFailure(cause: unknown): boolean {
  return cause instanceof TypeError
    || (typeof DOMException !== "undefined"
      && cause instanceof DOMException
      && cause.name === "AbortError");
}



export function ConversationScreen({
  conversationId,
  initialDraft,
  navigate,
  embedded,
  showBackNav = true,
  treatment = "standard",
}: {
  conversationId: string;
  initialDraft?: string;
  navigate: (r: Route) => void;
  embedded?: boolean;
  showBackNav?: boolean;
  /// How the thread is presented — see the "Presentations" block in
  /// conversation-screen.css. "standard" is the shipping bordered card;
  /// ledger/rail/document come from the readability study.
  treatment?: ThreadTreatment;
}) {
  const { agents, route, openContextCapture } = useScout();
  const machineId = routeMachineId(route);
  const scopedAgents = useMemo(
    () => filterAgentsByMachineScope(agents, machineId),
    [agents, machineId],
  );
  const [sessionMeta, setSessionMeta] = useState<SessionEntry | null>(null);
  const sessionMetaRef = useRef<SessionEntry | null>(null);
  sessionMetaRef.current = sessionMeta;
  const cachedTail = useMemo(
    () => readCachedConversationTail(conversationId),
    [conversationId],
  );
  const [messagesByConversationId, setMessagesByConversationId] = useState<
    Record<string, Message[]>
  >(() => cachedTail ? { [conversationId]: cachedTail } : {});
  const messages = messagesByConversationId[conversationId] ?? cachedTail ?? [];

  /* Arrival + loading.
   *
   * Two gaps this closes. First, the transcript fetch leaves the feed empty for
   * a beat — worse behind a web view, where the host is also booting — and an
   * empty feed reads as "no messages" rather than "not yet". Ghost turns say
   * the honest thing. Second, a landed turn simply appeared; the only motion in
   * the thread was a permalink flash.
   *
   * Deliberately quiet: opacity and a 4px rise, composited, ~220ms. No
   * character streaming, no bouncing dots. The first paint staggers a few rows
   * so the thread assembles rather than blinking in, capped so a 300-message
   * history never becomes a wave. */
  const [threadSettled, setThreadSettled] = useState(() => cachedTail !== null);
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  const enteringIds = useMemo(() => {
    const seen = seenMessageIdsRef.current;
    if (seen === null) return null; // first paint — staggered below
    return new Set(messages.filter((m) => !seen.has(m.id)).map((m) => m.id));
  }, [messages]);
  const isFirstPaint = seenMessageIdsRef.current === null && messages.length > 0;

  useEffect(() => {
    if (messages.length === 0) return;
    const seen = seenMessageIdsRef.current ?? new Set<string>();
    for (const message of messages) seen.add(message.id);
    seenMessageIdsRef.current = seen;
  }, [messages]);

  // A conversation switch is a different thread: forget what was on screen so
  // the new one gets its own entrance instead of inheriting the old one's.
  useEffect(() => {
    seenMessageIdsRef.current = null;
    setThreadSettled(readCachedConversationTail(conversationId) !== null);
  }, [conversationId]);

  const showThreadSkeleton = !threadSettled && messages.length === 0;
  const setMessages = useCallback((update: SetStateAction<Message[]>) => {
    setMessagesByConversationId((previousByConversationId) => {
      const previous = previousByConversationId[conversationId]
        ?? readCachedConversationTail(conversationId)
        ?? [];
      const next = typeof update === "function" ? update(previous) : update;
      const cached = writeCachedConversationTail(conversationId, next);
      return {
        ...previousByConversationId,
        [conversationId]: cached,
      };
    });
  }, [conversationId]);
  const stagedFlight = pendingConversationFlight(conversationId);
  const [currentFlight, setCurrentFlight] = useState<Flight | null>(stagedFlight);
  const [turnActivity, setTurnActivity] = useState<FleetActivity[]>([]);
  const [turnObserve, setTurnObserve] = useState<AgentObservePayload | null>(null);
  const [turnAsk, setTurnAsk] = useState<FleetAsk | null>(null);
  const [hashMessageId, setHashMessageId] = useState(() =>
    typeof window === "undefined" ? null : messageIdFromLocationHash(window.location.hash),
  );
  const [error, setError] = useState<string | null>(null);
  const [dismissedFailureMessageIds, setDismissedFailureMessageIds] = useState(() =>
    loadDismissedConversationFailureIds(conversationId)
  );
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  const [feedPaused, setFeedPaused] = useState(false);
  const [pendingNewMessageCount, setPendingNewMessageCount] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const pendingHistoryScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const autoScrollActiveRef = useRef(false);
  const autoScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const trackedInvocationIdsRef = useRef<Set<string>>(new Set());
  const currentFlightRef = useRef<Flight | null>(null);
  const lastForegroundRefreshAtRef = useRef(0);
  const appliedInitialDraftKeyRef = useRef<string | null>(null);
  const lastPostedReadCursorMessageIdRef = useRef<string | null>(null);
  const reconciledFailureDismissalsRef = useRef(new Set<string>());
  const activeConversationIdRef = useRef(conversationId);
  activeConversationIdRef.current = conversationId;
  const optimisticMessageIdByClientIdRef = useRef(new Map<string, string>());
  const canLoadEarlierMessages =
    canLoadEarlierConversationMessages(conversationId);

  // Set by the layout effect below and read by the autoscroll effect later in
  // the same commit: by then `pendingHistoryScrollRef` has already been
  // consumed, so this is what tells autoscroll to stand down.
  const historyRestoreAppliedRef = useRef(false);

  useLayoutEffect(() => {
    const pending = pendingHistoryScrollRef.current;
    const feed = feedRef.current;
    if (!pending || !feed) return;
    feed.scrollTop = pending.scrollTop + (feed.scrollHeight - pending.scrollHeight);
    pendingHistoryScrollRef.current = null;
    historyRestoreAppliedRef.current = true;
  });

  useEffect(() => {
    setLoadingEarlierMessages(false);
    pendingHistoryScrollRef.current = null;
    historyRestoreAppliedRef.current = false;
    wasAtBottomRef.current = true;
    autoScrollActiveRef.current = false;
    setFeedPaused(false);
    setPendingNewMessageCount(0);
    setExpandedFanOutKeys(new Set());
    optimisticMessageIdByClientIdRef.current.clear();
    setCurrentFlight(pendingConversationFlight(conversationId));
    setDismissedFailureMessageIds(loadDismissedConversationFailureIds(conversationId));
  }, [conversationId]);

  const persistConversationFailureDismissal = useCallback(async (message: Message) => {
    const explicitFlightId = typeof message.metadata?.["flightId"] === "string"
      ? message.metadata["flightId"].trim()
      : "";
    let flightId = explicitFlightId;
    if (!flightId && message.replyToMessageId) {
      try {
        const flights = await api<Flight[]>(
          `/api/flights?conversationId=${encodeURIComponent(conversationId)}&active=false`,
        );
        flightId = flights.find((flight) => flight.messageId === message.replyToMessageId)?.id ?? "";
      } catch {
        // The conversation-level acknowledgement below is sufficient to keep
        // this exact failed turn out of native chrome even when the optional
        // flight lookup is temporarily unavailable.
      }
    }
    await dismissOperatorAttention({
      ...(flightId ? { flightId } : {}),
      conversationId,
      messageId: message.replyToMessageId ?? message.id,
      itemUpdatedAt: normalizeTimestampMs(message.createdAt) ?? Date.now(),
    });
  }, [conversationId]);

  const clearConversationFailure = useCallback((message: Message) => {
    const attentionMessageId = message.replyToMessageId ?? message.id;
    setDismissedFailureMessageIds(
      dismissConversationFailure(conversationId, message.id),
    );
    // The macOS shell owns the conversation list. Clear the matching failed
    // turn there optimistically as well; the durable acknowledgement below
    // prevents the next channel refresh from restoring it.
    forwardScoutbotUiActionToNativeHost({
      type: "dismiss-conversation-failure",
      conversationId,
      messageId: attentionMessageId,
      reason: "The operator cleared this delivery issue",
    });
    const key = `${conversationId}:${message.id}`;
    reconciledFailureDismissalsRef.current.add(key);
    void persistConversationFailureDismissal(message).catch(() => {
      // Clearing the reading-surface notice is still valid if the durable
      // attention acknowledgement cannot be reached; the flight remains in
      // the dispatch ledger for later inspection.
      reconciledFailureDismissalsRef.current.delete(key);
    });
  }, [conversationId, persistConversationFailureDismissal]);

  useEffect(() => {
    for (const message of messages) {
      if (
        !dismissedFailureMessageIds.has(message.id)
        || !conversationFailureNotice(message)
      ) {
        continue;
      }
      const key = `${conversationId}:${message.id}`;
      if (reconciledFailureDismissalsRef.current.has(key)) continue;
      reconciledFailureDismissalsRef.current.add(key);
      void persistConversationFailureDismissal(message).catch(() => {
        reconciledFailureDismissalsRef.current.delete(key);
      });
    }
  }, [conversationId, dismissedFailureMessageIds, messages, persistConversationFailureDismissal]);

  const agentId = sessionMeta?.agentId ?? null;
  const isDm = sessionMeta?.kind === "direct";
  const equivalentConversationIds = useMemo(
    () => new Set([
      conversationId,
      ...(sessionMeta?.equivalentConversationIds ?? []),
    ]),
    [conversationId, sessionMeta?.equivalentConversationIds],
  );
  const agent = useMemo<Agent | null>(
    () =>
      agentId ? (scopedAgents.find((item) => item.id === agentId) ?? null) : null,
    [scopedAgents, agentId],
  );
  const conversationSessionId = directConversationSessionId(sessionMeta);
  const conversationDetailRoute = conversationIdentityRoute({
    resolvedAgentId: agent?.id,
    sessionId: conversationSessionId,
    machineId,
  });

  const [pinnedAsk, setPinnedAsk] = useState<FleetAsk | null>(null);

  useEffect(() => {
    api<FleetState>("/api/fleet")
      .then((fleet) => {
        setPinnedAsk((previous) =>
          keepPreviousIfJsonEqual(
            previous,
            selectOperatorPendingAsk(fleet.activeAsks, conversationId, agentId),
          ),
        );
      })
      .catch(() => {});
  }, [conversationId, agentId]);

  const load = useCallback(async (
    options: {
      messageMode?: ConversationMessageLoadMode;
      includeMetadata?: boolean;
    } = {},
  ) => {
    const messageMode = options.messageMode ?? "none";
    const includeMetadata = options.includeMetadata ?? true;
    setError(null);
    try {
      const meta = includeMetadata
        ? await api<SessionEntry>(
            `/api/session/${encodeURIComponent(conversationId)}`,
          ).catch(() => null)
        : sessionMetaRef.current;

      if (activeConversationIdRef.current !== conversationId) return;

      setSessionMeta((previous) => keepPreviousIfJsonEqual(previous, meta));
      const resolvedAgentId = meta?.agentId ?? null;

      const canonicalConversationId =
        meta?.id && meta.id !== conversationId
          ? meta.id
          : conversationId;

      if (canonicalConversationId !== conversationId) {
        navigate({
          view: "conversation",
          conversationId: canonicalConversationId,
        });
        return;
      }

      const cachedMessages = readCachedConversationTail(canonicalConversationId);
      const historyIsCached = hasCachedConversationHistory(
        canonicalConversationId,
      );
      const shouldLoadHistory = messageMode === "initial" && !historyIsCached;
      // A warm cache is an arrival optimization, never proof that the mounted
      // transcript is current. Always reconcile once on mount/selection; this
      // closes missed-event and broker-restart gaps even when the summary
      // projection is itself stale.
      const shouldRefreshTail = messageMode === "refresh"
        || messageMode === "initial";

      const secondaryState = Promise.all([
        api<Flight[]>(
          `/api/flights?conversationId=${encodeURIComponent(canonicalConversationId)}`,
        ).catch(() => []),
        api<FleetState>("/api/fleet?limit=24&activityLimit=160").catch(() =>
          emptyFleetState(),
        ),
      ]);
      const conversationMessages = await (shouldLoadHistory
        ? loadConversationHistory(canonicalConversationId)
        : shouldRefreshTail
          ? loadConversationTail(canonicalConversationId, { refresh: true })
          : Promise.resolve(cachedMessages));

      if (activeConversationIdRef.current !== conversationId) return;

      const sortedMessages = sortMessages(conversationMessages ?? []);
      const visibleMessages = sortedMessages.filter(
        (message) => !isNoisyConversationStatusMessage(message),
      );
      if (conversationMessages) {
        setMessages((previous) => keepPreviousIfJsonEqual(
          previous,
          mergeCanonicalMessagesPreservingPending(previous, visibleMessages),
        ));
      }
      setThreadSettled(true);
      saveLastViewed(canonicalConversationId);
      const lastMessage = sortedMessages.at(-1);
      if (
        lastMessage &&
        lastPostedReadCursorMessageIdRef.current !== lastMessage.id
      ) {
        lastPostedReadCursorMessageIdRef.current = lastMessage.id;
        void api(`/api/conversations/${encodeURIComponent(canonicalConversationId)}/read-cursor`, {
          method: "POST",
          body: JSON.stringify({ lastReadMessageId: lastMessage.id }),
        }).catch(() => {
          if (lastPostedReadCursorMessageIdRef.current === lastMessage.id) {
            lastPostedReadCursorMessageIdRef.current = null;
          }
        });
      }
      // Transcript arrival is the user-visible ready point. Flights and fleet
      // decorate the live-turn rail; a slow roster scan must never hold the
      // history skeleton or composer geometry on screen.
      const [activeFlights, fleet] = await secondaryState;
      if (activeConversationIdRef.current !== conversationId) return;
      const projectedCurrentFlight = selectCurrentFlight(activeFlights);
      const stagedCurrentFlight = pendingConversationFlight(canonicalConversationId);
      const nextCurrentFlight = projectedCurrentFlight ?? stagedCurrentFlight;
      trackedInvocationIdsRef.current = new Set([
        ...activeFlights.map((flight) => flight.invocationId),
        ...(stagedCurrentFlight?.invocationId?.startsWith("pending:")
          ? []
          : stagedCurrentFlight?.invocationId
            ? [stagedCurrentFlight.invocationId]
            : []),
      ]);
      if (projectedCurrentFlight && stagedCurrentFlight?.id === projectedCurrentFlight.id) {
        settlePendingConversationFlight(canonicalConversationId, projectedCurrentFlight.id);
      }
      const turnAgentId = nextCurrentFlight?.agentId ?? resolvedAgentId ?? null;
      const nextTurnActivity = selectTurnActivity(
        fleet.activity,
        nextCurrentFlight,
        canonicalConversationId,
        turnAgentId,
      );
      const nextTurnAsk = selectTurnAsk(
        fleet.activeAsks,
        nextCurrentFlight,
        canonicalConversationId,
        turnAgentId,
      );
      setCurrentFlight((previous) =>
        keepPreviousIfJsonEqual(previous, nextCurrentFlight),
      );
      setTurnActivity((previous) =>
        keepPreviousIfJsonEqual(previous, nextTurnActivity),
      );
      setTurnAsk((previous) => keepPreviousIfJsonEqual(previous, nextTurnAsk));
      setPinnedAsk((previous) =>
        keepPreviousIfJsonEqual(
          previous,
          selectOperatorPendingAsk(
            fleet.activeAsks,
            canonicalConversationId,
            resolvedAgentId,
          ),
        ),
      );
    } catch (cause) {
      if (activeConversationIdRef.current !== conversationId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [conversationId, navigate, setMessages]);

  useEffect(() => {
    void load({ messageMode: "initial" });
  }, [load]);

  useEffect(() => {
    lastPostedReadCursorMessageIdRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    currentFlightRef.current = currentFlight;
  }, [currentFlight]);

  const loadEarlierMessages = useCallback(async () => {
    if (loadingEarlierMessages || !canLoadEarlierConversationMessages(conversationId)) {
      return;
    }
    const feed = feedRef.current;
    const scrollSnapshot = feed
      ? { scrollHeight: feed.scrollHeight, scrollTop: feed.scrollTop }
      : null;
    setLoadingEarlierMessages(true);
    setError(null);
    try {
      const loaded = await loadEarlierConversationMessages(conversationId);
      if (activeConversationIdRef.current !== conversationId) return;
      if (scrollSnapshot) {
        pendingHistoryScrollRef.current = scrollSnapshot;
      }
      setMessages(
        sortMessages(loaded).filter(
          (message) => !isNoisyConversationStatusMessage(message),
        ),
      );
    } catch (cause) {
      if (activeConversationIdRef.current === conversationId) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (activeConversationIdRef.current === conversationId) {
        setLoadingEarlierMessages(false);
      }
    }
  }, [conversationId, loadingEarlierMessages, setMessages]);

  const [draft, setDraft] = useState(() => initialDraft ?? "");
  const [replyTarget, setReplyTarget] = useState<ConversationReplyTarget | null>(null);
  const [sending, setSending] = useState(false);
  const [operatorName, setOperatorName] = useState("operator");
  const [slashState, setSlashState] = useState<SlashSuggestState>({
    open: false,
    query: "",
    triggerStart: -1,
    index: 0,
  });
  const [mentionState, setMentionState] = useState<MentionSuggestState>({
    open: false,
    query: "",
    triggerStart: -1,
    index: 0,
  });
  const [awaitingResponseSince, setAwaitingResponseSince] = useState<
    number | null
  >(null);
  const [addParticipantOpen, setAddParticipantOpen] = useState(false);
  const [addParticipantId, setAddParticipantId] = useState("");
  const [addParticipantError, setAddParticipantError] = useState<string | null>(null);
  const [addingParticipant, setAddingParticipant] = useState(false);

  useEffect(() => {
    setAddParticipantOpen(false);
    setAddParticipantId("");
    setAddParticipantError(null);
    setAddingParticipant(false);
  }, [conversationId]);

  useEffect(() => {
    if (!initialDraft) return;
    const draftKey = `${conversationId}:${initialDraft}`;
    if (appliedInitialDraftKeyRef.current === draftKey) return;
    appliedInitialDraftKeyRef.current = draftKey;
    setDraft(initialDraft);
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [conversationId, initialDraft]);

  const participantMetaById = useMemo(() => {
    const entries = new Map<
      string,
      NonNullable<SessionEntry["participants"]>[number]
    >();
    for (const participant of sessionMeta?.participants ?? []) {
      entries.set(participant.actorId, participant);
      if (participant.agentId) entries.set(participant.agentId, participant);
    }
    return entries;
  }, [sessionMeta]);

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const seen = new Set<string>();
    const list: MentionCandidate[] = [];
    for (const participantId of sessionMeta?.participantIds ?? []) {
      if (participantId === "operator") continue;
      const participant = participantMetaById.get(participantId);
      const handleRaw = participant?.scopedAlias?.trim().replace(/^@+/, "");
      if (!handleRaw) continue;
      const key = handleRaw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        id: participantId,
        label: participant?.label ?? participant?.displayName ?? handleRaw,
        name: participant?.displayName ?? handleRaw,
        handle: handleRaw,
      });
    }
    for (const a of scopedAgents) {
      const handleRaw = a.handle?.trim().replace(/^@+/, "") ?? compactAgentId(a.id) ?? a.id;
      if (!handleRaw) continue;
      const key = handleRaw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        id: a.id,
        label: handleRaw,
        name: a.name ?? handleRaw,
        handle: handleRaw,
      });
    }
    return list.sort((a, b) => a.handle.localeCompare(b.handle));
  }, [participantMetaById, scopedAgents, sessionMeta]);

  const filteredSlashCommands = useMemo(() => {
    if (!slashState.open) return [];
    const q = slashState.query.toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (c) =>
        c.command.toLowerCase().startsWith("/" + q) ||
        c.command.toLowerCase().includes(q),
    );
  }, [slashState.open, slashState.query]);

  const filteredMentions = useMemo(() => {
    if (!mentionState.open) return [];
    const q = mentionState.query.toLowerCase();
    if (!q) return mentionCandidates.slice(0, 8);
    return mentionCandidates
      .filter(
        (c) =>
          c.handle.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.label.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [mentionState.open, mentionState.query, mentionCandidates]);

  const closeSuggestions = useCallback(() => {
    setSlashState((s) => (s.open ? { ...s, open: false } : s));
    setMentionState((s) => (s.open ? { ...s, open: false } : s));
  }, []);

  const updateTriggersFromDraft = useCallback(
    (value: string, caret: number) => {
      const slashMatch = matchSlashTrigger(value, caret);
      if (slashMatch) {
        setSlashState((prev) => ({
          open: true,
          query: slashMatch.query,
          triggerStart: slashMatch.start,
          index:
            prev.open && prev.triggerStart === slashMatch.start ? prev.index : 0,
        }));
      } else {
        setSlashState((prev) => (prev.open ? { ...prev, open: false } : prev));
      }

      const mentionMatch = matchMentionTrigger(value, caret);
      if (mentionMatch) {
        setMentionState((prev) => ({
          open: true,
          query: mentionMatch.query,
          triggerStart: mentionMatch.start,
          index:
            prev.open && prev.triggerStart === mentionMatch.start
              ? prev.index
              : 0,
        }));
      } else {
        setMentionState((prev) => (prev.open ? { ...prev, open: false } : prev));
      }
    },
    [],
  );

  const applySlashCommand = useCallback(
    (command: SlashCommand) => {
      const textarea = composeRef.current;
      const start = slashState.triggerStart;
      if (start < 0) return;
      const caret = textarea?.selectionStart ?? draft.length;
      const before = draft.slice(0, start);
      const after = draft.slice(caret);
      const insert = command.insert;
      const next = `${before}${insert}${after}`;
      setDraft(next);
      setSlashState((s) => ({ ...s, open: false }));
      requestAnimationFrame(() => {
        const el = composeRef.current;
        if (!el) return;
        const pos = before.length + insert.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [draft, slashState.triggerStart],
  );

  const applyMention = useCallback(
    (candidate: MentionCandidate) => {
      const textarea = composeRef.current;
      const start = mentionState.triggerStart;
      if (start < 0) return;
      const caret = textarea?.selectionStart ?? draft.length;
      const before = draft.slice(0, start);
      const after = draft.slice(caret);
      const needsSpace = after.length === 0 || !after.startsWith(" ");
      const insert = `@${candidate.handle}${needsSpace ? " " : ""}`;
      const next = `${before}${insert}${after}`;
      setDraft(next);
      setMentionState((s) => ({ ...s, open: false }));
      requestAnimationFrame(() => {
        const el = composeRef.current;
        if (!el) return;
        const pos = before.length + insert.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [draft, mentionState.triggerStart],
  );

  useEffect(() => {
    const element = composeRef.current;
    if (!element) return;
    element.style.height = "0px";
    const nextHeight = Math.min(Math.max(element.scrollHeight, 40), 160);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY =
      element.scrollHeight > nextHeight ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    api<{ name: string }>("/api/user")
      .then((user) => setOperatorName(user.name))
      .catch(() => {});
  }, []);

  const lastAgentReplyAt = useMemo(
    () => latestAgentMessageAt(messages, operatorName),
    [messages, operatorName],
  );

  useEffect(() => {
    if (awaitingResponseSince === null || lastAgentReplyAt === null) return;
    if (lastAgentReplyAt >= awaitingResponseSince) {
      setAwaitingResponseSince(null);
    }
  }, [awaitingResponseSince, lastAgentReplyAt]);

  const rawShowWorkingTurn = useMemo(() => {
    return shouldShowConversationWorkingTurn(currentFlight);
  }, [currentFlight]);
  const currentNowMs = Date.now();
  const quietWorkingTurnHasNewerReply =
    isConversationWorkingTurnWithoutRecentUpdateAnswered(
      currentFlight,
      lastAgentReplyAt,
      currentNowMs,
    );
  const showWorkingTurn =
    rawShowWorkingTurn &&
    !isQueuedUntilOnlineConversationFlight(currentFlight) &&
    !quietWorkingTurnHasNewerReply;
  const shouldPollOutstandingTurn =
    isDm && (sending || awaitingResponseSince !== null || showWorkingTurn);
  const hasOutstandingReply =
    isDm &&
    hasOutstandingConversationReply({
      sending,
      awaitingResponse: awaitingResponseSince !== null,
      currentFlight,
    });

  const agentName = minimalAgentDisplayName({
    name: agent?.name,
    agentName: sessionMeta?.agentName,
    id: agentId,
    title: sessionMeta?.title,
  });
  const presence = useMemo(
    () => {
      if (!isDm) {
        return {
          label: "Open",
          detail: "",
          tone: "idle",
          showStrip: false,
          showTyping: false,
        } satisfies ConversationPresence;
      }
      return describePresence({
        agentName,
        agentState: agent?.state ?? null,
        sending,
        currentFlight,
        showWorkingTurn,
        awaitingResponse: awaitingResponseSince !== null,
      });
    },
    [
      agent?.state,
      agentName,
      awaitingResponseSince,
      currentFlight,
      currentNowMs,
      isDm,
      sending,
      showWorkingTurn,
    ],
  );
  const turnMotionStartedAt =
    currentFlight?.startedAt ?? turnAsk?.startedAt ?? awaitingResponseSince;
  const normalizedTurnMotionStartedAt = normalizeTimestampMs(turnMotionStartedAt);
  const workingDurationStage = deriveWorkingDurationStage(
    turnMotionStartedAt,
    currentNowMs,
  );
  const [, setWorkingDurationTick] = useState(0);

  useEffect(() => {
    if (
      !presence.showTyping ||
      normalizedTurnMotionStartedAt === null
    ) {
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - normalizedTurnMotionStartedAt);
    const nextThresholdMs = [
      WORKING_DURATION_THRESHOLDS_MS.sustained,
      WORKING_DURATION_THRESHOLDS_MS.long,
    ].find((thresholdMs) => thresholdMs > elapsedMs);
    if (nextThresholdMs === undefined) return;

    const timer = window.setTimeout(
      () => setWorkingDurationTick((value) => value + 1),
      nextThresholdMs - elapsedMs + 50,
    );
    return () => window.clearTimeout(timer);
  }, [
    normalizedTurnMotionStartedAt,
    presence.showTyping,
    workingDurationStage,
  ]);
  const workingTurnBadgeLabel = "Live";
  const workingTurnSnapshot = useMemo(
    () =>
      buildTurnSnapshot({
        currentFlight,
        presence,
        turnActivity,
        turnAsk,
        awaitingResponseSince,
        nowMs: currentNowMs,
      }),
    [awaitingResponseSince, currentFlight, currentNowMs, presence, turnActivity, turnAsk],
  );
  const workingTurnCardClassName =
    "s-thread-msg-card s-thread-msg-working-card s-thread-msg-card--avatar-row";
  const workingTurnKindClassName = "s-thread-msg-kind";
  const workingTurnSnapshotClassName = "s-thread-turn-snapshot";
  const workingTurnPulseClassName = "s-thread-turn-snapshot-pulse";
  const presenceLineClassName = "s-thread-presence-line";
  const presenceStripClassName = [
    "s-thread-presence-strip",
    `s-thread-presence-strip--${workingDurationStage}`,
  ]
    .filter(Boolean)
    .join(" ");
  const threadTitle = sessionMeta ? deriveDisplayTitle(sessionMeta) : agentName;
  const canonicalConversationId = sessionMeta?.id ?? conversationId;
  const conversationAlias = sessionMeta?.alias?.trim() || null;
  const workspaceName = pathLeaf(sessionMeta?.workspaceRoot);
  const turnMotionTone: MotionTone = presence.tone;
  const showEmptyMotionPanel =
    messages.length === 0 &&
    isDm &&
    (presence.showTyping ||
      currentFlight !== null ||
      turnActivity.length > 0 ||
      turnAsk !== null ||
      awaitingResponseSince !== null);
  const operatorIsParticipant = useMemo(() => {
    if (sessionMeta) return sessionMeta.participantIds.includes("operator");
    return isDm;
  }, [isDm, sessionMeta]);

  const workingAgentId = currentFlight?.agentId ?? agentId;
  const workingAgent = workingAgentId
    ? resolveAgentByIdentity(scopedAgents, [workingAgentId])
    : null;
  // Carry the working turn's concrete refs alongside the flight id: a native
  // host resolves them straight to the live session viewer, and the web
  // flight-observe screen opens on the session that was live when clicked.
  const workingTraceAgentId = workingAgent?.id ?? workingAgentId;
  const workingTraceSessionId = currentFlight?.sessions.at(-1)?.sessionId
    ?? workingAgent?.harnessSessionId
    ?? undefined;
  const openWorkingTrace = currentFlight?.id
    ? () => {
        openContent(
          navigate,
          {
            view: "sessions",
            flightId: currentFlight.id,
            ...(workingTraceAgentId ? { agentId: workingTraceAgentId } : {}),
            ...(workingTraceSessionId ? { sessionId: workingTraceSessionId } : {}),
            ...(machineId ? { machineId } : {}),
          },
          { returnTo: route },
        );
      }
    : undefined;

  // While a turn is live, follow the working agent's observe trace so the
  // in-thread card reports the actual steps instead of "still working".
  const activeFlightId = currentFlight?.id ?? null;
  useEffect(() => {
    if (!activeFlightId || !workingTraceAgentId) {
      setTurnObserve(null);
      return;
    }
    let cancelled = false;
    const query = workingTraceSessionId
      ? `?sessionId=${encodeURIComponent(workingTraceSessionId)}`
      : "";
    const poll = async () => {
      try {
        const payload = await api<AgentObservePayload>(
          `/api/agents/${encodeURIComponent(workingTraceAgentId)}/observe${query}`,
        );
        if (cancelled) return;
        setTurnObserve((previous) => keepPreviousIfJsonEqual(previous, payload));
      } catch {
        // An unavailable trace (fresh session, remote node) is the quiet
        // non-error case; the card falls back to broker flight events.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), WORKING_TURN_TRACE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      setTurnObserve(null);
    };
  }, [activeFlightId, workingTraceAgentId, workingTraceSessionId]);

  // Step ledger for the working turn. Tail is the live rail (sub-second, with
  // tool name/argument structure intact); the observe poll above is the
  // fallback for sessions whose transcript this host cannot tail. Before either
  // has anything, the launch phase says which stage the turn is actually in.
  const turnStepScope = useMemo(
    () =>
      buildTurnStepScope({
        flight: currentFlight,
        agent: workingAgent ?? agent,
        sessionMeta,
        observeSessionId: turnObserve?.sessionId,
      }),
    [agent, currentFlight, sessionMeta, turnObserve?.sessionId, workingAgent],
  );
  const tailTurnSteps = useTurnSteps({
    sessionIds: turnStepScope,
    active: presence.showTyping || showEmptyMotionPanel,
  });
  const observeSteps = useMemo(
    () => observeTurnSteps({ observe: turnObserve, flight: currentFlight }),
    [currentFlight, turnObserve],
  );
  const workingTurnSteps = tailTurnSteps.length > 0 ? tailTurnSteps : observeSteps;
  const workingTurnPhase = useMemo(
    () =>
      workingTurnSteps.length > 0
        ? null
        : describeTurnLaunchPhase({
            flight: currentFlight,
            hasSessionScope: turnStepScope.length > 0,
            awaitingResponse: awaitingResponseSince !== null,
          }),
    [awaitingResponseSince, currentFlight, turnStepScope.length, workingTurnSteps.length],
  );
  // The broker's own snapshot says "No activity yet" for a turn that has
  // already run a dozen tools; when we hold real steps they take over the
  // headline and the stats so every reading of the card agrees with the
  // ledger underneath.
  const workingTurnStepSummary = summarizeTurnSteps(workingTurnSteps);
  const workingTurnLatestStep = latestStepSummary(workingTurnSteps);
  const lastWorkingTurnStep = workingTurnSteps.at(-1) ?? null;
  const workingTurnLastStepLabel = lastWorkingTurnStep
    ? timeAgo(lastWorkingTurnStep.ts, currentNowMs)
    : null;
  const displayTurnSnapshot = useMemo(() => {
    if (!workingTurnLatestStep) return workingTurnSnapshot;
    return {
      ...workingTurnSnapshot,
      latest: workingTurnLatestStep,
      ...(workingTurnStepSummary ? { activityLabel: workingTurnStepSummary } : {}),
      ...(workingTurnLastStepLabel ? { lastActivityLabel: workingTurnLastStepLabel } : {}),
    };
  }, [
    workingTurnLastStepLabel,
    workingTurnLatestStep,
    workingTurnSnapshot,
    workingTurnStepSummary,
  ]);
  const presenceLineLabel = `${agentName}: ${displayTurnSnapshot.latest}`;

  const openWorkingTerminal = workingAgentId && canOpenConversationTerminal(workingAgent)
    ? () => {
        openContent(
          navigate,
          { view: "terminal", agentId: workingAgentId, mode: "takeover" },
          { returnTo: route },
        );
      }
    : undefined;
  const focusSteerComposer = isDm
    ? () => {
        if (embedded && forwardScoutbotUiActionToNativeHost({
          type: "focus-composer",
          reason: "Steer the active conversation",
        })) return;
        requestAnimationFrame(() => {
          composeRef.current?.focus({ preventScroll: true });
          composeRef.current?.scrollIntoView({ block: "nearest" });
        });
      }
    : undefined;
  const headerParticipants = useMemo<ConversationHeaderParticipant[]>(() => {
    const participantIds = sessionMeta
      ? sessionMeta.participantIds.filter((id) => id !== "operator")
      : agentId
        ? [agentId]
        : [];
    return participantIds.map((id) => {
      const participantAgent = resolveAgentByIdentity(scopedAgents, [id]);
      const meta = participantMetaById.get(id);
      return {
        id,
        name: meta?.scopedAlias ?? participantAgent?.name ?? meta?.displayName ?? compactAgentId(id) ?? id,
        title: meta?.label ?? participantAgent?.id ?? id,
        agent: participantAgent,
        sessionId: meta?.sessionId ?? null,
        harness: participantAgent?.harness ?? meta?.harness ?? null,
        model: participantAgent?.model ?? null,
        reasoningEffort: participantAgent?.reasoningEffort ?? null,
      } satisfies ConversationHeaderParticipant;
    });
  }, [agentId, participantMetaById, scopedAgents, sessionMeta]);
  const headerOperator = useMemo<ConversationHeaderOperator>(
    () => ({ name: operatorName, active: operatorIsParticipant }),
    [operatorIsParticipant, operatorName],
  );

  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const scoutbotConversationId = useMemo(
    () => scopedAgents.find((candidate) =>
      isScoutbotAgent(candidate) && Boolean(candidate.conversationId?.trim())
    )?.conversationId?.trim() ?? null,
    [scopedAgents],
  );

  /// The feed's rows, with one kickoff's per-recipient deliveries folded back
  /// into the single event they came from. Expansion is per row and sticky for
  /// the life of the screen: a reader who opened one to check the recipients
  /// should not have it snap shut under them when the next turn lands.
  const feedRows = useMemo(() => buildConversationFeedRows(messages), [messages]);
  const [expandedFanOutKeys, setExpandedFanOutKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleFanOut = useCallback((key: string) => {
    setExpandedFanOutKeys((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  /// Which fan-out row swallowed each delivery, so a backlink or a `#msg-`
  /// permalink aimed at a folded message can open the row it now lives in
  /// instead of scrolling to a collapsed marker and showing nothing.
  const fanOutKeyByMessageId = useMemo(() => {
    const byMessageId = new Map<string, string>();
    for (const row of feedRows) {
      if (row.kind !== "fanout") continue;
      for (const message of row.messages) byMessageId.set(message.id, row.key);
    }
    return byMessageId;
  }, [feedRows]);

  const scrollToMessage = useCallback((messageId: string) => {
    const fanOutKey = fanOutKeyByMessageId.get(messageId);
    if (fanOutKey) {
      setExpandedFanOutKeys((previous) => (
        previous.has(fanOutKey) ? previous : new Set(previous).add(fanOutKey)
      ));
    }
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    // A folded delivery's anchor has no box of its own, so the row standing in
    // for it is what gets scrolled and highlighted.
    const target = el.closest<HTMLElement>(".s-thread-fanout") ?? el;
    const flashClass = target === el ? "s-thread-msg--flash" : "s-thread-fanout--flash";
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add(flashClass);
    window.setTimeout(() => target.classList.remove(flashClass), 1200);
  }, [fanOutKeyByMessageId]);

  useEffect(() => {
    const onHashChange = () => setHashMessageId(messageIdFromLocationHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!hashMessageId || !messagesById.has(hashMessageId)) return;
    const timer = window.setTimeout(() => scrollToMessage(hashMessageId), 50);
    return () => window.clearTimeout(timer);
  }, [hashMessageId, messagesById, scrollToMessage]);

  useBrokerEvents(
    useCallback(
      (event) => {
        if (event.kind === "message.posted") {
          const message = (
            event.payload as { message?: EventMessageRecord } | undefined
          )?.message;
          if (!message || !equivalentConversationIds.has(message.conversationId)) return;

          const isOperatorActor = message.actorId === "operator";
          const isAgentMessage = isDm
            && !isOperatorActor
            && message.class === "agent";
          const nextMessage: Message = {
            id: message.id,
            conversationId: message.conversationId,
            actorId: message.actorId,
            actorName: isAgentMessage
              ? agentName
              : displayNameForActor(message.actorId, scopedAgents, operatorName),
            body: message.body,
            createdAt: message.createdAt,
            class: isOperatorActor ? "operator" : message.class,
            attachments: message.attachments,
            metadata: message.metadata,
            replyToMessageId: message.replyToMessageId ?? message.n ?? null,
          };
          if (isNoisyConversationStatusMessage(nextMessage)) return;

          setMessages((previous) => {
            const clientMessageId = clientMessageIdFromMetadata(message.metadata);
            const knownOptimisticId = clientMessageId
              ? optimisticMessageIdByClientIdRef.current.get(clientMessageId)
              : undefined;
            if (previous.some((candidate) => candidate.id === message.id)) {
              if (clientMessageId) optimisticMessageIdByClientIdRef.current.delete(clientMessageId);
              return previous;
            }
            if (isOperatorActor && clientMessageId) {
              const optimisticIndex = optimisticMessageIndexForClientId(
                previous,
                clientMessageId,
                knownOptimisticId,
              );
              if (optimisticIndex !== -1) {
                const next = [...previous];
                next[optimisticIndex] = nextMessage;
                optimisticMessageIdByClientIdRef.current.delete(clientMessageId);
                return sortMessages(next);
              }
            }
            return sortMessages([...previous, nextMessage]);
          });

          if (isAgentMessage) {
            const messageAt =
              normalizeTimestampMs(message.createdAt) ?? Date.now();
            setAwaitingResponseSince((current) => {
              if (current === null || messageAt < current) return current;
              if (isActiveConversationFlight(currentFlightRef.current))
                return current;
              return null;
            });
            setCurrentFlight((current) => {
              return shouldClearConversationWorkingStateForAgentMessage(current)
                ? null
                : current;
            });
          }
          return;
        }

        if (event.kind === "invocation.requested") {
          const invocation = (
            event.payload as { invocation?: EventInvocationRecord } | undefined
          )?.invocation;
          if (!invocationTargetsConversation(invocation, equivalentConversationIds)) return;
          trackedInvocationIdsRef.current.add(invocation.id);
          setTurnActivity([]);
          setTurnAsk(null);
          setAwaitingResponseSince((current) => current ?? Date.now());
          return;
        }

        if (event.kind === "conversation.upserted") {
          const conversation = (
            event.payload as { conversation?: { id?: string | null } } | undefined
          )?.conversation;
          if (conversation?.id && equivalentConversationIds.has(conversation.id)) {
            // Native feed/materialization updates are a second wake-up path for
            // a turn whose invocation event raced the embedded thread mount.
            void load({ messageMode: "none", includeMetadata: false });
          }
          return;
        }

        if (event.kind === "flight.updated") {
          const flight = (
            event.payload as { flight?: EventFlightRecord } | undefined
          )?.flight;
          if (!flight || flight.targetAgentId !== agentId) return;
          const isTracked =
            trackedInvocationIdsRef.current.has(flight.invocationId) ||
            currentFlightRef.current?.id === flight.id;
          if (!isTracked) return;

          if (TERMINAL_CONVERSATION_FLIGHT_STATES.has(flight.state)) {
            settlePendingConversationFlight(conversationId, flight.id);
            setCurrentFlight((current) =>
              current?.id === flight.id ? null : current,
            );
            setTurnActivity([]);
            setTurnAsk(null);
            setAwaitingResponseSince(null);
            void load({ messageMode: "refresh", includeMetadata: false });
            return;
          }

          trackedInvocationIdsRef.current.add(flight.invocationId);
          const sameTurn = currentFlightRef.current?.id === flight.id;
          const mappedFlight = mapEventFlight(
            flight,
            conversationId,
            agentId ?? "",
            currentFlightRef.current,
          );
          if (isRequesterWaitTimeoutConversationFlight(mappedFlight)) {
            setAwaitingResponseSince(null);
          }
          setCurrentFlight(mappedFlight);
          if (!sameTurn) {
            setTurnActivity([]);
            setTurnAsk(null);
          }
          return;
        }

        if (event.kind === "agent.endpoint.upserted") {
          return;
        }

        if (event.kind === "unknown") {
          void load({ messageMode: "refresh" });
        }
      },
      [agentId, agentName, conversationId, equivalentConversationIds, isDm, load, operatorName, scopedAgents],
    ),
  );

  useEffect(() => {
    if (!shouldPollOutstandingTurn) {
      return;
    }

    const timer = setInterval(() => {
      void load({ messageMode: "refresh", includeMetadata: false });
    }, 5000);
    return () => clearInterval(timer);
  }, [shouldPollOutstandingTurn, load]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      const now = Date.now();
      if (now - lastForegroundRefreshAtRef.current < 1000) {
        return;
      }
      lastForegroundRefreshAtRef.current = now;
      void load({ messageMode: "refresh" });
    };

    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [load]);

  const previousNewestMessageIdRef = useRef<string | null>(null);
  const previousShowTypingRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const scrollToTail = useCallback((behavior: "instant" | "smooth") => {
    const feed = feedRef.current;
    if (!feed) return;

    autoScrollActiveRef.current = true;
    if (autoScrollTimeoutRef.current !== null) {
      clearTimeout(autoScrollTimeoutRef.current);
    }
    // Keep arrival scrolling inside the feed. `scrollIntoView()` also scrolls
    // eligible ancestors, which can move the entire web surface—and with it
    // the composer—when a route's skeleton is replaced by real history.
    if (behavior === "instant") {
      feed.scrollTop = feed.scrollHeight;
    } else {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
    }
    autoScrollTimeoutRef.current = setTimeout(() => {
      autoScrollActiveRef.current = false;
      autoScrollTimeoutRef.current = null;
    }, behavior === "smooth" ? 700 : 0);
  }, []);

  useEffect(() => () => {
    if (autoScrollTimeoutRef.current !== null) {
      clearTimeout(autoScrollTimeoutRef.current);
    }
  }, []);

  const handleFeedScroll = useCallback(() => {
    const feed = feedRef.current;
    if (!feed || autoScrollActiveRef.current) return;

    const distanceFromTail = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
    const atBottom = distanceFromTail <= CONVERSATION_TAIL_THRESHOLD_PX;
    wasAtBottomRef.current = atBottom;
    if (atBottom) {
      setFeedPaused(false);
      setPendingNewMessageCount(0);
    } else {
      setFeedPaused(true);
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    wasAtBottomRef.current = true;
    setFeedPaused(false);
    setPendingNewMessageCount(0);
    scrollToTail("smooth");
  }, [scrollToTail]);

  // Runs on every commit so the "what changed since last paint" refs below are
  // never stale, and so a suppressed prepend commit still clears its own flag.
  useEffect(() => {
    const newestMessageId = messages.at(-1)?.id ?? null;
    const newMessageArrived = Boolean(
      newestMessageId && newestMessageId !== previousNewestMessageIdRef.current,
    );
    const decision = resolveConversationAutoscroll({
      newestMessageId,
      previousNewestMessageId: previousNewestMessageIdRef.current,
      showTyping: presence.showTyping,
      previousShowTyping: previousShowTypingRef.current,
      historyRestorePending: historyRestoreAppliedRef.current
        || pendingHistoryScrollRef.current !== null,
      initialScrollDone: initialScrollDoneRef.current,
      nearBottom: wasAtBottomRef.current,
    });
    if (decision !== "none") {
      scrollToTail(decision);
      initialScrollDoneRef.current = true;
    } else if (
      newMessageArrived
      && initialScrollDoneRef.current
      && !wasAtBottomRef.current
    ) {
      setFeedPaused(true);
      setPendingNewMessageCount((count) => count + 1);
    }
    historyRestoreAppliedRef.current = false;
    previousNewestMessageIdRef.current = newestMessageId;
    previousShowTypingRef.current = presence.showTyping;
  });

  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  const attachments = useComposerAttachments();
  const [queued, setQueued] = useState<QueuedConversationDraft[]>([]);
  // What a Send press means while the agent is mid-turn. Queue is the default;
  // Steer has to be armed, because it interrupts.
  const [busyIntent, setBusyIntent] = useState<BusySendIntent>("queue");
  // A queued draft pulled back into the input box. Its files were uploaded when
  // it was queued, so they ride along as already-outgoing attachments rather
  // than being re-staged and re-uploaded.
  const [editingQueued, setEditingQueued] = useState<
    { id: string | null; attachments: OutgoingAttachment[] } | null
  >(null);

  const sendText = async (
    text: string,
    options?: {
      forceAction?: ComposeAction;
      attachments?: OutgoingAttachment[];
      replyTarget?: ConversationReplyTarget | null;
    },
  ): Promise<SendAttemptOutcome> => {
    const trimmed = text.trim();
    const outgoingAttachments = options?.attachments ?? [];
    const outgoingReplyTarget = options?.replyTarget ?? null;
    if ((!trimmed && outgoingAttachments.length === 0) || sending) return "failed";
    const forceAction = options?.forceAction;
    const action = forceAction ?? resolveComposeAction({
      isDm,
      hasOutstandingReply,
    });

    const optimisticCreatedAt = Date.now();
    const clientMessageId = createClientMessageId();
    const optimisticMessage: Message = {
      id: `optimistic-${clientMessageId}`,
      conversationId,
      actorId: "operator",
      actorName: operatorName,
      body: trimmed,
      createdAt: optimisticCreatedAt,
      class: "operator",
      ...(outgoingReplyTarget
        ? { replyToMessageId: outgoingReplyTarget.messageId }
        : {}),
      metadata: {
        clientMessageId,
        deliveryState: "sending",
      },
      ...(outgoingAttachments.length > 0
        ? { attachments: outgoingAttachments }
        : {}),
    };

    setSending(true);
    if (action !== "message") {
      setAwaitingResponseSince(optimisticCreatedAt);
    }
    setError(null);
    optimisticMessageIdByClientIdRef.current.set(clientMessageId, optimisticMessage.id);
    setMessages((previous) => sortMessages([...previous, optimisticMessage]));

    try {
      const result = await api<SendResult>(
        `/api/chats/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body: trimmed,
            clientMessageId,
            ...(outgoingReplyTarget
              ? { replyToMessageId: outgoingReplyTarget.messageId }
              : {}),
            ...(outgoingAttachments.length > 0
              ? { attachments: outgoingAttachments }
              : {}),
          }),
        },
      );
      const routedConversationId = result.chatId?.trim() ?? result.conversationId?.trim();
      if (routedConversationId && routedConversationId !== conversationId) {
        throw new Error(
          `Send returned a different Chat (${routedConversationId}) instead of appending to ${conversationId}.`,
        );
      }
      if (result.messageId?.trim()) {
        const canonicalMessageId = result.messageId.trim();
        setMessages((previous) => sortMessages(previous.map((message) =>
          message.id === optimisticMessage.id
            ? {
                ...message,
                id: canonicalMessageId,
                metadata: { clientMessageId },
              }
            : message
        )));
        optimisticMessageIdByClientIdRef.current.delete(clientMessageId);
      }
      if (result.flight) {
        trackedInvocationIdsRef.current.add(result.flight.invocationId);
        setCurrentFlight(
          mapEventFlight(result.flight, conversationId, agentId ?? ""),
        );
        setTurnActivity([]);
        setTurnAsk(null);
      } else if (action !== "message") {
        setAwaitingResponseSince(null);
      }
      return "sent";
    } catch (cause) {
      if (isAmbiguousTransportFailure(cause)) {
        setMessages((previous) => previous.map((message) =>
          message.id === optimisticMessage.id
            ? {
                ...message,
                metadata: {
                  ...(message.metadata ?? {}),
                  deliveryState: "unknown",
                },
              }
            : message
        ));
        return "unknown";
      }
      setMessages((previous) =>
        previous.filter((message) => message.id !== optimisticMessage.id),
      );
      optimisticMessageIdByClientIdRef.current.delete(clientMessageId);
      setAwaitingResponseSince(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      return "failed";
    } finally {
      setSending(false);
    }
  };

  const retryConversationFailure = async (failureMessage: Message) => {
    const original = failureMessage.replyToMessageId
      ? messagesById.get(failureMessage.replyToMessageId)
      : null;
    if (!original || sending) return;
    const reusableAttachments: OutgoingAttachment[] = [];
    for (const attachment of original.attachments ?? []) {
      if (!attachment.url) {
        setError("This request includes an attachment that can’t be reused. Add it again, then retry.");
        requestAnimationFrame(() => composeRef.current?.focus());
        return;
      }
      reusableAttachments.push({
        id: attachment.id,
        mediaType: attachment.mediaType,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
        url: attachment.url,
      });
    }
    const outcome = await sendText(original.body, {
      forceAction: "invoke",
      attachments: reusableAttachments,
    });
    if (outcome !== "failed") {
      clearConversationFailure(failureMessage);
    }
  };

  const askScoutbotAboutFailure = (
    failureMessage: Message,
    targetName: string,
    explanation: string,
  ) => {
    if (!scoutbotConversationId) return;
    const originalBody = failureMessage.replyToMessageId
      ? messagesById.get(failureMessage.replyToMessageId)?.body.trim()
      : "";
    const excerpt = originalBody
      ? `${originalBody.slice(0, 1_200)}${originalBody.length > 1_200 ? "…" : ""}`
      : "(The original request is no longer available in this transcript.)";
    const composeDraft = [
      `Help me recover a failed request to ${targetName}.`,
      explanation,
      "",
      "Original request:",
      excerpt,
    ].join("\n");
    const recoveryRoute: Route = {
      view: "conversation",
      conversationId: scoutbotConversationId,
      composeDraft,
    };
    if (embedded && forwardScoutbotUiActionToNativeHost({
      type: "navigate",
      route: recoveryRoute,
      reason: "Ask @scoutbot to help recover a failed conversation request",
    })) return;
    navigate(recoveryRoute);
  };

  /**
   * Uploads staged files and clears the composer. Returns null when there is
   * nothing to commit, or when the upload failed (the error is already shown).
   */
  const takeDraft = async (): Promise<
    {
      body: string;
      attachments: OutgoingAttachment[];
      replyTarget: ConversationReplyTarget | null;
    } | null
  > => {
    const text = draft.trim();
    const takenReplyTarget = replyTarget;
    const files = attachments.files;
    const carried = editingQueued?.attachments ?? [];
    if (!text && files.length === 0 && carried.length === 0) return null;

    let uploaded: OutgoingAttachment[] = [];
    if (files.length > 0) {
      setSending(true);
      try {
        uploaded = await uploadMediaFiles(files);
      } catch (cause) {
        attachments.setError(
          cause instanceof Error ? cause.message : String(cause),
        );
        return null;
      } finally {
        setSending(false);
      }
    }

    setDraft("");
    setReplyTarget(null);
    attachments.clear();
    setEditingQueued(null);
    return {
      body: text,
      attachments: [...carried, ...uploaded],
      replyTarget: takenReplyTarget,
    };
  };

  const send = async () => {
    // Resolve before taking the draft: `takeDraft` clears the editing state the
    // disposition is read from.
    const disposition = resolveSendDisposition({
      isAgentBusy,
      intent: busyIntent,
    });
    const editingId = editingQueued?.id ?? null;
    const taken = await takeDraft();
    if (!taken) return;

    // Mid-turn, Send does whatever the queue/steer modifier says. Queue holds
    // the draft until the running turn lands; steer interrupts and delivers it.
    if (disposition === "queue") {
      setQueued((previous) => {
        // A rewrite lands back in the slot it came from — editing must not
        // reorder the queue.
        if (editingId) {
          return previous.map((entry) =>
            entry.id === editingId
              ? {
                  ...entry,
                  body: taken.body,
                  attachments: taken.attachments,
                  replyTarget: taken.replyTarget,
                }
              : entry,
          );
        }
        return [
          ...previous,
          {
            id: `queued-${Date.now()}-${previous.length}`,
            body: taken.body,
            attachments: taken.attachments,
            replyTarget: taken.replyTarget,
            queuedAt: Date.now(),
          },
        ];
      });
      return;
    }

    // Leaving the queue by any other route drops the row it was edited from.
    if (editingId) {
      setQueued((previous) => previous.filter((entry) => entry.id !== editingId));
    }

    const restoreTakenDraft = () => {
      setDraft(taken.body);
      setEditingQueued(
        taken.attachments.length > 0
          ? { id: null, attachments: taken.attachments }
          : null,
      );
      setReplyTarget(taken.replyTarget);
      requestAnimationFrame(() => composeRef.current?.focus());
    };

    if (disposition === "steer") {
      setBusyIntent("queue");
      await interrupt();
      const outcome = await sendText(taken.body, {
        forceAction: "steer",
        attachments: taken.attachments,
        replyTarget: taken.replyTarget,
      });
      if (outcome === "failed") restoreTakenDraft();
      return;
    }

    const outcome = await sendText(taken.body, {
      attachments: taken.attachments,
      replyTarget: taken.replyTarget,
    });
    if (outcome === "failed") restoreTakenDraft();
  };

  const unqueue = (id: string) => {
    setQueued((previous) => previous.filter((entry) => entry.id !== id));
    setEditingQueued((current) => (current?.id === id ? null : current));
  };

  // Pull a queued draft back into the input box. The row keeps its place in the
  // queue — held out of the flush while it is being rewritten — so the draft in
  // the box and the slot it will land in stay visibly the same thing. Its files
  // were uploaded at queue time, so they ride along instead of re-uploading.
  const editQueued = (id: string) => {
    const entry = queued.find((candidate) => candidate.id === id);
    if (!entry) return;
    setDraft(entry.body);
    setReplyTarget(entry.replyTarget ?? null);
    setEditingQueued({ id, attachments: entry.attachments });
    requestAnimationFrame(() => {
      const field = composeRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  };

  // Abandon a rewrite: the queued row is left exactly as it was.
  const cancelEdit = () => {
    setEditingQueued(null);
    setDraft("");
    setReplyTarget(null);
    attachments.clear();
  };

  // Cut a queued draft in ahead of the running turn: pull it out of the queue
  // first so the flush effect can't release it a second time.
  const sendQueuedNow = async (id: string) => {
    const entry = queued.find((candidate) => candidate.id === id);
    if (!entry) return;
    setQueued((previous) => previous.filter((candidate) => candidate.id !== id));
    await interrupt();
    const outcome = await sendText(entry.body, {
      forceAction: "steer",
      attachments: entry.attachments,
      replyTarget: entry.replyTarget ?? null,
    });
    if (outcome === "failed") {
      setQueued((previous) => [entry, ...previous]);
    }
  };

  const beginReply = useCallback((message: Message, actorHandle: string | null) => {
    const normalizedHandle = actorHandle?.trim().replace(/^@+/, "") || null;
    const mentionToken = normalizedHandle ? `@${normalizedHandle}` : null;
    const draftWithoutPreviousMention = replyTarget?.insertedMention
      ? removeInsertedMention(draft, replyTarget.insertedMention)
      : draft;
    const shouldInsertMention = Boolean(
      !isDm
      && mentionToken
      && !draftWithoutPreviousMention.toLocaleLowerCase().includes(
        mentionToken.toLocaleLowerCase(),
      ),
    );
    const nextDraft = shouldInsertMention && mentionToken
      ? draftWithoutPreviousMention.trim()
        ? `${draftWithoutPreviousMention.trimEnd()} ${mentionToken} `
        : `${mentionToken} `
      : draftWithoutPreviousMention;
    setDraft(nextDraft);
    setReplyTarget({
      messageId: message.id,
      actorLabel: normalizedHandle ? `@${normalizedHandle}` : message.actorName,
      preview: messageReplyPreview(message),
      insertedMention: shouldInsertMention ? mentionToken : null,
    });
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [draft, isDm, replyTarget?.insertedMention]);

  const cancelReply = useCallback(() => {
    const insertedMention = replyTarget?.insertedMention;
    setReplyTarget(null);
    if (insertedMention) {
      setDraft((current) => removeInsertedMention(current, insertedMention));
    }
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [replyTarget]);

  const copyMessageLink = useCallback((messageId: string) => {
    const url = new URL(window.location.href);
    if (route.view === "agents-v2") {
      url.searchParams.set("tab", "message");
    }
    url.hash = `msg-${messageId}`;
    void copyTextToClipboard(url.toString());
  }, [route.view]);

  const forwardMessage = useCallback((
    message: Message,
    actorLabel: string,
    projectPath?: string,
  ) => {
    const forwardContext = createForwardContextSource({
      conversationId,
      selectedMessageId: message.id,
      messages: messages.map((candidate) => ({
        id: candidate.id,
        actorLabel: candidate.id === message.id
          ? actorLabel
          : isOperatorMessage(candidate, operatorName)
            ? operatorName
            : candidate.actorName,
        body: candidate.body,
        attachmentCount: candidate.attachments?.length ?? 0,
      })),
    });
    openContextCapture({
      intent: "forward-message",
      forwardContext,
      forwardContextMode: "selected-message",
      ...(projectPath ? { projectPath } : {}),
    });
  }, [conversationId, messages, openContextCapture, operatorName]);

  const interrupt = async () => {
    if (!agentId) return;
    try {
      await api("/api/agents/" + encodeURIComponent(agentId) + "/interrupt", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch {
      // Best-effort
    }
  };

  const isAgentBusy =
    presence.tone === "working" || presence.tone === "pending";
  const composeAction = resolveComposeAction({ isDm, hasOutstandingReply });
  const composePlaceholder = isDm
    ? `Message ${agentName} — type / to route or @ to mention an agent`
    : sessionMeta?.kind === "channel"
      ? `Comment in #${conversationShortLabel(sessionMeta)} — mention @agent to request a reply`
      : `Comment in ${threadTitle} — mention @agent to request a reply`;
  const carriedAttachments = editingQueued?.attachments ?? [];
  const isStopMode =
    !draft.trim() &&
    !attachments.hasFiles &&
    carriedAttachments.length === 0 &&
    isAgentBusy;

  // Release queued drafts one at a time as soon as the agent frees up. One per
  // pass keeps ordering intact: each send flips `sending`, which re-gates this.
  // A row being rewritten is held back: it is in the box, not ready to go.
  const flushingRef = useRef(false);
  useEffect(() => {
    const editingId = editingQueued?.id ?? null;
    const flushable = editingId
      ? queued.filter((entry) => entry.id !== editingId)
      : queued;
    if (!shouldFlushQueue({ isAgentBusy, sending, queued: flushable })) return;
    if (flushingRef.current) return;
    const next = flushable[0];
    if (!next) return;
    flushingRef.current = true;
    setQueued((previous) => previous.filter((entry) => entry.id !== next.id));
    void sendText(next.body, {
      attachments: next.attachments,
      replyTarget: next.replyTarget ?? null,
    })
      .then((outcome) => {
        if (outcome === "failed") {
          setQueued((previous) => [next, ...previous]);
        }
      })
      .finally(() => {
        flushingRef.current = false;
      });
  }, [isAgentBusy, sending, queued, editingQueued]);

  // Steer is armed for one send. Once the turn it would have interrupted is
  // over, fall back to the safe default rather than leaving it hot.
  useEffect(() => {
    if (!isAgentBusy) setBusyIntent("queue");
  }, [isAgentBusy]);

  // Queued drafts belong to the conversation they were written in.
  useEffect(() => {
    setQueued([]);
    setEditingQueued(null);
    setReplyTarget(null);
    setBusyIntent("queue");
    attachments.clear();
  }, [conversationId]);

  const queueNote = describeQueuedDrafts(queued);

  const showContextMenu = useContextMenu();
  const onMessageContextMenu = useCallback(
    (event: React.MouseEvent, message: Message) => {
      const sel = window.getSelection()?.toString().trim();
      const isYou = isOperatorMessage(message, operatorName);
      const participant = message.actorId
        ? participantMetaById.get(message.actorId)
        : null;
      const messageAgent = !isYou
        ? resolveMessageAgent(message, scopedAgents, agentId)
        : null;
      const actorHandle = (
        participant?.scopedAlias?.trim()
        || messageAgent?.handle?.trim()
        || null
      )?.replace(/^@+/, "") ?? null;
      const actorLabel = actorHandle ? `@${actorHandle}` : message.actorName;
      const actualAgentId = (
        messageAgent?.id
        || participant?.agentId
        || message.actorId
        || ""
      ).trim();
      const items: MenuItem[] = [];
      if (!isYou) {
        items.push({
          kind: "action",
          label: "Reply",
          onSelect: () => beginReply(message, actorHandle),
        });
      }
      items.push({
        kind: "action",
        label: "Forward to new task…",
        onSelect: () => forwardMessage(
          message,
          actorLabel,
          participant?.workspaceRoot
          ?? messageAgent?.projectRoot
          ?? messageAgent?.cwd
          ?? undefined,
        ),
      });
      items.push({ kind: "separator" });
      if (sel) {
        items.push({
          kind: "action",
          label: "Copy Selection",
          shortcut: "⌘C",
          onSelect: () => {
            void copyTextToClipboard(sel);
          },
        });
      }
      items.push({
        kind: "action",
        label: "Copy Message",
        onSelect: () => {
          void copyTextToClipboard(message.body);
        },
      });
      items.push({
        kind: "action",
        label: "Copy Link",
        onSelect: () => copyMessageLink(message.id),
      });
      items.push({ kind: "separator" });
      if (!isYou && actualAgentId) {
        items.push({
          kind: "action",
          label: "Copy Agent ID",
          onSelect: () => {
            void copyTextToClipboard(actualAgentId);
          },
        });
      }
      items.push({
        kind: "action",
        label: "Copy Message ID",
        onSelect: () => {
          void copyTextToClipboard(message.id);
        },
      });
      showContextMenu(event, items);
    },
    [
      agentId,
      beginReply,
      copyMessageLink,
      forwardMessage,
      operatorName,
      participantMetaById,
      scopedAgents,
      showContextMenu,
    ],
  );

  const dispatchToCandidate = async (
    record: ScoutDispatchRecord,
    candidate: ScoutDispatchCandidate,
  ) => {
    const prefix = `@${candidate.agentId} `;
    const leftover = draft.trim();
    if (leftover) {
      setDraft("");
      await sendText(`${prefix}${leftover}`, { forceAction: "invoke" });
      return;
    }
    setDraft(prefix);
    composeRef.current?.focus();
    void record;
  };

  const addableParticipantAgents = useMemo(() => {
    if (!sessionMeta) return [];
    const currentParticipants = new Set(sessionMeta.participantIds);
    return scopedAgents
      .filter((candidate) =>
        !currentParticipants.has(candidate.id) &&
        !candidate.retiredFromFleet
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [sessionMeta, scopedAgents]);

  useEffect(() => {
    if (!addParticipantOpen) return;
    setAddParticipantId((current) => {
      if (current && addableParticipantAgents.some((agent) => agent.id === current)) {
        return current;
      }
      return addableParticipantAgents[0]?.id ?? "";
    });
  }, [addParticipantOpen, addableParticipantAgents]);

  const canAddParticipants = Boolean(
    sessionMeta &&
    ["direct", "group_direct", "channel"].includes(sessionMeta.kind) &&
    addableParticipantAgents.length > 0,
  );

  const submitAddParticipant = useCallback(async () => {
    if (!sessionMeta) return;
    const actorId = addParticipantId.trim();
    if (!actorId) return;

    setAddingParticipant(true);
    setAddParticipantError(null);
    try {
      const result = await api<{
        ok: true;
        kind: string;
        participantIds: string[];
        session?: SessionEntry | null;
      }>(`/api/conversations/${encodeURIComponent(sessionMeta.id)}/members`, {
        method: "POST",
        body: JSON.stringify({ actorId }),
      });

      if (result.session) {
        setSessionMeta(result.session);
      } else {
        setSessionMeta((previous) =>
          previous
            ? {
                ...previous,
                kind: result.kind,
                participantIds: result.participantIds,
              }
            : previous,
        );
      }

      setAddParticipantOpen(false);
      setAddParticipantId("");
      await load({ messageMode: "none" });
    } catch (cause) {
      setAddParticipantError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAddingParticipant(false);
    }
  }, [addParticipantId, load, sessionMeta]);

  return (
    <div
      className={`s-thread-layout${embedded ? " s-thread-layout--embedded" : ""}`}
      data-thread-treatment={treatment === "standard" ? undefined : treatment}
    >
      <div className="s-thread-center">
        {!embedded && (
          <ConversationHeader
            showBackNav={showBackNav}
            isDm={isDm}
            navigate={navigate}
            route={route}
            canonicalConversationId={canonicalConversationId}
            threadTitle={threadTitle}
            agentId={agent?.id ?? null}
            sessionId={conversationSessionId}
            detailRoute={conversationDetailRoute}
            participants={headerParticipants}
            operator={headerOperator}
            canAddParticipants={canAddParticipants}
            onToggleAddParticipant={() => {
              setAddParticipantError(null);
              setAddParticipantOpen((open) => !open);
            }}
          />
        )}

        {!embedded && sessionMeta && (
          <ConversationIdentityRow
            canonicalConversationId={canonicalConversationId}
            conversationAlias={conversationAlias}
          />
        )}

        {!embedded && addParticipantOpen && canAddParticipants && (
          <AddParticipantForm
            agents={addableParticipantAgents}
            addParticipantId={addParticipantId}
            setAddParticipantId={setAddParticipantId}
            addingParticipant={addingParticipant}
            addParticipantError={addParticipantError}
            onCancel={() => {
              setAddParticipantOpen(false);
              setAddParticipantError(null);
            }}
            onSubmit={() => void submitAddParticipant()}
          />
        )}

        {pinnedAsk && (
          <PinnedAskCard
            pinnedAsk={pinnedAsk}
            onAnswer={() => {
              // Answer must visibly arm the composer — a bare focus() reads as
              // "nothing happened". Anchor the reply to the agent's latest
              // word so the chip shows who is being answered.
              const anchor = [...messages]
                .reverse()
                .find((candidate) => candidate.actorId === pinnedAsk.agentId)
                ?? [...messages]
                  .reverse()
                  .find((candidate) =>
                    !isOperatorMessage(candidate, operatorName)
                    && candidate.class !== "status"
                    && candidate.class !== "system");
              if (anchor) {
                beginReply(
                  anchor,
                  anchor.actorId
                    ? participantMetaById.get(anchor.actorId)?.scopedAlias ?? null
                    : null,
                );
              } else {
                composeRef.current?.focus();
              }
            }}
            onSteer={focusSteerComposer}
          />
        )}

        <ConversationStatusStrip presence={presence} agent={agent} />

        {error && <p className="s-thread-error">{error}</p>}

        <div
          className="s-thread-feed"
          data-conversation-id={conversationId}
          ref={feedRef}
          onScroll={handleFeedScroll}
        >
          {!showThreadSkeleton && messages.length > 0 && canLoadEarlierMessages && (
            <div className="s-thread-history-control">
              <button
                type="button"
                className="s-thread-history-button"
                disabled={loadingEarlierMessages}
                aria-busy={loadingEarlierMessages}
                onClick={() => void loadEarlierMessages()}
              >
                {loadingEarlierMessages && (
                  <span className="s-thread-history-spinner" aria-hidden="true" />
                )}
                {loadingEarlierMessages ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            </div>
          )}
          {showThreadSkeleton ? (
            <ThreadLoadingSkeleton />
          ) : messages.length === 0 ? (
            showEmptyMotionPanel ? (
              <ThreadMotionPanel
                agentName={agentName}
                title={presence.label}
                detail={presence.detail || displayTurnSnapshot.latest}
                snapshot={displayTurnSnapshot}
                events={turnActivity}
                steps={workingTurnSteps}
                phase={workingTurnPhase}
                tone={turnMotionTone}
                workspaceName={workspaceName}
                branch={sessionMeta?.currentBranch}
                startedAt={turnMotionStartedAt}
                onOpenTrace={openWorkingTrace}
                onOpenTerminal={openWorkingTerminal}
                onSteer={focusSteerComposer}
              />
            ) : (
              <div className="s-thread-empty">
                <div className="s-thread-empty-glyph" aria-hidden="true">
                  {isDm ? "@" : "#"}
                </div>
                <p>{threadTitle}</p>
                <p>
                  {isDm
                    ? "No messages yet. Send a message to start working with this agent."
                    : "No messages yet. Start the conversation below."}
                </p>
                {(workspaceName || sessionMeta?.currentBranch) && (
                  <div className="s-thread-empty-chips">
                    {workspaceName && (
                      <span className="s-thread-empty-chip">{workspaceName}</span>
                    )}
                    {sessionMeta?.currentBranch && (
                      <span className="s-thread-empty-chip">{sessionMeta.currentBranch}</span>
                    )}
                  </div>
                )}
              </div>
            )
          ) : (
            feedRows.map((row, index) => {
              const showDayDivider = shouldShowThreadDayDivider(row, index);

              if (row.kind === "fanout") {
                return (
                  <FanOutRow
                    key={row.key}
                    row={row}
                    expanded={expandedFanOutKeys.has(row.key)}
                    showDayDivider={showDayDivider}
                    onToggle={() => toggleFanOut(row.key)}
                  />
                );
              }

              const message = row.message;
              const isYou = isOperatorMessage(message, operatorName);
              const dispatch = readScoutDispatch(message);
              const rowClass = dispatch ? "scout.dispatch" : message.class;
              const badgeLabel = messageClassLabel(rowClass);
              const isToolMessage = rowClass === "status";
              const absoluteTime = formatAbsoluteTimestamp(message.createdAt);
              const messageAgent =
                !isYou
                  ? resolveMessageAgent(message, scopedAgents, agentId)
                  : null;
              const messageParticipant = participantMetaById.get(message.actorId);
              const scopedReplyHandle = messageParticipant?.scopedAlias?.trim() || null;
              const displayActorName = !isYou && scopedReplyHandle
                ? scopedReplyHandle
                : message.actorName;
              const actorHandle = isYou
                ? operatorName.toLowerCase()
                : scopedReplyHandle ?? messageAgent?.handle ?? null;
              const askReply = parseAskReplyTag(message.body);
              const replyContext = askReply
                ? resolveAskReplyContext({
                    flightId: askReply.flightId,
                    replyToMessageId: message.replyToMessageId,
                    messagesById,
                    agents: scopedAgents,
                    operatorName,
                  })
                : null;
              const replyOrigin = !askReply && message.replyToMessageId
                ? messagesById.get(message.replyToMessageId) ?? null
                : null;
              const replyOriginLabel = replyOrigin
                ? isOperatorMessage(replyOrigin, operatorName)
                  ? operatorName
                  : replyOrigin.actorName
                : null;
              const displayBody = askReply ? askReply.body : message.body;
              const failureNotice = conversationFailureNotice(message);
              if (failureNotice && dismissedFailureMessageIds.has(message.id)) {
                return null;
              }
              const failureTargetId = typeof message.metadata?.["targetAgentId"] === "string"
                ? message.metadata["targetAgentId"]
                : null;
              const failureTargetAgent = failureNotice
                ? resolveAgentByIdentity(scopedAgents, [
                    failureTargetId,
                    failureNotice.target,
                  ])
                : null;
              const failureTargetName = failureNotice
                ? minimalAgentDisplayName({
                    name: failureTargetAgent?.name,
                    id: failureTargetAgent?.id,
                    title: conversationalTargetLabel(failureNotice.target),
                  })
                : null;

              return (
                <div
                  key={message.id}
                  className={[
                    "s-thread-feed-block",
                    isYou && "s-thread-feed-block--you",
                    showDayDivider && "s-thread-feed-block--full-width",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {showDayDivider && <ThreadDayDivider at={message.createdAt} />}

                  {failureNotice && failureTargetName ? (
                    <article
                      id={`msg-${message.id}`}
                      className={[
                        "s-thread-msg",
                        "s-thread-failure-notice",
                        (isFirstPaint || enteringIds?.has(message.id)) && "s-thread-msg--enter",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={
                        isFirstPaint
                          ? {
                              animationDelay: `${
                                Math.max(0, 7 - (feedRows.length - 1 - index)) * 26
                              }ms`,
                            }
                          : undefined
                      }
                      data-class={rowClass}
                      aria-label="Delivery issue"
                    >
                      <span className="s-thread-failure-notice-mark" aria-hidden="true">
                        !
                      </span>
                      <div className="s-thread-failure-notice-content">
                        <p>
                          <strong>{failureTargetName} couldn’t reply.</strong>{" "}
                          <span>{failureNotice.explanation}</span>
                        </p>
                        {failureNotice.technicalDetail && (
                          <details className="s-thread-failure-notice-details">
                            <summary>Technical details</summary>
                            <pre>{failureNotice.technicalDetail}</pre>
                          </details>
                        )}
                        <div className="s-thread-failure-notice-actions">
                          {message.replyToMessageId && messagesById.has(message.replyToMessageId) && (
                            <button
                              className="s-thread-failure-notice-action s-thread-failure-notice-action--primary"
                              type="button"
                              disabled={sending}
                              onClick={() => void retryConversationFailure(message)}
                            >
                              {sending ? "Retrying…" : "Retry"}
                            </button>
                          )}
                          {scoutbotConversationId && (
                            <button
                              className="s-thread-failure-notice-action"
                              type="button"
                              onClick={() => askScoutbotAboutFailure(
                                message,
                                failureTargetName,
                                failureNotice.explanation,
                              )}
                            >
                              Ask @scoutbot
                            </button>
                          )}
                          <button
                            className="s-thread-failure-notice-action s-thread-failure-notice-action--clear"
                            type="button"
                            onClick={() => clearConversationFailure(message)}
                            aria-label={`Clear delivery issue for ${failureTargetName}`}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <span
                        className="s-thread-failure-notice-time"
                        title={absoluteTime}
                      >
                        {timeAgo(message.createdAt)}
                      </span>
                    </article>
                  ) : (
                  <article
                    id={`msg-${message.id}`}
                    className={[
                      "s-thread-msg",
                      isYou && "s-thread-msg--you",
                      isToolMessage && "s-thread-msg--tool",
                      (isFirstPaint || enteringIds?.has(message.id)) && "s-thread-msg--enter",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    /* Stagger only the tail of the first paint; a turn that
                       lands later is one event and gets no delay. */
                    style={
                      isFirstPaint
                        ? {
                            animationDelay: `${
                              Math.max(0, 7 - (feedRows.length - 1 - index)) * 26
                            }ms`,
                          }
                        : undefined
                    }
                    data-class={rowClass}
                    onContextMenu={(e) => onMessageContextMenu(e, message)}
                  >
                    <div className="s-thread-msg-card">
                      <div className="s-thread-msg-card-content">
                        <div className="s-thread-msg-header">
                          <div className="s-thread-msg-meta">
                            {(() => {
                              const profileNav = !isYou && messageAgent
                                ? () =>
                                    openContent(
                                      navigate,
                                      {
                                        view: "agents-v2",
                                        agentId: messageAgent.id,
                                      },
                                      { returnTo: route },
                                    )
                                : null;
                              const avatarName = isYou
                                ? operatorName
                                : displayActorName ?? "?";
                              const avatar = (
                                <AgentAvatar
                                  agent={messageAgent ?? undefined}
                                  name={avatarName}
                                  placement="turn"
                                  size={28}
                                  className="s-thread-msg-avatar"
                                  title={avatarName}
                                />
                              );
                              return profileNav ? (
                                <button
                                  type="button"
                                  className="s-thread-msg-avatar--nav"
                                  onClick={profileNav}
                                  aria-label={`View profile for ${message.actorName ?? "agent"}`}
                                  title={`View profile for ${message.actorName ?? "agent"}`}
                                >
                                  {avatar}
                                </button>
                              ) : (
                                avatar
                              );
                            })()}
                            {!isYou && messageAgent ? (
                              <button
                                type="button"
                                className="s-thread-msg-actor s-thread-msg-actor--nav"
                                onClick={() =>
                                  openContent(
                                    navigate,
                                    {
                                      view: "agents-v2",
                                      agentId: messageAgent.id,
                                    },
                                    { returnTo: route },
                                  )
                                }
                                title={`View profile for ${message.actorName}`}
                              >
                                {displayActorName}
                              </button>
                            ) : (
                              <span className="s-thread-msg-actor">
                                {isYou ? operatorName : displayActorName}
                              </span>
                            )}
                            {actorHandle && (
                              <span className="s-thread-msg-handle">
                                @{actorHandle}
                              </span>
                            )}
                            {badgeLabel && (
                              <span className="s-thread-msg-kind">
                                {badgeLabel}
                              </span>
                            )}
                          </div>
                          <span
                            className="s-thread-msg-time"
                            title={absoluteTime}
                          >
                            {timeAgo(message.createdAt)}
                          </span>
                          <span className="s-thread-msg-actions">
                            {!isYou && actorHandle && (
                              <button
                                type="button"
                                className="s-thread-msg-permalink"
                                aria-label={`Reply to @${actorHandle}`}
                                title={`Reply to @${actorHandle}`}
                                onClick={() => beginReply(message, actorHandle)}
                              >
                                <ReplyGlyph />
                              </button>
                            )}
                            <button
                              type="button"
                              className="s-thread-msg-permalink"
                              aria-label="Copy link to message"
                              title="Copy link to message"
                              onClick={() => copyMessageLink(message.id)}
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M6.5 9.5a2.5 2.5 0 0 0 3.54 0l2.12-2.12a2.5 2.5 0 0 0-3.54-3.54l-.7.7" />
                                <path d="M9.5 6.5a2.5 2.5 0 0 0-3.54 0L3.84 8.62a2.5 2.5 0 0 0 3.54 3.54l.7-.7" />
                              </svg>
                            </button>
                          </span>
                        </div>

                        {replyContext && (
                          <button
                            type="button"
                            className="s-thread-reply-ctx"
                            title={`Open the originating request${
                              replyContext.flightId
                                ? ` · ${replyContext.flightId}`
                                : ""
                            }`}
                            onClick={() =>
                              scrollToMessage(replyContext.originatingMessageId)
                            }
                          >
                            <ReplyGlyph />
                            <span className="s-thread-reply-ctx-label">
                              reply to
                            </span>
                            <span className="s-thread-reply-ctx-title">
                              {replyContext.title}
                            </span>
                            <span className="s-thread-reply-ctx-from">
                              · {replyContext.from}
                            </span>
                            <span className="s-thread-reply-ctx-status">
                              · done
                            </span>
                          </button>
                        )}

                        {replyOrigin && replyOriginLabel && (
                          <button
                            type="button"
                            className="s-thread-reply-ctx"
                            title={`Open message from ${replyOriginLabel}`}
                            onClick={() => scrollToMessage(replyOrigin.id)}
                          >
                            <ReplyGlyph />
                            <span className="s-thread-reply-ctx-label">
                              reply to
                            </span>
                            <span className="s-thread-reply-ctx-title">
                              {messageReplyPreview(replyOrigin)}
                            </span>
                            <span className="s-thread-reply-ctx-from">
                              · {replyOriginLabel}
                            </span>
                          </button>
                        )}

                        <div className="s-thread-msg-body" title={absoluteTime}>
                          <MessageMarkup text={displayBody} />
                        </div>

                        <MessageEmbeds message={message} />

                        {dispatch && dispatch.candidates.length > 0 && (
                          <div className="s-thread-dispatch">
                            {dispatch.candidates.map((candidate) => (
                              <button
                                key={candidate.agentId}
                                type="button"
                                className="s-thread-dispatch-tile"
                                onClick={() =>
                                  void dispatchToCandidate(dispatch, candidate)
                                }
                              >
                                <span className="s-thread-dispatch-tile-id">
                                  @{candidate.agentId}
                                </span>
                                <span className="s-thread-dispatch-tile-state">
                                  {candidate.endpointState}
                                </span>
                                <span className="s-thread-dispatch-tile-meta">
                                  {[
                                    candidate.workspace,
                                    candidate.node,
                                    candidate.projectRoot,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ") || candidate.displayName}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                  )}
                </div>
              );
            })
          )}

          {presence.showTyping && !showEmptyMotionPanel && (
            <div className="s-thread-feed-block">
              <div className="s-thread-msg" aria-live="polite">
                <div className={workingTurnCardClassName}>
                  <AgentAvatar
                    agent={agent ?? undefined}
                    name={agentName}
                    placement="turn"
                    size={28}
                    className="s-thread-msg-avatar s-thread-msg-avatar--working"
                    title={agentName}
                  />
                  <div className="s-thread-msg-card-content">
                    <div className="s-thread-msg-header">
                      <div className="s-thread-msg-meta">
                        <span className="s-thread-msg-actor">{agentName}</span>
                        <span className={workingTurnKindClassName}>
                          {workingTurnBadgeLabel}
                        </span>
                      </div>
                      <span
                        className="s-thread-msg-time"
                        title={
                          currentFlight?.startedAt
                            ? formatAbsoluteTimestamp(currentFlight.startedAt)
                            : "now"
                        }
                      >
                        {currentFlight?.startedAt
                          ? timeAgo(currentFlight.startedAt)
                          : "now"}
                      </span>
                    </div>
                    <div className="s-thread-msg-working-body">
                      <div className={workingTurnSnapshotClassName}>
                        <span
                          className={workingTurnPulseClassName}
                          aria-hidden="true"
                        />
                        <div className="s-thread-turn-snapshot-main">
                          <span className="s-thread-turn-snapshot-label">
                            Latest
                          </span>
                          <span className="s-thread-msg-working-copy">
                            {displayTurnSnapshot.latest}
                          </span>
                        </div>
                      </div>
                      <dl className="s-thread-turn-snapshot-stats">
                        <div className="s-thread-turn-snapshot-stat">
                          <dt>Activity</dt>
                          <dd>{displayTurnSnapshot.activityLabel}</dd>
                        </div>
                        <div className="s-thread-turn-snapshot-stat">
                          <dt>Elapsed</dt>
                          <dd>{displayTurnSnapshot.elapsedLabel}</dd>
                        </div>
                        <div className="s-thread-turn-snapshot-stat">
                          <dt>Last</dt>
                          <dd>{displayTurnSnapshot.lastActivityLabel}</dd>
                        </div>
                      </dl>
                      {workingTurnSteps.length > 0 || workingTurnPhase ? (
                        <WorkingTurnSteps
                          steps={workingTurnSteps}
                          phase={workingTurnPhase}
                          limit={5}
                          compact
                        />
                      ) : (
                        <WorkingTurnActivityPreview
                          events={turnActivity}
                          limit={4}
                          compact
                        />
                      )}
                      <WorkingTurnActions
                        onOpenTrace={openWorkingTrace}
                        onOpenTerminal={openWorkingTerminal}
                        onSteer={focusSteerComposer}
                        compact
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {feedPaused && pendingNewMessageCount > 0 && (
            <button
              type="button"
              className="s-thread-new-messages"
              onClick={jumpToLatest}
            >
              <span aria-hidden="true">↓</span> {pendingNewMessageCount} new {pendingNewMessageCount === 1 ? "message" : "messages"} · jump to latest
            </button>
          )}

          <div ref={bottomRef} />
        </div>

        {presence.showTyping && (
          <div className={presenceLineClassName}>
            <div className="s-thread-presence-line-avatars">
              <AgentAvatar
                agent={agent ?? undefined}
                name={agentName}
                placement="turn"
                size={22}
                className="s-thread-presence-line-avatar"
                title={agentName}
              />
            </div>
            <span className="s-thread-presence-line-label">
              {presenceLineLabel}
            </span>
            <div className={presenceStripClassName} aria-hidden="true" />
          </div>
        )}

        <ConversationComposer
          composeRef={composeRef}
          draft={draft}
          setDraft={setDraft}
          composePlaceholder={composePlaceholder}
          slashState={slashState}
          setSlashState={setSlashState}
          filteredSlashCommands={filteredSlashCommands}
          applySlashCommand={applySlashCommand}
          mentionState={mentionState}
          setMentionState={setMentionState}
          filteredMentions={filteredMentions}
          applyMention={applyMention}
          updateTriggersFromDraft={updateTriggersFromDraft}
          closeSuggestions={closeSuggestions}
          replyTarget={replyTarget}
          onCancelReply={cancelReply}
          isStopMode={isStopMode}
          sending={sending}
          composeAction={composeAction}
          onSend={() => void send()}
          onInterrupt={() => void interrupt()}
          attachments={attachments}
          isAgentBusy={isAgentBusy}
          busyIntent={busyIntent}
          onBusyIntentChange={setBusyIntent}
          queued={queued}
          queueNote={queueNote}
          onEditQueued={editQueued}
          editingQueuedId={editingQueued?.id ?? null}
          editingAttachmentCount={carriedAttachments.length}
          onCancelEdit={cancelEdit}
          onUnqueue={unqueue}
          onSendQueuedNow={(id) => void sendQueuedNow(id)}
        />
      </div>

    </div>
  );
}

function ReplyGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

/**
 * Thread — the conversation surface, embeddable.
 *
 * Native hosts render this same conversation component. The shared embed
 * boundary suppresses MessageComposer atoms when the host owns message input;
 * the transcript remains the canonical shared implementation.
 */
export const scoutSurface = defineSurface({
  id: "thread",
  label: "Thread",
  route: { view: "conversation", conversationId: "" },
  webPath: "/chat",
  screen: "ConversationScreen",
  embed: {
    path: "/embed/thread",
    profile: "macos.thread",
    rootClassName: "s-thread-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    hosts: { macos: true },
    // The host owns navigation; an in-embed back arrow would strand the user
    // inside a pane that has nowhere to go back to. Composer ownership is
    // resolved once by the shared embed boundary.
    resolveEmbedProps: resolveThreadEmbedProps,
  },
});
