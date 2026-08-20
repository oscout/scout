import type { AgentHarness, WakePolicy } from "./actors.js";
import type { AdvertiseScope, DeliveryTransport, MetadataMap, ScoutId } from "./common.js";
import type { RouteAliasDiagnosticCode, RouteAliasResolutionProof, RouteAliasScope } from "./route-aliases.js";

export type ScoutDispatchKind = "ambiguous" | "unknown" | "unparseable" | "unavailable";

export type ScoutCandidateEndpointState = "online" | "offline" | "unknown";

export type ScoutRouteTargetKind =
  | "agent_id"
  | "agent_label"
  | "existing_handle"
  | "runtime_profile"
  | "route_alias"
  | "target_handle"
  | "session_id"
  | "binding_ref"
  | "project_path"
  | "channel"
  | "broadcast";

export type ScoutRouteAmbiguousPolicy = "reject" | "ask";

export interface ScoutCallerContext {
  actorId?: ScoutId;
  nodeId?: ScoutId;
  displayName?: string;
  handle?: string;
  currentDirectory?: string;
  metadata?: MetadataMap;
}

export type ScoutRouteTarget =
  | { kind: "agent_id"; agentId: ScoutId; value?: string }
  | { kind: "agent_label"; label: string; value?: string }
  | { kind: "existing_handle"; handle: string; value?: string }
  | {
      kind: "runtime_profile";
      profile: string;
      projectPath: string;
      reasoningEffort?: string;
      value?: string;
    }
  | { kind: "route_alias"; alias: string; scope?: RouteAliasScope; bindingId?: ScoutId; value?: string }
  | { kind: "target_handle"; handle: string; value?: string }
  | { kind: "session_id"; sessionId: ScoutId; harness?: AgentHarness; value?: string }
  | { kind: "binding_ref"; ref: string; value?: string }
  | { kind: "project_path"; projectPath: string; value?: string }
  | { kind: "channel"; channel: string; value?: string }
  | { kind: "broadcast"; value?: string };

export interface ScoutRoutePolicy {
  preferLocalNodeId?: ScoutId;
  ambiguous?: ScoutRouteAmbiguousPolicy;
  allowHistoricalDirectId?: boolean;
  /** @deprecated use allowHistoricalDirectId */
  allowStaleDirectId?: boolean;
}

export type ScoutDispatchUnavailableReason =
  | "manual_wake_required"
  | "retired"
  | "superseded_registration"
  | "session_reference_not_attachable"
  /** @deprecated use superseded_registration or session_reference_not_attachable */
  | "stale_registration"
  | "unknown";

export interface ScoutDispatchCandidate {
  agentId: ScoutId;
  displayName: string;
  label: string;
  authorityNodeId?: ScoutId;
  homeNodeId?: ScoutId;
  advertiseScope?: AdvertiseScope;
  selector?: string | null;
  defaultSelector?: string | null;
  workspace?: string | null;
  node?: string | null;
  projectRoot?: string | null;
  endpointState: ScoutCandidateEndpointState;
  transport?: DeliveryTransport | null;
}

export interface ScoutDispatchUnavailableTarget {
  agentId: ScoutId;
  displayName: string;
  reason: ScoutDispatchUnavailableReason;
  detail: string;
  wakePolicy?: WakePolicy | null;
  endpointState: ScoutCandidateEndpointState;
  transport?: DeliveryTransport | null;
  projectRoot?: string | null;
}

export interface ScoutDispatchEnvelope {
  kind: ScoutDispatchKind;
  askedLabel: string;
  detail: string;
  candidates: ScoutDispatchCandidate[];
  target?: ScoutDispatchUnavailableTarget;
  dispatchedAt: number;
  dispatcherNodeId: ScoutId;
  diagnosticCode?: RouteAliasDiagnosticCode;
  aliasResolution?: RouteAliasResolutionProof;
}

export interface ScoutDispatchRecord extends ScoutDispatchEnvelope {
  id: ScoutId;
  invocationId?: ScoutId;
  conversationId?: ScoutId;
  requesterId?: ScoutId;
}
