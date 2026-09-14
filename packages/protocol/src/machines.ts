import type { AdvertiseScope, MetadataMap, ScoutId } from "./common.js";

/**
 * Machines — the physical (or virtual) boxes Scout knows about.
 *
 * A machine is NOT a node. A node is a Scout broker runtime; a machine is the
 * computer it runs on. The distinction matters because most machines Scout can
 * see are not running Scout at all: a tailnet peer, a Mac advertising itself on
 * the LAN, a Linux box that only answers ARP. Modelling them as nodes would
 * either invent fake nodes or make them invisible, and both were wrong.
 *
 * A machine record is assembled from **evidence**, never asserted. Four
 * channels report independently and none of them is authoritative:
 *
 * | channel   | tells us                                        |
 * | --------- | ----------------------------------------------- |
 * | `scout`   | a broker node lives here (id, mesh, urls)       |
 * | `tailnet` | reachable over Tailscale (stable peer id, IPs)  |
 * | `lan`     | seen on this network (mDNS advert, ARP neighbor)|
 * | `host`    | terminal hosts present (herdr, tmux, zellij)    |
 *
 * The join between them is `machineIdentityKeys` + `groupMachineEvidence`.
 * Everything else in this module is a pure derivation over a group, so the
 * whole model is testable without a network, a broker, or a database.
 */

export const MACHINE_ID_PREFIX = "mach-";

export type MachineEvidenceKind = "scout" | "tailnet" | "lan" | "host";

export type MachinePlatform =
  | "macos"
  | "linux"
  | "windows"
  | "ios"
  | "android"
  | "unknown";

/**
 * What a machine can do *for Scout*, as observed — never as configured. A
 * capability is present because something answered, so an operator reading
 * `herdr` on a row knows a herdr probe actually succeeded there.
 */
export type MachineCapability =
  | "scout-broker"
  | "scout-web"
  | "scout-pairing"
  | "herdr"
  | "tmux"
  | "zellij"
  | "ssh"
  | "vnc"
  | "smb"
  | "http";

export type MachineRouteKind = "loopback" | "lan" | "tailnet" | "mesh" | "relay";

/** One way to reach a machine. Ordered by preference in `deriveMachineRoutes`. */
export interface MachineRoute {
  kind: MachineRouteKind;
  host: string;
  port?: number;
  url?: string;
  lastSeenAt?: number;
}

export type MachineTerminalHost = "herdr" | "tmux" | "zellij";

export type LanDiscoveryMethod = "mdns" | "arp";

interface MachineEvidenceBase {
  kind: MachineEvidenceKind;
  observedAt: number;
}

/** A Scout broker node registered with, or discovered by, this broker. */
export interface ScoutMachineEvidence extends MachineEvidenceBase {
  kind: "scout";
  nodeId: ScoutId;
  meshId?: ScoutId;
  nodeName: string;
  hostName?: string;
  brokerUrl?: string;
  webUrl?: string;
  advertiseScope?: AdvertiseScope;
  tailnetName?: string;
  isSelf?: boolean;
}

/** A `tailscale status` peer (or self). Present whether or not it runs Scout. */
export interface TailnetMachineEvidence extends MachineEvidenceBase {
  kind: "tailnet";
  peerId: string;
  hostName?: string;
  dnsName?: string;
  tailnetName?: string;
  addresses: string[];
  online: boolean;
  os?: string;
  tags?: string[];
  isSelf?: boolean;
}

/** A local-network sighting: an mDNS service instance or an ARP neighbor. */
export interface LanMachineEvidence extends MachineEvidenceBase {
  kind: "lan";
  method: LanDiscoveryMethod;
  hostName?: string;
  instanceName?: string;
  /** Full service type as browsed, e.g. `_openscout._tcp`. */
  serviceType?: string;
  addresses: string[];
  port?: number;
  macAddress?: string;
  /** Best-effort OUI vendor. Null whenever the prefix is not in the table. */
  vendor?: string;
  interfaceName?: string;
  txt?: MetadataMap;
}

