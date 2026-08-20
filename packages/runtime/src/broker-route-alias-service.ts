import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type {
  AgentDefinition,
  AgentEndpoint,
  MetadataMap,
  RouteAliasBinding,
  RouteAliasDiagnosticCode,
  RouteAliasListRequest,
  RouteAliasMutationRequest,
  RouteAliasResolveRequest,
  RouteAliasResolveResult,
  RouteAliasResolutionProof,
  RouteAliasSetRequest,
  RouteAliasTarget,
  ScoutCallerContext,
  ScoutRouteTarget,
} from "@openscout/protocol";
import { SCOUT_RESERVED_AGENT_NAMES } from "@openscout/protocol";

import {
  endpointMatchesTargetSession,
  isStaleLocalEndpoint,
} from "./broker-endpoint-selection.js";
import {
  BrokerRouteAliasStore,
  type RouteAliasScopeKey,
} from "./broker-route-alias-store.js";
import {
  buildAgentLabelCandidates,
  resolveBrokerRouteTarget,
  type BrokerLabelResolution,
  type RuntimeSnapshot,
} from "./scout-dispatcher.js";

export const ROUTE_ALIAS_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const RESERVED_ROUTE_ALIASES = new Set(SCOUT_RESERVED_AGENT_NAMES);

export class BrokerRouteAliasError extends Error {
  constructor(
    readonly code: RouteAliasDiagnosticCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrokerRouteAliasError";
  }
}

export function normalizeRouteAlias(value: string): string {
  const alias = value.trim();
  if (
    alias !== alias.toLowerCase()
    || !ROUTE_ALIAS_NAME_PATTERN.test(alias)
    || RESERVED_ROUTE_ALIASES.has(alias)
  ) {
    throw new BrokerRouteAliasError(
      "invalid_alias",
      `invalid route alias "${value}"; use ^[a-z][a-z0-9-]{0,62}$ and avoid reserved route words`,
    );
  }
  return alias;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/")
    ? resolve(homedir(), trimmed.slice(2))
    : trimmed;
  return resolve(expanded);
}

export function routeAliasProjectKey(projectRoot: string): string {
  return `project:${createHash("sha256").update(normalizePath(projectRoot)).digest("hex").slice(0, 24)}`;
}

function metadataString(metadata: MetadataMap | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function projectRootForAgent(snapshot: RuntimeSnapshot, agent: AgentDefinition): string | undefined {
  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === agent.id)
    .sort((a, b) => b.id.localeCompare(a.id));
  return endpoints[0]?.projectRoot?.trim()
    || endpoints[0]?.cwd?.trim()
    || metadataString(agent.metadata, "projectRoot");
}

function projectRoots(snapshot: RuntimeSnapshot): string[] {
  return [...new Set(
    Object.values(snapshot.agents)
      .map((agent) => projectRootForAgent(snapshot, agent))
      .filter((value): value is string => Boolean(value))
      .map(normalizePath),
  )];
}

function inferProjectRoot(snapshot: RuntimeSnapshot, directory: string): string {
  const cwd = normalizePath(directory);
  const matches = projectRoots(snapshot)
    .filter((root) => cwd === root || cwd.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length);
  if (matches.length === 0) {
    throw new BrokerRouteAliasError(
      "ambiguous_alias_scope",
      `cannot infer a Scout project from ${cwd}; retry with --project <root>`,
      { candidates: projectRoots(snapshot) },
    );
  }
  const longest = matches[0]!;
  if (matches.filter((candidate) => candidate.length === longest.length).length > 1) {
    throw new BrokerRouteAliasError(
      "ambiguous_alias_scope",
      `multiple Scout projects match ${cwd}; retry with --project <root>`,
      { candidates: matches },
    );
  }
  return longest;
}

function actorId(caller: ScoutCallerContext | undefined, operatorActorId: string): string {
  return caller?.actorId?.trim() || operatorActorId;
}

function sessionTerminal(endpoint: AgentEndpoint | undefined): boolean {
  return !endpoint
    || endpoint.state === "stopped"
    || endpoint.state === "failed"
    || endpoint.state === "superseded"
    || endpoint.metadata?.terminal === true;
}

