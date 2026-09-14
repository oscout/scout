/**
 * Per-node state for the Network page.
 *
 * The page renders known inventory immediately from `/api/mesh`; this module
 * answers the separate question "what is actually going on over there?" for one
 * machine at a time, and it keeps the readings apart on purpose:
 *
 * - `network`    — could we reach the host at all
 * - `broker`     — did a Scout broker answer, refuse, or not understand us
 * - `observedAt` — when the state we are showing was true on that machine
 * - `workload`   — what is running there; `null` when nothing has evidenced it,
 *                  and individual counters are `null` when a source can name
 *                  agents but cannot attest their liveness
 *
 * Nothing here infers workload from reachability, and nothing infers idleness
 * from silence. A machine we cannot reach keeps its last good reading, flagged
 * `stale`; a machine that answers with an empty roster is genuinely idle, which
 * is a different and equally real fact.
 *
 * ## Trust and reach
 *
 * Callers name a machine by the id the mesh snapshot already published — a node
 * id, or `tailnet:<peerId>` for a tailnet device with no node record. A
 * caller-supplied URL is never accepted, so this is not a proxy and cannot be
 * steered at an arbitrary host. Peer reads go over `meshPeerFetch`, the signed
 * and TLS-pinned mesh client, and only to routes that are observe-tier in the
 * mesh route matrix: the local-only home feed is never widened. A payload whose
 * `nodeId` disagrees with the node we dialled is discarded rather than shown.
 *
 * Only tailnet addresses are dialled for tailnet-only rows. A device's private
 * LAN address is never used: several exe VMs advertise the same 10.42.0.42, so
 * that address neither reaches a specific machine nor identifies one.
 *
 * ## Caching boundary (deliberate)
 *
 * The cache below lives in the **web server process**. It coalesces every
 * viewer served by this machine's web server onto one probe per node, which is
 * the duplicate-check problem the Network page actually has. It is NOT a
 * broker-owned cross-process cache: a second web server, or the native app
 * talking to the broker directly, probes independently. Promoting this to
 * broker-owned state would mean the broker holding and expiring peer-state
 * records, which is a larger change than this lane, so the boundary is stated
 * rather than blurred.
 */

import { requestScoutBrokerJson } from "@openscout/runtime/broker-api";
import { meshPeerFetch } from "@openscout/runtime/mesh-peer-client";
import {
  MESH_NODE_STATE_ROSTER_LIMIT,
  MESH_NODE_STATE_SESSION_LIMIT,
  MESH_NODE_STATE_WORK_LIMIT,
  type MeshNodeStateReport,
} from "@openscout/runtime/mesh-node-state";
import { resolveBrokerSocketPathForBaseUrl } from "@openscout/runtime/broker-process-manager";
import { scoutBrokerPaths } from "@openscout/protocol";

import { resolveScoutBrokerUrl, loadScoutBrokerContext } from "../broker/service.ts";
import { readLocalNodeStateFromSnapshot } from "./local-node-state.ts";
import { projectPeerSnapshot, type PeerSnapshotProjection } from "./peer-snapshot-projection.ts";
import { loadMeshStatus, type MeshStatusReport } from "./service.ts";

/* ── Wire types ── */

export type MeshNodeNetworkStatus = "reachable" | "unreachable" | "unknown";

export type MeshNodeBrokerStatus =
  /** a Scout broker answered this check */
  | "answered"
  /** nothing answered on the broker address */
  | "unreachable"
  /** something answered and rejected us (gate, TLS pin, auth, wrong node) */
  | "refused"
  /** a broker answered but serves no supported state route */
  | "unsupported"
  /** nothing has asked yet */
  | "unknown";

/** How much of the machine we can actually describe. */
export type MeshNodeDetailLevel = "full" | "roster" | "none";

export type MeshNodeStateAgentView = {
  id: string;
  title: string;
  role: string | null;
  projectRoot: string | null;
  /** `null` when the source could name the agent but not its lifecycle state. */
  state: "offline" | "available" | "working" | null;
  statusLabel: string | null;
  lastSeenAt: number | null;
};

