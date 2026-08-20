import { gitBuildInfoProbe } from "./git-build-info.js";
import { netListenersProbe } from "./net-listeners.js";
import { psDiscoveryProbe, psRuntimeProbe } from "./ps.js";
import { getScoutdProbeClient } from "./scoutd-client.js";
import { tailscaleStatusProbe } from "./tailscale-status.js";
import { tmuxSessionsProbe } from "./tmux.js";
import {
  registeredSystemProbes,
  type ProbeBackend,
  type ProbeHandle,
  type ProbeMetrics,
  type ProbeSnapshot,
  type ProbeStatus,
} from "./registry.js";

const FALLBACK_WARNING_MS = 30_000;
void netListenersProbe; // Import registers the keyed net.listeners family for registry-driven doctor sweeps.

export type SystemProbeDoctorFamily = {
  id: string;
  key?: string;
  backend: ProbeBackend;
  status: ProbeStatus;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  fallbackSince: number | null;
  fallbackReason: string | null;
  fallbackAgeMs: number | null;
  warning: string | null;
};

export type SystemProbeDoctorReport = {
  socketPath: string;
  socketExists: boolean;
  daemonObserved: boolean;
  daemonVersion: string | null;
  supportedProbeIds: string[];
  lastCapabilityCheckAt: number | null;
  lastError: string | null;
  families: SystemProbeDoctorFamily[];
  warnings: string[];
};

export async function loadSystemProbeDoctorReport(input: { repoRoot: string }): Promise<SystemProbeDoctorReport> {
  await Promise.allSettled([
    tailscaleStatusProbe.fresh(),
    gitBuildInfoProbe.for(input.repoRoot).fresh(),
    tmuxSessionsProbe.for({}).fresh(),
    psRuntimeProbe.fresh(),
    psDiscoveryProbe.fresh(),
  ]);

  const diagnostics = getScoutdProbeClient().diagnostics();
  const families = activeDoctorFamilies();
  const warnings = families.flatMap((family) => family.warning ? [family.warning] : []);

  return {
    socketPath: diagnostics.socketPath,
    socketExists: diagnostics.socketExists,
    daemonObserved: diagnostics.daemonObserved,
    daemonVersion: diagnostics.daemonVersion,
    supportedProbeIds: diagnostics.supportedProbeIds,
    lastCapabilityCheckAt: diagnostics.lastCapabilityCheckAt,
    lastError: diagnostics.lastError,
    families,
    warnings,
  };
}

function activeDoctorFamilies(): SystemProbeDoctorFamily[] {
  const families: SystemProbeDoctorFamily[] = [];
  for (const entry of registeredSystemProbes()) {
    if (entry.kind === "probe") {
      const report = reportForHandle(entry.id, entry.handle);
      if (report) families.push(report);
      continue;
    }
    for (const key of entry.family.keys()) {
      const handle = entry.family.for(key);
      const report = reportForHandle(entry.id, handle);
      if (report) families.push(report);
    }
  }
  return families;
}

function reportForHandle<T>(id: string, handle: ProbeHandle<T>): SystemProbeDoctorFamily | null {
  const snapshot = handle.snapshot();
  const metrics = handle.metrics();
  if (snapshot.status === "empty" && metrics.runCount === 0 && !metrics.fallbackSince) {
    return null;
  }
  return familyReport({
    id,
    key: snapshot.key,
    snapshot,
    metrics,
  });
}

function familyReport(input: {
  id: string;
  key?: string;
  snapshot: Pick<ProbeSnapshot<unknown>, "status" | "backend" | "fallbackSince" | "fallbackReason">;
  metrics: Pick<ProbeMetrics, "lastRunAt" | "lastSuccessAt" | "consecutiveFailures" | "fallbackSince" | "fallbackReason">;
}): SystemProbeDoctorFamily {
  const fallbackSince = input.snapshot.fallbackSince ?? input.metrics.fallbackSince ?? null;
  const fallbackReason = input.snapshot.fallbackReason ?? input.metrics.fallbackReason ?? null;
  const fallbackAgeMs = fallbackSince === null ? null : Math.max(0, Date.now() - fallbackSince);
  const warning = input.snapshot.backend === "local-fallback" && fallbackAgeMs !== null && fallbackAgeMs >= FALLBACK_WARNING_MS
    ? `${input.id} has used local fallback for ${Math.round(fallbackAgeMs / 1000)}s: ${fallbackReason ?? "unknown reason"}`
    : null;

  return {
    id: input.id,
    ...(input.key ? { key: input.key } : {}),
    backend: input.snapshot.backend,
    status: input.snapshot.status,
    lastRunAt: input.metrics.lastRunAt,
    lastSuccessAt: input.metrics.lastSuccessAt,
    consecutiveFailures: input.metrics.consecutiveFailures,
    fallbackSince,
    fallbackReason,
    fallbackAgeMs,
    warning,
  };
}
