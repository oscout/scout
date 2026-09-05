import { ArrowDown, ArrowRight, AtSign, Bot, Check, ChevronDown, Copy, ExternalLink, Hash, LoaderCircle, Maximize2, MessageSquare, Minimize2, Paperclip, Plus, Radio, RefreshCw, SendHorizontal, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DictationMic } from "../../components/DictationMic.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { RuntimePicker } from "../../components/MessageComposer/index.ts";
import { api, peekApiGet } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { isRoutableMediaFile, uploadMediaFiles } from "../../lib/media-blobs.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { brokerAttemptTone } from "../../lib/status-tone.ts";
import { fullTimestamp, normalizeTimestampMs, timeAgo } from "../../lib/time.ts";
import type { Agent, BrokerDiagnostics, BrokerHistoryKey, BrokerRouteAttempt, DispatchFilter, Route } from "../../lib/types.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import {
  RUNTIME_CAPABILITY_SEED,
  runtimeCatalogFromCapabilities,
  type RuntimeCapabilityCatalog,
} from "../../lib/runtime-capabilities.ts";
import { effortsFor, type RuntimeValue } from "../../lib/runtime-catalog.ts";

import {
  brokerAttemptErrorSummary,
  brokerAttemptFailureTitle,
  brokerAttemptIsFailure,
  brokerAttemptTargetAgent,
  brokerAttemptContextText,
  brokerDispatchReviewRequest,
  brokerMessageFeedRows,
  brokerMetadataJson,
} from "./broker-display.ts";
import { BrokerMetadataPanel } from "./BrokerMetadataPanel.tsx";
import { DispatchAftermath } from "./DispatchAftermath.tsx";
import { brokerDiagnosticsUrl } from "./broker-query.ts";
import { useBrokerLedgerKeyboard } from "./useBrokerLedgerKeyboard.ts";
import { ShikiPane } from "../code/ShikiPane.tsx";
import { defineSurface } from "../../surfaces/types.ts";
import { useEmbedHeadline } from "../../surfaces/useEmbedHeadline.ts";
import "../system-surfaces-redesign.css";

type BrokerTab = DispatchFilter;

const BROKER_TABS: BrokerTab[] = ["all", "delivered", "failed"];

const ROUTE_CACHE_MAX_AGE_MS = 30_000;

const TAB_LABELS: Record<BrokerTab, string> = {
  all: "All",
  delivered: "Delivered",
  failed: "Failed",
};

function attemptKindLabel(kind: BrokerRouteAttempt["kind"]): string {
  switch (kind) {
    case "success":
      return "Success";
    case "failed_query":
      return "Query failure";
    case "failed_delivery":
      return "Delivery failure";
    default:
      return "Delivery attempt";
  }
}

function brokerAttemptReference(attempt: BrokerRouteAttempt): string {
  return attempt.messageId ?? attempt.deliveryId ?? attempt.invocationId ?? attempt.id;
}

/**
 * Dispatch status word. The ledger row no longer shows it — colour on the row
 * carries state for sighted operators — so this now feeds the row's accessible
 * name, the pending chip, and the inspector header beside the tone dot.
 */
function dispatchStateLabel(attempt: BrokerRouteAttempt): string {
  const tone = brokerAttemptTone(attempt.kind, attempt.status);
  switch (tone) {
    case "success":
      return "Delivered";
    case "danger":
      return "Failed";
    case "working":
      return "Pending";
    case "warning":
      return "Held";
    default:
      return attempt.status ? attempt.status.charAt(0).toUpperCase() + attempt.status.slice(1) : "Queued";
  }
}

