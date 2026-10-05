import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { ScoutMark } from "../../components/ScoutMark.tsx";
import { api } from "../../lib/api.ts";
import {
  DEFAULT_RESTING_OPACITY,
  RESTING_OPACITY_MIN,
  beginCompanionDrag,
  disallowCompanionScope,
  hideCompanion,
  openFromCompanion,
  pinToCompanion,
  reorderCompanion,
  reportCompanionLayout,
  setCompanionEngaged,
  setCompanionMinimized,
  setCompanionPreferences,
  unpinFromCompanion,
  type CompanionHostState,
  type CompanionMode,
  type CompanionPin,
  type CompanionPreferences,
  type CompanionScope,
} from "../../lib/companion-host.ts";
import { filterWorkDetailByMachineScope, machineScopedAgentIds } from "../../lib/machine-scope.ts";
import { isBrokerEventStreamLive, onBrokerEventStreamLiveChange, useBrokerEvents } from "../../lib/sse.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import type { Agent, MeshStatus, Route, TailEvent, WorkDetail, WorkItem } from "../../lib/types.ts";
import { useScout } from "../../scout/Provider.tsx";
import { defineSurface } from "../../surfaces/types.ts";
import {
  detailIdsFor,
  followQueryWorkId,
  loadPin,
  loadSummaries,
  mergeSurfaceRows,
  previewPins,
  pruneKeys,
  readExpanded,
  writeExpanded,
  type PinSnapshot,
} from "./companion-data.ts";
import {
  DEFAULT_OPERATOR_IDS,
  MAX_VISIBLE_CARDS,
  SURFACE_ROWS_PER_AGENT,
  ageLabel,
  bringIntoView,
  buildCompanionCard,
  clockLabel,
  groupByState,
  groupLabel,
  isCompanionRelevantEvent,
  operatorActorIds,
  overflowSummary,
  projectInitials,
  selectSurfaced,
  summaryState,
  surfaceAgentIds,
  type CompanionCard,
  type CompanionCardState,
  type SurfacedItem,
} from "./companion-model.ts";
import { CompanionEdge, type EdgeWork } from "./CompanionEdge.tsx";
import { isVisitor } from "./edge-model.ts";
import { useCompanionHostState } from "./useCompanionHostState.ts";
import "./companion.css";
import "./edge.css";

const TAIL_BUFFER_LIMIT = 600;
const REFRESH_DEBOUNCE_MS = 400;

type MeshNames = { localNodeId: string | null; names: Map<string, string> };

/** What a refresh read and failed: pinned reads dim the cards, surfacing reads do not. */
type ReadFailures = { pins: boolean; surfacing: boolean };

const SCOPE_KIND_LABEL: Record<CompanionScope["kind"], string> = { work: "Work", agent: "Agent", project: "Project" };

function scopeName(scope: CompanionScope): string {
  if (scope.label) return scope.label;
  return scope.kind === "project" ? scope.id.replace(/\/+$/, "").split("/").pop() || scope.id : scope.id;
}

function ownerAgent(detail: WorkDetail, agents: Agent[]): Agent | undefined {
  const ids = [detail.primaryInvocation?.targetAgentId, detail.ownerId].filter(Boolean);
  return agents.find((agent) => ids.includes(agent.id));
}

