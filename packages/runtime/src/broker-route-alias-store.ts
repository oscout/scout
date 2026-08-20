import type {
  AgentHarness,
  MetadataMap,
  RouteAliasBinding,
  RouteAliasRevision,
  RouteAliasRevisionOperation,
  RouteAliasState,
  RouteAliasTarget,
} from "@openscout/protocol";

import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";

type BindingRow = {
  id: string;
  normalized_alias: string;
  display_alias: string | null;
  owner_realm_id: string;
  scope_project_key: string;
  scope_project_root: string | null;
  scope_node_id: string;
  target_kind: "agent" | "session";
  target_agent_id: string | null;
  target_session_id: string | null;
  target_endpoint_id: string | null;
  target_node_id: string;
  target_harness: AgentHarness | null;
  target_snapshot_json: string;
  state: RouteAliasState;
  revision: number;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  metadata_json: string | null;
};

type RevisionRow = {
  id: string;
  binding_id: string;
  revision: number;
  operation: RouteAliasRevisionOperation;
  old_target_json: string | null;
  new_target_json: string | null;
  old_target_snapshot_json: string | null;
  new_target_snapshot_json: string | null;
  actor_id: string;
  authority_node_id: string;
  created_at: number;
  reason: string | null;
  request_id: string | null;
};

function parseJsonMap(value: string | null): MetadataMap | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as MetadataMap
      : undefined;
  } catch {
    return undefined;
  }
}

function parseTarget(value: string | null): RouteAliasTarget | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as RouteAliasTarget;
  } catch {
    return undefined;
  }
}

function targetFromRow(row: BindingRow): RouteAliasTarget {
  if (row.target_kind === "agent") {
    return { kind: "agent", agentId: row.target_agent_id!, nodeId: row.target_node_id };
  }
  return {
    kind: "session",
    sessionId: row.target_session_id!,
    agentId: row.target_agent_id!,
    endpointId: row.target_endpoint_id!,
    nodeId: row.target_node_id,
    harness: row.target_harness!,
  };
}

function bindingFromRow(row: BindingRow): RouteAliasBinding {
  return {
    id: row.id,
    alias: row.normalized_alias,
    ...(row.display_alias ? { displayAlias: row.display_alias } : {}),
    ownerRealmId: row.owner_realm_id,
    scopeProjectKey: row.scope_project_key,
    ...(row.scope_project_root ? { scopeProjectRoot: row.scope_project_root } : {}),
    scopeNodeId: row.scope_node_id,
    target: targetFromRow(row),
    targetSnapshot: parseJsonMap(row.target_snapshot_json) ?? {},
    state: row.state,
    revision: row.revision,
    createdByActorId: row.created_by_actor_id,
    updatedByActorId: row.updated_by_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    ...(parseJsonMap(row.metadata_json) ? { metadata: parseJsonMap(row.metadata_json) } : {}),
  };
}

function revisionFromRow(row: RevisionRow): RouteAliasRevision {
  return {
    id: row.id,
    bindingId: row.binding_id,
    revision: row.revision,
    operation: row.operation,
    ...(parseTarget(row.old_target_json) ? { oldTarget: parseTarget(row.old_target_json) } : {}),
    ...(parseTarget(row.new_target_json) ? { newTarget: parseTarget(row.new_target_json) } : {}),
    ...(parseJsonMap(row.old_target_snapshot_json) ? { oldTargetSnapshot: parseJsonMap(row.old_target_snapshot_json) } : {}),
    ...(parseJsonMap(row.new_target_snapshot_json) ? { newTargetSnapshot: parseJsonMap(row.new_target_snapshot_json) } : {}),
    actorId: row.actor_id,
    authorityNodeId: row.authority_node_id,
    createdAt: row.created_at,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
  };
}

export type RouteAliasScopeKey = {
  ownerRealmId: string;
  projectKey: string;
  projectRoot?: string;
  nodeId: string;
};

