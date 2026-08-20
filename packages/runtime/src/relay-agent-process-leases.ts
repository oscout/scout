import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertTestIsolatedUserData, resolveOpenScoutSupportPaths } from "./support-paths.js";

/**
 * Relay-agent process leases.
 *
 * Every relay agent the runtime launches into a detached tmux session gets a
 * lease file under `runtime/process-leases/`. The lease is the ownership claim
 * that makes a live relay process attributable: which agent it serves, which
 * tmux session hosts it, and which runtime pid brought it online. The reaper
 * uses leases (alongside the relay registry) to decide which tmux sessions it
 * is allowed to reap, and a human can `ls` the directory to see what is alive
 * and why. Same convention as the `web-capture-<pid>.json` leases written by
 * scripts/capture-web.mjs.
 */

export const RELAY_AGENT_PROCESS_LEASE_PREFIX = "relay-agent-";

export type RelayAgentProcessLease = {
  version: 1;
  kind: "relay_agent";
  agentId: string;
  sessionName: string;
  ownerPid: number;
  startedAtMs: number;
  adoptedAtMs?: number;
  projectRoot?: string;
  harness?: string;
  paneId?: string;
};

export function processLeasesDirectory(): string {
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "process-leases");
}

function leaseFileName(sessionName: string): string {
  const safe = sessionName.trim().replace(/[^\w.-]+/g, "-");
  return `${RELAY_AGENT_PROCESS_LEASE_PREFIX}${safe}.json`;
}

export function relayAgentProcessLeasePath(sessionName: string): string {
  return join(processLeasesDirectory(), leaseFileName(sessionName));
}

export function writeRelayAgentProcessLease(lease: Omit<RelayAgentProcessLease, "version" | "kind">): void {
  assertTestIsolatedUserData("write a relay-agent process lease", "OPENSCOUT_SUPPORT_DIRECTORY");
  const directory = processLeasesDirectory();
  mkdirSync(directory, { recursive: true });
  const payload: RelayAgentProcessLease = {
    version: 1,
    kind: "relay_agent",
    ...lease,
  };
  writeFileSync(relayAgentProcessLeasePath(lease.sessionName), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export function removeRelayAgentProcessLease(sessionName: string): void {
  try {
    rmSync(relayAgentProcessLeasePath(sessionName), { force: true });
  } catch {
    // Best effort: a missing or unremovable lease never blocks a kill.
  }
}

export function readRelayAgentProcessLeases(): RelayAgentProcessLease[] {
  const directory = processLeasesDirectory();
  if (!existsSync(directory)) {
    return [];
  }

  const leases: RelayAgentProcessLease[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(RELAY_AGENT_PROCESS_LEASE_PREFIX) || !entry.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(join(directory, entry), "utf8")) as RelayAgentProcessLease;
      if (parsed?.kind === "relay_agent" && parsed.sessionName?.trim() && parsed.agentId?.trim()) {
        leases.push(parsed);
      }
    } catch {
      // Ignore unreadable lease files; the reconcile pass rewrites live ones.
    }
  }
  return leases;
}

/**
 * Bring the lease directory back in line with reality: drop leases whose tmux
 * session no longer exists, and claim ownership of live attributed sessions
 * that have no lease (relays spawned by a previous runtime pid are adopted
 * rather than killed — the idle reaper bounds their lifetime either way).
 */
export function reconcileRelayAgentProcessLeases(input: {
  liveSessionNames: ReadonlySet<string>;
  owners: ReadonlyMap<string, string>;
  ownerPid?: number;
  now?: number;
}): { removed: string[]; adopted: string[] } {
  const now = input.now ?? Date.now();
  const ownerPid = input.ownerPid ?? process.pid;
  const removed: string[] = [];
  const adopted: string[] = [];

  const leases = new Map(readRelayAgentProcessLeases().map((lease) => [lease.sessionName, lease]));
  for (const lease of leases.values()) {
    if (!input.liveSessionNames.has(lease.sessionName)) {
      removeRelayAgentProcessLease(lease.sessionName);
      removed.push(lease.sessionName);
    }
  }

  for (const sessionName of input.liveSessionNames) {
    const agentId = input.owners.get(sessionName);
    if (!agentId) {
      continue;
    }
    const lease = leases.get(sessionName);
    if (lease && lease.ownerPid === ownerPid) {
      continue;
    }
    writeRelayAgentProcessLease({
      agentId,
      sessionName,
      ownerPid,
      startedAtMs: lease?.startedAtMs ?? now,
      adoptedAtMs: now,
      ...(lease?.projectRoot ? { projectRoot: lease.projectRoot } : {}),
      ...(lease?.harness ? { harness: lease.harness } : {}),
    });
    adopted.push(sessionName);
  }

  return { removed, adopted };
}