/** Holds the live subscriptions. Mounted only while the panel is on screen. */
function CompanionLiveFeed({
  onRelevantEvent,
  onTail,
}: {
  onRelevantEvent: () => void;
  onTail: (event: TailEvent) => void;
}) {
  useBrokerEvents((event) => {
    if (isCompanionRelevantEvent(event as { kind: string })) onRelevantEvent();
  });
  useTailEvents(onTail);
  return null;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d={open ? "M2 6.5 5 3.5l3 3" : "M2 3.5 5 6.5l3-3"} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TuneGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1.5 3h7M1.5 7h7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="3.6" cy="3" r="1.3" fill="var(--co-card)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="6.6" cy="7" r="1.3" fill="var(--co-card)" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function CompanionScreen({ workIds, mode: previewMode }: { workIds?: string; mode?: string; navigate: (route: Route) => void; embedded?: boolean }) {
  const { agents } = useScout();
  const hostHandle = useCompanionHostState();
  const hosted = hostHandle.available;
  // Browser preview: no Mac host, so the page keeps its own state.
  const [local, setLocal] = useState<CompanionHostState | null>(() =>
    hosted ? null : {
      pins: previewPins(workIds),
      corner: "bottom-right",
      minimized: false,
      visible: true,
      restingOpacity: DEFAULT_RESTING_OPACITY,
      alwaysOn: false,
      scopes: [],
      mode: previewMode === "edge" ? "edge" : "stack",
      originPins: true,
      edgeAnchor: "right",
      edge: null,
    },
  );
  const host = hosted ? hostHandle.state : local;
  const hostError = hostHandle.error;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [mesh, setMesh] = useState<MeshNames>({ localNodeId: null, names: new Map() });
  const [snapshots, setSnapshots] = useState<Map<string, PinSnapshot>>(new Map());
  const [tail, setTail] = useState<TailEvent[]>([]);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [failures, setFailures] = useState<ReadFailures>({ pins: false, surfacing: false });
  const [streamLive, setStreamLive] = useState(isBrokerEventStreamLive());
  const [streamSeenLive, setStreamSeenLive] = useState(isBrokerEventStreamLive());
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded());
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [surfacedOpen, setSurfacedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);
  const [summaries, setSummaries] = useState<Map<string, WorkItem>>(new Map());
  const [surfaceByAgent, setSurfaceByAgent] = useState<Map<string, WorkItem[]>>(new Map());
  const [operatorIds, setOperatorIds] = useState<ReadonlySet<string>>(DEFAULT_OPERATOR_IDS);
  const touchedAt = useRef(new Map<string, number>());
  const followCache = useRef(new Map<string, string | null>());
  const previous = useRef(new Map<string, { reportedAt: number; observedLine: string | null }>());
  // The Surfaced list as last shown: refreshes keep this order.
  const surfacedOrder = useRef<string[]>([]);
  // Read counters: a slow answer never overwrites a newer one.
  const reads = useRef({ pinned: 0, surfacing: 0 });
  const detailReads = useRef(new Map<string, number>());
  // One counter for every detail read, so pruning an id and pinning it
  // again never reissues a ticket an older read still holds.
  const detailTicket = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pins = host?.pins ?? [];
  const visible = host?.visible ?? true;
  const scopes = host?.scopes ?? [];
  const mode: CompanionMode = host?.mode ?? "stack";
  const edge = mode === "edge";
  const pinKey = pins.map((pin) => pin.workId).join(",");
  const detailKey = detailIdsFor(pins.map((pin) => pin.workId), mode, selectedId).join(",");
  // Work grants are read with the hidden pins; agent and project grants read
  // a bounded number of agents' active work. Keys keep the reads stable.
  const workScopeKey = scopes.filter((scope) => scope.kind === "work").map((scope) => scope.id).join(",");
  const surfaceAgentKey = useMemo(() => surfaceAgentIds(scopes, agents).join(","), [scopes, agents]);
  const surfaceRows = useMemo(() => [...surfaceByAgent.values()].flat(), [surfaceByAgent]);

  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  useEffect(() => onBrokerEventStreamLiveChange((live) => {
    setStreamLive(live);
    if (live) setStreamSeenLive(true);
  }), []);

  const markFailed = useCallback((part: keyof ReadFailures, failed: boolean) => {
    setFailures((prev) => (prev[part] === failed ? prev : { ...prev, [part]: failed }));
  }, []);

  // Full detail for some pins. Each id keeps its own read counter; returns
  // whether every read that still counts worked.
  const loadDetails = useCallback(async (ids: readonly string[]): Promise<boolean> => {
    const tickets = ids.map((id) => {
      const ticket = ++detailTicket.current;
      detailReads.current.set(id, ticket);
      return ticket;
    });
    const results = await Promise.allSettled(ids.map((id) => loadPin(id, followCache.current)));
    let ok = true;
    const fresh = new Map<string, PinSnapshot>();
    results.forEach((result, index) => {
      const id = ids[index]!;
      if (detailReads.current.get(id) !== tickets[index]) return;
      if (result.status === "fulfilled") fresh.set(id, result.value);
      else ok = false;
    });
    setSnapshots((prev) => {
      const next = new Map(prev);
      for (const [id, snapshot] of fresh) next.set(id, snapshot);
      // A failed read keeps the last snapshot; the header says it is stale.
      for (const id of ids) if (!next.has(id) && detailReads.current.has(id)) next.set(id, { status: "loading" });
      return next;
    });
    return ok;
  }, []);

  // Pinned work: full detail (timeline, follow, tail) only for the cards on
  // screen, or on the edge for the figure being looked at; list rows for the
  // rest and for work grants.
  const loadPinned = useCallback(async () => {
    const ids = pinKey ? pinKey.split(",") : [];
    const workScopeIds = workScopeKey ? workScopeKey.split(",") : [];
    const ticket = ++reads.current.pinned;
    if (ids.length === 0 && workScopeIds.length === 0) {
      setSnapshots((prev) => (prev.size ? new Map() : prev));
      setSummaries((prev) => (prev.size ? new Map() : prev));
      markFailed("pins", false);
      return;
    }
    const detailIds = detailIdsFor(ids, edge ? "edge" : "stack", selectedRef.current);
    const summaryIds = [...new Set([...ids.filter((id) => !detailIds.includes(id)), ...workScopeIds])];
    const [detailsOk, summaryRows, recentTail] = await Promise.all([
      loadDetails(detailIds),
      summaryIds.length ? loadSummaries(summaryIds).catch(() => null) : Promise.resolve<WorkItem[]>([]),
      detailIds.length
        ? api<{ events: TailEvent[] }>("/api/tail/recent?limit=300&transcripts=true").then((result) => result.events ?? [], () => null)
        : Promise.resolve(null),
    ]);
    if (recentTail) {
      setTail((prev) => {
        const byId = new Map<string, TailEvent>();
        for (const event of [...recentTail, ...prev]) byId.set(event.id, event);
        return [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-TAIL_BUFFER_LIMIT);
      });
    }
    if (ticket !== reads.current.pinned) return;
    if (summaryRows) setSummaries(new Map(summaryRows.map((row) => [row.id, row])));
    const ok = detailsOk && summaryRows !== null;
    markFailed("pins", !ok);
    if (ok) setLastSync(Date.now());
  }, [pinKey, workScopeKey, edge, loadDetails, markFailed]);

  // Agent and project grants. A failed agent read keeps that agent's last
  // rows and marks the Surfaced list stale; pinned cards are unaffected.
  const loadSurfacing = useCallback(async () => {
    const agentIds = surfaceAgentKey ? surfaceAgentKey.split(",") : [];
    const ticket = ++reads.current.surfacing;
    const results = await Promise.allSettled(agentIds.map((agentId) =>
      api<WorkItem[]>(`/api/work?agentId=${encodeURIComponent(agentId)}&limit=${SURFACE_ROWS_PER_AGENT}`)));
    if (ticket !== reads.current.surfacing) return;
    setSurfaceByAgent((prev) => mergeSurfaceRows(prev, results.map((result, index) => ({
      agentId: agentIds[index]!,
      rows: result.status === "fulfilled" ? result.value : null,
    }))));
    markFailed("surfacing", results.some((result) => result.status === "rejected"));
  }, [surfaceAgentKey, markFailed]);

  // The debounced refresh calls whatever loaders are current when it fires: a
  // timer set before the pins changed must not run a read of the old pins,
  // which would take a newer ticket than the fresh read and win.
  const loaders = useRef({ loadPinned, loadSurfacing });
  loaders.current = { loadPinned, loadSurfacing };
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void loaders.current.loadPinned();
      void loaders.current.loadSurfacing();
    }, REFRESH_DEBOUNCE_MS);
  }, []);

  // Waits for the host's state, so the first read is of the real pins: the
  // edge only treats work that appears after it as newly arrived.
  const hostKnown = host !== null;
  useEffect(() => {
    if (!visible || !hostKnown) return;
    let cancelled = false;
    void loadPinned().finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [loadPinned, visible, hostKnown]);

  useEffect(() => {
    if (!visible || !hostKnown) return;
    void loadSurfacing();
  }, [loadSurfacing, visible, hostKnown]);

  // On the edge, looking at a figure past the first few reads only its detail.
  useEffect(() => {
    if (!edge || !visible || !selectedId) return;
    const ids = pinKey ? pinKey.split(",") : [];
    if (!ids.includes(selectedId) || ids.indexOf(selectedId) < MAX_VISIBLE_CARDS) return;
    void loadDetails([selectedId]).then((ok) => { if (!ok) markFailed("pins", true); });
  }, [edge, visible, selectedId, pinKey, loadDetails, markFailed]);

  // Forget what belongs to work that is no longer pinned, so a long-running
  // panel stays bounded by its pins.
  useEffect(() => {
    if (!hostKnown) return;
    const keep = new Set(pinKey ? pinKey.split(",") : []);
    pruneKeys(touchedAt.current, keep);
    pruneKeys(previous.current, keep);
    pruneKeys(detailReads.current, keep);
    for (const query of [...followCache.current.keys()]) {
      const workId = followQueryWorkId(query);
      if (!workId || !keep.has(workId)) followCache.current.delete(query);
    }
    setSnapshots((prev) => {
      const next = new Map(prev);
      return pruneKeys(next, keep) ? next : prev;
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!pruneKeys(next, keep)) return prev;
      writeExpanded(next);
      return next;
    });
  }, [hostKnown, pinKey]);

  // Who the operator is, as the server counts it: asks addressed to the
  // configured name or handle are questions too, not only "operator".
  useEffect(() => {
    let cancelled = false;
    api<{ name?: string | null; handle?: string | null }>("/api/user")
      .then((user) => { if (!cancelled) setOperatorIds(operatorActorIds(user)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // One mesh read, on the edge only: the local node id is what makes a
  // visitor a visitor. Unknown means nobody is drawn as one.
  useEffect(() => {
    if (!edge || !visible) return;
    let cancelled = false;
    api<MeshStatus>("/api/mesh")
      .then((status) => {
        if (cancelled) return;
        const names = new Map<string, string>();
        for (const node of Object.values(status.nodes ?? {})) if (node?.id) names.set(node.id, node.name || node.id);
        setMesh({ localNodeId: status.localNode?.id ?? null, names });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [edge, visible]);

  // The edge is a full-width transparent band: nothing may scroll it.
  useEffect(() => {
    document.documentElement.classList.toggle("ce-edge-mode", edge);
    return () => document.documentElement.classList.remove("ce-edge-mode");
  }, [edge]);

  // Hiding (and unmounting) drops a pending refresh; nothing reads while hidden.
  useEffect(() => {
    if (visible) return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
  }, [visible]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  // Ages tick while visible; nothing runs while hidden.
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [visible]);

  const onTail = useCallback((event: TailEvent) => {
    setTail((prev) => (prev.length >= TAIL_BUFFER_LIMIT ? [...prev.slice(1), event] : [...prev, event]));
  }, []);

  // Disconnected: the last read of pinned work failed, or a stream that was
  // live dropped. A failed surfacing read only marks the Surfaced list stale.
  const offline = failures.pins || (streamSeenLive && !streamLive);
  const refTime = offline && lastSync ? lastSync : now;

  const scopedAgentIds = useCallback(
    (machineId: string | null | undefined) => machineScopedAgentIds(agents, machineId ?? null),
    [agents],
  );

  const visiblePins = pins.slice(0, MAX_VISIBLE_CARDS);
  const hiddenPins = pins.slice(MAX_VISIBLE_CARDS);
  const detailPins = useMemo(() => {
    const ids = new Set(detailKey ? detailKey.split(",") : []);
    return pins.filter((pin) => ids.has(pin.workId));
  }, [pins, detailKey]);

  const cards = useMemo(() => {
    const out = new Map<string, { card: CompanionCard | null; reason?: string }>();
    for (const pin of detailPins) {
      const snapshot = snapshots.get(pin.workId);
      if (!snapshot || snapshot.status === "loading") {
        out.set(pin.workId, { card: null, reason: "loading" });
        continue;
      }
      if (snapshot.status === "missing") {
        out.set(pin.workId, { card: null, reason: snapshot.reason });
        continue;
      }
      const scoped = filterWorkDetailByMachineScope(snapshot.detail, scopedAgentIds(pin.machineId));
      if (!scoped) {
        out.set(pin.workId, { card: null, reason: "Outside this machine scope." });
        continue;
      }
      const agent = ownerAgent(snapshot.detail, agents);
      const session = snapshot.harnessSessionId;
      const matched = session ? tail.filter((event) => event.sessionId === session) : [];
      out.set(pin.workId, {
        card: buildCompanionCard(scoped, {
          now: refTime,
          live: !offline,
          tail: matched,
          history: snapshot.history,
          tailMatched: Boolean(session),
          project: agent?.project ?? null,
          harness: agent?.harness ?? null,
          operatorIds,
        }),
      });
    }
    return out;
  }, [agents, offline, detailPins, operatorIds, refTime, scopedAgentIds, snapshots, tail]);

  // Detailed cards from full detail; every other pin from its list row.
  const states = useMemo(() => {
    const map = new Map<string, CompanionCardState>();
    for (const pin of pins) {
      const row = summaries.get(pin.workId);
      if (row) map.set(pin.workId, summaryState(row, refTime, operatorIds));
    }
    for (const [id, entry] of cards) if (entry.card) map.set(id, entry.card.state);
    return map;
  }, [cards, operatorIds, pins, summaries, refTime]);

  const surfaced: SurfacedItem[] = useMemo(() => {
    const workScoped = scopes.filter((scope) => scope.kind === "work")
      .map((scope) => summaries.get(scope.id))
      .filter((row): row is WorkItem => Boolean(row));
    return selectSurfaced([...workScoped, ...surfaceRows], {
      scopes,
      agents,
      pinnedIds: new Set(pins.map((pin) => pin.workId)),
      now: refTime,
      operatorIds,
      previousOrder: surfacedOrder.current,
    });
  }, [agents, operatorIds, pins, refTime, scopes, summaries, surfaceRows]);
  useEffect(() => { surfacedOrder.current = surfaced.map((item) => item.workId); }, [surfaced]);

  // One-shot motion cues: a new reported milestone draws the hairline, a new
  // observed line rolls in. Computed against the previous render, then stored.
  const cues = new Map<string, { fresh: boolean; prevObserved: string | null }>();
  for (const [id, entry] of cards) {
    const card = entry.card;
    if (!card) continue;
    const before = previous.current.get(id);
    cues.set(id, {
      fresh: Boolean(before && card.reportedAt > before.reportedAt),
      prevObserved: before && before.observedLine !== card.observedLine ? before.observedLine : null,
    });
  }
  useEffect(() => {
    for (const [id, entry] of cards) {
      if (entry.card) previous.current.set(id, { reportedAt: entry.card.reportedAt, observedLine: entry.card.observedLine });
    }
  });

  // Size the native panel to the content, not the other way round.
  useEffect(() => {
    // The edge band is sized by the host from the screen, not the content.
    if (!hosted || edge) return;
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const report = () => reportCompanionLayout(el.offsetWidth, el.offsetHeight);
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, [hosted, edge, hostKnown]);

  const touch = (id: string) => touchedAt.current.set(id, Date.now());

  const toggleExpanded = (id: string) => {
    touch(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeExpanded(next);
      return next;
    });
  };

  const { apply, fail, clearError } = hostHandle;

  // Browser preview: changes stay in the page.
  const applyLocal = (patch: Partial<CompanionHostState> | ((prev: CompanionHostState) => Partial<CompanionHostState>)) =>
    setLocal((prev) => prev && { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) });

  // A menu or sheet open over the panel keeps it opaque.
  const menuOpen = settingsOpen || overflowOpen || surfacedOpen;
  useEffect(() => {
    if (!hosted || edge) return;
    setCompanionEngaged(menuOpen);
  }, [hosted, edge, menuOpen]);

  // Esc closes whatever the stack has open. The edge handles its own.
  useEffect(() => {
    if (edge || !menuOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSettingsOpen(false);
      setOverflowOpen(false);
      setSurfacedOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edge, menuOpen]);

  const setPreferences = (prefs: CompanionPreferences) => {
    if (!hosted) {
      const { preview: _preview, ...changes } = prefs;
      applyLocal(Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<CompanionHostState>);
      return;
    }
    setCompanionPreferences(prefs).then(apply).catch(fail);
  };

  const revoke = (scope: CompanionScope) => {
    if (!hosted) {
      applyLocal((prev) => ({ scopes: prev.scopes.filter((s) => !(s.kind === scope.kind && s.id === scope.id)) }));
      return;
    }
    disallowCompanionScope(scope.kind, scope.id).then(apply).catch(fail);
  };

  const pinSurfaced = (item: SurfacedItem) => {
    if (!hosted) return;
    pinToCompanion(item.workId).then(apply).catch(fail);
  };

  const openSurfaced = (target: "work" | "thread", item: SurfacedItem) => {
    if (!hosted) {
      window.open(`/work/${encodeURIComponent(item.workId)}`, "_blank", "noopener");
      return;
    }
    openFromCompanion(target, { workId: item.workId, conversationId: target === "thread" ? item.conversationId : null }).then(clearError, fail);
  };

  const unpin = (id: string) => {
    if (!hosted) {
      applyLocal((prev) => ({ pins: prev.pins.filter((pin) => pin.workId !== id) }));
      return;
    }
    unpinFromCompanion(id).then(apply).catch(fail);
  };

  const open = (target: "work" | "thread", card: CompanionCard, pin: CompanionPin) => {
    touch(card.workId);
    if (!hosted) {
      window.open(`/work/${encodeURIComponent(card.workId)}`, "_blank", "noopener");
      return;
    }
    openFromCompanion(target, {
      workId: card.workId,
      machineId: pin.machineId,
      conversationId: target === "thread" ? card.conversationId : null,
    }).then(clearError, fail);
  };

  const bringIn = (id: string) => {
    const order = bringIntoView(pins.map((pin) => pin.workId), id, states, touchedAt.current);
    touch(id);
    setOverflowOpen(false);
    if (!hosted) {
      applyLocal((prev) => ({ pins: order.map((workId) => prev.pins.find((pin) => pin.workId === workId)!) }));
      return;
    }
    reorderCompanion(order).then(apply).catch(fail);
  };

  const setMinimized = (minimized: boolean) => {
    if (!hosted) {
      applyLocal({ minimized });
      return;
    }
    setCompanionMinimized(minimized).then(apply).catch(fail);
  };

  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleExpanded(id);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const all = [...(rootRef.current?.querySelectorAll<HTMLElement>(".co-card[data-id]") ?? [])];
      const index = all.indexOf(event.currentTarget);
      all[Math.max(0, Math.min(all.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }
  };

  const corner = host?.corner ?? "bottom-right";
  const pinnedAsks = pins.filter((pin) => {
    const state = states.get(pin.workId);
    return state === "question" || state === "blocked";
  }).length;
  const surfacedAsks = surfaced.filter((item) => item.needsOperator).length;
  const asksYou = pinnedAsks + surfacedAsks;
  const syncText = offline
    ? `offline · synced ${lastSync ? clockLabel(lastSync) : "never"}`
    : !hosted
      ? "browser preview"
      : pins.length
        ? `${pins.length} pinned`
        : "";
  const markLabel = [
    "Scout companion",
    pins.length ? `${pins.length} pinned` : "nothing pinned",
    asksYou ? `${asksYou} ${asksYou === 1 ? "needs" : "need"} you` : "",
  ].filter(Boolean).join(" · ");
  const opacityPercent = Math.round((opacityDraft ?? host?.restingOpacity ?? DEFAULT_RESTING_OPACITY) * 100);

  if (!host) {
    return (
      <div className="co-root" ref={rootRef} data-corner={corner}>
        <div className="co-head"><span className="co-grip"><ScoutMark className="co-mark" />Scout</span>
          <span className={`co-sync${hostError ? " off" : ""}`}>{hostError ? "companion unavailable" : ""}</span>
          {hostError && <button type="button" className="co-chip" onClick={hostHandle.retry}>Retry</button>}</div>
        {hostError && <p className="co-error" role="status">{hostError}</p>}
      </div>
    );
  }

  const renderSettings = () => (
    <section className="co-sheet" aria-label="Companion settings">
      <div className="co-field">
        <span className="co-sheet-h">Layout</span>
        <div className="co-seg" role="radiogroup" aria-label="Layout">
          {(["stack", "edge"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className="co-seg-btn"
              onClick={() => { if (mode !== value) { setSettingsOpen(false); setPreferences({ mode: value }); } }}
            >
              {value === "stack" ? "Stack" : "Edge characters"}
            </button>
          ))}
        </div>
        <p className="co-hint">
          {edge
            ? "Characters stand along the bottom of the screen. Clicks pass through everywhere else. The Scout menu can switch back to the stack."
            : "Edge characters puts each pinned item on the bottom edge of the screen as its agent's character."}
        </p>
      </div>
      {edge ? (
        <>
          <div className="co-field">
            <span className="co-sheet-h">Gather toward</span>
            <div className="co-seg" role="radiogroup" aria-label="Gather toward">
              {(["left", "right"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={host.edgeAnchor === value} className="co-seg-btn"
                  onClick={() => setPreferences({ edgeAnchor: value })}>
                  {value === "left" ? "Left end" : "Right end"}
                </button>
              ))}
            </div>
            <p className="co-hint">Scout cannot see other apps&rsquo; windows, so you choose the end that stays clear. Scout&rsquo;s own windows are stepped around.</p>
          </div>
          <label className="co-check">
            <input type="checkbox" checked={host.originPins} onChange={(event) => setPreferences({ originPins: event.currentTarget.checked })} />
            <span>
              Origin pins
              <small>A tab above work launched from the same conversation. It opens that conversation.</small>
            </span>
          </label>
        </>
      ) : (
        <div className="co-field">
          <label htmlFor="co-opacity">Resting opacity</label>
          <span className="co-val">{opacityPercent}%</span>
          <input
            id="co-opacity"
            type="range"
            min={Math.round(RESTING_OPACITY_MIN * 100)}
            max={100}
            step={5}
            value={opacityPercent}
            onChange={(event) => setOpacityDraft(Number(event.currentTarget.value) / 100)}
            onPointerUp={(event) => { setPreferences({ restingOpacity: Number(event.currentTarget.value) / 100, preview: true }); setOpacityDraft(null); }}
            onKeyUp={(event) => { setPreferences({ restingOpacity: Number(event.currentTarget.value) / 100, preview: true }); setOpacityDraft(null); }}
          />
          <p className="co-hint">How much of the stack shows while you work elsewhere. It comes up fully under the pointer or keyboard.</p>
        </div>
      )}
      <label className="co-check">
        <input type="checkbox" checked={host.alwaysOn} onChange={(event) => setPreferences({ alwaysOn: event.currentTarget.checked })} />
        <span>
          {edge ? "Keep the home mark on screen" : "Keep the mark on screen"}
          <small>Brings the companion back at launch, even with nothing pinned.</small>
        </span>
      </label>
      <div className="co-field">
        <span className="co-sheet-h">Allowed to surface</span>
        {scopes.length ? (
          <ul className="co-scopes">
            {scopes.map((scope) => (
              <li key={`${scope.kind}:${scope.id}`}>
                <span className="co-scope-kind">{SCOPE_KIND_LABEL[scope.kind]}</span>
                <span className="co-scope-name" title={scope.id}>{scopeName(scope)}</span>
                <button type="button" className="co-chip" onClick={() => revoke(scope)} aria-label={`Stop ${scopeName(scope)} surfacing here`}>Remove</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="co-hint">Nothing else can appear here. Allow a work item, its agent or its project from the work page.</p>
        )}
        <p className="co-hint">
          {edge
            ? "Allowed work stands on the edge as its agent's character. It never opens or focuses the companion."
            : "Allowed work shows in Surfaced with a mark when it asks you. It never opens or focuses the companion."}
        </p>
      </div>
      {edge && hosted && (
        <div className="co-foot">
          <button type="button" className="co-chip" onClick={() => { hideCompanion().then(apply).catch(fail); }}>Hide companion</button>
        </div>
      )}
    </section>
  );

  const renderCard = (pin: CompanionPin) => {
    const entry = cards.get(pin.workId);
    const card = entry?.card ?? null;
    if (!card) {
      const loading = entry?.reason === "loading";
      return (
        <article key={pin.workId} className="co-card" data-id={pin.workId} data-state="unavailable" data-dim={offline} tabIndex={0}>
          <div className="co-c-head">
            <span className="co-picon" aria-hidden="true">{projectInitials(null, pin.workId.replace(/^work-/, ""))}</span>
            <span className="co-c-title"><span className="co-t">{loading ? "Loading…" : "Not available"}</span><span className="co-who">{pin.workId}</span></span>
          </div>
          {!loading && <p className="co-phase"><span className="co-st muted">{entry?.reason}</span></p>}
          {!loading && <div className="co-foot"><button type="button" className="co-chip" onClick={() => unpin(pin.workId)}>Unpin</button></div>}
        </article>
      );
    }
    const isExpanded = expanded.has(card.workId);
    const cue = cues.get(card.workId);
    const actions: (ReactElement | null)[] = [];
    const openWork = <button key="open" type="button" className="co-chip" onClick={() => open("work", card, pin)}>{card.state === "done" ? "Open output" : "Open work"}</button>;
    const openThread = (primary: boolean, label: string) => card.conversationId
      ? <button key="thread" type="button" className={`co-chip${primary ? " primary" : ""}`} onClick={() => open("thread", card, pin)}>{label}</button>
      : null;
    const unpinButton = (label: string) => <button key="unpin" type="button" className="co-chip" onClick={() => unpin(card.workId)}>{label}</button>;
    if (card.state === "question") actions.push(openThread(true, card.status === "Asks you" ? "Answer in thread" : "Open thread"), openWork);
    else if (card.state === "blocked") actions.push(openThread(false, "Open thread"), openWork);
    else if (card.state === "done") actions.push(openWork, unpinButton("Dismiss"));
    else if (card.state === "ended" || card.state === "cancelled") actions.push(openWork, unpinButton("Unpin"));
    else if (isExpanded) actions.push(openWork, openThread(false, "Open thread"), unpinButton("Unpin"));
    const footer = actions.filter(Boolean);

    return (
      <article
        key={card.workId}
        className="co-card"
        data-id={card.workId}
        data-state={card.state}
        data-expanded={isExpanded}
        data-dim={offline}
        tabIndex={0}
        aria-label={`${card.title}: ${card.status || "working"}`}
        onKeyDown={(event) => onCardKeyDown(event, card.workId)}
      >
        <div className="co-c-head">
          <span className="co-picon" title={card.who.split(" · ")[0] || card.title} aria-hidden="true">{card.initials}</span>
          <span className="co-c-title">
            <span className="co-t" title={card.title}>{card.title}</span>
            {card.who && <span className="co-who">{card.who}</span>}
          </span>
          <span className="co-c-actions">
            <span className={`co-age${card.ageLabel === "now" ? " now" : ""}`} title={`Last update ${clockLabel(card.lastActivityAt)}`}>{card.ageLabel}</span>
            <button type="button" className="co-icon-btn" onClick={() => toggleExpanded(card.workId)} aria-label={isExpanded ? "Collapse" : "Expand"} title={isExpanded ? "Collapse" : "Expand"}>
              <Chevron open={isExpanded} />
            </button>
          </span>
        </div>
        <p className={`co-phase${cue?.fresh ? " fresh" : ""}`}>
          {card.status && <span className={`co-st ${card.statusTone}`}>{card.status}</span>}
          {card.status && card.headline ? " · " : ""}
          {card.headline && <span className="co-txt">{card.headline}</span>}
        </p>
        {card.callout && (
          <div className={`co-callout ${card.callout.tone}`}>
            <span className="co-k">{card.callout.label}</span>
            {card.callout.text}
          </div>
        )}
        {!isExpanded && card.sessionTail.length > 0 && (
          <div className="co-tail-preview">
            <div className="co-lane-h"><span>Session activity</span><span>last {Math.min(3, card.sessionTail.length)}</span></div>
            <ul className="co-tail">{card.sessionTail.slice(-3).map((line) => (
              <li key={`${line.at}-${line.text}`}><time dateTime={new Date(line.at).toISOString()} title={new Date(line.at).toLocaleString()}>{clockLabel(line.at)}</time><span title={line.text}>{line.text}</span></li>
            ))}</ul>
          </div>
        )}
        {isExpanded && (
          <div className="co-x-body">
            <div className="co-lane-h"><span>Reported</span><span>by the agent</span></div>
            {card.reported.length
              ? <ul className="co-said">{card.reported.map((line) => <li key={`${line.at}-${line.text}`}><time>{clockLabel(line.at)}</time><span>{line.text}</span></li>)}</ul>
              : <p className="co-note">Nothing reported through work_update yet.</p>}
            <div className="co-lane-h"><span>Observed</span><span>{card.tailMatched ? "flights · session tail" : "flights"} · last {card.observed.length}</span></div>
            {card.observed.length
              ? <ul className="co-tail">{card.observed.map((line) => <li key={`${line.at}-${line.text}`}><time>{clockLabel(line.at)}</time><span>{line.text}</span></li>)}</ul>
              : <p className="co-note">Nothing observed yet.</p>}
            <p className="co-note">
              {card.tailMatched
                ? "Tail is matched to this work's session and limited to recent lines. Open work for the full tail."
                : "No session tail matched this work. Observed lines are flight starts and finishes."}
            </p>
          </div>
        )}
        {footer.length > 0 && <div className="co-foot">{footer}</div>}
      </article>
    );
  };

  if (edge) {
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const visitorFrom = (machineId: string | null | undefined, agent: Agent | undefined): string | null => {
      if (!isVisitor({ localNodeId: mesh.localNodeId, pinMachineId: machineId, agentNodeIds: [agent?.authorityNodeId, agent?.homeNodeId] })) return null;
      const nodeId = machineId || agent?.authorityNodeId || agent?.homeNodeId || null;
      return (nodeId && mesh.names.get(nodeId)) || agent?.authorityNodeName || agent?.homeNodeName || nodeId || "another machine";
    };
    const works: EdgeWork[] = [];
    for (const pin of pins) {
      const card = cards.get(pin.workId)?.card ?? null;
      const snapshot = snapshots.get(pin.workId);
      const row = summaries.get(pin.workId);
      const detail = snapshot?.status === "ready" ? snapshot.detail : null;
      const agent = detail ? ownerAgent(detail, agents) : row?.ownerId ? agentById.get(row.ownerId) : undefined;
      works.push({
        workId: pin.workId,
        title: card?.title ?? row?.title ?? detail?.title ?? pin.workId,
        state: states.get(pin.workId),
        kind: "pinned",
        agent,
        ownerName: row?.ownerName ?? detail?.ownerName ?? null,
        conversationId: card?.conversationId ?? row?.conversationId ?? detail?.conversationId ?? null,
        lastActivityAt: card?.lastActivityAt ?? (row ? Math.max(row.updatedAt, row.lastMeaningfulAt ?? 0) : 0),
        visitorFrom: visitorFrom(pin.machineId, agent),
        origin: null,
      });
    }
    for (const item of surfaced) {
      const agent = item.ownerId ? agentById.get(item.ownerId) : undefined;
      works.push({
        workId: item.workId,
        title: item.title,
        state: item.state,
        kind: "surfaced",
        agent,
        ownerName: item.owner,
        conversationId: item.conversationId,
        lastActivityAt: item.lastActivityAt,
        visitorFrom: visitorFrom(null, agent),
        origin: item.origin,
      });
    }
    const surfacedById = new Map(surfaced.map((item) => [item.workId, item]));
    return (
      <>
        {visible && <CompanionLiveFeed onRelevantEvent={scheduleRefresh} onTail={onTail} />}
        <CompanionEdge
          works={works}
          geometry={host.edge}
          anchor={host.edgeAnchor}
          originPins={host.originPins}
          offline={offline}
          lastSync={lastSync}
          refTime={refTime}
          ready={ready}
          visible={visible}
          hostError={hostError}
          renderCard={(workId) => {
            const pin = pins.find((p) => p.workId === workId);
            return pin ? renderCard(pin) : null;
          }}
          renderSettings={renderSettings}
          onSelect={setSelectedId}
          onOpenSurfaced={(target, work) => {
            const item = surfacedById.get(work.workId);
            if (item) openSurfaced(target, item);
          }}
          onPinSurfaced={(work) => {
            const item = surfacedById.get(work.workId);
            if (item) pinSurfaced(item);
          }}
          onOpenThread={(conversationId, workId) => {
            if (!hosted) {
              window.open(`/work/${encodeURIComponent(workId)}`, "_blank", "noopener");
              return;
            }
            const pin = pins.find((p) => p.workId === workId);
            openFromCompanion("thread", { workId, machineId: pin?.machineId, conversationId }).then(clearError, fail);
          }}
        />
      </>
    );
  }

  return (
    <div className="co-root" ref={rootRef} data-corner={corner} data-minimized={host.minimized}>
      {visible && <CompanionLiveFeed onRelevantEvent={scheduleRefresh} onTail={onTail} />}
      {host.minimized ? (
        // The mark alone. In the Mac app the host owns the gesture: a press
        // that moves drags or throws it, a press that does not is the click
        // that expands. Keyboard activation (detail 0) expands here.
        <button
          type="button"
          className="co-mark-only"
          aria-label={`${markLabel}. Expand`}
          title={markLabel}
          data-asks={asksYou > 0}
          onPointerDown={(event) => { if (hosted && event.button === 0) beginCompanionDrag("mark"); }}
          onClick={(event) => { if (!hosted || event.detail === 0) setMinimized(false); }}
        >
          <ScoutMark className="co-mark" />
          {asksYou > 0 && <span className="co-badge" aria-hidden="true" />}
        </button>
      ) : (
        <>
          <div className="co-head">
            <span
              className="co-grip"
              role={hosted ? "img" : undefined}
              aria-label={hosted ? "Scout companion. Drag to move; it snaps to a corner" : undefined}
              title={hosted ? "Drag to move; snaps to a corner" : undefined}
              onPointerDown={(event) => { if (hosted && event.button === 0) beginCompanionDrag(); }}
            >
              <ScoutMark className="co-mark" />Scout
            </span>
            <span className={`co-sync${offline ? " off" : ""}`}>{syncText}</span>
            <button
              type="button"
              className="co-icon-btn"
              aria-expanded={settingsOpen}
              aria-label="Companion settings"
              title="Opacity, mark and surfacing"
              data-on={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <TuneGlyph />
            </button>
            <button type="button" className="co-icon-btn" onClick={() => setMinimized(true)} aria-label="Minimize" title="Minimize to the mark">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            </button>
          </div>
          {hostError && <p className="co-error" role="status">{hostError}</p>}
          {settingsOpen && renderSettings()}
          {surfaced.length > 0 && (
            <div className="co-overflow">
              <button type="button" className="co-overflow-tab" aria-expanded={surfacedOpen} onClick={() => setSurfacedOpen((open) => !open)}>
                <span>{surfaced.length} surfaced</span>
                {(surfacedAsks > 0 || failures.surfacing) && (
                  <span className="co-mono">
                    {[surfacedAsks > 0 ? `${surfacedAsks} ${surfacedAsks === 1 ? "asks" : "ask"} you` : "", failures.surfacing ? "not refreshed" : ""].filter(Boolean).join(" · ")}
                  </span>
                )}
              </button>
              {surfacedOpen && (
                <ul className="co-overflow-list co-surfaced">
                  {surfaced.map((item) => (
                    <li key={item.workId} data-asks={item.needsOperator}>
                      <button type="button" className="co-row" onClick={() => openSurfaced("work", item)} title="Open work">
                        <span className="co-dot" data-state={item.state} aria-hidden="true" />
                        <span className="co-ov-title">{item.title}</span>
                        <span className="co-age">{ageLabel(item.lastActivityAt, refTime)}</span>
                        <span className="co-ov-who">{groupLabel(item.state)} · {[item.owner, item.origin].filter(Boolean).join(" · ")}</span>
                      </button>
                      <span className="co-row-actions">
                        {item.needsOperator && item.conversationId && (
                          <button type="button" className="co-chip primary" onClick={() => openSurfaced("thread", item)}>Open thread</button>
                        )}
                        {hosted && <button type="button" className="co-chip" onClick={() => pinSurfaced(item)}>Pin</button>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {hiddenPins.length > 0 && (
            <div className="co-overflow">
              <button type="button" className="co-overflow-tab" aria-expanded={overflowOpen} onClick={() => setOverflowOpen((open) => !open)}>
                <span>+{hiddenPins.length} more pinned</span>
                <span className="co-mono">{overflowSummary(hiddenPins.map((pin) => states.get(pin.workId)))}</span>
              </button>
              {overflowOpen && (
                <div className="co-overflow-list co-grouped">
                  {groupByState(hiddenPins.map((pin) => pin.workId), states).map((group) => (
                    <div key={group.key} className="co-group" role="group" aria-label={groupLabel(group.key)}>
                      <div className="co-group-h"><span>{groupLabel(group.key)}</span><span>{group.ids.length}</span></div>
                      {group.ids.map((workId) => {
                        const row = summaries.get(workId);
                        const last = row ? Math.max(row.updatedAt, row.lastMeaningfulAt ?? 0) : null;
                        return (
                          <button key={workId} type="button" className="co-row" onClick={() => bringIn(workId)} title="Bring into view">
                            <span className="co-dot" data-state={states.get(workId) ?? "unknown"} aria-hidden="true" />
                            <span className="co-ov-title">{row?.title ?? workId}</span>
                            <span className="co-age">{last ? ageLabel(last, refTime) : ""}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="co-cards">
            {visiblePins.length
              ? visiblePins.map(renderCard)
              : <div className="co-card co-empty"><b>Nothing pinned</b>Open a work item in the Scout app and press Pin to companion to keep it here.</div>}
          </div>
        </>
      )}
    </div>
  );
}

export const scoutSurface = defineSurface({
  id: "companion",
  label: "Desktop companion",
  route: { view: "inbox" },
  webPath: "/",
  screen: "CompanionScreen",
  embed: {
    path: "/embed/companion",
    rootClassName: "s-companion-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    resolveEmbedProps: (params) => ({
      workIds: params.get("workIds")?.trim() || undefined,
      // Browser preview only; in the Mac app the host's stored mode wins.
      mode: params.get("mode")?.trim() || undefined,
    }),
    hosts: { macos: true },
  },
});