export type RouteAliasWrite = RouteAliasScopeKey & {
  id: string;
  alias: string;
  displayAlias?: string;
  target: RouteAliasTarget;
  targetSnapshot: MetadataMap;
  actorId: string;
  now: number;
  expiresAt?: number;
  metadata?: MetadataMap;
  revisionId: string;
  requestId?: string;
};

export class BrokerRouteAliasStore {
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase) {}

  getActive(scope: RouteAliasScopeKey, alias: string): RouteAliasBinding | null {
    const row = this.database.query<BindingRow>(`
      SELECT * FROM route_alias_bindings
      WHERE owner_realm_id = ?1 AND scope_project_key = ?2 AND scope_node_id = ?3
        AND normalized_alias = ?4 AND state = 'active'
      LIMIT 1
    `).get(scope.ownerRealmId, scope.projectKey, scope.nodeId, alias);
    return row ? bindingFromRow(row) : null;
  }

  getById(id: string): RouteAliasBinding | null {
    const row = this.database.query<BindingRow>(
      "SELECT * FROM route_alias_bindings WHERE id = ?1 LIMIT 1",
    ).get(id);
    return row ? bindingFromRow(row) : null;
  }

  list(input: RouteAliasScopeKey & {
    includeInactive?: boolean;
    targetAgentId?: string;
    targetSessionId?: string;
    limit?: number;
  }): RouteAliasBinding[] {
    const clauses = ["owner_realm_id = ?1", "scope_project_key = ?2", "scope_node_id = ?3"];
    const params: unknown[] = [input.ownerRealmId, input.projectKey, input.nodeId];
    if (!input.includeInactive) clauses.push("state = 'active'");
    if (input.targetAgentId) {
      params.push(input.targetAgentId);
      clauses.push(`target_agent_id = ?${params.length}`);
    }
    if (input.targetSessionId) {
      params.push(input.targetSessionId);
      clauses.push(`target_session_id = ?${params.length}`);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
    params.push(limit);
    return this.database.query<BindingRow>(`
      SELECT * FROM route_alias_bindings
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, normalized_alias ASC
      LIMIT ?${params.length}
    `).all(...params).map(bindingFromRow);
  }

  history(bindingId: string, limit = 200): RouteAliasRevision[] {
    return this.database.query<RevisionRow>(`
      SELECT * FROM route_alias_revisions WHERE binding_id = ?1
      ORDER BY revision DESC LIMIT ?2
    `).all(bindingId, Math.max(1, Math.min(limit, 1_000))).map(revisionFromRow);
  }

  listExpiryCandidates(now: number, limit = 200): RouteAliasBinding[] {
    return this.database.query<BindingRow>(`
      SELECT * FROM route_alias_bindings
      WHERE state = 'active'
        AND (expires_at IS NOT NULL AND expires_at <= ?1 OR target_kind = 'session')
      ORDER BY COALESCE(expires_at, updated_at) ASC, id ASC
      LIMIT ?2
    `).all(now, Math.max(1, Math.min(limit, 1_000))).map(bindingFromRow);
  }

  create(input: RouteAliasWrite): RouteAliasBinding {
    this.database.transaction(() => {
      const t = input.target;
      this.database.query(`
        INSERT INTO route_alias_bindings (
          id, normalized_alias, display_alias, owner_realm_id, scope_project_key,
          scope_project_root, scope_node_id, target_kind, target_agent_id,
          target_session_id, target_endpoint_id, target_node_id, target_harness,
          target_snapshot_json, state, revision, created_by_actor_id,
          updated_by_actor_id, created_at, updated_at, expires_at, metadata_json
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          ?14, 'active', 1, ?15, ?15, ?16, ?16, ?17, ?18
        )
      `).run(
        input.id, input.alias, input.displayAlias ?? null, input.ownerRealmId,
        input.projectKey, input.projectRoot ?? null, input.nodeId, t.kind,
        t.agentId, t.kind === "session" ? t.sessionId : null,
        t.kind === "session" ? t.endpointId : null, t.nodeId,
        t.kind === "session" ? t.harness : null, JSON.stringify(input.targetSnapshot),
        input.actorId, input.now, input.expiresAt ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
      this.insertRevision({
        id: input.revisionId,
        bindingId: input.id,
        revision: 1,
        operation: "set",
        newTarget: input.target,
        newSnapshot: input.targetSnapshot,
        actorId: input.actorId,
        authorityNodeId: input.nodeId,
        createdAt: input.now,
        requestId: input.requestId,
      });
    })();
    return this.getById(input.id)!;
  }

  update(input: {
    binding: RouteAliasBinding;
    operation: "repoint" | "unset" | "expire" | "repair";
    target?: RouteAliasTarget;
    targetSnapshot?: MetadataMap;
    actorId: string;
    authorityNodeId: string;
    now: number;
    expectedRevision?: number;
    expiresAt?: number | null;
    reason?: string;
    requestId?: string;
    revisionId: string;
  }): RouteAliasBinding | null {
    return this.database.transaction(() => {
      const current = this.getById(input.binding.id);
      if (!current || current.revision !== input.binding.revision) return null;
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) return null;
      const revision = current.revision + 1;
      const target = input.target ?? current.target;
      const snapshot = input.targetSnapshot ?? current.targetSnapshot;
      const state: RouteAliasState = input.operation === "unset"
        ? "unset"
        : input.operation === "expire"
        ? "expired"
        : "active";
      this.database.query(`
        UPDATE route_alias_bindings SET
          target_kind = ?1, target_agent_id = ?2, target_session_id = ?3,
          target_endpoint_id = ?4, target_node_id = ?5, target_harness = ?6,
          target_snapshot_json = ?7, state = ?8, revision = ?9,
          updated_by_actor_id = ?10, updated_at = ?11, expires_at = ?12,
          revoked_at = ?13
        WHERE id = ?14 AND revision = ?15
      `).run(
        target.kind, target.agentId, target.kind === "session" ? target.sessionId : null,
        target.kind === "session" ? target.endpointId : null, target.nodeId,
        target.kind === "session" ? target.harness : null, JSON.stringify(snapshot),
        state, revision, input.actorId, input.now,
        input.expiresAt === undefined ? current.expiresAt ?? null : input.expiresAt,
        state === "active" ? null : input.now, current.id, current.revision,
      );
      this.insertRevision({
        id: input.revisionId,
        bindingId: current.id,
        revision,
        operation: input.operation,
        oldTarget: current.target,
        newTarget: input.operation === "unset" || input.operation === "expire" ? undefined : target,
        oldSnapshot: current.targetSnapshot,
        newSnapshot: input.operation === "unset" || input.operation === "expire" ? undefined : snapshot,
        actorId: input.actorId,
        authorityNodeId: input.authorityNodeId,
        createdAt: input.now,
        reason: input.reason,
        requestId: input.requestId,
      });
      return this.getById(current.id)!;
    })();
  }

  private insertRevision(input: {
    id: string;
    bindingId: string;
    revision: number;
    operation: RouteAliasRevisionOperation;
    oldTarget?: RouteAliasTarget;
    newTarget?: RouteAliasTarget;
    oldSnapshot?: MetadataMap;
    newSnapshot?: MetadataMap;
    actorId: string;
    authorityNodeId: string;
    createdAt: number;
    reason?: string;
    requestId?: string;
  }): void {
    this.database.query(`
      INSERT INTO route_alias_revisions (
        id, binding_id, revision, operation, old_target_json, new_target_json,
        old_target_snapshot_json, new_target_snapshot_json, actor_id,
        authority_node_id, created_at, reason, request_id
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `).run(
      input.id, input.bindingId, input.revision, input.operation,
      input.oldTarget ? JSON.stringify(input.oldTarget) : null,
      input.newTarget ? JSON.stringify(input.newTarget) : null,
      input.oldSnapshot ? JSON.stringify(input.oldSnapshot) : null,
      input.newSnapshot ? JSON.stringify(input.newSnapshot) : null,
      input.actorId, input.authorityNodeId, input.createdAt,
      input.reason ?? null, input.requestId ?? null,
    );
  }
}