function routeAliasTargetSnapshot(
  snapshot: RuntimeSnapshot,
  target: RouteAliasTarget,
): MetadataMap {
  const agent = snapshot.agents[target.agentId];
  const endpoint = target.kind === "session" ? snapshot.endpoints[target.endpointId] : undefined;
  return {
    agentId: target.agentId,
    agentDisplayName: agent?.displayName ?? snapshot.actors[target.agentId]?.displayName ?? target.agentId,
    ...(agent?.definitionId ? { agentDefinitionId: agent.definitionId } : {}),
    nodeId: target.nodeId,
    ...(target.kind === "session" ? {
      sessionId: target.sessionId,
      endpointId: target.endpointId,
      harness: target.harness,
      projectRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
    } : {}),
  };
}

export type BrokerRouteAliasServiceOptions = {
  store: BrokerRouteAliasStore;
  ownerRealmId: string;
  nodeId: string;
  operatorActorId: string;
  runtimeSnapshot: () => RuntimeSnapshot;
  createId?: (prefix: string) => string;
  now?: () => number;
};

export type RouteAliasDispatchResolution = {
  resolution: Extract<BrokerLabelResolution, { kind: "resolved" | "resolved_session" }>;
  proof: RouteAliasResolutionProof;
  binding: RouteAliasBinding;
};

export class BrokerRouteAliasService {
  constructor(private readonly options: BrokerRouteAliasServiceOptions) {}

  set(request: RouteAliasSetRequest): RouteAliasBinding {
    const alias = normalizeRouteAlias(request.alias);
    const scope = this.scope(request.scope, request.caller);
    const callerActorId = actorId(request.caller, this.options.operatorActorId);
    this.assertCanManage(callerActorId, request.self);
    const existing = this.options.store.getActive(scope, alias);
    if (existing) {
      if (!request.replace) {
        throw new BrokerRouteAliasError("alias_exists", `alias ${alias} already points to ${existing.target.kind}:${existing.target.kind === "agent" ? existing.target.agentId : existing.target.sessionId} at revision ${existing.revision}`, {
          binding: existing,
        });
      }
      if (callerActorId !== this.options.operatorActorId) {
        throw new BrokerRouteAliasError("not_authorized", "self-claim cannot replace an existing active alias; owner authority is required");
      }
      return this.repoint(existing.id, {
        target: request.target,
        expectedRevision: request.expectedRevision,
        expiresAt: request.expiresAt,
        caller: request.caller,
      }, request.self);
    }
    const native = this.nativeCollision(alias, scope);
    if (native) {
      throw new BrokerRouteAliasError(
        "alias_exists",
        `alias ${alias} collides with native agent ${native.displayName ?? native.id}; choose a different alias`,
        { agentId: native.id },
      );
    }
    const target = this.canonicalTarget(request.target, request.self, request.caller);
    const now = this.now();
    if (request.expiresAt !== undefined && request.expiresAt <= now) {
      throw new BrokerRouteAliasError("invalid_alias", "alias expiry must be in the future");
    }
    return this.options.store.create({
      id: this.id("alias"),
      revisionId: this.id("aliasrev"),
      alias,
      displayAlias: request.alias.trim() === alias ? undefined : request.alias.trim(),
      ...scope,
      target,
      targetSnapshot: routeAliasTargetSnapshot(this.options.runtimeSnapshot(), target),
      actorId: callerActorId,
      now,
      expiresAt: request.expiresAt,
      metadata: request.metadata,
    });
  }

  list(request: RouteAliasListRequest): RouteAliasBinding[] {
    const scope = this.scope(request.scope, request.caller);
    this.assertCanRead(actorId(request.caller, this.options.operatorActorId));
    const bindings = this.options.store.list({
      ...scope,
      includeInactive: request.includeInactive,
      targetAgentId: request.targetAgentId,
      targetSessionId: request.targetSessionId,
      limit: request.limit,
    });
    return bindings.map((binding) => this.expireIfNeeded(binding));
  }