/** Two-glyph sender badge: trailing number for numbered agents, else initials. */
function dispatchActorInitials(name: string | null): string {
  if (!name) return "··";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "··";
  const last = parts[parts.length - 1]!;
  if (/^\d+$/.test(last)) return last.slice(-2);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

/** Wall-clock stamp (e.g. "12:20 AM"); the day grouping supplies the date. */
function dispatchClock(ts: number): string {
  const ms = normalizeTimestampMs(ts) ?? 0;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dispatchClockWithSeconds(ts: number | string | null | undefined): string {
  const ms = normalizeTimestampMs(ts);
  if (ms === null) return "—";
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function metadataLeaf(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  for (const nested of Object.values(record)) {
    const result = metadataLeaf(nested, keys, depth + 1);
    if (result !== undefined) return result;
  }
  return undefined;
}

function metadataText(attempt: BrokerRouteAttempt, ...keys: string[]): string | null {
  const value = metadataLeaf(attempt.metadata, keys);
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text || null;
}

function metadataTimestamp(attempt: BrokerRouteAttempt, ...keys: string[]): number | null {
  const value = metadataLeaf(attempt.metadata, keys);
  return typeof value === "number" || typeof value === "string"
    ? normalizeTimestampMs(value)
    : null;
}

function dispatchChannelLabel(route: string | null): string {
  switch (route) {
    case "dm":
      return "Direct · agent";
    case "channel":
      return "Channel";
    case "broadcast":
      return "Broadcast";
    case null:
      return "No route";
    default:
      return route.replaceAll("_", " ");
  }
}

function dispatchPartyKind(attempt: BrokerRouteAttempt, side: "from" | "to"): string {
  if (side === "to") {
    if (attempt.route === "channel") return "Channel";
    if (attempt.route === "broadcast") return "Broadcast";
    return attempt.target?.toLowerCase().includes("operator") ? "Operator" : "Agent lane";
  }
  const actorClass = metadataText(attempt, "class", "actorClass")?.toLowerCase();
  if (actorClass === "operator" || actorClass === "human") return "Operator";
  if (actorClass === "agent") return "Agent";
  return attempt.actorName?.toLowerCase().includes("operator") ? "Operator" : "Sender";
}

function dispatchLatencyLabel(attempt: BrokerRouteAttempt): string {
  const rawDuration = metadataLeaf(attempt.metadata, ["latencyMs", "durationMs"]);
  if (typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0) {
    if (rawDuration < 1_000) return `${Math.round(rawDuration)}ms`;
    return `${(rawDuration / 1_000).toFixed(rawDuration < 10_000 ? 1 : 0)}s`;
  }
  const sentAt = metadataTimestamp(attempt, "sentAt", "createdAt") ?? normalizeTimestampMs(attempt.ts);
  const deliveredAt = metadataTimestamp(attempt, "deliveredAt", "completedAt");
  if (sentAt === null || deliveredAt === null || deliveredAt < sentAt) return "—";
  const duration = deliveredAt - sentAt;
  return duration < 1_000 ? `${duration}ms` : `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`;
}

/** Route-kind encoded as the address glyph next to the target id. */
function RouteGlyph({ route }: { route: string | null }) {
  switch (route) {
    case "channel":
      return <Hash size={12} aria-hidden="true" />;
    case "broadcast":
      return <Radio size={12} aria-hidden="true" />;
    case "dm":
      return <AtSign size={12} aria-hidden="true" />;
    default:
      return <MessageSquare size={12} aria-hidden="true" />;
  }
}

function dispatchEndpointAgent(agents: Agent[], value: string | null): Agent | null {
  if (!value) return null;
  const needle = value.trim().replace(/^@/, "").toLowerCase();
  return agents.find((agent) => [
    agent.id,
    agent.name,
    agent.handle,
    agent.selector,
    agent.defaultSelector,
    agent.conversationId,
    agent.harnessSessionId,
  ].some((candidate) => candidate?.trim().replace(/^@/, "").toLowerCase() === needle)) ?? null;
}

type DispatchParty = {
  /** Display name for this end of the edge. */
  label: string;
  /** What kind of thing it is (Agent, Operator, Session route, Channel…). */
  kind: string;
  agent: Agent | null;
};

function dispatchParty(
  attempt: BrokerRouteAttempt,
  agents: Agent[],
  side: "from" | "to",
): DispatchParty {
  const rawValue = side === "from" ? attempt.actorName : attempt.target;
  const agent = dispatchEndpointAgent(agents, rawValue);
  const label = agent?.name ?? rawValue ?? (side === "from" ? "Unknown" : "No target");
  const kind = agent
    ? "Agent"
    : side === "to" && attempt.conversationId
      ? "Session route"
      : dispatchPartyKind(attempt, side);
  return { label, kind, agent };
}

/**
 * From and To describe one relationship, so they hover as one card. The fields
 * name the edge — who, to what kind of thing, at which address, over which
 * channel — instead of repeating an endpoint dossier twice per row.
 *
 * Where the edge lands on a known agent we also carry branch, runtime and
 * machine: the inspector does not list them, so hover is the only place in
 * Dispatch they exist. The target's context wins over the sender's — the
 * target is the half the operator is scanning for.
 */
function dispatchRouteFields(
  attempt: BrokerRouteAttempt,
  from: DispatchParty,
  to: DispatchParty,
): Array<{ label: string; value: string }> {
  const context = to.agent ?? from.agent;
  return [
    { label: "From", value: from.kind },
    { label: "To", value: to.kind },
    { label: "Target", value: attempt.target ?? to.label },
    { label: "Channel", value: dispatchChannelLabel(attempt.route) },
    {
      label: "Project",
      value: context?.project ?? metadataText(attempt, "project", "projectName"),
    },
    { label: "Branch", value: context?.branch ?? metadataText(attempt, "branch") },
    {
      label: "Runtime",
      value: context
        ? [context.harness, context.model, context.reasoningEffort].filter(Boolean).join(" · ") || null
        : [metadataText(attempt, "harness"), metadataText(attempt, "model")].filter(Boolean).join(" · ") || null,
    },
    {
      label: "Machine",
      value: context?.authorityNodeName
        ?? context?.homeNodeName
        ?? context?.authorityNodeId
        ?? context?.homeNodeId
        ?? metadataText(attempt, "machine", "machineName", "nodeName"),
    },
  ].filter((field): field is { label: string; value: string } => Boolean(field.value));
}

function DispatchRouteFace({
  party,
  route,
  side,
}: {
  party: DispatchParty;
  route: string | null;
  side: "from" | "to";
}) {
  return (
    <span className={`sys-broker-route-end sys-broker-route-end--${side}`}>
      <span className="sys-broker-avatar sys-broker-endpoint-avatar" aria-hidden="true">
        {party.agent || side === "from"
          ? dispatchActorInitials(party.label)
          : <RouteGlyph route={route} />}
      </span>
      <span className="sys-broker-endpoint-name" title={party.label}>{party.label}</span>
    </span>
  );
}

/**
 * The route: one composite cell, one hover card, one truncation budget. The
 * sender recedes and gives up width first — the target is the half that varies
 * and the half the operator is scanning for.
 */
function DispatchRoute({ attempt, agents }: { attempt: BrokerRouteAttempt; agents: Agent[] }) {
  const from = dispatchParty(attempt, agents, "from");
  const to = dispatchParty(attempt, agents, "to");
  const fields = dispatchRouteFields(attempt, from, to);
  const descriptionId = `dispatch-route-${attempt.id}`;

  return (
    <span className="sys-broker-route" tabIndex={0} aria-describedby={descriptionId}>
      <DispatchRouteFace party={from} route={attempt.route} side="from" />
      <ArrowRight className="sys-broker-route-arrow" size={11} aria-hidden="true" />
      <DispatchRouteFace party={to} route={attempt.route} side="to" />
      <span className="sys-broker-endpoint-card" id={descriptionId} role="tooltip">
        <span className="sys-broker-endpoint-card-head">
          <span className="sys-broker-endpoint-card-edge">
            <span className="sys-broker-avatar sys-broker-endpoint-avatar" aria-hidden="true">
              {dispatchActorInitials(from.label)}
            </span>
            <strong>{from.label}</strong>
            <ArrowRight className="sys-broker-route-arrow" size={11} aria-hidden="true" />
            <span className="sys-broker-avatar sys-broker-endpoint-avatar" aria-hidden="true">
              {to.agent ? dispatchActorInitials(to.label) : <RouteGlyph route={attempt.route} />}
            </span>
            <strong>{to.label}</strong>
          </span>
        </span>
        <span className="sys-broker-endpoint-card-body">
          {fields.map((field) => (
            <span className="sys-broker-endpoint-card-field" key={field.label}>
              <small>{field.label}</small>
              <code title={field.value}>{field.value}</code>
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function dispatchDayKey(ts: number): string {
  const timestamp = normalizeTimestampMs(ts) ?? 0;
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dispatchDayLabel(ts: number, nowMs = Date.now()): string {
  const timestamp = normalizeTimestampMs(ts) ?? 0;
  const date = new Date(timestamp);
  const today = new Date(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);

  if (dispatchDayKey(ts) === dispatchDayKey(today.getTime())) return "Today";
  if (dispatchDayKey(ts) === dispatchDayKey(yesterday.getTime())) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function mergeBrokerPage(
  current: BrokerDiagnostics,
  next: BrokerDiagnostics,
  key: BrokerHistoryKey,
): BrokerDiagnostics {
  return {
    ...next,
    source: current.source,
    attempts: key === "attempts" ? [...current.attempts, ...next.attempts] : current.attempts,
    failedQueries: key === "failedQueries" ? [...current.failedQueries, ...next.failedQueries] : current.failedQueries,
    failedDeliveries: key === "failedDeliveries" ? [...current.failedDeliveries, ...next.failedDeliveries] : current.failedDeliveries,
    dialogue: key === "dialogue" ? [...current.dialogue, ...next.dialogue] : current.dialogue,
    ledger: {
      ...next.ledger,
      cursors: {
        ...current.ledger.cursors,
        [key]: next.ledger.cursors[key],
      },
      hasMore: {
        ...current.ledger.hasMore,
        [key]: next.ledger.hasMore[key],
      },
    },
  };
}

export function BrokerScreen({
  navigate,
  embedded = false,
  initialAttemptId,
}: {
  navigate: (r: Route) => void;
  embedded?: boolean;
  /** Embed deep link (`/embed/dispatch?attempt=…`); the shell uses the route. */
  initialAttemptId?: string;
}) {
  useEmbedHeadline("Dispatch", embedded);
  const { route, agents, selectedBrokerAttempt, inspectBrokerAttempt, clearBrokerAttempt } = useScout();
  // Warm start: paint the last diagnostics page on remount while the mount
  // effect's load("initial") refreshes it in the background.
  const [initialBroker] = useState(() =>
    peekApiGet<BrokerDiagnostics>(brokerDiagnosticsUrl(), ROUTE_CACHE_MAX_AGE_MS),
  );
  const [broker, setBroker] = useState<BrokerDiagnostics | null>(initialBroker);
  const activeTab: BrokerTab = route.view === "broker" ? route.filter ?? "all" : "all";
  const [loading, setLoading] = useState(initialBroker === null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brokerRef = useRef<BrokerDiagnostics | null>(initialBroker);
  const requestIdRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (mode: "initial" | "background" | "manual" = "initial") => {
    const requestId = ++requestIdRef.current;
    if (!brokerRef.current && mode !== "background") {
      setLoading(true);
      setError(null);
    } else {
      setRefreshing(true);
    }

    try {
      const next = await api<BrokerDiagnostics>(brokerDiagnosticsUrl());
      if (requestId !== requestIdRef.current) return;
      brokerRef.current = next;
      setBroker(next);
      setError(null);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const loadOlder = useCallback(async () => {
    const current = brokerRef.current;
    if (!current || loadingOlder) return;
    const key: BrokerHistoryKey = "attempts";
    const cursor = current.ledger.cursors[key];
    if (!cursor || !current.ledger.hasMore[key]) return;

    const requestId = ++requestIdRef.current;
    setLoadingOlder(true);
    setError(null);

    try {
      const next = await api<BrokerDiagnostics>(brokerDiagnosticsUrl(cursor));
      if (requestId !== requestIdRef.current) return;
      const latest = brokerRef.current;
      const merged = latest ? mergeBrokerPage(latest, next, key) : next;
      brokerRef.current = merged;
      setBroker(merged);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoadingOlder(false);
      }
    }
  }, [loadingOlder]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load("background");
    }, 250);
  }, [load]);

  useEffect(() => {
    void load("initial");
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [load]);

  useBrokerEvents((event) => {
    if (
      event.kind === "message.posted" ||
      event.kind === "delivery.planned" ||
      event.kind === "delivery.attempted" ||
      event.kind === "delivery.state.changed" ||
      event.kind === "scout.dispatched"
    ) {
      scheduleRefresh();
    }
  });

  const feedRows = useMemo(() => {
    if (!broker) return [];
    const messageBodies = new Map(broker.dialogue.map((message) => [message.id, message.body]));
    return brokerMessageFeedRows(broker.attempts).map((attempt) => {
      const body = attempt.messageId ? messageBodies.get(attempt.messageId) : null;
      return body && body !== attempt.detail ? { ...attempt, detail: body } : attempt;
    });
  }, [broker]);

  const activeRows = useMemo(() => {
    switch (activeTab) {
      case "delivered":
        return feedRows.filter((attempt) => !brokerAttemptIsFailure(attempt));
      case "failed":
        return feedRows.filter(brokerAttemptIsFailure);
      default:
        return feedRows;
    }
  }, [activeTab, feedRows]);
  const activeHasMore = broker?.ledger.hasMore.attempts ?? false;
  const tabCounts = useMemo<Record<BrokerTab, number>>(() => ({
    all: feedRows.length,
    delivered: feedRows.filter((attempt) => !brokerAttemptIsFailure(attempt)).length,
    failed: feedRows.filter(brokerAttemptIsFailure).length,
  }), [feedRows]);

  const selectedAttempt = useMemo(() => {
    const requestedAttemptId = route.view === "broker" ? route.attemptId : undefined;
    if (!broker || !requestedAttemptId) return null;
    return feedRows.find((attempt) => attempt.id === requestedAttemptId)
      ?? broker.attempts.find((attempt) => attempt.id === requestedAttemptId)
      ?? broker.failedQueries.find((attempt) => attempt.id === requestedAttemptId)
      ?? broker.failedDeliveries.find((attempt) => attempt.id === requestedAttemptId)
      ?? null;
  }, [broker, feedRows, route]);

  // Every background refresh rebuilds the feed from JSON, so the selected row
  // is a fresh object each poll even when nothing about it changed. Comparing
  // by identity re-cached it into context on every poll and re-rendered the
  // whole surface — including the inspector the operator is typing into. Only
  // a real change (a different row, or new state/timing on the same row) is
  // worth pushing through.
  const selectedAttemptSignature = selectedAttempt
    ? `${selectedAttempt.id}\0${selectedAttempt.status}\0${selectedAttempt.ts}`
    : null;
  const cachedAttemptSignature = selectedBrokerAttempt
    ? `${selectedBrokerAttempt.id}\0${selectedBrokerAttempt.status}\0${selectedBrokerAttempt.ts}`
    : null;

  useEffect(() => {
    if (selectedAttempt && selectedAttemptSignature !== cachedAttemptSignature) {
      inspectBrokerAttempt(selectedAttempt);
    }
  }, [cachedAttemptSignature, inspectBrokerAttempt, selectedAttempt, selectedAttemptSignature]);

  // Selection is the shell's to hold only when there is a shell. An embed's
  // location is `/embed/dispatch`, which never parses to a `broker` route, so
  // the provider's cached attempt stays null there no matter what is clicked —
  // and routing through it would also rewrite the WebView's URL to the shell
  // path. The embed therefore keeps its own selection.
  const [embeddedSelection, setEmbeddedSelection] = useState<BrokerRouteAttempt | null>(null);
  /** Set once the deep-link seed has fired, or the operator has taken over. */
  const seedConsumedRef = useRef(false);
  const selectAttempt = useCallback((attempt: BrokerRouteAttempt) => {
    if (embedded) {
      // Any deliberate selection retires the deep-link seed (see below).
      seedConsumedRef.current = true;
      setEmbeddedSelection(attempt);
      return;
    }
    inspectBrokerAttempt(attempt);
  }, [embedded, inspectBrokerAttempt]);
  const clearSelection = useCallback(() => {
    if (embedded) {
      seedConsumedRef.current = true;
      setEmbeddedSelection(null);
      return;
    }
    clearBrokerAttempt();
  }, [clearBrokerAttempt, embedded]);

  const activateLedgerRow = useCallback((index: number) => {
    const attempt = activeRows[index];
    if (!attempt) return;
    selectAttempt(attempt);
    window.dispatchEvent(new CustomEvent("scout:set-inspector-width", {
      detail: { width: 520 },
    }));
  }, [activeRows, selectAttempt]);

  const { getRowFocusProps, setFocusedIndex } = useBrokerLedgerKeyboard({
    enabled: Boolean(broker) && activeRows.length > 0,
    rowCount: activeRows.length,
    onActivateRow: activateLedgerRow,
    onClearSelection: clearSelection,
  });

  // The ledger reloads every few seconds and rebuilds every row object. A
  // selection captured at click time would keep rendering the status the row
  // had *then* — so a dispatch that later failed would show Delivered in the
  // pane while the ledger beside it shows Failed. Re-read the live row.
  const embeddedSelectionId = embeddedSelection?.id ?? null;
  const embeddedSelectionSignature = embeddedSelection
    ? `${embeddedSelection.id} ${embeddedSelection.status} ${embeddedSelection.ts}`
    : null;
  useEffect(() => {
    if (!embedded || !embeddedSelectionId) return;
    const fresh = feedRows.find((row) => row.id === embeddedSelectionId);
    if (!fresh) return;
    if (`${fresh.id} ${fresh.status} ${fresh.ts}` === embeddedSelectionSignature) return;
    setEmbeddedSelection(fresh);
  }, [embedded, embeddedSelectionId, embeddedSelectionSignature, feedRows]);

  // An embed deep link carries only an id, which the ledger may not hold yet —
  // an older attempt only appears after "Load older". So the seed stays armed
  // rather than firing once, but it is disarmed the moment the operator takes
  // over: a late seed must never yank a selection they made, and must never
  // resurrect one they dismissed. Failed queries and deliveries are searched
  // too; those ids never appear in the message feed.
  useEffect(() => {
    if (!embedded || !initialAttemptId || !broker) return;
    if (seedConsumedRef.current || embeddedSelection) return;
    const match = feedRows.find((row) => row.id === initialAttemptId)
      ?? broker.attempts.find((row) => row.id === initialAttemptId)
      ?? broker.failedQueries.find((row) => row.id === initialAttemptId)
      ?? broker.failedDeliveries.find((row) => row.id === initialAttemptId);
    if (!match) return;
    seedConsumedRef.current = true;
    setEmbeddedSelection(match);
  }, [broker, embedded, embeddedSelection, feedRows, initialAttemptId]);

  useEffect(() => {
    const requestedAttemptId = route.view === "broker" ? route.attemptId : undefined;
    if (!requestedAttemptId) return;
    const index = activeRows.findIndex((row) => row.id === requestedAttemptId);
    if (index >= 0) setFocusedIndex(index);
  }, [activeRows, activeTab, route, setFocusedIndex]);

  const cycleBrokerTab = useCallback((delta: number) => {
    const current = BROKER_TABS.indexOf(activeTab);
    const next = (current + delta + BROKER_TABS.length) % BROKER_TABS.length;
    const filter = BROKER_TABS[next]!;
    navigate({ view: "broker", ...(filter === "all" ? {} : { filter }) });
  }, [activeTab, navigate]);

  // The web shell mounts the inspector in its right rail. An embed has no rail
  // — the native host owns that chrome — so selecting a row used to update
  // context nothing rendered. The embed therefore carries its own detail pane
  // instead of the host trying to reproduce a web-side inspector natively.
  const inspectorAttempt = embedded ? embeddedSelection : null;

  // SCO-083: Dispatch is its own primary area — do not render OpsSubnav here.
  return (
    <div className={`s-ops${embedded ? " s-ops--embedded" : ""}${inspectorAttempt ? " s-ops--split" : ""}`}>
      <div className="s-ops-body">
        <div className="sys-surface-page sys-surface-page-wide sys-surface-page-fluid sys-broker-page">
          <div className="sys-ledger-toolbar" aria-label="Dispatch controls">
            {broker ? (
              <div
                className="sys-tab-row sys-tab-row--toolbar"
                role="tablist"
                aria-label="Dispatch message filters"
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    cycleBrokerTab(1);
                  } else if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    cycleBrokerTab(-1);
                  }
                }}
              >
                {BROKER_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    className={`sys-tab${activeTab === tab ? " sys-tab-active" : ""}`}
                    onClick={() => navigate({
                      view: "broker",
                      ...(tab === "all" ? {} : { filter: tab }),
                    })}
                  >
                    <span>{TAB_LABELS[tab]}</span>
                    <span className="sys-tab-count">{tabCounts[tab]}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="sys-ledger-kicker">Dispatch ledger</div>
            )}
            <div className="sys-page-actions sys-ledger-actions">
              <div className="sys-sync-note">
                {loading
                  ? "Loading dispatch ledger..."
                  : broker
                    ? `Updated ${timeAgo(broker.generatedAt)}${broker.source?.latestMessageAt ? ` · latest message ${timeAgo(broker.source.latestMessageAt)}` : ""}`
                    : "Waiting for dispatch data"}
              </div>
              <button
                type="button"
                className="s-btn"
                disabled={loading || refreshing}
                onClick={() => void load("manual")}
              >
                {refreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          {error && (
            <div className="sys-banner sys-banner-warning">
              <strong>Refresh failed.</strong>
              <span>{error}</span>
            </div>
          )}

          {refreshing && broker && (
            <div
              className="sys-broker-source-note"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle className="sys-broker-source-spinner" size={12} aria-hidden="true" />
              <strong>Updating dispatches…</strong>
            </div>
          )}

          {!refreshing
            && broker?.source?.mode === "sqlite_projection"
            && broker.source.status === "degraded"
            && broker.source.detail && (
            <div
              className="sys-broker-source-note sys-broker-source-note--warning"
              role="status"
              aria-label={broker.source.detail}
              title={broker.source.detail}
            >
              <span className="sys-broker-source-dot" aria-hidden="true" />
              <strong>
                {broker.source.brokerReachable
                  ? "Dispatch history is loading"
                  : "Dispatch may be out of date"}
              </strong>
              <span>
                {broker.source.brokerReachable
                  ? "Broker online; showing saved dispatch history while live messages load."
                  : "Live broker unavailable; showing saved dispatch history."}
              </span>
            </div>
          )}

          {loading && !broker && (
            <div className="sys-broker-empty-wrap">
              <EmptyState
                className="sys-state-card-centered"
                icon={<LoaderCircle className="sys-broker-source-spinner" size={24} aria-hidden="true" />}
                title="Loading dispatch"
                body="Reading the dispatch database snapshot."
              />
            </div>
          )}

          {!loading && !broker && !error && (
            <div className="sys-broker-empty-wrap">
              <EmptyState
                className="sys-state-card-centered"
                title="No dispatch data"
                body="No dispatch rows are available yet."
              />
            </div>
          )}

          {broker && (
            <>
              <BrokerAttemptList
                attempts={activeRows}
                agents={agents}
                // Clicking a row inspects without navigating, so the deep-link
                // id alone left every click unhighlighted. The inspected row is
                // the selection; the route id only seeds it.
                selectedAttemptId={embedded
                  ? embeddedSelection?.id ?? null
                  : selectedBrokerAttempt?.id
                    ?? (route.view === "broker" ? route.attemptId ?? null : null)}
                onInspect={selectAttempt}
                getRowFocusProps={getRowFocusProps}
              />
              {activeRows.length > 0 && activeHasMore && (
                <div className="sys-ledger-footer">
                  <button
                    type="button"
                    className="s-btn"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {loadingOlder ? "Loading older..." : "Load older"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {inspectorAttempt && (
          <div className="s-broker-embed-detail">
            <BrokerAttemptInspector
              attempt={inspectorAttempt}
              navigate={navigate}
              onClose={clearSelection}
            />
          </div>
        )}
      </div>
    </div>
  );
}

type BrokerRowFocusProps = ReturnType<typeof useBrokerLedgerKeyboard>["getRowFocusProps"];

function BrokerAttemptList({
  attempts,
  agents,
  selectedAttemptId,
  onInspect,
  getRowFocusProps,
}: {
  attempts: BrokerRouteAttempt[];
  agents: Agent[];
  selectedAttemptId: string | null;
  onInspect: (attempt: BrokerRouteAttempt) => void;
  getRowFocusProps: BrokerRowFocusProps;
}) {
  if (attempts.length === 0) {
    return (
      <div className="sys-broker-empty-wrap">
        <EmptyState
          className="sys-state-card-centered"
          title="No dispatch rows"
          body="No dispatch rows are available yet."
        />
      </div>
    );
  }

  const groups = attempts.reduce<Array<{
    key: string;
    label: string;
    attempts: Array<{ attempt: BrokerRouteAttempt; index: number }>;
  }>>((result, attempt, index) => {
    const key = dispatchDayKey(attempt.ts);
    const current = result[result.length - 1];
    if (current?.key === key) {
      current.attempts.push({ attempt, index });
    } else {
      result.push({ key, label: dispatchDayLabel(attempt.ts), attempts: [{ attempt, index }] });
    }
    return result;
  }, []);

  return (
    <div className="sys-broker-wire" aria-label="Dispatch ledger">
      <div className="sys-broker-wire-head" aria-hidden="true">
        <span className="sys-broker-col sys-broker-col--route">Route</span>
        <span className="sys-broker-col sys-broker-col--msg">Message</span>
        <span className="sys-broker-col sys-broker-col--time">Time</span>
      </div>
      {groups.map((group) => (
        <section className="sys-broker-day" key={group.key} aria-labelledby={`dispatch-day-${group.key}`}>
          <header className="sys-broker-day-head">
            <h2 id={`dispatch-day-${group.key}`}>{group.label}</h2>
            <span>{group.attempts.length} {group.attempts.length === 1 ? "dispatch" : "dispatches"}</span>
          </header>
          <div className="sys-broker-wire-body" role="list">
            {group.attempts.map(({ attempt, index }) => {
              const tone = brokerAttemptTone(attempt.kind, attempt.status);
              const isFailure = brokerAttemptIsFailure(attempt);
              const isPending = !isFailure && (tone === "working" || tone === "warning");
              const errorSummary = brokerAttemptErrorSummary(attempt);
              const stateLabel = dispatchStateLabel(attempt);
              // Delivered is the unmarked norm: the row itself carries state in
              // colour, and the chip only speaks when the dispatch did not just
              // work. The state word survives for screen readers in aria-label.
              const chipText = isFailure ? errorSummary : isPending ? stateLabel : null;
              const inspect = () => {
                onInspect(attempt);
                window.dispatchEvent(new CustomEvent("scout:set-inspector-width", {
                  detail: { width: 520 },
                }));
              };
              return (
                <div
                  key={attempt.id}
                  role="listitem"
                  className={`sys-broker-wire-row${isFailure ? " sys-broker-wire-row--failure" : isPending ? " sys-broker-wire-row--pending" : ""}${selectedAttemptId === attempt.id ? " sys-broker-wire-row--selected" : ""}`}
                  aria-label={`${stateLabel}. Inspect ${attempt.detail}`}
                  onClick={inspect}
                  {...getRowFocusProps(index)}
                >
                  <div className="sys-broker-cell sys-broker-col--route">
                    <DispatchRoute attempt={attempt} agents={agents} />
                  </div>
                  <div className="sys-broker-cell sys-broker-col--msg">
                    <span className="sys-broker-msg" title={attempt.detail}>{attempt.detail}</span>
                    {chipText && (
                      <span
                        className={`sys-broker-msg-error sys-broker-msg-error--${isFailure ? "danger" : "warning"}`}
                        title={chipText}
                      >
                        {chipText}
                      </span>
                    )}
                  </div>
                  <div className="sys-broker-cell sys-broker-col--time">
                    <time
                      className="sys-broker-time-abs"
                      title={`${timeAgo(attempt.ts)} · ${fullTimestamp(attempt.ts)}`}
                    >
                      {dispatchClock(attempt.ts)}
                    </time>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function brokerInspectorRows(attempt: BrokerRouteAttempt): Array<{ label: string; value: string }> {
  const reference = brokerAttemptReference(attempt);
  return [
    { label: "Kind", value: attemptKindLabel(attempt.kind) },
    { label: "Time", value: fullTimestamp(attempt.ts) },
    { label: "Actor", value: attempt.actorName },
    { label: "Target", value: attempt.target },
    { label: "Route", value: attempt.route },
    { label: "Conversation", value: attempt.conversationId },
    { label: "Reference", value: reference },
    { label: "Message", value: attempt.messageId === reference ? null : attempt.messageId },
    { label: "Delivery", value: attempt.deliveryId === reference ? null : attempt.deliveryId },
    { label: "Invocation", value: attempt.invocationId === reference ? null : attempt.invocationId },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));
}

function CopyIconButton({ value, subject, className }: { value: string; subject: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setStatus("idle");
  }, [value]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copyValue = useCallback(async () => {
    const copied = await copyTextToClipboard(value);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setStatus(copied ? "copied" : "failed");
    resetTimerRef.current = setTimeout(() => {
      setStatus("idle");
      resetTimerRef.current = null;
    }, 1500);
  }, [value]);

  const copied = status === "copied";
  const failed = status === "failed";

  return (
    <button
      type="button"
      className={`sys-copy-btn${className ? ` ${className}` : ""}${copied ? " sys-copy-btn--copied" : ""}${failed ? " sys-copy-btn--failed" : ""}`}
      onClick={() => void copyValue()}
      title={copied ? `Copied ${subject}` : failed ? "Copy failed" : `Copy ${subject}`}
      aria-label={copied ? `Copied ${subject}` : failed ? `Copy ${subject} failed` : `Copy ${subject}`}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

type DispatchReviewResponse = {
  ok: true;
  conversationId: string | null;
  messageId: string | null;
  flightId: string | null;
  targetAgentId: string | null;
  targetLabel: string | null;
  dedupeFingerprint: string;
  rootCauseFingerprint: string;
};

type DispatchAskResponse = {
  conversationId?: string | null;
  flightId?: string | null;
  flight?: { id?: string | null } | null;
  targetAgentId?: string | null;
};

type DispatchActionStatus = "idle" | "sending" | "sent" | "failed";

function dispatchPayloadSource(payload: string): {
  code: string;
  path: "payload.json" | "payload.md";
  language: "JSON" | "Text · Markdown";
} {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return {
        code: JSON.stringify(JSON.parse(trimmed), null, 2),
        path: "payload.json",
        language: "JSON",
      };
    } catch {
      // A prose payload can legitimately begin with a bracket. Preserve it.
    }
  }
  return { code: payload, path: "payload.md", language: "Text · Markdown" };
}

function DispatchPayloadViewer({ payload }: { payload: string }) {
  const source = useMemo(() => dispatchPayloadSource(payload), [payload]);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lineCount = source.code.split("\n").length;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !expanded || dialog.open) return;
    dialog.showModal();
  }, [expanded]);

  useEffect(() => {
    setExpanded(false);
  }, [payload]);

  const code = (
    <div
      className="sys-broker-payload-code"
      data-language={source.path === "payload.json" ? "json" : "markdown"}
      role="region"
      aria-label={`Dispatch payload, ${source.language}`}
      tabIndex={0}
    >
      <ShikiPane code={source.code} path={source.path} />
    </div>
  );

  return (
    <>
      <div className="sys-broker-payload-head">
        <span className="sys-detail-label">Payload</span>
        <span className="sys-broker-payload-meta">{source.language} · {lineCount} {lineCount === 1 ? "line" : "lines"}</span>
        <CopyIconButton value={payload} subject="payload" />
        <button
          type="button"
          className="sys-copy-btn sys-broker-payload-expand"
          onClick={() => setExpanded(true)}
          title="Expand payload"
          aria-label="Expand payload"
        >
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="sys-broker-payload-resizer">{code}</div>

      {expanded && createPortal(
        <dialog
          ref={dialogRef}
          className="sys-broker-payload-dialog"
          aria-label="Expanded dispatch payload"
          onCancel={(event) => {
            event.preventDefault();
            setExpanded(false);
          }}
          onClose={() => setExpanded(false)}
        >
          <header className="sys-broker-payload-dialog-head">
            <div>
              <span className="sys-detail-label">Dispatch payload</span>
              <span className="sys-broker-payload-meta">{source.language} · {lineCount} {lineCount === 1 ? "line" : "lines"}</span>
            </div>
            <CopyIconButton value={payload} subject="payload" />
            <button
              type="button"
              className="sys-copy-btn"
              onClick={() => setExpanded(false)}
              title="Return payload to inspector"
              aria-label="Return payload to inspector"
            >
              <Minimize2 size={14} aria-hidden="true" />
            </button>
          </header>
          <div className="sys-broker-payload-dialog-body">{code}</div>
        </dialog>,
        document.body,
      )}
    </>
  );
}

function DispatchRouteFailure({ attempt }: { attempt: BrokerRouteAttempt }) {
  const title = brokerAttemptFailureTitle(attempt);
  return (
    <div className="sys-broker-route-failure" role="status">
      <span className="sys-broker-route-failure-mark" aria-hidden="true"><X size={14} /></span>
      <div>
        <span className="sys-detail-label">Routing stopped</span>
        <strong>{title}</strong>
        <p>{attempt.detail}</p>
      </div>
      <CopyIconButton value={attempt.detail} subject="failure detail" />
    </div>
  );
}

export function BrokerAttemptInspector({
  attempt,
  navigate,
  onClose,
}: {
  attempt: BrokerRouteAttempt;
  navigate: (r: Route) => void;
  onClose: () => void;
}) {
  const { route, agents, scoutbotAgentId } = useScout();
  const rows = brokerInspectorRows(attempt);
  const metadata = brokerMetadataJson(attempt.metadata);
  const isFailure = brokerAttemptIsFailure(attempt);
  const isRouteFailure = attempt.kind === "failed_query";
  const errorSummary = brokerAttemptErrorSummary(attempt);
  const tone = brokerAttemptTone(attempt.kind, attempt.status);
  const sentAt = metadataTimestamp(attempt, "sentAt", "createdAt") ?? normalizeTimestampMs(attempt.ts);
  const deliveredAt = metadataTimestamp(attempt, "deliveredAt", "completedAt")
    ?? normalizeTimestampMs(attempt.ts);
  const reference = brokerAttemptReference(attempt);
  const [reviewStatus, setReviewStatus] = useState<"idle" | "running" | "sent" | "failed">("idle");
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [reviewConversationId, setReviewConversationId] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [redispatchAgentId, setRedispatchAgentId] = useState("");
  const [redispatchStatus, setRedispatchStatus] = useState<DispatchActionStatus>("idle");
  const [redispatchMessage, setRedispatchMessage] = useState<string | null>(null);
  const [forwardAgentId, setForwardAgentId] = useState("");
  const [forwardProjectPath, setForwardProjectPath] = useState("");
  const [forwardHarness, setForwardHarness] = useState("");
  const [forwardModel, setForwardModel] = useState("");
  const [forwardEffort, setForwardEffort] = useState("medium");
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<RuntimeCapabilityCatalog | null>(null);
  const [forwardFiles, setForwardFiles] = useState<File[]>([]);
  const [forwardStatus, setForwardStatus] = useState<DispatchActionStatus>("idle");
  const [forwardMessage, setForwardMessage] = useState<string | null>(null);
  const retryHarness = metadataText(attempt, "harness");
  const retryModel = metadataText(attempt, "model");
  const retryEffort = metadataText(attempt, "reasoningEffort", "effort");
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const forwardFileInputRef = useRef<HTMLInputElement>(null);
  const contextText = useMemo(() => brokerAttemptContextText(attempt), [attempt]);
  const routableAgents = useMemo(
    () => agents
      .filter((agent) => !agent.retiredFromFleet && !agent.staleLocalRegistration)
      .slice()
      .sort((left, right) => {
        if (left.id === scoutbotAgentId) return -1;
        if (right.id === scoutbotAgentId) return 1;
        return (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.name.localeCompare(right.name);
      }),
    [agents, scoutbotAgentId],
  );
  const originalTargetAgentId = useMemo(
    () => brokerAttemptTargetAgent(attempt, routableAgents)?.id ?? "",
    [attempt, routableAgents],
  );
  const defaultForwardAgentId = routableAgents.some((agent) => agent.id === scoutbotAgentId)
    ? scoutbotAgentId
    : routableAgents[0]?.id ?? "";
  const firstRoutableAgentId = routableAgents[0]?.id ?? "";
  const defaultForwardAgent = routableAgents.find((agent) => agent.id === defaultForwardAgentId) ?? null;
  const projectOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const agent of routableAgents) {
      const path = agent.projectRoot?.trim() || agent.cwd?.trim();
      if (!path) continue;
      const fallback = path.split("/").filter(Boolean).at(-1) ?? path;
      options.set(path, agent.project?.trim() || fallback);
    }
    return [...options.entries()].map(([path, label]) => ({ path, label }));
  }, [routableAgents]);

  // Everything the composer is seeded from is derived from the fleet snapshot,
  // and that snapshot churns constantly: `routableAgents` is re-sorted by
  // `updatedAt` on every agents poll, so `firstRoutableAgentId` and friends
  // change identity whenever any agent does anything. Those values are read
  // through a ref so a *reset* can be driven by one thing only — the operator
  // selecting a different dispatch. Depending on them directly meant a busy
  // fleet wiped the half-typed request and re-pointed the recipient mid-compose.
  const composerDefaultsRef = useRef({
    originalTargetAgentId,
    firstRoutableAgentId,
    defaultForwardAgentId,
    defaultForwardAgent,
    effort: "medium",
  });
  composerDefaultsRef.current = {
    originalTargetAgentId,
    firstRoutableAgentId,
    defaultForwardAgentId,
    defaultForwardAgent,
    effort: metadataText(attempt, "reasoningEffort", "effort") || "medium",
  };
  // Set as soon as the operator picks a route themselves, so later seeding can
  // never re-fill a field they deliberately changed (including back to "any").
  const routingTouchedRef = useRef(false);

  useEffect(() => {
    const defaults = composerDefaultsRef.current;
    routingTouchedRef.current = false;
    setReviewStatus("idle");
    setReviewMessage(null);
    setReviewConversationId(null);
    setMessageDraft("");
    setRedispatchAgentId(defaults.originalTargetAgentId || defaults.firstRoutableAgentId);
    setRedispatchStatus("idle");
    setRedispatchMessage(null);
    setForwardAgentId(defaults.defaultForwardAgentId);
    setForwardProjectPath(
      defaults.defaultForwardAgent?.projectRoot?.trim() || defaults.defaultForwardAgent?.cwd?.trim() || "",
    );
    setForwardHarness(defaults.defaultForwardAgent?.harness?.trim() || "");
    setForwardModel(defaults.defaultForwardAgent?.model?.trim() || "");
    setForwardEffort(defaults.effort);
    setForwardFiles([]);
    setForwardStatus("idle");
    setForwardMessage(null);
    // Deliberately keyed on the selected dispatch alone — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt.id]);

  // The fleet snapshot can land (or repopulate) after this panel mounts, so
  // routing fields that are still empty get filled in. Values that are already
  // set are left alone: seeding must never overwrite an operator's choice.
  useEffect(() => {
    if (routingTouchedRef.current) return;
    setRedispatchAgentId((current) => current || originalTargetAgentId || firstRoutableAgentId);
    setForwardAgentId((current) => current || defaultForwardAgentId);
    setForwardProjectPath((current) => current
      || defaultForwardAgent?.projectRoot?.trim()
      || defaultForwardAgent?.cwd?.trim()
      || "");
    setForwardHarness((current) => current || defaultForwardAgent?.harness?.trim() || "");
    setForwardModel((current) => current || defaultForwardAgent?.model?.trim() || "");
  }, [defaultForwardAgent, defaultForwardAgentId, firstRoutableAgentId, originalTargetAgentId]);

  useEffect(() => {
    const query = new URLSearchParams({ scope: "global+project" });
    if (forwardProjectPath) query.set("projectRoot", forwardProjectPath);
    let cancelled = false;
    void api<RuntimeCapabilityCatalog>(`/api/runner/options?${query.toString()}`)
      .then((options) => {
        if (!cancelled && options.schemaVersion === "openscout.runtime-capabilities.v1") {
          setRuntimeCapabilities(options);
        }
      })
      .catch(() => {
        // The built-in seed remains available while the server is unreachable.
      });
    return () => { cancelled = true; };
  }, [forwardProjectPath]);

  const prepareScoutMessage = useCallback((prompt: string) => {
    setMessageDraft(prompt);
    window.requestAnimationFrame(() => messageInputRef.current?.focus());
  }, []);

  const redispatch = useCallback(async () => {
    const target = routableAgents.find((agent) => agent.id === redispatchAgentId);
    if (!target || redispatchStatus === "sending") return;
    setRedispatchStatus("sending");
    setRedispatchMessage(null);
    try {
      const result = await api<DispatchAskResponse>("/api/ask", {
        method: "POST",
        body: JSON.stringify({
          body: attempt.detail,
          targetAgentId: target.id,
          targetLabel: target.name,
          ...((retryHarness || retryModel || retryEffort) ? {
            execution: {
              ...(retryHarness ? { harness: retryHarness } : {}),
              ...(retryModel ? { model: retryModel } : {}),
              ...(retryEffort ? { reasoningEffort: retryEffort } : {}),
              session: "new",
            },
          } : {}),
          metadata: {
            source: "scout-dispatch-redispatch",
            originalDispatchId: attempt.id,
            ...(attempt.messageId ? { originalMessageId: attempt.messageId } : {}),
            ...(attempt.conversationId ? { originalConversationId: attempt.conversationId } : {}),
          },
        }),
      });
      const flightId = result.flightId ?? result.flight?.id;
      setRedispatchStatus("sent");
      setRedispatchMessage(`New dispatch sent to ${target.name}${flightId ? ` · ${flightId}` : ""}`);
    } catch (error) {
      setRedispatchStatus("failed");
      setRedispatchMessage(`Retry failed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [attempt, redispatchAgentId, redispatchStatus, retryEffort, retryHarness, retryModel, routableAgents]);

  const forwardDispatch = useCallback(async () => {
    const note = messageDraft.trim();
    const target = routableAgents.find((agent) => agent.id === forwardAgentId);
    if (!note || !target || forwardStatus === "sending") return;
    setForwardStatus("sending");
    setForwardMessage(forwardFiles.length > 0 ? `Uploading ${forwardFiles.length} ${forwardFiles.length === 1 ? "attachment" : "attachments"}…` : null);
    try {
      const attachments = forwardFiles.length > 0 ? await uploadMediaFiles(forwardFiles) : [];
      const result = await api<DispatchAskResponse>("/api/ask", {
        method: "POST",
        body: JSON.stringify({
          body: `${note}\n\nAttached dispatch context:\n${contextText}`,
          targetAgentId: target.id,
          targetLabel: target.name,
          ...(attachments.length > 0 ? { attachments } : {}),
          execution: {
            ...(forwardHarness ? { harness: forwardHarness } : {}),
            ...(forwardModel ? { model: forwardModel } : {}),
            ...(forwardEffort ? { reasoningEffort: forwardEffort } : {}),
          },
          metadata: {
            source: "scout-dispatch-forward",
            originalDispatchId: attempt.id,
            ...(forwardProjectPath ? { targetProjectPath: forwardProjectPath } : {}),
            ...(attempt.messageId ? { originalMessageId: attempt.messageId } : {}),
            ...(attempt.conversationId ? { originalConversationId: attempt.conversationId } : {}),
          },
        }),
      });
      const flightId = result.flightId ?? result.flight?.id;
      setForwardStatus("sent");
      setForwardMessage(`Request sent to ${target.name}${flightId ? ` · ${flightId}` : ""}`);
      setMessageDraft("");
      setForwardFiles([]);
    } catch (error) {
      setForwardStatus("failed");
      setForwardMessage(`Request wasn't sent. ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [attempt, contextText, forwardAgentId, forwardEffort, forwardFiles, forwardHarness, forwardModel, forwardProjectPath, forwardStatus, messageDraft, routableAgents]);

  const addForwardFiles = useCallback((files: File[]) => {
    const accepted = files.filter(isRoutableMediaFile);
    const rejected = files.length - accepted.length;
    if (accepted.length > 0) {
      setForwardFiles((current) => [...current, ...accepted]);
      setForwardStatus("idle");
      setForwardMessage(null);
    }
    if (rejected > 0) {
      setForwardStatus("failed");
      setForwardMessage("Attach markdown, code, an image, or a video clip.");
    }
  }, []);

  const scoutPrompts = isFailure
    ? ["Get a second opinion", "Propose a recovery plan", "Draft a follow-up"]
    : ["Summarize this dispatch", "Draft a follow-up", "What changed?"];
  const redispatchAgent = routableAgents.find((agent) => agent.id === redispatchAgentId) ?? null;
  const forwardAgent = routableAgents.find((agent) => agent.id === forwardAgentId) ?? null;
  const forwardProjectAgents = routableAgents.filter((agent) => {
    if (!forwardProjectPath) return true;
    return (agent.projectRoot?.trim() || agent.cwd?.trim()) === forwardProjectPath;
  });
  const effectiveCapabilities = runtimeCapabilities ?? RUNTIME_CAPABILITY_SEED;
  // The picker runs on a nested catalog. Models observed on live agents but
  // missing from the capability snapshot stay selectable as "observed" rows,
  // and "" keeps its meaning: no override — the broker picks the runtime.
  const forwardCatalog = useMemo(() => {
    const base = runtimeCatalogFromCapabilities(effectiveCapabilities);
    const observed = [
      forwardModel,
      forwardAgent?.harness === forwardHarness ? forwardAgent.model : null,
      ...forwardProjectAgents
        .filter((agent) => agent.harness === forwardHarness)
        .map((agent) => agent.model),
    ]
      .map((model) => model?.trim())
      .filter((model): model is string => Boolean(model));
    let harnesses = base.harnesses;
    if (!harnesses.some((entry) => entry.value === forwardHarness)) {
      harnesses = [
        { value: forwardHarness, label: forwardHarness || "default", models: [] },
        ...harnesses,
      ];
    }
    harnesses = harnesses.map((entry) => {
      if (entry.value !== forwardHarness) return entry;
      const withDefault = entry.models.some((model) => model.value === "")
        ? entry.models
        : [{ value: "", label: "Default", note: "harness picks" }, ...entry.models];
      const known = new Set(withDefault.map((model) => model.value));
      const extras = observed
        .filter((model) => !known.has(model))
        .map((model) => ({ value: model, label: model, note: "observed" }));
      return extras.length === 0 && withDefault === entry.models
        ? entry
        : { ...entry, models: [...withDefault, ...extras] };
    });
    return { ...base, harnesses };
  }, [effectiveCapabilities, forwardAgent, forwardHarness, forwardModel, forwardProjectAgents]);

  // Outside user interaction (capabilities arriving, target switching) the
  // picker never sees a change event, so the effort clamp lives here.
  useEffect(() => {
    const efforts = effortsFor(forwardCatalog, forwardHarness);
    if (!efforts || efforts.some((candidate) => candidate.value === forwardEffort)) return;
    setForwardEffort(efforts.find((candidate) => candidate.value === "medium")?.value
      ?? efforts[0]?.value
      ?? "");
  }, [forwardCatalog, forwardHarness, forwardEffort]);

  const invokeCodex = useCallback(async () => {
    setReviewStatus("running");
    setReviewMessage(null);
    try {
      const result = await api<DispatchReviewResponse>("/api/broker/dispatch-review", {
        method: "POST",
        body: JSON.stringify(brokerDispatchReviewRequest(attempt)),
      });
      setReviewStatus("sent");
      setReviewConversationId(result.conversationId);
      setReviewMessage(result.conversationId
        ? `Report started${result.targetLabel ? ` with ${result.targetLabel}` : ""}. Open the conversation to follow it.`
        : `Report started${result.targetLabel ? ` with ${result.targetLabel}` : ""}${result.flightId ? ` · ${result.flightId}` : ""}.`);
    } catch (error) {
      setReviewStatus("failed");
      setReviewMessage(`Couldn't start the report. ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [attempt]);

  // Quiet action rows, ordered by failure kind: a route failure never reached
  // a destination, so the report outranks retrying; a delivery failure did, so
  // retrying outranks the report.
  const reportAction = isFailure ? (
    <div className="sys-broker-action-row">
      <div className="sys-broker-action-line">
        <span className="sys-broker-action-label" id="dispatch-report-title">Failure report</span>
        <button
          type="button"
          className="sys-broker-report-button"
          disabled={reviewStatus === "running" || (reviewStatus === "sent" && !reviewConversationId)}
          onClick={() => {
            if (reviewConversationId) {
              openContent(navigate, { view: "conversation", conversationId: reviewConversationId }, { returnTo: route });
              return;
            }
            void invokeCodex();
          }}
        >
          {reviewStatus === "running" ? <LoaderCircle size={13} className="sys-broker-action-spinner" aria-hidden="true" /> : reviewConversationId ? <ExternalLink size={13} aria-hidden="true" /> : <Bot size={13} aria-hidden="true" />}
          {reviewStatus === "running" ? "Starting report…" : reviewConversationId ? "Open report conversation" : "Start failure report"}
        </button>
      </div>
      {reviewMessage && (
        <div className={`sys-broker-review-status sys-broker-review-status--${reviewStatus}`} role="status">
          {reviewMessage}
        </div>
      )}
    </div>
  ) : null;

  const retryAction = (
    <div className="sys-broker-action-row">
      <div className="sys-broker-action-line">
        <span className="sys-broker-action-label" id="dispatch-redispatch-title">Retry</span>
        <div className="sys-broker-redispatch-controls">
          <select
            aria-label="Retry destination"
            value={redispatchAgentId}
            disabled={redispatchStatus === "sending" || routableAgents.length === 0}
            onChange={(event) => {
              setRedispatchAgentId(event.target.value);
              setRedispatchStatus("idle");
              setRedispatchMessage(null);
            }}
          >
            {routableAgents.length === 0 ? (
              <option value="">No agents available</option>
            ) : (
              <>
                {!redispatchAgentId && <option value="">Original destination unavailable</option>}
                {routableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.id === scoutbotAgentId ? "Scout" : agent.name}
                    {agent.project ? ` · ${agent.project}` : ""}
                  </option>
                ))}
              </>
            )}
          </select>
          <button
            type="button"
            className="sys-broker-redispatch-send"
            disabled={!redispatchAgent || redispatchStatus === "sending"}
            onClick={() => void redispatch()}
          >
            {redispatchStatus === "sending" ? <LoaderCircle size={13} className="sys-broker-action-spinner" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
            {redispatchStatus === "sending" ? "Retrying…" : "Retry dispatch"}
          </button>
        </div>
      </div>
      {redispatchAgent && (
        <div className="sys-broker-action-target-meta">
          {redispatchAgent.harness && <span>{redispatchAgent.harness}</span>}
          {redispatchAgent.model && <span>{redispatchAgent.model}</span>}
          {(redispatchAgent.cwd ?? redispatchAgent.projectRoot) && <code>{redispatchAgent.cwd ?? redispatchAgent.projectRoot}</code>}
        </div>
      )}
      {redispatchMessage && (
        <div className={`sys-broker-action-status sys-broker-action-status--${redispatchStatus}`} role="status">
          {redispatchMessage}
        </div>
      )}
    </div>
  );

  return (
    <aside className="sys-panel sys-broker-inspector" aria-label="Dispatch route inspector">
      <header className="sys-broker-inspector-head">
        <div className="sys-broker-inspector-status">
          <span className={`sys-broker-dot sys-broker-dot--${tone}`} aria-hidden="true" />
          <strong className={`sys-broker-state sys-broker-state--${tone}`}>{dispatchStateLabel(attempt)}</strong>
          <code title={reference}>{reference}</code>
          <CopyIconButton
            value={contextText}
            subject="dispatch context"
            className="sys-broker-inspector-copy"
          />
          <button
            type="button"
            className="sys-copy-btn sys-broker-inspector-close"
            onClick={onClose}
            title="Close inspector"
            aria-label="Close inspector"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="sys-broker-inspector-body">
        <section className="sys-broker-route-stack" aria-label="Dispatch route">
          <div className="sys-broker-route-party">
            <span className="sys-broker-avatar sys-broker-route-avatar" aria-hidden="true">
              {dispatchActorInitials(attempt.actorName)}
            </span>
            <div className="sys-broker-route-party-copy">
              <span className="sys-detail-label">From · {dispatchPartyKind(attempt, "from")}</span>
              <strong>{attempt.actorName ?? "Unknown sender"}</strong>
            </div>
          </div>

          <ArrowDown className="sys-broker-route-down" size={17} aria-hidden="true" />

          <div className="sys-broker-route-party">
            <span className="sys-broker-route-target-icon" aria-hidden="true">
              <RouteGlyph route={attempt.route} />
            </span>
            <div className="sys-broker-route-party-copy">
              <span className="sys-detail-label">To · {dispatchPartyKind(attempt, "to")}</span>
              <code title={attempt.target ?? "No target"}>{attempt.target ?? "No target"}</code>
            </div>
            {attempt.conversationId && (
              <button
                type="button"
                className="sys-broker-route-button"
                onClick={() => openContent(navigate, { view: "conversation", conversationId: attempt.conversationId! }, { returnTo: route })}
              >
                <ExternalLink size={11} aria-hidden="true" />
                Route
              </button>
            )}
          </div>
        </section>

        <dl className="sys-broker-delivery-grid">
          <div>
            <dt>Channel</dt>
            <dd>{dispatchChannelLabel(attempt.route)}</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd className="sys-broker-delivery-accent">{dispatchLatencyLabel(attempt)}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd>{dispatchClockWithSeconds(sentAt)}</dd>
          </div>
          <div>
            <dt>{isFailure ? "Failed" : "Delivered"}</dt>
            <dd>{dispatchClockWithSeconds(deliveredAt)}</dd>
          </div>
        </dl>

        <section className="sys-broker-payload">
          {isRouteFailure
            ? <DispatchRouteFailure attempt={attempt} />
            : <DispatchPayloadViewer payload={attempt.detail} />}
          {isFailure && !isRouteFailure && errorSummary && (
            <div className="sys-broker-inspector-error" role="status">
              <span className="sys-broker-inspector-error-label">Error</span>
              <p>{errorSummary}</p>
            </div>
          )}
        </section>

        {/* The payload is only the ask. Routing succeeded is not an outcome, so
            the aftermath sits directly under it rather than behind an action. */}
        <DispatchAftermath
          attempt={attempt}
          targetAgentId={originalTargetAgentId || null}
          navigate={navigate}
          returnTo={route}
        />

        <section className="sys-broker-actions" aria-label="Dispatch actions">
          {isRouteFailure
            ? <>{reportAction}{retryAction}</>
            : <>{retryAction}{reportAction}</>}
        </section>

        <details className="sys-broker-technical">
          <summary>
            <span>Technical details</span>
            <ChevronDown size={13} aria-hidden="true" />
          </summary>
          <div className="sys-broker-inspector-rows">
            {rows.map((row) => (
              <div key={row.label} className="sys-broker-inspector-row">
                <span className="sys-detail-label">{row.label}</span>
                <code className="sys-detail-value">{row.value}</code>
                <CopyIconButton value={row.value} subject={row.label.toLowerCase()} />
              </div>
            ))}
          </div>
          <div className="sys-broker-metadata">
            <div className="sys-broker-metadata-head">
              <span className="sys-detail-label">Metadata</span>
              <CopyIconButton value={metadata} subject="metadata" className="sys-broker-metadata-copy" />
            </div>
            <BrokerMetadataPanel metadata={attempt.metadata} rawJson={metadata} />
          </div>
        </details>
      </div>

      <section className="sys-broker-forward" aria-labelledby="dispatch-forward-title">
        <div className="sys-broker-forward-head">
          <span id="dispatch-forward-title" className="sys-broker-action-label">Follow up</span>
        </div>
        <div id="dispatch-forward-content">
            <div className="sys-broker-forward-intro">
              <div className="sys-broker-ask-prompts" aria-label="Suggested requests">
                {scoutPrompts.map((prompt) => (
                  <button key={prompt} type="button" onClick={() => prepareScoutMessage(prompt)}>
                    <Sparkles size={11} aria-hidden="true" />
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
            <form
              className="sys-broker-message-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void forwardDispatch();
              }}
            >
          <label htmlFor="dispatch-message-input">Request</label>
          <textarea
            ref={messageInputRef}
            id="dispatch-message-input"
            value={messageDraft}
            rows={3}
            placeholder={`What should ${forwardAgent?.id === scoutbotAgentId ? "Scout" : forwardAgent?.name ?? "this agent"} investigate or do?`}
            disabled={forwardStatus === "sending"}
            onChange={(event) => {
              setMessageDraft(event.target.value);
              if (forwardStatus !== "idle") {
                setForwardStatus("idle");
                setForwardMessage(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void forwardDispatch();
              }
            }}
          />
          {forwardFiles.length > 0 && (
            <div className="sys-broker-composer-attachments" aria-label="Attachments">
              {forwardFiles.map((file, index) => (
                <span key={`${file.name}:${file.size}:${index}`}>
                  <Paperclip size={10} aria-hidden="true" />
                  <span title={file.name}>{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setForwardFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    aria-label={`Remove ${file.name}`}
                  >
                    <X size={10} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <footer>
            <div className="sys-broker-composer-left">
              <input
                ref={forwardFileInputRef}
                type="file"
                multiple
                hidden
                disabled={forwardStatus === "sending"}
                onChange={(event) => {
                  addForwardFiles([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="sys-broker-composer-attach"
                disabled={forwardStatus === "sending"}
                onClick={() => forwardFileInputRef.current?.click()}
                aria-label="Attach files"
                title="Attach files"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
              <span className="sys-broker-message-attachment" title={reference}>Dispatch context included</span>
            </div>

            <div className="sys-broker-composer-targets">
              <span className="sys-broker-composer-route-label">Send to</span>
              <label title="Project target">
                <span>Project</span>
                <select
                  aria-label="Project target"
                  value={forwardProjectPath}
                  disabled={forwardStatus === "sending"}
                  onChange={(event) => {
                    const projectPath = event.target.value;
                    const nextAgent = routableAgents.find((agent) => (
                      !projectPath || (agent.projectRoot?.trim() || agent.cwd?.trim()) === projectPath
                    )) ?? null;
                    routingTouchedRef.current = true;
                    setForwardProjectPath(projectPath);
                    if (nextAgent) {
                      setForwardAgentId(nextAgent.id);
                      setForwardHarness(nextAgent.harness?.trim() || "");
                      setForwardModel(nextAgent.model?.trim() || "");
                    }
                  }}
                >
                  <option value="">Any project</option>
                  {projectOptions.map((project) => (
                    <option key={project.path} value={project.path}>{project.label}</option>
                  ))}
                </select>
              </label>
              <label title="Agent target">
                <span>Agent</span>
                <select
                  aria-label="Agent target"
                  value={forwardAgentId}
                  disabled={forwardStatus === "sending" || forwardProjectAgents.length === 0}
                  onChange={(event) => {
                    const nextAgent = routableAgents.find((agent) => agent.id === event.target.value) ?? null;
                    routingTouchedRef.current = true;
                    setForwardAgentId(event.target.value);
                    if (nextAgent) {
                      setForwardProjectPath(nextAgent.projectRoot?.trim() || nextAgent.cwd?.trim() || "");
                      setForwardHarness(nextAgent.harness?.trim() || "");
                      setForwardModel(nextAgent.model?.trim() || "");
                    }
                    setForwardStatus("idle");
                    setForwardMessage(null);
                  }}
                >
                  {forwardProjectAgents.length === 0 ? (
                    <option value="">No agents</option>
                  ) : forwardProjectAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.id === scoutbotAgentId ? "Scout" : agent.name}</option>
                  ))}
                </select>
              </label>
              <RuntimePicker
                catalog={forwardCatalog}
                value={{ harness: forwardHarness, model: forwardModel, effort: forwardEffort }}
                onChange={(next: RuntimeValue) => {
                  routingTouchedRef.current = true;
                  setForwardHarness(next.harness);
                  setForwardModel(next.model);
                  setForwardEffort(next.effort);
                }}
                disabled={forwardStatus === "sending"}
              />
              <DictationMic
                className="sys-broker-composer-mic"
                disabled={forwardStatus === "sending"}
                onAppend={(text) => setMessageDraft((current) => current.trim() ? `${current.trimEnd()} ${text}` : text)}
                onError={(message) => {
                  setForwardStatus("failed");
                  setForwardMessage(message);
                }}
              />
            </div>
            <button
              type="submit"
              className="sys-broker-composer-send"
              disabled={!messageDraft.trim() || !forwardAgent || forwardStatus === "sending"}
              aria-label={`Ask ${forwardAgent?.name ?? "recipient"} about this dispatch`}
            >
              {forwardStatus === "sending" ? <LoaderCircle size={14} className="sys-broker-action-spinner" aria-hidden="true" /> : <SendHorizontal size={14} aria-hidden="true" />}
            </button>
          </footer>
            </form>
            {forwardMessage && (
              <div className={`sys-broker-action-status sys-broker-action-status--${forwardStatus}`} role="status">
                {forwardMessage}
              </div>
            )}
          </div>
      </section>
    </aside>
  );
}

export const scoutSurface = defineSurface({
  id: "dispatch",
  label: "Dispatch",
  route: { view: "broker" },
  webPath: "/dispatch",
  screen: "BrokerScreen",
  embed: {
    path: "/embed/dispatch",
    profile: "macos.dispatch",
    rootClassName: "s-broker-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    // Filter tabs and row selection are `view: "broker"` routes; the host has
    // nowhere else to put them, so the embed keeps them.
    ownsInternalRoutes: true,
    resolveEmbedProps: (params) => {
      const attempt = params.get("attempt")?.trim();
      return attempt ? { initialAttemptId: attempt } : {};
    },
    hosts: { macos: true },
  },
});
