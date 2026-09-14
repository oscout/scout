// Local-network inventory: what this machine can see on the network it is
// plugged into, without sending a single packet at a machine that did not
// already announce itself or answer for its own address.
//
// Two passive sources, deliberately:
//
//   mDNS browse — every machine that publishes a Bonjour service tells us its
//   instance name, host, addresses and TXT record. This is how a Mac running
//   Scout, a NAS offering SMB, or anything with Remote Login on gets found.
//
//   ARP/neighbor table — the kernel's own record of who answered for an
//   address on this segment. It carries no name, but it carries the MAC, which
//   is the only durable identity a silent machine has. It is a *read of local
//   state*: nothing is transmitted to obtain it.
//
// What this deliberately does NOT do is sweep the subnet. Pinging every address
// in a /24 and knocking on ports is traffic aimed at machines the operator may
// not own, on networks (cafés, offices, hotels) where it is at best rude and at
// worst reportable. If that is ever wanted it belongs behind an explicit,
// per-invocation flag — never on a background probe like this one.
//
// Both sources run under the SCO-077 probe registry, so N surfaces asking for
// the machine list share one scan instead of each spawning their own.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import {
  MACHINE_LAN_SERVICE_TYPES,
  normalizeMacAddress,
  normalizeMachineAddress,
} from "@openscout/protocol";

import type { RuntimeEnv } from "../portable-types.js";
import { execProbeFile, ProbeCommandError } from "./exec.js";
import { defineProbe, type ProbeCtx } from "./registry.js";

const require = createRequire(import.meta.url);

// Structural mDNS surface, redeclared rather than imported. `mesh-mdns-service`
// owns the advertising half, but it reaches into the broker process manager,
// and probes stay leaves — every consumer of `system-probes` would otherwise
// pull the broker's sqlite adapter and spawn machinery in behind this scan.
export type LanMdnsAdvertisement = {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
};

export type LanMdnsBrowserHandle = { stop(): void };

export type LanMdnsResponder = {
  find(
    options: { type: string; protocol: "tcp" | "udp" },
    onup?: (service: LanMdnsAdvertisement) => void,
  ): LanMdnsBrowserHandle;
  destroy(callback?: () => void): void;
};

/** How long the browser listens before the snapshot closes. */
const DEFAULT_BROWSE_MS = 2_500;
const LAN_SCAN_TTL_MS = 60_000;
const LAN_SCAN_TIMEOUT_MS = 10_000;

export type LanServiceAdvert = {
  /** Full type as browsed, e.g. `_openscout._tcp`. */
  serviceType: string;
  instanceName: string;
  host: string | null;
  addresses: string[];
  port: number | null;
  txt: Record<string, string>;
};

export type LanNeighbor = {
  address: string;
  macAddress: string;
  interfaceName: string | null;
  /** Curated OUI lookup; null whenever the prefix is not in the table. */
  vendor: string | null;
};

export type LanScanSnapshot = {
  services: LanServiceAdvert[];
  neighbors: LanNeighbor[];
  browsedTypes: string[];
  /** False when mDNS is off (`OPENSCOUT_MDNS_ENABLED=0`) — services is then empty by policy, not by absence. */
  mdnsEnabled: boolean;
  scannedAt: number;
};

export const EMPTY_LAN_SCAN: LanScanSnapshot = {
  services: [],
  neighbors: [],
  browsedTypes: [],
  mdnsEnabled: false,
  scannedAt: 0,
};

/**
 * A deliberately small OUI table. A complete IEEE registry is ~30k rows and
 * would be stale the day it shipped; the point here is to label the handful of
 * vendors that actually show up on a developer's network so a bare MAC has
 * *some* handle. Anything else honestly reports null rather than guessing.
 */
const OUI_VENDORS: Readonly<Record<string, string>> = {
  "00:03:93": "Apple",
  "00:05:02": "Apple",
  "00:0a:27": "Apple",
  "00:0a:95": "Apple",
  "00:17:f2": "Apple",
  "00:1b:63": "Apple",
  "00:1e:c2": "Apple",
  "00:25:00": "Apple",
  "00:26:bb": "Apple",
  "3c:22:fb": "Apple",
  "40:6c:8f": "Apple",
  "5c:f9:38": "Apple",
  "6c:40:08": "Apple",
  "7c:d1:c3": "Apple",
  "88:66:5a": "Apple",
  "a4:83:e7": "Apple",
  "ac:de:48": "Apple",
  "b8:e8:56": "Apple",
  "f0:18:98": "Apple",
  "f4:d4:88": "Apple",
  "b8:27:eb": "Raspberry Pi",
  "dc:a6:32": "Raspberry Pi",
  "e4:5f:01": "Raspberry Pi",
  "d8:3a:dd": "Raspberry Pi",
  "00:1b:21": "Intel",
  "00:1e:67": "Intel",
  "3c:fd:fe": "Intel",
  "a0:36:9f": "Intel",
  "24:0a:c4": "Espressif",
  "7c:9e:bd": "Espressif",
  "24:5a:4c": "Ubiquiti",
  "78:8a:20": "Ubiquiti",
  "fc:ec:da": "Ubiquiti",
  "00:11:32": "Synology",
  "00:1d:0f": "TP-Link",
  "00:50:56": "VMware",
  "08:00:27": "VirtualBox",
  "52:54:00": "QEMU/KVM",
  "00:16:3e": "Xen",
};

