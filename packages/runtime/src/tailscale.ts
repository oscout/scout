import type { RuntimeEnv } from "./portable-types.js";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  isTailscaleBackendRunning,
  parseTailscaleStatusJson,
  summarizeTailscaleStatus,
  tailscaleSelfWebHosts,
  tailscaleStatusProbe,
  type TailscalePeerCandidate,
  type TailscaleSelfCandidate,
  type TailscaleStatusJson,
  type TailscaleStatusSummary,
} from "./system-probes/tailscale-status.js";

export type {
  TailscalePeerCandidate,
  TailscaleSelfCandidate,
  TailscaleStatusSummary,
} from "./system-probes/tailscale-status.js";
export { tailscaleSelfWebHosts, tailscaleStatusProbe } from "./system-probes/tailscale-status.js";

const DEFAULT_TAILSCALE_STATUS_TIMEOUT_MS = 1_500;
const SYNC_TAILSCALE_STATUS_CACHE_MS = 30_000;
let syncStatusCache: {
  key: string;
  at: number;
  value: TailscaleStatusJson | null;
} | null = null;

function readStatusJsonFromFileSync(filePath: string): TailscaleStatusJson {
  const raw = readFileSync(filePath, "utf8");
  return parseTailscaleStatusJson(raw);
}

function statusTimeoutMs(env: RuntimeEnv): number {
  const parsed = Number.parseInt(env.OPENSCOUT_TAILSCALE_STATUS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TAILSCALE_STATUS_TIMEOUT_MS;
}

function readStatusJsonSync(env: RuntimeEnv = process.env): TailscaleStatusJson | null {
  if (env.OPENSCOUT_TAILSCALE_AUTO_HOSTS === "0") {
    return null;
  }

  const fixturePath = env.OPENSCOUT_TAILSCALE_STATUS_JSON;
  if (fixturePath) {
    try {
      return readStatusJsonFromFileSync(fixturePath);
    } catch {
      return null;
    }
  }

  const tailscaleBin = env.OPENSCOUT_TAILSCALE_BIN ?? (env === process.env ? "tailscale" : undefined);
  if (!tailscaleBin) {
    return null;
  }

  const cacheKey = [
    tailscaleBin,
    env.OPENSCOUT_TAILSCALE_AUTO_HOSTS ?? "",
    env.OPENSCOUT_TAILSCALE_STATUS_TIMEOUT_MS ?? "",
  ].join("\0");
  const cached = syncStatusCache;
  if (env === process.env && cached?.key === cacheKey && Date.now() - cached.at < SYNC_TAILSCALE_STATUS_CACHE_MS) {
    return cached.value;
  }

  try {
    const stdout = execFileSync(tailscaleBin, ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: statusTimeoutMs(env),
      windowsHide: true,
    });
    const value = parseTailscaleStatusJson(stdout);
    if (env === process.env) syncStatusCache = { key: cacheKey, at: Date.now(), value };
    return value;
  } catch {
    if (env === process.env) syncStatusCache = { key: cacheKey, at: Date.now(), value: null };
    return null;
  }
}

export async function readTailscalePeers(): Promise<TailscalePeerCandidate[]> {
  const summary = await readTailscaleStatusSummary();
  if (!summary) {
    return [];
  }
  return summary.peers;
}

export async function readTailscaleSelf(): Promise<TailscaleSelfCandidate | null> {
  const summary = await readTailscaleStatusSummary();
  if (!summary) {
    return null;
  }
  return summary.self;
}

export async function readTailscaleStatusSummary(): Promise<TailscaleStatusSummary | null> {
  const snapshot = await tailscaleStatusProbe.fresh();
  return snapshot.value;
}

export function readTailscaleSelfWebHostsSync(env: RuntimeEnv = process.env): string[] {
  const status = readStatusJsonSync(env);
  if (!status || !isTailscaleBackendRunning(status)) {
    return [];
  }
  return tailscaleSelfWebHosts(summarizeTailscaleStatus(status).self);
}