  resolve(request: RouteAliasResolveRequest): RouteAliasResolveResult {
    const scope = this.scope(request.scope, request.caller);
    this.assertCanRead(actorId(request.caller, this.options.operatorActorId));
    let binding = request.bindingId
      ? this.options.store.getById(request.bindingId)
      : this.options.store.getActive(scope, normalizeRouteAlias(request.alias ?? ""));
    if (!binding || binding.ownerRealmId !== scope.ownerRealmId) {
      return {
        resolved: false,
        available: false,
        diagnostic: { code: "unknown_alias", detail: `no route alias exists in project ${scope.projectRoot ?? scope.projectKey} on node ${scope.nodeId}` },
      };
    }
    const terminalSession = binding.state === "active"
      && binding.target.kind === "session"
      && sessionTerminal(this.options.runtimeSnapshot().endpoints[binding.target.endpointId]);
    binding = this.expireIfNeeded(binding);
    if (binding.state !== "active") {
      return {
        resolved: false,
        available: false,
        binding,
        status: binding.state,
        diagnostic: terminalSession
          ? { code: "alias_session_terminal", detail: `alias ${binding.alias} exact session is terminal; repoint or unset the alias` }
          : { code: "alias_inactive", detail: `alias ${binding.alias} is ${binding.state}` },
      };
    }
    const native = this.nativeCollision(binding.alias, scope);
    const available = this.targetAvailable(binding.target);
    const status = native
      ? "shadowed" as const
      : available
      ? "active" as const
      : binding.target.kind === "session" && sessionTerminal(this.options.runtimeSnapshot().endpoints[binding.target.endpointId])
      ? "terminal" as const
      : "unreachable" as const;
    const proof = this.proof(binding);
    return {
      resolved: true,
      available,
      binding,
      proof,
      status,
      ...(native ? { diagnostic: { code: "alias_shadowed" as const, detail: `native agent ${native.displayName ?? native.id} wins bare-name resolution; use alias:${binding.alias}` } } : {}),
      fullyQualifiedSelector: `alias:${binding.alias} --alias-project ${binding.scopeProjectRoot ?? binding.scopeProjectKey} --alias-host ${binding.scopeNodeId}`,
    };
  }

  repoint(bindingId: string, request: RouteAliasMutationRequest, self?: "session" | "agent"): RouteAliasBinding {
    const binding = this.requireBinding(bindingId);
    const callerActorId = actorId(request.caller, this.options.operatorActorId);
    this.assertCanManage(callerActorId, self);
    if (request.expectedRevision !== undefined && request.expectedRevision !== binding.revision) {
      throw new BrokerRouteAliasError("revision_conflict", `expected revision ${request.expectedRevision}, current revision is ${binding.revision}`, { binding });
    }
    const target = this.canonicalTarget(request.target, self, request.caller);
    const updated = this.options.store.update({
      binding,
      operation: "repoint",
      target,
      targetSnapshot: routeAliasTargetSnapshot(this.options.runtimeSnapshot(), target),
      actorId: callerActorId,
      authorityNodeId: this.options.nodeId,
      now: this.now(),
      expectedRevision: request.expectedRevision,
      expiresAt: request.expiresAt,
      reason: request.reason,
      revisionId: this.id("aliasrev"),
    });
    if (!updated) throw new BrokerRouteAliasError("revision_conflict", "alias changed concurrently; reload and retry");
    return updated;
  }

  unset(bindingId: string, request: RouteAliasMutationRequest): RouteAliasBinding {
    const binding = this.requireBinding(bindingId);
    const callerActorId = actorId(request.caller, this.options.operatorActorId);
    this.assertCanManage(callerActorId);
    if (request.expectedRevision !== undefined && request.expectedRevision !== binding.revision) {
      throw new BrokerRouteAliasError("revision_conflict", `expected revision ${request.expectedRevision}, current revision is ${binding.revision}`, { binding });
    }
    const updated = this.options.store.update({
      binding,
      operation: "unset",
      actorId: callerActorId,
      authorityNodeId: this.options.nodeId,
      now: this.now(),
      expectedRevision: request.expectedRevision,
      reason: request.reason,
      revisionId: this.id("aliasrev"),
    });
    if (!updated) throw new BrokerRouteAliasError("revision_conflict", "alias changed concurrently; reload and retry");
    return updated;
  }

  history(bindingId: string, caller?: ScoutCallerContext) {
    this.assertCanRead(actorId(caller, this.options.operatorActorId));
    this.requireBinding(bindingId);
    return this.options.store.history(bindingId);
  }