export type MeshNodeWorkloadView = {
  total: number;
  /** `null` counters mean "this source cannot attest liveness", not zero. */
  working: number | null;
  available: number | null;
  offline: number | null;
  truncated: boolean;
  /** Rows the peer would not attribute to this node; excluded from `total`. */
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
 * A section is `null` when nothing has reported it — an older peer whose
 * snapshot scan never reached it, or a machine we could not reach at all. That
 * is not the same as a section with nothing in it, and the panel renders the
 * two differently.
 */
export type MeshNodeStateSectionView<T> = {
  total: number;
  truncated: boolean;
  items: T[];
} | null;

export type MeshNodeStateView = {
  /** Node id, or `tailnet:<peerId>` for a tailnet device with no node record. */
  machineId: string;
  kind: "local" | "peer" | "tailnet";
  label: string;
  network: MeshNodeNetworkStatus;
  broker: MeshNodeBrokerStatus;
  detail: MeshNodeDetailLevel;
  /** Which supported read produced the state below. */
  source: "local" | "node-state" | "snapshot" | null;
  /** When this web server last completed a check. */
  checkedAt: number | null;
  /** When the state shown was true on that machine, by its clock. */
  observedAt: number | null;
  /** The state shown is a previous good reading kept after a failed check. */
  stale: boolean;
  /** A check is running right now for this machine. */
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
  /** `null` means "not evidenced", never "nothing running". */
  workload: MeshNodeWorkloadView | null;
  roster: MeshNodeStateAgentView[];
  /** Live harness sessions on the machine. */
  sessions: MeshNodeStateSectionView<MeshNodeStateSessionView>;
  /** Work in flight against the machine's agents. */
  work: MeshNodeStateSectionView<MeshNodeStateWorkView> & { running?: number } | null;
  /** Consecutive failed checks; drives the backoff below. */
  failures: number;
  /** Earliest time an automatic refresh may run again. */
  nextAttemptAt: number | null;
};

export type MeshNodeStateList = {
  updatedAt: number;
  nodes: MeshNodeStateView[];
};

/* ── Policy ── */

/** A reading younger than this answers without touching the network. */
export const NODE_STATE_FRESH_MS = 20_000;
/** Ceiling on peer probes in flight from this process, across every caller. */
export const NODE_STATE_MAX_CONCURRENCY = 4;
const PEER_TIMEOUT_MS = 4_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A compact report is small; anything larger is not one, and is not read. */
const MAX_PAYLOAD_BYTES = 512 * 1024;
const SNAPSHOT_FALLBACK_ROSTER_LIMIT = 24;
/**
 * The legacy snapshot path has its own budget, because it is a different shape
 * of request. Measured live: a peer sends 42 MB of whole-registry to answer a
 * question about 9 agents. We stream and discard rather than buffer, so the
 * ceiling bounds time on the wire, not memory.
 */
const LEGACY_MAX_BYTES = 64 * 1024 * 1024;
const LEGACY_TIMEOUT_MS = 25_000;
/** The local registry snapshot is a socket read, but it can be a large one. */
const LOCAL_SNAPSHOT_TIMEOUT_MS = 10_000;

export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

/* ── Inventory ── */

export type MeshMachineTarget = {
  machineId: string;
  kind: "local" | "peer" | "tailnet";
  label: string;
  brokerUrl: string | null;
  /** Node id a peer payload must claim to be accepted; null for tailnet rows. */
  expectedNodeId: string | null;
  /** Second dial for a guessed scheme; never a second host. */
  fallbackBrokerUrl?: string | null;
  node: MeshNodeStateView["node"];
  /** Tailnet presence, when a tailnet peer backs or matches this row. */
  tailnetOnline: boolean | null;
};

function shortHost(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0]?.split(".")[0] ?? "";
}

const GENERIC_PEER_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "127.0.0.1", "::1"]);

function peerHostKey(peer: { dnsName?: string | null; hostName?: string | null; name?: string | null }): string {
  const dns = shortHost(peer.dnsName);
  if (dns && !GENERIC_PEER_HOSTNAMES.has(dns.toLowerCase())) return dns.toLowerCase();
  const host = shortHost(peer.hostName);
  if (host && !GENERIC_PEER_HOSTNAMES.has(host.toLowerCase())) return host.toLowerCase();
  return (peer.name ?? "").trim().toLowerCase();
}

function nodeHostKey(node: { hostName?: string | null; name?: string | null }): string {
  return (shortHost(node.hostName) || shortHost(node.name)).toLowerCase();
}

function cleanAddress(address: string | null | undefined): string | null {
  const value = (address ?? "").split("/")[0]?.trim();
  return value ? value : null;
}

/** Tailscale CGNAT (100.64.0.0/10) and the tailnet IPv6 ULA prefix. */
export function isTailnetAddress(address: string): boolean {
  if (address.includes(":")) return address.toLowerCase().startsWith("fd7a:115c:a1e0");
  const octets = address.split(".");
  if (octets.length !== 4) return false;
  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return Number.isInteger(first) && Number.isInteger(second)
    && first === 100 && second >= 64 && second <= 127;
}

