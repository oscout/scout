import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { readClaudeAgentTeamTopology } from "@openscout/agent-sessions/adapters/claude-code/team-topology";
import { readClaudeSubagentTopology } from "@openscout/agent-sessions/adapters/claude-code/subagent-topology";
import { readClaudeWorkflowTopology } from "@openscout/agent-sessions/adapters/claude-code/workflow-topology";
import { CodexObservedTopologyTracker } from "@openscout/agent-sessions/adapters/codex/topology";
import type { ObservedHarnessTopology } from "@openscout/agent-sessions/protocol/primitives";

import type {
  HarnessTopologyEvent,
  HarnessTopologyObservation,
  HarnessTopologyObserverOptions,
  HarnessTopologySnapshot,
  HarnessTopologySource,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = readPositiveIntEnv("OPENSCOUT_TOPOLOGY_POLL_INTERVAL_MS", 10_000);
const EVENT_BUFFER_LIMIT = 500;

type Subscriber = (event: HarnessTopologyEvent) => void;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function topologyFingerprint(topology: ObservedHarnessTopology): string {
  const { observedAt: _observedAt, ...stableTopology } = topology;
  return createHash("sha256").update(stableJson(stableTopology)).digest("hex");
}

function summarizeTopology(topology: ObservedHarnessTopology): HarnessTopologyObservation["summary"] {
  return {
    groups: topology.groups.length,
    agents: topology.agents.length,
    tasks: topology.tasks.length,
    relationships: topology.relationships.length,
  };
}

function observationFromTopology(
  topology: ObservedHarnessTopology,
  changedAt: number,
): HarnessTopologyObservation {
  const fingerprint = topologyFingerprint(topology);
  return {
    id: `${topology.source}:${fingerprint.slice(0, 16)}`,
    source: topology.source,
    observedAt: topology.observedAt,
    changedAt,
    fingerprint,
    summary: summarizeTopology(topology),
    topology,
  };
}

function sourceKey(topology: ObservedHarnessTopology): string {
  return topology.source;
}

function normalizeSources(sources: HarnessTopologySource[] | undefined): HarnessTopologySource[] {
  if (!sources || sources.length === 0) return ["claude", "codex"];
  return [...new Set(sources)];
}

export function scanObservedHarnessTopologies(
  options: HarnessTopologyObserverOptions = {},
): ObservedHarnessTopology[] {
  const sources = normalizeSources(options.sources);
  const homeDir = options.homeDir ?? homedir();
  const now = options.now;
  const topologies: ObservedHarnessTopology[] = [];

  if (sources.includes("claude")) {
    const topology = readClaudeAgentTeamTopology({
      homeDir,
      cwd: options.cwd,
      includeUnmatchedTeams: options.includeUnmatchedClaudeTeams ?? true,
      now,
    });
    if (topology) topologies.push(topology);

    const workflowTopology = readClaudeWorkflowTopology({
      homeDir,
      cwd: options.cwd,
      claudeSessionId: options.claudeSessionId,
      includeUnmatchedWorkflows: options.includeUnmatchedClaudeWorkflows ?? true,
      now,
    });
    if (workflowTopology) topologies.push(workflowTopology);

    const subagentTopology = readClaudeSubagentTopology({
      homeDir,
      cwd: options.cwd,
      claudeSessionId: options.claudeSessionId,
      includeUnmatchedSubagents: options.includeUnmatchedClaudeSubagents ?? true,
      now,
    });
    if (subagentTopology) topologies.push(subagentTopology);
  }

  if (sources.includes("codex")) {
    const tracker = new CodexObservedTopologyTracker({
      homeDir,
      cwd: options.cwd,
      now,
    });
    const topology = tracker.toTopology();
    if (topology) topologies.push(topology);
  }

  return topologies;
}

export class HarnessTopologyObserver {
  private readonly options: HarnessTopologyObserverOptions;
  private readonly observations = new Map<string, HarnessTopologyObservation>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly eventBuffer: HarnessTopologyEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanInFlight: Promise<HarnessTopologySnapshot> | null = null;
  private eventCounter = 0;
  private lastSnapshot: HarnessTopologySnapshot | null = null;

  constructor(options: HarnessTopologyObserverOptions = {}) {
    this.options = options;
  }

  async scan(): Promise<HarnessTopologySnapshot> {
    if (this.scanInFlight) return this.scanInFlight;
    this.scanInFlight = Promise.resolve()
      .then(() => this.scanNow())
      .finally(() => {
        this.scanInFlight = null;
      });
    return this.scanInFlight;
  }

  async getSnapshot(force = false): Promise<HarnessTopologySnapshot> {
    if (force || !this.lastSnapshot) {
      return this.scan();
    }
    return this.lastSnapshot;
  }

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    this.ensureLoopRunning();
    void this.scan();
    return () => {
      this.subscribers.delete(handler);
      if (this.subscribers.size === 0) {
        this.stopLoop();
      }
    };
  }

  snapshotRecentEvents(limit = EVENT_BUFFER_LIMIT): HarnessTopologyEvent[] {
    return this.eventBuffer.slice(-limit);
  }

  private scanNow(): HarnessTopologySnapshot {
    const nowMs = (this.options.now ?? (() => new Date()))().getTime();
    const topologies = scanObservedHarnessTopologies(this.options);
    const seen = new Set<string>();

    for (const topology of topologies) {
      const key = sourceKey(topology);
      seen.add(key);
      const next = observationFromTopology(topology, nowMs);
      const existing = this.observations.get(key);
      if (existing?.fingerprint === next.fingerprint) {
        this.observations.set(key, {
          ...next,
          changedAt: existing.changedAt,
        });
        continue;
      }
      this.observations.set(key, next);
      this.pushEvent({
        id: this.nextEventId("snapshot", key),
        ts: nowMs,
        kind: "snapshot",
        source: key,
        observation: next,
      });
    }

    for (const key of [...this.observations.keys()]) {
      if (seen.has(key)) continue;
      this.observations.delete(key);
      this.pushEvent({
        id: this.nextEventId("removed", key),
        ts: nowMs,
        kind: "removed",
        source: key,
      });
    }

    this.lastSnapshot = this.buildSnapshot(nowMs);
    return this.lastSnapshot;
  }

  private buildSnapshot(generatedAt: number): HarnessTopologySnapshot {
    const observations = [...this.observations.values()]
      .sort((a, b) => a.source.localeCompare(b.source));
    const totals = observations.reduce(
      (acc, observation) => {
        acc.sources += 1;
        acc.groups += observation.summary.groups;
        acc.agents += observation.summary.agents;
        acc.tasks += observation.summary.tasks;
        acc.relationships += observation.summary.relationships;
        return acc;
      },
      {
        sources: 0,
        groups: 0,
        agents: 0,
        tasks: 0,
        relationships: 0,
      },
    );

    return {
      generatedAt,
      observations,
      totals,
    };
  }

  private pushEvent(event: HarnessTopologyEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > EVENT_BUFFER_LIMIT) {
      this.eventBuffer.splice(0, this.eventBuffer.length - EVENT_BUFFER_LIMIT);
    }
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch {
        /* subscriber errors are isolated */
      }
    }
  }

  private nextEventId(kind: HarnessTopologyEvent["kind"], source: string): string {
    this.eventCounter += 1;
    return `topology:${kind}:${source}:${this.eventCounter}`;
  }

  private ensureLoopRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  private stopLoop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

const defaultObserver = new HarnessTopologyObserver();

export function getHarnessTopologySnapshot(force = false): Promise<HarnessTopologySnapshot> {
  return defaultObserver.getSnapshot(force);
}

export function subscribeHarnessTopology(handler: Subscriber): () => void {
  return defaultObserver.subscribe(handler);
}

export function snapshotRecentHarnessTopologyEvents(limit = EVENT_BUFFER_LIMIT): HarnessTopologyEvent[] {
  return defaultObserver.snapshotRecentEvents(limit);
}

export function nudgeHarnessTopologyScan(): Promise<HarnessTopologySnapshot> {
  return defaultObserver.scan();
}