  sweepExpired(limit = 200): number {
    let expired = 0;
    for (const binding of this.options.store.listExpiryCandidates(this.now(), limit)) {
      if (this.expireIfNeeded(binding).state === "expired") expired += 1;
    }
    return expired;
  }

  resolveForDispatch(target: Extract<ScoutRouteTarget, { kind: "route_alias" }>, caller?: ScoutCallerContext): RouteAliasDispatchResolution {
    const result = this.resolve({
      alias: target.alias,
      bindingId: target.bindingId,
      scope: target.scope,
      caller,
    });
    if (!result.resolved || !result.binding || !result.proof) {
      throw new BrokerRouteAliasError(result.diagnostic?.code ?? "unknown_alias", result.diagnostic?.detail ?? `unknown route alias ${target.alias}`);
    }
    const resolution = this.bindingResolution(result.binding);
    if (!resolution) {
      const code = result.binding.target.kind === "session"
        ? sessionTerminal(this.options.runtimeSnapshot().endpoints[result.binding.target.endpointId])
          ? "alias_session_terminal"
          : "alias_session_not_reachable"
        : "alias_target_unavailable";
      throw new BrokerRouteAliasError(code, `alias ${result.binding.alias} target is not routable`);
    }
    return { resolution, proof: result.proof, binding: result.binding };
  }

  resolveBareForDispatch(alias: string, caller?: ScoutCallerContext): RouteAliasDispatchResolution | null {
    try {
      const scope = this.scope(undefined, caller);
      const binding = this.options.store.getActive(scope, normalizeRouteAlias(alias));
      if (!binding) return null;
      return this.resolveForDispatch({ kind: "route_alias", alias }, caller);
    } catch (error) {
      if (error instanceof BrokerRouteAliasError && error.code === "invalid_alias") return null;
      throw error;
    }
  }

  private scope(scope: RouteAliasResolveRequest["scope"], caller?: ScoutCallerContext): RouteAliasScopeKey {
    const snapshot = this.options.runtimeSnapshot();
    const nodeId = this.resolveNode(scope?.nodeId);
    const explicitRoot = scope?.projectRoot?.trim();
    let projectRoot: string | undefined;
    let projectKey = scope?.projectKey?.trim();
    if (explicitRoot) {
      projectRoot = normalizePath(explicitRoot);
      projectKey = routeAliasProjectKey(projectRoot);
    } else if (!projectKey) {
      const cwd = caller?.currentDirectory?.trim();
      if (!cwd) {
        throw new BrokerRouteAliasError("ambiguous_alias_scope", "route alias scope requires caller.currentDirectory or an explicit project root/key");
      }
      projectRoot = inferProjectRoot(snapshot, cwd);
      projectKey = routeAliasProjectKey(projectRoot);
    }
    return {
      ownerRealmId: this.options.ownerRealmId,
      projectKey: projectKey!,
      projectRoot,
      nodeId,
    };
  }

  private resolveNode(value: string | undefined): string {
    const requested = value?.trim();
    if (!requested) return this.options.nodeId;
    const snapshot = this.options.runtimeSnapshot();
    const matches = Object.values(snapshot.nodes).filter((node) =>
      node.id === requested || node.name === requested || node.hostName === requested
    );
    if (matches.length !== 1) {
      throw new BrokerRouteAliasError("ambiguous_alias_scope", `host ${requested} is ${matches.length ? "ambiguous" : "unknown"}; use an exact node id`, {
        candidates: matches.map((node) => node.id),
      });
    }
    if (matches[0]!.id !== this.options.nodeId) {
      throw new BrokerRouteAliasError("not_authorized", `alias management for node ${matches[0]!.id} must be forwarded to that node's authoritative broker`);
    }
    return matches[0]!.id;
  }