function tailnetHostAddress(addresses: readonly string[] | undefined): string | null {
  for (const raw of addresses ?? []) {
    const address = cleanAddress(raw);
    if (address && isTailnetAddress(address)) return address;
  }
  return null;
}

function brokerUrlForAddress(address: string, scheme: "https" | "http"): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `${scheme}://${host}:43110`;
}

/**
 * A tailnet device has not announced a broker URL, so its scheme is a guess.
 * Mesh brokers announce `https`, so that is dialled first; a plaintext broker
 * is retried once rather than reported as an unreachable machine.
 */
function tailnetBrokerUrl(addresses: readonly string[] | undefined): string | null {
  const address = tailnetHostAddress(addresses);
  return address ? brokerUrlForAddress(address, "https") : null;
}

function tailnetBrokerUrlFallback(addresses: readonly string[] | undefined): string | null {
  const address = tailnetHostAddress(addresses);
  return address ? brokerUrlForAddress(address, "http") : null;
}

function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true;
  const octets = host.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part));
}

/**
 * Where to actually dial a registered node.
 *
 * A node can announce a private LAN address it shares with other machines —
 * several exe VMs all publish 10.42.0.42 — and dialling that reaches whichever
 * VM answers, not the one asked about. When the node also appears on the
 * tailnet, its tailnet address names one machine, so that is preferred. A
 * hostname is left alone: names resolve per network and are not ambiguous the
 * way a shared RFC-1918 literal is.
 */
function preferredBrokerUrl(
  announced: string | null,
  twin: { addresses?: readonly string[] } | undefined,
): string | null {
  const tailnetAddress = tailnetHostAddress(twin?.addresses);
  if (!announced) return tailnetAddress ? brokerUrlForAddress(tailnetAddress, "https") : null;
  let parsed: URL;
  try {
    parsed = new URL(announced);
  } catch {
    return announced;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!isIpLiteral(host) || isTailnetAddress(host)) return announced;
  if (!tailnetAddress) return announced;
  const scheme = parsed.protocol === "http:" ? "http" : "https";
  const port = parsed.port || "43110";
  const nextHost = tailnetAddress.includes(":") ? `[${tailnetAddress}]` : tailnetAddress;
  return `${scheme}://${nextHost}:${port}`;
}

/**
 * The machines the Network page may ask about, derived from the mesh snapshot.
 * This is the allowlist: an id outside it is rejected, so no request can be
 * steered at a host the broker has not published.
 */
export function meshMachineTargets(mesh: MeshStatusReport): MeshMachineTarget[] {
  const targets: MeshMachineTarget[] = [];
  const localId = mesh.localNode?.id ?? null;
  const running = Boolean(mesh.tailscale?.running);

  const peersByHostKey = new Map<string, MeshStatusReport["tailscale"]["peers"][number]>();
  for (const peer of mesh.tailscale?.peers ?? []) {
    const key = peerHostKey(peer);
    if (key && !peersByHostKey.has(key)) peersByHostKey.set(key, peer);
  }

  const claimedHostKeys = new Set<string>();
  for (const node of Object.values(mesh.nodes ?? {})) {
    if (!node?.id) continue;
    const hostKey = nodeHostKey(node);
    if (hostKey) claimedHostKeys.add(hostKey);
    const twin = hostKey ? peersByHostKey.get(hostKey) : undefined;
    targets.push({
      machineId: node.id,
      kind: node.id === localId ? "local" : "peer",
      label: shortHost(node.hostName) || node.name || node.id,
      brokerUrl: preferredBrokerUrl(node.brokerUrl ?? null, twin),
      expectedNodeId: node.id,
      node: {
        id: node.id,
        name: node.name ?? null,
        hostName: node.hostName ?? null,
        meshId: node.meshId ?? null,
        brokerUrl: node.brokerUrl ?? null,
        capabilities: node.capabilities ?? [],
        lastSeenAt: typeof node.lastSeenAt === "number" ? node.lastSeenAt : null,
      },
      tailnetOnline: twin ? Boolean(twin.online && running) : null,
    });
  }
  const localHostKey = mesh.localNode ? nodeHostKey(mesh.localNode) : "";
  if (localHostKey) claimedHostKeys.add(localHostKey);

  for (const peer of mesh.tailscale?.peers ?? []) {
    const hostKey = peerHostKey(peer);
    if (!hostKey || claimedHostKeys.has(hostKey)) continue;
    claimedHostKeys.add(hostKey);
    targets.push({
      machineId: `tailnet:${peer.id}`,
      kind: "tailnet",
      label: hostKey,
      brokerUrl: tailnetBrokerUrl(peer.addresses),
      fallbackBrokerUrl: tailnetBrokerUrlFallback(peer.addresses),
      // A tailnet device has no announced node id, so any node a broker there
      // claims is new information rather than something to check against.
      expectedNodeId: null,
      node: null,
      tailnetOnline: Boolean(peer.online && running),
    });
  }

  return targets;
}

