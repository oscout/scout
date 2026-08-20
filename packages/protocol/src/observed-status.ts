import type { MetadataMap, ScoutId } from "./common.js";

export type ObservedStatusPhase =
  | "unconfigured"
  | "registered"
  | "starting"
  | "connecting"
  | "running"
  | "stopping"
  | "stopped"
  | "closed"
  | "error"
  | "unknown";

export type ObservedActivity =
  | "idle"
  | "queued"
  | "waking"
  | "thinking"
  | "executing"
  | "working"
  | "waiting_for_input"
  | "waiting_on_actor"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "stalled"
  | "offline"
  | "unknown";

export type ObservedStatusSubjectKind =
  | "agent"
  | "endpoint"
  | "flight"
  | "run"
  | "question"
  | "work_item"
  | "pairing_runtime"
  | "tail_session";

export type ObservedStatusProvenanceSource =
  | "broker_record"
  | "endpoint"
  | "flight"
  | "agent_run"
  | "collaboration_record"
  | "session_trace"
  | "pairing_runtime"
  | "tail_event"
  | "process"
  | "tmux"
  | "staleness_inference";

export interface ObservedStatusDetail {
  title?: string;
  summary?: string;
  toolName?: string;
  waitingOn?: unknown;
  sourceCursor?: string;
  metadata?: MetadataMap;
}

export interface StatusProjectionProvenance {
  source: ObservedStatusProvenanceSource;
  refId: ScoutId;
  observedAt: number;
  confidence: number;
}

export interface ObservedStatusProjection {
  subjectKind: ObservedStatusSubjectKind;
  subjectId: ScoutId;
  agentId?: ScoutId;
  phase: ObservedStatusPhase;
  activity: ObservedActivity;
  detail?: ObservedStatusDetail;
  provenance: StatusProjectionProvenance[];
  confidence: number;
  updatedAt: number;
  staleAt?: number;
}

export function observedStatusDisplay(status: Pick<ObservedStatusProjection, "phase" | "activity">): string {
  if (status.phase === "running" && status.activity && status.activity !== "unknown") {
    return status.activity;
  }
  return status.phase;
}
