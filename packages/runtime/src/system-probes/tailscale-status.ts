import type { RuntimeEnv } from "../portable-types.js";
import { readFile } from "node:fs/promises";

import { defineProbe, type ProbeCtx } from "./registry.js";
import { execProbeFile, ProbeCommandError } from "./exec.js";
import { runWithScoutdFallback } from "./scoutd-client.js";

const DEFAULT_TAILSCALE_STATUS_TIMEOUT_MS = 1_500;

export interface TailscalePeerCandidate {
  id: string;
  name: string;
  dnsName?: string;
  addresses: string[];
  online: boolean;
  hostName?: string;
  os?: string;
  tags?: string[];
}

export interface TailscaleSelfCandidate {
  id: string;
  name: string;
  dnsName?: string;
  addresses: string[];
  online: boolean;
  hostName?: string;
  os?: string;
  tailnetName?: string;
  magicDnsSuffix?: string;
}

export interface TailscaleStatusSummary {
  backendState: string | null;
  running: boolean;
  health: string[];
  peers: TailscalePeerCandidate[];
  self: TailscaleSelfCandidate | null;
}

export interface TailscaleStatusJson {
  BackendState?: string;
  Health?: string[];
  Self?: {
    ID?: string;
    HostName?: string;
    DNSName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
    OS?: string;
  };
  Peer?: Record<string, {
    ID?: string;
    HostName?: string;
    DNSName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
    OS?: string;
    Tags?: string[];
  }>;
  CurrentTailnet?: {
    Name?: string;
    MagicDNSSuffix?: string;
  };
}

export function parseTailscaleStatusJson(raw: string): TailscaleStatusJson {
  return JSON.parse(raw) as TailscaleStatusJson;
}

function parsePeers(status: TailscaleStatusJson): TailscalePeerCandidate[] {
  const peers = Object.entries(status.Peer ?? {});

  return peers.map(([fallbackId, peer]) => ({
    id: peer.ID ?? fallbackId,
    name: peer.HostName ?? peer.DNSName ?? fallbackId,
    dnsName: peer.DNSName,
    addresses: peer.TailscaleIPs ?? [],
    online: peer.Online ?? false,
    hostName: peer.HostName,
    os: peer.OS,
    tags: peer.Tags ?? [],
  }));
}

function parseSelf(status: TailscaleStatusJson): TailscaleSelfCandidate | null {
  const self = status.Self;
  if (!self) {
    return null;
  }

  return {
    id: self.ID ?? self.DNSName ?? self.HostName ?? "self",
    name: self.HostName ?? self.DNSName ?? "self",
    dnsName: self.DNSName,
    addresses: self.TailscaleIPs ?? [],
    online: self.Online ?? true,
    hostName: self.HostName,
    os: self.OS,
    tailnetName: status.CurrentTailnet?.Name,
    magicDnsSuffix: status.CurrentTailnet?.MagicDNSSuffix,
  };
}

export function isTailscaleBackendRunning(status: TailscaleStatusJson): boolean {
  return (status.BackendState ?? "").trim().toLowerCase() === "running";
}

function normalizeHost(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\.$/, "").toLowerCase();
  if (!normalized || normalized.includes("/") || /\s/.test(normalized)) {
    return null;
  }
  return normalized;
}

function uniq(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeHost(value ?? undefined);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function tailscaleSelfWebHosts(self: TailscaleSelfCandidate | null | undefined): string[] {
  if (!self) {
    return [];
  }
  return uniq([
    self.dnsName,
    self.hostName && self.magicDnsSuffix ? `${self.hostName}.${self.magicDnsSuffix}` : undefined,
    ...self.addresses,
  ]);
}

export function summarizeTailscaleStatus(status: TailscaleStatusJson): TailscaleStatusSummary {
  return {
    backendState: status.BackendState ?? null,
    running: isTailscaleBackendRunning(status),
    health: status.Health ?? [],
    peers: parsePeers(status),
    self: parseSelf(status),
  };
}

function statusTimeoutMs(env: RuntimeEnv): number {
  const parsed = Number.parseInt(env.OPENSCOUT_TAILSCALE_STATUS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TAILSCALE_STATUS_TIMEOUT_MS;
}

async function readStatusJsonFromFile(filePath: string): Promise<TailscaleStatusJson | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseTailscaleStatusJson(raw);
  } catch {
    return null;
  }
}

function isDomainUnavailableError(error: unknown): boolean {
  if (!(error instanceof ProbeCommandError)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "spawn" || error.code === "exit";
}

export async function readTailscaleStatusSummaryLocal(ctx: ProbeCtx): Promise<TailscaleStatusSummary | null> {
  const fixturePath = process.env.OPENSCOUT_TAILSCALE_STATUS_JSON;
  if (fixturePath) {
    const status = await readStatusJsonFromFile(fixturePath);
    return status ? summarizeTailscaleStatus(status) : null;
  }

  const tailscaleBin = process.env.OPENSCOUT_TAILSCALE_BIN ?? "tailscale";
  try {
    const { stdout } = await execProbeFile(ctx, tailscaleBin, ["status", "--json"], {
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    });
    return summarizeTailscaleStatus(parseTailscaleStatusJson(stdout));
  } catch (error) {
    if (isDomainUnavailableError(error)) {
      return null;
    }
    throw error;
  }
}

export const tailscaleStatusProbe = defineProbe<TailscaleStatusSummary | null>({
  id: "tailscale.status",
  ttlMs: 30_000,
  timeoutMs: statusTimeoutMs(process.env),
  run: (ctx) => runWithScoutdFallback({
    probeId: "tailscale.status",
    ctx,
    local: () => readTailscaleStatusSummaryLocal(ctx),
  }),
});