/**
 * A vendor for a MAC, or null. Randomized addresses — iOS/Android private
 * Wi-Fi MACs, most cloud NICs — carry a locally administered prefix that maps
 * to no registered vendor and correctly falls through to null here.
 */
export function lookupOuiVendor(macAddress: string): string | null {
  const normalized = normalizeMacAddress(macAddress);
  if (!normalized) return null;
  return OUI_VENDORS[normalized.slice(0, 8)] ?? null;
}

/* ── ARP / neighbor table ── */

/**
 * Parse `arp -an`. The BSD and Linux spellings differ in where the interface
 * and link-type fields land, so both shapes are matched off the same anchor:
 * `(address) at <mac>`.
 *
 *   BSD:   ? (192.168.1.23) at 3c:22:fb:1:2:3 on en0 ifscope [ethernet]
 *   Linux: ? (192.168.1.23) at 3c:22:fb:01:02:03 [ether] on eth0
 *   Either: ? (192.168.1.99) at (incomplete) on en0
 */
export function parseArpTable(stdout: string): LanNeighbor[] {
  const neighbors: LanNeighbor[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const match = line.match(/\(([^)]+)\)\s+at\s+([^\s]+)/);
    if (!match) continue;

    const address = normalizeMachineAddress(match[1]);
    const macAddress = normalizeMacAddress(match[2]);
    if (!address || !macAddress) continue;

    const key = `${address}|${macAddress}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const interfaceMatch = line.match(/\bon\s+([a-z0-9._-]+)/i);
    neighbors.push({
      address,
      macAddress,
      interfaceName: interfaceMatch?.[1] ?? null,
      vendor: lookupOuiVendor(macAddress),
    });
  }

  return neighbors;
}

function arpBin(env: RuntimeEnv = process.env): string {
  return env.OPENSCOUT_ARP_BIN?.trim() || "arp";
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ProbeCommandError
    && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit");
}

async function readArpNeighbors(ctx: ProbeCtx, env: RuntimeEnv): Promise<LanNeighbor[]> {
  try {
    const { stdout } = await execProbeFile(ctx, arpBin(env), ["-an"], {
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 32 * 1024,
    });
    return parseArpTable(stdout);
  } catch (error) {
    // No `arp` (a slim container, Windows) is a missing source, not a failed
    // scan — the mDNS half still has something to say.
    if (isUnavailable(error)) return [];
    throw error;
  }
}

/* ── mDNS browse: darwin (`dns-sd`) ── */

// On macOS, mDNSResponder owns port 5353 and no other process gets to receive
// on it, so `bonjour-service` browses into silence — verified against a network
// where `dns-sd -B` returned four services instantly and the library returned
// none. Apple's own `dns-sd` is the only client that works here, and it ships
// with the OS.
//
// `-Z` is the useful mode: one process per service type dumps every instance's
// SRV (target host + port) and TXT in zone-file form, where `-B` alone gives
// instance names with no way to reach them.

const DNS_SD_BIN = "/usr/bin/dns-sd";

/** `Arts\032Mini` → `Arts Mini`. dns-sd escapes with decimal byte codes. */
function unescapeDnsSdLabel(value: string): string {
  return value.replace(/\\(\d{3}|.)/g, (_match, escape: string) => (
    /^\d{3}$/.test(escape) ? String.fromCharCode(Number.parseInt(escape, 10)) : escape
  ));
}

export function parseDnsSdZoneDump(stdout: string, serviceType: string): LanServiceAdvert[] {
  const suffix = `.${serviceType.replace(/^_?/, "_")}`;
  const byInstance = new Map<string, LanServiceAdvert>();

  const advertFor = (rawName: string): LanServiceAdvert | null => {
    if (!rawName.endsWith(suffix)) return null;
    const instanceName = unescapeDnsSdLabel(rawName.slice(0, -suffix.length));
    if (!instanceName) return null;
    const existing = byInstance.get(instanceName);
    if (existing) return existing;
    const created: LanServiceAdvert = {
      serviceType,
      instanceName,
      host: null,
      addresses: [],
      port: null,
      txt: {},
    };
    byInstance.set(instanceName, created);
    return created;
  };

  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(SRV|TXT)\s+(.*)$/);
    if (!match) continue;
    const advert = advertFor(match[1] ?? "");
    if (!advert) continue;

    if (match[2] === "SRV") {
      // `0 0 7000 arts-mini-2.local. ; Replace with unicast FQDN…`
      const parts = (match[3] ?? "").split(";")[0]!.trim().split(/\s+/);
      const port = Number.parseInt(parts[2] ?? "", 10);
      const target = (parts[3] ?? "").replace(/\.$/, "");
      if (Number.isFinite(port) && port > 0) advert.port = port;
      if (target) advert.host = target;
      continue;
    }

    for (const pair of (match[3] ?? "").matchAll(/"([^"]*)"/g)) {
      const entry = pair[1] ?? "";
      const equals = entry.indexOf("=");
      if (equals <= 0) continue;
      advert.txt[entry.slice(0, equals)] = entry.slice(equals + 1);
    }
  }

  return [...byInstance.values()];
}

/**
 * Run a browse for a fixed window, then stop it and keep whatever answered.
 * mDNS has no "done", so `dns-sd` never exits on its own — and `execProbeFile`
 * cannot express this, because it discards stdout when it aborts.
 */
function runBoundedBrowse(
  file: string,
  args: readonly string[],
  windowMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      if (!child.killed) child.kill("SIGTERM");
      resolve(stdout);
    };

    const timer = setTimeout(finish, windowMs);
    signal?.addEventListener("abort", finish, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk}`;
      // A chatty network must not become an unbounded string.
      if (stdout.length > 512 * 1024) finish();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      reject(error);
    });
    child.once("exit", finish);
  });
}

