/**
 * Originator outbox + retry worker (Issue 3 of broker-three-contracts).
 *
 * Decouples the caller-facing `POST /v1/invocations` path from the
 * peer-broker-to-peer-broker hop. The HTTP handler enqueues a delivery in
 * `accepted` state and returns 202; this worker drains the outbox in the
 * background, retries on transient peer failures, and surfaces durable
 * terminal states (`peer_acked`, `failed { peer_unreachable | peer_rejected }`)
 * via the deliveries projection.
 *
 * Peer reachability is treated as a *delivery* concern, not a caller concern:
 * a peer being down causes the delivery to cycle `accepted ↔ deferred` until
 * it succeeds, the retry budget expires, or the peer explicitly refuses.
 */

import type {
  AgentDefinition,
  ControlEvent,
  DeliveryFailureReason,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  NodeDefinition,
} from "@openscout/protocol";

import type { FileBackedBrokerJournal } from "./broker-journal.js";
import {
  buildMeshInvocationBundle,
  forwardMeshInvocation,
  type MeshForwardTarget,
  PeerRejectedError,
  PeerUnreachableError,
} from "./mesh-forwarding.js";
import { meshPeerFetch, type MeshPeerFetch } from "./mesh-peer-client.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

/* ── Configuration ── */

export interface PeerDeliveryConfig {
  /** First retry delay after the first failure. Default 2_000 ms. */
  initialBackoffMs: number;
  /** Cap on retry delay. Default 60_000 ms. */
  maxBackoffMs: number;
  /** Total wall-clock window before giving up with `peer_unreachable`. Default 30 minutes. */
  retryWindowMs: number;
  /** How often the worker scans the outbox. Default 1_000 ms. */
  tickIntervalMs: number;
  /** How long a worker holds an exclusive lease on a delivery while forwarding. Default 30_000 ms. */
  leaseMs: number;
}

export const DEFAULT_PEER_DELIVERY_CONFIG: PeerDeliveryConfig = {
  initialBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  retryWindowMs: 30 * 60_000,
  tickIntervalMs: 1_000,
  leaseMs: 30_000,
};

/* ── Dependencies (injected so the worker is testable) ── */

export interface PeerDeliveryDeps {
  journal: Pick<FileBackedBrokerJournal, "listDeliveries" | "listDeliveryAttempts">;
  /** Returns the current registry snapshot (for bundle building). */
  snapshot: () => Readonly<RuntimeRegistrySnapshot>;
  /** Returns the local node definition (origin of the envelope). */
  localNode: () => NodeDefinition;
  /** Local node id — used to skip non-peer deliveries quickly. */
  localNodeId: string;
  /** Looks up a node definition by id (target peer). */
  nodeFor: (nodeId: string) => NodeDefinition | undefined;
  /** Looks up an agent definition by id (used to fail when target vanished). */
  agentFor: (agentId: string) => AgentDefinition | undefined;
  /** Looks up the in-flight invocation by id (used by enqueue + dispatcher). */
  invocationFor: (invocationId: string) => InvocationRequest | undefined;

