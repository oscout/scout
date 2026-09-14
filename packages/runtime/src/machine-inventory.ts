// Machine inventory — turn four independent observers into one fleet.
//
// Nothing here decides *what a machine is*; that is `@openscout/protocol`'s
// `machines.ts`, which is pure and network-free. This module's job is the
// plumbing either side of it: read the probes, shape their output into
// evidence, then reconcile the resulting groups against the records already on
// disk so ids, operator-given names, and first-seen timestamps survive.
//
// The reconcile step is where the durable registry earns its keep. Evidence
// alone is a snapshot: a laptop that is asleep produces none, and a machine
// seen by ARP today and Tailscale tomorrow produces two disjoint sets. Feeding
// the stored identity keys back in as seeds is what makes those the same
// machine across days.

import {
  buildMachineRecord,
  compareMachines,
  groupMachineEvidence,
  normalizeMachineAddress,
  normalizeMachineHostName,
  type HostMachineEvidence,
  type LanMachineEvidence,
  type MachineEvidence,
  type MachineRecord,
  type MachineTerminalHost,
  type NodeDefinition,
  type ScoutMachineEvidence,
  type TailnetMachineEvidence,
} from "@openscout/protocol";

import { herdrSessionsProbe, isHerdrAvailable } from "./system-probes/herdr.js";
import { lanScanProbe, type LanScanSnapshot } from "./system-probes/lan-scan.js";
import { tailscaleStatusProbe, type TailscaleStatusSummary } from "./system-probes/tailscale-status.js";
import { tmuxSessionsProbe, zellijSessionsProbe } from "./system-probes/tmux.js";

/**
 * How long a machine nobody has seen stays on the roster. Long enough that a
 * laptop can be away for a holiday, short enough that a one-off café neighbour
 * does not live in the fleet forever. A pinned machine is never pruned.
 */
export const MACHINE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type MachineEvidenceSources = {
  /** Broker-known nodes, as `runtime.snapshot().nodes` hands them over. */
  nodes?: Readonly<Record<string, NodeDefinition>> | readonly NodeDefinition[];
  /** This broker's own node id, so its machine is marked as self. */
  localNodeId?: string | null;
  tailscale?: TailscaleStatusSummary | null;
  lan?: LanScanSnapshot | null;
  /** Terminal hosts, already attributed to a machine by the caller. */
  terminalHosts?: readonly HostMachineEvidence[];
  observedAt?: number;
};

/* ── Evidence shaping ── */

function scoutEvidence(
  nodes: readonly NodeDefinition[],
  localNodeId: string | null,
  observedAt: number,
): ScoutMachineEvidence[] {
  return nodes.map((node) => ({
    kind: "scout" as const,
    observedAt: node.lastSeenAt ?? observedAt,
    nodeId: node.id,
    ...(node.meshId ? { meshId: node.meshId } : {}),
    nodeName: node.name,
    ...(node.hostName ? { hostName: node.hostName } : {}),
    ...(node.brokerUrl ? { brokerUrl: node.brokerUrl } : {}),
    ...(node.webUrl ? { webUrl: node.webUrl } : {}),
    ...(node.advertiseScope ? { advertiseScope: node.advertiseScope } : {}),
    ...(node.tailnetName ? { tailnetName: node.tailnetName } : {}),
    ...(localNodeId && node.id === localNodeId ? { isSelf: true } : {}),
  }));
}