export async function browseLanServicesViaDnsSd(options: {
  serviceTypes?: readonly string[];
  browseMs?: number;
  signal?: AbortSignal;
  bin?: string;
} = {}): Promise<LanServiceAdvert[]> {
  const serviceTypes = options.serviceTypes ?? MACHINE_LAN_SERVICE_TYPES;
  const browseMs = options.browseMs ?? DEFAULT_BROWSE_MS;
  const bin = options.bin ?? DNS_SD_BIN;

  // One process per type, all in the same window rather than in series.
  const dumps = await Promise.all(serviceTypes.map((serviceType) => (
    runBoundedBrowse(bin, ["-Z", serviceType, "local"], browseMs, options.signal)
      .then((stdout) => parseDnsSdZoneDump(stdout, serviceType))
      .catch(() => [] as LanServiceAdvert[])
  )));

  return dumps.flat();
}

/* ── mDNS browse: everything else (`bonjour-service`) ── */

export function normalizeServiceAdvert(
  serviceType: string,
  advertisement: LanMdnsAdvertisement,
): LanServiceAdvert {
  const txt: Record<string, string> = {};
  for (const [key, value] of Object.entries(advertisement.txt ?? {})) {
    if (typeof value === "string") txt[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") txt[key] = String(value);
    else if (value instanceof Uint8Array) txt[key] = Buffer.from(value).toString("utf8");
  }

  const addresses: string[] = [];
  for (const address of advertisement.addresses ?? []) {
    const normalized = normalizeMachineAddress(address);
    // Link-local v6 (fe80::) is per-interface and never routable from here.
    if (normalized && !normalized.startsWith("fe80:") && !addresses.includes(normalized)) {
      addresses.push(normalized);
    }
  }

  return {
    serviceType,
    instanceName: advertisement.name ?? "",
    host: advertisement.host ?? null,
    addresses,
    port: typeof advertisement.port === "number" ? advertisement.port : null,
    txt,
  };
}

export type LanMdnsResponderFactory = () => LanMdnsResponder;

function defaultResponderFactory(): LanMdnsResponder {
  // bonjour-service is CommonJS (`export =`), loaded the same way the mesh
  // mDNS service loads it.
  const Bonjour = require("bonjour-service") as new () => LanMdnsResponder;
  return new Bonjour();
}

export type BrowseLanServicesOptions = {
  serviceTypes?: readonly string[];
  browseMs?: number;
  responderFactory?: LanMdnsResponderFactory;
  signal?: AbortSignal;
};

/**
 * Browse every service type once and close. The browser is inherently
 * open-ended — there is no "done" in mDNS — so the snapshot is whatever
 * answered inside the window. The responder is always destroyed, including on
 * abort, because a leaked one holds a multicast socket for the life of the
 * process.
 */
export async function browseLanServices(
  options: BrowseLanServicesOptions = {},
): Promise<LanServiceAdvert[]> {
  const serviceTypes = options.serviceTypes ?? MACHINE_LAN_SERVICE_TYPES;
  const browseMs = options.browseMs ?? DEFAULT_BROWSE_MS;
  const responder = (options.responderFactory ?? defaultResponderFactory)();

  const found = new Map<string, LanServiceAdvert>();
  const browsers: Array<{ stop(): void }> = [];

  try {
    for (const serviceType of serviceTypes) {
      const parsed = serviceType.match(/^_?([^.]+)\._(tcp|udp)$/);
      if (!parsed) continue;
      const browser = responder.find(
        { type: parsed[1]!, protocol: parsed[2] as "tcp" | "udp" },
        (advertisement) => {
          const advert = normalizeServiceAdvert(serviceType, advertisement);
          const key = `${serviceType}|${advert.instanceName}|${advert.host ?? ""}`;
          // Later answers carry more resolved addresses; keep the fuller one.
          const existing = found.get(key);
          if (!existing || advert.addresses.length >= existing.addresses.length) {
            found.set(key, advert);
          }
        },
      );
      browsers.push(browser);
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, browseMs);
      function finish(): void {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", finish);
        resolve();
      }
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  } finally {
    for (const browser of browsers) {
      try {
        browser.stop();
      } catch {
        // A browser that already tore itself down must not mask the results.
      }
    }
    try {
      responder.destroy();
    } catch {
      // Same: the snapshot is already collected.
    }
  }

  return [...found.values()].sort((a, b) => (
    a.serviceType.localeCompare(b.serviceType) || a.instanceName.localeCompare(b.instanceName)
  ));
}

/* ── The probe ── */

function isOff(value: string | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

/** `OPENSCOUT_LAN_SCAN_ENABLED=0` opts this machine out of LAN inventory. */
export function lanScanEnabled(env: RuntimeEnv = process.env): boolean {
  return !isOff(env.OPENSCOUT_LAN_SCAN_ENABLED);
}

/**
 * The browse half honors the same laptop toggle as the mesh advert
 * (`meshMdnsEnabled` in mesh-mdns-service.ts): a node opted out of mDNS should
 * not be listening on multicast either.
 */
export function lanMdnsBrowseEnabled(env: RuntimeEnv = process.env): boolean {
  return !isOff(env.OPENSCOUT_MDNS_ENABLED);
}

/**
 * Pick the browser that can actually hear on this OS. An explicit responder
 * factory always wins, so tests never depend on the host platform.
 */
export function browseLanServicesForPlatform(
  platform: NodeJS.Platform,
  options: BrowseLanServicesOptions = {},
): Promise<LanServiceAdvert[]> {
  if (platform === "darwin" && !options.responderFactory) {
    return browseLanServicesViaDnsSd({
      ...(options.serviceTypes ? { serviceTypes: options.serviceTypes } : {}),
      ...(options.browseMs !== undefined ? { browseMs: options.browseMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  return browseLanServices(options);
}

export async function readLanScan(
  ctx: ProbeCtx,
  env: RuntimeEnv = process.env,
  responderFactory?: LanMdnsResponderFactory,
  platform: NodeJS.Platform = process.platform,
): Promise<LanScanSnapshot> {
  if (!lanScanEnabled(env)) {
    return { ...EMPTY_LAN_SCAN, scannedAt: Date.now() };
  }

  const mdnsOn = lanMdnsBrowseEnabled(env);
  const browseMs = Number.parseInt(env.OPENSCOUT_LAN_SCAN_BROWSE_MS ?? "", 10);

  // The two halves are independent; one failing must not blank the other.
  const [neighbors, services] = await Promise.all([
    readArpNeighbors(ctx, env),
    mdnsOn
      ? browseLanServicesForPlatform(platform, {
        browseMs: Number.isFinite(browseMs) && browseMs > 0 ? browseMs : DEFAULT_BROWSE_MS,
        responderFactory,
        signal: ctx.signal,
      }).catch(() => [] as LanServiceAdvert[])
      : Promise.resolve([] as LanServiceAdvert[]),
  ]);

  return {
    services,
    neighbors,
    browsedTypes: mdnsOn ? [...MACHINE_LAN_SERVICE_TYPES] : [],
    mdnsEnabled: mdnsOn,
    scannedAt: Date.now(),
  };
}

export const lanScanProbe = defineProbe<LanScanSnapshot>({
  id: "lan.scan",
  ttlMs: LAN_SCAN_TTL_MS,
  timeoutMs: LAN_SCAN_TIMEOUT_MS,
  run: (ctx) => readLanScan(ctx),
});