  private canonicalTarget(target: ScoutRouteTarget | undefined, self: "session" | "agent" | undefined, caller?: ScoutCallerContext): RouteAliasTarget {
    if (self) return this.selfTarget(self, caller);
    if (!target) throw new BrokerRouteAliasError("invalid_alias", "alias set/repoint requires one existing target");
    if (target.kind === "route_alias") {
      throw new BrokerRouteAliasError("invalid_alias", "a route alias cannot target another alias");
    }
    if (
      target.kind !== "agent_id"
      && target.kind !== "agent_label"
      && target.kind !== "existing_handle"
      && target.kind !== "session_id"
    ) {
      throw new BrokerRouteAliasError(
        "invalid_alias",
        `a route alias must target one existing agent or exact session; ${target.kind} is not bindable`,
      );
    }
    if (target.kind === "session_id") {
      const matches = Object.values(this.options.runtimeSnapshot().endpoints)
        .filter((endpoint) => endpointMatchesTargetSession(endpoint, target.sessionId))
        .filter((endpoint) => !target.harness || endpoint.harness === target.harness);
      if (matches.length !== 1) {
        throw new BrokerRouteAliasError("alias_session_not_reachable", `session ${target.sessionId} resolves to ${matches.length} broker endpoints; use one exact broker-known session`);
      }
      if (sessionTerminal(matches[0]) || isStaleLocalEndpoint(this.options.runtimeSnapshot(), matches[0]!)) {
        throw new BrokerRouteAliasError("alias_session_not_reachable", `session ${target.sessionId} is terminal or no longer reachable`);
      }
      return this.sessionTarget(matches[0]!, target.sessionId);
    }
    const resolution = resolveBrokerRouteTarget(this.options.runtimeSnapshot(), { target }, {
      preferLocalNodeId: this.options.nodeId,
      helpers: { isStale: (agent) => !agent || agent.metadata?.retired === true },
    });
    if (resolution.kind !== "resolved") {
      throw new BrokerRouteAliasError("alias_target_unavailable", `target must resolve to one existing durable agent; got ${resolution.kind}`);
    }
    return { kind: "agent", agentId: resolution.agent.id, nodeId: resolution.agent.authorityNodeId };
  }

  private selfTarget(kind: "session" | "agent", caller?: ScoutCallerContext): RouteAliasTarget {
    const callerId = caller?.actorId?.trim();
    if (!callerId) throw new BrokerRouteAliasError("not_authorized", "self-claim requires a broker-authenticated caller actor");
    const snapshot = this.options.runtimeSnapshot();
    if (kind === "agent") {
      const agent = snapshot.agents[callerId];
      if (!agent) throw new BrokerRouteAliasError("not_authorized", "caller is not a durable Scout agent");
      return { kind: "agent", agentId: agent.id, nodeId: agent.authorityNodeId };
    }
    const claimedSession = metadataString(caller?.metadata, "sessionId")
      || metadataString(caller?.metadata, "runtimeSessionId");
    const endpoints = Object.values(snapshot.endpoints).filter((endpoint) =>
      endpoint.agentId === callerId
      && (!claimedSession || endpointMatchesTargetSession(endpoint, claimedSession))
    );
    if (endpoints.length !== 1) {
      throw new BrokerRouteAliasError("not_authorized", "broker cannot prove one exact attached session for this caller");
    }
    if (sessionTerminal(endpoints[0]) || isStaleLocalEndpoint(snapshot, endpoints[0]!)) {
      throw new BrokerRouteAliasError("alias_session_not_reachable", "attached session is terminal or no longer reachable");
    }
    const sessionId = claimedSession
      || metadataString(endpoints[0]!.metadata, "sessionId")
      || metadataString(endpoints[0]!.metadata, "runtimeSessionId");
    if (!sessionId) throw new BrokerRouteAliasError("not_authorized", "attached endpoint has no broker-known exact session id");
    return this.sessionTarget(endpoints[0]!, sessionId);
  }

  private sessionTarget(endpoint: AgentEndpoint, sessionId: string): RouteAliasTarget {
    return {
      kind: "session",
      sessionId,
      agentId: endpoint.agentId,
      endpointId: endpoint.id,
      nodeId: endpoint.nodeId,
      harness: endpoint.harness,
    };
  }

