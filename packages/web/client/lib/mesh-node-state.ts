/**
 * Per-node state on the Network page.
 *
 * The page renders known machines from `/api/mesh` straight away; this store
 * answers the separate question "what is actually going on over there?" and
 * keeps that answer stable while it does.
 *
 * Two response streams land here — a cheap sweep of every machine and a richer
 * read of the selected one — and they can finish in any order. The rules below
 * exist because the old page had neither: a shared roster fetch could paint a
 * remote agent and the next response could take it away again, which reads to
 * an operator as a machine that briefly had something on it and then went
 * quiet. So:
 *
 * - a response older than the one on screen is dropped, not applied
 * - a poorer reading never erases a richer one; it updates reachability and
 *   marks what is shown stale, and the detail stays up
 * - nothing is ever filled in from local agents, and a failed read never
 *   renders as an empty machine
 */

import { api } from "./api.ts";

export type MeshNodeNetworkStatus = "reachable" | "unreachable" | "unknown";
export type MeshNodeBrokerStatus = "answered" | "unreachable" | "refused" | "unsupported" | "unknown";
export type MeshNodeDetailLevel = "full" | "roster" | "none";

export type MeshNodeStateAgentView = {
  id: string;
  title: string;
  role: string | null;
  projectRoot: string | null;
  state: "offline" | "available" | "working" | null;
  statusLabel: string | null;
  lastSeenAt: number | null;
};

export type MeshNodeWorkloadView = {
  total: number;
  working: number | null;
  available: number | null;
  offline: number | null;
  truncated: boolean;
  unattributed: number;
};

export type MeshNodeStateSessionView = {
  id: string;
  agentId: string;
  harness: string | null;
  transport: string | null;
  state: string;
  sessionId: string | null;
  projectRoot: string | null;
};