/** A terminal host observed on a machine Scout can probe. */
export interface HostMachineEvidence extends MachineEvidenceBase {
  kind: "host";
  host: MachineTerminalHost;
  /** Machine this was probed on — host probes are never self-identifying. */
  hostName?: string;
  nodeId?: ScoutId;
  sessionCount: number;
  runningSessionCount?: number;
  version?: string;
}

export type MachineEvidence =
  | ScoutMachineEvidence
  | TailnetMachineEvidence
  | LanMachineEvidence
  | HostMachineEvidence;

/**
 * Identity keys, split by how long they stay true.
 *
 * `durable` keys name the machine itself — a Tailscale node id, a MAC, a Scout
 * node id, a hostname. They are persisted with the record and re-join evidence
 * across passes, days apart.
 *
 * `transient` keys are only true right now. A LAN IP is the important one: it
 * is what joins an ARP row to an mDNS advert *inside one scan*, and it is
 * exactly what DHCP hands to a different machine next week. Persisting it
 * would silently fuse two machines, so it never leaves the pass that saw it.
 */
export interface MachineIdentityKeys {
  durable: string[];
  transient: string[];
}

const EMPTY_KEYS: MachineIdentityKeys = { durable: [], transient: [] };

/** mDNS service types Scout browses, and what each one proves. */
export const MACHINE_SERVICE_CAPABILITIES: Readonly<Record<string, MachineCapability>> = {
  "_openscout._tcp": "scout-broker",
  "_oscout-pair._tcp": "scout-pairing",
  "_ssh._tcp": "ssh",
  "_sftp-ssh._tcp": "ssh",
  "_rfb._tcp": "vnc",
  "_smb._tcp": "smb",
  "_http._tcp": "http",
};

/** Browsed for inventory. `_workstation._tcp` proves nothing but presence. */
export const MACHINE_LAN_SERVICE_TYPES: readonly string[] = [
  "_openscout._tcp",
  "_oscout-pair._tcp",
  "_ssh._tcp",
  "_workstation._tcp",
  "_rfb._tcp",
  "_smb._tcp",
];

/* ── Normalization ── */

/**
 * Reduce a host label to the machine's short name: `mini.local.` → `mini`,
 * `mini.tail1234.ts.net` → `mini`.
 *
 * Bonjour renames a colliding instance to `mini (2)` or `mini-2.local`, and
 * both must fold back to `mini` or one machine becomes two. The numeric form
 * is only stripped for a `.local` name — a machine genuinely called `node-1`
 * must keep its digit, which is the same rule
 * `stripBonjourCollisionSuffix` follows in the runtime.
 */
/**
 * Host names that every machine can answer to and therefore identify none of
 * them. iOS devices report `localhost` as their Tailscale host name, so
 * treating this as identity fuses an iPhone and an iPad into one record.
 */
const NON_IDENTIFYING_HOST_NAMES = new Set(["localhost", "ip6-localhost", "unknown", "android"]);

export function normalizeMachineHostName(value: string | null | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withoutTrailingDot = raw.replace(/\.+$/, "");
  const isMdnsName = /\.local$/.test(withoutTrailingDot);
  const firstLabel = (withoutTrailingDot.split(".")[0] ?? "").replace(/\s*\(\d+\)$/, "").trim();
  // A machine that has re-registered hundreds of times carries a suffix to
  // match: `Arts-Mac-mini-769.local` and `Arts-Mac-mini-612.local` are one Mac,
  // and capping at two digits left 25 of them as 25 machines.
  const name = isMdnsName ? firstLabel.replace(/-\d{1,4}$/, "") : firstLabel;
  return NON_IDENTIFYING_HOST_NAMES.has(name) ? "" : name;
}

/**
 * Lowercase colon-form MAC. Returns "" for entries that identify nothing —
 * broadcast, all-zero, or an incomplete ARP row.
 *
 * BSD `arp` drops leading zeros (`3c:22:fb:1:2:3`), so octets are padded
 * rather than the string being scrubbed of separators: scrubbing turns that
 * nine-character form into a rejected MAC instead of a valid one.
 */