/* ── One check ── */

function emptyView(target: MeshMachineTarget): MeshNodeStateView {
  return {
    machineId: target.machineId,
    kind: target.kind,
    label: target.label,
    network: target.tailnetOnline === null
      ? "unknown"
      : target.tailnetOnline
        ? "reachable"
        : "unreachable",
    broker: "unknown",
    detail: "none",
    source: null,
    checkedAt: null,
    observedAt: null,
    stale: false,
    checking: false,
    error: null,
    node: target.node,
    workload: null,
    roster: [],
    sessions: null,
    work: null,
    failures: 0,
    nextAttemptAt: null,
  };
}

function reportToView(
  target: MeshMachineTarget,
  report: MeshNodeStateReport,
  source: "local" | "node-state",
  now: number,
): MeshNodeStateView {
  return {
    ...emptyView(target),
    network: "reachable",
    broker: "answered",
    detail: "full",
    source,
    checkedAt: now,
    observedAt: typeof report.observedAt === "number" ? report.observedAt : now,
    node: {
      id: report.nodeId ?? target.node?.id ?? target.machineId,
      name: report.name ?? target.node?.name ?? null,
      hostName: report.hostName ?? target.node?.hostName ?? null,
      meshId: report.meshId ?? target.node?.meshId ?? null,
      brokerUrl: target.brokerUrl,
      capabilities: report.capabilities ?? target.node?.capabilities ?? [],
      lastSeenAt: target.node?.lastSeenAt ?? null,
    },
    workload: report.workload
      ? {
          total: report.workload.total,
          working: report.workload.working,
          available: report.workload.available,
          offline: report.workload.offline,
          truncated: Boolean(report.workload.truncated),
          unattributed: 0,
        }
      : null,
    // Caps are re-applied on ingest. The limits a peer honours are the peer's
    // business; a 512 KB envelope can hold thousands of tiny rows, and the
    // panel's bounds must not depend on a remote build behaving.
    roster: (report.roster ?? []).slice(0, MESH_NODE_STATE_ROSTER_LIMIT).map((row) => ({
      id: row.id,
      title: row.title,
      role: row.role ?? null,
      projectRoot: row.projectRoot ?? null,
      state: row.state ?? null,
      statusLabel: row.statusLabel ?? null,
      lastSeenAt: row.lastSeenAt ?? null,
    })),
    sessions: report.sessions
      ? {
          total: report.sessions.total,
          truncated: Boolean(report.sessions.truncated)
            || (report.sessions.items ?? []).length > MESH_NODE_STATE_SESSION_LIMIT,
          items: (report.sessions.items ?? []).slice(0, MESH_NODE_STATE_SESSION_LIMIT),
        }
      : null,
    work: report.work
      ? {
          total: report.work.total,
          running: report.work.running,
          truncated: Boolean(report.work.truncated)
            || (report.work.items ?? []).length > MESH_NODE_STATE_WORK_LIMIT,
          items: (report.work.items ?? []).slice(0, MESH_NODE_STATE_WORK_LIMIT),
        }
      : null,
  };
}

function isMeshNodeStateReport(value: unknown): value is MeshNodeStateReport {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "mesh-node-state"
    && typeof (value as { nodeId?: unknown }).nodeId === "string",
  );
}

/**
 * Project an older peer's registry snapshot into this node's own state.
 *
 * The snapshot names who is registered and what sessions and flights the peer
 * holds, but it carries no lifecycle attestation for an agent, so every
 * roster row's state stays `null` and the working / available / offline
 * counters stay `null` too — "registered here, liveness unknown", never a
 * fabricated zero. Records the peer does not attribute to this node are
 * counted separately rather than folded into the machine's total.
 *
 * Selection-only: never part of the recurring list refresh.
 */