function tailnetEvidence(
  summary: TailscaleStatusSummary | null | undefined,
  observedAt: number,
): TailnetMachineEvidence[] {
  if (!summary) return [];

  const evidence: TailnetMachineEvidence[] = [];
  const tailnetName = summary.self?.tailnetName;

  if (summary.self) {
    evidence.push({
      kind: "tailnet",
      observedAt,
      peerId: summary.self.id,
      ...(summary.self.hostName ? { hostName: summary.self.hostName } : {}),
      ...(summary.self.dnsName ? { dnsName: summary.self.dnsName } : {}),
      ...(summary.self.tailnetName ? { tailnetName: summary.self.tailnetName } : {}),
      addresses: [...summary.self.addresses],
      // `self` is this machine; the backend being up is what "online" means here.
      online: summary.running,
      ...(summary.self.os ? { os: summary.self.os } : {}),
      isSelf: true,
    });
  }

  for (const peer of summary.peers) {
    evidence.push({
      kind: "tailnet",
      observedAt,
      peerId: peer.id,
      ...(peer.hostName ? { hostName: peer.hostName } : {}),
      ...(peer.dnsName ? { dnsName: peer.dnsName } : {}),
      ...(tailnetName ? { tailnetName } : {}),
      addresses: [...peer.addresses],
      online: peer.online,
      ...(peer.os ? { os: peer.os } : {}),
      ...(peer.tags?.length ? { tags: [...peer.tags] } : {}),
    });
  }

  return evidence;
}

function lanEvidence(
  scan: LanScanSnapshot | null | undefined,
  observedAt: number,
): LanMachineEvidence[] {
  if (!scan) return [];

  const evidence: LanMachineEvidence[] = [];

  for (const service of scan.services) {
    // An advert with neither a name nor an address names no machine.
    if (!service.addresses.length && !service.host && !service.instanceName) continue;
    evidence.push({
      kind: "lan",
      observedAt: scan.scannedAt || observedAt,
      method: "mdns",
      ...(service.host ? { hostName: service.host } : {}),
      ...(service.instanceName ? { instanceName: service.instanceName } : {}),
      serviceType: service.serviceType,
      addresses: [...service.addresses],
      ...(service.port ? { port: service.port } : {}),
      ...(Object.keys(service.txt).length ? { txt: service.txt } : {}),
    });
  }

  for (const neighbor of scan.neighbors) {
    evidence.push({
      kind: "lan",
      observedAt: scan.scannedAt || observedAt,
      method: "arp",
      addresses: [neighbor.address],
      macAddress: neighbor.macAddress,
      ...(neighbor.vendor ? { vendor: neighbor.vendor } : {}),
      ...(neighbor.interfaceName ? { interfaceName: neighbor.interfaceName } : {}),
    });
  }

  return evidence;
}

/** Shape every source into evidence. Pure — no probes are read here. */
export function buildMachineEvidence(sources: MachineEvidenceSources): MachineEvidence[] {
  const observedAt = sources.observedAt ?? Date.now();
  const nodes = Array.isArray(sources.nodes)
    ? [...sources.nodes]
    : Object.values((sources.nodes ?? {}) as Record<string, NodeDefinition>);

  return [
    ...scoutEvidence(nodes, sources.localNodeId ?? null, observedAt),
    ...tailnetEvidence(sources.tailscale, observedAt),
    ...lanEvidence(sources.lan, observedAt),
    ...(sources.terminalHosts ?? []).map((host) => ({ ...host })),
  ];
}

/* ── Reconcile ── */

export type MachineReconcileResult = {
  /** Every machine now on the roster, display-ordered. */
  machines: MachineRecord[];
  /** Records rebuilt from fresh evidence — the ones worth persisting. */
  updated: MachineRecord[];
  /**
   * Ids that no longer exist: absorbed into another record because evidence
   * proved they were one machine, or pruned for going unseen past retention.
   */
  removed: string[];
};

export type MachineReconcileOptions = {
  now?: number;
  retentionMs?: number;
};

/**
 * Fold this pass's evidence into the stored roster.
 *
 * Records the pass did not see are kept untouched (a sleeping laptop is still
 * part of the fleet) until they age past retention. Records the pass proved
 * identical are merged into the lowest-indexed survivor, which keeps the id
 * the operator has already seen in a URL or a command.
 */