  /** Persist a `deliveries.record` journal entry. */
  recordDelivery: (delivery: DeliveryIntent) => Promise<void>;
  /** Persist a `delivery.status.update` journal entry. */
  updateDeliveryStatus: (input: {
    deliveryId: string;
    status: DeliveryIntent["status"];
    metadata?: Record<string, unknown>;
    leaseOwner?: string | null;
    leaseExpiresAt?: number | null;
  }) => Promise<void>;
  /** Persist a `delivery.attempt.record` journal entry. */
  recordDeliveryAttempt: (attempt: {
    id: string;
    deliveryId: string;
    attempt: number;
    status: "sent" | "acknowledged" | "failed";
    error?: string;
    externalRef?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  /** Persist the receiver-returned flight (after a successful peer ACK). */
  recordFlight: (flight: FlightRecord) => Promise<void>;
  /** Mark the originator-side flight as failed (terminal). */
  failInvocation: (invocation: InvocationRequest, detail: string) => Promise<void>;
  /**
   * Emit a control event so per-invocation stream subscribers can mirror
   * delivery state transitions in real time. Optional — when absent, state
   * is still durable via the journal but only observable by polling.
   */
  emit?: (event: ControlEvent) => void;

  /**
   * Forward the bundle to the receiver. Default is `forwardMeshInvocation`;
   * tests inject a stub. Throws `PeerUnreachableError` for network failures
   * and `PeerRejectedError` for HTTP error responses.
   */
  forward?: (target: MeshForwardTarget, bundle: ReturnType<typeof buildMeshInvocationBundle>) =>
    Promise<{ ok: true; flight: FlightRecord; duplicate?: boolean }>;

  /**
   * Signed peer client for the authority status-mirror stream (mesh trust
   * cone §5). Defaults to the shared meshPeerFetch singleton; tests inject
   * a stub to stay hermetic.
   */
  peerFetch?: MeshPeerFetch;

  /** Inject a clock for tests. */
  now?: () => number;
}

/* ── Helpers ── */

function pickFailureReason(error: unknown): DeliveryFailureReason {
  if (error instanceof PeerUnreachableError) return "peer_unreachable";
  if (error instanceof PeerRejectedError) {
    return error.retryable ? "peer_unreachable" : "peer_rejected";
  }
  return "peer_unreachable";
}

function nextBackoffMs(attempt: number, config: PeerDeliveryConfig): number {
  // attempt is 1-based: first retry uses initialBackoffMs.
  const exp = config.initialBackoffMs * 2 ** Math.max(0, attempt - 1);
  // Decorrelated jitter: ±25% so a fleet of brokers doesn't sync up.
  const base = Math.min(exp, config.maxBackoffMs);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(config.initialBackoffMs, Math.round(base + jitter));
}

function readNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasMeshEntrypoint(node: NodeDefinition | undefined): node is NodeDefinition {
  return Boolean(node?.meshEntrypoints?.length);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emitDeliveryStateChanged(
  emit: PeerDeliveryDeps["emit"],
  delivery: DeliveryIntent,
  previousStatus: DeliveryIntent["status"] | undefined,
  ts: number,
): void {
  if (!emit) return;
  emit({
    id: createId("evt"),
    kind: "delivery.state.changed",
    ts,
    actorId: "system",
    payload: { delivery, previousStatus },
  });
}

/* ── Authority status mirror ──
 *
 * After a delivery reaches `peer_acked`, we subscribe to the authority
 * broker's per-invocation stream and rebroadcast `flight.updated` and
 * `delivery.state.changed` events into our own local stream so callers
 * observing the originator see the full lifecycle.
 */

const MIRRORED_EVENT_KINDS = new Set(["flight.updated", "delivery.state.changed"]);
const TERMINAL_FLIGHT_STATES = new Set(["completed", "failed", "cancelled"]);

interface StatusMirrorHandle {
  stop: () => void;
}

function parseSseFrame(frame: string): { event: string; data: string } | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^\s/, ""));
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

function isTerminalFlightEvent(event: ControlEvent): boolean {
  if (event.kind !== "flight.updated") return false;
  const state = (event.payload as { flight?: { state?: string } })?.flight?.state;
  return typeof state === "string" && TERMINAL_FLIGHT_STATES.has(state);
}

function startStatusMirror(args: {
  peerUrl: string;
  invocationId: string;
  emit: (event: ControlEvent) => void;
  peerFetch: MeshPeerFetch;
  onClose?: () => void;
}): StatusMirrorHandle {
  const controller = new AbortController();
  const baseUrl = args.peerUrl.replace(/\/$/, "");
  const streamPath = (prefix: string) =>
    `${prefix}/invocations/${encodeURIComponent(args.invocationId)}/stream`;

  void (async () => {
    try {
      // Remote-tier status stream (mesh trust cone §4): the local-tier route
      // is unreachable to peers in enforce mode. Pre-trust-cone peers lack
      // the /v1/mesh equivalent — fall back to the legacy path on 404.
      let response = await args.peerFetch(baseUrl, streamPath("/v1/mesh"), {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (response.status === 404) {
        response = await args.peerFetch(baseUrl, streamPath("/v1"), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
      }
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (parsed && MIRRORED_EVENT_KINDS.has(parsed.event)) {
            try {
              const data = JSON.parse(parsed.data) as ControlEvent;
              args.emit(data);
              if (isTerminalFlightEvent(data)) {
                controller.abort();
                break;
              }
            } catch {
              // Malformed frame — skip and keep streaming.
            }
          }
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted or network blip — the origin's outbox state is authoritative
      // either way; the mirror is best-effort observability.
    } finally {
      args.onClose?.();
    }
  })();

  return { stop: () => controller.abort() };
}

/* ── Public API ── */

export interface PeerDeliveryWorker {
  /**
   * Record a `peer_broker` delivery for an invocation that needs to cross
   * a node boundary, then trigger an immediate forward attempt. Returns the
   * persisted delivery so the caller can correlate it with the invocation.
   */
  enqueue: (invocation: InvocationRequest, peer: NodeDefinition) => Promise<DeliveryIntent>;
  /** Drain the outbox once. Safe to call concurrently — leasing prevents dupes. */
  tick: () => Promise<void>;
  /**
   * Hint that a previously-unreachable peer has come back online (e.g. from
   * the discovery loop). Forces an immediate flush so deferred deliveries
   * to that peer don't wait for their next backoff window.
   */
  notifyPeerOnline: (nodeId: string) => void;
  /** Start the periodic tick loop. */
  start: () => void;
  /** Stop the periodic tick loop. */
  stop: () => void;
}

export function createPeerDeliveryWorker(
  deps: PeerDeliveryDeps,
  config: Partial<PeerDeliveryConfig> = {},
): PeerDeliveryWorker {
  const cfg: PeerDeliveryConfig = { ...DEFAULT_PEER_DELIVERY_CONFIG, ...config };
  const forward = deps.forward ?? forwardMeshInvocation;
  const peerFetch = deps.peerFetch ?? meshPeerFetch;
  const now = deps.now ?? (() => Date.now());
  const leaseOwner = `peer-delivery-${createId("worker")}`;

  // In-process re-entrancy guard: the journal lease is the source of truth
  // across processes, but we also want to skip work we're actively doing in
  // this same process so a fast tick doesn't pile up.
  const inFlight = new Set<string>();
  const statusMirrors = new Map<string, StatusMirrorHandle>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;

  function ensureStatusMirror(deliveryId: string, peerUrl: string, invocationId: string): void {
    if (!deps.emit) return;
    if (statusMirrors.has(deliveryId)) return;
    const handle = startStatusMirror({
      peerUrl,
      invocationId,
      emit: deps.emit,
      peerFetch,
      onClose: () => {
        statusMirrors.delete(deliveryId);
      },
    });
    statusMirrors.set(deliveryId, handle);
  }

  async function enqueue(invocation: InvocationRequest, peer: NodeDefinition): Promise<DeliveryIntent> {
    const delivery: DeliveryIntent = {
      id: createId("dlv-peer"),
      invocationId: invocation.id,
      targetId: invocation.targetAgentId,
      targetNodeId: peer.id,
      targetKind: "agent",
      transport: "peer_broker",
      reason: "invocation",
      policy: "must_ack",
      status: "accepted",
      metadata: {
        peerBrokerUrl: peer.brokerUrl,
        firstAttemptQueuedAt: now(),
      },
    };
    await deps.recordDelivery(delivery);
    emitDeliveryStateChanged(deps.emit, delivery, undefined, now());
    // Fire-and-forget tick so the caller's 202 path is not blocked by the
    // forward attempt. Errors here are already journalled by the worker.
    void tick();
    return delivery;
  }

  /** Update a delivery's status and emit a state-change event when the status differs. */
  async function transition(
    delivery: DeliveryIntent,
    next: {
      status: DeliveryIntent["status"];
      metadata?: Record<string, unknown>;
      leaseOwner?: string | null;
      leaseExpiresAt?: number | null;
    },
  ): Promise<void> {
    const previousStatus = delivery.status;
    await deps.updateDeliveryStatus({ deliveryId: delivery.id, ...next });
    if (next.status !== previousStatus) {
      const merged: DeliveryIntent = {
        ...delivery,
        status: next.status,
        metadata: { ...(delivery.metadata ?? {}), ...(next.metadata ?? {}) },
        leaseOwner: next.leaseOwner ?? undefined,
        leaseExpiresAt: next.leaseExpiresAt ?? undefined,
      };
      emitDeliveryStateChanged(deps.emit, merged, previousStatus, now());
    }
  }

  function shouldAttempt(delivery: DeliveryIntent, currentTime: number): boolean {
    if (delivery.status === "accepted") return true;
    if (delivery.status !== "deferred") return false;
    const nextAt = readNumber(delivery.metadata, "nextAttemptAt");
    return typeof nextAt === "number" ? nextAt <= currentTime : true;
  }

  function isLeaseHeldByOther(delivery: DeliveryIntent, currentTime: number): boolean {
    if (!delivery.leaseOwner || delivery.leaseOwner === leaseOwner) return false;
    const expires = delivery.leaseExpiresAt;
    return typeof expires === "number" && expires > currentTime;
  }

  async function attemptDelivery(delivery: DeliveryIntent): Promise<void> {
    if (inFlight.has(delivery.id)) return;
    inFlight.add(delivery.id);

    try {
      const invocation = delivery.invocationId
        ? deps.invocationFor(delivery.invocationId)
        : undefined;
      if (!invocation) {
        await transition(delivery, {
          status: "failed",
          metadata: {
            failureReason: "peer_rejected",
            failureDetail: "originator dropped the invocation before it could be forwarded",
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return;
      }

      if (!delivery.targetNodeId) {
        await transition(delivery, {
          status: "failed",
          metadata: { failureReason: "peer_rejected", failureDetail: "delivery missing targetNodeId" },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        await deps.failInvocation(invocation, "peer delivery is missing targetNodeId");
        return;
      }

      const peer = deps.nodeFor(delivery.targetNodeId);
      const peerUrl = peer?.brokerUrl ?? readString(delivery.metadata, "peerBrokerUrl");
      const peerTarget: MeshForwardTarget | undefined = peerUrl || hasMeshEntrypoint(peer)
        ? (peer ?? peerUrl)
        : undefined;
      if (!peerTarget) {
        // No URL on record — peer hasn't been discovered yet. Defer until
        // a discovery cycle populates an HTTP URL or mesh entrypoint; don't
        // burn through the retry budget.
        const waitMs = Math.min(cfg.maxBackoffMs, 5_000);
        await transition(delivery, {
          status: "deferred",
          metadata: {
            failureReason: "peer_unreachable",
            failureDetail: `no broker URL or mesh entrypoint known for node ${delivery.targetNodeId}`,
            nextAttemptAt: now() + waitMs,
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return;
      }

      const attempts = deps.journal.listDeliveryAttempts(delivery.id);
      const attemptNumber = attempts.length + 1;
      const startedAt = now();

      // Take a lease so concurrent ticks (or peer brokers in HA) don't
      // double-forward. This does not change status, so no event fires.
      await deps.updateDeliveryStatus({
        deliveryId: delivery.id,
        status: delivery.status === "deferred" ? "deferred" : "accepted",
        leaseOwner,
        leaseExpiresAt: startedAt + cfg.leaseMs,
      });

      try {
        const bundle = buildMeshInvocationBundle(deps.snapshot(), deps.localNode(), invocation);
        const result = await forward(peerTarget, bundle);

        await deps.recordDeliveryAttempt({
          id: createId("dlv-att"),
          deliveryId: delivery.id,
          attempt: attemptNumber,
          status: "acknowledged",
          createdAt: now(),
          metadata: {
            peerBrokerUrl: peerUrl,
            peerTransport: typeof peerTarget === "string" ? "http" : "node_entrypoint",
            durationMs: now() - startedAt,
            duplicate: result.duplicate ?? false,
          },
        });
        await transition(delivery, {
          status: "peer_acked",
          metadata: {
            peerAckedAt: now(),
            peerFlightId: result.flight?.id,
            authorityStreamUrl: peerUrl
              ? `${peerUrl.replace(/\/$/, "")}/v1/mesh/invocations/${encodeURIComponent(invocation.id)}/stream`
              : undefined,
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        if (result.flight) {
          await deps.recordFlight(result.flight);
        }
        if (peerUrl) {
          ensureStatusMirror(delivery.id, peerUrl, invocation.id);
        }
      } catch (error) {
        const reason = pickFailureReason(error);
        const detail = error instanceof Error ? error.message : String(error);

        await deps.recordDeliveryAttempt({
          id: createId("dlv-att"),
          deliveryId: delivery.id,
          attempt: attemptNumber,
          status: "failed",
          error: detail,
          createdAt: now(),
          metadata: {
            peerBrokerUrl: peerUrl,
            durationMs: now() - startedAt,
            failureReason: reason,
            httpStatus: error instanceof PeerRejectedError ? error.status : undefined,
          },
        });

        if (reason === "peer_rejected") {
          // Terminal — config/trust problem, never auto-retry.
          await transition(delivery, {
            status: "failed",
            metadata: { failureReason: reason, failureDetail: detail },
            leaseOwner: null,
            leaseExpiresAt: null,
          });
          await deps.failInvocation(
            invocation,
            `peer broker rejected invocation: ${detail}`,
          );
          return;
        }

        const firstQueuedAt = readNumber(delivery.metadata, "firstAttemptQueuedAt") ?? startedAt;
        const elapsed = now() - firstQueuedAt;
        if (elapsed >= cfg.retryWindowMs) {
          // Budget exhausted — give up.
          await transition(delivery, {
            status: "failed",
            metadata: {
              failureReason: "peer_unreachable",
              failureDetail: detail,
              attempts: attemptNumber,
              elapsedMs: elapsed,
            },
            leaseOwner: null,
            leaseExpiresAt: null,
          });
          await deps.failInvocation(
            invocation,
            `peer broker unreachable after ${attemptNumber} attempts (${Math.round(elapsed / 1000)}s): ${detail}`,
          );
          return;
        }

        const backoff = nextBackoffMs(attemptNumber, cfg);
        await transition(delivery, {
          status: "deferred",
          metadata: {
            failureReason: reason,
            failureDetail: detail,
            nextAttemptAt: now() + backoff,
            attempts: attemptNumber,
            backoffMs: backoff,
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
      }
    } finally {
      inFlight.delete(delivery.id);
    }
  }

  async function tickInternal(filterPeerNodeId?: string, force = false): Promise<void> {
    const currentTime = now();
    const candidates = deps.journal
      .listDeliveries({ transport: "peer_broker", limit: 500 })
      .filter((delivery) => delivery.status === "accepted" || delivery.status === "deferred")
      .filter((delivery) => !filterPeerNodeId || delivery.targetNodeId === filterPeerNodeId)
      .filter((delivery) => force || shouldAttempt(delivery, currentTime))
      .filter((delivery) => !isLeaseHeldByOther(delivery, currentTime));

    // Run forwards in parallel — each is bounded by HTTP timeout and we don't
    // want a slow peer to head-of-line block delivery to a fast one.
    await Promise.all(candidates.map((delivery) => attemptDelivery(delivery).catch((error) => {
      console.error(`[openscout-runtime] peer-delivery: unhandled error on delivery ${delivery.id}:`, error);
    })));
  }

  async function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = tickInternal().finally(() => {
      ticking = undefined;
    });
    return ticking;
  }

  function notifyPeerOnline(nodeId: string): void {
    // Bypass nextAttemptAt — heartbeat says the peer is back, no point waiting.
    void tickInternal(nodeId, true).catch((error) => {
      console.error(`[openscout-runtime] peer-delivery: flush for ${nodeId} failed:`, error);
    });
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, cfg.tickIntervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    for (const mirror of statusMirrors.values()) {
      try {
        mirror.stop();
      } catch {
        // best-effort cleanup
      }
    }
    statusMirrors.clear();
  }

  return { enqueue, tick, notifyPeerOnline, start, stop };
}