  private bindingResolution(binding: RouteAliasBinding): RouteAliasDispatchResolution["resolution"] | null {
    const snapshot = this.options.runtimeSnapshot();
    if (binding.target.kind === "agent") {
      const agent = snapshot.agents[binding.target.agentId];
      return agent ? { kind: "resolved", agent } : null;
    }
    const endpoint = snapshot.endpoints[binding.target.endpointId];
    if (
      !endpoint
      || !endpointMatchesTargetSession(endpoint, binding.target.sessionId)
      || sessionTerminal(endpoint)
      || isStaleLocalEndpoint(snapshot, endpoint)
    ) return null;
    return {
      kind: "resolved_session",
      session: {
        sessionId: binding.target.sessionId,
        actorId: binding.target.agentId,
        endpoint,
        label: String(binding.targetSnapshot.agentDisplayName ?? binding.target.sessionId),
        nodeId: binding.target.nodeId,
      },
    };
  }

  private nativeCollision(alias: string, scope: RouteAliasScopeKey): AgentDefinition | undefined {
    return buildAgentLabelCandidates(this.options.runtimeSnapshot(), {
      isStale: (agent) => !agent || agent.metadata?.retired === true,
    }).find((candidate) => {
      const names = [candidate.definitionId, candidate.agent.handle, candidate.agent.selector, candidate.agent.defaultSelector, ...(candidate.aliases ?? [])]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.replace(/^@/, "").trim().toLowerCase());
      const root = projectRootForAgent(this.options.runtimeSnapshot(), candidate.agent);
      return names.includes(alias)
        && candidate.agent.authorityNodeId === scope.nodeId
        && Boolean(root)
        && routeAliasProjectKey(root!) === scope.projectKey;
    })?.agent;
  }

  private targetAvailable(target: RouteAliasTarget): boolean {
    const snapshot = this.options.runtimeSnapshot();
    if (target.kind === "agent") return Boolean(snapshot.agents[target.agentId]);
    const endpoint = snapshot.endpoints[target.endpointId];
    return Boolean(endpoint && endpointMatchesTargetSession(endpoint, target.sessionId) && !isStaleLocalEndpoint(snapshot, endpoint) && !sessionTerminal(endpoint));
  }

  private expireIfNeeded(binding: RouteAliasBinding): RouteAliasBinding {
    if (binding.state !== "active") return binding;
    const now = this.now();
    const timeExpired = binding.expiresAt !== undefined && binding.expiresAt <= now;
    const sessionExpired = binding.target.kind === "session" && sessionTerminal(this.options.runtimeSnapshot().endpoints[binding.target.endpointId]);
    if (!timeExpired && !sessionExpired) return binding;
    return this.options.store.update({
      binding,
      operation: "expire",
      actorId: this.options.operatorActorId,
      authorityNodeId: this.options.nodeId,
      now,
      reason: timeExpired ? "configured expiry reached" : "exact session retired or left broker retention",
      revisionId: this.id("aliasrev"),
    }) ?? this.options.store.getById(binding.id) ?? binding;
  }

  private proof(binding: RouteAliasBinding): RouteAliasResolutionProof {
    return {
      bindingId: binding.id,
      revision: binding.revision,
      requestedAlias: binding.alias,
      scope: {
        projectKey: binding.scopeProjectKey,
        ...(binding.scopeProjectRoot ? { projectRoot: binding.scopeProjectRoot } : {}),
        nodeId: binding.scopeNodeId,
      },
      target: binding.target,
      resolvedAt: this.now(),
    };
  }

  private requireBinding(id: string): RouteAliasBinding {
    const binding = this.options.store.getById(id);
    if (!binding || binding.ownerRealmId !== this.options.ownerRealmId) {
      throw new BrokerRouteAliasError("unknown_alias", "unknown route alias binding");
    }
    return binding;
  }

  private assertCanRead(callerActorId: string): void {
    if (!this.options.runtimeSnapshot().actors[callerActorId] && callerActorId !== this.options.operatorActorId) {
      throw new BrokerRouteAliasError("not_authorized", "caller is not a broker-known actor");
    }
  }

  private assertCanManage(callerActorId: string, self?: "session" | "agent"): void {
    if (callerActorId === this.options.operatorActorId) return;
    if (self && this.options.runtimeSnapshot().actors[callerActorId]) return;
    throw new BrokerRouteAliasError("not_authorized", "alias management requires local owner authority; agents may only self-claim");
  }

  private id(prefix: string): string {
    return this.options.createId?.(prefix) ?? `${prefix}-${randomUUID()}`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