function projectionToView(
  target: MeshMachineTarget,
  projection: PeerSnapshotProjection,
  now: number,
): MeshNodeStateView {
  const reached = new Set(projection.complete);
  return {
    ...emptyView(target),
    network: "reachable",
    broker: "answered",
    // Roster, not full: this is who is registered, not what they are doing.
    detail: "roster",
    source: "snapshot",
    checkedAt: now,
    // A registry snapshot carries no observation stamp of its own; the only
    // honest timestamp is when we read it.
    observedAt: now,
    workload: {
      total: projection.matched.agents,
      working: null,
      available: null,
      offline: null,
      // A record we skipped is a record we did not count: any of these means
      // the total below is a floor, not a complete census.
      truncated: projection.matched.agents > projection.agents.length
        || projection.truncated
        || projection.oversizeRecords > 0,
      unattributed: projection.unattributed,
    },
    roster: projection.agents.map((agent) => ({
      id: agent.id,
      title: (agent.displayName ?? "").trim() || agent.id,
      role: typeof agent.metadata?.role === "string" ? agent.metadata.role : null,
      projectRoot: typeof agent.metadata?.projectRoot === "string" ? agent.metadata.projectRoot : null,
      state: null,
      statusLabel: null,
      lastSeenAt: null,
    })),
    // A section the scan never reached stays null — unread, not empty.
    sessions: reached.has("endpoints")
      ? {
          total: projection.matched.endpoints,
          truncated: projection.matched.endpoints > projection.endpoints.length
            || projection.truncated
            || projection.oversizeRecords > 0,
          items: projection.endpoints.map((endpoint) => ({
            id: endpoint.id,
            agentId: endpoint.agentId ?? "",
            harness: endpoint.harness ?? null,
            transport: endpoint.transport ?? null,
            state: endpoint.state ?? "unknown",
            sessionId: endpoint.sessionId ?? null,
            projectRoot: typeof endpoint.metadata?.projectRoot === "string"
              ? endpoint.metadata.projectRoot
              : null,
          })),
        }
      : null,
    work: reached.has("flights")
      ? {
          total: projection.matched.flights,
          truncated: projection.matched.flights > projection.flights.length
            || projection.truncated
            || projection.oversizeRecords > 0,
          items: projection.flights.map((flight) => ({
            id: flight.id,
            targetAgentId: flight.targetAgentId ?? "",
            state: flight.state ?? "unknown",
            // Flight output never leaves the peer; only a status line does.
            summary: null,
            startedAt: flight.startedAt ?? flight.createdAt ?? null,
            completedAt: flight.completedAt ?? null,
          })),
        }
      : null,
  };
}

function failureView(
  target: MeshMachineTarget,
  previous: MeshNodeStateView | null,
  broker: MeshNodeBrokerStatus,
  network: MeshNodeNetworkStatus,
  error: string,
  now: number,
): MeshNodeStateView {
  const base = previous ?? emptyView(target);
  const keepsState = Boolean(previous?.source);
  return {
    ...base,
    machineId: target.machineId,
    kind: target.kind,
    label: target.label,
    node: base.node ?? target.node,
    network,
    broker,
    checkedAt: now,
    // Last good reading survives the failure, visibly marked. Collapsing to an
    // empty machine here is the lie this whole module exists to avoid.
    stale: keepsState,
    checking: false,
    error,
  };
}

export type MeshNodeStateFetchDeps = {
  peerFetch?: typeof meshPeerFetch;
  readLocal?: (signal: AbortSignal) => Promise<unknown>;
  /** Local compatibility read for a broker that predates the compact route. */
  readLocalSnapshot?: typeof readLocalNodeStateFromSnapshot;
  now?: () => number;
};

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** A refusal is a live peer that would not talk to us — never a dead host. */
function classifyPeerFailure(error: unknown): { broker: MeshNodeBrokerStatus; network: MeshNodeNetworkStatus } {
  const name = error instanceof Error ? error.name : "";
  if (name === "PeerTlsPinError" || name === "PeerCardVerificationError" || name === "PeerTlsDowngradeError") {
    return { broker: "refused", network: "reachable" };
  }
  // A body we could not read or parse came from a host that answered. Calling
  // that "unreachable" would put a dead-machine label on a live one.
  if (error instanceof PeerPayloadError) {
    return { broker: "unsupported", network: "reachable" };
  }
  return { broker: "unreachable", network: "unknown" };
}

/**
 * A peer answered, but not with something we can use. This is deliberately not
 * a transport error: the host is up and talking, so the panel must not say it
 * is unreachable.
 */
class PeerPayloadError extends Error {
  override readonly name = "PeerPayloadError";
  constructor(message: string, readonly kind: "oversize" | "parse") {
    super(message);
  }
}

