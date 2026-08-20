import type { MetadataMap, ScoutId } from "./common.js";
import type {
  ObservedActivity,
  ObservedStatusPhase,
  ObservedStatusProjection,
} from "./observed-status.js";

export type ScoutActivityAltitude = "shell" | "list" | "focused";

export type ScoutActivityMotionLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "blocked";

export type ScoutActivitySeverity = "info" | "warning" | "critical";

export type ScoutActivityEventKind =
  | "message"
  | "invocation"
  | "flight"
  | "work_item"
  | "question"
  | "approval"
  | "permission"
  | "session"
  | "tool"
  | "edit"
  | "result"
  | "tail"
  | "error";

export type ScoutActivitySourceKind =
  | "broker_record"
  | "message"
  | "invocation"
  | "flight"
  | "collaboration_record"
  | "work_item"
  | "question"
  | "endpoint"
  | "tail_event"
  | "session_projection"
  | "observed_status";

export interface ScoutActivitySourceRef {
  kind: ScoutActivitySourceKind;
  refId: ScoutId | string;
  label?: string;
}

export interface ScoutActivityEvent {
  id: ScoutId | string;
  kind: ScoutActivityEventKind;
  agentId?: ScoutId;
  sessionId?: ScoutId;
  conversationId?: ScoutId;
  title?: string;
  summary: string;
  at: number;
  severity?: ScoutActivitySeverity;
  source: ScoutActivitySourceRef;
  metadata?: MetadataMap;
}

export interface ScoutActivityWorkSummary {
  title?: string;
  summary?: string;
  source?: ScoutActivitySourceRef;
  metadata?: MetadataMap;
}

export interface ScoutAgentActivitySummary {
  agentId: ScoutId;
  displayName?: string;
  phase: ObservedStatusPhase;
  activity: ObservedActivity;
  motion: ScoutActivityMotionLevel;
  needsYou: boolean;
  currentWork?: ScoutActivityWorkSummary;
  latestEvent?: ScoutActivityEvent;
  updatedAt: number;
  staleAt?: number;
  status?: ObservedStatusProjection;
  metadata?: MetadataMap;
}

export interface ScoutActivityDigest {
  label: string;
  summary: string;
  motion: ScoutActivityMotionLevel;
  updatedAt: number;
  needsYouCount: number;
  workingCount: number;
  latestEvent?: ScoutActivityEvent;
  metadata?: MetadataMap;
}

export interface ScoutFleetActivitySummary {
  totalAgents: number;
  workingCount: number;
  needsYouCount: number;
  activeCount: number;
  quietCount: number;
  updatedAt: number;
  agents: ScoutAgentActivitySummary[];
  currentlyWorking: ScoutAgentActivitySummary[];
  needsYou: ScoutAgentActivitySummary[];
  latestEvents: ScoutActivityEvent[];
  digest: ScoutActivityDigest;
  metadata?: MetadataMap;
}