export function normalizeMacAddress(value: string | null | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";

  const groups = raw.split(/[:-]/);
  const octets = groups.length === 6
    ? groups.map((group) => (/^[0-9a-f]{1,2}$/.test(group) ? group.padStart(2, "0") : ""))
    : (raw.replace(/[^0-9a-f]/g, "").match(/.{2}/g) ?? []);

  if (octets.length !== 6 || octets.some((octet) => !/^[0-9a-f]{2}$/.test(octet))) return "";
  const joined = octets.join(":");
  if (joined === "00:00:00:00:00:00") return "";
  // The low bit of the first octet is the I/G bit: when it is set the address
  // is a group (multicast or broadcast) destination, never a station address.
  // Real ARP tables are full of these — `01:00:5e:00:00:fb` is mDNS, not a
  // machine — and treating one as identity would mint a phantom neighbour on
  // every network Scout ever sees.
  if ((Number.parseInt(octets[0] ?? "0", 16) & 0x01) === 1) return "";
  return joined;
}

export function normalizeMachineAddress(value: string | null | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  return raw.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "");
}

export function isLoopbackAddress(value: string): boolean {
  const address = normalizeMachineAddress(value);
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

/** Tailscale's CGNAT range (100.64.0.0/10) and its IPv6 ULA prefix. */
export function isTailnetAddress(value: string): boolean {
  const address = normalizeMachineAddress(value);
  if (address.startsWith("fd7a:115c:a1e0")) return true;
  const octets = address.split(".");
  if (octets.length !== 4) return false;
  const first = Number.parseInt(octets[0] ?? "", 10);
  const second = Number.parseInt(octets[1] ?? "", 10);
  return first === 100 && second >= 64 && second <= 127;
}

/* ── Identity ── */

function pushUnique<T>(target: T[], value: T | null | undefined): void {
  if (value === null || value === undefined || value === "") return;
  if (!target.includes(value)) target.push(value);
}

const pushKey = pushUnique<string>;

/**
 * The keys one piece of evidence claims. Two pieces of evidence describe the
 * same machine when they share any key — see `groupMachineEvidence`.
 */
export function machineIdentityKeys(evidence: MachineEvidence): MachineIdentityKeys {
  const durable: string[] = [];
  const transient: string[] = [];

  switch (evidence.kind) {
    case "scout": {
      pushKey(durable, `node:${evidence.nodeId}`);
      const host = normalizeMachineHostName(evidence.hostName)
        || normalizeMachineHostName(evidence.nodeName);
      if (host) pushKey(durable, `host:${host}`);
      return { durable, transient };
    }
    case "tailnet": {
      pushKey(durable, `tailnet:${evidence.peerId}`);
      const host = normalizeMachineHostName(evidence.hostName)
        || normalizeMachineHostName(evidence.dnsName);
      if (host) pushKey(durable, `host:${host}`);
      // A tailnet address is assigned by the coordination server and stays with
      // the node, so unlike a LAN address it is safe to keep.
      for (const address of evidence.addresses) {
        const normalized = normalizeMachineAddress(address);
        if (!normalized) continue;
        if (isTailnetAddress(normalized)) pushKey(durable, `ip:${normalized}`);
        else pushKey(transient, `ip:${normalized}`);
      }
      return { durable, transient };
    }
    case "lan": {
      const mac = normalizeMacAddress(evidence.macAddress);
      if (mac) pushKey(durable, `mac:${mac}`);
      const host = normalizeMachineHostName(evidence.hostName)
        || normalizeMachineHostName(evidence.instanceName);
      if (host) pushKey(durable, `host:${host}`);
      for (const address of evidence.addresses) {
        const normalized = normalizeMachineAddress(address);
        if (!normalized || isLoopbackAddress(normalized)) continue;
        if (isTailnetAddress(normalized)) pushKey(durable, `ip:${normalized}`);
        else pushKey(transient, `ip:${normalized}`);
      }
      return { durable, transient };
    }
    case "host": {
      if (evidence.nodeId) pushKey(durable, `node:${evidence.nodeId}`);
      const host = normalizeMachineHostName(evidence.hostName);
      if (host) pushKey(durable, `host:${host}`);
      return { durable, transient };
    }
    default:
      return EMPTY_KEYS;
  }
}

export interface MachineEvidenceGroup {
  /** Durable keys only — what gets persisted so the next pass re-joins here. */
  identityKeys: string[];
  evidence: MachineEvidence[];
  /**
   * Indices of every seed this group attached to, ascending. More than one
   * means fresh evidence proved two records were always the same machine —
   * the first is the survivor, the rest are absorbed by the caller.
   */
  seedIndices: number[];
}

/**
 * Union-find over identity keys. Evidence lands in the same group when it
 * shares any key, directly or through a chain — an ARP row and an mDNS advert
 * share an IP; the advert and a tailnet peer share a hostname; so all three
 * describe one machine even though ARP and Tailscale share nothing at all.
 *
 * `seeds` are the durable key sets of machines already on record. They enter
 * the union as members, which is what lets a machine seen only by ARP today
 * and only by Tailscale tomorrow stay one record: the seed bridges the passes.
 */
export function groupMachineEvidence(
  evidence: readonly MachineEvidence[],
  seeds: readonly (readonly string[])[] = [],
): MachineEvidenceGroup[] {
  const parent: number[] = [];
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  // Members: seeds first (so a seed's slot index is its own), then evidence.
  const memberKeys: MachineIdentityKeys[] = [];
  for (const seed of seeds) {
    parent.push(parent.length);
    memberKeys.push({ durable: [...seed], transient: [] });
  }
  const evidenceOffset = memberKeys.length;
  for (const item of evidence) {
    parent.push(parent.length);
    memberKeys.push(machineIdentityKeys(item));
  }

  const owners = new Map<string, number>();
  memberKeys.forEach((keys, index) => {
    for (const key of [...keys.durable, ...keys.transient]) {
      const existing = owners.get(key);
      if (existing === undefined) owners.set(key, index);
      else union(existing, index);
    }
  });

  const groups = new Map<number, MachineEvidenceGroup>();
  const groupOrder: number[] = [];
  const ensureGroup = (root: number): MachineEvidenceGroup => {
    const existing = groups.get(root);
    if (existing) return existing;
    const created: MachineEvidenceGroup = { identityKeys: [], evidence: [], seedIndices: [] };
    groups.set(root, created);
    groupOrder.push(root);
    return created;
  };

  memberKeys.forEach((keys, index) => {
    const group = ensureGroup(find(index));
    for (const key of keys.durable) pushKey(group.identityKeys, key);
    if (index < evidenceOffset) group.seedIndices.push(index);
    else group.evidence.push(evidence[index - evidenceOffset]!);
  });

  return groupOrder
    .map((root) => groups.get(root)!)
    // A seed with no fresh evidence is a machine nobody saw this pass. It stays
    // on record (the caller keeps it), but it is not a result of this scan.
    .filter((group) => group.evidence.length > 0)
    .map((group) => ({
      ...group,
      identityKeys: [...group.identityKeys].sort(),
      // Ascending, so the lowest-indexed record is the stable survivor of a merge.
      seedIndices: [...group.seedIndices].sort((a, b) => a - b),
    }));
}

/**
 * Deterministic id from a group's durable keys, so two brokers observing the
 * same machine mint the same id and a restart never renumbers the fleet.
 * FNV-1a ×2, matching `stableChannelId`.
 */
export function stableMachineId(identityKeys: readonly string[]): ScoutId {
  const normalized = [...identityKeys].map((key) => key.trim().toLowerCase()).sort().join("|");
  const hash = (seed: bigint): string => {
    let value = seed;
    for (let index = 0; index < normalized.length; index += 1) {
      value ^= BigInt(normalized.charCodeAt(index));
      value = BigInt.asUintN(64, value * 0x100000001b3n);
    }
    return value.toString(16).padStart(16, "0");
  };
  return `${MACHINE_ID_PREFIX}${hash(0xcbf29ce484222325n)}${hash(0x84222325cbf29ce4n)}`;
}

/* ── Derivations over a group ── */

function evidenceOf<K extends MachineEvidence["kind"]>(
  evidence: readonly MachineEvidence[],
  kind: K,
): Extract<MachineEvidence, { kind: K }>[] {
  return evidence.filter((item): item is Extract<MachineEvidence, { kind: K }> => item.kind === kind);
}

/**
 * The name to show. Scout's own name for the node wins because the operator
 * chose it; then the tailnet hostname, then whatever the LAN advertised. A
 * machine known only by MAC gets its MAC, never a fabricated label.
 */
export function deriveMachineName(evidence: readonly MachineEvidence[]): string {
  for (const scout of evidenceOf(evidence, "scout")) {
    // A node name is a host name — `Arts-Mac-mini-534.local`, suffix and all —
    // so it goes through the same normalizer rather than straight to the UI.
    const name = normalizeMachineHostName(scout.nodeName) || normalizeMachineHostName(scout.hostName);
    if (name) return name;
  }

  const tailnet = evidenceOf(evidence, "tailnet")
    .sort((a, b) => Number(b.online) - Number(a.online))[0];
  const tailnetName = normalizeMachineHostName(tailnet?.hostName)
    || normalizeMachineHostName(tailnet?.dnsName);
  if (tailnetName) return tailnetName;

  for (const lan of evidenceOf(evidence, "lan")) {
    const name = normalizeMachineHostName(lan.hostName) || normalizeMachineHostName(lan.instanceName);
    if (name) return name;
  }

  // A terminal host names the machine it was probed on. Weaker than a node or
  // a tailnet peer, but far better than falling through to a bare MAC for a
  // box we are literally running sessions on.
  for (const host of evidenceOf(evidence, "host")) {
    const name = normalizeMachineHostName(host.hostName);
    if (name) return name;
  }

  const mac = evidenceOf(evidence, "lan")
    .map((lan) => normalizeMacAddress(lan.macAddress))
    .find(Boolean);
  if (mac) return mac;

  const address = evidenceOf(evidence, "lan")
    .flatMap((lan) => lan.addresses.map(normalizeMachineAddress))
    .find((value) => value && !isLoopbackAddress(value));
  return address || "unknown";
}

const TAILSCALE_OS_PLATFORMS: Readonly<Record<string, MachinePlatform>> = {
  macos: "macos",
  macOS: "macos",
  darwin: "macos",
  linux: "linux",
  windows: "windows",
  ios: "ios",
  iOS: "ios",
  android: "android",
};

export function deriveMachinePlatform(evidence: readonly MachineEvidence[]): MachinePlatform {
  for (const tailnet of evidenceOf(evidence, "tailnet")) {
    const os = (tailnet.os ?? "").trim();
    const platform = TAILSCALE_OS_PLATFORMS[os] ?? TAILSCALE_OS_PLATFORMS[os.toLowerCase()];
    if (platform) return platform;
  }
  // Only Apple platforms publish `_rfb._tcp` alongside `_ssh._tcp` by default
  // on a stock install, but that is a guess, not proof — keep it to the
  // Bonjour `model` TXT key, which Apple devices set and others do not.
  for (const lan of evidenceOf(evidence, "lan")) {
    const model = String(lan.txt?.model ?? "").trim();
    if (/^(mac|imac|macbook|macmini|macpro|macstudio)/i.test(model)) return "macos";
  }
  return "unknown";
}

export function deriveMachineCapabilities(
  evidence: readonly MachineEvidence[],
): MachineCapability[] {
  const capabilities: MachineCapability[] = [];

  for (const scout of evidenceOf(evidence, "scout")) {
    if (scout.brokerUrl) pushUnique(capabilities, "scout-broker");
    if (scout.webUrl) pushUnique(capabilities, "scout-web");
  }
  for (const lan of evidenceOf(evidence, "lan")) {
    pushUnique(capabilities, lan.serviceType ? MACHINE_SERVICE_CAPABILITIES[lan.serviceType] : null);
  }
  for (const host of evidenceOf(evidence, "host")) {
    pushUnique(capabilities, host.host);
  }

  return capabilities.sort();
}

/**
 * Routes, best first: loopback (it's this machine), then LAN (no hop), then
 * tailnet, then whatever the mesh advertised. This is the order a caller
 * should dial, and it mirrors the LAN-first preference iOS already uses.
 */
/**
 * Every way we know to reach this machine, best first. `isSelf` decides whether
 * loopback belongs at all: a peer advertising `http://127.0.0.1:43120` is
 * describing its own loopback, which is not a route to it from here.
 */
export function deriveMachineRoutes(
  evidence: readonly MachineEvidence[],
  isSelf = false,
): MachineRoute[] {
  const routes: MachineRoute[] = [];
  const seen = new Set<string>();
  const add = (route: MachineRoute): void => {
    const key = `${route.kind}|${route.host}|${route.port ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(route);
  };

  for (const scout of evidenceOf(evidence, "scout")) {
    for (const url of [scout.brokerUrl, scout.webUrl]) {
      if (!url) continue;
      try {
        const parsed = new URL(url);
        const host = normalizeMachineAddress(parsed.hostname);
        const port = parsed.port ? Number.parseInt(parsed.port, 10) : undefined;
        const kind: MachineRouteKind = isLoopbackAddress(host)
          ? "loopback"
          : isTailnetAddress(host)
            ? "tailnet"
            : "mesh";
        add({ kind, host, ...(port ? { port } : {}), url, lastSeenAt: scout.observedAt });
      } catch {
        // A malformed advertised URL is the peer's problem, not a reason to
        // drop every other route this machine has.
      }
    }
  }

  for (const lan of evidenceOf(evidence, "lan")) {
    for (const address of lan.addresses) {
      const host = normalizeMachineAddress(address);
      if (!host || isLoopbackAddress(host)) continue;
      add({
        kind: isTailnetAddress(host) ? "tailnet" : "lan",
        host,
        ...(lan.port ? { port: lan.port } : {}),
        lastSeenAt: lan.observedAt,
      });
    }
  }

  for (const tailnet of evidenceOf(evidence, "tailnet")) {
    for (const address of tailnet.addresses) {
      const host = normalizeMachineAddress(address);
      if (!host) continue;
      add({ kind: "tailnet", host, lastSeenAt: tailnet.observedAt });
    }
    const dnsName = (tailnet.dnsName ?? "").trim().replace(/\.+$/, "");
    if (dnsName) add({ kind: "tailnet", host: dnsName, lastSeenAt: tailnet.observedAt });
  }

  const order: Record<MachineRouteKind, number> = {
    lan: 0,
    tailnet: 1,
    mesh: 2,
    relay: 3,
    // Last, not first: `127.0.0.1` only reaches the machine you are already on.
    // A dozen peers each advertising `http://127.0.0.1:43120` made loopback the
    // headline address for machines it cannot reach at all.
    loopback: 4,
  };
  return routes
    .filter((route) => isSelf || route.kind !== "loopback")
    .sort((a, b) => order[a.kind] - order[b.kind]);
}

/* ── The record ── */

export type MachinePresence = "online" | "recent" | "offline";

/** Anything seen inside this window counts as present. */
export const MACHINE_ONLINE_WINDOW_MS = 2 * 60_000;
export const MACHINE_RECENT_WINDOW_MS = 60 * 60_000;

export interface MachineRecord {
  id: ScoutId;
  /** Operator-set name. Null means "use `name`". */
  displayName: string | null;
  /** Derived from the strongest evidence — recomputed every pass. */
  name: string;
  platform: MachinePlatform;
  /** Durable keys, sorted. The join key set for the next pass. */
  identityKeys: string[];
  isSelf: boolean;
  scoutNodeId?: ScoutId;
  meshId?: ScoutId;
  tailnetId?: string;
  tailnetName?: string;
  hostNames: string[];
  addresses: string[];
  macAddresses: string[];
  capabilities: MachineCapability[];
  routes: MachineRoute[];
  evidence: MachineEvidence[];
  /** Operator marked it worth keeping even when nothing has seen it in weeks. */
  pinned: boolean;
  notes?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  metadata?: MetadataMap;
}

export function machineLabel(machine: Pick<MachineRecord, "displayName" | "name">): string {
  return machine.displayName?.trim() || machine.name;
}

export function machinePresence(
  machine: Pick<MachineRecord, "lastSeenAt">,
  now: number = Date.now(),
): MachinePresence {
  const age = now - machine.lastSeenAt;
  if (age <= MACHINE_ONLINE_WINDOW_MS) return "online";
  if (age <= MACHINE_RECENT_WINDOW_MS) return "recent";
  return "offline";
}

/**
 * Build (or rebuild) a record from a group. `previous` carries the parts an
 * operator owns — id, chosen name, notes, pin, first-seen — which no amount of
 * fresh evidence may overwrite.
 */
export function buildMachineRecord(
  group: MachineEvidenceGroup,
  previous?: Partial<MachineRecord> | null,
): MachineRecord {
  const evidence = [...group.evidence].sort((a, b) => a.observedAt - b.observedAt);
  const observedAt = evidence.reduce((latest, item) => Math.max(latest, item.observedAt), 0);

  const scout = evidenceOf(evidence, "scout")[0];
  const tailnet = evidenceOf(evidence, "tailnet")
    .sort((a, b) => Number(b.online) - Number(a.online))[0];

  const hostNames: string[] = [];
  const addresses: string[] = [];
  const macAddresses: string[] = [];
  for (const key of group.identityKeys) {
    const [prefix, ...rest] = key.split(":");
    const value = rest.join(":");
    if (prefix === "host") pushKey(hostNames, value);
    else if (prefix === "ip") pushKey(addresses, value);
    else if (prefix === "mac") pushKey(macAddresses, value);
  }
  for (const item of evidence) {
    if (item.kind === "lan" || item.kind === "tailnet") {
      for (const address of item.addresses) {
        const normalized = normalizeMachineAddress(address);
        if (normalized && !isLoopbackAddress(normalized)) pushKey(addresses, normalized);
      }
    }
  }

  const isSelf = evidence.some((item) => (
    (item.kind === "scout" || item.kind === "tailnet") && item.isSelf === true
  ));

  return {
    id: previous?.id ?? stableMachineId(group.identityKeys),
    displayName: previous?.displayName ?? null,
    name: deriveMachineName(evidence),
    platform: deriveMachinePlatform(evidence),
    identityKeys: group.identityKeys,
    isSelf,
    ...(scout?.nodeId ? { scoutNodeId: scout.nodeId } : {}),
    ...(scout?.meshId ? { meshId: scout.meshId } : {}),
    ...(tailnet?.peerId ? { tailnetId: tailnet.peerId } : {}),
    ...(tailnet?.tailnetName ?? scout?.tailnetName
      ? { tailnetName: tailnet?.tailnetName ?? scout?.tailnetName }
      : {}),
    hostNames,
    addresses,
    macAddresses,
    capabilities: deriveMachineCapabilities(evidence),
    routes: deriveMachineRoutes(evidence, isSelf),
    evidence,
    pinned: previous?.pinned ?? false,
    ...(previous?.notes ? { notes: previous.notes } : {}),
    firstSeenAt: previous?.firstSeenAt ?? observedAt,
    lastSeenAt: Math.max(observedAt, previous?.lastSeenAt ?? 0),
    ...(previous?.metadata ? { metadata: previous.metadata } : {}),
  };
}

/** Sort for display: this machine, then present ones, then by name. */
export function compareMachines(a: MachineRecord, b: MachineRecord): number {
  if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
  if (a.lastSeenAt !== b.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
  return machineLabel(a).localeCompare(machineLabel(b));
}