export type MeshNodeStateWorkView = {
  id: string;
  targetAgentId: string;
  state: string;
  summary: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

/**
 * `null` means the section was never reported — not reached, not reachable,
 * not supported. A section with `items: []` means the machine answered and
 * there is genuinely nothing there. The panel must not render them alike.
 */
export type MeshNodeStateSectionView<T> = {
  total: number;
  running?: number;
  truncated: boolean;
  items: T[];
} | null;

export type MeshNodeStateView = {
  machineId: string;
  kind: "local" | "peer" | "tailnet";
  label: string;
  network: MeshNodeNetworkStatus;
  broker: MeshNodeBrokerStatus;
  detail: MeshNodeDetailLevel;
  source: "local" | "node-state" | "snapshot" | null;
  checkedAt: number | null;
  observedAt: number | null;
  stale: boolean;
  checking: boolean;
  error: string | null;
  node: {
    id: string;
    name: string | null;
    hostName: string | null;
    meshId: string | null;
    brokerUrl: string | null;
    capabilities: readonly string[];
    lastSeenAt: number | null;
  } | null;
  workload: MeshNodeWorkloadView | null;
  roster: MeshNodeStateAgentView[];
  sessions: MeshNodeStateSectionView<MeshNodeStateSessionView>;
  work: MeshNodeStateSectionView<MeshNodeStateWorkView>;
  failures: number;
  nextAttemptAt: number | null;
};

export type MeshNodeStateList = { updatedAt: number; nodes: MeshNodeStateView[] };

export type MeshNodeStateEntry = {
  /**
   * `null` only before anything has been read — a machine selected before the
   * first sweep landed. It is never nulled again afterwards, because losing a
   * reading is not the same as a machine having nothing on it.
   */
  view: MeshNodeStateView | null;
  /** A request this viewer issued for this machine is outstanding. */
  loading: boolean;
  /** The last transport-level failure; broker-level ones live on the view. */
  error: string | null;
};

/* ── Merge rules (pure, and the part worth testing) ── */

/**
 * How much a reading actually tells us about a machine. Used to decide what a
 * later response is allowed to replace — never to decide what to show.
 */
export function nodeStateRank(view: MeshNodeStateView): number {
  if (!view.source) return 0;
  if (view.detail === "full") return 3;
  if (view.detail === "roster") return 2;
  return 1;
}

/** Sections a reading actually reported, for copy that distinguishes them. */
export function reportedSections(view: MeshNodeStateView | null): {
  roster: boolean;
  sessions: boolean;
  work: boolean;
} {
  return {
    roster: Boolean(view?.workload),
    sessions: Boolean(view?.sessions),
    work: Boolean(view?.work),
  };
}

/** A response that describes an older moment than what is on screen. */
export function isOlderReading(previous: MeshNodeStateView, incoming: MeshNodeStateView): boolean {
  if (incoming.checkedAt === null || previous.checkedAt === null) return false;
  return incoming.checkedAt < previous.checkedAt;
}

/**
 * Fold one response into what is displayed.
 *
 * A richer or equally rich reading replaces the old one outright. A poorer one
 * — the sweep passing over a machine whose detail came from a selection, or a
 * failed check — keeps the detail visible and marks it stale, while still
 * adopting the new reachability verdict, because "we can no longer reach this"
 * is itself current and worth showing.
 */
export function mergeNodeStateView(
  previous: MeshNodeStateView | null,
  incoming: MeshNodeStateView,
): MeshNodeStateView {
  if (!previous) return incoming;
  if (isOlderReading(previous, incoming)) return previous;
  if (nodeStateRank(incoming) >= nodeStateRank(previous)) return incoming;
  return {
    ...previous,
    // Inventory and reachability are always the newest thing we know.
    label: incoming.label,
    kind: incoming.kind,
    node: incoming.node ?? previous.node,
    network: incoming.network,
    broker: incoming.broker,
    checkedAt: incoming.checkedAt,
    checking: incoming.checking,
    error: incoming.error,
    failures: incoming.failures,
    nextAttemptAt: incoming.nextAttemptAt,
    // What is on screen came from an earlier, better read. Keep it, say so.
    stale: true,
  };
}

/* ── Store ── */

type StoreState = {
  entries: Readonly<Record<string, MeshNodeStateEntry>>;
  updatedAt: number | null;
  /** Sweep-level failure, e.g. the web server itself is unreachable. */
  error: string | null;
  loading: boolean;
};

export type MeshNodeStateTransport = {
  list: () => Promise<MeshNodeStateList>;
  read: (machineId: string, options: { deep: boolean; force: boolean }) => Promise<MeshNodeStateView>;
  refresh: (machineId: string) => Promise<MeshNodeStateView>;
};

export const defaultMeshNodeStateTransport: MeshNodeStateTransport = {
  list: () => api<MeshNodeStateList>("/api/mesh/nodes/state"),
  read: (machineId, options) => api<MeshNodeStateView>(
    `/api/mesh/nodes/${encodeURIComponent(machineId)}/state`
    + `?${options.deep ? "deep=1&" : ""}${options.force ? "force=1" : ""}`,
  ),
  refresh: (machineId) => api<MeshNodeStateView>(
    `/api/mesh/nodes/${encodeURIComponent(machineId)}/refresh`,
    { method: "POST", body: "{}" },
  ),
};

export function createMeshNodeStateStore(
  transport: MeshNodeStateTransport = defaultMeshNodeStateTransport,
) {
  let state: StoreState = { entries: {}, updatedAt: null, error: null, loading: false };
  const listeners = new Set<() => void>();

  // One counter gives every request an issue order, but the two streams settle
  // against separate guards. They are not comparable: a sweep issued while a
  // selection is in flight is newer *as a request* and older *as knowledge*,
  // so letting one ticket line arbitrate both is what throws the richer answer
  // away. Sweeps are ordered against sweeps; a machine's reads against that
  // machine's reads; and what survives between the two streams is decided by
  // mergeNodeStateView, on how much each reading actually says.
  let ticket = 0;
  let sweepApplied = 0;
  /** Newest read issued per machine — also what "still loading" means. */
  const readIssued = new Map<string, number>();
  const readApplied = new Map<string, number>();
  const readPending = new Set<string>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function putEntry(machineId: string, entry: MeshNodeStateEntry): void {
    state = { ...state, entries: { ...state.entries, [machineId]: entry } };
  }

  function merge(machineId: string, view: MeshNodeStateView): MeshNodeStateView {
    return mergeNodeStateView(state.entries[machineId]?.view ?? null, view);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    snapshot(): StoreState {
      return state;
    },

    /** Sweep every machine. Cheap, shallow, and never deepens a selection. */
    async sweep(): Promise<void> {
      ticket += 1;
      const at = ticket;
      if (state.updatedAt === null && !state.loading) {
        state = { ...state, loading: true };
        notify();
      }

      let payload: MeshNodeStateList;
      try {
        payload = await transport.list();
      } catch (error) {
        state = {
          ...state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        };
        notify();
        return;
      }

      // An out-of-order sweep describes an inventory we have already moved past.
      if (at < sweepApplied) return;
      sweepApplied = at;

      const live = new Set(payload.nodes.map((view) => view.machineId));
      const entries: Record<string, MeshNodeStateEntry> = {};
      for (const [machineId, entry] of Object.entries(state.entries)) {
        // Machines the mesh no longer publishes stop being shown; keeping a last
        // reading for one would be inventing a machine. A machine selected after
        // this sweep went out is exempt: this inventory simply predates it.
        const selectedSinceSweep = (readIssued.get(machineId) ?? 0) > at;
        if (live.has(machineId) || selectedSinceSweep) entries[machineId] = entry;
        else {
          readIssued.delete(machineId);
          readApplied.delete(machineId);
          readPending.delete(machineId);
        }
      }
      state = { ...state, entries, updatedAt: payload.updatedAt, error: null, loading: false };

      for (const view of payload.nodes) {
        const current = state.entries[view.machineId] ?? null;
        putEntry(view.machineId, {
          view: merge(view.machineId, view),
          // A sweep owns no machine's spinner and clears no machine's error.
          loading: current?.loading ?? readPending.has(view.machineId),
          error: current?.error ?? null,
        });
      }
      notify();
    },

    /** Load what a machine is actually running. Used on selection. */
    async load(machineId: string, options: { deep?: boolean; force?: boolean } = {}): Promise<void> {
      ticket += 1;
      const at = ticket;
      readIssued.set(machineId, at);
      readPending.add(machineId);
      putEntry(machineId, {
        // A machine selected before the first sweep has no reading yet; say
        // that plainly rather than rendering an empty machine.
        view: state.entries[machineId]?.view ?? null,
        loading: true,
        error: null,
      });
      notify();

      try {
        const view = options.force
          ? await transport.refresh(machineId)
          : await transport.read(machineId, { deep: options.deep ?? true, force: false });
        if (at >= (readApplied.get(machineId) ?? 0)) {
          readApplied.set(machineId, at);
          putEntry(machineId, { view: merge(machineId, view), loading: false, error: null });
        }
      } catch (error) {
        // A failed request never blanks the machine; it annotates it.
        if (at >= (readApplied.get(machineId) ?? 0)) {
          readApplied.set(machineId, at);
          putEntry(machineId, {
            view: state.entries[machineId]?.view ?? null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        // Only the newest read for this machine owns the spinner.
        if ((readIssued.get(machineId) ?? 0) === at) {
          readPending.delete(machineId);
          const settled = state.entries[machineId];
          if (settled?.loading) putEntry(machineId, { ...settled, loading: false });
        }
        notify();
      }
    },

    reset(): void {
      state = { entries: {}, updatedAt: null, error: null, loading: false };
      readIssued.clear();
      readApplied.clear();
      readPending.clear();
      sweepApplied = 0;
      ticket = 0;
      notify();
    },
  };
}

export type MeshNodeStateStore = ReturnType<typeof createMeshNodeStateStore>;
export type MeshNodeStateStoreState = StoreState;

/** The page's single store; the React binding lives in use-mesh-node-state.ts. */
export const meshNodeStateStore = createMeshNodeStateStore();

export function sweepMeshNodeStates(): Promise<void> {
  return meshNodeStateStore.sweep();
}

export function loadMeshNodeState(
  machineId: string,
  options: { deep?: boolean; force?: boolean } = {},
): Promise<void> {
  return meshNodeStateStore.load(machineId, options);
}

export function refreshMeshNodeState(machineId: string): Promise<void> {
  return meshNodeStateStore.load(machineId, { force: true });
}

/* ── Reading the state out, for copy that does not lie ── */

export type MeshNodeReachSummary = {
  tone: "ok" | "warn" | "bad" | "muted";
  label: string;
  detail: string | null;
};

/**
 * One sentence for what we know about a machine, keeping the four readings
 * apart. "Unknown" is a real answer here and is never dressed up as "idle".
 */
export function summarizeNodeReach(view: MeshNodeStateView | null): MeshNodeReachSummary {
  if (!view || view.broker === "unknown") {
    if (view?.network === "unreachable") {
      return { tone: "bad", label: "Offline", detail: "This machine is not on the tailnet right now." };
    }
    if (view && !view.node?.brokerUrl && view.kind === "tailnet") {
      return { tone: "muted", label: "No broker address", detail: "This device publishes no address to check." };
    }
    return { tone: "muted", label: "Not checked yet", detail: null };
  }
  switch (view.broker) {
    case "answered":
      return view.stale
        ? { tone: "warn", label: "Last known", detail: "Showing the last state this machine reported." }
        : { tone: "ok", label: "Responding", detail: null };
    case "unsupported":
      return {
        tone: "warn",
        label: "Older broker",
        detail: view.detail === "none"
          ? "This broker does not report node state. Select it to load what it can."
          : "This broker reports who is registered, but not what they are doing.",
      };
    case "refused":
      return { tone: "bad", label: "Refused", detail: view.error };
    case "unreachable":
    default:
      return { tone: "bad", label: "No answer", detail: view.error };
  }
}

/** Whether a workload block may be read as "this machine is idle". */
export function isEvidencedIdle(view: MeshNodeStateView | null): boolean {
  const workload = view?.workload;
  return Boolean(
    view
    && view.broker === "answered"
    && !view.stale
    && workload
    && workload.total === 0
    // A count that stopped early, or a source that could name agents without
    // attesting their liveness, is not evidence of an idle machine. "Nothing
    // running" is only sayable from a complete, attested reading.
    && !workload.truncated
    && workload.working !== null,
  );
}