export function reconcileMachines(
  existing: readonly MachineRecord[],
  evidence: readonly MachineEvidence[],
  options: MachineReconcileOptions = {},
): MachineReconcileResult {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? MACHINE_RETENTION_MS;

  const groups = groupMachineEvidence(evidence, existing.map((machine) => machine.identityKeys));

  const updated: MachineRecord[] = [];
  const removed: string[] = [];
  const consumedSeeds = new Set<number>();

  for (const group of groups) {
    const seeds = group.seedIndices.map((index) => existing[index]).filter(Boolean) as MachineRecord[];
    for (const index of group.seedIndices) consumedSeeds.add(index);

    const survivor = seeds[0] ?? null;
    for (const absorbed of seeds.slice(1)) removed.push(absorbed.id);

    // A merge inherits the union of what the absorbed records knew: the
    // earliest sighting, any pin, and the first note written on any of them.
    const previous = survivor
      ? {
        id: survivor.id,
        displayName: seeds.map((seed) => seed.displayName).find(Boolean) ?? null,
        notes: seeds.map((seed) => seed.notes).find(Boolean),
        pinned: seeds.some((seed) => seed.pinned),
        firstSeenAt: Math.min(...seeds.map((seed) => seed.firstSeenAt)),
        lastSeenAt: Math.max(...seeds.map((seed) => seed.lastSeenAt)),
        metadata: survivor.metadata,
      }
      : null;

    // The survivor keeps the keys every absorbed record contributed, so a
    // later pass that sees only an absorbed record's key still lands here.
    const identityKeys = [...new Set([
      ...group.identityKeys,
      ...seeds.flatMap((seed) => seed.identityKeys),
    ])].sort();

    updated.push(buildMachineRecord({ ...group, identityKeys }, previous));
  }

  const untouched: MachineRecord[] = [];
  existing.forEach((machine, index) => {
    if (consumedSeeds.has(index)) return;
    if (!machine.pinned && now - machine.lastSeenAt > retentionMs) {
      removed.push(machine.id);
      return;
    }
    untouched.push(machine);
  });

  return {
    machines: [...updated, ...untouched].sort(compareMachines),
    updated,
    removed,
  };
}

/* ── Probe collection ── */

/**
 * Terminal hosts as observed on *this* machine. A herdr or tmux probe can only
 * ever speak for the box it runs on, so the caller supplies that box's
 * identity rather than the probe pretending to know it.
 */
