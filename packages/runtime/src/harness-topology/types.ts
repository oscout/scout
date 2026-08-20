import type { ObservedHarnessTopology } from "@openscout/agent-sessions/protocol/primitives";

export type HarnessTopologySource = "claude" | "codex";

export type HarnessTopologyObservationSummary = {
  groups: number;
  agents: number;
  tasks: number;
  relationships: number;
};

export type HarnessTopologyObservation = {
  id: string;
  source: string;
  observedAt: string;
  changedAt: number;
  fingerprint: string;
  summary: HarnessTopologyObservationSummary;
  topology: ObservedHarnessTopology;
};

export type HarnessTopologyEventKind = "snapshot" | "removed";

export type HarnessTopologyEvent = {
  id: string;
  ts: number;
  kind: HarnessTopologyEventKind;
  source: string;
  observation?: HarnessTopologyObservation;
};

export type HarnessTopologySnapshot = {
  generatedAt: number;
  observations: HarnessTopologyObservation[];
  totals: HarnessTopologyObservationSummary & {
    sources: number;
  };
};

export type HarnessTopologyObserverOptions = {
  homeDir?: string;
  cwd?: string;
  sources?: HarnessTopologySource[];
  pollIntervalMs?: number;
  now?: () => Date;
  claudeSessionId?: string | null;
  includeUnmatchedClaudeTeams?: boolean;
  includeUnmatchedClaudeWorkflows?: boolean;
  includeUnmatchedClaudeSubagents?: boolean;
};