/**
 * Read a bounded JSON body.
 *
 * The cap is enforced **while reading**, not after: a peer that omits or lies
 * about `content-length` must not be able to make us buffer its whole registry
 * before we reject it. The declared length is still a fast path out, and the
 * whole read happens under the caller's abort signal.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
    throw new PeerPayloadError(
      `Response declares ${declared} bytes, over the ${MAX_PAYLOAD_BYTES} byte bound.`, "oversize");
  }
  const body = response.body;
  if (!body) throw new PeerPayloadError("The broker answered with no body.", "parse");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PAYLOAD_BYTES) {
        throw new PeerPayloadError(
          `Response passed the ${MAX_PAYLOAD_BYTES} byte bound for a compact report.`, "oversize");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    // Stop the transfer on the way out, whether we finished or gave up.
    await reader.cancel().catch(() => undefined);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PeerPayloadError(`The broker answered with unreadable JSON: ${describeError(error)}`, "parse");
  }
}

/**
 * One check against one machine.
 *
 * `deep` adds the selection-only snapshot fallback for peers that do not serve
 * the compact route. The recurring list refresh never sets it.
 */
export async function readMeshNodeState(
  target: MeshMachineTarget,
  previous: MeshNodeStateView | null,
  options: { deep?: boolean } & MeshNodeStateFetchDeps = {},
): Promise<MeshNodeStateView> {
  const now = options.now?.() ?? Date.now();

  if (target.kind === "local") {
    let compactError: string | null = null;
    try {
      const payload = await withTimeout((signal) => (
        options.readLocal
          ? options.readLocal(signal)
          : (() => {
              const baseUrl = resolveScoutBrokerUrl();
              return requestScoutBrokerJson<unknown>(baseUrl, scoutBrokerPaths.v1.meshNodeState, {
                socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
                signal,
              });
            })()
      ), PEER_TIMEOUT_MS);
      if (isMeshNodeStateReport(payload)) return reportToView(target, payload, "local", now);
      compactError = "This broker answered with an unrecognized node-state payload.";
    } catch (error) {
      compactError = describeError(error);
    }

    // The broker running right now may predate this route — a web server can be
    // updated without restarting the broker under it. Fall back to the registry
    // snapshot the web server already reads, scoped by the broker's own rules.
    try {
      const local = await withTimeout(
        (signal) => (options.readLocalSnapshot ?? readLocalNodeStateFromSnapshot)(target.expectedNodeId, { signal }),
        LOCAL_SNAPSHOT_TIMEOUT_MS,
      );
      if (local) return reportToView(target, local, "local", now);
    } catch (error) {
      compactError = `${compactError ?? ""} ${describeError(error)}`.trim();
    }
    return failureView(target, previous, "unreachable", "reachable",
      compactError ?? "This broker did not answer.", now);
  }

  if (!target.brokerUrl) {
    return failureView(
      target,
      previous,
      "unknown",
      target.tailnetOnline === false ? "unreachable" : "unknown",
      target.kind === "tailnet"
        ? "This tailnet device publishes no reachable address."
        : "No broker address is published for this machine.",
      now,
    );
  }

  const peerFetch = options.peerFetch ?? meshPeerFetch;
  const brokerUrl = target.brokerUrl;

  // The fetch AND the body read share one deadline: a peer that answers headers
  // and then stalls must not hold a slot open past the timeout.
  let nodeStateOutcome: { ok: true; payload: unknown } | { ok: false; status: number };
  let dialledUrl = brokerUrl;
  try {
    nodeStateOutcome = await withTimeout(async (signal) => {
      const read = async (url: string) => {
        const response = await peerFetch(url, scoutBrokerPaths.v1.meshNodeState, { signal });
        if (!response.ok) return { ok: false as const, status: response.status };
        return { ok: true as const, payload: await readBoundedJson(response) };
      };
      try {
        return await read(brokerUrl);
      } catch (error) {
        // Only the scheme is retried, and only where we guessed it. The host is
        // never changed on a retry, so a failure cannot walk to another machine.
        const fallback = target.fallbackBrokerUrl;
        if (!fallback || fallback === brokerUrl || error instanceof PeerPayloadError) throw error;
        dialledUrl = fallback;
        return await read(fallback);
      }
    }, PEER_TIMEOUT_MS);
  } catch (error) {
    const classified = classifyPeerFailure(error);
    return failureView(target, previous, classified.broker, classified.network, describeError(error), now);
  }

  if (nodeStateOutcome.ok) {
    const payload = nodeStateOutcome.payload;
    if (!isMeshNodeStateReport(payload)) {
      return failureView(target, previous, "unsupported", "reachable",
        "The broker answered with an unrecognized node-state payload.", now);
    }
    // Identity check: a payload claiming a different node is not this machine's
    // state, whatever answered on the address.
    if (target.expectedNodeId && payload.nodeId !== target.expectedNodeId) {
      return failureView(target, previous, "refused", "reachable",
        `The broker at this address reports node ${payload.nodeId}, not ${target.expectedNodeId}.`, now);
    }
    return reportToView(target, payload, "node-state", now);
  }

  // A live broker that will not serve this route is an older peer, not a dead
  // host. It says so two ways: 404 where the route is simply absent, and 403
  // where a deny-by-default route matrix rejects a name it has never heard of.
  // Both are read as "cannot answer this", and the selection path then asks a
  // route that peer does publish — the peer's own gate still decides whether
  // to answer it, so nothing here widens what we are allowed to see.
  const status = nodeStateOutcome.status;
  const mayBeOlderPeer = status === 404 || status === 501 || status === 403 || status === 401;
  if (!mayBeOlderPeer) {
    return failureView(target, previous, "unreachable", "reachable", `Broker answered ${status}.`, now);
  }

  if (!options.deep) {
    return failureView(target, previous, "unsupported", "reachable",
      `This broker does not serve compact node state (${status}). Select it to load what it can report.`,
      now);
  }

  // The fallback reads a registry that describes many machines, and it can only
  // pick this one out by node id. A tailnet device with no node record gives us
  // nothing to scope by, and an unscoped registry would hand back other
  // machines' agents under this device's name. Say so instead.
  const expectedNodeId = target.expectedNodeId;
  if (!expectedNodeId) {
    return failureView(target, previous, "unsupported", "reachable",
      "This device runs an older broker that cannot report its own node identity, "
      + "so what it registers cannot be attributed to this machine.",
      now);
  }

  try {
    const projection = await withTimeout(async (signal) => {
      const response = await peerFetch(dialledUrl, "/v1/mesh/snapshot?scope=agents", { signal });
      if (!response.ok) throw new Error(`snapshot answered ${response.status}`);
      // Streamed and projected as it arrives: older peers ignore the scope hint
      // and send their whole registry, tens of megabytes of it, to answer a
      // question about a handful of agents.
      return await projectPeerSnapshot(response.body, {
        nodeId: expectedNodeId,
        limit: SNAPSHOT_FALLBACK_ROSTER_LIMIT,
        maxBytes: LEGACY_MAX_BYTES,
      });
    }, LEGACY_TIMEOUT_MS);

    if (projection.complete.length === 0 && projection.matched.agents === 0) {
      return failureView(target, previous, "unsupported", "reachable",
        projection.truncated
          ? "This peer's registry is too large to read within the limit set for one check."
          : "The peer's snapshot response could not be read.",
        now);
    }
    return projectionToView(target, projection, now);
  } catch (error) {
    const classified = classifyPeerFailure(error);
    // The compact route refused us and so did the one fallback: that is a
    // refusal, not an old build.
    const broker = status === 401 || status === 403 ? "refused" : classified.broker;
    return failureView(target, previous, broker, classified.network,
      `No supported detail route on this peer: ${describeError(error)}`, now);
  }
}

