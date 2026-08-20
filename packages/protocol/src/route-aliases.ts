import type { AgentHarness } from "./actors.js";
import type { MetadataMap, ScoutId } from "./common.js";

export interface RouteAliasScope {
  projectKey?: string;
  projectRoot?: string;
  nodeId?: ScoutId;
}

export type RouteAliasTarget =
  | { kind: "agent"; agentId: ScoutId; nodeId: ScoutId }
  | {
      kind: "session";
      sessionId: ScoutId;
      agentId: ScoutId;
      endpointId: ScoutId;
      nodeId: ScoutId;
      harness: AgentHarness;
    };

export type RouteAliasState = "active" | "unset" | "expired";

export interface RouteAliasBinding {
  id: ScoutId;
  alias: string;
  displayAlias?: string;
  ownerRealmId: ScoutId;
  scopeProjectKey: string;
  scopeProjectRoot?: string;
  scopeNodeId: ScoutId;
  target: RouteAliasTarget;
  targetSnapshot: MetadataMap;
  state: RouteAliasState;
  revision: number;
  createdByActorId: ScoutId;
  updatedByActorId: ScoutId;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  revokedAt?: number;
  metadata?: MetadataMap;
}

export type RouteAliasRevisionOperation = "set" | "repoint" | "unset" | "expire" | "repair";

export interface RouteAliasRevision {
  id: ScoutId;
  bindingId: ScoutId;
  revision: number;
  operation: RouteAliasRevisionOperation;
  oldTarget?: RouteAliasTarget;
  newTarget?: RouteAliasTarget;
  oldTargetSnapshot?: MetadataMap;
  newTargetSnapshot?: MetadataMap;
  actorId: ScoutId;
  authorityNodeId: ScoutId;
  createdAt: number;
  reason?: string;
  requestId?: ScoutId;
}

export interface RouteAliasResolutionProof {
  bindingId: ScoutId;
  revision: number;
  requestedAlias: string;
  scope: Required<Pick<RouteAliasScope, "projectKey" | "nodeId">> & Pick<RouteAliasScope, "projectRoot">;
  target: RouteAliasTarget;
  resolvedAt: number;
}

export type RouteAliasDiagnosticCode =
  | "invalid_alias"
  | "alias_exists"
  | "unknown_alias"
  | "ambiguous_alias_scope"
  | "alias_inactive"
  | "alias_shadowed"
  | "alias_target_unavailable"
  | "alias_session_not_reachable"
  | "alias_session_terminal"
  | "not_authorized"
  | "revision_conflict";

export interface RouteAliasSetRequest {
  alias: string;
  scope?: RouteAliasScope;
  target?: import("./scout-dispatch.js").ScoutRouteTarget;
  self?: "session" | "agent";
  replace?: boolean;
  expectedRevision?: number;
  expiresAt?: number;
  caller?: import("./scout-dispatch.js").ScoutCallerContext;
  metadata?: MetadataMap;
}

export interface RouteAliasListRequest {
  scope?: RouteAliasScope;
  targetAgentId?: ScoutId;
  targetSessionId?: ScoutId;
  includeInactive?: boolean;
  limit?: number;
  caller?: import("./scout-dispatch.js").ScoutCallerContext;
}

export interface RouteAliasResolveRequest {
  alias?: string;
  bindingId?: ScoutId;
  scope?: RouteAliasScope;
  caller?: import("./scout-dispatch.js").ScoutCallerContext;
}

export interface RouteAliasResolveResult {
  resolved: boolean;
  available: boolean;
  binding?: RouteAliasBinding;
  proof?: RouteAliasResolutionProof;
  status?: "active" | "shadowed" | "unreachable" | "terminal" | "expired" | "unset";
  diagnostic?: { code: RouteAliasDiagnosticCode; detail: string };
  fullyQualifiedSelector?: string;
}

export interface RouteAliasMutationRequest {
  target?: import("./scout-dispatch.js").ScoutRouteTarget;
  /** Included by front doors so a non-authoritative broker can forward the mutation. */
  scope?: RouteAliasScope;
  expectedRevision?: number;
  expiresAt?: number | null;
  caller?: import("./scout-dispatch.js").ScoutCallerContext;
  reason?: string;
}