export async function collectLocalTerminalHostEvidence(input: {
  hostName?: string | null;
  nodeId?: string | null;
  observedAt?: number;
  maxAgeMs?: number;
} = {}): Promise<HostMachineEvidence[]> {
  const observedAt = input.observedAt ?? Date.now();
  const hostName = normalizeMachineHostName(input.hostName);
  const freshness = input.maxAgeMs === undefined ? undefined : { maxAgeMs: input.maxAgeMs };

  const [herdr, tmux, zellij] = await Promise.all([
    herdrSessionsProbe.for(null).fresh(freshness).catch(() => null),
    tmuxSessionsProbe.for({}).fresh(freshness).catch(() => null),
    zellijSessionsProbe.for({}).fresh(freshness).catch(() => null),
  ]);

  const evidence: HostMachineEvidence[] = [];
  const add = (
    host: MachineTerminalHost,
    sessions: readonly unknown[] | null | undefined,
    running: number,
    installed = false,
  ): void => {
    // A session list is the only unambiguous proof. Every one of these probes
    // answers `[]` for BOTH "not installed" and "installed but idle", so an
    // empty list alone must not mint a capability — a machine would claim tmux
    // and zellij and herdr purely for having none of them. `installed` is the
    // separate check that resolves the tie, when a caller paid for one.
    if (!sessions || (sessions.length === 0 && !installed)) return;
    evidence.push({
      kind: "host",
      observedAt,
      host,
      ...(hostName ? { hostName } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      sessionCount: sessions.length,
      runningSessionCount: running,
    });
  };

  // herdr is the host Scout integrates most deeply, so it is worth one `which`
  // to tell an idle install from an absent one. tmux and zellij settle for the
  // session list they already produced.
  const herdrSessions = herdr?.value ?? null;
  add(
    "herdr",
    herdrSessions,
    herdrSessions?.filter((session) => session.running).length ?? 0,
    herdrSessions?.length === 0 ? await isHerdrAvailable().catch(() => false) : false,
  );
  // Every session tmux lists is live — tmux has no notion of a stopped one.
  add("tmux", tmux?.value, tmux?.value?.length ?? 0);
  add("zellij", zellij?.value, zellij?.value?.filter((session) => session.state === "live").length ?? 0);

  return evidence;
}

export type CollectMachineEvidenceOptions = {
  nodes?: Readonly<Record<string, NodeDefinition>> | readonly NodeDefinition[];
  localNodeId?: string | null;
  localHostName?: string | null;
  /** Force a fresh scan rather than accepting whatever the probes have cached. */
  refresh?: boolean;
  includeTerminalHosts?: boolean;
};

/**
 * Read every source and shape it. `refresh` is the difference between "show me
 * the fleet" (cached, instant) and "go look again" (`scout machines scan`).
 */
export async function collectMachineEvidence(
  options: CollectMachineEvidenceOptions = {},
): Promise<MachineEvidence[]> {
  const observedAt = Date.now();
  if (options.refresh) lanScanProbe.invalidate("machines.scan");

  const [tailscale, lan, terminalHosts] = await Promise.all([
    // `fresh` without options honours the probe's own TTL, so a non-refresh
    // pass is still cheap. `read` would have returned null on a cold cache and
    // silently dropped the entire tailnet from the first pass after boot.
    tailscaleStatusProbe.fresh(options.refresh ? { maxAgeMs: 0 } : undefined)
      .then((snapshot) => snapshot.value)
      .catch(() => null),
    lanScanProbe.fresh(options.refresh ? { maxAgeMs: 0 } : undefined)
      .then((snapshot) => snapshot.value)
      .catch(() => null),
    options.includeTerminalHosts === false
      ? Promise.resolve([] as HostMachineEvidence[])
      : collectLocalTerminalHostEvidence({
        hostName: options.localHostName ?? null,
        nodeId: options.localNodeId ?? null,
        observedAt,
      }),
  ]);

  return buildMachineEvidence({
    ...(options.nodes ? { nodes: options.nodes } : {}),
    localNodeId: options.localNodeId ?? null,
    tailscale,
    lan,
    terminalHosts,
    observedAt,
  });
}

/* ── Lookup ── */

/**
 * Resolve an operator-typed machine reference: an id, a name, a hostname, or
 * an address. Exact id wins; after that the match must be unambiguous, because
 * silently picking one of two machines called `mini` is worse than saying so.
 */
export function resolveMachineReference(
  machines: readonly MachineRecord[],
  reference: string,
): { machine: MachineRecord } | { ambiguous: MachineRecord[] } | null {
  const raw = reference.trim();
  if (!raw) return null;

  const byId = machines.find((machine) => machine.id === raw);
  if (byId) return { machine: byId };

  const normalized = raw.toLowerCase();
  const host = normalizeMachineHostName(raw);
  const address = normalizeMachineAddress(raw);

  const matches = machines.filter((machine) => (
    machine.displayName?.trim().toLowerCase() === normalized
    || machine.name.toLowerCase() === normalized
    || (host !== "" && machine.hostNames.includes(host))
    || (address !== "" && machine.addresses.includes(address))
    || machine.scoutNodeId === raw
    || machine.tailnetId === raw
  ));

  if (matches.length === 1) return { machine: matches[0]! };
  if (matches.length > 1) return { ambiguous: matches };
  return null;
}