/* ── Cache, coalescing, backoff ── */

type CacheEntry = {
  view: MeshNodeStateView;
  inFlight: Promise<MeshNodeStateView> | null;
  /** Whether the running check is the deep, selection-only one. */
  inFlightDeep: boolean;
};

export type MeshNodeStateStore = {
  /**
   * Everything known right now. Returns immediately with cached readings and
   * kicks refreshes in the background, so one slow peer never delays the rest;
   * callers poll to collect results as they land.
   */
  list(options?: { refresh?: boolean }): Promise<MeshNodeStateList>;
  /** One machine, refreshed if stale. `deep` allows the selection-only path. */
  read(machineId: string, options?: { deep?: boolean; force?: boolean }): Promise<MeshNodeStateView | null>;
  /** Test seam: resolves when no check is running. */
  idle(): Promise<void>;
  reset(): void;
};

/** Shared ceiling on peer probes in flight, across list and selection callers. */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function createMeshNodeStateStore(
  deps: MeshNodeStateFetchDeps & {
    loadMesh?: () => Promise<MeshStatusReport>;
    fetchState?: typeof readMeshNodeState;
    maxConcurrency?: number;
  } = {},
): MeshNodeStateStore {
  const cache = new Map<string, CacheEntry>();
  const loadMesh = deps.loadMesh ?? loadMeshStatus;
  const fetchState = deps.fetchState ?? readMeshNodeState;
  const now = () => deps.now?.() ?? Date.now();
  const withSlot = createSemaphore(deps.maxConcurrency ?? NODE_STATE_MAX_CONCURRENCY);
  const running = new Set<Promise<unknown>>();

  function entryFor(target: MeshMachineTarget): CacheEntry {
    const existing = cache.get(target.machineId);
    if (existing) {
      // Inventory facts (label, kind, broker address) always come from the
      // current snapshot; only observed state is cached.
      existing.view = {
        ...existing.view,
        label: target.label,
        kind: target.kind,
        node: existing.view.node ?? target.node,
        network: existing.view.checkedAt === null ? emptyView(target).network : existing.view.network,
      };
      return existing;
    }
    const created: CacheEntry = { view: emptyView(target), inFlight: null, inFlightDeep: false };
    cache.set(target.machineId, created);
    return created;
  }

  function isFresh(view: MeshNodeStateView): boolean {
    return view.checkedAt !== null && now() - view.checkedAt < NODE_STATE_FRESH_MS;
  }

  function mayAttempt(view: MeshNodeStateView): boolean {
    return view.nextAttemptAt === null || now() >= view.nextAttemptAt;
  }

  /** True when a deep read would learn something a shallow one cannot. */
  function wantsDeeper(view: MeshNodeStateView): boolean {
    return view.broker === "unsupported" && view.detail !== "roster";
  }

  function settle(
    entry: CacheEntry,
    target: MeshMachineTarget,
    view: MeshNodeStateView,
  ): MeshNodeStateView {
    const failed = view.broker !== "answered";
    const failures = failed ? entry.view.failures + 1 : 0;
    const settled: MeshNodeStateView = {
      ...view,
      checking: false,
      failures,
      nextAttemptAt: failed ? (view.checkedAt ?? now()) + backoffDelayMs(failures) : null,
    };
    entry.view = settled;
    void target;
    return settled;
  }

  function start(target: MeshMachineTarget, deep: boolean): Promise<MeshNodeStateView> {
    const entry = entryFor(target);
    const previous = entry.view.source ? entry.view : null;
    entry.view = { ...entry.view, checking: true };
    entry.inFlightDeep = deep;

    const work = withSlot(() => fetchState(target, previous, { ...deps, deep }))
      .then((view) => settle(entry, target, view))
      .catch((error) => {
        const failures = entry.view.failures + 1;
        const settled: MeshNodeStateView = {
          ...failureView(target, entry.view.source ? entry.view : null, "unreachable", "unknown", describeError(error), now()),
          failures,
          nextAttemptAt: now() + backoffDelayMs(failures),
        };
        entry.view = settled;
        return settled;
      })
      .finally(() => {
        if (entry.inFlight === work) {
          entry.inFlight = null;
          entry.inFlightDeep = false;
        }
      });

    entry.inFlight = work;
    running.add(work);
    void work.finally(() => running.delete(work));
    return work;
  }

  /**
   * One probe per machine, however many viewers ask at once. A deep request
   * that arrives while a shallow check is running waits for it and then asks
   * again, so a selection never inherits a shallow "unsupported" answer and
   * stops there.
   *
   * The wait re-enters this function rather than starting the deeper probe
   * itself: two viewers selecting the same machine mid-sweep both resume in
   * the same microtask drain, and whichever resumes second has to join the
   * upgrade the first one started instead of launching a second probe at a
   * peer we have already decided is fragile.
   */
  function refresh(target: MeshMachineTarget, deep: boolean): Promise<MeshNodeStateView> {
    const entry = entryFor(target);
    if (entry.inFlight) {
      if (!deep || entry.inFlightDeep) return entry.inFlight;
      return entry.inFlight.then((view) => (wantsDeeper(view) ? refresh(target, true) : view));
    }
    return start(target, deep);
  }

  return {
    async list(options = {}) {
      const mesh = await loadMesh();
      const targets = meshMachineTargets(mesh);
      const live = new Set(targets.map((target) => target.machineId));
      for (const key of [...cache.keys()]) {
        if (!live.has(key)) cache.delete(key);
      }

      if (options.refresh !== false) {
        for (const target of targets) {
          const entry = entryFor(target);
          if (entry.inFlight || isFresh(entry.view) || !mayAttempt(entry.view)) continue;
          // Fire and collect later. Awaiting here would make the whole list as
          // slow as its slowest peer, which is the opposite of incremental.
          void refresh(target, false).catch(() => undefined);
        }
      }

      return {
        updatedAt: now(),
        nodes: targets.map((target) => entryFor(target).view),
      };
    },

    async read(machineId, options = {}) {
      const mesh = await loadMesh();
      const target = meshMachineTargets(mesh).find((candidate) => candidate.machineId === machineId);
      // Unknown id: not an error to explain, just not a machine we publish.
      if (!target) return null;

      const entry = entryFor(target);
      const deep = options.deep ?? false;
      const needsDeeper = deep && wantsDeeper(entry.view);
      if (!options.force && !needsDeeper) {
        if (isFresh(entry.view)) return entry.view;
        if (!mayAttempt(entry.view)) return entry.view;
      }
      return refresh(target, deep);
    },

    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },

    reset() {
      cache.clear();
    },
  };
}
